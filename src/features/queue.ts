import type {
  BootstrapHandoff, CandidateInput, ChangeView, Digest, FeatureModule, FrozenAdmission, Gate, Id,
  Job, ModuleContext, Promotion, PromotionResult, SeedInput, StackResult, ValidateStackJob,
} from '../contracts';
import { digest, failure, HttpError, json } from '../http';
import { eventSequence } from '../state';
import { accepted, arbitrate, type ContestResult } from '../queue/arbitrate';
import { hashCanonical } from '../verdicts/manifest';
import {
  advanceDiagnosis, COALESCE_MS, MAX_CANDIDATES, selectStack, startDiagnosis, STACK_WIDTH,
  type Diagnosis, type PlannedEntry,
} from '../queue/plan';

type EntryState = 'admitted' | 'reserved' | 'checking' | 'landed' | 'blocked' | 'withdrawn' | 'failed';
interface Entry extends PlannedEntry {
  entryId: Id; revision: number; baseOid: string; headOid: string; storageName: string; ref: string;
  canonicalStorageName: string; scratchStorageName: string; policyId: Id; profileId: Id;
  policyDigest: Digest; profileDigest: Digest;
  authorId: Id; unitKeys: string[]; verdictId: Id; findingSetVersion: number;
  reservationFences: Record<string, number>; admittedAt: number; state: EntryState; blockedReason: string | null;
  contestId: Id | null;
}
interface JobRecord {
  job: Job; purpose: 'stack' | 'diagnostic' | 'contest' | 'promotion'; memberIds: Id[];
  admissionIds: Id[];
  contestId?: Id; result?: StackResult | PromotionResult; resultSequence?: number;
  consumed: boolean; retryOf?: Id; retryIssued?: boolean;
  verified?: boolean;
}
interface ContestState {
  contestId: Id; childIds: [Id, Id]; admissionIds: [Id, Id]; creationSequences: [number, number];
  intentKey: string; intentText: string; unitKey: string; baseOid: string; policyDigest: Digest; profileDigest: Digest;
  state: 'open' | 'selected' | 'landed' | 'blocked'; winnerId: Id | null; reason: string | null;
  resultIds: Id[];
}
interface ContestLeaseEvidence {
  contestId: Id; parentChangeId: Id; childChangeIds: [Id, Id]; selectedChangeId: Id | null; ownerCreated: true;
  closed?: boolean;
}
interface Ticket extends Promotion {
  jobId: Id; canonicalStorageName: string; scratchStorageName: string; scratchRef: string; memberIds: Id[];
  admissionIds: Id[];
  resultId: Id; createdAt: number; lastObservedOid: string | null; reconciliation: string | null;
  jobIds: Id[]; retryIssued: boolean;
}
interface BootstrapState {
  input: BootstrapHandoff; stackId: Id; createdAt: number; state: 'waiting' | 'checking' | 'blocked' | 'merged';
  blockedReason: string | null; policyDigest: Digest; profileDigest: Digest;
}
interface QueueState {
  generation: number; observedMain: string | null; entries: Entry[]; jobs: JobRecord[];
  contests: ContestState[]; ticket: Ticket | null; bootstrap: BootstrapState | null;
  activeStackJobId: Id | null; diagnosis: Diagnosis | null; diagnosticResults: Array<{
    jobId: Id; memberIds: Id[]; outcome: string; composedOid: string | null; sequence: number;
  }>;
  finalCanonicalOid: string | null; coalesceUntil: number | null; blockedReason: string | null;
}
const empty = (): QueueState => ({
  generation: 0, observedMain: null, entries: [], jobs: [], contests: [], ticket: null, bootstrap: null,
  activeStackJobId: null, diagnosis: null, diagnosticResults: [], finalCanonicalOid: null,
  coalesceUntil: null, blockedReason: null,
});
const read = (context: ModuleContext): QueueState => context.state.get<QueueState>('data') ?? empty();
const save = (context: ModuleContext, state: QueueState) => context.state.put('data', state);
const eligible = <T>(context: ModuleContext, value: T, ids: Id[] = []): Gate<T> => ({ status: 'eligible', version: context.version(), evidenceIds: ids, value });
const blocked = (context: ModuleContext, code: string, reason: string): Gate<never> => ({ status: 'blocked', version: context.version(), code, reason, evidenceIds: [] });
function requireGate<T>(gate: Gate<T>): T {
  if (gate.status === 'blocked') throw new HttpError(gate.code === 'MODULE_UNAVAILABLE' ? 501 : 409, gate.code, gate.reason);
  return gate.value;
}
const active = (entry: Entry) => ['admitted', 'reserved', 'checking'].includes(entry.state);
const current = (state: QueueState, id: Id) => [...state.entries].reverse().find(entry => entry.changeId === id && active(entry));
const admitted = (state: QueueState, id: Id) => state.entries.find(entry => entry.entryId === id);
const member = (state: QueueState, record: JobRecord, id: Id) => admitted(state, record.admissionIds[record.memberIds.indexOf(id)]);
function contestEvidence(context: ModuleContext, contest: ContestState, selectedChangeId: Id | null): void {
  const evidence: ContestLeaseEvidence = { contestId: contest.contestId, parentChangeId: contest.childIds[0],
    childChangeIds: contest.childIds, selectedChangeId, ownerCreated: true };
  context.state.put(`contest:${contest.contestId}`, evidence);
  for (const id of contest.childIds) context.state.put(`contest-child:${id}`, { contestId: contest.contestId });
}
function transition(context: ModuleContext, state: QueueState, entry: Entry, next: EntryState, reason: string | null = null): void {
  if (entry.state === next) return;
  const allowed: Record<EntryState, EntryState[]> = {
    admitted: ['reserved'],
    reserved: ['checking', 'blocked', 'withdrawn', 'failed'],
    checking: ['reserved', 'landed', 'blocked', 'withdrawn'],
    landed: [], blocked: [], withdrawn: [], failed: [],
  };
  if (!allowed[entry.state].includes(next)) throw new HttpError(409, 'INVALID_QUEUE_TRANSITION', `${entry.state} -> ${next}`);
  if (['landed', 'blocked', 'withdrawn', 'failed'].includes(next)) {
    context.transaction(() => {
      context.state.put(`entry:${entry.changeId}`, { changeId: entry.changeId,
        state: next === 'landed' ? 'merged' : 'withdrawn', entryId: entry.entryId });
      requireGate(context.call('leases.releaseReservation', entry.changeId));
      const contest = state.contests.find(item => item.contestId === entry.contestId
        && item.state === 'selected' && item.winnerId === entry.changeId);
      if (contest) {
        contest.state = next === 'landed' ? 'landed' : 'blocked';
        if (next !== 'landed') contest.reason = reason;
      }
      entry.state = next;
      entry.blockedReason = reason;
      save(context, state);
    });
    return;
  }
  entry.state = next;
  entry.blockedReason = reason;
}
const ordered = (state: QueueState) => [...state.entries].sort((a, b) => a.sequence - b.sequence);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validOid = (value: unknown): value is string => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function requiredView(context: ModuleContext, changeId: Id): ChangeView & Required<Pick<ChangeView,
  'baseOid' | 'candidateStorageName' | 'branch' | 'dependencyChangeIds' | 'canonicalStorageName' | 'scratchStorageName' | 'policyId' | 'profileId'>> {
  if (!context.readChange) throw new HttpError(501, 'MODULE_UNAVAILABLE', 'Change view unavailable');
  const value = requireGate(context.readChange(changeId));
  if (!validOid(value.headOid) || !validOid(value.baseOid) || !value.candidateStorageName || !value.branch
    || !Array.isArray(value.dependencyChangeIds) || !value.canonicalStorageName || !value.scratchStorageName
    || !value.policyId || !value.profileId) throw new HttpError(409, 'IMMUTABLE_INPUT_MISSING', 'Change view lacks immutable queue inputs');
  return value as ReturnType<typeof requiredView>;
}
function checkAdmission(context: ModuleContext, state: QueueState, changeId: Id, verdictId: Id,
  fences: Record<string, number>, main: string, contestId: Id | null): Omit<Entry, 'entryId' | 'sequence' | 'admittedAt'> {
  if (state.contests.some(contest => contest.childIds.includes(changeId) &&
    (contest.state === 'open' || contest.state === 'selected' && contest.admissionIds.some(id => {
      const entry = admitted(state, id);
      return entry?.changeId === contest.winnerId && active(entry);
    })))) throw new HttpError(409, 'CONTEST_OWNED', 'Change remains owned by an active contest');
  const view = requiredView(context, changeId);
  if (view.status !== 'ready' || view.frozen) throw new HttpError(409, 'CHANGE_NOT_READY', 'Change is not ready');
  if (state.entries.some(entry => active(entry) && entry.changeId === changeId)) throw new HttpError(409, 'ALREADY_QUEUED', 'Change already admitted');
  if (!context.principal.roles.includes('agent') && !context.principal.roles.includes('owner')) throw new HttpError(403, 'FORBIDDEN', 'Agent or owner role required');
  if (context.principal.principalId !== view.authorId && !context.principal.roles.includes('owner')) throw new HttpError(403, 'FORBIDDEN', 'Only the author or owner may enqueue');
  if (!Array.isArray(view.unitKeys) || view.unitKeys.length === 0 || new Set(view.unitKeys).size !== view.unitKeys.length
    || Object.keys(fences).length !== view.unitKeys.length
    || !view.unitKeys.every(key => Number.isSafeInteger(fences[key]) && fences[key] > 0)) {
    throw new HttpError(409, 'LEASE_COVERAGE', 'Current lease fences must cover every verified unit');
  }
  const finding = requireGate(context.call('findings.gate', changeId, view.revision));
  if (finding.unresolvedIds.length || finding.pendingRound !== null) throw new HttpError(409, 'FINDINGS_OPEN', 'Findings are unresolved');
  const verdict = requireGate(context.call('verdicts.gate', changeId, view.revision));
  if (verdict.verdictId !== verdictId || verdict.findingSetVersion !== finding.findingSetVersion) {
    throw new HttpError(409, 'VERDICT_STALE', 'Approval does not cover this finding set');
  }
  if (view.dependencyChangeIds.includes(changeId) || new Set(view.dependencyChangeIds).size !== view.dependencyChangeIds.length) {
    throw new HttpError(409, 'INVALID_DEPENDENCY', 'Invalid dependency graph');
  }
  for (const dependency of view.dependencyChangeIds) {
    if (!state.entries.some(entry => entry.changeId === dependency && ['reserved', 'checking', 'landed'].includes(entry.state))) {
      throw new HttpError(409, 'DEPENDENCY_UNAVAILABLE', 'Prerequisite is not admitted or merged');
    }
  }
  if (view.baseOid !== main && !view.dependencyChangeIds.some(id => state.entries.some(entry =>
    entry.changeId === id && ['reserved', 'checking'].includes(entry.state) && entry.headOid === view.baseOid))) {
    throw new HttpError(409, 'STALE_BASE', 'Candidate base is neither canonical main nor an admitted prerequisite head');
  }
  const { policy, profile } = policyAndProfile(context, view.policyId, view.profileId);
  return {
    changeId, revision: view.revision, baseOid: view.baseOid!, headOid: view.headOid!,
    storageName: view.candidateStorageName, ref: view.branch, canonicalStorageName: view.canonicalStorageName,
    scratchStorageName: view.scratchStorageName, policyId: view.policyId, profileId: view.profileId,
    policyDigest: policy.digest, profileDigest: profile.digest,
    dependencyChangeIds: [...view.dependencyChangeIds], authorId: view.authorId, unitKeys: [...view.unitKeys],
    verdictId, findingSetVersion: finding.findingSetVersion, reservationFences: { ...fences },
    state: 'admitted', blockedReason: null, contestId,
  };
}
function admissionStillValid(context: ModuleContext, entry: Entry): boolean {
  try {
    requireGate(context.call('leases.reservationLive', entry.changeId, entry.reservationFences));
    const view = requiredView(context, entry.changeId);
    if (view.revision !== entry.revision || view.headOid !== entry.headOid || view.baseOid !== entry.baseOid
      || !['ready', 'queued', 'checking'].includes(view.status)
      || view.frozen || view.candidateStorageName !== entry.storageName || view.branch !== entry.ref
      || view.canonicalStorageName !== entry.canonicalStorageName || view.scratchStorageName !== entry.scratchStorageName
      || view.policyId !== entry.policyId || view.profileId !== entry.profileId
      || context.trusted.policies[entry.policyId]?.digest !== entry.policyDigest
      || context.trusted.profiles[entry.profileId]?.digest !== entry.profileDigest
      || view.dependencyChangeIds.length !== entry.dependencyChangeIds.length
      || view.dependencyChangeIds.some((id, index) => id !== entry.dependencyChangeIds[index])) return false;
    const findings = requireGate(context.call('findings.gate', entry.changeId, entry.revision));
    const verdict = requireGate(context.call('verdicts.gate', entry.changeId, entry.revision));
    return findings.unresolvedIds.length === 0 && findings.pendingRound === null
      && findings.findingSetVersion === entry.findingSetVersion
      && verdict.verdictId === entry.verdictId && verdict.findingSetVersion === entry.findingSetVersion;
  } catch { return false; }
}
function bump(context: ModuleContext, state: QueueState, reason: string, ids: Id[]): void {
  state.generation++;
  state.activeStackJobId = null;
  state.diagnosis = null;
  state.coalesceUntil = context.now() + COALESCE_MS;
  const version = context.nextVersion();
  context.appendEvent('queue.generation', ids, { generation: state.generation, reason }, version);
}
function admissionSnapshot(entry: Entry): FrozenAdmission {
  return { changeId: entry.changeId, admissionId: entry.entryId, revision: entry.revision, verdictId: entry.verdictId,
    findingSetVersion: entry.findingSetVersion, reservationFences: { ...entry.reservationFences },
    baseOid: entry.baseOid, headOid: entry.headOid,
    policyDigest: entry.policyDigest, profileDigest: entry.profileDigest };
}
function policyAndProfile(context: ModuleContext, policyId: Id, profileId: Id) {
  const policy = context.trusted.policies[policyId];
  const profile = context.trusted.profiles[profileId];
  if (!policy || !profile) throw new HttpError(409, 'PROFILE_UNAVAILABLE', 'Trusted policy or profile unavailable');
  return { policy, profile };
}
async function makeStackJob(context: ModuleContext, state: QueueState, memberIds: Id[], bootstrap: boolean): Promise<ValidateStackJob> {
  const entries = memberIds.map(id => current(state, id)!);
  const seed = state.bootstrap?.input;
  const first = entries[0] ?? current(state, state.diagnosis?.original[0] ?? '');
  const canonicalName = bootstrap ? seed!.canonicalStorageName : first?.canonicalStorageName;
  const scratchName = bootstrap ? seed!.scratchStorageName : first?.scratchStorageName;
  const policyId = bootstrap ? seed!.policyId : first?.policyId;
  const profileId = bootstrap ? seed!.profileId : first?.profileId;
  if (!canonicalName || !scratchName || !policyId || !profileId) throw new HttpError(409, 'IMMUTABLE_INPUT_MISSING', 'Stack inputs unavailable');
  const { policy, profile } = policyAndProfile(context, policyId, profileId);
  if (bootstrap && (state.bootstrap?.policyDigest !== policy.digest || state.bootstrap.profileDigest !== profile.digest)) {
    throw new HttpError(409, 'PROFILE_CHANGED', 'Bootstrap policy or profile changed');
  }
  if (entries.some(entry => entry.policyId !== policyId || entry.profileId !== profileId
    || entry.policyDigest !== policy.digest || entry.profileDigest !== profile.digest
    || entry.canonicalStorageName !== canonicalName || entry.scratchStorageName !== scratchName)) {
    throw new HttpError(409, 'NON_COMPARABLE_PROFILE', 'Stack candidates have different policy or profile');
  }
  const names = [...new Set([canonicalName, scratchName, ...entries.map(entry => entry.storageName), ...(bootstrap ? [seed!.seedStorageName] : [])])];
  const infos = await Promise.all(names.map(name => context.storage.info(name)));
  if (infos.some(info => !info || info.status !== 'ready')) throw new HttpError(503, 'STORAGE_UNAVAILABLE', 'Stack repository unavailable');
  const remotes = Object.fromEntries(names.map((name, i) => [name, infos[i]!.remote]));
  const candidates: CandidateInput[] = entries.map(entry => ({ changeId: entry.changeId, revision: entry.revision,
    baseOid: entry.baseOid, headOid: entry.headOid, storageName: entry.storageName, ref: entry.ref }));
  const stackId = bootstrap ? state.bootstrap!.stackId : crypto.randomUUID();
  const scratchRef = `refs/heads/queue-${stackId}`;
  const base = {
    kind: 'validate-stack' as const, version: 1, jobId: crypto.randomUUID(), repoId: context.repoId,
    generation: state.generation, profileDigest: profile.digest, policyId, policyDigest: policy.digest,
    unitPolicy: policy, expectedRefs: Object.fromEntries([
      [canonicalName + ':refs/heads/main', state.observedMain],
      ...entries.map(entry => [entry.storageName + ':' + entry.ref, entry.headOid] as const),
      ...(bootstrap ? [[seed!.seedStorageName + ':' + seed!.seedRef, seed!.headOid] as const] : []),
    ]), storageRemotes: remotes, checkerId: policy.checkerId, checkerDigest: policy.checkerDigest,
    oracleDigest: profile.oracleDigest, toolchainDigest: profile.toolchainDigest,
    environmentDigest: profile.environmentDigest, timeoutMs: profile.timeoutMs,
    maxOutputBytes: profile.maxOutputBytes, state: 'pending' as const, attempt: 0, runnerId: null,
    fence: 0, expiresAt: null, stackId, scratchStorageName: scratchName, scratchRef,
  };
  const immutable = bootstrap
    ? { ...base, bootstrap: true as const, ownerAuthorized: true as const, canonicalBaseOid: null,
      candidates: [{ changeId: `seed-${stackId}`, revision: 1, baseOid: null, headOid: seed!.headOid,
        seedStorageName: seed!.seedStorageName, seedRef: seed!.seedRef }] as [SeedInput] }
    : { ...base, bootstrap: false as const, canonicalBaseOid: state.observedMain!, candidates };
  const { jobId: _jobId, version: _version, state: _state, attempt: _attempt,
    runnerId: _runnerId, fence: _fence, expiresAt: _expiresAt, ...input } = immutable;
  const inputDigest = await digest(input);
  return { ...immutable, inputDigest } as ValidateStackJob;
}
function schedule(context: ModuleContext, state: QueueState, job: Job, purpose: JobRecord['purpose'], memberIds: Id[], contestId?: Id): JobRecord {
  const entries = memberIds.map(id => current(state, id));
  if (entries.some(entry => !entry || !['reserved', 'checking'].includes(entry.state))) {
    throw new HttpError(409, 'ADMISSION_UNAVAILABLE', 'Scheduled member has no active reservation');
  }
  for (const entry of entries) requireGate(context.call('leases.reservationLive', entry!.changeId, entry!.reservationFences));
  if (contestId) {
    const contest = state.contests.find(item => item.contestId === contestId && item.state === 'open');
    if (!contest || entries.some(entry => !contest.admissionIds.includes(entry!.entryId))) {
      throw new HttpError(409, 'CONTEST_CLOSED', 'Contest admission is no longer active');
    }
  }
  requireGate(context.call('runners.schedule', job));
  const record: JobRecord = { job, purpose, memberIds: [...memberIds],
    admissionIds: entries.map(entry => entry!.entryId), contestId, consumed: false };
  state.jobs.push(record);
  if (purpose === 'stack' || purpose === 'diagnostic') state.activeStackJobId = job.jobId;
  const version = context.nextVersion();
  context.appendEvent('queue.job_scheduled', memberIds, { jobId: job.jobId, kind: job.kind, purpose,
    generation: state.generation, subset: memberIds }, version);
  return record;
}

