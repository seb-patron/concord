/** Concord v1 wire and module contracts. IDs are opaque; times are UTC milliseconds. */
export type Id = string;
export type Oid = string;
export type Digest = `sha256:${string}`;
export type Role = 'owner' | 'agent' | 'reviewer' | 'checker' | 'promoter' | 'viewer';
export type Versioned = { version: number };

export interface Principal {
  tenantId: Id;
  principalId: Id;
  roles: Role[];
  repoIds: Id[] | '*';
  expiresAt: number;
}

export interface Repo extends Versioned {
  repoId: Id; tenantId: Id; displayName: string; canonicalStorageName: string;
  defaultBranch: 'main'; observedCanonicalOid: Oid | null;
  policyId: Id; policyDigest: Digest; profileId: Id;
  status: 'provisioning' | 'ready' | 'blocked';
}
export interface Branch extends Versioned {
  logicalRepoId: Id; storageName: string; ref: string; ownerId: Id;
  observedHead: Oid | null;
}
export interface Change extends Versioned {
  changeId: Id; repoId: Id; authorId: Id; intentKey: string; intentText: string;
  candidateStorageName: string; branch: string; baseOid: Oid | null;
  headOid: Oid | null; revision: number; unitKeys: string[];
  dependencyChangeIds: Id[];
  status: 'draft' | 'ready' | 'queued' | 'checking' | 'merged' | 'blocked' | 'superseded' | 'closed';
}
export interface Intent extends Versioned {
  repoId: Id; intentKey: string; changeId: Id; attempt: number; terminal: boolean;
}
export interface Lease extends Versioned {
  leaseId: Id; unitKey: string; holderId: Id; changeId: Id; intentText: string;
  fence: number; expiresAt: number; state: 'active' | 'released' | 'expired' | 'reserved';
}
export interface Finding extends Versioned {
  findingId: Id; changeId: Id; originRevision: number; unitKey: string;
  evidenceDigest: Digest; text: string; status: 'open' | 'resolved';
  repairRound: number | null; resolvedAtRevision: number | null; resolvingReviewerId: Id | null;
}
export interface Verdict extends Versioned {
  verdictId: Id; changeId: Id; reviewerId: Id; revision: number;
  reviewManifestDigest: Digest; policyDigest: Digest; checkerDigest: Digest;
  findingSetVersion: number; decision: 'approve' | 'reject';
  evidenceDigest: Digest; parentVerdictId: Id | null;
}
export interface QueueEntry extends Versioned {
  entryId: Id; changeId: Id; admittedRevision: number; baseOid: Oid | null;
  sequence: number; generation: number; dependencyChangeIds: Id[];
  state: 'waiting' | 'checking' | 'blocked' | 'merged' | 'withdrawn';
  blockedReason: string | null;
}
export interface Stack extends Versioned {
  stackId: Id; canonicalBaseOid: Oid | null;
  entries: Array<{ changeId: Id; revision: number; headOid: Oid }>;
  generation: number; composedOid: Oid | null; treeOid: Oid | null; resultId: Id | null;
}
export interface Promotion extends Versioned {
  promotionId: Id; expectedOldOid: Oid | null; checkedNewOid: Oid; bootstrap: boolean;
  queueGeneration: number; frozenAdmission: FrozenAdmission[];
  state: 'pending' | 'applied' | 'reconcile' | 'failed';
}
export interface Runner extends Versioned {
  runnerId: Id; principalId: Id; role: 'checker' | 'promoter';
  supportedProfileDigests: Digest[]; state: 'idle' | 'claimed' | 'offline';
  lastSeenAt: number; activeJobId: Id | null;
}
export interface RepairRound extends Versioned {
  roundId: Id; changeId: Id; revision: number; findingSetVersion: number;
  findingIds: Id[]; status: 'pending' | 'accepted' | 'rejected';
  reviewerId: Id | null;
}
export interface Contest extends Versioned {
  contestId: Id; intentKey: string; unitKey: string; baseOid: Oid;
  childChangeIds: [Id, Id]; selectedChangeId: Id | null;
  state: 'open' | 'selected' | 'blocked';
}
export interface OutboxIntent extends Versioned {
  intentId: Id; kind: 'ensure-repo' | 'fork' | 'promotion';
  storageName: string; requestDigest: Digest; state: 'pending' | 'observed' | 'failed';
  retryAt: number; observedOid: Oid | null;
}
export interface FrozenAdmission {
  changeId: Id; revision: number; verdictId: Id | null;
  findingSetVersion: number; reservationFences: Record<string, number>;
}
export interface Event {
  sequence: number; kind: string; actorId: Id; timestamp: number;
  version: number; relatedIds: Id[]; payload: Record<string, unknown>;
}
export interface IdempotentRequest {
  principalId: Id; route: string; idempotencyKey: string;
  requestDigest: Digest; status: number; response: unknown;
}

