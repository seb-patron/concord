import type { FeatureModule, Gate, Job, JobResult, ModuleContext, RepoStorage, ReviewManifest, RunnerPollBody, JobHeartbeatBody, JobCredentialsBody, JobResultBody } from '../contracts';
import { requireRole } from '../auth';
import { digest, HttpError, json, stableJson } from '../http';

const CLAIM_MS = 60_000;
// The bridge, like Artifacts, issues Git credentials for at least 60 seconds.
// Give its job claim room for that token plus request latency.
const claimMs = (c: ModuleContext) => c.env?.STORAGE_BACKEND === 'bridge' ? 90_000 : CLAIM_MS;
type Stored = { job: Job; result?: JobResult; dispatch?: Gate<unknown>; completedPrincipalId?: string };
type RunnerState = { principalId: string; role: 'checker' | 'promoter'; activeJobId: string | null;
  supportedProfileDigests: string[]; lastSeenAt: number };
const ids = (c: ModuleContext) => c.state.get<string[]>('ids') ?? [];
const load = (c: ModuleContext, id: string) => c.state.get<Stored>('job:' + id);
const save = (c: ModuleContext, row: Stored) => c.state.put('job:' + row.job.jobId, row);
const runner = (c: ModuleContext, id: string) => c.state.get<RunnerState>('runner:' + id);
const saveRunner = (c: ModuleContext, id: string, value: RunnerState) => c.state.put('runner:' + id, value);
const conflict = (code: string): never => { throw new HttpError(409, code, code); };
const validId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const validDigest = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
// Scheduling is synchronous (the feature hook and storage transaction are synchronous).
// Hash the same UTF-8 canonical JSON bytes as src/http.ts without an async subtle.digest call.
const sha256Words = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function inputHash(value: string): string {
  const bytes = [...new TextEncoder().encode(value)];
  const bitLength = BigInt(bytes.length) * 8n;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let shift = 56n; shift >= 0n; shift -= 8n) bytes.push(Number(bitLength >> shift & 255n));
  const state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const rotate = (word: number, count: number) => word >>> count | word << 32 - count;
  for (let offset = 0; offset < bytes.length; offset += 64) {
    const words = new Array<number>(64);
    for (let i = 0; i < 16; i++) words[i] = (bytes[offset + i * 4] << 24 | bytes[offset + i * 4 + 1] << 16 |
      bytes[offset + i * 4 + 2] << 8 | bytes[offset + i * 4 + 3]) >>> 0;
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15], b = words[i - 2];
      words[i] = (words[i - 16] + (rotate(a, 7) ^ rotate(a, 18) ^ a >>> 3) + words[i - 7] +
        (rotate(b, 17) ^ rotate(b, 19) ^ b >>> 10)) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const one = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + (e & f ^ ~e & g) + sha256Words[i] + words[i]) >>> 0;
      const two = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + (a & b ^ a & c ^ b & c)) >>> 0;
      h = g; g = f; f = e; e = (d + one) >>> 0; d = c; c = b; b = a; a = (one + two) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((word, i) => { state[i] = (state[i] + word) >>> 0; });
  }
  return 'sha256:' + state.map(word => word.toString(16).padStart(8, '0')).join('');
}
async function ancestor(storage: RepoStorage, name: string, oldOid: string, newOid: string): Promise<boolean> {
  const pending = [newOid];
  const seen = new Set<string>();
  while (pending.length) {
    const oid = pending.pop()!;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = await storage.readCommit(name, oid);
    if (!commit) continue;
    pending.push(...commit.parents);
  }
  return false;
}
function immutableJob(job: Job): string {
  const { state: _state, attempt: _attempt, fence: _fence, runnerId: _runnerId, expiresAt: _expiresAt, version: _version, ...input } = job;
  return stableJson(input);
}
export function jobInput<T extends { inputDigest?: unknown; state: unknown; attempt: unknown; fence: unknown;
  runnerId: unknown; expiresAt: unknown; version: unknown }>(job: T) {
  const { inputDigest: _inputDigest, state: _state, attempt: _attempt, fence: _fence, runnerId: _runnerId,
    expiresAt: _expiresAt, version: _version, ...input } = job;
  return input;
}
function validManifest(job: Job, manifest: ReviewManifest | null): manifest is ReviewManifest {
  return !!manifest && typeof manifest === 'object' && Array.isArray(manifest.changedUnits) &&
    manifest.changedUnits.every(item => item && typeof item.unitKey === 'string') &&
    ['complete', 'unknown'].includes(manifest.coverage) && Array.isArray(manifest.dependencyScope) &&
    manifest.policyVersion === job.unitPolicy.version && manifest.policyDigest === job.policyDigest &&
    manifest.checkerDigest === job.checkerDigest && manifest.oracleDigest === job.oracleDigest &&
    manifest.toolchainDigest === job.toolchainDigest;
}