function emit(context: ModuleContext, kind: string, ids: Id[], payload: Record<string, unknown>): number {
  const version = context.nextVersion();
  return context.appendEvent(kind, ids, payload, version).sequence;
}
function invalidate(context: ModuleContext, state: QueueState, reason: string, ids: Id[]): void {
  for (const entry of state.entries) if (entry.state === 'checking') transition(context, state, entry, 'reserved');
  bump(context, state, reason, ids);
}
function blockEntry(context: ModuleContext, state: QueueState, entry: Entry, reason: string): void {
  const contest = state.contests.find(item => item.contestId === entry.contestId && item.state === 'open');
  if (contest) {
    closeContest(context, state, contest, reason);
    invalidate(context, state, reason, contest.childIds);
    return;
  }
  transition(context, state, entry, 'blocked', reason);
  emit(context, 'queue.entry_blocked', [entry.changeId], { reason, confidence: 'none' });
  invalidate(context, state, reason, [entry.changeId]);
}
function closeContest(context: ModuleContext, state: QueueState, contest: ContestState, reason: string): void {
  contest.state = 'blocked'; contest.reason = reason;
  contestEvidence(context, contest, contest.childIds[0]);
  for (const id of contest.admissionIds) {
    const entry = admitted(state, id);
    if (entry && active(entry)) transition(context, state, entry, 'blocked', reason);
  }
}
async function enqueue(context: ModuleContext, body: Record<string, unknown>): Promise<Response> {
  if (!validId(body.changeId)) throw new HttpError(400, 'INVALID_ENQUEUE', 'Change ID is required');
  const available = context.readChange?.(body.changeId);
  if (!available || available.status === 'blocked' && available.code === 'MODULE_UNAVAILABLE') {
    return failure(new HttpError(501, 'MODULE_UNAVAILABLE', 'Repos change view unavailable'));
  }
  if (!validId(body.verdictId) || !body.leaseFences
    || typeof body.leaseFences !== 'object' || Array.isArray(body.leaseFences)) {
    throw new HttpError(400, 'INVALID_ENQUEUE', 'Change, verdict, and lease fences are required');
  }
  const changeId = body.changeId;
  const view = requiredView(context, changeId);
  const main = await context.storage.resolveRef(view.canonicalStorageName, 'refs/heads/main');
  if (!main) throw new HttpError(409, 'BOOTSTRAP_REQUIRED', 'Canonical main is absent');
  return context.transaction(() => {
    const state = read(context);
    if (state.ticket && ['pending', 'reconcile'].includes(state.ticket.state)) throw new HttpError(409, 'PROMOTION_IN_PROGRESS', 'Promotion is pending');
    if (state.entries.filter(active).length >= MAX_CANDIDATES) throw new HttpError(429, 'QUEUE_FULL', 'Eight active candidates are allowed');
    if (state.observedMain !== null && state.observedMain !== main) invalidate(context, state, 'MAIN_CHANGED', []);
    state.observedMain = main;
    const checked = checkAdmission(context, state, changeId, body.verdictId as Id, body.leaseFences as Record<string, number>, main, null);
    context.state.delete(`contest-child:${changeId}`);
    const reservation = requireGate(context.call('leases.reserve', changeId, checked.reservationFences));
    if (Object.keys(reservation.reservationFences).length !== checked.unitKeys.length
      || !checked.unitKeys.every(key => reservation.reservationFences[key] === checked.reservationFences[key])) {
      throw new HttpError(409, 'LEASE_FENCE_CHANGED', 'Reservation fences differ from admission');
    }
    const sequence = emit(context, 'queue.enqueued', [changeId], { revision: checked.revision, headOid: checked.headOid,
      verdictId: checked.verdictId, findingSetVersion: checked.findingSetVersion });
    const entry: Entry = { ...checked, entryId: crypto.randomUUID(), sequence, admittedAt: context.now() };
    transition(context, state, entry, 'reserved');
    state.entries.push(entry);
    bump(context, state, 'ADMITTED', [changeId]);
    const waiting = ordered(state).filter(item => item.state === 'reserved');
    const first = waiting[0];
    if (first) {
      const cohort = waiting.filter(item => item.policyId === first.policyId && item.profileId === first.profileId
        && item.canonicalStorageName === first.canonicalStorageName && item.scratchStorageName === first.scratchStorageName);
      const available = new Set(state.entries.filter(item => item.state === 'landed').map(item => item.changeId));
      if (selectStack(cohort, available, STACK_WIDTH).length === STACK_WIDTH) state.coalesceUntil = context.now();
    }
    save(context, state);
    return json(entry, context.version(), eventSequence(context.sql), 201);
  });
}

