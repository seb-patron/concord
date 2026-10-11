import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { digest, requiresExpectedVersion } from '../src/http';
import { ConcordClient } from '../cli/client';
import { rememberCredential } from '../cli/client';
import { runAwMock } from '../adapters/aw-mock';
import { localEnvironment, dispatchArgv, loadProfile } from '../runner/profiles';
import type { LocalProfile } from '../runner/profiles';

const execFile = promisify(execFileCallback);
const root = dirname(fileURLToPath(import.meta.url));
const actor: Record<string, string> = {
  owner: 'local-owner', A: 'local-agent-a', B: 'local-agent-b', C: 'local-agent-c',
  reviewer: 'local-reviewer', checker: 'local-checker', promoter: 'local-promoter',
  low: 'local-contest-low', high: 'local-contest-high', aw: 'local-mock-aw',
};
const principal: Record<string, string> = { owner: 'owner', A: 'agent-a', B: 'agent-b', C: 'agent-c',
  low: 'contest-agent-low', high: 'contest-agent-high', aw: 'mock-aw' };
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const fileHash = async (path: string) => `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;

export function wranglerStateDir(stateDir: string): string {
  const runHash = createHash('sha256').update(resolve(stateDir)).digest('hex').slice(0, 12);
  return resolve(realpathSync(resolve(root, '..')), '.wrangler', 'state', runHash);
}

export interface Options { run: string; stateDir: string; url: string; pumpLocal: boolean; json: boolean;
  target: 'local' | 'remote'; actors: Record<string, string> }
interface Envelope { status: number; data?: any; version?: number; error?: { code: string; message: string } }
export interface Manifest {
  schemaVersion: 1; run: string; repoId: string; seedOid: string; canonicalOid: string;
  profileDigest: string; policyDigest: string; profilePath: string; workDir: string;
  changes: Record<string, { changeId: string; storageName: string; branch: string; worktree: string;
    baseOid: string | null; headOid: string | null; leaseFences: Record<string, number>; leaseIds: Record<string, string>;
    verdictId: string | null; revision: number }>;
  scenes: string[]; evidence: Record<string, unknown>;
  audit: Array<{ method: string; path: string; actor: string; status: number; requestVersion: number | null;
    responseVersion: number | null; eventSeq: number | null; jobId?: string; resultDigest?: string }>;
}
const pendingAudit: Manifest['audit'] = [];

function validatePath(options: Options): string {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(options.run)) throw new Error('INVALID_RUN_ID');
  if (!options.stateDir || !resolve(options.stateDir).startsWith(resolve(process.env.TMPDIR ?? '/tmp'))) {
    throw new Error('STATE_DIR_MUST_BE_IN_TMPDIR');
  }
  return join(resolve(options.stateDir), options.run + '.json');
}

async function api(options: Options, who: string, method: string, path: string, body?: unknown): Promise<Envelope> {
  if (body && method === 'POST' && path !== '/repos' && requiresExpectedVersion(method, '/v1' + path)) {
    const repoId = /^\/repos\/([^/]+)\//.exec(path)?.[1];
    if (!repoId) throw new Error('VERSION_REPO_ID_MISSING');
    const current = await api(options, who, 'GET', `/repos/${repoId}/snapshot`);
    if (current.status !== 200 || !Number.isSafeInteger(current.version)) throw new Error('VERSION_READ_FAILED');
    body = { ...body as Record<string, unknown>, expectedVersion: current.version };
  }
  const response = await fetch(new URL('/v1' + path, options.url), { method, headers: {
    authorization: `Bearer ${options.actors[who] ?? actor[who]}`, ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': randomUUID() }),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const value = response.status === 204 ? {} : await response.json() as Record<string, unknown>;
  const envelope = { status: response.status, ...value } as Envelope;
  if (method === 'POST' || path.endsWith('/result')) {
    const data = envelope.data as Record<string, any> | undefined;
    pendingAudit.push({ method, path, actor: who, status: response.status,
      requestVersion: (body as { expectedVersion?: number } | undefined)?.expectedVersion ?? null,
      responseVersion: envelope.version ?? null, eventSeq: (envelope as { eventSeq?: number }).eventSeq ?? null,
      ...(typeof data?.jobId === 'string' ? { jobId: data.jobId } : {}),
      ...(typeof data?.result?.resultDigest === 'string' ? { resultDigest: data.result.resultDigest } : {}),
    });
  }
  return envelope;
}
function ok(value: Envelope, label: string): any {
  if (value.status < 200 || value.status >= 300) throw new Error(`${label}: ${value.status} ${value.error?.code ?? ''} ${value.error?.message ?? ''}`);
  return value.data;
}
async function waitFor<T>(label: string, read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let value: T;
  do { value = await read(); if (accept(value)) return value;
    if ((value as Envelope)?.error?.code === 'PROVISIONING_FAILED') throw new Error(`${label}: ${JSON.stringify(value)}`);
    await sleep(150); } while (Date.now() < until);
  throw new Error(`TIMEOUT ${label}: ${JSON.stringify(value).slice(0, 2000)}`);
}
export async function gitWithCredential(cwd: string, secret: string | undefined, ...args: string[]): Promise<string> {
  if (secret) rememberCredential(secret);
  try {
    const { stdout } = await execFile('git', args, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024, env: {
    ...process.env, GIT_AUTHOR_NAME: 'Concord Demo', GIT_AUTHOR_EMAIL: 'demo@example.test',
    GIT_COMMITTER_NAME: 'Concord Demo', GIT_COMMITTER_EMAIL: 'demo@example.test',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    ...(secret ? { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${secret}` } : {}),
  } });
    return stdout.trim();
  } catch { throw new Error('DEMO_GIT_FAILED'); }
}
const git = (cwd: string, ...args: string[]) => gitWithCredential(cwd, undefined, ...args);
export function demoGitRemote(options: Pick<Options, 'target' | 'url'>, remote: string): string {
  let url: URL;
  try { url = new URL(remote); } catch { throw new Error('INVALID_GIT_REMOTE'); }
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol === 'file:' ? !!url.hostname || (options.target === 'remote' &&
      !['127.0.0.1', 'localhost'].includes(new URL(options.url).hostname)) : options.target === 'local' || url.protocol !== 'https:')) throw new Error('INVALID_GIT_REMOTE');
  return remote;
}

