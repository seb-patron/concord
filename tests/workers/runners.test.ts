import { describe, expect, it, vi } from 'vitest';
import type { Digest, Job, JobResult, ModuleContext, Principal } from '../../src/contracts';
import { runners } from '../../src/features/runners';
import { artifactsStorage } from '../../src/storage/artifacts';
import { digest, failure, HttpError } from '../../src/http';
import { localFixtureConfig } from '../../src/state';
import { pendingResultFailure } from '../../src/repos/model';

const oid = 'a'.repeat(40);
const tree = 'b'.repeat(40);
const pin = ('sha256:' + '0'.repeat(64)) as Digest;

async function seal<T extends Job>(job: T): Promise<T> {
  const { inputDigest: _inputDigest, state: _state, attempt: _attempt, fence: _fence, runnerId: _runnerId,
    expiresAt: _expiresAt, version: _version, ...input } = job;
  return { ...job, inputDigest: await digest(input) };
}

async function fixture() {
  const data = new Map<string, unknown>();
  let now = 1000;
  let version = 0;
  const calls: string[] = [];
  const principal: Principal = { tenantId: 'local', principalId: 'checker', roles: ['checker'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
  const context = {
    repoId: 'demo', tenantId: 'local', principal, trusted: localFixtureConfig('local'),
    now: () => now, version: () => version, nextVersion: () => ++version,
    transaction: (run: () => unknown) => run(), appendEvent: () => ({ sequence: version }),
    state: { get: (key: string) => data.get(key) ?? null, put: (key: string, value: unknown) => { data.set(key, structuredClone(value)); }, delete: (key: string) => { data.delete(key); } },
    storage: {
      readCommit: async () => ({ oid, treeOid: tree, parents: [] }),
      resolveRef: async () => oid,
      mintToken: async (_name: string, _scope: string, ttlSeconds: number) => ({ secret: 'secret', expiresAt: now + ttlSeconds * 1000 }),
      revokeToken: async () => true,
    },
    call: (name: string) => { calls.push(name); return { status: 'blocked', version, code: 'MODULE_UNAVAILABLE', reason: 'Other slice pending', evidenceIds: [] }; },
  } as unknown as ModuleContext;
  const job: Job = {
    kind: 'inspect-candidate', jobId: 'job1', repoId: 'demo', inputDigest: pin, generation: 1,
    profileDigest: pin, policyId: 'local-demo', policyDigest: pin, unitPolicy: context.trusted.policies['local-demo'],
    expectedRefs: { candidate: oid }, storageRemotes: { candidate: 'file:///candidate' }, checkerId: 'local-demo',
    checkerDigest: pin, oracleDigest: pin, toolchainDigest: pin, environmentDigest: pin, timeoutMs: 120_000,
    maxOutputBytes: 16 * 1024, state: 'pending', attempt: 0, runnerId: null, fence: 0, expiresAt: null, version: 0,
    changeId: 'change1', revision: 1,
    candidate: { changeId: 'change1', revision: 1, baseOid: oid, headOid: oid, storageName: 'candidate', ref: 'refs/heads/main' },
  };
  const route = async (suffix: string, body: unknown) => {
    const path = '/v1/repos/demo/' + suffix;
    const entry = runners.routes.find(route => route.method === 'POST' && route.pattern.test(path))!;
    try { return await entry.handle(context, new Request('https://test' + path, { method: 'POST' }), path.match(entry.pattern)!, body); }
    catch (error) { return failure(error instanceof HttpError ? error : new HttpError(503, 'ERROR', String(error))); }
  };
  return { context, job: await seal(job), calls, route, advance: (ms: number) => { now += ms; }, now: () => now, principal };
}

async function acceptedResult(job: Job): Promise<{ result: JobResult; resultDigest: string; attempt: number; fence: number; inputDigest: string }> {
  if (job.kind !== 'inspect-candidate') throw new Error('bad fixture');
  const reviewManifest = { changedUnits: [], policyVersion: 1, policyDigest: pin, checkerDigest: pin,
    oracleDigest: pin, toolchainDigest: pin, coverage: 'complete' as const, dependencyScope: [] };
  const reviewManifestDigest = await digest(reviewManifest);
  const unsigned = {
    jobId: job.jobId, attempt: job.attempt, fence: job.fence, inputDigest: job.inputDigest, kind: 'inspect-candidate' as const,
    checkerDigest: job.checkerDigest, oracleDigest: job.oracleDigest, toolchainDigest: job.toolchainDigest,
    environmentDigest: job.environmentDigest, sourceTreeOid: tree, durationMs: 4, log: '',
    outcome: 'PASS' as const, observedHeadOid: oid, unitKeys: [], reviewManifestDigest, reviewManifest,
  };
  const resultDigest = await digest(unsigned);
  return { result: { ...unsigned, resultDigest }, resultDigest, attempt: job.attempt, fence: job.fence, inputDigest: job.inputDigest };
}

describe('durable runner protocol', () => {
  it('checks the canonical immutable input digest before scheduling', async () => {
    const f = await fixture();
    expect(runners.hooks['runners.schedule']!(f.context, { ...f.job, inputDigest: pin })).toMatchObject({ status: 'blocked', code: 'INVALID_JOB' });
    expect(runners.hooks['runners.schedule']!(f.context, { ...f.job, revision: 2 })).toMatchObject({ status: 'blocked', code: 'INVALID_JOB' });
    expect(runners.hooks['runners.schedule']!(f.context, f.job)).toMatchObject({ status: 'eligible' });
  });

  it('accepts only an explicit empty-candidate canonical base check', async () => {
    const f = await fixture();
    const stack = { ...f.job, kind: 'validate-stack' as const, canonicalBaseOid: oid,
      candidates: [], bootstrap: false as const, stackId: 'stack1', scratchStorageName: 'scratch',
      scratchRef: 'refs/heads/check', expectedRefs: { canonical: oid, scratch: null },
      storageRemotes: { canonical: 'file:///canonical', scratch: 'file:///scratch' } } as Job;
    expect(runners.hooks['runners.schedule']!(f.context, await seal(stack))).toMatchObject({ status: 'blocked', code: 'INVALID_JOB' });
    const baseCheck = await seal({ ...stack, baseCheck: true } as Job);
    expect(runners.hooks['runners.schedule']!(f.context, baseCheck)).toMatchObject({ status: 'eligible' });
    const withCandidate = await seal({ ...stack, jobId: 'job2', baseCheck: true,
      candidates: [{ changeId: 'change1', revision: 1, baseOid: oid, headOid: oid,
        storageName: 'candidate', ref: 'refs/heads/main' }], expectedRefs: { canonical: oid, scratch: null, candidate: oid },
      storageRemotes: { canonical: 'file:///canonical', scratch: 'file:///scratch', candidate: 'file:///candidate' } } as Job);
    expect(runners.hooks['runners.schedule']!(f.context, withCandidate)).toMatchObject({ status: 'blocked', code: 'INVALID_JOB' });
  });

  it('schedules only an owner-pinned null-base seed and completes its inspection', async () => {
    const f = await fixture();
    const seed = await seal({ ...f.job, candidate: { changeId: 'change1', revision: 1, baseOid: null,
      headOid: oid, seedStorageName: 'candidate', seedRef: 'refs/heads/main' } } as Job);
    expect(runners.hooks['runners.schedule']!(f.context, seed)).toMatchObject({ status: 'blocked', code: 'INVALID_JOB' });
    f.principal.roles = ['owner', 'checker'];
    expect(runners.hooks['runners.schedule']!(f.context, await seal({ ...seed, expectedRefs: { candidate: null } }))).toMatchObject({ status: 'blocked', code: 'INVALID_JOB' });
    expect(runners.hooks['runners.schedule']!(f.context, seed)).toMatchObject({ status: 'eligible' });
    const claimed = await f.route('runner/poll', { runnerId: 'one', role: 'checker', supportedProfileDigests: [pin] });
    expect(claimed.status).toBe(200);
    const job = (await claimed.json() as { data: { job: Job } }).data.job;
    expect((await f.route('jobs/job1/result', await acceptedResult(job))).status).toBe(200);
    expect(f.calls).toEqual(['repos.inspectRevision']);
  });

  it('verifies promotion ancestry beyond 2048 commits before accepting APPLIED', async () => {
    const f = await fixture();
    f.principal.roles = ['promoter'];
    const deepOid = (2050).toString(16).padStart(40, '0');
    f.context.storage.readCommit = async (_name, value) => {
      const index = parseInt(value, 16);
      return { oid: value, treeOid: tree, parents: index ? [(index - 1).toString(16).padStart(40, '0')] : [] };
    };
    f.context.storage.resolveRef = async () => deepOid;
    const job = await seal({ ...f.job, kind: 'promote', promotionId: 'promotion1', bootstrap: false,
      expectedOldOid: '0'.repeat(40), checkedNewOid: deepOid, scratchStorageName: 'scratch', scratchRef: 'refs/heads/check',
      expectedRefs: { canonical: '0'.repeat(40), scratch: deepOid }, storageRemotes: { canonical: 'file:///canonical', scratch: 'file:///scratch' } } as Job);
    expect(runners.hooks['runners.schedule']!(f.context, job)).toMatchObject({ status: 'eligible' });
    const claimed = await f.route('runner/poll', { runnerId: 'one', role: 'promoter', supportedProfileDigests: [pin] });
    expect(claimed.status).toBe(200);
    const current = (await claimed.json() as { data: { job: Job } }).data.job;
    const unsigned = { jobId: current.jobId, attempt: current.attempt, fence: current.fence, inputDigest: current.inputDigest,
      kind: 'promote' as const, outcome: 'APPLIED' as const, observedCanonicalOid: deepOid, sourceTreeOid: tree,
      checkerDigest: current.checkerDigest, toolchainDigest: current.toolchainDigest, oracleDigest: current.oracleDigest,
      environmentDigest: current.environmentDigest, durationMs: 1, log: '' };
    const resultDigest = await digest(unsigned);
    expect((await f.route('jobs/job1/result', { attempt: current.attempt, fence: current.fence,
      inputDigest: current.inputDigest, resultDigest, result: { ...unsigned, resultDigest } })).status).toBe(200);
    expect(f.calls).toEqual(['queue.onResult']);
  });

  it('schedules once, filters roles/profiles, fences expiration, and stops after three attempts', async () => {
    const f = await fixture();
    expect(f.context.call).toBeDefined();
    expect(runners.hooks['runners.schedule']!(f.context, f.job)).toMatchObject({ status: 'eligible', value: { jobId: 'job1' } });
    expect(runners.hooks['runners.schedule']!(f.context, f.job)).toMatchObject({ status: 'eligible' });
    expect(runners.hooks['runners.schedule']!(f.context, { ...f.job, inputDigest: ('sha256:' + '1'.repeat(64)) as typeof pin })).toMatchObject({ status: 'blocked', code: 'JOB_CONFLICT' });
    const poll = (role: 'checker' | 'promoter', profiles = [pin]) => f.route('runner/poll', { runnerId: 'one', role, supportedProfileDigests: profiles });
    expect((await poll('checker', [])).status).toBe(204);
    expect((await poll('checker')).status).toBe(200);
    expect((await poll('checker')).status).toBe(409);
    let current = (runners.snapshot(f.context) as { jobs: Job[] }).jobs[0];
    expect(current).toMatchObject({ attempt: 1, fence: 1, expiresAt: 61_000 });
    f.advance(60_000);
    const stale = await f.route('jobs/job1/heartbeat', { attempt: 1, fence: 1, inputDigest: f.job.inputDigest });
    expect(stale.status).toBe(409);
    expect((await f.route('jobs/job1/result', await acceptedResult(current))).status).toBe(409);
    for (let attempt = 2; attempt <= 3; attempt++) {
      const next = await poll('checker');
      expect(next.status).toBe(200);
      current = (runners.snapshot(f.context) as { jobs: Job[] }).jobs[0];
      expect(current.attempt).toBe(attempt);
      expect(current.fence).toBe(attempt);
      f.advance(60_000);
    }
    expect((await poll('checker')).status).toBe(204);
    expect((runners.snapshot(f.context) as { jobs: Job[] }).jobs[0].state).toBe('blocked');
    expect(f.calls).toEqual([]);
  });

  it('accepts one matching result and its retransmission, rejects conflicting and stale evidence', async () => {
    const f = await fixture();
    runners.hooks['runners.schedule']!(f.context, f.job);
    const wrongRole = await f.route('runner/poll', { runnerId: 'promoter', role: 'promoter', supportedProfileDigests: [pin] });
    expect(wrongRole.status).toBe(403);
    const claimed = await f.route('runner/poll', { runnerId: 'one', role: 'checker', supportedProfileDigests: [pin] });
    expect(claimed.status).toBe(200);
    const job = (await claimed.json() as { data: { job: Job } }).data.job;
    const body = await acceptedResult(job);
    expect((await f.route('jobs/job1/result', body)).status).toBe(200);
    expect((await f.route('jobs/job1/result', body)).status).toBe(200);
    expect((await f.route('jobs/job1/result', { ...body, resultDigest: pin })).status).toBe(409);
    expect(f.calls).toEqual(['repos.inspectRevision']);
    expect((runners.snapshot(f.context) as { jobs: Job[] }).jobs[0].state).toBe('completed');
  });

  it('grants operation-scoped credentials only on a live claim', async () => {
    const f = await fixture();
    runners.hooks['runners.schedule']!(f.context, f.job);
    await f.route('runner/poll', { runnerId: 'one', role: 'checker', supportedProfileDigests: [pin] });
    const granted = await f.route('jobs/job1/credentials', { attempt: 1, fence: 1, operation: 'fetch' });
    expect(granted.status).toBe(200);
    expect((await granted.json() as { data: { credentials: Array<{ expiresAt: number }> } }).data.credentials[0].expiresAt).toBeLessThan(61_000);
    expect((await f.route('jobs/job1/credentials', { attempt: 1, fence: 1, operation: 'canonical-push' })).status).toBe(403);
    f.advance(60_000);
    expect((await f.route('jobs/job1/credentials', { attempt: 1, fence: 1, operation: 'fetch' })).status).toBe(409);
  });

  it('keeps a bridge job live beyond its minimum 60-second Git credential', async () => {
    const f = await fixture();
    Object.defineProperty(f.context, 'env', { value: { STORAGE_BACKEND: 'bridge' } as Env });
    f.context.storage.mintToken = async (_name, _scope, ttlSeconds) => {
      expect(ttlSeconds).toBe(60);
      return { secret: 'bridge-secret', expiresAt: 61_000 };
    };
    expect(runners.hooks['runners.schedule']!(f.context, f.job).status).toBe('eligible');
    const poll = await f.route('runner/poll', { runnerId: 'bridge', role: 'checker', supportedProfileDigests: [pin] });
    expect(poll.status).toBe(200);
    const job = (await poll.json() as { data: { job: Job } }).data.job;
    expect(job.expiresAt).toBe(91_000);
    const credential = await f.route('jobs/job1/credentials', { attempt: 1, fence: 1, operation: 'fetch' });
    expect(credential.status).toBe(200);
  });

  it.each(['fetch', 'scratch-push', 'canonical-push'] as const)(
    'mints a 60-second Artifacts credential for %s within a 90-second claim', async operation => {
      const f = await fixture();
      Object.defineProperty(f.context, 'env', { value: { STORAGE_BACKEND: 'artifacts' } as Env });
      const minted: Array<{ name: string; scope: string; ttl: number }> = [];
      const revoked: string[] = [];
      Object.defineProperty(f.context, 'storage', { value: artifactsStorage({
        create: vi.fn(),
        get: vi.fn(async (name: string) => ({
          [Symbol.dispose]: () => undefined,
          createToken: async (scope: string, ttl: number) => {
            if (ttl < 60) throw new Error('INVALID_TTL: must be at least 60 seconds');
            minted.push({ name, scope, ttl });
            return { plaintext: `${name}-token`, expiresAt: new Date(f.now() + ttl * 1000).toISOString() };
          },
          revokeToken: async (secret: string) => { revoked.push(secret); return true; },
        })),
      } as unknown as Artifacts) });
      let scheduled: Job = f.job;
      if (operation === 'scratch-push') {
        scheduled = await seal({ ...f.job, kind: 'validate-stack', stackId: 'stack1', canonicalBaseOid: oid,
          candidates: [], baseCheck: true, bootstrap: false, scratchStorageName: 'scratch', scratchRef: 'refs/heads/check',
          expectedRefs: { canonical: oid, scratch: null },
          storageRemotes: { canonical: 'https://example.test/canonical.git', scratch: 'https://example.test/scratch.git' } } as Job);
      } else if (operation === 'canonical-push') {
        f.principal.roles = ['promoter'];
        scheduled = await seal({ ...f.job, kind: 'promote', promotionId: 'promotion1', bootstrap: false,
          expectedOldOid: oid, checkedNewOid: oid, scratchStorageName: 'scratch', scratchRef: 'refs/heads/check',
          expectedRefs: { canonical: oid, scratch: oid },
          storageRemotes: { canonical: 'https://example.test/canonical.git', scratch: 'https://example.test/scratch.git' } } as Job);
      }
      expect(runners.hooks['runners.schedule']!(f.context, scheduled).status).toBe('eligible');
      const polled = await f.route('runner/poll', { runnerId: 'one', role: operation === 'canonical-push' ? 'promoter' : 'checker', supportedProfileDigests: [pin] });
      expect(polled.status).toBe(200);
      const job = (await polled.json() as { data: { job: Job } }).data.job;
      expect(job.expiresAt).toBe(91_000);
      const body = { attempt: job.attempt, fence: job.fence, operation };
      const granted = await f.route('jobs/job1/credentials', body);
      expect(granted.status).toBe(200);
      const credentials = (await granted.json() as { data: { credentials: Array<{ expiresAt: number }> } }).data.credentials;
      expect(credentials).toHaveLength(operation === 'fetch' ? Object.keys(job.storageRemotes).length : 1);
      expect(credentials.every(token => token.expiresAt < job.expiresAt!)).toBe(true);
      expect(minted).toEqual((operation === 'fetch' ? Object.keys(job.storageRemotes) :
        [operation === 'scratch-push' ? 'scratch' : 'canonical']).map(name => ({ name, scope: operation === 'fetch' ? 'read' : 'write', ttl: 60 })));
      f.advance(30_000);
      const stale = await f.route('jobs/job1/credentials', body);
      expect(stale.status).toBe(409);
      expect((await stale.json() as { error: { code: string } }).error.code).toBe('STALE_JOB');
      expect(minted).toHaveLength(credentials.length);
      expect(revoked).toEqual([]);
      expect((await f.route('jobs/job1/heartbeat', { attempt: job.attempt, fence: job.fence, inputDigest: job.inputDigest })).status).toBe(200);
      expect((await f.route('jobs/job1/credentials', body)).status).toBe(200);
    },
  );

  it('revokes a provider token whose lifetime reaches the end of the claim', async () => {
    const f = await fixture();
    Object.defineProperty(f.context, 'env', { value: { STORAGE_BACKEND: 'artifacts' } as Env });
    const revoked: string[] = [];
    f.context.storage.mintToken = async () => ({ secret: 'held-token', expiresAt: 91_000 });
    f.context.storage.revokeToken = async (_name, token) => { revoked.push(token); return true; };
    expect(runners.hooks['runners.schedule']!(f.context, f.job).status).toBe('eligible');
    await f.route('runner/poll', { runnerId: 'one', role: 'checker', supportedProfileDigests: [pin] });
    const response = await f.route('jobs/job1/credentials', { attempt: 1, fence: 1, operation: 'fetch' });
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('TOKEN_LIFETIME');
    expect(revoked).toEqual(['held-token']);
  });

  it('rejects a malformed Artifacts expiry, keeps failed cleanup for retry, and never returns the secret', async () => {
    const f = await fixture();
    Object.defineProperty(f.context, 'env', { value: { STORAGE_BACKEND: 'artifacts' } as Env });
    const createToken = vi.fn()
      .mockResolvedValueOnce({ plaintext: 'held-token', expiresAt: 'invalid' })
      .mockImplementation(async () => ({ plaintext: 'valid-token', expiresAt: new Date(f.now() + 60_000).toISOString() }));
    const revokeToken = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
    Object.defineProperty(f.context, 'storage', { value: artifactsStorage({
      create: vi.fn(),
      get: vi.fn(async () => ({ [Symbol.dispose]: () => undefined, createToken, revokeToken })),
    } as unknown as Artifacts) });
    expect(runners.hooks['runners.schedule']!(f.context, f.job).status).toBe('eligible');
    await f.route('runner/poll', { runnerId: 'one', role: 'checker', supportedProfileDigests: [pin] });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await f.route('jobs/job1/credentials', { attempt: 1, fence: 1, operation: 'fetch' });
      expect(response.status).toBe(502);
      expect(await response.clone().text()).not.toContain('held-token');
      expect(await response.json()).toMatchObject({ error: { code: 'TOKEN_RESULT_INVALID' } });
      expect(errorLog).toHaveBeenCalledExactlyOnceWith('TOKEN_RESULT_INVALID', 'job1');
      expect(f.context.state.get('mint-token:candidate')).toBe('held-token');
      expect(revokeToken).toHaveBeenCalledWith('held-token');
      const pending = await f.route('jobs/job1/credentials', { attempt: 1, fence: 1, operation: 'fetch' });
      expect(pending.status).toBe(503);
      expect(await pending.json()).toMatchObject({ error: { code: 'TOKEN_REVOCATION_FAILED' } });
      expect(createToken).toHaveBeenCalledTimes(1);
      expect(f.context.state.get('mint-token:candidate')).toBe('held-token');
      const retry = await f.route('jobs/job1/credentials', { attempt: 1, fence: 1, operation: 'fetch' });
      expect(retry.status).toBe(200);
      expect((await retry.json() as { data: { credentials: Array<{ secret: string }> } }).data.credentials[0].secret).toBe('valid-token');
      expect(f.context.state.get('mint-token:candidate')).toBeNull();
      expect(revokeToken).toHaveBeenCalledTimes(3);
      expect(errorLog).toHaveBeenLastCalledWith('TOKEN_REVOCATION_FAILED', 'job1');
    } finally { errorLog.mockRestore(); }
  });

  it.each([
    ['non-finite expiry', { secret: 'held-token', expiresAt: NaN }],
    ['failure marker', { secret: 'held-token', expiresAt: 61_000, [pendingResultFailure]: 'ARTIFACTS_DISPOSE_FAILED' }],
  ])('rejects a credential with %s', async (_case, issued) => {
    const f = await fixture();
    const revoked: string[] = [];
    f.context.storage.mintToken = async () => issued;
    f.context.storage.revokeToken = async (_name, secret) => { revoked.push(secret); return true; };
    expect(runners.hooks['runners.schedule']!(f.context, f.job).status).toBe('eligible');
    await f.route('runner/poll', { runnerId: 'one', role: 'checker', supportedProfileDigests: [pin] });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await f.route('jobs/job1/credentials', { attempt: 1, fence: 1, operation: 'fetch' });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: { code: 'TOKEN_RESULT_INVALID' } });
      expect(revoked).toEqual(['held-token']);
      expect(errorLog).toHaveBeenCalledExactlyOnceWith('TOKEN_RESULT_INVALID', 'job1');
    } finally { errorLog.mockRestore(); }
  });

  it('logs only a fixed code and job id for unexpected credential errors', async () => {
    const f = await fixture();
    runners.hooks['runners.schedule']!(f.context, f.job);
    await f.route('runner/poll', { runnerId: 'one', role: 'checker', supportedProfileDigests: [pin] });
    f.context.storage.mintToken = async () => { throw new Error('private-token-value'); };
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await f.route('jobs/job1/credentials', { attempt: 1, fence: 1, operation: 'fetch' })).status).toBe(503);
      expect(errorLog).toHaveBeenCalledExactlyOnceWith('RUNNER_CREDENTIALS_UNEXPECTED', 'job1');
    } finally { errorLog.mockRestore(); }
  });

  it('exposes a completed result to a reviewer through a read-only route', async () => {
    const f = await fixture();
    runners.hooks['runners.schedule']!(f.context, f.job);
    const poll = await f.route('runner/poll', { runnerId: 'one', role: 'checker', supportedProfileDigests: [pin] });
    const job = (await poll.json() as { data: { job: Job } }).data.job;
    await f.route('jobs/job1/result', await acceptedResult(job));
    f.principal.roles = ['reviewer'];
    const path = '/v1/repos/demo/jobs/job1/result';
    const route = runners.routes.find(item => item.method === 'GET' && item.pattern.test(path))!;
    const response = await route.handle(f.context, new Request('https://test' + path), path.match(route.pattern)!, undefined);
    expect(response.status).toBe(200);
    expect((await response.json() as any).data.result.resultDigest).toMatch(/^sha256:/);
  });

  it('renews a 35-minute job with fake clock advances and no wall wait', async () => {
    const f = await fixture();
    f.context.trusted.profiles['local-demo'].timeoutMs = 35 * 60_000;
    f.job.timeoutMs = 35 * 60_000;
    f.job = await seal(f.job);
    runners.hooks['runners.schedule']!(f.context, f.job);
    expect((await f.route('runner/poll', { runnerId: 'long', role: 'checker', supportedProfileDigests: [pin] })).status).toBe(200);
    for (let elapsed = 20_000; elapsed <= 35 * 60_000; elapsed += 20_000) {
      f.advance(20_000);
      expect((await f.route('jobs/job1/heartbeat', { attempt: 1, fence: 1, inputDigest: f.job.inputDigest })).status).toBe(200);
    }
    expect((runners.snapshot(f.context) as { jobs: Job[] }).jobs[0].state).toBe('claimed');
  });

  it('recovers a persisted claim after a coordinator instance is recreated', async () => {
    const f = await fixture();
    runners.hooks['runners.schedule']!(f.context, f.job);
    await f.route('runner/poll', { runnerId: 'first', role: 'checker', supportedProfileDigests: [pin] });
    f.advance(60_000);
    const restarted = { ...f.context } as ModuleContext;
    await runners.onAlarm(restarted);
    expect((runners.snapshot(restarted) as { jobs: Job[] }).jobs[0]).toMatchObject({ state: 'pending', attempt: 1, fence: 1 });
    const next = await f.route('runner/poll', { runnerId: 'second', role: 'checker', supportedProfileDigests: [pin] });
    expect((await next.json() as { data: { job: Job } }).data.job).toMatchObject({ attempt: 2, fence: 2 });
  });
});