function queueProjection(state: QueueState) {
  const activeRecord = state.jobs.find(record => record.job.jobId === state.activeStackJobId);
  const stackIds = activeRecord?.memberIds ?? state.ticket?.memberIds ?? [];
  const stackAdmissionIds = activeRecord?.admissionIds ?? state.ticket?.admissionIds ?? [];
  return {
    generation: state.generation, observedMain: state.observedMain,
    entries: ordered(state).map(entry => ({ ...entry, stackMember: stackAdmissionIds.includes(entry.entryId) })),
    contests: state.contests, promotion: state.ticket, bootstrap: state.bootstrap,
    activeStackJobId: state.activeStackJobId, stackMembers: stackIds, diagnosis: state.diagnosis,
    blameConfidence: state.diagnosis?.reason === 'SINGLETON' ? 'reproduced-singleton'
      : state.diagnosis?.reason ? 'group-only' : null,
    diagnosticResults: state.diagnosticResults, finalCanonicalOid: state.finalCanonicalOid,
    blockedReason: state.blockedReason,
  };
}

function withdraw(context: ModuleContext, body: Record<string, unknown>): Response {
  if (!validId(body.changeId) || typeof body.reason !== 'string' || !body.reason.trim()) throw new HttpError(400, 'INVALID_WITHDRAW', 'Change and reason required');
  return context.transaction(() => {
    const state = read(context);
    const entry = current(state, body.changeId as Id);
    if (!entry) throw new HttpError(404, 'QUEUE_ENTRY_NOT_FOUND', 'No active entry');
    if (entry.authorId !== context.principal.principalId && !context.principal.roles.includes('owner')) throw new HttpError(403, 'FORBIDDEN', 'Only the author or owner may withdraw');
    if (entry.contestId) {
      const contest = state.contests.find(item => item.contestId === entry.contestId && item.state === 'open');
      if (contest) {
        contest.state = 'blocked'; contest.reason = 'CHILD_WITHDRAWN';
        contestEvidence(context, contest, entry.changeId);
      }
    }
    transition(context, state, entry, 'withdrawn', body.reason as string);
    if (entry.contestId) {
      const contest = state.contests.find(item => item.contestId === entry.contestId && item.reason === 'CHILD_WITHDRAWN');
      if (contest) {
        for (const id of contest.admissionIds) {
          const sibling = admitted(state, id);
          if (sibling && active(sibling)) transition(context, state, sibling, 'blocked', 'CHILD_WITHDRAWN');
        }
      }
    }
    emit(context, 'queue.withdrawn', [entry.changeId], { reason: body.reason });
    bump(context, state, 'WITHDRAWN', [entry.changeId]);
    save(context, state);
    return json(entry, context.version(), eventSequence(context.sql));
  });
}