export async function prepareLocal(stateDir: string): Promise<{ profile: LocalProfile; trustedConfig: string }> {
  const directory = resolve(stateDir);
  if (!directory.startsWith(resolve(process.env.TMPDIR ?? '/tmp'))) throw new Error('STATE_DIR_MUST_BE_IN_TMPDIR');
  await mkdir(directory, { recursive: true });
  const template = JSON.parse(await readFile(join(root, 'profile.json'), 'utf8')) as Record<string, unknown>;
  const checkerFile = join(root, 'checker.mjs');
  const checkerDigest = await fileHash(checkerFile);
  const profileInput = { ...template, checkerFile, executable: process.execPath, argv: dispatchArgv,
    toolchainFile: process.execPath, checkerDigest, oracleDigest: await digest(template.cases),
    toolchainDigest: await fileHash(process.execPath), environmentDigest: await digest(localEnvironment()) };
  const profilePath = join(directory, 'dispatch-profile.json');
  await writeFile(profilePath, JSON.stringify({ ...profileInput, digest: await digest(profileInput) }, null, 2) + '\n');
  const profile = await loadProfile(profilePath);
  const unitTemplate = JSON.parse(await readFile(join(root, 'units.json'), 'utf8')) as Record<string, unknown>;
  const policyInput = { ...unitTemplate, checkerDigest };
  const policy = { ...policyInput, digest: await digest(policyInput) };
  const trustedConfig = JSON.stringify({ policies: { 'dispatch-lab': policy }, profiles: { 'dispatch-lab': {
    id: profile.id, digest: profile.digest, toolchainDigest: profile.toolchainDigest, oracleDigest: profile.oracleDigest,
    environmentDigest: profile.environmentDigest, timeoutMs: profile.timeoutMs, maxOutputBytes: profile.maxOutputBytes,
  } } });
  await writeFile(join(directory, 'trusted-config.json'), trustedConfig + '\n');
  return { profile, trustedConfig };
}

async function snapshot(options: Options, manifest: Manifest): Promise<any> {
  return ok(await api(options, 'owner', 'GET', `/repos/${manifest.repoId}/snapshot`), 'snapshot').projections;
}
async function queue(options: Options, manifest: Manifest): Promise<any> {
  return ok(await api(options, 'owner', 'GET', `/repos/${manifest.repoId}/queue`), 'queue');
}
async function change(options: Options, manifest: Manifest, alias: string): Promise<any> {
  return ok(await api(options, 'owner', 'GET', `/repos/${manifest.repoId}/changes/${manifest.changes[alias].changeId}`), 'change');
}
async function changeById(options: Options, manifest: Manifest, id: string): Promise<any> {
  return ok(await api(options, 'owner', 'GET', `/repos/${manifest.repoId}/changes/${id}`), 'change');
}
async function save(options: Options, manifest: Manifest): Promise<void> {
  await writeFile(validatePath(options), JSON.stringify(manifest, null, 2) + '\n');
}
export async function load(options: Options): Promise<Manifest> {
  return JSON.parse(await readFile(validatePath(options), 'utf8')) as Manifest;
}

async function pump(options: Options, manifest: Manifest, until: (view: any) => boolean, label: string,
  maxChecker = 16, maxPromoter = 4): Promise<any> {
  const deadline = Date.now() + 60_000;
  let checker = 0, promoter = 0, last: any;
  while (Date.now() < deadline) {
    last = await snapshot(options, manifest);
    if (until(last)) return last;
    const pending = (last.runners?.jobs ?? []).filter((job: any) => job.state === 'pending');
    const job = pending.find((item: any) => item.kind !== 'promote') ?? pending.find((item: any) => item.kind === 'promote');
    if (job && (options.pumpLocal || options.target === 'remote')) {
      const role = job.kind === 'promote' ? 'promoter' : 'checker';
      if (role === 'checker' ? ++checker > maxChecker : ++promoter > maxPromoter) throw new Error(`PUMP_BOUND ${label}`);
      const args = ['runner/main.ts', '--repo', manifest.repoId, '--role', role, '--once'];
      if (role === 'checker') args.push('--profile', manifest.profilePath);
      const { stdout } = await execFile(options.target === 'remote' ? 'npm' : process.execPath,
        options.target === 'remote' ? ['run', 'runner', '--', ...args.slice(1)] : ['--import', 'tsx', ...args], {
        cwd: process.cwd(), timeout: 35_000, env: { ...process.env, CONCORD_URL: options.url,
          CONCORD_TOKEN: options.actors[role] ?? actor[role], CONCORD_PROFILE_DIGEST: manifest.profileDigest }, maxBuffer: 1024 * 1024 });
      if (!stdout.includes('Completed 1 job(s)')) throw new Error(`RUNNER_IDLE ${label}: ${stdout}`);
      await waitFor(`result ${job.jobId}`, () => api(options, 'reviewer', 'GET',
        `/repos/${manifest.repoId}/jobs/${job.jobId}/result`), value => value.status === 200, 10_000);
    } else await sleep(150);
  }
  throw new Error(`TIMEOUT ${label}: ${JSON.stringify(last).slice(0, 2500)}`);
}

async function tokenRemote(options: Options, manifest: Manifest, storageName: string, who: string): Promise<{ remote: string; secret: string }> {
  const detail = ok(await api(options, who, 'POST', `/repos/${manifest.repoId}/git-token`,
    { storageName, scope: 'write', ttlSeconds: 600 }), 'git token');
  return { remote: demoGitRemote(options, detail.remote), secret: detail.secret };
}
async function createDraft(options: Options, manifest: Manifest, alias: string, who: string, intentKey: string,
  intentText: string, baseOid: string | null, unitKeys: string[], dependencies: string[] = []): Promise<void> {
  if (manifest.changes[alias]) return;
  const body = { intentKey, intentText, baseOid, branch: 'refs/heads/demo', unitKeys, dependencyChangeIds: dependencies };
  const created = ok(await api(options, who, 'POST', `/repos/${manifest.repoId}/changes`, body), `create ${alias}`);
  const observed = await waitFor(`${alias} fork`, () => api(options, who, 'POST', `/repos/${manifest.repoId}/changes`, body),
    value => value.status === 200 || value.status === 201);
  const data = ok(observed, `fork ${alias}`) ?? created;
  manifest.changes[alias] = { changeId: data.changeId, storageName: data.candidateStorageName, branch: data.branch,
    worktree: join(manifest.workDir, alias), baseOid, headOid: null, leaseFences: {}, leaseIds: {}, verdictId: null, revision: 0 };
  await save(options, manifest);
}

