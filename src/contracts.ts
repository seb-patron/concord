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
  model?: string | null;
  authMethod?: 'access';
}

export interface HumanIdentity {
  email: string; tenantId: Id; principalId: Id; roles: Role[]; repoIds: Id[] | '*';
}

/** Public metadata for a runtime delegated identity. The token digest is never returned. */
export interface DelegatedPrincipal {
  id: Id; roles: Role[]; repoIds: Id[] | '*'; expiresAt: number;
  parentId: Id; createdAt: number; revokedAt: number | null; name?: string;
}

export interface Repo extends Versioned {
  repoId: Id; tenantId: Id; displayName: string; canonicalStorageName: string;
  defaultBranch: 'main'; observedCanonicalOid: Oid | null;
  policyId: Id; policyDigest: Digest; profileId: Id;
  status: 'provisioning' | 'ready' | 'blocked';
  /** Owner-controlled anonymous read flag. Absent on records written before the flag existed; treated as false. */
  public?: boolean;
}
export interface Branch extends Versioned {
  logicalRepoId: Id; storageName: string; ref: string; ownerId: Id;
  observedHead: Oid | null;
}
export interface Change extends Versioned {
  changeId: Id; repoId: Id; authorId: Id; intentKey: string; intentText: string;
  issueNumber?: number | null;
  authorModel?: string | null;
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
  issueNumber?: number | null; issueTitle?: string | null;
  fence: number; expiresAt: number; state: 'active' | 'released' | 'expired' | 'reserved';
}
export interface Finding extends Versioned {
  findingId: Id; changeId: Id; originRevision: number; unitKey: string;
  evidenceDigest: Digest; text: string; status: 'open' | 'resolved';
  repairRound: number | null; resolvedAtRevision: number | null; resolvingReviewerId: Id | null;
  /** Stable semantic target; path and line are display hints only. */
  semanticAnchor?: { kind: 'unit' | 'unknown'; key: string; path?: string; line?: number };
}
export interface Verdict extends Versioned {
  verdictId: Id; changeId: Id; reviewerId: Id; revision: number;
  reviewManifestDigest: Digest; reviewManifest: ReviewManifest;
  policyDigest: Digest; checkerDigest: Digest;
  oracleDigest: Digest; toolchainDigest: Digest; deltaResultId: Id | null;
  findingSetVersion: number; decision: 'approve' | 'reject';
  evidenceDigest: Digest; parentVerdictId: Id | null;
  carriedFrom?: { sourceOid: Oid; method: 'patch-id' };
}
export interface QueueEntry extends Versioned {
  entryId: Id; changeId: Id; admittedRevision: number; baseOid: Oid | null;
  issueNumber?: number | null;
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
  state: 'open' | 'selected' | 'landed' | 'blocked';
}
export interface OutboxIntent extends Versioned {
  intentId: Id; kind: 'ensure-repo' | 'fork' | 'promotion';
  storageName: string; requestDigest: Digest; state: 'pending' | 'observed' | 'failed';
  retryAt: number; observedOid: Oid | null;
}
export interface FrozenAdmission {
  changeId: Id; revision: number; verdictId: Id | null;
  /** Queue admission identity; distinguishes a re-enqueued change from its withdrawn predecessor. */
  admissionId?: Id;
  findingSetVersion: number; reservationFences: Record<string, number>;
  headOid?: Oid; baseOid?: Oid | null; policyDigest?: Digest; profileDigest?: Digest;
}
export interface Event {
  sequence: number; kind: string; actorId: Id; timestamp: number;
  version: number; relatedIds: Id[]; payload: Record<string, unknown>;
}
export interface IdempotentRequest {
  principalId: Id; route: string; idempotencyKey: string;
  requestDigest: Digest; status: number; response: unknown;
}

export interface AcceptanceGate { id: string; requiredOutcome: 'MATCH' | 'PASS' }
export type AcceptancePolicy =
  | { kind: 'hard-gates'; gates: AcceptanceGate[] }
  | { kind: 'score'; gates: AcceptanceGate[]; fixedDenominator: number };