function expire(c: ModuleContext): void {
  for (const id of ids(c)) {
    const row = load(c, id);
    if (!row || row.job.state !== 'claimed' || row.job.expiresAt === null || row.job.expiresAt > c.now()) continue;
    const old = row.job.runnerId ? runner(c, row.job.runnerId) : null;
    if (old?.activeJobId === id) saveRunner(c, row.job.runnerId!, { ...old, activeJobId: null });
    row.job = { ...row.job, state: row.job.attempt >= 3 ? 'blocked' : 'pending', runnerId: null, expiresAt: null, version: c.nextVersion() };
    save(c, row);
    c.appendEvent('runner.expired', [id], { attempt: row.job.attempt, state: row.job.state }, row.job.version);
  }
}

function current(c: ModuleContext, id: string, body: JobHeartbeatBody): Stored {
  if (!body || !Number.isSafeInteger(body.attempt) || !Number.isSafeInteger(body.fence) || !validDigest(body.inputDigest))
    throw new HttpError(400, 'INVALID_FENCE', 'Attempt, fence, and input digest required');
  const row = load(c, id);
  if (!row || row.job.state !== 'claimed' || row.job.expiresAt === null || row.job.expiresAt <= c.now() ||
    row.job.runnerId === null || row.job.attempt !== body.attempt || row.job.fence !== body.fence ||
    row.job.inputDigest !== body.inputDigest) throw new HttpError(409, 'STALE_JOB', 'Job claim expired or was replaced');
  const owner = runner(c, row.job.runnerId);
  if (!owner || owner.principalId !== c.principal.principalId || owner.activeJobId !== id) conflict('STALE_JOB');
  requireRole(c.principal, row.job.kind === 'promote' ? 'promoter' : 'checker');
  return row;
}