export interface TrustedPolicy {
  id: Id; digest: Digest; version: number;
  units: Record<string, { canonicalKey: string; file: string; resources: string[] }>;
  checkerId: string; checkerDigest: Digest;
  acceptance: 'match' | 'pass' | 'no-regression';
}
export interface TrustedProfile {
  id: Id; digest: Digest; toolchainDigest: Digest; oracleDigest: Digest;
  environmentDigest: Digest; timeoutMs: number; maxOutputBytes: number;
}
export interface TrustedConfiguration {
  policies: Record<string, TrustedPolicy>;
  profiles: Record<string, TrustedProfile>;
}

export interface ApiSuccess<T> { data: T; version: number; eventSeq: number }
export interface ApiFailure { error: { code: string; message: string; details?: unknown }; requestId: string }
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface MutationBody { expectedVersion?: number }
export interface CreateRepoBody { name: string; policyId: Id; profileId: Id }
export interface BootstrapBody extends MutationBody {
  seedStorageName: string; seedRef: string; headOid: Oid; policyId: Id; profileId: Id;
}
export interface CreateChangeBody {
  intentKey: string; intentText: string; baseOid: Oid | null; branch: string;
  unitKeys: string[]; dependencyChangeIds: Id[]; attempt?: number;
}
export interface ClaimBody extends MutationBody { changeId: Id; unitKeys: string[]; intentText: string; ttlSeconds?: number }
export interface PublishBody extends MutationBody {
  baseOid: Oid | null; headOid: Oid; branch: string; unitKeys: string[];
  leaseFences: Record<string, number>;
}
export interface EnqueueBody extends MutationBody { changeId: Id; verdictId: Id; leaseFences: Record<string, number> }
export interface AddFindingBody extends MutationBody { revision: number; unitKey: string; text: string; evidenceDigest: Digest }
export interface SubmitRepairBody extends MutationBody {
  revision: number; findingSetVersion: number;
  dispositions: Array<{ findingId: Id; explanation: string; evidenceDigest: Digest }>;
}
export interface ReviewRepairBody extends MutationBody {
  revision: number; findingSetVersion: number; decision: 'accept' | 'reject'; evidenceDigest: Digest;
}
export interface AddVerdictBody extends MutationBody {
  revision: number; reviewManifestDigest: Digest; findingSetVersion: number;
  decision: 'approve' | 'reject'; evidenceDigest: Digest;
}
export interface CarryBody extends MutationBody { parentVerdictId: Id; revision: number; newBaseOid: Oid }
export interface CreateContestBody {
  intentKey: string; intentText: string; unitKey: string; baseOid: Oid; profileId: Id;
}
export interface RegisterBranchBody extends MutationBody {
  storageName: string; ref: string; observedHead: Oid; ownerId: Id;
}
export interface GitTokenBody extends MutationBody {
  storageName: string; scope: 'read' | 'write'; ttlSeconds: number;
}
export interface WithdrawBody extends MutationBody { changeId: Id; reason: string }
export interface RunnerPollBody {
  runnerId: Id; role: 'checker' | 'promoter'; supportedProfileDigests: Digest[]; maxJobs?: 1;
}
export interface JobHeartbeatBody { attempt: number; fence: number; inputDigest: Digest }
export interface JobResultBody { attempt: number; fence: number; inputDigest: Digest; resultDigest: Digest; result: JobResult }
export interface JobCredentialsBody { attempt: number; fence: number; operation: 'fetch' | 'scratch-push' | 'canonical-push' }

