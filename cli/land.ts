import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConcordClient, ConcordError, idempotencyKey, redactOutput, rememberCredential } from './client.ts';
import { git, gitBytes, patchId, rejectCanonicalTarget, validateRemote } from './git.ts';
import { mirrorGit } from '../deploy/mirror.ts';
import { readAwRun } from './aw-run.ts';
import { MAX_NORMALIZED_UNITS, unitsOverCapMessage } from '../src/leases/units.ts';
import { changeByIntent, leaseCovers } from './start.ts';

type Obj = Record<string, any>;
type Envelope = { data: Obj; version: number };
export type LandOptions = { repo?: string; source?: string; commit?: string; intentKey?: string; intent?: string;
  allowedFiles?: string; dependsOn?: string[]; reviewEvidence?: string; mirrorTo?: string; waitSeconds?: number;
  base?: string; awRun?: string; json?: boolean; emit?: (event: Obj) => void; client?: ConcordClient };
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new ConcordError(`${name} is required`, 'usage');
  return value;
}
async function api(client: ConcordClient, path: string, body?: Obj, expectedVersion?: number): Promise<Envelope> {
  let version = expectedVersion;
  for (let attempt = 0; attempt < 20; attempt++) {
    try { return await client.request(body ? 'POST' : 'GET', path, body ? { body, expectedVersion: version, idempotencyKey: idempotencyKey() } : {}); }
    catch (error) {
      const stale = error instanceof ConcordError && body && version !== undefined &&
        (error.payload as Obj)?.error?.code === 'STALE_VERSION';
      if (stale && attempt < 5) {
        const repo = /^\/repos\/([^/]+)/.exec(path)?.[1];
        if (repo) { version = (await client.request<Envelope>('GET', `/repos/${repo}/snapshot`)).version; await pause(20 * (attempt + 1)); continue; }
      }
      const promotion = error instanceof ConcordError && body && version !== undefined &&
        (path.endsWith('/verdicts') || path.endsWith('/queue/enqueue')) &&
        (error.payload as Obj)?.error?.code === 'PROMOTION_IN_PROGRESS';
      if (promotion && attempt < 19) {
        const repo = /^\/repos\/([^/]+)/.exec(path)?.[1];
        if (repo) { version = (await client.request<Envelope>('GET', `/repos/${repo}/snapshot`)).version; await pause(500); continue; }
      }
      if (error instanceof ConcordError) error.message = `${error.message} at ${body ? 'POST' : 'GET'} ${path}`;
      throw error;
    }
  }
  throw new ConcordError('STALE_VERSION: too many concurrent updates', 'conflict');
}
function safeRemote(remote: string, client: ConcordClient): string {
  const url = new URL(remote);
  if (url.protocol === 'file:' && ['127.0.0.1', 'localhost', '::1'].includes(new URL(client.baseUrl).hostname) && !url.host && !url.search && !url.hash) return remote;
  validateRemote(remote);
  return remote;
}
async function access(client: ConcordClient, root: string, repository: Obj, scope: 'read' | 'write', storageName: string): Promise<{ remote: string; token: string }> {
  const response = (await api(client, `${root}/git-token`, { storageName, scope, ttlSeconds: 300 }, await currentVersion(client, root))).data;
  const token = required(response.secret ?? response.token ?? response.plaintext, 'Git token');
  rememberCredential(token);
  return { remote: safeRemote(required(response.remote, 'Git remote'), client), token };
}
async function currentVersion(client: ConcordClient, root: string): Promise<number> { return (await api(client, `${root}/snapshot`)).version; }
async function leases(client: ConcordClient, root: string): Promise<Obj[]> {
  const result: Obj[] = []; let cursor: string | null = null;
  do {
    const page: Obj = (await api(client, `${root}/leases${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)).data;
    result.push(...(page.items ?? [])); cursor = page.nextCursor ?? null;
  } while (cursor);
  return result;
}
export async function filesChanged(source: string, commit: string, base?: string): Promise<{ parent: string; files: string[] }> {
  if (base !== undefined) {
    if (!/^[a-f0-9]{40}$/i.test(base)) throw new ConcordError('--base requires a full 40-hex commit OID', 'usage');
    try {
      const resolved = await git(['rev-parse', '--verify', `${base}^{commit}`], {}, source);
      if (resolved.toLowerCase() !== base.toLowerCase()) throw new Error('base did not resolve exactly');
      await git(['merge-base', '--is-ancestor', base, commit], {}, source);
    } catch { throw new ConcordError('REFUSED: base is not an ancestor of head', 'usage'); }
    const history = await git(['rev-list', '--parents', `${base}..${commit}`], {}, source);
    if (history.split('\n').some(line => line && line.split(' ').length > 2))
      throw new ConcordError('REFUSED: range contains a merge commit', 'usage');
  }
  const parents = (await git(['rev-list', '--parents', '-n', '1', commit], {}, source)).split(' ');
  if ((!base && parents.length !== 2) || parents[0].toLowerCase() !== commit.toLowerCase()) throw new ConcordError('land requires a single-parent commit', 'usage');
  const parent = base ?? parents[1];
  const raw = await gitBytes(['diff-tree', '--no-commit-id', '-r', '--no-renames', '--name-only', '-z', parent, commit], {}, source);
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { throw new ConcordError('REFUSED: Git path is not valid UTF-8', 'usage'); }
  const files = decoded.split('\0').filter(Boolean);
  if (!files.length) throw new ConcordError(base ? 'REFUSED: range has an empty diff' : 'candidate commit changes no files', 'usage');
  return { parent, files };
}
export function parseAllowed(text: string): Set<string> {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.some(line => line.trim() !== line || line.startsWith('/') || line.split('/').some(part => !part || part === '.' || part === '..' || part === '.git'))) throw new ConcordError('allowed-files contains an invalid path', 'usage');
  return new Set(lines);
}
export async function unitKeys(source: string, parent: string, head: string, paths: string[], policy: Obj | undefined): Promise<string[]> {
  const result: string[] = [];
  for (const path of paths) {
    const table = (policy?.tables ?? []).find((item: Obj) => item.file === path);
    if (!table) { result.push(`file:${path}`); continue; }
    const mode = async (oid: string) => /^([0-7]{6})\s/.exec(await git(['ls-tree', oid, '--', path], {}, source))?.[1] ?? null;
    if (await mode(parent) !== await mode(head)) { result.push(`file:${path}`); continue; }
    const content = async (oid: string) => {
      try { return await git(['show', `${oid}:${path}`], { preserveOutput: true }, source); } catch { return null; }
    };
    const before = await content(parent); const after = await content(head);
    if (before === null || after === null || before.endsWith('\n') !== after.endsWith('\n') || before.includes('\r') || after.includes('\r')) {
      result.push(`file:${path}`); continue;
    }
    const validKey = (key: string): boolean => {
      const spec = table.keySpec;
      if (!spec || key.length < spec.minLength || key.length > spec.maxLength) return false;
      return [...key].every(character => Array.isArray(spec.charset) ? spec.charset.includes(character) :
        spec.charset === 'lower' ? /^[a-z]$/.test(character) : spec.charset === 'alnum' ? /^[a-zA-Z0-9]$/.test(character) :
          /^[a-zA-Z0-9.-]$/.test(character));
    };
    const rows = (text: string | null): Map<string, string> | null => {
      if (text === null) return null;
      const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
      if (lines.shift() !== table.header.join('\t')) return null;
      const keyIndex = table.header.indexOf(table.keyColumn);
      const map = new Map<string, string>();
      for (const line of lines) {
        const cells = line.split('\t'); const key = cells[keyIndex];
        if (cells.length !== table.header.length || !validKey(key) || map.has(key)) return null;
        map.set(key, line);
      }
      return map;
    };
    const oldRows = rows(before); const newRows = rows(after);
    if (!oldRows || !newRows) { result.push(`file:${path}`); continue; }
    const changed = [...new Set([...oldRows.keys(), ...newRows.keys()])].filter(key => oldRows.get(key) !== newRows.get(key));
    if (!changed.length) { result.push(`file:${path}`); continue; }
    for (const key of changed) {
      const named = Object.entries(policy?.units ?? {}).find(([alias, spec]) => alias === `row:${table.name}:${key}` ||
        (spec as Obj).file === path && (spec as Obj).canonicalKey === `row:${table.name}:${key}`);
      result.push(named ? (named[1] as Obj).canonicalKey : `row:${table.name}:${key}`);
    }
  }
  return [...new Set(result)].sort();
}
async function inspection(client: ConcordClient, root: string, change: Obj): Promise<Obj | null> {
  const snapshot = (await api(client, `${root}/snapshot`)).data;
  const jobs = snapshot.projections?.runners?.jobs ?? [];
  const job = [...jobs].reverse().find((item: Obj) => item.kind === 'inspect-candidate' && item.changeId === change.changeId && item.revision === change.revision);
  if (!job || job.state !== 'completed') return null;
  try { return (await api(client, `${root}/jobs/${encodeURIComponent(job.jobId)}/result`)).data.result; }
  catch (error) {
    if (error instanceof ConcordError && [401, 403, 404].includes(error.status ?? 0)) return null;
    throw error;
  }
}
function failInspection(result: Obj): never {
  const outcome = typeof result.outcome === 'string' ? result.outcome : 'UNKNOWN';
  const retry = ['ENV_ERROR', 'TIMEOUT'].includes(outcome)
    ? '; fix the environment, then re-run land with a new --intent-key' : '';
  throw new ConcordError(`INSPECTION_FAILED: ${outcome}${retry}`, 'server', undefined,
    typeof result.log === 'string' ? { log: redactOutput(result.log) } : undefined);
}
export async function waitChange(client: ConcordClient, path: string, deadline: number, emit: (event: Obj) => void, onTick: () => Promise<void>, inspector = client): Promise<Obj> {
  let last = '';
  while (Date.now() < deadline) {
    const change = (await api(client, path)).data;
    if (change.status !== last) { emit({ state: 'change', status: change.status, changeId: change.changeId }); last = change.status; }
    const result = await inspection(inspector, path.slice(0, path.lastIndexOf('/changes/')), change);
    if (result && result.outcome !== 'PASS') failInspection(result);
    if (['ready', 'queued', 'checking', 'landed', 'blocked', 'failed', 'closed'].includes(change.status)) return change;
    await onTick();
    await pause(1000);
  }
  throw new ConcordError('INSPECTION_TIMEOUT: checker did not finish', 'server');
}
async function prepareHead(source: string, commit: string, parent: string, base: string, canonical: { remote: string; token: string }): Promise<{ work: string; head: string; cherryPicked: boolean; cleanup: () => Promise<void> }> {
  if (parent === base) return { work: source, head: commit, cherryPicked: false, cleanup: async () => {} };
  const work = await mkdtemp(join(tmpdir(), 'concord-land-'));
  try {
    await git(['clone', '--quiet', '--shared', '--no-checkout', '--', source, work]);
    await git(['fetch', '--no-tags', '--', canonical.remote, base], { token: canonical.token }, work);
    await git(['checkout', '--quiet', '--detach', base], {}, work);
    try { await git(['-c', 'core.hooksPath=/dev/null', 'cherry-pick', '--no-gpg-sign', commit], { identity: true }, work); }
    catch { throw new ConcordError('MERGE_CONFLICT: candidate does not apply to current canonical base', 'conflict'); }
    return { work, head: await git(['rev-parse', 'HEAD'], {}, work), cherryPicked: true, cleanup: () => rm(work, { recursive: true, force: true }) };
  } catch (error) { await rm(work, { recursive: true, force: true }); throw error; }
}
async function squashRange(source: string, base: string, head: string): Promise<{ work: string; oid: string; cleanup: () => Promise<void> }> {
  const work = await mkdtemp(join(tmpdir(), 'concord-land-squash-'));
  try {
    await git(['clone', '--quiet', '--shared', '--no-checkout', '--', source, work]);
    const tree = await git(['rev-parse', `${head}^{tree}`], {}, work);
    const oid = await git(['commit-tree', tree, '-p', base, '-m', `Squash range ${base}..${head}`], { identity: true }, work);
    if ((await git(['rev-parse', `${oid}^{tree}`], {}, work)) !== tree ||
        (await git(['rev-parse', `${oid}^`], {}, work)).toLowerCase() !== base.toLowerCase())
      throw new ConcordError('squash tree or parent does not match reviewed range', 'server');
    return { work, oid, cleanup: () => rm(work, { recursive: true, force: true }) };
  } catch (error) { await rm(work, { recursive: true, force: true }); throw error; }
}
export function approvedHead(evidence: string, head: string): boolean {
  const lines = evidence.split(/\r?\n/);
  const report = lines.filter(line => line.trim() !== '');
  const approval = /^# ✅ APPROVED FOR MERGE — head ([a-fA-F0-9]{40})$/;
  const match = approval.exec(report[0] ?? '');
  const last = report.at(-1);
  const approvedFooter = last === 'APPROVED for merge' || last === 'VERDICT: APPROVED' ||
    (last === 'DELEGATE_OUTCOME=completed' && report.at(-2) === 'VERDICT: APPROVED');
  return !!match && match[1].toLowerCase() === head.toLowerCase() &&
    approvedFooter &&
    !/CHANGES REQUIRED|REQUEST CHANGES|NOT APPROVED/i.test(evidence);
}
export async function land(input: LandOptions): Promise<Obj> {
  let options = input;
  if (input.awRun) {
    if (!input.base) throw new ConcordError('REFUSED: AW run requires an explicit run-start base; supply --base', 'usage');
    const run = await readAwRun(input.awRun);
    if (input.commit !== undefined && input.commit.toLowerCase() !== run.commit.toLowerCase())
      throw new ConcordError('--commit conflicts with AW validated_sha', 'usage');
    if (input.allowedFiles !== undefined && resolve(input.allowedFiles) !== resolve(run.allowedFiles))
      throw new ConcordError('--allowed-files conflicts with AW run allowed-files.txt', 'usage');
    options = { ...run, ...input, source: input.source ?? run.source, intentKey: input.intentKey ?? run.intentKey,
      intent: input.intent ?? run.intent,
      commit: run.commit, allowedFiles: run.allowedFiles };
  }
  const repo = required(options.repo, '--repo'); const source = resolve(required(options.source, '--source'));
  const commit = required(options.commit, '--commit'); const intentKey = required(options.intentKey, '--intent-key');
  const intent = required(options.intent, '--intent'); const allowedFile = required(options.allowedFiles, '--allowed-files');
  if (!sha.test(commit) || !/^[A-Za-z0-9_-]{1,128}$/.test(intentKey) || !/^[A-Za-z0-9_-]{1,64}$/.test(repo)) throw new ConcordError('invalid repo, intent key, or commit SHA', 'usage');
  if (options.mirrorTo) {
    validateRemote(options.mirrorTo);
    if (new URL(options.mirrorTo).protocol !== 'https:') throw new ConcordError('--mirror-to requires a credential-free HTTPS Git URL', 'usage');
  }
  let changed = await filesChanged(source, commit, options.base);
  const allowed = parseAllowed(await readFile(allowedFile, 'utf8'));
  const outside = changed.files.filter(file => !allowed.has(file));
  if (outside.length) throw new ConcordError(`OUTSIDE_ALLOWED_FILES: ${outside.join(', ')}`, 'usage');
  const token = required(process.env.CONCORD_TOKEN, 'CONCORD_TOKEN');
  const url = required(process.env.CONCORD_URL, 'CONCORD_URL');
  const client = input.client ?? new ConcordClient({ url, token });
  if (options.reviewEvidence && process.env.CONCORD_REVIEWER_TOKEN === token)
    throw new ConcordError('reviewer token must differ from author token', 'usage');
  const inspector = !input.client && process.env.CONCORD_REVIEWER_TOKEN && process.env.CONCORD_REVIEWER_TOKEN !== token
    ? new ConcordClient({ url, token: process.env.CONCORD_REVIEWER_TOKEN }) : client;
  const emit = (event: Obj) => (options.emit ?? ((value: Obj) => { process.stdout.write(`${JSON.stringify(redactOutput(value))}\n`); }))({ repo, intentKey, ...event });
  let squash = options.base ? await squashRange(source, changed.parent, commit) : null;
  if (squash) emit({ state: 'squashed', base: changed.parent, headOid: commit, squashOid: squash.oid });
  try {
  const root = `/repos/${encodeURIComponent(repo)}`;
  const wait = options.waitSeconds ?? 600;
  if (!Number.isSafeInteger(wait) || wait < 0) throw new ConcordError('--wait-seconds must be a nonnegative integer', 'usage');
  const deadline = Date.now() + wait * 1000;
  const repository = (await api(client, root)).data;
  if (!repository.observedCanonicalOid || !sha.test(repository.observedCanonicalOid)) throw new ConcordError('canonical main is unavailable', 'server');
  const initialSnapshot = (await api(client, `${root}/snapshot`)).data;
  const policy = initialSnapshot.projections?.repos?.unitPolicy ?? (initialSnapshot.projections?.runners?.jobs ?? []).map((job: Obj) => job.unitPolicy)
    .find((item: Obj | undefined) => item?.digest === repository.policyDigest);
  let units = await unitKeys(source, changed.parent, commit, changed.files, policy);
  if (units.length > MAX_NORMALIZED_UNITS) throw new ConcordError(`LAND_TOO_MANY_UNITS: ${unitsOverCapMessage(units.length)}`, 'usage');
  const branch = `refs/heads/land/${hash(intentKey).slice(7, 23)}`;
  const createBody = { intentKey, intentText: intent, baseOid: repository.observedCanonicalOid, branch, unitKeys: units, dependencyChangeIds: options.dependsOn ?? [] };
  let started: Obj | undefined;
  let created: Obj;
  try { created = (await api(client, `${root}/changes`, createBody)).data; }
  catch (error) {
    if (!(error instanceof ConcordError) || (error.payload as Obj)?.error?.code !== 'INTENT_CONFLICT') throw error;
    started = await changeByIntent(client, root, intentKey);
    if (!started || started.intentText !== intent || started.branch !== branch ||
        JSON.stringify([...(started.dependencyChangeIds ?? [])].sort()) !== JSON.stringify([...(options.dependsOn ?? [])].sort())) throw error;
    created = started;
  }
  const startScope: string[] | undefined = created.startUnitKeys;
  const outsideStartScope = startScope ? units.filter(unit => !startScope.some(scope => leaseCovers(scope, unit, policy))) : [];
  if (outsideStartScope.length) throw new ConcordError(`START_SCOPE_CONFLICT: ${outsideStartScope.join(', ')} outside the change's original start scope`, 'conflict');
  if (startScope && changed.parent !== created.baseOid &&
      await git(['merge-base', '--is-ancestor', created.baseOid, commit], {}, source).then(() => true, () => false)) {
    const fullRange = await filesChanged(source, commit, created.baseOid);
    const outsideRange = fullRange.files.filter(file => !allowed.has(file));
    if (outsideRange.length) throw new ConcordError(`OUTSIDE_ALLOWED_FILES: ${outsideRange.join(', ')}`, 'usage');
    const fullUnits = await unitKeys(source, fullRange.parent, commit, fullRange.files, policy);
    if (fullUnits.length > MAX_NORMALIZED_UNITS) throw new ConcordError(`LAND_TOO_MANY_UNITS: ${unitsOverCapMessage(fullUnits.length)}`, 'usage');
    const outsideFullScope = fullUnits.filter(unit => !startScope.some(scope => leaseCovers(scope, unit, policy)));
    if (outsideFullScope.length) throw new ConcordError(`START_SCOPE_CONFLICT: ${outsideFullScope.join(', ')} outside the change's original start scope`, 'conflict');
    changed = fullRange;
    units = fullUnits;
    squash = await squashRange(source, changed.parent, commit);
  }
  while (created.provisioning?.state !== 'observed' && Date.now() < deadline) {
    await pause(1000);
    created = started ? (await api(client, `${root}/changes/${encodeURIComponent(started.changeId)}`)).data :
      (await api(client, `${root}/changes`, createBody)).data;
  }
  if (created.provisioning?.state !== 'observed') throw new ConcordError('FORK_TIMEOUT: candidate fork was not provisioned', 'server');
  const changeId = required(created.changeId, 'changeId'); const path = `${root}/changes/${encodeURIComponent(changeId)}`;
  emit({ state: 'created', changeId, baseOid: created.baseOid });
  const existingQueue = (await api(client, `${root}/queue`)).data;
  const alreadyQueued = (existingQueue.entries ?? []).some((item: Obj) => item.changeId === changeId &&
    ['admitted', 'reserved', 'checking', 'landed'].includes(item.state));
  let held: Obj[] = [];
  let owned: Obj[] = [];
  const refresh = async () => {
    owned = (await leases(client, root)).filter(item => item.changeId === changeId && item.state === 'active');
    held = owned.filter(item => units.some(unit => leaseCovers(item.unitKey, unit, policy)));
  };
  const renew = async () => {
    await refresh();
    for (const item of held.filter(value => value.remainingSeconds < 60)) {
      const updated = (await api(client, `${root}/leases/${encodeURIComponent(item.leaseId)}/renew`, { fence: item.fence, ttlSeconds: 300 }, await currentVersion(client, root))).data.lease;
      Object.assign(item, updated); emit({ state: 'lease-renewed', unitKey: item.unitKey, fence: item.fence });
    }
  };
  const fences = () => Object.fromEntries(held.map(item => [item.unitKey, item.fence]));
  let awaitingReview = false;
  let adoptedLease = false;
  let firstLeaseRead = true;
  let refused = false;
  try {
    let attempt = 0;
    while (!alreadyQueued) {
      await refresh();
      if (firstLeaseRead) { adoptedLease = held.length > 0; firstLeaseRead = false; }
      const missing = units.filter(unit => !held.some(item => leaseCovers(item.unitKey, unit, policy)));
      if (!missing.length) break;
      try {
        const result = (await api(client, `${root}/leases`, { changeId, unitKeys: missing, intentText: intent, ttlSeconds: 300 }, await currentVersion(client, root))).data;
        held.push(...result.leases); emit({ state: 'leased', unitKeys: result.leases.map((item: Obj) => item.unitKey), missingUnits: missing });
      } catch (error) {
        if (!(error instanceof ConcordError)) throw error;
        const code = (error.payload as Obj)?.error?.code;
        if (code !== 'LEASE_CONFLICT' && code !== 'PROMOTION_IN_PROGRESS') throw error;
        const details = (error.payload as Obj)?.error?.details ?? (error.payload as Obj)?.error ?? {};
        if (code === 'LEASE_CONFLICT') emit({ state: 'LEASE_CONFLICT', holderId: details.holderId, holderIntent: details.intentText, conflicts: details.conflicts });
        else emit({ state: 'promotion-in-progress', changeId });
        if (Date.now() >= deadline) throw new ConcordError(`${code}: timed out waiting for admission`, 'conflict', 409, details);
        await renew(); await pause(Math.min(1000 * 2 ** Math.min(attempt++, 4), 15000, Math.max(0, deadline - Date.now())));
      }
    }
    const current = (await api(client, path)).data;
    const latestRepo = (await api(client, root)).data;
    const canonical = await access(client, root, latestRepo, 'read', latestRepo.canonicalStorageName);
    const targetBase = alreadyQueued || current.headOid && current.baseOid === latestRepo.observedCanonicalOid ? current.baseOid : latestRepo.observedCanonicalOid;
    const prepared = await prepareHead(squash?.work ?? source, squash?.oid ?? commit, changed.parent, targetBase, canonical);
    let priorWork: string | null = null;
    let priorHead: string | null = null;
    try {
      let capturedEvidence: string | undefined;
      const reviewEvidence = async () => capturedEvidence ??= await readFile(required(options.reviewEvidence, 'review evidence'), 'utf8');
      let change = (await api(client, path)).data;
      if (change.revision !== current.revision || change.headOid !== current.headOid || change.baseOid !== current.baseOid)
        throw new ConcordError('PUBLISHED_HEAD_MISMATCH: change changed during preparation', 'conflict');
      if (change.headOid !== prepared.head || !change.headOid || change.baseOid !== targetBase) {
        if (change.headOid && change.baseOid === targetBase && alreadyQueued)
          throw new ConcordError('INSPECTION_FAILED: environment inspection cannot be retried for an admitted change; use a new intent key', 'server');
        const candidate = await access(client, root, repository, 'write', change.candidateStorageName);
        rejectCanonicalTarget(change.candidateStorageName, repository.canonicalStorageName, candidate.remote, repository.canonicalRemote);
        const evidence = options.reviewEvidence ? await reviewEvidence() : null;
        const priorJobs = evidence && !approvedHead(evidence, commit)
          ? (await api(client, `${root}/snapshot`)).data.projections?.runners?.jobs ?? [] : [];
        const priorJob = priorJobs.find((job: Obj) => job.kind === 'inspect-candidate' &&
          job.changeId === changeId && job.state === 'completed' && job.revision <= change.revision &&
          job.candidate?.storageName === change.candidateStorageName &&
          typeof job.candidate?.headOid === 'string' && approvedHead(evidence!, job.candidate.headOid));
        if (priorJob) {
          priorHead = priorJob.candidate.headOid;
          priorWork = await mkdtemp(join(tmpdir(), 'concord-land-prior-'));
          await git(['clone', '--quiet', '--no-checkout', '--', candidate.remote, priorWork], { token: candidate.token });
          if (priorJob.candidate.headOid !== change.headOid) {
            try { await git(['cat-file', '-e', `${priorJob.candidate.headOid}^{commit}`], {}, priorWork); }
            catch {
              try { await git(['fetch', '--no-tags', '--', candidate.remote, priorJob.candidate.headOid], { token: candidate.token }, priorWork); }
              catch { throw new ConcordError(`review evidence for earlier published head ${priorJob.candidate.headOid} cannot be verified against ${prepared.head}: prior commit is unavailable`, 'usage'); }
            }
          }
        }
        await git(['-c', 'core.hooksPath=/dev/null', 'push', '--no-follow-tags',
          ...(change.headOid ? [`--force-with-lease=${change.branch}:${change.headOid}`] : []),
          '--', candidate.remote, `${prepared.head}:${change.branch}`], { token: candidate.token }, prepared.work);
        await api(client, `${root}/branches`, { storageName: change.candidateStorageName, ref: change.branch, observedHead: prepared.head, ownerId: change.authorId }, await currentVersion(client, root));
        change = (await api(client, path)).data;
        await api(client, `${path}/publish`, { baseOid: targetBase, headOid: prepared.head, branch: change.branch, unitKeys: units, leaseFences: fences() }, (await api(client, path)).version);
        emit({ state: 'published', changeId, headOid: prepared.head });
        change = (await api(client, path)).data;
      }
      const publishedRevision = change.revision;
      const requirePublishedChange = (current: Obj) => {
        if (current.headOid !== prepared.head || current.baseOid !== targetBase || current.revision !== publishedRevision)
          throw new ConcordError('PUBLISHED_HEAD_MISMATCH: change head, base, or revision changed during land', 'conflict');
      };
      change = await waitChange(client, path, deadline, emit, alreadyQueued ? async () => {} : renew, inspector);
      if (!['ready', 'queued', 'checking', 'landed'].includes(change.status)) throw new ConcordError(`INSPECTION_FAILED: ${change.status}`, 'server');
      requirePublishedChange(change);
      if (!alreadyQueued) await renew();
      const queue = (await api(client, `${root}/queue`)).data;
      let entry = [...(queue.entries ?? [])].reverse().find((item: Obj) => item.changeId === changeId && !['blocked', 'failed', 'withdrawn'].includes(item.state));
      if (!entry) {
        change = (await api(client, path)).data;
        requirePublishedChange(change);
        if (!options.reviewEvidence) { awaitingReview = true; emit({ state: 'awaiting-review', changeId, headOid: prepared.head, url: `${client.baseUrl}/v1/repos/${repo}/changes/${changeId}` }); return { status: 'awaiting-review', changeId, headOid: prepared.head }; }
        const reviewerToken = required(process.env.CONCORD_REVIEWER_TOKEN, 'CONCORD_REVIEWER_TOKEN');
        if (reviewerToken === token) throw new ConcordError('reviewer token must differ from author token', 'usage');
        const evidence = await reviewEvidence();
        let carriedFromOid: string | null = null;
        if (!approvedHead(evidence, prepared.head)) {
          const sourceApproval = (prepared.cherryPicked || squash) && prepared.head !== commit && approvedHead(evidence, commit);
          const previousHead = priorWork && priorHead;
          if (sourceApproval || previousHead) {
            const reviewedOid = previousHead ?? squash?.oid ?? commit;
            const reviewedWork = previousHead ? priorWork! : squash?.work ?? source;
            const published = await filesChanged(prepared.work, prepared.head);
            const reviewedFiles = previousHead ? (await filesChanged(reviewedWork, reviewedOid)).files : changed.files;
            const sameFiles = published.parent === targetBase && published.files.length === reviewedFiles.length &&
              published.files.every(file => allowed.has(file) && reviewedFiles.includes(file));
            const sameSquash = previousHead || !squash || (await git(['rev-parse', `${squash.oid}^{tree}`], {}, squash.work)) ===
              (await git(['rev-parse', `${commit}^{tree}`], {}, source)) &&
              (await git(['rev-parse', `${squash.oid}^`], {}, squash.work)).toLowerCase() === changed.parent.toLowerCase();
            if (sameFiles && sameSquash && await patchId(reviewedWork, reviewedOid) === await patchId(prepared.work, prepared.head))
              carriedFromOid = previousHead ?? commit;
            else if (previousHead) throw new ConcordError(`review evidence for earlier published head ${previousHead} cannot be carried to ${prepared.head}: patch ID or changed files differ`, 'usage');
          }
          if (!carriedFromOid) throw new ConcordError('review evidence must approve the exact published head SHA', 'usage');
        }
        const reviewer = new ConcordClient({ url, token: reviewerToken });
        const inspected = await inspection(reviewer, root, change);
        if (!inspected || inspected.outcome !== 'PASS' || !inspected.reviewManifestDigest) throw new ConcordError('trusted inspection result is unavailable', 'server');
        const findings = (await api(reviewer, `${path}/findings`)).data;
        const verdicts = (await api(reviewer, `${path}/verdicts`)).data;
        let verdict = (verdicts.items ?? []).find((item: Obj) => item.revision === change.revision && item.decision === 'approve' && item.evidenceDigest === hash(evidence) &&
          (carriedFromOid ? item.carriedFrom?.sourceOid === carriedFromOid && item.carriedFrom?.method === 'patch-id' : !item.carriedFrom));
        requirePublishedChange((await api(client, path)).data);
        if (!verdict) verdict = (await api(reviewer, `${path}/verdicts`, { revision: change.revision, reviewManifestDigest: inspected.reviewManifestDigest, findingSetVersion: findings.findingSetVersion, decision: 'approve', evidenceDigest: hash(evidence),
          ...(carriedFromOid ? { carriedFrom: { sourceOid: carriedFromOid, method: 'patch-id' } } : {}) }, await currentVersion(reviewer, root))).data;
        if (carriedFromOid) emit({ state: 'review-carried', sourceOid: carriedFromOid, publishedOid: prepared.head });
        emit({ state: 'reviewed', verdictId: verdict.verdictId, headOid: prepared.head });
        await renew();
        entry = (await api(client, `${root}/queue/enqueue`, { changeId, verdictId: verdict.verdictId, leaseFences: fences() }, await currentVersion(client, root))).data;
        emit({ state: 'enqueued', entryId: entry.entryId });
      }
      let previous = '';
      while (Date.now() < deadline) {
        const state = (await api(client, `${root}/queue`)).data;
        entry = [...(state.entries ?? [])].reverse().find((item: Obj) => item.changeId === changeId);
        if (entry?.state !== previous) { emit({ state: 'queue', queueState: entry?.state, reason: entry?.blockedReason }); previous = entry?.state; }
        if (entry?.state === 'landed') {
          const readback = (await api(client, root)).data;
          const landed = state.finalCanonicalOid;
          if (!sha.test(landed) || readback.observedCanonicalOid !== landed || !state.promotion) throw new ConcordError('canonical landing readback does not match ticket', 'server');
          emit({ state: 'landed', changeId, canonicalOid: landed, ticket: state.promotion });
          if (options.mirrorTo) {
            const destinationRemote = options.mirrorTo;
            const latest = await access(client, root, readback, 'read', readback.canonicalStorageName);
            const plan = await mirrorGit({ sourceRemote: latest.remote, sourceToken: latest.token, sourceOid: landed, destinationRemote, destinationToken: process.env.CONCORD_MIRROR_TOKEN, execute: true });
            emit({ state: 'mirrored', ...plan });
          }
          return { status: 'landed', changeId, canonicalOid: landed };
        }
        if (['blocked', 'failed', 'withdrawn'].includes(entry?.state)) throw new ConcordError(`QUEUE_${entry.state.toUpperCase()}: ${entry.blockedReason ?? state.blockedReason ?? 'diagnostic failure'}`, 'server');
        await renew(); await pause(1000);
      }
      throw new ConcordError('QUEUE_TIMEOUT: landing did not finish', 'server');
    } finally { if (priorWork) await rm(priorWork, { recursive: true, force: true }); await prepared.cleanup(); }
  } catch (error) { refused = true; throw error; } finally {
    await refresh().catch(() => {});
    const latest = await api(client, path).then(result => result.data).catch(() => null);
    const publishedUnits: string[] | null = latest?.headOid ? latest.unitKeys ?? units : null;
    // A started change (recorded start scope) keeps every live lease on refusal, including one land reclaimed
    // after the start hold expired, so its author can repair and rerun land.
    for (const item of refused && startScope ? [] : owned) {
      const unused = publishedUnits && !publishedUnits.some(unit => leaseCovers(item.unitKey, unit, policy));
      const abandoned = !started && !adoptedLease && !awaitingReview && held.includes(item);
      if (unused || abandoned) await api(client, `${root}/leases/${encodeURIComponent(item.leaseId)}/release`,
        { fence: item.fence }, await currentVersion(client, root)).catch(() => {});
    }
  }
  } finally { await squash?.cleanup(); }
}
