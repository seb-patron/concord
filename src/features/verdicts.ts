import type { CandidateInput, DeltaCheckJob, DeltaResult, Digest, FeatureModule, Gate, Id, ModuleContext, ReviewManifest, TrustedPolicy, TrustedProfile, Verdict, InspectedRevision } from '../contracts';
import { requireRepo, requireRole } from '../auth';
import { HttpError, json } from '../http';
import { dependencyScopeDigest, hashCanonical, manifestDigest, normalizeManifest } from '../verdicts/manifest';

export type { InspectedRevision } from '../contracts';
interface ActiveEvidence { revision: number; headOid: string; manifestDigest: Digest; profileDigest: Digest; sourceId: Id }
interface CarryRequest { job: DeltaCheckJob; parentVersion: number; status: 'pending' | 'review-required' | 'carried'; reason: string | null; resultDigest: Digest | null; derivedVerdictId: Id | null }

function deltaInputDigest(job: DeltaCheckJob, _parentVersion: number): Digest {
  const { inputDigest: _digest, state: _state, attempt: _attempt, runnerId: _runnerId,
    fence: _fence, expiresAt: _expiresAt, version: _jobVersion, ...immutableInput } = job;
  // Runner scheduling hashes the immutable wire job. Parent version is checked
  // separately against the stored verdict before the result can carry review.
  return hashCanonical(immutableInput);
}

const reject = (context: ModuleContext, code: string, reason: string, evidenceIds: Id[] = []): Gate<never> =>
  ({ status: 'blocked', version: context.version?.() ?? 0, code, reason, evidenceIds });
const isDigest = (value: unknown): value is Digest => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const isId = (value: unknown): value is Id => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const view = (context: ModuleContext, changeId: Id) => context.readChange?.(changeId) ?? reject(context, 'MODULE_UNAVAILABLE', 'Trusted change view unavailable');
const storedVerdict = (context: ModuleContext, id: Id) => context.state.get<Verdict>(`verdict:${id}`);
const ids = (context: ModuleContext, changeId: Id) => context.state.get<Id[]>(`list:${changeId}`) ?? [];

function inspection(context: ModuleContext, changeId: Id): Gate<{ record: InspectedRevision; policy: TrustedPolicy; profile: TrustedProfile }> {
  const change = view(context, changeId);
  if (change.status === 'blocked') return change;
  const record = context.state.get<InspectedRevision>(`inspection:${changeId}`);
  if (!change.value.headOid || !['ready', 'queued', 'checking'].includes(change.value.status) || !record ||
    record.changeId !== changeId || record.revision !== change.value.revision ||
    record.candidate.changeId !== changeId || record.candidate.revision !== change.value.revision ||
    record.candidate.headOid !== change.value.headOid || !['PASS', 'MATCH'].includes(record.outcome)) {
    return reject(context, 'REVIEW_REQUIRED', 'Current revision has no matching trusted inspection');
  }
  const policy = context.trusted.policies[record.policyId];
  const profile = context.trusted.profiles[record.profileId];
  if (!policy || !profile) return reject(context, 'REVIEW_REQUIRED', 'Trusted policy or profile is unavailable');
  try {
    const normalized = normalizeManifest(record.reviewManifest, policy, change.value.unitKeys);
    if (normalized.oracleDigest !== profile.oracleDigest || normalized.toolchainDigest !== profile.toolchainDigest ||
      manifestDigest(normalized, policy, change.value.unitKeys) !== record.reviewManifestDigest) {
      return reject(context, 'REVIEW_REQUIRED', 'Inspection manifest or pins differ');
    }
  } catch { return reject(context, 'REVIEW_REQUIRED', 'Inspection manifest lacks trusted scope'); }
  return { status: 'eligible', version: context.version(), evidenceIds: [changeId], value: { record, policy, profile } };
}

function clearFindings(context: ModuleContext, changeId: Id, revision: number): Gate<{ findingSetVersion: number }> {
  const result = context.call('findings.gate', changeId, revision);
  if (result.status === 'blocked') return result;
  if (result.value.unresolvedIds.length || result.value.pendingRound !== null) return reject(context, 'REVIEW_REQUIRED', 'Unresolved or pending findings require review', result.value.unresolvedIds);
  return { status: 'eligible', version: result.version, evidenceIds: result.evidenceIds, value: { findingSetVersion: result.value.findingSetVersion } };
}