function validJob(c: ModuleContext, job: Job): boolean {
  const policy = c.trusted.policies[job.policyId];
  const profile = Object.values(c.trusted.profiles).find(value => value.digest === job.profileDigest);
  if (!validId(job.jobId) || job.repoId !== c.repoId || !validDigest(job.inputDigest) || !policy || !profile ||
    policy.digest !== job.policyDigest || policy.checkerDigest !== job.checkerDigest || policy.checkerId !== job.checkerId ||
    stableJson(policy) !== stableJson(job.unitPolicy) ||
    profile.toolchainDigest !== job.toolchainDigest || profile.oracleDigest !== job.oracleDigest ||
    profile.environmentDigest !== job.environmentDigest || profile.timeoutMs !== job.timeoutMs ||
    profile.maxOutputBytes !== job.maxOutputBytes || job.timeoutMs < 1 || job.timeoutMs > 35 * 60_000 ||
    job.maxOutputBytes > 16 * 1024 || job.attempt !== 0 || job.fence !== 0 || job.state !== 'pending') return false;
  if (Object.values(job.storageRemotes).some(remote => {
    try { const parsed = new URL(remote); return !['https:', 'file:'].includes(parsed.protocol) || !!parsed.username || !!parsed.password; }
    catch { return true; }
  })) return false;
  if (Object.keys(job.expectedRefs).some(name => !job.storageRemotes[name])) return false;
  if (job.checkerId === 'dispatch-lab' && !/^[a-z0-9-]{1,64}$/.test((job as Job & { caseId?: string }).caseId ?? '')) return false;
  if (job.kind === 'inspect-candidate') {
    const candidate = job.candidate;
    if (candidate.baseOid === null) {
      if (!('seedStorageName' in candidate) || 'storageName' in candidate || 'ref' in candidate ||
        typeof candidate.seedRef !== 'string' || !candidate.seedRef.startsWith('refs/') ||
        !job.storageRemotes[candidate.seedStorageName] ||
        job.expectedRefs[candidate.seedStorageName] !== candidate.headOid ||
        !c.principal.roles.includes('owner')) return false;
    } else if ('seedStorageName' in candidate || !job.storageRemotes[candidate.storageName]) return false;
  }
  if (job.kind === 'validate-stack') {
    if (!job.storageRemotes[job.scratchStorageName] || job.candidates.some(candidate => !job.storageRemotes['seedStorageName' in candidate ? candidate.seedStorageName : candidate.storageName])) return false;
    const candidateNames = new Set(job.candidates.map(candidate => 'seedStorageName' in candidate ? candidate.seedStorageName : candidate.storageName));
    const canonical = Object.entries(job.expectedRefs).filter(([name]) => name !== job.scratchStorageName && !candidateNames.has(name));
    if (canonical.length !== 1 || canonical[0][1] !== job.canonicalBaseOid) return false;
    if (job.bootstrap) return job.ownerAuthorized === true && job.canonicalBaseOid === null && job.candidates.length === 1 && job.candidates[0].baseOid === null;
    return !!job.canonicalBaseOid &&
      (job.baseCheck === true ? job.candidates.length === 0 : job.baseCheck === undefined && job.candidates.length > 0) &&
      job.candidates.every(candidate => !!candidate.baseOid);
  }
  if (job.kind === 'delta-check') return !!job.candidate.baseOid && !!job.storageRemotes[job.candidate.storageName] &&
    Object.entries(job.expectedRefs).filter(([name, oid]) => name !== job.candidate.storageName && oid === job.newBaseOid).length === 1;
  if (job.kind === 'promote') {
    if (!job.storageRemotes[job.scratchStorageName]) return false;
    const canonical = Object.entries(job.expectedRefs).filter(([name]) => name !== job.scratchStorageName);
    if (canonical.length !== 1 || canonical[0][1] !== job.expectedOldOid || job.expectedRefs[job.scratchStorageName] !== job.checkedNewOid) return false;
    return job.bootstrap ? job.ownerAuthorized === true && job.expectedOldOid === null : !!job.expectedOldOid;
  }
  return true;
}

function schedule(c: ModuleContext, job: Job): Gate<{ jobId: string }> {
  if (!job || typeof job.jobId !== 'string') return { status: 'blocked', version: c.version?.() ?? 0, code: 'MODULE_UNAVAILABLE', reason: 'No job supplied', evidenceIds: [] };
  return c.transaction(() => {
    const prior = load(c, job.jobId);
    if (prior) return prior.job.inputDigest === job.inputDigest && immutableJob(prior.job) === immutableJob(job) ?
      { status: 'eligible', version: prior.job.version, evidenceIds: [job.jobId], value: { jobId: job.jobId } } :
      { status: 'blocked', version: prior.job.version, code: 'JOB_CONFLICT', reason: 'Job identity changed', evidenceIds: [job.jobId] };
    if (!validJob(c, job) || inputHash(stableJson(jobInput(job))) !== job.inputDigest)
      return { status: 'blocked', version: c.version(), code: 'INVALID_JOB', reason: 'Job pins or input digest invalid', evidenceIds: [] };
    const version = c.nextVersion();
    save(c, { job: { ...job, version } });
    c.state.put('ids', [...ids(c), job.jobId]);
    c.appendEvent('runner.scheduled', [job.jobId], { kind: job.kind }, version);
    return { status: 'eligible', version, evidenceIds: [job.jobId], value: { jobId: job.jobId } };
  });
}