export interface TrustedPolicy {
  id: Id; digest: Digest; version: number;
  units: Record<string, { canonicalKey: string; file: string; resources: string[]; dependencyKeys: string[] }>;
  /** Owner-approved directories for whole-file units at paths absent from the registry. */
  newFilePrefixes?: string[];
  /** Owner-declared TSV row namespaces. These are never supplied by a change author. */
  tables?: Array<{ name: string; file: string; header: string[]; keyColumn: string;
    keySpec: { charset: 'lower' | 'alnum' | 'alnum-dash-dot' | string[]; minLength: number; maxLength: number } }>;
  checkerId: string; checkerDigest: Digest;
  acceptance: AcceptancePolicy;
}
export interface TrustedProfile {
  id: Id; digest: Digest; toolchainDigest: Digest; oracleDigest: Digest;
  environmentDigest: Digest; timeoutMs: number; maxOutputBytes: number;
}
export interface TrustedConfiguration {
  policies: Record<string, TrustedPolicy>;
  profiles: Record<string, TrustedProfile>;
  delegatedPrincipals?: { maxTtlMs?: number; activeLimit?: number; totalLimit?: number };
  humans?: HumanIdentity[];
  costLimits?: {
    maxReposPerTenant?: number; maxForksPerTenant?: number; maxTokenMintsPerTenantPerDay?: number;
    /** Install-wide ceiling on non-terminal changes per repo (default 32); agents cannot change it. */
    maxActiveChangesPerRepo?: number;
    /** Per-repo overrides of maxActiveChangesPerRepo, keyed by repoId. */
    activeChangeLimits?: Record<Id, number>;
  };
}