async function createContest(context: ModuleContext, body: Record<string, unknown>): Promise<Response> {
  if (!context.principal.roles.includes('owner')) throw new HttpError(403, 'FORBIDDEN', 'Only an owner may create a contest');
  const children = body.childChangeIds;
  const verdicts = body.verdictIds;
  const fences = body.leaseFences;
  if (!Array.isArray(children) || children.length !== 2 || !children.every(validId) || children[0] === children[1]
    || !Array.isArray(verdicts) || verdicts.length !== 2 || !verdicts.every(validId)
    || !Array.isArray(fences) || fences.length !== 2 || !fences.every(value => value && typeof value === 'object' && !Array.isArray(value))
    || typeof body.intentKey !== 'string' || !body.intentKey.trim()
    || typeof body.intentText !== 'string' || !body.intentText.trim()
    || typeof body.unitKey !== 'string' || !body.unitKey.trim() || !validOid(body.baseOid)
    || !validId(body.profileId)) throw new HttpError(400, 'INVALID_CONTEST', 'Two children with verdicts and fences are required');
  const views = children.map(id => requiredView(context, id));
  if (!views.every(view => view.baseOid === body.baseOid && view.profileId === body.profileId
    && view.intentKey === body.intentKey && view.unitKeys.includes(body.unitKey as string))) {
    throw new HttpError(409, 'NON_COMPARABLE_CONTEST', 'Children must share intent, base, unit, and profile');
  }
  const main = await context.storage.resolveRef(views[0].canonicalStorageName, 'refs/heads/main');
  if (!main || main !== body.baseOid) throw new HttpError(409, 'STALE_MAIN', 'Contest base is not canonical main');
  return context.transaction(() => {
    const state = read(context);
    if (state.entries.filter(active).length + 2 > MAX_CANDIDATES) throw new HttpError(429, 'QUEUE_FULL', 'Eight active candidates are allowed');
    if (state.ticket && ['pending', 'reconcile'].includes(state.ticket.state)) throw new HttpError(409, 'PROMOTION_IN_PROGRESS', 'Promotion is pending');
    if (state.observedMain !== null && state.observedMain !== main) invalidate(context, state, 'MAIN_CHANGED', []);
    state.observedMain = main;
    const contestId = crypto.randomUUID();
    const prepared = children.map((id, i) => checkAdmission(context, state, id, verdicts[i], fences[i] as Record<string, number>, main, contestId));
    if (prepared[0].policyId !== prepared[1].policyId || prepared[0].canonicalStorageName !== prepared[1].canonicalStorageName
      || prepared[0].scratchStorageName !== prepared[1].scratchStorageName) throw new HttpError(409, 'NON_COMPARABLE_PROFILE', 'Contest policy or storage differs');
    const firstFences = prepared[0].reservationFences;
    const secondFences = prepared[1].reservationFences;
    if (Object.keys(firstFences).length !== Object.keys(secondFences).length ||
      Object.entries(firstFences).some(([key, fence]) => secondFences[key] !== fence)) {
      throw new HttpError(409, 'LEASE_COVERAGE', 'Contest children must share the same fenced units');
    }
    const parentReservation = requireGate(context.call('leases.reserve', children[0], prepared[0].reservationFences));
    if (!prepared[0].unitKeys.every(key => parentReservation.reservationFences[key] === prepared[0].reservationFences[key])) {
      throw new HttpError(409, 'LEASE_FENCE_CHANGED', 'Contest parent reservation differs');
    }
    const contest: ContestState = { contestId, childIds: [children[0], children[1]], admissionIds: ['', ''], creationSequences: [0, 0],
      intentKey: body.intentKey as string, intentText: body.intentText as string, unitKey: body.unitKey as string,
      baseOid: main, policyDigest: prepared[0].policyDigest, profileDigest: prepared[0].profileDigest,
      state: 'open', winnerId: null, reason: null, resultIds: [] };
    contestEvidence(context, contest, null);
    const creationSequences: [number, number] = [0, 0];
    const admissionIds: [Id, Id] = ['', ''];
    prepared.forEach((candidate, i) => {
      const sequence = emit(context, 'queue.contest_child', [candidate.changeId, contestId], { headOid: candidate.headOid });
      creationSequences[i] = sequence;
      const entry: Entry = { ...candidate, entryId: crypto.randomUUID(), sequence, admittedAt: context.now() };
      transition(context, state, entry, 'reserved');
      admissionIds[i] = entry.entryId;
      state.entries.push(entry);
    });
    state.contests.push({ contestId, childIds: [children[0], children[1]], admissionIds, creationSequences,
      intentKey: body.intentKey as string, intentText: body.intentText as string,
      unitKey: body.unitKey as string, baseOid: main,
      policyDigest: prepared[0].policyDigest, profileDigest: prepared[0].profileDigest,
      state: 'open', winnerId: null, reason: null, resultIds: [] });
    bump(context, state, 'CONTEST_CREATED', children);
    save(context, state);
    return json(state.contests[state.contests.length - 1], context.version(), eventSequence(context.sql), 201);
  });
}

/** Repos calls this only after its authenticated owner-only bootstrap request validates the seed. */
function bootstrapHandoff(context: ModuleContext, input: BootstrapHandoff): Gate<{ stackId: Id }> {
  if (!context.principal.roles.includes('owner')) return blocked(context, 'FORBIDDEN', 'Owner authorization required');
  if (!validOid(input.headOid) || !input.seedStorageName || !input.seedRef || !input.canonicalStorageName
    || !input.scratchStorageName || !context.trusted.policies[input.policyId] || !context.trusted.profiles[input.profileId]) {
    return blocked(context, 'INVALID_BOOTSTRAP', 'Validated seed inputs required');
  }
  return context.transaction(() => {
    const state = read(context);
    if (state.observedMain !== null || state.finalCanonicalOid !== null || state.bootstrap || state.ticket
      || state.entries.some(active)) return blocked(context, 'BOOTSTRAP_CONFLICT', 'Canonical repository is already initialized or initialization is pending');
    const stackId = crypto.randomUUID();
    state.bootstrap = { input: { ...input }, stackId, createdAt: context.now(), state: 'waiting', blockedReason: null,
      policyDigest: context.trusted.policies[input.policyId].digest,
      profileDigest: context.trusted.profiles[input.profileId].digest };
    bump(context, state, 'BOOTSTRAP_REQUESTED', [stackId]);
    save(context, state);
    return eligible(context, { stackId }, [stackId]);
  });
}