function poll(c: ModuleContext, body: RunnerPollBody): Response {
  if (!body || !validId(body.runnerId) || !['checker', 'promoter'].includes(body.role) ||
    !Array.isArray(body.supportedProfileDigests) || body.supportedProfileDigests.some(value => !validDigest(value)) ||
    body.maxJobs !== undefined && body.maxJobs !== 1) throw new HttpError(400, 'INVALID_POLL', 'Invalid runner registration');
  requireRole(c.principal, body.role);
  return c.transaction(() => {
    expire(c);
    const previous = runner(c, body.runnerId);
    if (previous && (previous.principalId !== c.principal.principalId || previous.role !== body.role)) conflict('RUNNER_ID_CONFLICT');
    if (previous?.activeJobId) conflict('RUNNER_BUSY');
    const row = ids(c).map(id => load(c, id)).find(item => item?.job.state === 'pending' &&
      body.supportedProfileDigests.includes(item.job.profileDigest) && (item.job.kind === 'promote') === (body.role === 'promoter'));
    saveRunner(c, body.runnerId, { principalId: c.principal.principalId, role: body.role, activeJobId: row?.job.jobId ?? null,
      supportedProfileDigests: body.supportedProfileDigests, lastSeenAt: c.now() });
    if (!previous) c.state.put('runner-ids', [...(c.state.get<string[]>('runner-ids') ?? []), body.runnerId]);
    if (!row) return new Response(null, { status: 204 });
    row.job = { ...row.job, state: 'claimed', attempt: row.job.attempt + 1, fence: row.job.fence + 1,
      runnerId: body.runnerId, expiresAt: c.now() + claimMs(c), version: c.nextVersion() };
    save(c, row);
    const event = c.appendEvent('runner.claimed', [row.job.jobId], { attempt: row.job.attempt, fence: row.job.fence }, row.job.version);
    return json({ job: row.job }, row.job.version, event.sequence);
  });
}

function heartbeat(c: ModuleContext, id: string, body: JobHeartbeatBody): Response {
  return c.transaction(() => {
    const row = current(c, id, body);
    row.job = { ...row.job, expiresAt: c.now() + claimMs(c), version: c.nextVersion() };
    save(c, row);
    const assigned = runner(c, row.job.runnerId!);
    if (assigned) saveRunner(c, row.job.runnerId!, { ...assigned, lastSeenAt: c.now() });
    return json({ expiresAt: row.job.expiresAt }, row.job.version);
  });
}

async function credentials(c: ModuleContext, id: string, body: JobCredentialsBody & JobHeartbeatBody): Promise<Response> {
  if (!body || !Number.isSafeInteger(body.attempt) || !Number.isSafeInteger(body.fence)) throw new HttpError(400, 'INVALID_FENCE', 'Attempt and fence required');
  const stored = load(c, id);
  if (!stored) throw new HttpError(409, 'STALE_JOB', 'Job claim missing');
  const fence = { ...body, inputDigest: stored.job.inputDigest };
  const job = current(c, id, fence).job;
  if (body.operation !== 'fetch' && body.operation !== 'scratch-push' && body.operation !== 'canonical-push') throw new HttpError(400, 'INVALID_OPERATION', 'Unknown operation');
  if (body.operation === 'scratch-push' && job.kind !== 'validate-stack' ||
    body.operation === 'canonical-push' && job.kind !== 'promote') throw new HttpError(403, 'FORBIDDEN', 'Operation unavailable');
  const names = body.operation === 'fetch' ? Object.keys(job.storageRemotes) :
    body.operation === 'scratch-push' ? [job.kind === 'validate-stack' ? job.scratchStorageName : ''] :
      [Object.keys(job.expectedRefs).find(name => name !== (job.kind === 'promote' ? job.scratchStorageName : '')) ?? ''];
  if (names.some(name => !name || !job.storageRemotes[name])) conflict('MISSING_REMOTE');
  const tokens: Array<{ storageName: string; remote: string; secret: string; expiresAt: number }> = [];
  try {
    for (const name of names) {
      const live = current(c, id, fence);
      const ttlSeconds = Math.min(c.env?.STORAGE_BACKEND === 'bridge' ? 60 : 59,
        Math.floor((live.job.expiresAt! - c.now() - 1000) / 1000));
      if (ttlSeconds < 1) conflict('STALE_JOB');
      const issued = await c.storage.mintToken(name, body.operation === 'fetch' ? 'read' : 'write', ttlSeconds);
      if (issued.expiresAt > live.job.expiresAt!) {
        await c.storage.revokeToken(name, issued.secret);
        conflict('TOKEN_LIFETIME');
      }
      tokens.push({ storageName: name, remote: job.storageRemotes[name], ...issued });
    }
    current(c, id, fence);
  } catch (error) {
    await Promise.all(tokens.map(token => c.storage.revokeToken(token.storageName, token.secret)));
    throw error;
  }
  return json({ credentials: tokens }, job.version);
}