async function prepareCheckout(options: Options, manifest: Manifest, alias: string, _who: string, baseOid: string): Promise<void> {
  const item = manifest.changes[alias];
  await mkdir(item.worktree, { recursive: true });
  await git(item.worktree, 'init', '--quiet');
  const repo = ok(await api(options, 'owner', 'GET', `/repos/${manifest.repoId}`), 'repo detail');
  const detail = ok(await api(options, 'owner', 'POST', `/repos/${manifest.repoId}/git-token`, {
    storageName: repo.canonicalStorageName, scope: 'read', ttlSeconds: 600 }), 'canonical read token');
  await gitWithCredential(item.worktree, options.target === 'remote' ? detail.secret : undefined,
    'fetch', '--quiet', demoGitRemote(options, detail.remote), baseOid);
  await git(item.worktree, 'switch', '--detach', baseOid);
}

async function editTable(worktree: string, family: string, retry: number, timeout: number): Promise<void> {
  const path = join(worktree, 'families.tsv');
  const old = await readFile(path, 'utf8');
  const lines = old.split('\n').map(line => line.startsWith(family + '\t') ? `${family}\t${retry}\t${timeout}` : line);
  if (lines.join('\n') === old) throw new Error('NO_DELTA:' + family);
  await writeFile(path, lines.join('\n'));
}
async function commitPush(options: Options, manifest: Manifest, alias: string, who: string, message: string): Promise<string> {
  const item = manifest.changes[alias];
  await git(item.worktree, 'add', '-A');
  await git(item.worktree, 'commit', '--quiet', '-m', message);
  const head = await git(item.worktree, 'rev-parse', 'HEAD');
  const remote = await tokenRemote(options, manifest, item.storageName, who);
  await gitWithCredential(item.worktree, options.target === 'remote' ? remote.secret : undefined,
    'push', '--quiet', ...(item.headOid ? [`--force-with-lease=${item.branch}:${item.headOid}`] : []),
    remote.remote, `HEAD:${item.branch}`);
  const current = await change(options, manifest, alias);
  ok(await api(options, who, 'POST', `/repos/${manifest.repoId}/branches`, {
    expectedVersion: current.version, storageName: item.storageName, ref: item.branch,
    observedHead: head, ownerId: principal[who],
  }), `register ${alias}`);
  item.headOid = head;
  await save(options, manifest);
  return head;
}

export async function seed(options: Options): Promise<Manifest> {
  const path = validatePath(options);
  try { return JSON.parse(await readFile(path, 'utf8')) as Manifest; } catch { /* first run */ }
  const { profile, trustedConfig } = await prepareLocal(options.stateDir);
  const policyDigest = (JSON.parse(trustedConfig) as any).policies['dispatch-lab'].digest as string;
  const repoId = `dispatch_${options.run}`;
  const ready = await waitFor('repo ready', () => api(options, 'owner', 'POST', '/repos',
    { name: repoId, policyId: 'dispatch-lab', profileId: 'dispatch-lab' }), value => value.status === 201);
  ok(ready, 'repo create');
  const manifest: Manifest = { schemaVersion: 1, run: options.run, repoId, seedOid: '', canonicalOid: '',
    profileDigest: profile.digest, policyDigest, profilePath: profile.sourcePath!, workDir: join(resolve(options.stateDir), options.run),
    changes: {}, scenes: [], evidence: {}, audit: [] };
  await mkdir(manifest.workDir, { recursive: true });
  await createDraft(options, manifest, 'seed', 'owner', 'seed', 'Public dispatch-lab root', null, ['file:families.tsv']);
  const checkout = manifest.changes.seed.worktree;
  await mkdir(checkout, { recursive: true });
  await git(checkout, 'init', '--quiet');
  for (const name of ['families.tsv', 'dispatch.mjs', 'README.md']) await copyFile(join(root, 'dispatch-lab', name), join(checkout, name));
  const oid = await commitPush(options, manifest, 'seed', 'owner', 'Public dispatch-lab seed');
  manifest.seedOid = oid;
  const current = ok(await api(options, 'owner', 'GET', `/repos/${manifest.repoId}`), 'repo detail');
  ok(await api(options, 'owner', 'POST', `/repos/${manifest.repoId}/bootstrap`, { expectedVersion: current.version,
    seedStorageName: manifest.changes.seed.storageName, seedRef: manifest.changes.seed.branch, headOid: oid,
    policyId: 'dispatch-lab', profileId: 'dispatch-lab' }), 'bootstrap');
  await pump({ ...options, pumpLocal: true }, manifest, view => view.queue?.finalCanonicalOid === oid, 'bootstrap');
  manifest.canonicalOid = oid;
  await save(options, manifest);
  for (const [alias, who, key, intent, unit] of [
    ['A', 'A', 'A', 'tune-alpha', 'row:families:alpha'],
    ['B', 'B', 'B', 'tune-gamma', 'row:families:gamma'],
    ['C', 'C', 'C', 'tune-delta', 'row:families:delta'],
    ['X', 'B', 'X', 'alpha-alternative', 'row:families:alpha'],
  ]) await createDraft(options, manifest, alias, who, key, intent, oid, [unit]);
  for (const [alias, who, family, retry, timeout] of [
    ['A', 'A', 'alpha', 2, 1000], ['B', 'B', 'gamma', 0, 0], ['C', 'C', 'delta', 5, 1000],
  ] as const) {
    await prepareCheckout(options, manifest, alias, who, oid);
    await editTable(manifest.changes[alias].worktree, family, retry, timeout);
    await commitPush(options, manifest, alias, who, `${alias} ${family} policy`);
  }
  manifest.scenes.push('seed');
  manifest.audit.push(...pendingAudit.splice(0));
  await save(options, manifest);
  return manifest;
}