export interface ApiSuccess<T> { data: T; version: number; eventSeq: number }
export interface ApiFailure { error: { code: string; message: string; details?: unknown }; requestId: string }
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface MutationBody { expectedVersion?: number }
export interface CreateRepoBody { name: string; policyId: Id; profileId: Id; public?: boolean }
export interface BootstrapBody extends MutationBody {
  seedStorageName: string; seedRef: string; headOid: Oid; policyId: Id; profileId: Id; withHistory?: boolean;
}
export interface CreateChangeBody {
  intentKey: string; intentText: string; baseOid: Oid | null; branch: string;
  unitKeys: string[]; dependencyChangeIds: Id[]; attempt?: number;
  issueNumber?: number;
}
export interface ClaimBody extends MutationBody { changeId: Id; unitKeys: string[]; intentText: string; ttlSeconds?: number }
export interface PublishBody extends MutationBody {
  baseOid: Oid | null; headOid: Oid; branch: string; unitKeys: string[];
  leaseFences: Record<string, number>;
}
export interface EnqueueBody extends MutationBody { changeId: Id; verdictId: Id; leaseFences: Record<string, number> }
export interface AddFindingBody extends MutationBody {
  revision: number; unitKey: string; text: string; evidenceDigest: Digest;
  semanticAnchor?: Finding['semanticAnchor'];
  /** Reopen the existing stable ID with a new evidence event. */
  reopenFindingId?: Id;
}
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
  carriedFrom?: { sourceOid: Oid; method: 'patch-id' };
}
export interface CarryBody extends MutationBody { parentVerdictId: Id; revision: number; newBaseOid: Oid }
export interface CreateContestBody {
  intentKey: string; intentText: string; unitKey: string; baseOid: Oid; profileId: Id;
  /** Two already published children, admitted atomically through the queue's normal gates. */
  childChangeIds?: [Id, Id]; verdictIds?: [Id, Id]; leaseFences?: [Record<string, number>, Record<string, number>];
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
  profileDigest: Digest; policyId: Id; policyDigest: Digest;
  unitPolicy: TrustedPolicy; expectedRefs: Record<string, Oid | null>;
  storageRemotes: Record<string, string>; checkerId: string; checkerDigest: Digest;
  oracleDigest: Digest; toolchainDigest: Digest; environmentDigest: Digest;
  timeoutMs: number; maxOutputBytes: number;
  /** Trusted dispatch-lab case selected by the server, never from candidate files. */
  caseId?: string;
  /** Present only for score-comparable contest validation jobs. */
  contest?: true;
  state: JobState; attempt: number; runnerId: Id | null; fence: number; expiresAt: number | null;
}
export interface CandidateInput {
  changeId: Id; revision: number; baseOid: Oid; headOid: Oid;
  storageName: string; ref: string;
}
export interface SeedInput { changeId: Id; revision: number; baseOid: null; headOid: Oid; seedStorageName: string; seedRef: string }
export interface InspectCandidateJob extends JobBase {
  kind: 'inspect-candidate'; changeId: Id; revision: number; candidate: CandidateInput | SeedInput;
}
export interface OrdinaryStackJob extends JobBase {
  kind: 'validate-stack'; canonicalBaseOid: Oid; candidates: CandidateInput[];
  /** Explicit canonical-base-only diagnostic; ordinary stacks require candidates. */
  baseCheck?: true;
  bootstrap: false; stackId: Id; scratchStorageName: string; scratchRef: string;
}
export interface BootstrapStackJob extends JobBase {
  kind: 'validate-stack'; canonicalBaseOid: null; candidates: [SeedInput];
  bootstrap: true; ownerAuthorized: true; stackId: Id; scratchStorageName: string; scratchRef: string;
}
export type ValidateStackJob = OrdinaryStackJob | BootstrapStackJob;
export interface DeltaCheckJob extends JobBase {
  kind: 'delta-check'; changeId: Id; candidate: CandidateInput; oldManifestDigest: Digest; newBaseOid: Oid;
  parentVerdictId: Id; findingSetVersion: number; oldReviewManifest: ReviewManifest;
}
export interface OrdinaryPromoteJob extends JobBase {
  kind: 'promote'; promotionId: Id; expectedOldOid: Oid; checkedNewOid: Oid; bootstrap: false;
  scratchStorageName: string; scratchRef: string;
}
export interface BootstrapPromoteJob extends JobBase {
  kind: 'promote'; promotionId: Id; expectedOldOid: null; checkedNewOid: Oid; bootstrap: true; ownerAuthorized: true;
  scratchStorageName: string; scratchRef: string;
}
export type PromoteJob = OrdinaryPromoteJob | BootstrapPromoteJob;
export type Job = InspectCandidateJob | ValidateStackJob | DeltaCheckJob | PromoteJob;
export type CheckOutcome = 'PASS' | 'FAIL' | 'MATCH' | 'MISMATCH' | 'COMPILE_ERROR' | 'UNVERIFIED_TARGET' | 'ENV_ERROR' | 'MERGE_CONFLICT' | 'TIMEOUT';
export interface ChangedUnitEvidence {
  unitKey: string; beforePath: string | null; afterPath: string | null;
  beforeMode: string | null; afterMode: string | null;
  beforeDigest: Digest | null; afterDigest: Digest | null;
}
export interface UnitDependencyScopeEntry {
  kind: 'unit'; unitKey: string; path: string; mode: string; contentDigest: Digest;
}
export interface TreeDependencyScopeEntry { kind: 'tree'; treeOid: Oid }
export type DependencyScopeEntry = UnitDependencyScopeEntry | TreeDependencyScopeEntry;
export interface ReviewManifestBase {
  changedUnits: ChangedUnitEvidence[];
  policyVersion: number; policyDigest: Digest; checkerDigest: Digest;
  oracleDigest: Digest; toolchainDigest: Digest;
}
export type ReviewManifest = ReviewManifestBase & (
  | { coverage: 'complete'; dependencyScope: UnitDependencyScopeEntry[] }
  | { coverage: 'unknown'; dependencyScope: [TreeDependencyScopeEntry] }
);
export interface ResultBase {
  jobId: Id; attempt: number; inputDigest: Digest; fence: number;
  sourceTreeOid: Oid | null; checkerDigest: Digest; toolchainDigest: Digest; oracleDigest: Digest;
  environmentDigest: Digest; durationMs: number; log: string;
  /** sha256 of canonical sorted JSON of this result with the resultDigest field omitted; must equal JobResultBody.resultDigest. */
  resultDigest: Digest;
}
export interface InspectionResult extends ResultBase {
  kind: 'inspect-candidate'; outcome: CheckOutcome;
  /** Head the runner actually fetched; null only when it observed none (ENV_ERROR or TIMEOUT before fetch). Never a copy of the requested OID. */
  observedHeadOid: Oid | null;
  unitKeys: string[]; reviewManifestDigest: Digest | null; reviewManifest: ReviewManifest | null;
}
/** Trusted result handoff from repos inspection to verdict review. */
export interface InspectedRevision {
  changeId: Id; revision: number; candidate: CandidateInput;
  canonicalStorageName: string; policyId: Id; profileId: Id;
  reviewManifest: ReviewManifest; reviewManifestDigest: Digest; outcome: 'PASS' | 'MATCH';
}
export interface StackResultBase extends ResultBase {
  kind: 'validate-stack'; outcome: CheckOutcome; composedOid: Oid | null;
  composedTreeOid: Oid | null;
  gateResults: Array<{ gateId: string; outcome: CheckOutcome }>;
  score: { matched: number; total: number } | null;
}
export type StackResult = StackResultBase & (
  | { bootstrap: false; canonicalBaseOid: Oid }
  | { bootstrap: true; canonicalBaseOid: null }
);
export interface DeltaResult extends ResultBase {
  kind: 'delta-check'; outcome: CheckOutcome; reviewManifestDigest: Digest | null;
  reviewManifest: ReviewManifest | null;
  dependencyScopeDigest: Digest | null; dependencyScope: DependencyScopeEntry[] | null;
}
export interface PromotionResult extends ResultBase {
  kind: 'promote'; outcome: 'APPLIED' | 'OLD_REF' | 'THIRD_REF' | 'ENV_ERROR';
  observedCanonicalOid: Oid | null;
}
export type JobResult = InspectionResult | StackResult | DeltaResult | PromotionResult;