async function result(c: ModuleContext, id: string, body: JobResultBody): Promise<Response> {
  if (!body || !Number.isSafeInteger(body.attempt) || !Number.isSafeInteger(body.fence) || !validDigest(body.inputDigest) ||
    !validDigest(body.resultDigest) || !body.result) throw new HttpError(400, 'INVALID_RESULT', 'Result envelope missing');
  const prior = load(c, id);
  if (prior?.result && prior.job.state === 'completed') {
    if (prior.result.resultDigest !== body.resultDigest || prior.result.attempt !== body.attempt ||
      prior.result.fence !== body.fence || prior.result.inputDigest !== body.inputDigest ||
      prior.result.jobId !== id || prior.job.kind !== body.result?.kind || prior.completedPrincipalId !== c.principal.principalId ||
      stableJson(prior.result) !== stableJson(body.result)) conflict('RESULT_CONFLICT');
    return json({ dispatch: prior.dispatch, resultDigest: body.resultDigest }, prior.job.version);
  }
  const job = current(c, id, body).job;
  const value = body.result;
  if (!value || value.jobId !== id || value.kind !== job.kind || value.attempt !== job.attempt ||
    value.fence !== job.fence || value.inputDigest !== job.inputDigest || value.resultDigest !== body.resultDigest ||
    value.checkerDigest !== job.checkerDigest || value.toolchainDigest !== job.toolchainDigest ||
    value.oracleDigest !== job.oracleDigest || value.environmentDigest !== job.environmentDigest ||
    typeof value.log !== 'string' || new TextEncoder().encode(value.log).length > Math.min(16 * 1024, job.maxOutputBytes) ||
    !Number.isSafeInteger(value.durationMs) || value.durationMs < 0) throw new HttpError(400, 'INVALID_RESULT', 'Result identity or evidence invalid');
  const checkOutcomes = ['PASS', 'FAIL', 'MATCH', 'MISMATCH', 'COMPILE_ERROR', 'UNVERIFIED_TARGET', 'ENV_ERROR', 'MERGE_CONFLICT', 'TIMEOUT'];
  if (value.kind === 'promote' ? !['APPLIED', 'OLD_REF', 'THIRD_REF', 'ENV_ERROR'].includes(value.outcome) :
    !checkOutcomes.includes(value.outcome)) throw new HttpError(400, 'INVALID_RESULT', 'Unknown result outcome');
  if (value.kind === 'validate-stack' && (!Array.isArray(value.gateResults) || value.bootstrap !== (job.kind === 'validate-stack' && job.bootstrap) ||
    value.canonicalBaseOid !== (job.kind === 'validate-stack' ? job.canonicalBaseOid : undefined) ||
    value.gateResults.some(gate => !gate || typeof gate.gateId !== 'string' || !checkOutcomes.includes(gate.outcome)) ||
    value.score !== null && (!value.score || !Number.isSafeInteger(value.score.matched) || !Number.isSafeInteger(value.score.total) ||
      value.score.matched < 0 || value.score.total < 1 || value.score.matched > value.score.total)))
    throw new HttpError(400, 'INVALID_RESULT', 'Invalid stack evidence');
  if (value.kind === 'inspect-candidate' && (!Array.isArray(value.unitKeys) ||
    value.unitKeys.some(key => typeof key !== 'string') ||
    value.observedHeadOid !== null && typeof value.observedHeadOid !== 'string'))
    throw new HttpError(400, 'INVALID_RESULT', 'Invalid inspection evidence');
  if (value.kind === 'delta-check' && (value.dependencyScope !== null && !Array.isArray(value.dependencyScope) ||
    value.reviewManifestDigest !== null && !validDigest(value.reviewManifestDigest) ||
    value.dependencyScopeDigest !== null && !validDigest(value.dependencyScopeDigest)))
    throw new HttpError(400, 'INVALID_RESULT', 'Invalid delta evidence');
  const { resultDigest: _ignored, ...preimage } = value;
  if (await digest(preimage) !== body.resultDigest) throw new HttpError(400, 'INVALID_RESULT_DIGEST', 'Result digest mismatch');
  if (value.kind === 'inspect-candidate' && value.outcome === 'PASS') {
    if (!validManifest(job, value.reviewManifest) || value.reviewManifestDigest !== await digest(value.reviewManifest) ||
      stableJson([...new Set(value.reviewManifest.changedUnits.map(item => item.unitKey))].sort()) !== stableJson([...value.unitKeys].sort())) conflict('RESULT_EVIDENCE');
  }
  if (value.kind === 'delta-check' && value.outcome === 'PASS') {
    if (!validManifest(job, value.reviewManifest) || value.reviewManifestDigest !== await digest(value.reviewManifest) ||
      value.dependencyScopeDigest !== await digest(value.reviewManifest.dependencyScope) ||
      stableJson(value.dependencyScope) !== stableJson(value.reviewManifest.dependencyScope)) conflict('RESULT_EVIDENCE');
  }
  if (value.kind === 'validate-stack' && value.outcome === 'PASS') {
    const required = job.unitPolicy.acceptance.gates;
    if (value.gateResults.length !== required.length || required.some((gate, index) =>
      value.gateResults[index].gateId !== gate.id || value.gateResults[index].outcome !== gate.requiredOutcome) ||
      job.unitPolicy.acceptance.kind === 'score' && job.kind === 'validate-stack' && job.contest === true &&
      value.score?.total !== job.unitPolicy.acceptance.fixedDenominator ||
      job.unitPolicy.acceptance.kind === 'score' && job.kind === 'validate-stack' && job.contest !== true && value.score !== null) conflict('RESULT_EVIDENCE');
  }
  if (value.kind === 'inspect-candidate' && value.outcome === 'PASS') {
    if (job.kind !== 'inspect-candidate') throw new HttpError(409, 'RESULT_IDENTITY', 'Kind mismatch');
    const candidate = job.candidate;
    const name = 'seedStorageName' in candidate ? candidate.seedStorageName : candidate.storageName;
    if (value.observedHeadOid !== candidate.headOid ||
      (await c.storage.readCommit(name, candidate.headOid))?.treeOid !== value.sourceTreeOid) conflict('RESULT_IDENTITY');
    if (candidate.baseOid && !await ancestor(c.storage, name, candidate.baseOid, candidate.headOid)) conflict('RESULT_IDENTITY');
  }
  if (value.kind === 'validate-stack' && job.kind === 'validate-stack' && !job.bootstrap && job.baseCheck &&
    (value.composedOid !== null || !['ENV_ERROR', 'MERGE_CONFLICT', 'TIMEOUT'].includes(value.outcome))) {
    const canonicalName = Object.keys(job.expectedRefs).find(name => name !== job.scratchStorageName);
    if (value.composedOid !== job.canonicalBaseOid || value.composedTreeOid !== value.sourceTreeOid ||
      !canonicalName || (await c.storage.readCommit(canonicalName, job.canonicalBaseOid))?.treeOid !== value.composedTreeOid)
      conflict('RESULT_IDENTITY');
  }
  if (value.kind === 'validate-stack' && value.outcome === 'PASS') {
    if (job.kind !== 'validate-stack' || !value.composedOid) throw new HttpError(409, 'RESULT_IDENTITY', 'Stack missing');
    const stack = job;
    const composedOid = value.composedOid;
    if (value.bootstrap !== stack.bootstrap || value.canonicalBaseOid !== stack.canonicalBaseOid ||
      value.composedTreeOid !== value.sourceTreeOid ||
      (await c.storage.readCommit(stack.scratchStorageName, composedOid))?.treeOid !== value.composedTreeOid ||
      await c.storage.resolveRef(stack.scratchStorageName, stack.scratchRef) !== composedOid) conflict('RESULT_IDENTITY');
    if (stack.bootstrap) {
      if (composedOid !== stack.candidates[0].headOid) conflict('RESULT_IDENTITY');
    } else if (!stack.baseCheck) {
      if (!await ancestor(c.storage, stack.scratchStorageName, stack.canonicalBaseOid, composedOid) ||
        (await Promise.all(stack.candidates.map(candidate => ancestor(c.storage, stack.scratchStorageName, candidate.headOid, composedOid)))).some(found => !found)) conflict('RESULT_IDENTITY');
    }
  }
  if (value.kind === 'promote' && value.outcome === 'APPLIED') {
    if (job.kind !== 'promote') throw new HttpError(409, 'RESULT_IDENTITY', 'Promotion missing');
    const promotion = job;
    const canonicalName = Object.keys(promotion.expectedRefs).find(name => name !== promotion.scratchStorageName);
    if (!canonicalName || value.observedCanonicalOid !== promotion.checkedNewOid ||
      await c.storage.resolveRef(canonicalName, 'refs/heads/main') !== promotion.checkedNewOid) conflict('RESULT_IDENTITY');
    if (promotion.expectedOldOid && !await ancestor(c.storage, promotion.scratchStorageName, promotion.expectedOldOid, promotion.checkedNewOid)) conflict('RESULT_IDENTITY');
  }
  if (value.kind === 'promote') {
    const promotion = job.kind === 'promote' ? job : null;
    const canonicalName = promotion && Object.keys(promotion.expectedRefs).find(name => name !== promotion.scratchStorageName);
    if (!canonicalName || await c.storage.resolveRef(canonicalName, 'refs/heads/main') !== value.observedCanonicalOid) conflict('RESULT_IDENTITY');
  }
  return c.transaction(() => {
    current(c, id, body);
    const dispatched = job.kind === 'inspect-candidate' ? c.call('repos.inspectRevision', value as Extract<JobResult, { kind: 'inspect-candidate' }>) :
      job.kind === 'delta-check' ? c.call('verdicts.evaluateCarry', value as Extract<JobResult, { kind: 'delta-check' }>) :
        c.call('queue.onResult', value as Extract<JobResult, { kind: 'validate-stack' | 'promote' }>);
    const version = c.nextVersion();
    save(c, { job: { ...job, state: 'completed', runnerId: null, expiresAt: null, version }, result: value, dispatch: dispatched,
      completedPrincipalId: c.principal.principalId });
    const owner = runner(c, job.runnerId!);
    if (owner) saveRunner(c, job.runnerId!, { ...owner, activeJobId: null, lastSeenAt: c.now() });
    const event = c.appendEvent('runner.result', [id], { resultDigest: body.resultDigest, outcome: value.outcome, dispatch: dispatched.status }, version);
    return json({ dispatch: dispatched, resultDigest: body.resultDigest }, version, event.sequence);
  });
}