async function claim(options: Options, manifest: Manifest, alias: string, who: string, unitKeys: string[]): Promise<Envelope> {
  const item = manifest.changes[alias];
  const response = await api(options, who, 'POST', `/repos/${manifest.repoId}/leases`, {
    changeId: item.changeId, unitKeys, intentText: `${alias} changes ${unitKeys.join(', ')}`, ttlSeconds: 300,
  });
  if (response.status === 201) {
    for (const lease of response.data.leases) { item.leaseFences[lease.unitKey] = lease.fence; item.leaseIds[lease.unitKey] = lease.leaseId; }
    await save(options, manifest);
  }
  return response;
}
async function release(options: Options, manifest: Manifest, alias: string, who: string): Promise<void> {
  const item = manifest.changes[alias];
  for (const [unitKey, leaseId] of Object.entries(item.leaseIds)) {
    const listing = ok(await api(options, who, 'GET', `/repos/${manifest.repoId}/leases`), 'leases');
    const lease = listing.items.find((value: any) => value.leaseId === leaseId);
    if (lease?.state === 'active') ok(await api(options, who, 'POST', `/repos/${manifest.repoId}/leases/${leaseId}/release`, {
      expectedVersion: lease.version, fence: lease.fence,
    }), 'release');
    delete item.leaseFences[unitKey];
    delete item.leaseIds[unitKey];
  }
  await save(options, manifest);
}
async function publish(options: Options, manifest: Manifest, alias: string, who: string, unitKeys: string[],
  fences = manifest.changes[alias].leaseFences): Promise<void> {
  const item = manifest.changes[alias];
  const current = await change(options, manifest, alias);
  ok(await api(options, who, 'POST', `/repos/${manifest.repoId}/changes/${item.changeId}/publish`, {
    expectedVersion: current.version, baseOid: item.baseOid, headOid: item.headOid, branch: item.branch,
    unitKeys, leaseFences: fences,
  }), `publish ${alias}`);
  const ready = await pump(options, manifest, view => view.repos?.changes?.some((value: any) =>
    value.changeId === item.changeId && value.status === 'ready' && value.revision > item.revision), `inspect ${alias}`);
  const updated = ready.repos.changes.find((value: any) => value.changeId === item.changeId);
  item.revision = updated.revision;
  await save(options, manifest);
}
async function inspectionResult(options: Options, manifest: Manifest, alias: string): Promise<any> {
  const item = manifest.changes[alias];
  const view = await snapshot(options, manifest);
  const job = [...(view.runners?.jobs ?? [])].reverse().find((value: any) => value.kind === 'inspect-candidate' &&
    value.changeId === item.changeId && value.revision === item.revision && value.state === 'completed');
  if (!job) throw new Error(`INSPECTION_RESULT_MISSING ${alias}`);
  return ok(await api(options, 'reviewer', 'GET', `/repos/${manifest.repoId}/jobs/${job.jobId}/result`), 'inspection result').result;
}
async function approve(options: Options, manifest: Manifest, alias: string): Promise<void> {
  const item = manifest.changes[alias];
  const inspected = await inspectionResult(options, manifest, alias);
  if (inspected.outcome !== 'PASS' || !inspected.reviewManifestDigest) throw new Error(`INSPECTION_FAILED ${alias}`);
  const findings = ok(await api(options, 'reviewer', 'GET', `/repos/${manifest.repoId}/changes/${item.changeId}/findings`), 'findings');
  const current = await change(options, manifest, alias);
  const verdict = ok(await api(options, 'reviewer', 'POST', `/repos/${manifest.repoId}/changes/${item.changeId}/verdicts`, {
    expectedVersion: current.version, revision: item.revision, reviewManifestDigest: inspected.reviewManifestDigest,
    findingSetVersion: findings.findingSetVersion, decision: 'approve', evidenceDigest: await digest({ alias, headOid: item.headOid }),
  }), `approve ${alias}`);
  item.verdictId = verdict.verdictId;
  await save(options, manifest);
}
async function enqueue(options: Options, manifest: Manifest, alias: string): Promise<void> {
  const item = manifest.changes[alias];
  const current = await api(options, 'owner', 'GET', `/repos/${manifest.repoId}/queue`);
  ok(await api(options, alias === 'A' || alias === 'D' || alias === 'H' ? 'A' :
    alias === 'B' || alias === 'I' ? 'B' : alias === 'C' || alias === 'E' ? 'C' : 'owner',
  'POST', `/repos/${manifest.repoId}/queue/enqueue`, { expectedVersion: current.version,
    changeId: item.changeId, verdictId: item.verdictId, leaseFences: item.leaseFences }), `enqueue ${alias}`);
}
async function land(options: Options, manifest: Manifest, alias: string): Promise<void> {
  const item = manifest.changes[alias];
  const view = await pump(options, manifest, value => value.queue?.entries?.some((entry: any) =>
    entry.changeId === item.changeId && entry.state === 'landed') && !!value.queue.finalCanonicalOid, `land ${alias}`);
  manifest.canonicalOid = view.queue.finalCanonicalOid;
  await save(options, manifest);
}
async function checkoutAt(options: Options, manifest: Manifest, alias: string, base: string): Promise<void> {
  const item = manifest.changes[alias];
  const repo = ok(await api(options, 'owner', 'GET', `/repos/${manifest.repoId}`), 'repo detail');
  const detail = ok(await api(options, 'owner', 'POST', `/repos/${manifest.repoId}/git-token`, {
    storageName: repo.canonicalStorageName, scope: 'read', ttlSeconds: 600 }), 'canonical read token');
  await gitWithCredential(item.worktree, options.target === 'remote' ? detail.secret : undefined,
    'fetch', '--quiet', demoGitRemote(options, detail.remote), base);
  await git(item.worktree, 'switch', '--detach', base);
  item.baseOid = base;
}
async function newRowChange(options: Options, manifest: Manifest, alias: string, who: string, intent: string,
  unit: string, family: string, retry: number, timeout: number, base = manifest.canonicalOid): Promise<void> {
  await createDraft(options, manifest, alias, who, intent, `${alias} policy`, base, [unit]);
  await prepareCheckout(options, manifest, alias, who, base);
  await editTable(manifest.changes[alias].worktree, family, retry, timeout);
  await commitPush(options, manifest, alias, who, `${alias} ${family} policy`);
  ok(await claim(options, manifest, alias, who, [unit]), `claim ${alias}`);
  await publish(options, manifest, alias, who, [unit]);
  await approve(options, manifest, alias);
}