/** Name of the shared TenantCatalog index mapping public repo IDs to their tenant for anonymous reads. */
export const PUBLIC_DIRECTORY_NAME = 'public:directory';

/** Internal handoff for a creation token; never included in JSON responses. */
export const pendingInitialToken: unique symbol = Symbol('pendingInitialToken');
/** Adapter validation failed after a credential was returned. The coordinator persists the credential before failing the intent. */
export const pendingResultFailure: unique symbol = Symbol('pendingResultFailure');
export interface StorageRepo { name: string; remote: string; status: 'ready' | 'provisioning'; [pendingInitialToken]?: string; [pendingResultFailure]?: string }
export interface StorageCommit { oid: Oid; treeOid: Oid; parents: Oid[] }
export interface StorageTreeEntry { name: string; type: 'tree' | 'blob' | 'exec' | 'symlink' | 'gitlink'; oid: Oid }
export interface StorageToken { secret: string; expiresAt: number; [pendingResultFailure]?: string }
export interface RepoStorage {
  ensureRepo(name: string): Promise<StorageRepo>;
  fork(sourceName: string, targetName: string): Promise<StorageRepo>;
  info(name: string): Promise<StorageRepo | null>;
  resolveRef(name: string, ref: string): Promise<Oid | null>;
  readCommit(name: string, oid: Oid): Promise<StorageCommit | null>;
  listTree(name: string, oid: Oid, path: string): Promise<StorageTreeEntry[] | null>;
  readFile(name: string, oid: Oid, path: string, maxBytes?: number): Promise<Uint8Array | null>;
  mintToken(name: string, scope: 'read' | 'write', ttlSeconds: number): Promise<StorageToken>;
  revokeToken(name: string, tokenIdOrSecret: string): Promise<boolean>;
}

export type Gate<T = void> =
  | { status: 'eligible'; version: number; evidenceIds: Id[]; value: T }
  | { status: 'blocked'; version: number; code: string; reason: string; evidenceIds: Id[] };