function onResult(context: ModuleContext, result: StackResult | PromotionResult): Gate<{ promotionId: Id | null }> {
  if (!result) return { status: 'blocked', version: 0, code: 'MODULE_UNAVAILABLE',
    reason: 'No scheduled result', evidenceIds: [] };
  if (result.kind === 'validate-stack' && !context.principal.roles.includes('checker')
    || result.kind === 'promote' && !context.principal.roles.includes('promoter')) {
    return blocked(context, 'FORBIDDEN', 'Trusted runner role required');
  }
  return context.transaction(() => {
    const state = read(context);
    const record = state.jobs.find(item => item.job.jobId === result.jobId);
    if (!record || record.job.kind !== result.kind || record.job.inputDigest !== result.inputDigest
      || record.job.checkerDigest !== result.checkerDigest || record.job.toolchainDigest !== result.toolchainDigest
      || record.job.oracleDigest !== result.oracleDigest || record.job.environmentDigest !== result.environmentDigest
      || !Number.isSafeInteger(result.attempt) || result.attempt < 1
      || !Number.isSafeInteger(result.fence) || result.fence < 1) return blocked(context, 'STALE_JOB_RESULT', 'Result does not match a scheduled job');
    if (record.job.generation !== state.generation && record.purpose !== 'promotion') return blocked(context, 'STALE_GENERATION', 'Queue generation has changed');
    if (result.kind === 'validate-stack' && (record.job.kind !== 'validate-stack'
      || result.bootstrap !== record.job.bootstrap || result.canonicalBaseOid !== record.job.canonicalBaseOid)) {
      return blocked(context, 'STALE_JOB_RESULT', 'Result base differs from scheduled job');
    }
    const { resultDigest, ...preimage } = result;
    if (hashCanonical(preimage) !== resultDigest) {
      state.blockedReason = 'RESULT_DIGEST_MISMATCH';
      emit(context, 'queue.result_rejected', record.memberIds, { jobId: result.jobId, reason: state.blockedReason });
      if (record.purpose !== 'promotion') failRecord(context, state, record, 'RESULT_DIGEST_MISMATCH');
      save(context, state);
      return blocked(context, 'RESULT_DIGEST_MISMATCH', 'Result digest does not match its contents');
    }
    if (record.result) return record.result.resultDigest === result.resultDigest
      ? eligible(context, { promotionId: state.ticket?.promotionId ?? null }, [result.jobId])
      : blocked(context, 'CONFLICTING_RESULT', 'Result digest differs from recorded result');
    record.result = result;
    record.resultSequence = emit(context, 'queue.result_received', record.memberIds, { jobId: result.jobId,
      outcome: result.outcome, purpose: record.purpose, generation: record.job.generation });
    save(context, state);
    return eligible(context, { promotionId: state.ticket?.promotionId ?? null }, [result.jobId]);
  });
}