function save(context: ModuleContext, verdict: Verdict, headOid: string, profileDigest: Digest, sourceId: Id): void {
  context.state.put(`verdict:${verdict.verdictId}`, verdict);
  context.state.put(`list:${verdict.changeId}`, [...ids(context, verdict.changeId), verdict.verdictId]);
  context.state.put(`active:${verdict.changeId}`, verdict.verdictId);
  context.state.put(`active-evidence:${verdict.verdictId}`, { revision: verdict.revision, headOid, manifestDigest: verdict.reviewManifestDigest, profileDigest, sourceId } satisfies ActiveEvidence);
}

function gate(context: ModuleContext, changeId: Id, revision: number): Gate<{ verdictId: Id; reviewManifestDigest: Digest; findingSetVersion: number }> {
  const change = view(context, changeId);
  if (change.status === 'blocked') return change;
  if (change.value.revision !== revision || !change.value.headOid) return reject(context, 'REVIEW_REQUIRED', 'Active revision or head changed');
  const activeId = context.state.get<Id>(`active:${changeId}`);
  const verdict = activeId ? storedVerdict(context, activeId) : null;
  if (!verdict || verdict.decision !== 'approve' || verdict.revision !== revision) return reject(context, 'REVIEW_REQUIRED', 'No approval for active revision');
  const evidence = context.state.get<ActiveEvidence>(`active-evidence:${verdict.verdictId}`);
  if (!evidence || evidence.revision !== revision || evidence.headOid !== change.value.headOid || evidence.manifestDigest !== verdict.reviewManifestDigest) return reject(context, 'REVIEW_REQUIRED', 'Approved content is no longer active');
  if (verdict.reviewerId === change.value.authorId) return reject(context, 'REVIEW_REQUIRED', 'Approval is not independent of author');
  const current = inspection(context, changeId);
  if (current.status === 'blocked') return current;
  if (current.value.record.reviewManifestDigest !== verdict.reviewManifestDigest ||
    current.value.policy.digest !== verdict.policyDigest || current.value.policy.checkerDigest !== verdict.checkerDigest ||
    current.value.profile.oracleDigest !== verdict.oracleDigest || current.value.profile.toolchainDigest !== verdict.toolchainDigest ||
    current.value.profile.digest !== evidence.profileDigest) return reject(context, 'REVIEW_REQUIRED', 'Inspected content or trusted pins changed');
  const findings = clearFindings(context, changeId, revision);
  if (findings.status === 'blocked') return findings;
  if (findings.value.findingSetVersion !== verdict.findingSetVersion) return reject(context, 'REVIEW_REQUIRED', 'Finding set changed after approval');
  return { status: 'eligible', version: context.version(), evidenceIds: [verdict.verdictId], value: { verdictId: verdict.verdictId, reviewManifestDigest: verdict.reviewManifestDigest, findingSetVersion: verdict.findingSetVersion } };
}

function contentDifference(oldManifest: ReviewManifest, nextManifest: ReviewManifest): string {
  if (oldManifest.coverage !== 'complete' || nextManifest.coverage !== 'complete') return 'Unknown dependency coverage requires fresh review';
  for (const [index, oldUnit] of oldManifest.changedUnits.entries()) {
    const next = nextManifest.changedUnits[index];
    if (!next || oldUnit.unitKey !== next.unitKey) return 'Changed unit scope differs';
    if (oldUnit.beforePath !== next.beforePath || oldUnit.afterPath !== next.afterPath) return `Reviewed path changed: ${oldUnit.unitKey}`;
    if (oldUnit.beforeMode !== next.beforeMode || oldUnit.afterMode !== next.afterMode) return `Reviewed file mode changed: ${oldUnit.unitKey}`;
    if (oldUnit.beforeDigest !== next.beforeDigest || oldUnit.afterDigest !== next.afterDigest) return `Reviewed byte digest changed: ${oldUnit.unitKey}`;
  }
  for (const [index, oldDependency] of oldManifest.dependencyScope.entries()) {
    const next = nextManifest.dependencyScope[index];
    if (!next || next.kind !== 'unit' || oldDependency.unitKey !== next.unitKey) return 'Trusted dependency scope changed';
    if (oldDependency.path !== next.path || oldDependency.mode !== next.mode) return `Dependency path or mode changed: ${oldDependency.unitKey}`;
    if (oldDependency.contentDigest !== next.contentDigest) return `Dependency digest changed: ${oldDependency.unitKey}`;
  }
  return 'Review manifest changed';
}