export const runners: FeatureModule = {
  name: 'runners', migrations: [],
  routes: [
    { method: 'GET', pattern: /^\/v1\/repos\/[^/]+\/jobs\/([^/]+)\/result$/, handle: (c, _r, m) => {
      requireRole(c.principal, 'owner', 'reviewer');
      const stored = load(c, m[1]);
      if (!stored?.result || stored.job.state !== 'completed') throw new HttpError(404, 'RESULT_NOT_FOUND', 'Completed result unavailable');
      return json({ jobId: stored.job.jobId, result: stored.result }, stored.job.version);
    } },
    { method: 'POST', pattern: /^\/v1\/repos\/[^/]+\/runner\/poll$/, handle: (c, _r, _m, b) => poll(c, b as unknown as RunnerPollBody) },
    { method: 'POST', pattern: /^\/v1\/repos\/[^/]+\/jobs\/([^/]+)\/heartbeat$/, handle: (c, _r, m, b) => heartbeat(c, m[1], b as unknown as JobHeartbeatBody) },
    { method: 'POST', pattern: /^\/v1\/repos\/[^/]+\/jobs\/([^/]+)\/result$/, handle: (c, _r, m, b) => result(c, m[1], b as unknown as JobResultBody) },
    { method: 'POST', pattern: /^\/v1\/repos\/[^/]+\/jobs\/([^/]+)\/credentials$/, handle: (c, _r, m, b) => credentials(c, m[1], b as unknown as JobCredentialsBody & JobHeartbeatBody) },
  ],
  snapshot: c => {
    const runnerIds = c.state.get<string[]>('runner-ids') ?? [];
    return { status: runnerIds.length ? 'active' : 'unavailable', jobs: ids(c).map(id => load(c, id)?.job).filter(Boolean),
      runners: runnerIds.map(id => ({ runnerId: id, ...runner(c, id), state: (() => {
        const record = runner(c, id);
        return !record || c.now() - record.lastSeenAt > CLAIM_MS ? 'offline' : record.activeJobId ? 'claimed' : 'idle';
      })() })) };
  },
  nextDeadline: c => { const values = ids(c).map(id => load(c, id)?.job.expiresAt).filter((n): n is number => n !== null && n !== undefined); return values.length ? Math.min(...values) : null; },
  onAlarm: c => c.transaction(() => expire(c)),
  hooks: { 'runners.schedule': schedule },
};