async function validResultDigest(result: StackResult | PromotionResult): Promise<boolean> {
  const { resultDigest, ...preimage } = result;
  return await digest(preimage) === resultDigest;
}
async function checkedScratch(context: ModuleContext, record: JobRecord, result: StackResult): Promise<boolean> {
  if (record.job.kind !== 'validate-stack' || !result.composedOid || !result.composedTreeOid
    || result.sourceTreeOid !== result.composedTreeOid) return false;
  const observed = await context.storage.resolveRef(record.job.scratchStorageName, record.job.scratchRef);
  if (observed !== result.composedOid) return false;
  const commit = await context.storage.readCommit(record.job.scratchStorageName, result.composedOid);
  return commit?.oid === result.composedOid && commit.treeOid === result.composedTreeOid;
}
function resultPolicy(_context: ModuleContext, record: JobRecord) {
  return record.job.unitPolicy.digest === record.job.policyDigest ? record.job.unitPolicy : null;
}
function failRecord(context: ModuleContext, state: QueueState, record: JobRecord, reason: string): void {
  if (record.job.generation !== state.generation || record.purpose === 'promotion') return;
  const contest = record.contestId ? state.contests.find(item => item.contestId === record.contestId && item.state === 'open') : undefined;
  if (record.purpose === 'contest' && !contest) return;
  if (contest) contestEvidence(context, contest, contest.childIds[0]);
  if (contest) { contest.state = 'blocked'; contest.reason = reason; }
  const ids = contest?.admissionIds ?? (record.purpose === 'diagnostic' && state.diagnosis
    ? state.diagnosis.admissionIds ?? record.admissionIds : record.admissionIds);
  for (const id of ids) { const entry = admitted(state, id); if (entry && active(entry)) transition(context, state, entry, 'blocked', reason); }
  state.activeStackJobId = null;
}
async function makePromotionJob(context: ModuleContext, state: QueueState, checked: JobRecord, result: StackResult, promotionId: Id): Promise<Job> {
  const job = checked.job;
  if (job.kind !== 'validate-stack' || !result.composedOid) throw new HttpError(409, 'INVALID_PROMOTION', 'Checked stack unavailable');
  const canonicalName = job.bootstrap ? state.bootstrap!.input.canonicalStorageName
    : member(state, checked, checked.memberIds[0])!.canonicalStorageName;
  const immutable = {
    kind: 'promote' as const, version: 1, jobId: crypto.randomUUID(), repoId: context.repoId,
    generation: state.generation, profileDigest: job.profileDigest, policyId: job.policyId,
    policyDigest: job.policyDigest, unitPolicy: job.unitPolicy,
    expectedRefs: {
      [job.scratchStorageName + ':' + job.scratchRef]: result.composedOid,
      [canonicalName + ':refs/heads/main']: state.observedMain,
    }, storageRemotes: job.storageRemotes, checkerId: job.checkerId, checkerDigest: job.checkerDigest,
    oracleDigest: job.oracleDigest, toolchainDigest: job.toolchainDigest,
    environmentDigest: job.environmentDigest, timeoutMs: job.timeoutMs, maxOutputBytes: job.maxOutputBytes,
    state: 'pending' as const, attempt: 0, runnerId: null, fence: 0, expiresAt: null,
    promotionId, expectedOldOid: state.observedMain, checkedNewOid: result.composedOid,
    bootstrap: job.bootstrap, ...(job.bootstrap ? { ownerAuthorized: true as const } : {}),
    scratchStorageName: job.scratchStorageName, scratchRef: job.scratchRef,
  };
  const { jobId: _jobId, version: _version, state: _state, attempt: _attempt,
    runnerId: _runnerId, fence: _fence, expiresAt: _expiresAt, ...input } = immutable;
  return { ...immutable, inputDigest: await digest(input) } as Job;
}
async function createTicket(context: ModuleContext, state: QueueState, record: JobRecord, result: StackResult,
  main: string | null): Promise<void> {
  if (state.ticket && ['pending', 'reconcile'].includes(state.ticket.state)) return;
  if (record.job.kind !== 'validate-stack' || record.job.generation !== state.generation
    || record.job.canonicalBaseOid !== main || result.canonicalBaseOid !== main) return;
  if (!await checkedScratch(context, record, result)) {
    state.blockedReason = 'CHECKED_SCRATCH_MISMATCH';
    emit(context, 'queue.blocked', record.memberIds, { reason: state.blockedReason });
    failRecord(context, state, record, 'CHECKED_SCRATCH_MISMATCH');
    return;
  }
  if (!record.job.bootstrap && !record.memberIds.every(id => {
    const entry = member(state, record, id);
    return entry && ['reserved', 'checking'].includes(entry.state) && admissionStillValid(context, entry);
  })) {
    invalidate(context, state, 'ELIGIBILITY_CHANGED', record.memberIds);
    return;
  }
  if (record.job.bootstrap && (main !== null || state.bootstrap?.state !== 'checking')) {
    state.blockedReason = 'BOOTSTRAP_CONFLICT';
    return;
  }
  if (record.job.bootstrap && (state.bootstrap?.policyDigest !== record.job.policyDigest
    || state.bootstrap.profileDigest !== record.job.profileDigest)) {
    state.blockedReason = 'PROFILE_CHANGED';
    return;
  }
  const promotionId = crypto.randomUUID();
  const promote = await makePromotionJob(context, state, record, result, promotionId);
  const checkedJob = record.job;
  const memberIds = [...record.memberIds];
  context.transaction(() => {
    // The coordinator alarm is exclusive with HTTP mutations. Recheck the authoritative gates before freezing.
    if (!checkedJob.bootstrap && !memberIds.every(id => {
      const entry = member(state, record, id);
      return entry && ['reserved', 'checking'].includes(entry.state) && admissionStillValid(context, entry);
    })) throw new HttpError(409, 'ELIGIBILITY_CHANGED', 'Admission changed before promotion freeze');
    schedule(context, state, promote, 'promotion', memberIds);
    state.ticket = {
      version: 1, promotionId, expectedOldOid: main, checkedNewOid: result.composedOid!,
      bootstrap: checkedJob.bootstrap, queueGeneration: state.generation,
      frozenAdmission: memberIds.map(id => admissionSnapshot(member(state, record, id)!)),
      state: 'pending', jobId: promote.jobId,
      canonicalStorageName: checkedJob.bootstrap ? state.bootstrap!.input.canonicalStorageName
        : member(state, record, memberIds[0])!.canonicalStorageName,
      scratchStorageName: checkedJob.scratchStorageName,
      scratchRef: checkedJob.scratchRef, memberIds, admissionIds: [...record.admissionIds], resultId: result.jobId, createdAt: context.now(),
      lastObservedOid: main, reconciliation: null, jobIds: [promote.jobId], retryIssued: false,
    };
    state.blockedReason = null;
    emit(context, 'queue.promotion_ticket', memberIds, { promotionId, expectedOldOid: main,
      checkedNewOid: result.composedOid, bootstrap: checkedJob.bootstrap, frozenAdmission: state.ticket.frozenAdmission });
    save(context, state);
  });
}
function finishDiagnosis(context: ModuleContext, state: QueueState, record: JobRecord, result: StackResult): Promise<void> | void {
  const diagnosis = state.diagnosis;
  if (!diagnosis || diagnosis.phase !== 'done' || !diagnosis.reason) return;
  const reason = diagnosis.reason;
  state.blockedReason = reason === 'SINGLETON' && diagnosis.survivors.length > 0 ? null : reason;
  emit(context, 'queue.diagnosis', diagnosis.original, { reason, blame: diagnosis.blame,
    confidence: reason === 'SINGLETON' ? 'reproduced-singleton' : 'group-only',
    diagnosticJobs: diagnosis.jobs, survivors: diagnosis.survivors });
  for (const [index, id] of diagnosis.original.entries()) {
    const entry = admitted(state, diagnosis.admissionIds?.[index] ?? '');
    if (entry && active(entry) && (reason !== 'SINGLETON' || diagnosis.blame.includes(id) || diagnosis.survivors.length === 0)) {
      transition(context, state, entry, 'blocked', reason);
    }
  }
  if (reason !== 'SINGLETON' || diagnosis.survivors.length === 0) return;
  if (record.memberIds.length !== diagnosis.survivors.length
    || !record.memberIds.every(id => diagnosis.survivors.includes(id))) {
    state.blockedReason = 'DEPENDENCY_GROUP';
    for (const id of diagnosis.survivors) { const entry = admitted(state, diagnosis.admissionIds?.[diagnosis.original.indexOf(id)] ?? ''); if (entry && active(entry)) transition(context, state, entry, 'blocked', 'DEPENDENCY_GROUP'); }
    return;
  }
  if (!diagnosis.survivors.every(id => { const entry = member(state, record, id); return entry && admissionStillValid(context, entry); })) {
    for (const id of diagnosis.survivors) { const entry = admitted(state, diagnosis.admissionIds?.[diagnosis.original.indexOf(id)] ?? ''); if (entry && active(entry)) transition(context, state, entry, 'blocked', 'ELIGIBILITY_CHANGED'); }
    return;
  }
  return createTicket(context, state, record, result, state.observedMain).then(() => {
    if (!state.ticket || !['pending', 'reconcile'].includes(state.ticket.state)) {
      for (const id of diagnosis.survivors) { const entry = admitted(state, diagnosis.admissionIds?.[diagnosis.original.indexOf(id)] ?? ''); if (entry && active(entry)) transition(context, state, entry, 'blocked', state.blockedReason ?? 'TICKET_UNAVAILABLE'); }
    }
  });
}
async function processStackResult(context: ModuleContext, state: QueueState, record: JobRecord, result: StackResult, main: string | null): Promise<void> {
  if (record.job.kind !== 'validate-stack' || record.job.generation !== state.generation || record.job.canonicalBaseOid !== main) return;
  if (!record.job.bootstrap && !record.memberIds.every(id => {
    const entry = member(state, record, id);
    return entry && active(entry) && admissionStillValid(context, entry);
  })) {
    invalidate(context, state, 'ELIGIBILITY_CHANGED', record.memberIds);
    return;
  }
  const policy = resultPolicy(context, record);
  if (!policy) { state.blockedReason = 'PROFILE_UNAVAILABLE'; failRecord(context, state, record, 'PROFILE_UNAVAILABLE'); return; }
  const green = accepted(result, policy.acceptance);
  if (green && !await checkedScratch(context, record, result)) {
    state.blockedReason = 'CHECKED_SCRATCH_MISMATCH';
    emit(context, 'queue.blocked', record.memberIds, { reason: state.blockedReason });
    failRecord(context, state, record, 'CHECKED_SCRATCH_MISMATCH');
    return;
  }
  record.verified = true;
  if (record.purpose === 'contest') {
    await processContestResult(context, state, record, result, main);
    return;
  }
  if (record.purpose === 'stack') {
    state.activeStackJobId = null;
    if (green) { await createTicket(context, state, record, result, main); return; }
    if (record.job.bootstrap) {
      state.bootstrap!.state = 'blocked'; state.bootstrap!.blockedReason = result.outcome;
      state.blockedReason = 'BOOTSTRAP_CHECK_FAILED';
      emit(context, 'queue.bootstrap_blocked', [state.bootstrap!.stackId], { reason: result.outcome });
      return;
    }
    const started = startDiagnosis(record.memberIds);
    state.diagnosis = { ...started.diagnosis, admissionIds: [...record.admissionIds] };
    emit(context, 'queue.diagnosis_started', record.memberIds, { outcome: result.outcome, next: started.next });
    await scheduleDiagnostic(context, state, started.next!);
    return;
  }
  if (record.purpose === 'diagnostic') {
    state.activeStackJobId = null;
    state.diagnosticResults.push({ jobId: result.jobId, memberIds: record.memberIds,
      outcome: result.outcome, composedOid: result.composedOid, sequence: record.resultSequence! });
    emit(context, 'queue.diagnostic_result', record.memberIds, { jobId: result.jobId, outcome: result.outcome,
      subset: record.memberIds, confidence: 'observation' });
    const next = advanceDiagnosis(state.diagnosis!, green, ordered(state));
    state.diagnosis = next.diagnosis;
    if (next.next !== null) await scheduleDiagnostic(context, state, next.next);
    else await finishDiagnosis(context, state, record, result);
  }
}
async function scheduleDiagnostic(context: ModuleContext, state: QueueState, ids: Id[]): Promise<void> {
  const job = await makeStackJob(context, state, ids, false);
  context.transaction(() => { schedule(context, state, job, 'diagnostic', ids); save(context, state); });
}

