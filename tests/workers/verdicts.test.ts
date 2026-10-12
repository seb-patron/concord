import { describe, expect, it } from 'vitest';
import type { CandidateInput, DeltaCheckJob, DeltaResult, Digest, ModuleContext, ReviewManifest, TrustedPolicy, TrustedProfile, Verdict } from '../../src/contracts';
import { verdicts, humanApprovalStatus, type InspectedRevision } from '../../src/features/verdicts';
import { canonicalJson, dependencyScopeDigest, hashCanonical, manifestDigest, normalizeManifest, trustedDependencyKeys } from '../../src/verdicts/manifest';

const d = (text: string): Digest => hashCanonical(text);
const oid = (char: string) => char.repeat(40);
const policy: TrustedPolicy = {
  id: 'demo', digest: d('policy'), version: 3, checkerId: 'table-checker', checkerDigest: d('checker'),
  units: {
    'row:alpha': { canonicalKey: 'row:alpha', file: 'families.tsv', resources: [], dependencyKeys: [] },
    'row:beta': { canonicalKey: 'row:beta', file: 'families.tsv', resources: [], dependencyKeys: [] },
    'row:gamma': { canonicalKey: 'row:gamma', file: 'families.tsv', resources: [], dependencyKeys: ['row:beta'] },
  },
  acceptance: { kind: 'hard-gates', gates: [{ id: 'table', requiredOutcome: 'PASS' }] },
};
const profile: TrustedProfile = { id: 'demo', digest: d('profile'), toolchainDigest: d('toolchain'), oracleDigest: d('oracle'), environmentDigest: d('environment'), timeoutMs: 1000, maxOutputBytes: 1024 };

function manifest(unitKey: string, options: { dependency?: Digest; after?: Digest; mode?: string; oracle?: Digest; coverage?: 'unknown' } = {}): ReviewManifest {
  const common = {
    changedUnits: [{ unitKey, beforePath: 'families.tsv', afterPath: 'families.tsv', beforeMode: '100644', afterMode: options.mode ?? '100644', beforeDigest: d(`${unitKey}:before`), afterDigest: options.after ?? d(`${unitKey}:after`) }],
    policyVersion: policy.version, policyDigest: policy.digest, checkerDigest: policy.checkerDigest,
    oracleDigest: options.oracle ?? profile.oracleDigest, toolchainDigest: profile.toolchainDigest,
  };
  if (options.coverage === 'unknown') return { ...common, coverage: 'unknown', dependencyScope: [{ kind: 'tree', treeOid: oid('f') }] };
  return { ...common, coverage: 'complete', dependencyScope: unitKey === 'row:gamma' ?
    [{ kind: 'unit', unitKey: 'row:beta', path: 'families.tsv', mode: '100644', contentDigest: options.dependency ?? d('beta:before') }] : [] };
}