export type JobKind = 'inspect-candidate' | 'validate-stack' | 'delta-check' | 'promote';
export type JobState = 'pending' | 'claimed' | 'completed' | 'expired' | 'blocked';
export interface JobBase extends Versioned {
  jobId: Id; repoId: Id; inputDigest: Digest; generation: number;
  profileDigest: Digest; expectedRefs: Record<string, Oid | null>;
  storageRemotes: Record<string, string>; checkerId: string; checkerDigest: Digest;
  oracleDigest: Digest; toolchainDigest: Digest; environmentDigest: Digest;
  timeoutMs: number; maxOutputBytes: number;
  state: JobState; attempt: number; runnerId: Id | null; fence: number; expiresAt: number | null;
}
export interface CandidateInput { changeId: Id; revision: number; baseOid: Oid; headOid: Oid }
export interface SeedInput { changeId: Id; revision: number; baseOid: null; headOid: Oid; seedStorageName: string; seedRef: string }
export interface InspectCandidateJob extends JobBase {
  kind: 'inspect-candidate'; changeId: Id; revision: number; candidate: CandidateInput | SeedInput;
}
export interface OrdinaryStackJob extends JobBase {
  kind: 'validate-stack'; canonicalBaseOid: Oid; candidates: CandidateInput[];
  bootstrap: false; stackId: Id; scratchStorageName: string;
}
export interface BootstrapStackJob extends JobBase {
  kind: 'validate-stack'; canonicalBaseOid: null; candidates: [SeedInput];
  bootstrap: true; ownerAuthorized: true; stackId: Id; scratchStorageName: string;
}
export type ValidateStackJob = OrdinaryStackJob | BootstrapStackJob;
export interface DeltaCheckJob extends JobBase {
  kind: 'delta-check'; changeId: Id; oldManifestDigest: Digest; newBaseOid: Oid;
}
export interface OrdinaryPromoteJob extends JobBase {
  kind: 'promote'; promotionId: Id; expectedOldOid: Oid; checkedNewOid: Oid; bootstrap: false;
}
export interface BootstrapPromoteJob extends JobBase {
  kind: 'promote'; promotionId: Id; expectedOldOid: null; checkedNewOid: Oid; bootstrap: true; ownerAuthorized: true;
}
export type PromoteJob = OrdinaryPromoteJob | BootstrapPromoteJob;
export type Job = InspectCandidateJob | ValidateStackJob | DeltaCheckJob | PromoteJob;
export type CheckOutcome = 'PASS' | 'FAIL' | 'MATCH' | 'MISMATCH' | 'COMPILE_ERROR' | 'UNVERIFIED_TARGET' | 'ENV_ERROR' | 'MERGE_CONFLICT';
export interface ResultBase {
  jobId: Id; attempt: number; inputDigest: Digest; fence: number;
  sourceTreeOid: Oid | null; toolchainDigest: Digest; oracleDigest: Digest;
  environmentDigest: Digest; durationMs: number; log: string; resultDigest: Digest;
}
export interface InspectionResult extends ResultBase {
  kind: 'inspect-candidate'; outcome: CheckOutcome; observedHeadOid: Oid;
  unitKeys: string[]; reviewManifestDigest: Digest | null;
}
export interface StackResultBase extends ResultBase {
  kind: 'validate-stack'; outcome: CheckOutcome; composedOid: Oid | null;
  score: number | null;
}
export type StackResult = StackResultBase & (
  | { bootstrap: false; canonicalBaseOid: Oid }
  | { bootstrap: true; canonicalBaseOid: null }
);
export interface DeltaResult extends ResultBase {
  kind: 'delta-check'; outcome: CheckOutcome; reviewManifestDigest: Digest | null;
  dependencyScopeDigest: Digest | null;
}
export interface PromotionResult extends ResultBase {
  kind: 'promote'; outcome: 'APPLIED' | 'OLD_REF' | 'THIRD_REF' | 'ENV_ERROR';
  observedCanonicalOid: Oid | null;
}
export type JobResult = InspectionResult | StackResult | DeltaResult | PromotionResult;