function evaluateCarry(context: ModuleContext, result: DeltaResult): Gate<{ verdictId: Id }> {
  if (!context.state || !result) return reject(context, 'MODULE_UNAVAILABLE', 'Trusted delta result unavailable');
  const pending = context.state.get<CarryRequest>(`carry:${result.jobId}`);
  if (!pending) return reject(context, 'REVIEW_REQUIRED', 'No scheduled delta check matches this result');
  if (pending.status === 'carried' && pending.resultDigest === result.resultDigest && pending.derivedVerdictId) {
    if (context.state.get<Id>(`active:${pending.job.changeId}`) !== pending.derivedVerdictId) {
      return reject(context, 'REVIEW_REQUIRED', 'Carried approval is no longer active');
    }
    return { status: 'eligible', version: context.version(), evidenceIds: [pending.derivedVerdictId], value: { verdictId: pending.derivedVerdictId } };
  }
  if (pending.status !== 'pending') return reject(context, 'REVIEW_REQUIRED', pending.reason ?? 'Delta check already decided');
  const job = pending.job;
  const parent = storedVerdict(context, job.parentVerdictId);
  if (!parent || parent.decision !== 'approve' || parent.version !== pending.parentVersion || parent.reviewManifestDigest !== job.oldManifestDigest ||
    parent.findingSetVersion !== job.findingSetVersion) return reject(context, 'REVIEW_REQUIRED', 'Parent approval or expected versions changed');
  const { resultDigest, ...resultPreimage } = result;
  if (result.kind !== 'delta-check' || result.jobId !== job.jobId || result.inputDigest !== job.inputDigest || job.inputDigest !== deltaInputDigest(job, pending.parentVersion) ||
    !Number.isSafeInteger(result.attempt) || result.attempt < 1 || !Number.isSafeInteger(result.fence) || result.fence < 1 ||
    !isDigest(resultDigest) || hashCanonical(resultPreimage) !== resultDigest) {
    return reject(context, 'STALE_DELTA_RESULT', 'Delta result identity, claim fence, or digest is invalid');
  }
  // The runner owns the live claim fence. It invokes this hook only after checking attempt/fence/inputDigest.
  const fail = (reason: string): Gate<never> => {
    pending.status = 'review-required'; pending.reason = reason; pending.resultDigest = resultDigest;
    context.state.put(`carry:${job.jobId}`, pending);
    const version = context.nextVersion();
    context.appendEvent('verdict.carry-review-required', [parent.verdictId, job.jobId], { reason }, version);
    return reject(context, 'REVIEW_REQUIRED', reason, [parent.verdictId, job.jobId]);
  };
  if (context.state.get<Id>(`active:${job.changeId}`) !== parent.verdictId) return fail('Parent approval was superseded');
  if (result.checkerDigest !== job.checkerDigest) return fail('Checker pin changed');
  if (result.oracleDigest !== job.oracleDigest) return fail('Oracle pin changed');
  if (result.toolchainDigest !== job.toolchainDigest) return fail('Toolchain pin changed');
  if (result.environmentDigest !== job.environmentDigest) return fail('Environment pin changed');
  if (!result.sourceTreeOid || !/^[a-f0-9]{40,64}$/.test(result.sourceTreeOid)) return fail('Delta source tree is missing or invalid');
  if (!Number.isFinite(result.durationMs) || result.durationMs < 0 || typeof result.log !== 'string' ||
    new TextEncoder().encode(result.log).length > job.maxOutputBytes) return fail('Delta timing or bounded log is invalid');
  const current = inspection(context, job.changeId);
  if (current.status === 'blocked') return fail(current.reason);
  if (current.value.record.revision !== job.candidate.revision || current.value.record.candidate.headOid !== job.candidate.headOid ||
    current.value.record.candidate.baseOid !== job.candidate.baseOid) return fail('Candidate revision, head, or base changed');
  if (current.value.policy.digest !== job.policyDigest) return fail('Policy pin changed');
  if (current.value.policy.checkerDigest !== job.checkerDigest) return fail('Checker pin changed');
  if (current.value.profile.oracleDigest !== job.oracleDigest) return fail('Oracle pin changed');
  if (current.value.profile.toolchainDigest !== job.toolchainDigest) return fail('Toolchain pin changed');
  if (current.value.profile.digest !== job.profileDigest) return fail('Profile pin changed');
  const findings = clearFindings(context, job.changeId, job.candidate.revision);
  if (findings.status === 'blocked') return fail(findings.reason);
  if (findings.value.findingSetVersion !== job.findingSetVersion) return fail('Finding set changed since delta scheduling');
  if (parent.reviewManifest.coverage !== 'complete') return fail('Unknown dependency coverage requires fresh review');
  if (result.outcome !== 'PASS' && result.outcome !== 'MATCH') return fail(`Affected-unit check returned ${result.outcome}`);
  if (!result.reviewManifest || !result.reviewManifestDigest || !result.dependencyScope || !result.dependencyScopeDigest) return fail('Delta result lacks complete manifest evidence');
  let normalized: ReviewManifest;
  try { normalized = normalizeManifest(result.reviewManifest, current.value.policy, current.value.record.reviewManifest.changedUnits.map(unit => unit.unitKey)); }
  catch { return fail('Delta manifest lacks trusted dependency coverage'); }
  if (normalized.coverage !== 'complete') return fail('Unknown dependency coverage requires fresh review');
  const freshDigest = manifestDigest(normalized, current.value.policy, normalized.changedUnits.map(unit => unit.unitKey));
  if (freshDigest !== result.reviewManifestDigest || dependencyScopeDigest(normalized.dependencyScope) !== result.dependencyScopeDigest ||
    dependencyScopeDigest(result.dependencyScope) !== result.dependencyScopeDigest) return fail('Delta dependency evidence is inconsistent');
  if (freshDigest !== parent.reviewManifestDigest || freshDigest !== job.oldManifestDigest ||
    hashCanonical(normalized.changedUnits) !== hashCanonical(parent.reviewManifest.changedUnits)) return fail(contentDifference(parent.reviewManifest, normalized));
  if (freshDigest !== current.value.record.reviewManifestDigest) return fail('Current inspected content differs from delta evidence');
  const version = context.nextVersion();
  const verdictId = crypto.randomUUID();
  const { carriedFrom: _carriedFrom, ...parentWithoutPatchIdProvenance } = parent;
  const derived: Verdict = { ...parentWithoutPatchIdProvenance, version, verdictId, revision: job.candidate.revision,
    reviewManifest: normalized, reviewManifestDigest: freshDigest, findingSetVersion: job.findingSetVersion,
    parentVerdictId: parent.verdictId, deltaResultId: result.jobId, evidenceDigest: resultDigest };
  save(context, derived, job.candidate.headOid, job.profileDigest, result.jobId);
  pending.status = 'carried'; pending.resultDigest = resultDigest; pending.derivedVerdictId = verdictId;
  context.state.put(`carry:${job.jobId}`, pending);
  context.appendEvent('verdict.carried', [verdictId, parent.verdictId, job.jobId], { revision: derived.revision }, version);
  return { status: 'eligible', version, evidenceIds: [verdictId, result.jobId], value: { verdictId } };
}