async function processContestResult(context: ModuleContext, state: QueueState, record: JobRecord, _result: StackResult, _main: string | null): Promise<void> {
  const contest = state.contests.find(item => item.contestId === record.contestId);
  if (!contest || contest.state !== 'open') return;
  if (contest.admissionIds.some(id => { const entry = admitted(state, id); return !entry || entry.state !== 'reserved' || !admissionStillValid(context, entry); })) {
    closeContest(context, state, contest, 'CHILD_UNAVAILABLE');
    bump(context, state, 'CONTEST_BLOCKED', contest.childIds);
    return;
  }
  contest.resultIds.push(record.job.jobId);
  const pair = contest.childIds.map(id => [...state.jobs].reverse().find(item => item.purpose === 'contest'
    && item.contestId === contest.contestId && item.memberIds[0] === id
    && item.result?.kind === 'validate-stack' && item.verified && item.consumed && !item.retryIssued));
  if (pair.some(item => !item)) return;
  const [first, second] = pair as [JobRecord, JobRecord];
  if (first.job.kind !== 'validate-stack' || second.job.kind !== 'validate-stack') return;
  const policy = resultPolicy(context, first);
  if (!policy) return;
  const inputs = [first, second].map((item, i): ContestResult => ({
    changeId: contest.childIds[i], creationSequence: contest.creationSequences[i], resultSequence: item.resultSequence!,
    policyDigest: item.job.policyDigest, profileDigest: item.job.profileDigest, oracleDigest: item.job.oracleDigest,
    toolchainDigest: item.job.toolchainDigest, checkerDigest: item.job.checkerDigest,
    canonicalBaseOid: (item.job as ValidateStackJob).canonicalBaseOid!, result: item.result as StackResult,
  }));
  const outcome = inputs.some(item => item.canonicalBaseOid !== contest.baseOid
    || item.profileDigest !== contest.profileDigest || item.policyDigest !== contest.policyDigest)
    ? { status: 'blocked' as const, reason: 'NON_COMPARABLE_PROFILE' }
    : arbitrate(inputs[0], inputs[1], policy.acceptance);
  contest.reason = outcome.reason;
  if (outcome.status === 'blocked') {
    state.blockedReason = outcome.reason;
    closeContest(context, state, contest, outcome.reason);
  } else {
    contest.state = 'selected'; contest.winnerId = outcome.winnerId;
    contestEvidence(context, contest, outcome.winnerId);
    const loser = admitted(state, contest.admissionIds[contest.childIds.indexOf(outcome.loserId)])!;
    transition(context, state, loser, 'failed', outcome.reason);
  }
  emit(context, 'queue.contest_arbitrated', contest.childIds, { contestId: contest.contestId,
    winnerId: contest.winnerId, reason: contest.reason, firstResult: first.result?.jobId, secondResult: second.result?.jobId });
  bump(context, state, 'CONTEST_ARBITRATED', contest.childIds);
}

function reconcileTicket(context: ModuleContext, state: QueueState, observed: string | null): void {
  const ticket = state.ticket;
  if (!ticket || !['pending', 'reconcile'].includes(ticket.state)) return;
  const attempts = ticket.jobIds.map(id => state.jobs.find(item => item.job.jobId === id));
  const results = attempts.map(item => item?.result as PromotionResult | undefined);
  ticket.lastObservedOid = observed;
  if (observed === ticket.checkedNewOid) {
    context.transaction(() => {
      ticket.state = 'applied'; ticket.reconciliation = 'EXACT_NEW_OID';
      state.finalCanonicalOid = observed;
      state.blockedReason = null;
      for (const id of ticket.admissionIds) {
        const entry = admitted(state, id);
        if (entry && active(entry)) transition(context, state, entry, 'landed');
      }
      if (ticket.bootstrap) state.bootstrap!.state = 'merged';
      state.observedMain = observed;
      emit(context, 'queue.promotion_applied', ticket.memberIds, { promotionId: ticket.promotionId,
        canonicalOid: observed, checkedNewOid: ticket.checkedNewOid, readback: true });
      bump(context, state, 'MAIN_CHANGED', ticket.memberIds);
      save(context, state);
    });
    return;
  }
  if (observed === ticket.expectedOldOid && results.length > 0
    && results.every(result => result?.outcome === 'OLD_REF' && result.observedCanonicalOid === observed)) {
    ticket.state = 'failed'; ticket.reconciliation = 'CONFIRMED_OLD_REF';
    state.blockedReason = null;
    for (const id of ticket.admissionIds) {
      const entry = admitted(state, id);
      if (entry && entry.state === 'checking') transition(context, state, entry, 'reserved');
    }
    if (ticket.bootstrap) state.bootstrap!.state = 'waiting';
    emit(context, 'queue.promotion_failed', ticket.memberIds, { reason: 'CONFIRMED_OLD_REF', observed });
    bump(context, state, 'PROMOTION_FAILED', ticket.memberIds);
    return;
  }
  if (observed !== ticket.expectedOldOid) {
    ticket.state = 'reconcile'; ticket.reconciliation = 'THIRD_OID';
  } else if (results.some(result => result?.outcome === 'ENV_ERROR' || result?.outcome === 'THIRD_REF')
    || context.now() - ticket.createdAt >= 60_000) {
    ticket.state = 'reconcile'; ticket.reconciliation = 'AMBIGUOUS_OLD_OID';
  }
  if (ticket.state === 'reconcile' && state.blockedReason !== ticket.reconciliation) {
    state.blockedReason = ticket.reconciliation;
    emit(context, 'queue.promotion_reconcile', ticket.memberIds, { promotionId: ticket.promotionId,
      observed, expectedOldOid: ticket.expectedOldOid, checkedNewOid: ticket.checkedNewOid,
      reason: ticket.reconciliation, frozen: true });
  }
}

function retryAmbiguousPromotion(context: ModuleContext, state: QueueState, observed: string | null): void {
  const ticket = state.ticket;
  if (!ticket || ticket.state !== 'reconcile' || ticket.retryIssued || observed !== ticket.expectedOldOid
    || ticket.reconciliation !== 'AMBIGUOUS_OLD_OID') return;
  const original = state.jobs.find(item => item.job.jobId === ticket.jobId);
  if (!original || original.job.kind !== 'promote') return;
  const retry: Job = { ...original.job, jobId: crypto.randomUUID(), state: 'pending', attempt: 0,
    runnerId: null, fence: 0, expiresAt: null };
  context.transaction(() => {
    schedule(context, state, retry, 'promotion', ticket.memberIds);
    ticket.jobIds.push(retry.jobId);
    ticket.retryIssued = true;
    emit(context, 'queue.promotion_retry', ticket.memberIds, { promotionId: ticket.promotionId,
      firstJobId: ticket.jobId, retryJobId: retry.jobId, expectedOldOid: ticket.expectedOldOid,
      checkedNewOid: ticket.checkedNewOid });
    save(context, state);
  });
}

async function processRecordedResult(context: ModuleContext, state: QueueState, record: JobRecord, main: string | null): Promise<void> {
  const result = record.result;
  if (!result || record.consumed) return;
  record.consumed = true;
  if (!await validResultDigest(result)) {
    state.blockedReason = 'RESULT_DIGEST_MISMATCH';
    emit(context, 'queue.result_rejected', record.memberIds, { jobId: result.jobId, reason: state.blockedReason });
    if (record.purpose !== 'promotion') failRecord(context, state, record, 'RESULT_DIGEST_MISMATCH');
    return;
  }
  if (record.purpose === 'promotion') {
    reconcileTicket(context, state, main);
    return;
  }
  if (record.job.generation !== state.generation) return;
  if (record.retryOf) {
    const previous = state.jobs.find(item => item.job.jobId === record.retryOf)?.result;
    if (previous && previous.outcome !== result.outcome) {
      state.blockedReason = 'SUSPECTED_FLAKE';
      emit(context, 'queue.suspected_flake', record.memberIds, { firstJobId: record.retryOf,
        retryJobId: result.jobId, firstOutcome: previous.outcome, secondOutcome: result.outcome });
      failRecord(context, state, record, 'SUSPECTED_FLAKE');
      return;
    }
  }
  if (result.outcome === 'ENV_ERROR' || result.outcome === 'TIMEOUT') {
    if (!record.retryOf && !record.retryIssued) {
      const retry = { ...record.job, jobId: crypto.randomUUID(), state: 'pending' as const,
        attempt: 0, fence: 0, runnerId: null, expiresAt: null } as Job;
      context.transaction(() => {
        const next = schedule(context, state, retry, record.purpose, record.memberIds, record.contestId);
        next.retryOf = record.job.jobId;
        record.retryIssued = true;
        save(context, state);
      });
      return;
    }
    state.blockedReason = 'ENVIRONMENT_FAILURE';
    emit(context, 'queue.blocked', record.memberIds, { reason: state.blockedReason });
    failRecord(context, state, record, 'ENVIRONMENT_FAILURE');
    return;
  }
  if (result.kind !== 'validate-stack') return;
  await processStackResult(context, state, record, result, main);
}

