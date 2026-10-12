import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ConcordClient, ConcordError, idempotencyKey, redactOutput, rememberCredential } from './client.ts';
import { git, rejectCanonicalTarget, validateRemote } from './git.ts';
import { mirrorGit } from '../deploy/mirror.ts';
import { readAwRun } from './aw-run.ts';

type Obj = Record<string, any>;
type Envelope = { data: Obj; version: number };
export type LandOptions = { repo?: string; source?: string; commit?: string; intentKey?: string; intent?: string;
  allowedFiles?: string; dependsOn?: string[]; reviewEvidence?: string; mirrorTo?: string; waitSeconds?: number;
  awRun?: string; json?: boolean; emit?: (event: Obj) => void; client?: ConcordClient };
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function required(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new ConcordError(`${name} is required`, 'usage');
  return value;
}
async function api(client: ConcordClient, path: string, body?: Obj, expectedVersion?: number): Promise<Envelope> {
  let version = expectedVersion;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return await client.request(body ? 'POST' : 'GET', path, body ? { body, expectedVersion: version, idempotencyKey: idempotencyKey() } : {}); }
    catch (error) {
      const stale = error instanceof ConcordError && body && version !== undefined &&
        (error.payload as Obj)?.error?.code === 'STALE_VERSION';
      if (stale && attempt < 5) {
        const repo = /^\/repos\/([^/]+)/.exec(path)?.[1];
        if (repo) { version = (await client.request<Envelope>('GET', `/repos/${repo}/snapshot`)).version; await pause(20 * (attempt + 1)); continue; }
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
export async function filesChanged(source: string, commit: string): Promise<{ parent: string; files: string[] }> {
  const parents = (await git(['rev-list', '--parents', '-n', '1', commit], {}, source)).split(' ');
  if (parents.length !== 2 || parents[0] !== commit) throw new ConcordError('land requires a single-parent commit', 'usage');
  const raw = await git(['diff-tree', '--no-commit-id', '-r', '--no-renames', '--name-only', '-z', parents[1], commit], {}, source);
  const files = raw.split('\0').filter(Boolean);
  if (!files.length) throw new ConcordError('candidate commit changes no files', 'usage');
  return { parent: parents[1], files };
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
  return (await api(client, `${root}/jobs/${encodeURIComponent(job.jobId)}/result`)).data.result;
}
async function waitChange(client: ConcordClient, path: string, deadline: number, emit: (event: Obj) => void, onTick: () => Promise<void>): Promise<Obj> {
  let last = '';
  while (Date.now() < deadline) {
    const change = (await api(client, path)).data;
    if (change.status !== last) { emit({ state: 'change', status: change.status, changeId: change.changeId }); last = change.status; }
    if (['ready', 'queued', 'checking', 'landed', 'blocked', 'failed', 'closed'].includes(change.status)) return change;
    await onTick();
    await pause(1000);
  }
  throw new ConcordError('INSPECTION_TIMEOUT: checker did not finish', 'server');
}
async function prepareHead(source: string, commit: string, parent: string, base: string, canonical: { remote: string; token: string }): Promise<{ work: string; head: string; cleanup: () => Promise<void> }> {
  if (parent === base) return { work: source, head: commit, cleanup: async () => {} };
  const work = await mkdtemp(join(tmpdir(), 'concord-land-'));
  try {
    await git(['clone', '--quiet', '--shared', '--no-checkout', '--', source, work]);
    await git(['fetch', '--no-tags', '--', canonical.remote, base], { token: canonical.token }, work);
    await git(['checkout', '--quiet', '--detach', base], {}, work);
    try { await git(['cherry-pick', '--no-gpg-sign', commit], { identity: true }, work); }
    catch { throw new ConcordError('MERGE_CONFLICT: candidate does not apply to current canonical base', 'conflict'); }
    return { work, head: await git(['rev-parse', 'HEAD'], {}, work), cleanup: () => rm(work, { recursive: true, force: true }) };
  } catch (error) { await rm(work, { recursive: true, force: true }); throw error; }
}
export function approvedHead(evidence: string, head: string): boolean {
  const lines = evidence.split(/\r?\n/);
  const approval = /^APPROVED for merge: ([a-f0-9]{40}(?:[a-f0-9]{24})?)$/i;
  const approvals = lines.filter(line => approval.test(line));
  const named = [...new Set((evidence.match(/\b[a-f0-9]{40}(?:[a-f0-9]{24})?\b/gi) ?? []).map(found => found.toLowerCase()))];
  return approvals.length === 1 && approval.exec(approvals[0])?.[1].toLowerCase() === head.toLowerCase() &&
    named.length === 1 && named[0] === head.toLowerCase() &&
    !/\b(?:NOT\s+APPROVED|REQUEST\s+CHANGES|REJECT(?:ED|ION)?)\b/i.test(evidence) &&
    !lines.some(line => /APPROVED for merge/i.test(line) && !approval.test(line));
}
export async function land(input: LandOptions): Promise<Obj> {
  let options = input;
  if (input.awRun) {
    const run = await readAwRun(input.awRun);
    if (input.commit !== undefined && input.commit.toLowerCase() !== run.commit.toLowerCase())
      throw new ConcordError('--commit conflicts with AW validated_sha', 'usage');
    if (input.allowedFiles !== undefined && resolve(input.allowedFiles) !== resolve(run.allowedFiles))
      throw new ConcordError('--allowed-files conflicts with AW run allowed-files.txt', 'usage');
    options = { ...run, ...input, commit: run.commit, allowedFiles: run.allowedFiles };
  }
  const repo = required(options.repo, '--repo'); const source = resolve(required(options.source, '--source'));
  const commit = required(options.commit, '--commit'); const intentKey = required(options.intentKey, '--intent-key');
  const intent = required(options.intent, '--intent'); const allowedFile = required(options.allowedFiles, '--allowed-files');
  if (!sha.test(commit) || !/^[A-Za-z0-9_-]{1,128}$/.test(intentKey) || !/^[A-Za-z0-9_-]{1,64}$/.test(repo)) throw new ConcordError('invalid repo, intent key, or commit SHA', 'usage');
  if (options.mirrorTo) {
    validateRemote(options.mirrorTo);
    if (new URL(options.mirrorTo).protocol !== 'https:') throw new ConcordError('--mirror-to requires a credential-free HTTPS Git URL', 'usage');
  }
  const changed = await filesChanged(source, commit);
  const allowed = parseAllowed(await readFile(allowedFile, 'utf8'));
  const outside = changed.files.filter(file => !allowed.has(file));
  if (outside.length) throw new ConcordError(`OUTSIDE_ALLOWED_FILES: ${outside.join(', ')}`, 'usage');
  const token = required(process.env.CONCORD_TOKEN, 'CONCORD_TOKEN');
  const url = required(process.env.CONCORD_URL, 'CONCORD_URL');
  const client = input.client ?? new ConcordClient({ url, token });
  const emit = (event: Obj) => (options.emit ?? ((value: Obj) => { process.stdout.write(`${JSON.stringify(redactOutput(value))}\n`); }))({ repo, intentKey, ...event });
  const root = `/repos/${encodeURIComponent(repo)}`;
  const wait = options.waitSeconds ?? 600;
  if (!Number.isSafeInteger(wait) || wait < 0) throw new ConcordError('--wait-seconds must be a nonnegative integer', 'usage');
  const deadline = Date.now() + wait * 1000;
  const repository = (await api(client, root)).data;
  if (!repository.observedCanonicalOid || !sha.test(repository.observedCanonicalOid)) throw new ConcordError('canonical main is unavailable', 'server');
  const initialSnapshot = (await api(client, `${root}/snapshot`)).data;
  const policy = (initialSnapshot.projections?.runners?.jobs ?? []).map((job: Obj) => job.unitPolicy)
    .find((item: Obj | undefined) => item?.digest === repository.policyDigest);
  const units = await unitKeys(source, changed.parent, commit, changed.files, policy);
  if (units.length > 16) throw new ConcordError(`LAND_TOO_MANY_UNITS: ${units.length} units > 16; split the change`, 'usage');
  const branch = `refs/heads/land/${hash(intentKey).slice(7, 23)}`;
  const createBody = { intentKey, intentText: intent, baseOid: repository.observedCanonicalOid, branch, unitKeys: units, dependencyChangeIds: options.dependsOn ?? [] };
  let created = (await api(client, `${root}/changes`, createBody)).data;
  while (created.provisioning?.state !== 'observed' && Date.now() < deadline) {
    await pause(1000);
    created = (await api(client, `${root}/changes`, createBody)).data;
  }
  if (created.provisioning?.state !== 'observed') throw new ConcordError('FORK_TIMEOUT: candidate fork was not provisioned', 'server');
  const changeId = required(created.changeId, 'changeId'); const path = `${root}/changes/${encodeURIComponent(changeId)}`;
  emit({ state: 'created', changeId, baseOid: created.baseOid });
  const existingQueue = (await api(client, `${root}/queue`)).data;
  const alreadyQueued = (existingQueue.entries ?? []).some((item: Obj) => item.changeId === changeId &&
    ['admitted', 'reserved', 'checking', 'landed'].includes(item.state));
  let held: Obj[] = [];
  const refresh = async () => { held = (await leases(client, root)).filter(item => item.changeId === changeId && item.state === 'active' && units.includes(item.unitKey)); };
  const renew = async () => {
    await refresh();
    for (const item of held.filter(value => value.remainingSeconds < 60)) {
      const updated = (await api(client, `${root}/leases/${encodeURIComponent(item.leaseId)}/renew`, { fence: item.fence, ttlSeconds: 300 }, await currentVersion(client, root))).data.lease;
      Object.assign(item, updated); emit({ state: 'lease-renewed', unitKey: item.unitKey, fence: item.fence });
    }
  };
  const fences = () => Object.fromEntries(held.map(item => [item.unitKey, item.fence]));
  try {
    let attempt = 0;
    while (!alreadyQueued) {
      await refresh();
      const missing = units.filter(unit => !held.some(item => item.unitKey === unit));
      if (!missing.length) break;
      try {
        const result = (await api(client, `${root}/leases`, { changeId, unitKeys: missing, intentText: intent, ttlSeconds: 300 }, await currentVersion(client, root))).data;
        held.push(...result.leases); emit({ state: 'leased', unitKeys: result.leases.map((item: Obj) => item.unitKey) });
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
    const prepared = await prepareHead(source, commit, changed.parent, targetBase, canonical);
    try {
      let change = (await api(client, path)).data;
      if (change.headOid && change.baseOid === targetBase && change.headOid !== prepared.head) throw new ConcordError('PUBLISHED_HEAD_MISMATCH: existing intent has a different head', 'conflict');
      if (!change.headOid || change.baseOid !== targetBase) {
        const candidate = await access(client, root, repository, 'write', change.candidateStorageName);
        rejectCanonicalTarget(change.candidateStorageName, repository.canonicalStorageName, candidate.remote, repository.canonicalRemote);
        await git(['-c', 'core.hooksPath=/dev/null', 'push', '--no-follow-tags', '--', candidate.remote, `${prepared.head}:${change.branch}`], { token: candidate.token }, prepared.work);
        await api(client, `${root}/branches`, { storageName: change.candidateStorageName, ref: change.branch, observedHead: prepared.head, ownerId: change.authorId }, await currentVersion(client, root));
        change = (await api(client, path)).data;
        await api(client, `${path}/publish`, { baseOid: targetBase, headOid: prepared.head, branch: change.branch, unitKeys: units, leaseFences: fences() }, (await api(client, path)).version);
        emit({ state: 'published', changeId, headOid: prepared.head });
      }
      change = await waitChange(client, path, deadline, emit, alreadyQueued ? async () => {} : renew);
      if (!['ready', 'queued', 'checking', 'landed'].includes(change.status)) throw new ConcordError(`INSPECTION_FAILED: ${change.status}`, 'server');
      if (!alreadyQueued) await renew();
      const queue = (await api(client, `${root}/queue`)).data;
      let entry = [...(queue.entries ?? [])].reverse().find((item: Obj) => item.changeId === changeId && !['blocked', 'failed', 'withdrawn'].includes(item.state));
      if (!entry) {
        if (!options.reviewEvidence) { emit({ state: 'awaiting-review', changeId, headOid: prepared.head, url: `${client.baseUrl}/v1/repos/${repo}/changes/${changeId}` }); return { status: 'awaiting-review', changeId, headOid: prepared.head }; }
        const reviewerToken = required(process.env.CONCORD_REVIEWER_TOKEN, 'CONCORD_REVIEWER_TOKEN');
        if (reviewerToken === token) throw new ConcordError('reviewer token must differ from author token', 'usage');
        const evidence = await readFile(options.reviewEvidence, 'utf8');
        if (!approvedHead(evidence, prepared.head)) throw new ConcordError('review evidence must approve the exact published head SHA', 'usage');
        const reviewer = new ConcordClient({ url, token: reviewerToken });
        const inspected = await inspection(reviewer, root, change);
        if (!inspected || inspected.outcome !== 'PASS' || !inspected.reviewManifestDigest) throw new ConcordError('trusted inspection result is unavailable', 'server');
        const findings = (await api(reviewer, `${path}/findings`)).data;
        const verdicts = (await api(reviewer, `${path}/verdicts`)).data;
        let verdict = (verdicts.items ?? []).find((item: Obj) => item.revision === change.revision && item.decision === 'approve' && item.evidenceDigest === hash(evidence));
        if (!verdict) verdict = (await api(reviewer, `${path}/verdicts`, { revision: change.revision, reviewManifestDigest: inspected.reviewManifestDigest, findingSetVersion: findings.findingSetVersion, decision: 'approve', evidenceDigest: hash(evidence) }, await currentVersion(reviewer, root))).data;
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
    } finally { await prepared.cleanup(); }
  } finally {
    await refresh().catch(() => {});
    for (const item of held) await api(client, `${root}/leases/${encodeURIComponent(item.leaseId)}/release`, { fence: item.fence }, await currentVersion(client, root)).catch(() => {});
  }
}