export async function scene(options: Options, name: string): Promise<Manifest> {
  const manifest = await load(options);
  if (manifest.scenes.includes(name)) return manifest;
  const need = (sceneName: string) => { if (!manifest.scenes.includes(sceneName)) throw new Error(`SCENE_ORDER: ${sceneName} required`); };
  if (name === 'context') {
    need('seed');
    manifest.evidence.context = { source: 'owner-reported aggregates, 2026-10-10; not a replay result',
      sharedHeaderPRs: '111/122', landBlockedFunctions: 726, conflictedApprovals: '3/9' };
  } else if (name === 'leases') {
    need('context');
    const a = claim(options, manifest, 'A', 'A', ['row:families:alpha']);
    const x = claim(options, manifest, 'X', 'B', ['row:families:alpha']);
    const [first, second] = await Promise.all([a, x]);
    const aWins = first.status === 201 && second.status === 409 && second.error?.code === 'LEASE_CONFLICT';
    const xWins = second.status === 201 && first.status === 409 && first.error?.code === 'LEASE_CONFLICT';
    if (!aWins && !xWins) {
      throw new Error(`LEASE_RACE_UNEXPECTED ${first.status}/${second.status}`);
    }
    if (xWins) {
      await release(options, manifest, 'X', 'B');
      ok(await claim(options, manifest, 'A', 'A', ['row:families:alpha']), 'A reacquires alpha');
    }
    const detail = await change(options, manifest, 'X');
    ok(await api(options, 'B', 'POST', `/repos/${manifest.repoId}/changes/${manifest.changes.X.changeId}/close`,
      { expectedVersion: detail.version }), 'close X');
    ok(await claim(options, manifest, 'B', 'B', ['row:families:gamma']), 'claim B');
    ok(await claim(options, manifest, 'C', 'C', ['row:families:delta']), 'claim C');
    manifest.evidence.leases = { firstWinner: aWins ? 'A' : 'X',
      grant: (aWins ? first : second).data.leases[0], refusal: (aWins ? second : first).error,
      concurrentRows: ['alpha', 'gamma', 'delta'] };
  } else if (name === 'stack') {
    need('leases');
    for (const [alias, who, unit] of [['A', 'A', 'row:families:alpha'], ['B', 'B', 'row:families:gamma'],
      ['C', 'C', 'row:families:delta']]) {
      await publish(options, manifest, alias, who, [unit]);
      await approve(options, manifest, alias);
    }
    for (const alias of ['A', 'B', 'C']) await enqueue(options, manifest, alias);
    const view = await pump(options, manifest, value => !!value.queue?.diagnosis, 'composed failure', 4, 0);
    manifest.evidence.stack = { diagnosis: view.queue.diagnosis, activeJobId: view.queue.activeStackJobId,
      canonicalOid: view.queue.observedMain };
  } else if (name === 'isolate') {
    need('stack');
    const view = await pump(options, manifest, value => ['A', 'C'].every(alias => value.queue?.entries?.some((entry: any) =>
      entry.changeId === manifest.changes[alias].changeId && entry.state === 'landed')) &&
      value.queue.entries.some((entry: any) => entry.changeId === manifest.changes.B.changeId && entry.state === 'blocked'),
    'survivors landed');
    manifest.canonicalOid = view.queue.finalCanonicalOid;
    manifest.evidence.isolate = { diagnosticResults: view.queue.diagnosticResults, finalCanonicalOid: manifest.canonicalOid,
      blocked: view.queue.entries.find((entry: any) => entry.changeId === manifest.changes.B.changeId) };
  } else if (name === 'negative') {
    need('isolate');
    const before = await queue(options, manifest);
    const originalTicket = before.promotion?.promotionId;
    for (const [alias, unit] of [['wrong-exec', 'file:dispatch.mjs'], ['wrong-row', 'row:families:alpha']] as const) {
      await createDraft(options, manifest, alias, 'A', alias, `${alias} negative acceptance`, manifest.canonicalOid, [unit]);
      await prepareCheckout(options, manifest, alias, 'A', manifest.canonicalOid);
      ok(await claim(options, manifest, alias, 'A', [unit]), `claim ${alias}`);
      if (alias === 'wrong-row') await editTable(manifest.changes[alias].worktree, 'alpha', 3, 1000);
      else {
        const path = join(manifest.changes[alias].worktree, 'dispatch.mjs');
        const original = await readFile(path, 'utf8');
        const altered = original.replace('return Number(cells[1]) * Number(cells[2]);',
          "return family === 'alpha' ? Math.min(5000, Number(cells[1]) * Number(cells[2]) + 250) : Number(cells[1]) * Number(cells[2]);");
        if (altered === original) throw new Error('EXECUTABLE_PATCH_MISSED');
        await writeFile(path, altered);
      }
      await commitPush(options, manifest, alias, 'A', `${alias} negative candidate`);
      await publish(options, manifest, alias, 'A', [unit]);
      const inspected = await inspectionResult(options, manifest, alias);
      if (inspected.unitKeys.join(',') !== unit) throw new Error(`NEGATIVE_UNIT_MISMATCH ${alias}`);
      await approve(options, manifest, alias);
      await enqueue(options, manifest, alias);
      const admitted = await queue(options, manifest);
      const entry = admitted.entries.find((value: any) => value.changeId === manifest.changes[alias].changeId);
      if (!entry || entry.reservationFences[unit] !== manifest.changes[alias].leaseFences[unit]) throw new Error('NEGATIVE_NOT_ADMITTED');
      const finished = await pump(options, manifest, value => value.queue?.entries?.some((value: any) =>
        value.changeId === manifest.changes[alias].changeId && value.state === 'blocked'), `negative ${alias}`);
      if (finished.queue.promotion?.promotionId !== originalTicket || finished.queue.finalCanonicalOid !== manifest.canonicalOid) {
        throw new Error('NEGATIVE_PROMOTED');
      }
      const checkerJobs = (finished.runners.jobs as any[]).filter(job => job.kind === 'validate-stack' &&
        job.candidates?.some((candidate: any) => candidate.changeId === manifest.changes[alias].changeId));
      const checked = await Promise.all(checkerJobs.map(job => api(options, 'reviewer', 'GET',
        `/repos/${manifest.repoId}/jobs/${job.jobId}/result`)));
      if (!checked.some(value => value.status === 200 && value.data.result.outcome === 'FAIL')) throw new Error('NEGATIVE_CHECKER_DID_NOT_FAIL');
      manifest.evidence[alias] = { declaredUnit: unit, inspectedUnitKeys: inspected.unitKeys,
        reservationFences: entry.reservationFences, admitted: true, checkerOutcomes: checked.filter(value => value.status === 200)
          .map(value => value.data.result.outcome), promotionIssued: false };
    }
  } else if (name === 'repair') {
    need('isolate');
    const b = manifest.changes.B;
    const detail = await change(options, manifest, 'B');
    const f1 = ok(await api(options, 'reviewer', 'POST', `/repos/${manifest.repoId}/changes/${b.changeId}/findings`, {
      expectedVersion: detail.version, revision: b.revision, unitKey: 'row:families:gamma', text: 'Gamma retry limit is zero',
      evidenceDigest: await digest('gamma retry 0'), semanticAnchor: { kind: 'unit', key: 'row:families:gamma' },
    }), 'finding F-1');
    const f2 = ok(await api(options, 'reviewer', 'POST', `/repos/${manifest.repoId}/changes/${b.changeId}/findings`, {
      expectedVersion: (await change(options, manifest, 'B')).version, revision: b.revision,
      unitKey: 'row:families:gamma', text: 'Gamma timeout is zero', evidenceDigest: await digest('gamma timeout 0'),
      semanticAnchor: { kind: 'unit', key: 'row:families:gamma' },
    }), 'finding F-2');
    ok(await claim(options, manifest, 'B', 'B', ['row:families:gamma']), 'reclaim B');
    await checkoutAt(options, manifest, 'B', manifest.canonicalOid);
    await editTable(b.worktree, 'gamma', 4, 1250);
    await commitPush(options, manifest, 'B', 'B', 'B complete gamma repair');
    await publish(options, manifest, 'B', 'B', ['row:families:gamma']);
    const findings = ok(await api(options, 'reviewer', 'GET', `/repos/${manifest.repoId}/changes/${b.changeId}/findings`), 'findings');
    const incomplete = await api(options, 'B', 'POST', `/repos/${manifest.repoId}/changes/${b.changeId}/repairs`, {
      expectedVersion: (await change(options, manifest, 'B')).version, revision: b.revision,
      findingSetVersion: findings.findingSetVersion, dispositions: [{ findingId: f1.findingId,
        explanation: 'Raised retry limit', evidenceDigest: await digest('repair F1') }],
    });
    if (incomplete.status !== 409) throw new Error(`INCOMPLETE_REPAIR_ACCEPTED ${incomplete.status}`);
    const round = ok(await api(options, 'B', 'POST', `/repos/${manifest.repoId}/changes/${b.changeId}/repairs`, {
      expectedVersion: (await change(options, manifest, 'B')).version, revision: b.revision,
      findingSetVersion: findings.findingSetVersion, dispositions: [f1, f2].map((finding: any) => ({
        findingId: finding.findingId, explanation: 'Repaired gamma row', evidenceDigest: finding.evidenceDigest,
      })),
    }), 'complete repair');
    ok(await api(options, 'reviewer', 'POST', `/repos/${manifest.repoId}/changes/${b.changeId}/repairs/${round.number}/review`, {
      expectedVersion: (await change(options, manifest, 'B')).version, revision: b.revision,
      findingSetVersion: findings.findingSetVersion, decision: 'accept', evidenceDigest: await digest('gamma repair review'),
    }), 'review repair');
    await approve(options, manifest, 'B');
    await enqueue(options, manifest, 'B');
    await land(options, manifest, 'B');
    manifest.evidence.repair = { findingIds: [f1.findingId, f2.findingId], incompleteStatus: incomplete.status,
      roundId: round.roundId, canonicalOid: manifest.canonicalOid };
  } else if (name === 'carry') {
    need('repair');
    const base = manifest.canonicalOid;
    await newRowChange(options, manifest, 'D', 'A', 'D', 'row:families:alpha', 'alpha', 3, 1000, base);
    await newRowChange(options, manifest, 'E', 'C', 'E', 'row:families:delta', 'delta', 4, 1500, base);
    const parent = manifest.changes.D.verdictId!;
    await enqueue(options, manifest, 'E');
    await land(options, manifest, 'E');
    await checkoutAt(options, manifest, 'D', manifest.canonicalOid);
    await editTable(manifest.changes.D.worktree, 'alpha', 3, 1000);
    await commitPush(options, manifest, 'D', 'A', 'D rebuilt against E');
    await publish(options, manifest, 'D', 'A', ['row:families:alpha']);
    const request = ok(await api(options, 'reviewer', 'POST', `/repos/${manifest.repoId}/changes/${manifest.changes.D.changeId}/carry`, {
      expectedVersion: (await change(options, manifest, 'D')).version, parentVerdictId: parent,
      revision: manifest.changes.D.revision, newBaseOid: manifest.canonicalOid,
    }), 'carry D');
    await pump(options, manifest, value => value.runners?.jobs?.some((job: any) => job.jobId === request.jobId && job.state === 'completed'), 'delta D');
    const verdicts = ok(await api(options, 'reviewer', 'GET', `/repos/${manifest.repoId}/changes/${manifest.changes.D.changeId}/verdicts`), 'D verdicts');
    const derived = verdicts.items.find((item: any) => item.parentVerdictId === parent);
    if (!derived) throw new Error('D_CARRY_NOT_GRANTED');
    manifest.changes.D.verdictId = derived.verdictId;
    await enqueue(options, manifest, 'D');
    await land(options, manifest, 'D');
    manifest.evidence.carry = { parentVerdictId: parent, derivedVerdictId: derived.verdictId,
      deltaJobId: request.jobId, canonicalOid: manifest.canonicalOid };
  } else if (name === 'invalidate') {
    need('carry');
    const base = manifest.canonicalOid;
    await newRowChange(options, manifest, 'H', 'A', 'H', 'row:families:alpha', 'alpha', 4, 1000, base);
    await newRowChange(options, manifest, 'I', 'B', 'I', 'row:families:beta', 'beta', 3, 1000, base);
    const parent = manifest.changes.H.verdictId!;
    await enqueue(options, manifest, 'I');
    await land(options, manifest, 'I');
    await checkoutAt(options, manifest, 'H', manifest.canonicalOid);
    await editTable(manifest.changes.H.worktree, 'alpha', 4, 1000);
    await commitPush(options, manifest, 'H', 'A', 'H rebuilt after beta changed');
    await publish(options, manifest, 'H', 'A', ['row:families:alpha']);
    const request = ok(await api(options, 'reviewer', 'POST', `/repos/${manifest.repoId}/changes/${manifest.changes.H.changeId}/carry`, {
      expectedVersion: (await change(options, manifest, 'H')).version, parentVerdictId: parent,
      revision: manifest.changes.H.revision, newBaseOid: manifest.canonicalOid,
    }), 'carry H');
    await pump(options, manifest, value => value.runners?.jobs?.some((job: any) => job.jobId === request.jobId && job.state === 'completed'), 'delta H');
    const verdicts = ok(await api(options, 'reviewer', 'GET', `/repos/${manifest.repoId}/changes/${manifest.changes.H.changeId}/verdicts`), 'H verdicts');
    if (verdicts.items.some((item: any) => item.parentVerdictId === parent)) throw new Error('H_CARRY_WRONGLY_GRANTED');
    ok(await api(options, 'A', 'POST', `/repos/${manifest.repoId}/changes/${manifest.changes.H.changeId}/close`, {
      expectedVersion: (await change(options, manifest, 'H')).version,
    }), 'close H');
    await release(options, manifest, 'H', 'A');
    manifest.evidence.invalidate = { parentVerdictId: parent, deltaJobId: request.jobId, carried: false,
      canonicalOid: manifest.canonicalOid };
  } else if (name === 'contest') {
    need('invalidate');
    const base = manifest.canonicalOid;
    const contestRepo = ok(await api(options, 'owner', 'GET', `/repos/${manifest.repoId}`), 'contest repository');
    ok(await api(options, 'owner', 'POST', `/repos/${manifest.repoId}/intent-contests`, {
      expectedVersion: contestRepo.version, intentKey: 'J', childAuthorIds: [principal.low, principal.high],
    }), 'authorize contest intent');
    await createDraft(options, manifest, 'J-low', 'low', 'J', 'epsilon-contest', base, ['row:families:epsilon']);
    await createDraft(options, manifest, 'J-high', 'high', 'J', 'epsilon-contest', base, ['row:families:epsilon']);
    ok(await claim(options, manifest, 'J-low', 'low', ['row:families:epsilon']), 'claim J');
    for (const [alias, who, timeout] of [['J-low', 'low', 500], ['J-high', 'high', 1000]] as const) {
      await prepareCheckout(options, manifest, alias, who, base);
      await editTable(manifest.changes[alias].worktree, 'epsilon', 2, timeout);
      await commitPush(options, manifest, alias, who, `${alias} epsilon`);
      await publish(options, manifest, alias, who, ['row:families:epsilon'], manifest.changes['J-low'].leaseFences);
      await approve(options, manifest, alias);
    }
    const children = ['J-low', 'J-high'] as const;
    const contest = ok(await api(options, 'owner', 'POST', `/repos/${manifest.repoId}/contests`, {
      intentKey: 'J', intentText: 'epsilon-contest', unitKey: 'row:families:epsilon', baseOid: base,
      profileId: 'dispatch-lab', childChangeIds: children.map(alias => manifest.changes[alias].changeId),
      verdictIds: children.map(alias => manifest.changes[alias].verdictId),
      leaseFences: children.map(() => manifest.changes['J-low'].leaseFences),
    }), 'create contest');
    const selected = await pump(options, manifest, value => value.queue?.contests?.some((item: any) =>
      item.contestId === contest.contestId && item.state === 'selected'), 'contest selected');
    const jobs = (selected.runners.jobs as any[]).filter(job => job.kind === 'validate-stack' && job.contest === true &&
      children.some(alias => job.candidates?.[0]?.changeId === manifest.changes[alias].changeId));
    if (jobs.length !== 2 || jobs.some(job => job.caseId !== 'j-common' || job.canonicalBaseOid !== base)) throw new Error('J_COMMON_CASE_MISSING');
    const results = await Promise.all(jobs.map(job => api(options, 'reviewer', 'GET', `/repos/${manifest.repoId}/jobs/${job.jobId}/result`)));
    const scores = results.map((value, i) => ({ jobId: jobs[i].jobId, ...ok(value, 'contest result').result }));
    if (scores.some(value => value.outcome !== 'PASS' || value.gateResults?.[0]?.outcome !== 'PASS') ||
      scores.map(value => value.score?.matched).sort().join(',') !== '2,4') throw new Error('J_HARD_GATE_OR_SCORE_MISMATCH');
    await land(options, manifest, 'J-high');
    manifest.evidence.contest = { contestId: contest.contestId, hardGateCaseId: 'j-common', baseOid: base,
      scores: scores.map(value => ({ jobId: value.jobId, outcome: value.outcome, score: value.score, gateResults: value.gateResults })),
      winnerId: manifest.changes['J-high'].changeId, canonicalOid: manifest.canonicalOid };
  } else if (name === 'dedupe') {
    need('contest');
    const ids: string[] = [];
    const observedBases: string[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const observedBaseOid = attempt === 0 ? manifest.seedOid : manifest.canonicalOid;
      observedBases.push(observedBaseOid);
      const value = ok(await api(options, 'aw', 'POST', `/repos/${manifest.repoId}/changes`, {
        intentKey: 'public-aw/task-17', intentText: 'Increase gamma retry budget safely',
        baseOid: observedBaseOid, branch: 'refs/heads/aw-task', unitKeys: ['row:families:gamma'],
        dependencyChangeIds: [], attempt: 1,
      }), 'dedupe attempt');
      ids.push(value.changeId);
    }
    if (new Set(ids).size !== 1) throw new Error('AW_RETRY_DUPLICATED_CHANGE');
    manifest.evidence.dedupe = { attempts: 7, changeId: ids[0], observedBases,
      stableIntent: 'Increase gamma retry budget safely' };
  } else if (name === 'aw') {
    need('contest');
    const fixturePath = join(resolve(options.stateDir), 'aw-task.json');
    const runStatePath = join(resolve(options.stateDir), 'aw-run-state.json');
    const template = JSON.parse(await readFile(join(root, 'aw-task.json'), 'utf8')) as Record<string, unknown>;
    const client = new ConcordClient({ url: options.url, token: options.actors.aw ?? actor.aw });
    const reviewer = new ConcordClient({ url: options.url, token: options.actors.reviewer ?? actor.reviewer });
    const observedBases: string[] = [];
    const changeIds: string[] = [];
    const outputs: Array<{ phase: string; headOid: string | null }> = [];
    const worktree = join(manifest.workDir, 'aw-task-checkout');
    for (let retry = 0; retry < 7; retry++) {
      const observedBaseOid = retry === 0 ? manifest.seedOid : manifest.canonicalOid;
      observedBases.push(observedBaseOid);
      await writeFile(fixturePath, JSON.stringify({ ...template, project: manifest.repoId, worktree, observedBaseOid }, null, 2) + '\n');
      const result = await runAwMock(fixturePath, runStatePath, client, reviewer);
      if (result.phase !== (retry === 0 ? 'awaiting_review' : 'queued') || !result.headOid || result.blocked) {
        throw new Error(`AW_RETRY_${retry + 1}_FAILED ${JSON.stringify(result)}`);
      }
      changeIds.push(result.changeId);
      outputs.push({ phase: result.phase, headOid: result.headOid });
      if (retry === 0) {
        const ready = await pump({ ...options, pumpLocal: true }, manifest, view => view.repos?.changes?.some((value: any) =>
          value.changeId === result.changeId && value.status === 'ready' && value.revision === 1), 'inspect AW');
        const current = await changeById(options, manifest, result.changeId);
        manifest.changes.AW = { changeId: result.changeId, storageName: current.candidateStorageName,
          branch: current.branch, worktree, baseOid: current.baseOid, headOid: result.headOid,
          leaseFences: {}, leaseIds: {}, verdictId: null, revision: 1 };
        if (!ready.repos.changes.some((value: any) => value.changeId === result.changeId && value.status === 'ready')) throw new Error('AW_INSPECTION_NOT_READY');
        await approve(options, manifest, 'AW');
      }
    }
    if (new Set(changeIds).size !== 1 || new Set(outputs.map(value => value.headOid)).size !== 1 ||
      new Set(observedBases).size !== 2) throw new Error('AW_RETRY_DUPLICATED_CHANGE');
    const all = ok(await api(options, 'owner', 'GET', `/repos/${manifest.repoId}/changes`), 'AW changes');
    const awChanges = all.items.filter((value: any) => value.intentKey.startsWith('aw-mock:'));
    if (awChanges.length !== 1 || awChanges[0].changeId !== changeIds[0]) throw new Error('AW_SERVER_CHANGE_COUNT');
    const adapterState = JSON.parse(await readFile(runStatePath, 'utf8')) as { mappings: Record<string, {
      changeId: string; leaseFences?: Record<string, number> }> };
    const mapping = adapterState.mappings[`${manifest.repoId}/${template.taskId}/1`];
    if (mapping?.changeId !== changeIds[0] || !mapping.leaseFences?.['row:families:gamma']) throw new Error('AW_LEASE_EVIDENCE_MISSING');
    manifest.changes.AW.leaseFences = mapping.leaseFences;
    const landed = await pump({ ...options, pumpLocal: true }, manifest, view => view.queue?.entries?.some((entry: any) =>
      entry.changeId === changeIds[0] && entry.state === 'landed'), 'land AW');
    const entry = landed.queue.entries.find((value: any) => value.changeId === changeIds[0] && value.state === 'landed');
    const checkJob = [...(landed.runners.jobs as any[])].reverse().find(job => job.kind === 'validate-stack' &&
      job.caseId === 'aw-only' && job.candidates?.some((candidate: any) => candidate.changeId === changeIds[0]));
    if (!checkJob) throw new Error('AW_TRUSTED_CASE_MISSING');
    const check = ok(await api(options, 'reviewer', 'GET', `/repos/${manifest.repoId}/jobs/${checkJob.jobId}/result`), 'AW checker').result;
    if (check.outcome !== 'PASS') throw new Error('AW_CHECKER_FAILED');
    manifest.canonicalOid = landed.queue.finalCanonicalOid;
    manifest.evidence.aw = { attempts: 7, taskId: template.taskId, changeId: changeIds[0], changeIds,
      observedBases, baseOid: manifest.changes.AW.baseOid, headOid: outputs[0].headOid,
      leaseFences: mapping.leaseFences, phases: outputs.map(value => value.phase),
      verdictId: manifest.changes.AW.verdictId, checkerJobId: checkJob.jobId, checkerOutcome: check.outcome,
      queueEntryId: entry.entryId, queueState: entry.state, canonicalOid: manifest.canonicalOid };
  } else throw new Error('UNKNOWN_SCENE: ' + name);
  manifest.scenes.push(name);
  manifest.audit.push(...pendingAudit.splice(0));
  await save(options, manifest);
  return manifest;
}

export async function inspect(options: Options): Promise<unknown> {
  const manifest = await load(options);
  return { ...manifest, queue: await queue(options, manifest), snapshot: await snapshot(options, manifest) };
}