async function queueAlarm(context: ModuleContext): Promise<void> {
  const state = read(context);
  const canonicalName = state.ticket?.canonicalStorageName
    ?? state.bootstrap?.input.canonicalStorageName ?? state.entries[0]?.canonicalStorageName;
  if (!canonicalName) return;
  const main = await context.storage.resolveRef(canonicalName, 'refs/heads/main');
  if (state.ticket && ['pending', 'reconcile'].includes(state.ticket.state)) {
    for (const jobId of state.ticket.jobIds) {
      const promotionRecord = state.jobs.find(item => item.job.jobId === jobId);
      if (promotionRecord?.result && !promotionRecord.consumed) {
        if (!await validResultDigest(promotionRecord.result)) {
          state.blockedReason = 'RESULT_DIGEST_MISMATCH';
          emit(context, 'queue.result_rejected', [], { jobId: promotionRecord.job.jobId, reason: state.blockedReason });
          promotionRecord.result = undefined;
        }
        promotionRecord.consumed = true;
      }
    }
    reconcileTicket(context, state, main);
    retryAmbiguousPromotion(context, state, main);
    save(context, state);
    return;
  }
  if (state.bootstrap && state.bootstrap.state !== 'merged' && main !== null) {
    state.bootstrap.state = 'blocked'; state.bootstrap.blockedReason = 'BOOTSTRAP_CONFLICT';
    emit(context, 'queue.bootstrap_blocked', [state.bootstrap.stackId], { reason: 'MAIN_EXISTS', observed: main });
  }
  if (state.observedMain !== main) {
    state.observedMain = main;
    invalidate(context, state, 'MAIN_CHANGED', []);
    for (const entry of state.entries) if (active(entry) && entry.baseOid !== main) {
      blockEntry(context, state, entry, 'STALE_MAIN');
    }
  }
  for (const entry of state.entries) if (active(entry) && entry.state !== 'blocked' && !admissionStillValid(context, entry)) {
    blockEntry(context, state, entry, 'ELIGIBILITY_CHANGED');
  }
  const pendingResult = state.jobs.find(record => record.result && !record.consumed);
  if (pendingResult) {
    await processRecordedResult(context, state, pendingResult, main);
    save(context, state);
    return;
  }
  if (state.blockedReason === 'SUSPECTED_FLAKE' || state.blockedReason === 'RESULT_DIGEST_MISMATCH'
    || state.blockedReason === 'CHECKED_SCRATCH_MISMATCH') { save(context, state); return; }
  const contest = state.contests.find(item => item.state === 'open');
  if (contest) {
    if (contest.admissionIds.some(id => { const entry = admitted(state, id); return !entry || entry.state !== 'reserved' || !admissionStillValid(context, entry); })) {
      closeContest(context, state, contest, 'CHILD_UNAVAILABLE');
      bump(context, state, 'CONTEST_BLOCKED', contest.childIds);
      save(context, state);
      return;
    }
    for (const id of contest.childIds) {
      const admissionId = contest.admissionIds[contest.childIds.indexOf(id)];
      if (state.jobs.some(record => record.purpose === 'contest' && record.contestId === contest.contestId && record.admissionIds[0] === admissionId)) continue;
      const job = await makeStackJob(context, state, [id], false);
      context.transaction(() => { schedule(context, state, job, 'contest', [id], contest.contestId); save(context, state); });
    }
    save(context, state);
    return;
  }
  if (state.bootstrap?.state === 'waiting' && main === null) {
    const job = await makeStackJob(context, state, [], true);
    context.transaction(() => {
      schedule(context, state, job, 'stack', []);
      state.bootstrap!.state = 'checking';
      save(context, state);
    });
    return;
  }
  if (state.activeStackJobId || state.diagnosis && state.diagnosis.phase !== 'done'
    || state.coalesceUntil !== null && context.now() < state.coalesceUntil) { save(context, state); return; }
  const waiting = ordered(state).filter(entry => entry.state === 'reserved' && (!entry.contestId
    || state.contests.some(contest => contest.state === 'selected' && contest.admissionIds.includes(entry.entryId) && contest.winnerId === entry.changeId)));
  if (waiting.length === 0) { save(context, state); return; }
  const available = new Set(state.entries.filter(entry => entry.state === 'landed').map(entry => entry.changeId));
  const anchor = waiting[0];
  const comparable = waiting.filter(entry => entry.policyId === anchor.policyId && entry.profileId === anchor.profileId
    && entry.canonicalStorageName === anchor.canonicalStorageName && entry.scratchStorageName === anchor.scratchStorageName);
  const selected = selectStack(comparable, available, STACK_WIDTH);
  if (selected.length === 0) { state.coalesceUntil = context.now() + 10_000; save(context, state); return; }
  const job = await makeStackJob(context, state, selected, false);
  context.transaction(() => {
    schedule(context, state, job, 'stack', selected);
    for (const id of selected) transition(context, state, current(state, id)!, 'checking');
    state.coalesceUntil = null;
    emit(context, 'queue.stack_checking', selected, { jobId: job.jobId, generation: state.generation, width: selected.length });
    save(context, state);
  });
}

export const queue: FeatureModule = {
  name: 'queue', migrations: [],
  routes: [
    { method: 'GET', pattern: /^\/v1\/repos\/[^/]+\/queue$/, handle: context => {
      return json(queueProjection(read(context)), context.version(), eventSequence(context.sql));
    } },
    { method: 'POST', pattern: /^\/v1\/repos\/[^/]+\/queue\/enqueue$/, handle: (context, _request, _match, body) => enqueue(context, body as Record<string, unknown>) },
    { method: 'POST', pattern: /^\/v1\/repos\/[^/]+\/queue\/withdraw$/, handle: (context, _request, _match, body) => withdraw(context, body as Record<string, unknown>) },
    { method: 'POST', pattern: /^\/v1\/repos\/[^/]+\/contests$/, handle: (context, _request, _match, body) => createContest(context, body as Record<string, unknown>) },
  ],
  snapshot: context => {
    const view = context.readChange?.('queue_status_probe');
    const status = !view || view.status === 'blocked' && view.code === 'MODULE_UNAVAILABLE'
      ? 'unavailable' : 'ready';
    return { status, ...queueProjection(read(context)) };
  },
  nextDeadline: context => {
    const state = read(context);
    if (state.blockedReason && state.coalesceUntil !== null && state.coalesceUntil > context.now()) return state.coalesceUntil;
    if (state.jobs.some(record => record.result && !record.consumed)) return context.now() + 1;
    if (state.ticket && ['pending', 'reconcile'].includes(state.ticket.state)) return context.now() + 10_000;
    if (state.contests.some(contest => contest.state === 'open')) {
      const unscheduled = state.contests.some(contest => contest.state === 'open'
        && contest.childIds.some(id => !state.jobs.some(record => record.purpose === 'contest'
          && record.contestId === contest.contestId && record.memberIds[0] === id)));
      return unscheduled && state.coalesceUntil !== null
        ? Math.max(context.now() + 1, state.coalesceUntil) : context.now() + 10_000;
    }
    if (state.bootstrap?.state === 'waiting' || state.entries.some(entry => entry.state === 'reserved')) {
      return state.coalesceUntil !== null
        ? Math.max(context.now() + 1, state.coalesceUntil) : context.now() + 10_000;
    }
    if (state.activeStackJobId) return context.now() + 10_000;
    return null;
  },
  onAlarm: async context => {
    try { await queueAlarm(context); }
    catch (error) {
      const state = read(context);
      const reason = error instanceof HttpError ? error.code : 'QUEUE_ALARM_ERROR';
      state.blockedReason = reason;
      state.coalesceUntil = context.now() + 10_000;
      emit(context, 'queue.alarm_deferred', [], { reason, retryAt: state.coalesceUntil });
      save(context, state);
    }
  },
  hooks: { 'queue.onResult': onResult },
  bootstrapHandoff,
  promotionFreeze: (context, request) => {
    const ticket = read(context).ticket;
    if (!ticket || !['pending', 'reconcile'].includes(ticket.state)) return { frozen: false };
    const path = new URL(request.url).pathname;
    const base = `/v1/repos/${context.repoId}`;
    const ticketJob = ticket.jobIds.some(id => path === `${base}/jobs/${id}/heartbeat`
      || path === `${base}/jobs/${id}/credentials` || path === `${base}/jobs/${id}/result`);
    const promoterPath = path === `${base}/runner/poll`
      || ticketJob;
    return { frozen: true, exempt: request.method === 'POST' && promoterPath && context.principal.roles.includes('promoter') };
  },
};