export interface StorageRepo { name: string; remote: string; status: 'ready' | 'provisioning' }
export interface StorageCommit { oid: Oid; treeOid: Oid; parents: Oid[] }
export interface StorageToken { secret: string; expiresAt: number }
export interface RepoStorage {
  ensureRepo(name: string): Promise<StorageRepo>;
  fork(sourceName: string, targetName: string): Promise<StorageRepo>;
  info(name: string): Promise<StorageRepo | null>;
  resolveRef(name: string, ref: string): Promise<Oid | null>;
  readCommit(name: string, oid: Oid): Promise<StorageCommit | null>;
  readFile(name: string, oid: Oid, path: string): Promise<Uint8Array | null>;
  mintToken(name: string, scope: 'read' | 'write', ttlSeconds: number): Promise<StorageToken>;
  revokeToken(name: string, tokenIdOrSecret: string): Promise<boolean>;
}

export type Gate<T = void> =
  | { status: 'eligible'; version: number; evidenceIds: Id[]; value: T }
  | { status: 'blocked'; version: number; code: string; reason: string; evidenceIds: Id[] };
export interface ServiceHooks {
  'repos.inspectRevision': (context: ModuleContext, result: InspectionResult) => Gate<{ changeId: Id; revision: number; reviewManifestDigest: Digest }>;
  'leases.reserve': (context: ModuleContext, changeId: Id, fences: Record<string, number>) => Gate<{ reservationFences: Record<string, number> }>;
  'leases.releaseReservation': (context: ModuleContext, changeId: Id) => Gate;
  'findings.gate': (context: ModuleContext, changeId: Id, revision: number) => Gate<{ findingSetVersion: number; unresolvedIds: Id[]; pendingRound: number | null }>;
  'verdicts.gate': (context: ModuleContext, changeId: Id, revision: number) => Gate<{ verdictId: Id; reviewManifestDigest: Digest; findingSetVersion: number }>;
  'verdicts.evaluateCarry': (context: ModuleContext, result: DeltaResult) => Gate<{ verdictId: Id }>;
  'queue.onResult': (context: ModuleContext, result: StackResult | PromotionResult) => Gate<{ promotionId: Id | null }>;
  'runners.schedule': (context: ModuleContext, job: Job) => Gate<{ jobId: Id }>;
}
export type HookName = keyof ServiceHooks;
export type ModuleName = 'repos' | 'leases' | 'queue' | 'runners' | 'findings' | 'verdicts';
export interface Migration { version: number; statements: string[] }
export interface ModuleContext {
  readonly repoId: Id; readonly tenantId: Id; readonly principal: Principal;
  readonly env: Env;
  readonly storage: RepoStorage; readonly trusted: TrustedConfiguration;
  readonly now: () => number; readonly sql: SqlStorage;
  transaction<T>(run: () => T): T;
  version(): number;
  nextVersion(): number;
  appendEvent(kind: string, relatedIds: Id[], payload: Record<string, unknown>, version: number): Event;
  state: { get<T>(key: string): T | null; put<T>(key: string, value: T): void; delete(key: string): void };
  call<K extends HookName>(name: K, ...args: Parameters<ServiceHooks[K]> extends [ModuleContext, ...infer A] ? A : never): ReturnType<ServiceHooks[K]>;
}
export interface ModuleRoute {
  method: string; pattern: RegExp;
  handle(context: ModuleContext, request: Request, match: RegExpMatchArray, body: unknown): Response | Promise<Response>;
}
export interface FeatureModule {
  name: ModuleName; migrations: Migration[]; routes: ModuleRoute[];
  snapshot(context: ModuleContext): unknown;
  nextDeadline(context: ModuleContext): number | null;
  onAlarm(context: ModuleContext): void | Promise<void>;
  hooks: Partial<ServiceHooks>;
}