function harness(unitKey = 'row:alpha', initial = manifest(unitKey)) {
  const state = new Map<string, unknown>();
  let version = 0;
  let findingVersion = 0;
  let unresolvedIds: string[] = [];
  let author = 'agent-a';
  let revision = 1;
  let head = oid('a');
  let base = oid('0');
  let canonical = oid('0');
  let frozen = false;
  let activeManifest = initial;
  let trustedProfile = profile;
  const jobs: DeltaCheckJob[] = [];
  const candidate = (): CandidateInput => ({ changeId: 'change', revision, baseOid: base, headOid: head, storageName: 'candidate', ref: 'refs/heads/work' });
  const installInspection = (override?: Partial<InspectedRevision>) => {
    const record: InspectedRevision = { changeId: 'change', revision, candidate: candidate(), canonicalStorageName: 'canonical',
      policyId: 'demo', profileId: 'demo', reviewManifest: activeManifest,
      reviewManifestDigest: manifestDigest(activeManifest, policy, [unitKey]), outcome: 'PASS', ...override };
    state.set('inspection:change', record);
  };
  installInspection();
  const context = {
    repoId: 'repo', tenantId: 'local', principal: { tenantId: 'local', principalId: 'reviewer', roles: ['reviewer'], repoIds: '*', expiresAt: Infinity },
    trusted: { policies: { demo: policy }, profiles: { demo: trustedProfile } }, now: () => 100,
    storage: { resolveRef: async () => canonical, info: async (name: string) => ({ name, remote: `https://example.test/${name}`, status: 'ready' }) },
    state: { get: <T>(key: string) => (state.get(key) ?? null) as T | null, put: <T>(key: string, value: T) => { state.set(key, value); }, delete: (key: string) => { state.delete(key); } },
    sql: { exec: (_query: string, key: string) => ({ toArray: () => {
      const actual = key?.startsWith('module:verdicts:') ? key.slice('module:verdicts:'.length) : key;
      const value = state.get(actual);
      return value === undefined ? [] : [{ value: JSON.stringify(value) }];
    } }) },
    version: () => version, nextVersion: () => ++version,
    appendEvent: (_kind: string, _ids: string[], _payload: Record<string, unknown>, eventVersion: number) => ({ sequence: eventVersion }),
    readChange: () => ({ status: 'eligible', version, evidenceIds: ['change'], value: { authorId: author, headOid: head, revision, status: 'ready', unitKeys: [unitKey], frozen } }),
    call: (name: string, ...args: unknown[]) => {
      if (name === 'findings.gate') return { status: 'eligible', version, evidenceIds: [], value: { findingSetVersion: findingVersion, unresolvedIds, pendingRound: null } };
      if (name === 'runners.schedule') { jobs.push(args[0] as DeltaCheckJob); return { status: 'eligible', version, evidenceIds: [], value: { jobId: (args[0] as DeltaCheckJob).jobId } }; }
      throw new Error(`Unknown hook ${name}`);
    },
  } as unknown as ModuleContext;
  async function route(method: 'GET' | 'POST', path: 'verdicts' | 'carry' | 'human-approval', body: Record<string, unknown> = {}) {
    const pathname = `/v1/repos/repo/changes/change/${path}`;
    const selected = verdicts.routes.find(item => item.method === method && item.pattern.test(pathname))!;
    const response = await selected.handle(context, new Request(`https://concord.test${pathname}`, { method }), pathname.match(selected.pattern)!, body);
    return { status: response.status, payload: await response.json() as { data: any } };
  }
  const approve = async () => {
    const response = await route('POST', 'verdicts', { revision, findingSetVersion: findingVersion, reviewManifestDigest: manifestDigest(activeManifest, policy, [unitKey]), decision: 'approve', evidenceDigest: d('review-evidence') });
    expect(response.status).toBe(201);
    return response.payload.data as Verdict;
  };
  const advance = (next = initial) => { revision++; base = oid('1'); head = oid('b'); canonical = oid('1'); activeManifest = next; installInspection(); };
  const carry = async (parent: Verdict) => route('POST', 'carry', { parentVerdictId: parent.verdictId, revision, newBaseOid: base });
  const result = (job = jobs.at(-1)!, next = activeManifest, outcome: DeltaResult['outcome'] = 'PASS'): DeltaResult => {
    const normalized = normalizeManifest(next, policy, [unitKey]);
    const scope = normalized.dependencyScope;
    const preimage = {
      kind: 'delta-check' as const, jobId: job.jobId, attempt: 1, fence: 1, inputDigest: job.inputDigest,
      sourceTreeOid: oid('e'), checkerDigest: job.checkerDigest, toolchainDigest: job.toolchainDigest,
      oracleDigest: job.oracleDigest, environmentDigest: job.environmentDigest, durationMs: 1, log: '',
      outcome, reviewManifestDigest: manifestDigest(normalized, policy, [unitKey]), reviewManifest: normalized,
      dependencyScopeDigest: dependencyScopeDigest(scope), dependencyScope: scope,
    };
    return { ...preimage, resultDigest: hashCanonical(preimage) };
  };
  return { context, state, jobs, route, approve, advance, carry, result, installInspection,
    gate: () => verdicts.hooks['verdicts.gate']!(context, 'change', revision),
    evaluate: (value: DeltaResult) => verdicts.hooks['verdicts.evaluateCarry']!(context, value),
    setAuthor: (value: string) => { author = value; },
    setFrozen: (value: boolean) => { frozen = value; },
    setFindings: (value: number, unresolved: string[] = []) => { findingVersion = value; unresolvedIds = unresolved; },
    setProfile: (value: TrustedProfile) => { trustedProfile = value; context.trusted.profiles.demo = value; },
    setManifest: (value: ReviewManifest) => { activeManifest = value; installInspection(); },
  };
}