const verdictPath = /^\/v1\/repos\/([A-Za-z0-9_-]{1,64})\/changes\/([A-Za-z0-9_-]{1,64})\/verdicts$/;
const carryPath = /^\/v1\/repos\/([A-Za-z0-9_-]{1,64})\/changes\/([A-Za-z0-9_-]{1,64})\/carry$/;

export const verdicts: FeatureModule = {
  name: 'verdicts', migrations: [],
  routes: [
    { method: 'GET', pattern: verdictPath, handle: (context, request, match) => {
      requireRepo(context.principal, match[1]);
      const change = view(context, match[2]);
      if (change.status === 'blocked') throw new HttpError(change.code === 'MODULE_UNAVAILABLE' ? 501 : 409, change.code, change.reason);
      const cursor = new URL(request.url).searchParams.get('cursor');
      let offset = 0;
      try { if (cursor !== null) offset = Number(atob(cursor)); } catch { throw new HttpError(400, 'INVALID_CURSOR', 'Invalid verdict cursor'); }
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, 'INVALID_CURSOR', 'Invalid verdict cursor');
      const all = ids(context, match[2]);
      const full = context.principal.roles.some(role => role === 'owner' || role === 'reviewer');
      const items = all.slice(offset, offset + 100).map(id => storedVerdict(context, id)).filter((item): item is Verdict => item !== null)
        .map(item => full ? item : ({ verdictId: item.verdictId, changeId: item.changeId,
          reviewerId: item.reviewerId, revision: item.revision, decision: item.decision,
          parentVerdictId: item.parentVerdictId }));
      return json({ items, nextCursor: offset + 100 < all.length ? btoa(String(offset + 100)) : null }, context.version());
    } },
    { method: 'POST', pattern: verdictPath, handle: (context, _request, match, raw) => {
      const body = raw as Record<string, unknown>;
      requireRole(context.principal, 'reviewer');
      const changeId = match[2];
      const change = view(context, changeId);
      if (change.status === 'blocked') throw new HttpError(change.code === 'MODULE_UNAVAILABLE' ? 501 : 409, change.code, change.reason);
      if (change.value.authorId === context.principal.principalId) throw new HttpError(403, 'SELF_REVIEW', 'Change author cannot review');
      if (change.value.frozen) throw new HttpError(409, 'PROMOTION_IN_PROGRESS', 'Change is frozen');
      if (!Number.isSafeInteger(body?.revision) || body!.revision !== change.value.revision ||
        !Number.isSafeInteger(body?.findingSetVersion) || !['approve', 'reject'].includes(body?.decision as string) ||
        !isDigest(body?.reviewManifestDigest) || !isDigest(body?.evidenceDigest)) throw new HttpError(422, 'INVALID_VERDICT', 'Verdict fields must bind current revision and evidence');
      const carriedFrom = body?.carriedFrom;
      const sourceOid = (carriedFrom as Record<string, unknown> | null)?.sourceOid;
      const method = (carriedFrom as Record<string, unknown> | null)?.method;
      if (carriedFrom !== undefined && (!carriedFrom || typeof carriedFrom !== 'object' || Array.isArray(carriedFrom) ||
        typeof sourceOid !== 'string' || !/^[a-fA-F0-9]{40}$/.test(sourceOid) ||
        typeof method !== 'string' || method !== 'patch-id' || body.decision !== 'approve' ||
        sourceOid.toLowerCase() === change.value.headOid?.toLowerCase())) {
        throw new HttpError(400, 'INVALID_CARRIED_FROM', 'carriedFrom requires an approved, distinct 40-hex source OID and patch-id method');
      }
      const current = inspection(context, changeId);
      if (current.status === 'blocked') throw new HttpError(409, current.code, current.reason);
      if (body!.reviewManifestDigest !== current.value.record.reviewManifestDigest) throw new HttpError(409, 'MANIFEST_MISMATCH', 'Verdict manifest does not match trusted inspection');
      const findings = context.call('findings.gate', changeId, body!.revision as number);
      if (findings.status === 'blocked') throw new HttpError(409, findings.code, findings.reason);
      if (findings.value.findingSetVersion !== body!.findingSetVersion) throw new HttpError(409, 'FINDINGS_STALE', 'Finding set version changed');
      if (body!.decision === 'approve' && (findings.value.unresolvedIds.length || findings.value.pendingRound !== null)) {
        throw new HttpError(409, 'REVIEW_REQUIRED', 'Unresolved or pending findings require review');
      }
      const version = context.nextVersion();
      const verdictId = crypto.randomUUID();
      const verdict: Verdict = { version, verdictId, changeId, reviewerId: context.principal.principalId,
        revision: body!.revision as number, reviewManifestDigest: body!.reviewManifestDigest as Digest,
        reviewManifest: normalizeManifest(current.value.record.reviewManifest, current.value.policy, change.value.unitKeys),
        policyDigest: current.value.policy.digest, checkerDigest: current.value.policy.checkerDigest,
        oracleDigest: current.value.profile.oracleDigest, toolchainDigest: current.value.profile.toolchainDigest,
        deltaResultId: null, findingSetVersion: body!.findingSetVersion as number,
        decision: body!.decision as 'approve' | 'reject', evidenceDigest: body!.evidenceDigest as Digest, parentVerdictId: null,
        ...(carriedFrom === undefined ? {} : { carriedFrom: carriedFrom as Verdict['carriedFrom'] }) };
      save(context, verdict, change.value.headOid!, current.value.profile.digest, changeId);
      const event = context.appendEvent('verdict.created', [verdictId, changeId], { decision: verdict.decision, revision: verdict.revision }, version);
      return json(verdict, version, event.sequence, 201);
    } },
    { method: 'POST', pattern: carryPath, handle: async (context, _request, match, raw) => {
      const body = raw as Record<string, unknown>;
      requireRole(context.principal, 'reviewer');
      const changeId = match[2];
      const change = view(context, changeId);
      if (change.status === 'blocked') throw new HttpError(change.code === 'MODULE_UNAVAILABLE' ? 501 : 409, change.code, change.reason);
      if (change.value.authorId === context.principal.principalId) throw new HttpError(403, 'SELF_REVIEW', 'Change author cannot request carry');
      if (change.value.frozen) throw new HttpError(409, 'PROMOTION_IN_PROGRESS', 'Change is frozen');
      if (!isId(body?.parentVerdictId) || !Number.isSafeInteger(body?.revision) || body!.revision !== change.value.revision ||
        typeof body?.newBaseOid !== 'string' || !/^[a-f0-9]{40,64}$/.test(body.newBaseOid)) throw new HttpError(422, 'INVALID_CARRY', 'Carry must name parent, current revision, and new base');
      const parent = storedVerdict(context, body!.parentVerdictId as string);
      if (!parent || parent.changeId !== changeId || parent.decision !== 'approve') throw new HttpError(409, 'REVIEW_REQUIRED', 'Parent approval unavailable');
      if (parent.reviewManifest.coverage !== 'complete') throw new HttpError(409, 'REVIEW_REQUIRED', 'Unknown dependency coverage requires fresh review');
      const parentEvidence = context.state.get<ActiveEvidence>(`active-evidence:${parent.verdictId}`);
      if (!parentEvidence || parentEvidence.manifestDigest !== parent.reviewManifestDigest) throw new HttpError(409, 'REVIEW_REQUIRED', 'Parent approval evidence is unavailable');
      const current = inspection(context, changeId);
      if (current.status === 'blocked') throw new HttpError(409, current.code, current.reason);
      const findings = clearFindings(context, changeId, body!.revision as number);
      if (findings.status === 'blocked') throw new HttpError(409, findings.code, findings.reason);
      if (findings.value.findingSetVersion !== parent.findingSetVersion) throw new HttpError(409, 'REVIEW_REQUIRED', 'Finding set changed after parent approval');
      const { record, policy, profile } = current.value;
      if (policy.digest !== parent.policyDigest) throw new HttpError(409, 'REVIEW_REQUIRED', 'Policy pin changed');
      if (policy.checkerDigest !== parent.checkerDigest) throw new HttpError(409, 'REVIEW_REQUIRED', 'Checker pin changed');
      if (profile.oracleDigest !== parent.oracleDigest) throw new HttpError(409, 'REVIEW_REQUIRED', 'Oracle pin changed');
      if (profile.toolchainDigest !== parent.toolchainDigest) throw new HttpError(409, 'REVIEW_REQUIRED', 'Toolchain pin changed');
      if (profile.digest !== parentEvidence.profileDigest) throw new HttpError(409, 'REVIEW_REQUIRED', 'Profile pin changed');
      if (record.candidate.baseOid !== body!.newBaseOid) throw new HttpError(409, 'REVIEW_REQUIRED', 'Candidate base differs from requested new base');
      const canonical = await context.storage.resolveRef(record.canonicalStorageName, 'refs/heads/main');
      if (canonical !== body!.newBaseOid) throw new HttpError(409, 'REVIEW_REQUIRED', 'New base is not current canonical tip');
      const candidateRepo = await context.storage.info(record.candidate.storageName);
      const canonicalRepo = await context.storage.info(record.canonicalStorageName);
      if (!candidateRepo || !canonicalRepo || candidateRepo.status !== 'ready' || canonicalRepo.status !== 'ready') throw new HttpError(409, 'REVIEW_REQUIRED', 'Delta storage remotes unavailable');
      const jobId = crypto.randomUUID();
      const version = context.version() + 1;
      const job: DeltaCheckJob = {
        kind: 'delta-check', version, jobId, repoId: context.repoId, generation: version,
        inputDigest: hashCanonical(null),
        profileDigest: profile.digest, policyId: policy.id, policyDigest: policy.digest, unitPolicy: structuredClone(policy),
        expectedRefs: { [record.candidate.storageName]: record.candidate.headOid, [record.canonicalStorageName]: body!.newBaseOid as string },
        storageRemotes: { [record.candidate.storageName]: candidateRepo.remote, [record.canonicalStorageName]: canonicalRepo.remote },
        checkerId: policy.checkerId, checkerDigest: policy.checkerDigest, oracleDigest: profile.oracleDigest,
        toolchainDigest: profile.toolchainDigest, environmentDigest: profile.environmentDigest,
        timeoutMs: profile.timeoutMs, maxOutputBytes: profile.maxOutputBytes,
        ...(policy.checkerId === 'dispatch-lab' ? { caseId: change.value.intentKey === 'D' ? 'd-e' :
          change.value.intentKey === 'H' ? 'h-only' : 'seed' } : {}),
        state: 'pending', attempt: 0, runnerId: null, fence: 0, expiresAt: null,
        changeId, candidate: structuredClone(record.candidate), oldManifestDigest: parent.reviewManifestDigest,
        newBaseOid: body!.newBaseOid as string, parentVerdictId: parent.verdictId,
        findingSetVersion: findings.value.findingSetVersion, oldReviewManifest: structuredClone(parent.reviewManifest),
      };
      job.inputDigest = deltaInputDigest(job, parent.version);
      if (context.state.get<Id>(`active:${changeId}`) !== parent.verdictId) {
        throw new HttpError(409, 'REVIEW_REQUIRED', 'Parent approval was superseded');
      }
      const scheduled = context.call('runners.schedule', structuredClone(job));
      if (scheduled.status === 'blocked') throw new HttpError(409, scheduled.code, scheduled.reason);
      if (scheduled.value.jobId !== jobId) throw new HttpError(409, 'SCHEDULE_MISMATCH', 'Runner accepted another job identity');
      context.state.put(`carry:${jobId}`, { job: structuredClone(job), parentVersion: parent.version, status: 'pending', reason: null, resultDigest: null, derivedVerdictId: null } satisfies CarryRequest);
      const committed = context.nextVersion();
      const event = context.appendEvent('verdict.carry-requested', [parent.verdictId, jobId], { newBaseOid: body!.newBaseOid, revision: body!.revision }, committed);
      return json({ jobId, parentVerdictId: parent.verdictId, status: 'pending' }, committed, event.sequence, 202);
    } },
  ],
  snapshot: context => {
    const availability = view(context, '__availability__');
    return { status: availability.status === 'blocked' && availability.code === 'MODULE_UNAVAILABLE' ? 'unavailable' : 'ready', items: [] };
  },
  nextDeadline: () => null, onAlarm: () => undefined,
  hooks: { 'verdicts.gate': gate, 'verdicts.evaluateCarry': evaluateCarry,
    'verdicts.recordInspection': (context, record) => {
      // The repository module has already checked this inspection against its
      // indexed candidate and declared units. Keep the handoff digest strict,
      // while allowing legacy seed inspections with no reviewable units to be
      // recorded; the verdict gate still rejects those manifests.
      if (!context.principal || !context.trusted || !context.state) {
        return reject(context, 'MODULE_UNAVAILABLE', 'Trusted inspection context unavailable');
      }
      if (!context.principal.roles.includes('checker') || !record || !record.reviewManifest ||
        !context.trusted.policies[record.policyId] ||
        record.reviewManifestDigest !== hashCanonical(record.reviewManifest)) {
        return reject(context, 'INSPECTION_MISMATCH', 'Trusted inspection record is incomplete');
      }
      context.state.put(`inspection:${record.changeId}`, structuredClone(record));
      return { status: 'eligible', version: context.version(), evidenceIds: [record.changeId], value: undefined };
    } },
};