export interface ServiceHooks {
  'issues.validate': (context: ModuleContext, issueNumber: number) => Gate<{ number: number; title: string }>;
  'issues.land': (context: ModuleContext, changeId: Id, canonicalOid: Oid) => Gate;
  'repos.inspectRevision': (context: ModuleContext, result: InspectionResult) => Gate<{ changeId: Id; revision: number; reviewManifestDigest: Digest }>;
  'verdicts.recordInspection': (context: ModuleContext, record: InspectedRevision) => Gate;
  'leases.reserve': (context: ModuleContext, changeId: Id, fences: Record<string, number>) => Gate<{ reservationFences: Record<string, number> }>;
  'leases.reservationLive': (context: ModuleContext, changeId: Id, fences: Record<string, number>) => Gate;
  'leases.releaseReservation': (context: ModuleContext, changeId: Id) => Gate;
  'leases.releaseForChange': (context: ModuleContext, changeId: Id, reason?: 'change-closed' | 'change-merged') => Gate;
  'findings.gate': (context: ModuleContext, changeId: Id, revision: number) => Gate<{ findingSetVersion: number; unresolvedIds: Id[]; pendingRound: number | null }>;
  'verdicts.gate': (context: ModuleContext, changeId: Id, revision: number) => Gate<{ verdictId: Id; reviewManifestDigest: Digest; findingSetVersion: number }>;
  'verdicts.evaluateCarry': (context: ModuleContext, result: DeltaResult) => Gate<{ verdictId: Id }>;
  'queue.onResult': (context: ModuleContext, result: StackResult | PromotionResult) => Gate<{ promotionId: Id | null }>;
  'runners.schedule': (context: ModuleContext, job: Job) => Gate<{ jobId: Id }>;
  'runners.cancelBootstrap': (context: ModuleContext, jobId: Id) => Gate;
  'queue.bootstrapStatus': (context: ModuleContext) => Gate<{ jobId: Id; state: string; blockedReason: string | null; policyDigest: Digest; profileDigest: Digest } | null>;
}
export type HookName = keyof ServiceHooks;
export type ModuleName = 'repos' | 'leases' | 'queue' | 'runners' | 'findings' | 'verdicts' | 'issues';
/** A queue-owned decision made immediately before a module mutation is dispatched. */
export interface PromotionFreezeDecision { frozen: boolean; exempt?: boolean }
export type PromotionFreezeProvider = (context: ModuleContext, request: Request) => PromotionFreezeDecision;
/** Repos owns the record; callers receive a detached, immutable projection. */
export interface ChangeView {
  readonly authorId: Id; readonly headOid: Oid | null; readonly revision: number;
  readonly issueNumber?: number | null;
  readonly status: Change['status']; readonly unitKeys: readonly string[]; readonly frozen: boolean;
  /** Optional until repos publishes immutable queue inputs; queue fails closed when required fields are absent. */
  readonly baseOid?: Oid | null; readonly candidateStorageName?: string; readonly branch?: string;
  readonly dependencyChangeIds?: readonly Id[]; readonly canonicalStorageName?: string;
  readonly scratchStorageName?: string; readonly policyId?: Id; readonly profileId?: Id;
  readonly intentKey?: string;
}
export type ChangeViewProvider = (context: ModuleContext, changeId: Id) => Gate<ChangeView>;
/** Internal, authenticated repos-to-queue handoff after the owner-only bootstrap route validates its seed. */
export interface BootstrapHandoff {
  seedStorageName: string; seedRef: string; headOid: Oid;
  canonicalStorageName: string; scratchStorageName: string; policyId: Id; profileId: Id;
  /** Reserved by repos so the bootstrap response identifies the scheduled runner job. */
  jobId?: Id;
  /** Owner-authorized replacement of an existing bootstrap with the same seed. */
  repin?: true;
}
export type BootstrapHandoffProvider = (context: ModuleContext, seed: BootstrapHandoff) => Gate<{ stackId: Id }>;
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
  /** Present on repo-coordinator contexts; catalog contexts do not read changes. */
  readChange?(changeId: Id): Gate<ChangeView>;
  /** Internal dispatch only; never exposed as an HTTP route. */
  handoffBootstrap?(seed: BootstrapHandoff): Gate<{ stackId: Id }>;
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
  /** Slice 04 registers the queue's promotion state here. An absent provider reports unfrozen. */
  promotionFreeze?: PromotionFreezeProvider;
  /** Slice 02 registers a reader of repos-owned change state here. */
  changeView?: ChangeViewProvider;
  /** Slice 02 calls this after its owner-only bootstrap request has been authenticated and validated. */
  bootstrapHandoff?: BootstrapHandoffProvider;
}