describe('content-bound verdicts', () => {
  it('carries a separate owner approval across a clean rebase', async () => {
    const h = harness();
    h.state.set('module:settings:record', { version: 1, protectedPaths: [{ pattern: 'families.tsv', level: 'human-approval' }] });
    const parent = await h.approve();
    expect(humanApprovalStatus(h.context, 'change', 1).awaitingHumanApproval).toEqual(['families.tsv']);
    h.context.principal.principalId = 'owner';
    h.context.principal.roles = ['owner'];
    const approval = await h.route('POST', 'human-approval', { revision: 1,
      reviewManifestDigest: parent.reviewManifestDigest, decision: 'approve', evidenceDigest: d('owner-evidence') });
    expect(approval.status).toBe(201);
    expect(humanApprovalStatus(h.context, 'change', 1).awaitingHumanApproval).toEqual([]);
    h.context.principal.principalId = 'reviewer';
    h.context.principal.roles = ['reviewer'];
    h.advance();
    expect(humanApprovalStatus(h.context, 'change', 2).awaitingHumanApproval).toEqual(['families.tsv']);
    expect((await h.carry(parent)).status).toBe(202);
    expect(h.evaluate(h.result()).status).toBe('eligible');
    expect(humanApprovalStatus(h.context, 'change', 2).awaitingHumanApproval).toEqual([]);
  });
  it('uses canonical byte-sensitive sorted manifests and exact trusted dependency closure', async () => {
    const original = manifest('row:gamma');
    const reversed = { ...original, changedUnits: [...original.changedUnits].reverse(), dependencyScope: [...original.dependencyScope].reverse() } as ReviewManifest;
    expect(manifestDigest(original, policy, ['row:gamma'])).toBe(manifestDigest(reversed, policy, ['row:gamma']));
    const twoChanged = { ...original, changedUnits: [...original.changedUnits, ...manifest('row:alpha').changedUnits] } as ReviewManifest;
    expect(manifestDigest(twoChanged, policy, ['row:alpha', 'row:gamma'])).toBe(manifestDigest({ ...twoChanged, changedUnits: [...twoChanged.changedUnits].reverse() }, policy, ['row:alpha', 'row:gamma']));
    const widerPolicy = { ...policy, digest: d('wider-policy'), units: { ...policy.units, 'row:gamma': { ...policy.units['row:gamma'], dependencyKeys: ['row:alpha', 'row:beta'] } } };
    const wider = { ...original, policyDigest: widerPolicy.digest, dependencyScope: [
      { kind: 'unit' as const, unitKey: 'row:beta', path: 'families.tsv', mode: '100644', contentDigest: d('beta:before') },
      { kind: 'unit' as const, unitKey: 'row:alpha', path: 'families.tsv', mode: '100644', contentDigest: d('alpha:before') },
    ] } as ReviewManifest;
    expect(manifestDigest(wider, widerPolicy, ['row:gamma'])).toBe(manifestDigest({ ...wider, dependencyScope: [...wider.dependencyScope].reverse() } as ReviewManifest, widerPolicy, ['row:gamma']));
    expect(trustedDependencyKeys(policy, ['row:gamma'])).toEqual(['row:beta']);
    const dispatchPolicy = { ...policy, units: {
      'row:families:gamma': { canonicalKey: 'row:families:gamma', file: 'families.tsv',
        resources: ['families.tsv#gamma'], dependencyKeys: ['row:families:beta'] },
      'row:families:beta': { canonicalKey: 'row:families:beta', file: 'families.tsv',
        resources: ['families.tsv#beta'], dependencyKeys: [] },
    } };
    expect(trustedDependencyKeys(dispatchPolicy, ['row:families:gamma'])).toEqual(['row:families:beta']);
    expect(() => trustedDependencyKeys({ ...dispatchPolicy, units: { ...dispatchPolicy.units,
      'row:families:gamma': { ...dispatchPolicy.units['row:families:gamma'], resources: ['families.tsv#beta'] } } },
    ['row:families:gamma'])).toThrow('UNKNOWN_RESOURCE_SCOPE');
    expect(() => manifestDigest({ ...original, dependencyScope: [] } as ReviewManifest, policy, ['row:gamma'])).toThrow('MANIFEST_DEPENDENCY_SCOPE_MISMATCH');
    expect(manifestDigest(manifest('row:gamma', { after: d('row:gamma:after ') }), policy, ['row:gamma'])).not.toBe(manifestDigest(original, policy, ['row:gamma']));
    expect(manifestDigest(manifest('row:gamma', { mode: '100755' }), policy, ['row:gamma'])).not.toBe(manifestDigest(original, policy, ['row:gamma']));
    const moved = { ...original, changedUnits: [{ ...original.changedUnits[0], beforePath: 'old-families.tsv' }] } as ReviewManifest;
    expect(manifestDigest(moved, policy, ['row:gamma'])).not.toBe(manifestDigest(original, policy, ['row:gamma']));
    expect(() => manifestDigest({ ...original, dependencyScope: [...original.dependencyScope, ...original.dependencyScope] } as ReviewManifest, policy, ['row:gamma'])).toThrow('MANIFEST_DEPENDENCY_SCOPE_MISMATCH');
    expect(() => manifestDigest(original, { ...policy, units: { ...policy.units, 'row:gamma': { ...policy.units['row:gamma'], resources: ['schema.tsv'] } } }, ['row:gamma'])).toThrow('UNKNOWN_RESOURCE_SCOPE');
    const bytes = new TextEncoder().encode(JSON.stringify('abc'));
    const web = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    expect(hashCanonical('abc')).toBe(`sha256:${Array.from(web, byte => byte.toString(16).padStart(2, '0')).join('')}`);
    const normalized = normalizeManifest(original, policy, ['row:gamma']);
    const manifestBytes = new TextEncoder().encode(canonicalJson(normalized));
    const webManifest = new Uint8Array(await crypto.subtle.digest('SHA-256', manifestBytes));
    expect(manifestDigest(original, policy, ['row:gamma'])).toBe(`sha256:${Array.from(webManifest, byte => byte.toString(16).padStart(2, '0')).join('')}`);
  });

  it('carries an independent TSV row across a changed commit identity with fenced delta evidence', async () => {
    const h = harness();
    const parent = await h.approve();
    expect(h.gate().status).toBe('eligible');
    h.setFrozen(true);
    expect(h.gate().status).toBe('eligible');
    h.setFrozen(false);
    h.advance();
    expect(h.gate().status).toBe('blocked');
    expect((await h.carry(parent)).status).toBe(202);
    const job = h.jobs[0];
    expect(job).toMatchObject({ kind: 'delta-check', parentVerdictId: parent.verdictId, newBaseOid: oid('1'),
      candidate: { revision: 2, headOid: oid('b') }, oldManifestDigest: parent.reviewManifestDigest,
      findingSetVersion: 0, checkerDigest: policy.checkerDigest, oracleDigest: profile.oracleDigest });
    const accepted = h.evaluate(h.result());
    expect(accepted.status).toBe('eligible');
    if (accepted.status !== 'eligible') return;
    const child = h.state.get(`verdict:${accepted.value.verdictId}`) as Verdict;
    expect(child).toMatchObject({ parentVerdictId: parent.verdictId, deltaResultId: job.jobId, revision: 2, reviewerId: 'reviewer' });
    expect(h.gate().status).toBe('eligible');
    expect((await h.route('GET', 'verdicts')).payload.data.items).toHaveLength(2);
    expect(h.state.get(`verdict:${parent.verdictId}`)).toEqual(parent);
  });

  it('refuses to schedule carry from an approval superseded by a current verdict', async () => {
    const h = harness();
    const parent = await h.approve();
    h.advance();
    const newer = await h.approve();
    await expect(h.carry(parent)).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });
    expect(h.jobs).toHaveLength(0);
    expect(h.state.get('active:change')).toBe(newer.verdictId);
    expect(h.gate().status).toBe('eligible');
  });

  it('rechecks the active approval after resolving carry storage', async () => {
    const h = harness();
    const parent = await h.approve();
    h.advance();
    let newer: Verdict | undefined;
    h.context.storage.resolveRef = async () => {
      newer = await h.approve();
      return oid('1');
    };
    await expect(h.carry(parent)).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });
    expect(h.jobs).toHaveLength(0);
    expect(h.state.get('active:change')).toBe(newer?.verdictId);
  });

  it('preserves a rejection made while carry is pending', async () => {
    const h = harness();
    const parent = await h.approve();
    h.advance();
    expect((await h.carry(parent)).status).toBe(202);
    const rejected = (await h.route('POST', 'verdicts', {
      revision: 2, findingSetVersion: 0, reviewManifestDigest: parent.reviewManifestDigest,
      decision: 'reject', evidenceDigest: d('rejection'),
    })).payload.data as Verdict;
    const green = h.result();
    expect(h.evaluate(green)).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED' });
    expect(h.evaluate(green)).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED' });
    expect(h.state.get('active:change')).toBe(rejected.verdictId);
    expect(h.gate()).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED' });
    expect((await h.route('GET', 'verdicts')).payload.data.items).toHaveLength(2);
    expect(h.state.get(`verdict:${parent.verdictId}`)).toEqual(parent);
  });

  it('does not report a superseded carried verdict as eligible on replay', async () => {
    const h = harness();
    const parent = await h.approve();
    h.advance();
    await h.carry(parent);
    const green = h.result();
    const carried = h.evaluate(green);
    expect(carried.status).toBe('eligible');
    expect(h.evaluate(green)).toMatchObject({ status: 'eligible' });
    const newer = await h.approve();
    expect(h.evaluate(green)).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED' });
    expect(h.state.get('active:change')).toBe(newer.verdictId);
    expect((await h.route('GET', 'verdicts')).payload.data.items).toHaveLength(3);
  });

  it('rejects dependent-row base advancement and preserves parent history', async () => {
    const h = harness('row:gamma');
    const parent = await h.approve();
    h.advance(manifest('row:gamma', { dependency: d('beta:advanced') }));
    expect((await h.carry(parent)).status).toBe(202);
    const decision = h.evaluate(h.result());
    expect(decision).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED' });
    expect((decision as { reason: string }).reason).toContain('Dependency digest changed: row:beta');
    expect((await h.route('GET', 'verdicts')).payload.data.items).toHaveLength(1);
    expect(h.state.get(`verdict:${parent.verdictId}`)).toEqual(parent);
  });

  it('rejects forged review manifests and missing inspection', async () => {
    const h = harness();
    await expect(h.route('POST', 'verdicts', { revision: 1, findingSetVersion: 0, decision: 'approve', reviewManifestDigest: d('forged'), evidenceDigest: d('review') })).rejects.toMatchObject({ code: 'MANIFEST_MISMATCH' });
    expect(() => h.installInspection({ reviewManifest: { ...manifest('row:alpha'), dependencyScope: [{ kind: 'unit', unitKey: 'row:beta', path: 'families.tsv', mode: '100644', contentDigest: d('beta') }] } as ReviewManifest })).not.toThrow();
    expect(h.gate()).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED' });
    h.state.delete('inspection:change');
    expect(h.gate()).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED' });
  });

  it('refuses stale result identity and changed oracle pin', async () => {
    const h = harness();
    const parent = await h.approve();
    h.advance();
    await h.carry(parent);
    const stale = h.result();
    stale.inputDigest = d('other-job');
    expect(h.evaluate(stale)).toMatchObject({ status: 'blocked', code: 'STALE_DELTA_RESULT' });
    const changed = { ...profile, oracleDigest: d('new-oracle'), digest: d('new-profile') };
    h.setProfile(changed);
    h.setManifest(manifest('row:alpha', { oracle: changed.oracleDigest }));
    expect(h.evaluate(h.result())).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED', reason: 'Oracle pin changed' });
  });

  it('requires unchanged findings and a green pinned delta result at completion', async () => {
    const added = harness();
    const parent = await added.approve();
    added.advance();
    await added.carry(parent);
    added.setFindings(1, ['new-finding']);
    expect(added.evaluate(added.result())).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED', reason: expect.stringContaining('finding') });

    const conflict = harness();
    const approved = await conflict.approve();
    conflict.advance();
    await conflict.carry(approved);
    expect(conflict.evaluate(conflict.result(undefined, undefined, 'MERGE_CONFLICT'))).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED', reason: expect.stringContaining('MERGE_CONFLICT') });

    const pin = harness();
    const prior = await pin.approve();
    pin.advance();
    await pin.carry(prior);
    const forged = pin.result();
    forged.checkerDigest = d('different-checker');
    const { resultDigest: _ignored, ...preimage } = forged;
    forged.resultDigest = hashCanonical(preimage);
    expect(pin.evaluate(forged)).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED', reason: 'Checker pin changed' });
  });

  it('refuses a forged delta scope and a changed immutable job input', async () => {
    const scope = harness('row:gamma');
    const parent = await scope.approve();
    scope.advance();
    await scope.carry(parent);
    const forged = scope.result();
    forged.dependencyScope = [];
    forged.dependencyScopeDigest = dependencyScopeDigest([]);
    const { resultDigest: _ignored, ...preimage } = forged;
    forged.resultDigest = hashCanonical(preimage);
    expect(scope.evaluate(forged)).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED', reason: 'Delta dependency evidence is inconsistent' });

    const job = harness();
    const original = await job.approve();
    job.advance();
    await job.carry(original);
    const pending = job.state.get(`carry:${job.jobs[0].jobId}`) as { job: DeltaCheckJob };
    pending.job.newBaseOid = oid('9');
    expect(job.evaluate(job.result())).toMatchObject({ status: 'blocked', code: 'STALE_DELTA_RESULT' });
  });

  it('forbids self review even with reviewer role and refuses unknown coverage', async () => {
    const h = harness();
    h.setAuthor('reviewer');
    const body = { revision: 1, findingSetVersion: 0, reviewManifestDigest: manifestDigest(manifest('row:alpha'), policy, ['row:alpha']), decision: 'approve', evidenceDigest: d('review') };
    await expect(h.route('POST', 'verdicts', body)).rejects.toMatchObject({ code: 'SELF_REVIEW' });
    expect((await h.route('GET', 'verdicts')).status).toBe(200);
    const unknown = harness('row:alpha', manifest('row:alpha', { coverage: 'unknown' }));
    const parent = await unknown.approve();
    unknown.advance(manifest('row:alpha', { coverage: 'unknown' }));
    await expect(unknown.carry(parent)).rejects.toMatchObject({ code: 'REVIEW_REQUIRED', message: expect.stringContaining('Unknown dependency') });
  });

  it('shares reduced verdict history with in-scope readers and keeps writes reviewer-only', async () => {
    const h = harness();
    const approved = await h.approve();
    const principal = h.context.principal;
    for (const role of ['viewer', 'agent'] as const) {
      principal.roles = [role];
      const read = await h.route('GET', 'verdicts');
      expect(read.status).toBe(200);
      expect(read.payload.data.items).toEqual([{
        verdictId: approved.verdictId, changeId: approved.changeId, reviewerId: approved.reviewerId,
        revision: approved.revision, decision: approved.decision, parentVerdictId: null,
      }]);
      const serialized = JSON.stringify(read.payload.data);
      expect(serialized).not.toMatch(/reviewManifest|evidenceDigest|beforePath|afterPath|beforeDigest|afterDigest|sha256:/);
      await expect(h.route('POST', 'verdicts', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(h.route('POST', 'carry', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    principal.roles = ['owner'];
    expect((await h.route('GET', 'verdicts')).payload.data.items).toEqual([approved]);
    principal.roles = ['reviewer'];
    expect((await h.route('GET', 'verdicts')).payload.data.items).toEqual([approved]);
    principal.repoIds = ['other'];
    await expect(h.route('GET', 'verdicts')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects whitespace and mode changes after review', async () => {
    for (const changed of [manifest('row:alpha', { after: d('row:alpha:after ') }), manifest('row:alpha', { mode: '100755' })]) {
      const h = harness();
      const parent = await h.approve();
      h.advance(changed);
      await h.carry(parent);
      expect(h.evaluate(h.result())).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED' });
    }
  });

  it('blocks approval and gate on new or unresolved findings', async () => {
    const h = harness();
    h.setFindings(1, ['finding-1']);
    await expect(h.approve()).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });
    const rejection = await h.route('POST', 'verdicts', { revision: 1, findingSetVersion: 1,
      reviewManifestDigest: manifestDigest(manifest('row:alpha'), policy, ['row:alpha']), decision: 'reject', evidenceDigest: d('rejection') });
    expect(rejection.status).toBe(201);
    expect(h.gate().status).toBe('blocked');
    h.setFindings(1);
    const parent = await h.approve();
    expect(h.gate().status).toBe('eligible');
    h.setFindings(2);
    expect(h.gate()).toMatchObject({ status: 'blocked', code: 'REVIEW_REQUIRED' });
    h.advance();
    await expect(h.carry(parent)).rejects.toMatchObject({ code: 'REVIEW_REQUIRED' });
  });
});
