import type { BootstrapBody, BootstrapHandoff, Branch, Change, CreateChangeBody, CreateRepoBody, FeatureModule, InspectionResult, InspectCandidateJob, Intent, ModuleContext, Repo, StorageRepo, TrustedPolicy, ValidateStackJob } from '../contracts';
import { PUBLIC_DIRECTORY_NAME } from '../contracts';
import { requireRole } from '../auth';
import { digest, encodeCursor, failure, HttpError, json, parseCursor, stableJson, unavailableGate } from '../http';
import { activeChangeLimit, costLimits, eventSequence, sqlState } from '../state';
import { covers, MAX_NORMALIZED_UNITS, resolveUnit, unitRegistry, unitsOverCapMessage } from '../leases/units';
import { parseSymbolKey } from '../leases/symbol-keys';
import { branch, ids, mergeLandedChanges, oid, pendingInitialToken, pendingResultFailure, repoName, requireReady, revokeOrphanTokens, sameTask, terminal, text, type BootstrapPending, type InspectionPending, type ProvisioningIntent } from '../repos/model';
import { isRepoPath } from '../repos/paths';
import { storedJob, withJobPolicy } from '../jobs/policy';
import { humanApprovalStatus } from './verdicts';

const list = <T>(context: ModuleContext, key: string): T[] => context.state.get<T[]>(key) ?? [];
const page = <T>(items: T[], request: Request) => {
  const offset = parseCursor(new URL(request.url).searchParams.get('cursor'));
  const selected = items.slice(offset, offset + 100);
  return { items: selected, nextCursor: offset + selected.length < items.length ? encodeCursor(offset + selected.length) : null };
};
const respond = <T>(context: ModuleContext, data: T, status = 200, headers?: HeadersInit) => {
  const response = json(data, context.version(), eventSequence(context.sql), status);
  if (headers) new Headers(headers).forEach((value, name) => response.headers.set(name, value));
  return response;
};
const jobDigest = async (job: InspectCandidateJob | ValidateStackJob) => {
  const { inputDigest: _digest, state: _state, attempt: _attempt,
    runnerId: _runnerId, fence: _fence, expiresAt: _expiresAt, version: _version, ...input } = job;
  return digest(input);
};
const fail = (status: number, code: string, message: string, details?: unknown): never => { throw new HttpError(status, code, message, details); };
const versioned = (context: ModuleContext, kind: string, relatedIds: string[], payload: Record<string, unknown>): number => {
  const version = context.nextVersion();
  context.appendEvent(kind, relatedIds, payload, version);
  return version;
};
const getChange = (context: ModuleContext, changeId: string): Change => {
  const change = list<Change>(context, 'changes').find(item => item.changeId === changeId);
  return change ?? fail(404, 'CHANGE_NOT_FOUND', 'Change not found');
};
const changeResponse = (change: Change): Change => ({ ...change, authorModel: change.authorModel ?? null });
function inspectionResponse(context: ModuleContext, change: Change): { jobId: string; revision: number; state: string } | null {
  if (change.status === 'closed') return null;
  const pending = context.state.get<InspectionPending>(`inspection:${change.changeId}`);
  if (!pending || pending.revision !== change.revision) return null;
  const job = sqlState(context.sql).get<{ job?: { state?: string } }>(`module:runners:job:${pending.jobId}`);
  const state = job?.job?.state;
  return typeof state === 'string' ? { jobId: pending.jobId, revision: pending.revision, state } : null;
}
type StartedChange = Change & { startUnitKeys?: string[] };
function storeChange(context: ModuleContext, change: Change): void {
  const all = list<Change>(context, 'changes');
  context.state.put('changes', all.some(item => item.changeId === change.changeId)
    ? all.map(item => item.changeId === change.changeId ? change : item) : [...all, change]);
  // Lease reservation reads this exact versioned change from the shared SQL state.
  context.state.put(`change:${change.changeId}`, change);
}
const ownChange = (context: ModuleContext, change: Change) => {
  if (change.authorId !== context.principal.principalId && !context.principal.roles.includes('owner')) fail(403, 'FORBIDDEN', 'Only the change author or owner can mutate this change');
};
const intentKey = (kind: 'ensure-repo' | 'fork', storageName: string) => `${kind}:${storageName}`;
const intents = (context: ModuleContext) => context.state.get<Record<string, ProvisioningIntent>>('provisioning') ?? {};
const catalogRepoCache = new WeakMap<SqlStorage, { fetchedAt: number; repo: Repo }>();
interface IntentContest {
  repoId: string; intentKey: string; childAuthorIds: [string, string]; ownerId: string;
}
const intentContests = (context: ModuleContext) => context.state.get<IntentContest[]>('intent-contests') ?? [];
const saveIntent = (context: ModuleContext, intent: ProvisioningIntent) => {
  const all = intents(context);
  all[intentKey(intent.kind, intent.storageName)] = intent;
  context.state.put('provisioning', all);
};

function scheduleInspection(context: ModuleContext, change: Change, job: InspectCandidateJob): Response {
  try {
    const gate = context.call('runners.schedule', job);
    if (gate.status === 'blocked') return failure(new HttpError(gate.code === 'MODULE_UNAVAILABLE' ? 501 : 409, gate.code, gate.reason));
    const pending = context.state.get<InspectionPending>(`inspection:${change.changeId}`);
    if (!pending || pending.jobId !== job.jobId) fail(409, 'INSPECTION_SUPERSEDED', 'Inspection request was superseded');
    context.state.put(`inspection:${change.changeId}`, { ...pending, scheduled: true });
    return respond(context, changeResponse(change), 202);
  } catch {
    return failure(new HttpError(503, 'SCHEDULE_UNAVAILABLE', 'Inspection scheduler did not acknowledge the request'));
  }
}

function scheduleBootstrap(context: ModuleContext, request: BootstrapPending, seed: BootstrapHandoff): Response {
  try {
    const gate = context.handoffBootstrap?.(seed);
    if (!gate) return failure(new HttpError(501, 'MODULE_UNAVAILABLE', 'Queue bootstrap handoff unavailable'));
    if (gate.status === 'blocked') {
      context.state.put('bootstrap', { ...request, status: 'blocked' } satisfies BootstrapPending);
      return failure(new HttpError(gate.code === 'MODULE_UNAVAILABLE' ? 501 : 409, gate.code, gate.reason));
    }
    context.state.put('bootstrap', { ...request, status: 'requested' } satisfies BootstrapPending);
    return respond(context, { jobId: request.jobId, state: 'requested' }, 202);
  } catch {
    context.state.put('bootstrap', { ...request, status: 'blocked' } satisfies BootstrapPending);
    return failure(new HttpError(503, 'SCHEDULE_UNAVAILABLE', 'Bootstrap scheduler did not acknowledge the request'));
  }
}

const activeProvisioning = (intent: ProvisioningIntent) => intent.state !== 'observed' && intent.state !== 'failed';

async function reconcile(context: ModuleContext, intent: ProvisioningIntent, retry: boolean): Promise<StorageRepo | null> {
  const tokenKey = `initial-token:${intent.storageName}`;
  try {
    const expectedDigest = await digest(intent.kind === 'ensure-repo'
      ? { kind: intent.kind, storageName: intent.storageName }
      : { kind: intent.kind, storageName: intent.storageName, sourceName: intent.sourceName });
    if (intent.requestDigest !== expectedDigest) throw new Error('PROVISIONING_INTENT_MISMATCH');
    if (intent.state === 'failed') {
      if (!retry) return null;
      // A caller retry starts a new attempt. Keep any credential from the old attempt.
      intent.polls = 0;
      intent.state = context.state.get<string>(tokenKey) ? 'token-held' : 'intent';
      delete intent.error;
      saveIntent(context, intent);
    }
    if (intent.state !== 'observed' && intent.state !== 'creating' && intent.state !== 'token-held' && intent.state !== 'revoking') {
      intent.state = 'creating';
      saveIntent(context, intent);
    }
    let observed = await context.storage.info(intent.storageName);
    if (!observed && intent.everObserved) throw new Error('PROVIDER_OBJECT_MISSING');
    if (!observed && retry && !context.state.get<string>(tokenKey)) observed = intent.kind === 'ensure-repo'
      ? await context.storage.ensureRepo(intent.storageName)
      : await context.storage.fork(intent.sourceName!, intent.storageName);
    if (observed && (observed.name !== intent.storageName || (observed.status === 'ready' && !observed.remote))) throw new Error('PROVIDER_IDENTITY_MISMATCH');
    const returnedToken = observed?.[pendingInitialToken];
    if (returnedToken && context.state.get<string>(tokenKey) && context.state.get<string>(tokenKey) !== returnedToken) throw new Error('INITIAL_TOKEN_CONFLICT');
    if (returnedToken) {
      context.state.put(tokenKey, returnedToken);
      intent.state = 'token-held';
      saveIntent(context, intent);
    }
    if (observed?.[pendingResultFailure]) throw new Error(observed[pendingResultFailure]);
    const heldToken = context.state.get<string>(tokenKey);
    if (observed?.status === 'ready') {
      if (intent.state !== 'observed') {
        intent.state = 'revoking';
        saveIntent(context, intent);
        if (heldToken) {
          if (!await context.storage.revokeToken(intent.storageName, heldToken)) throw new Error('INITIAL_TOKEN_REVOCATION_FAILED');
          context.state.delete(tokenKey);
        }
        if (!intent.everObserved) {
          await (context.storage as typeof context.storage & { [revokeOrphanTokens]?: (name: string) => Promise<void> })[revokeOrphanTokens]?.(intent.storageName);
        }
      }
      intent.state = 'observed';
      intent.everObserved = true;
      intent.retryAt = 0;
      delete intent.error;
      saveIntent(context, intent);
      return observed;
    }
    intent.polls += 1;
    if (intent.polls >= 30) {
      intent.state = 'failed';
      intent.error = 'Provider did not become ready within 30 status polls';
      intent.retryAt = 0;
      saveIntent(context, intent);
      return observed;
    }
    intent.state = heldToken ? 'token-held' : 'creating';
    intent.retryAt = context.now() + 1000;
    delete intent.error;
    saveIntent(context, intent);
    return observed;
  } catch {
    intent.state = 'failed';
    intent.error = 'Provider operation failed; retry the same request after checking provider state';
    intent.retryAt = 0;
    saveIntent(context, intent);
    return null;
  }
}

async function syncPublicDirectory(context: ModuleContext, repo: Repo): Promise<void> {
  // Module-only fixtures omit CONCORD_MODE; actual Worker contexts always supply it.
  if (!context.env?.CONCORD_MODE || !context.env.TENANT_CATALOG) return;
  const directory = context.env.TENANT_CATALOG.get(context.env.TENANT_CATALOG.idFromName(PUBLIC_DIRECTORY_NAME));
  const response = await directory.fetch(new Request('https://concord.internal/internal/repo-directory', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-concord-tenant': context.tenantId },
    body: JSON.stringify({ repoId: repo.repoId, public: repo.public === true }),
  }));
  if (response.status === 409) fail(409, 'PUBLIC_REPO_NAME_CONFLICT', 'Public repository name belongs to another tenant');
  if (!response.ok) fail(503, 'DIRECTORY_UNAVAILABLE', 'Public repository directory unavailable');
}

async function catalogCreate(context: ModuleContext, body: CreateRepoBody): Promise<Response> {
  requireRole(context.principal, 'owner');
  const repoId = repoName(body.name);
  const policy = context.trusted.policies[body.policyId];
  const profile = context.trusted.profiles[body.profileId];
  if (!policy || !profile) fail(400, 'UNKNOWN_POLICY_OR_PROFILE', 'Trusted policy and profile are required');
  if (body.public !== undefined && typeof body.public !== 'boolean') fail(400, 'INVALID_INPUT', 'public must be a boolean');
  let repo = list<Repo>(context, 'catalog:index').find(item => item.repoId === repoId);
  if (repo && (repo.policyId !== policy.id || repo.profileId !== profile.id)) fail(409, 'REPO_NAME_CONFLICT', 'Repository name belongs to another configuration');
  if (!repo) {
    const canonicalStorageName = `concord-r-${crypto.randomUUID()}`;
    const requestDigest = await digest({ kind: 'ensure-repo', storageName: canonicalStorageName });
    repo = {
      repoId, tenantId: context.tenantId, displayName: repoId,
      canonicalStorageName, defaultBranch: 'main', observedCanonicalOid: null,
      policyId: policy.id, policyDigest: policy.digest, profileId: profile.id, status: 'provisioning',
      public: false, version: 0,
    };
    context.transaction(() => {
      const current = list<Repo>(context, 'catalog:index');
      if (current.some(item => item.repoId === repoId)) fail(409, 'REPO_NAME_CONFLICT', 'Repository already exists');
      if (current.length >= costLimits(context.trusted).maxReposPerTenant) fail(429, 'TENANT_REPO_LIMIT', 'Tenant repository limit reached');
      repo!.version = versioned(context, 'repo.provisioning', [repoId], { storageName: repo!.canonicalStorageName });
      context.state.put('catalog:index', [...current, repo!]);
      saveIntent(context, { kind: 'ensure-repo', storageName: repo!.canonicalStorageName, requestDigest, state: 'intent', retryAt: context.now(), polls: 0 });
    });
  }
  const intent = intents(context)[intentKey('ensure-repo', repo.canonicalStorageName)];
  if (!intent) fail(503, 'PROVISIONING_INTENT_MISSING', 'Repository provisioning intent missing');
  await reconcile(context, intent, true);
  const status = intent.state === 'observed' ? 'ready' : intent.state === 'failed' ? 'blocked' : 'provisioning';
  if (repo.status !== status) context.transaction(() => {
    repo!.status = status;
    repo!.version = versioned(context, `repo.${status}`, [repoId], {});
    context.state.put('catalog:index', list<Repo>(context, 'catalog:index').map(item => item.repoId === repoId ? repo! : item));
  });
  if (status === 'blocked') fail(503, 'PROVISIONING_FAILED', 'Canonical repository provisioning failed; retry the same name');
  if (body.public !== undefined && repo.public !== body.public) {
    // Reserve before publication; revoke in the catalog before deleting the
    // directory entry. Anonymous reads verify both records and fail closed.
    if (body.public) await syncPublicDirectory(context, { ...repo, public: true });
    const next = body.public;
    context.transaction(() => {
      const current = list<Repo>(context, 'catalog:index');
      const item = current.find(entry => entry.repoId === repoId);
      if (item) {
        item.public = next;
        item.version = versioned(context, 'repo.updated', [repoId], { public: next });
        context.state.put('catalog:index', current);
        if (!next) context.state.put(`directory-removal:${repoId}`, true);
      }
    });
    repo = list<Repo>(context, 'catalog:index').find(item => item.repoId === repoId) ?? repo;
    if (!body.public) {
      await syncPublicDirectory(context, repo);
      context.state.delete(`directory-removal:${repoId}`);
    }
  } else if (body.public === false && context.state.get<boolean>(`directory-removal:${repoId}`)) {
    await syncPublicDirectory(context, repo);
    context.state.delete(`directory-removal:${repoId}`);
  }
  return respond(context, repo, status === 'ready' ? 201 : 202);
}

async function catalogRepo(context: ModuleContext, maxAgeMs = 0): Promise<Repo> {
  const cached = catalogRepoCache.get(context.sql);
  const now = context.now();
  if (maxAgeMs > 0 && cached && now >= cached.fetchedAt && now - cached.fetchedAt < maxAgeMs) return cached.repo;
  const stub = context.env.TENANT_CATALOG.get(context.env.TENANT_CATALOG.idFromName(`tenant:${context.tenantId}`));
  let cursor: string | null = null;
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const url = `https://concord.test/v1/repos${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response = await stub.fetch(new Request(url, { headers: {
      'x-concord-principal': JSON.stringify(context.principal), 'x-concord-tenant': context.tenantId,
    } }));
    if (!response.ok) fail(503, 'CATALOG_UNAVAILABLE', 'Repository catalog unavailable');
    const envelope = await response.json() as { data: { items: Repo[]; nextCursor: string | null } };
    const catalog = envelope.data.items.find(item => item.repoId === context.repoId);
    if (catalog) {
      catalog.public = catalog.public === true;
      const stored = context.state.get<Repo>('repo');
      const repo = stored?.canonicalStorageName === catalog.canonicalStorageName
        && (stored.observedCanonicalOid !== null || catalog.observedCanonicalOid === null)
        ? { ...catalog, observedCanonicalOid: stored.observedCanonicalOid }
        : catalog;
      // The local in-process fake stores objects in each DO's SQLite state.
      // Reconcile its deterministic empty canonical name in the coordinator.
      if (context.env.CONCORD_MODE === 'local' && context.env.STORAGE_BACKEND === 'fake' && repo.status === 'ready') {
        if (!await context.storage.info(repo.canonicalStorageName)) {
          if (context.state.get<boolean>('fake-canonical-materialized')) fail(503, 'PROVIDER_REPO_MISSING', 'Local fake canonical repository disappeared');
          await context.storage.ensureRepo(repo.canonicalStorageName);
        }
        context.state.put('fake-canonical-materialized', true);
      }
      if (stableJson(stored) !== stableJson(repo)) context.state.put('repo', repo);
      catalogRepoCache.set(context.sql, { fetchedAt: now, repo });
      return repo;
    }
    cursor = envelope.data.nextCursor;
    if (!cursor) break;
  }
  return fail(404, 'REPO_NOT_FOUND', 'Repository not found');
}

async function repoDetail(context: ModuleContext): Promise<Response> {
  const catalog = await catalogRepo(context, 60_000);
  const repo = { ...catalog };
  if (repo.status === 'ready') {
    repo.observedCanonicalOid = await context.storage.resolveRef(repo.canonicalStorageName, 'refs/heads/main');
    if (stableJson(context.state.get<Repo>('repo')) !== stableJson(repo)) context.state.put('repo', repo);
    const cached = catalogRepoCache.get(context.sql);
    if (cached) catalogRepoCache.set(context.sql, { ...cached, repo });
  }
  const pending = context.state.get<BootstrapPending>('bootstrap');
  const queue = pending ? context.call('queue.bootstrapStatus') : null;
  const active = queue?.status === 'eligible' ? queue.value : null;
  return respond(context, { ...repo, activeChangeLimit: activeChangeLimit(context.trusted, repo.repoId),
    bootstrap: pending ? { ...pending, state: active?.state ?? pending.status,
    blockedReason: active?.blockedReason ?? null } : null }, repo.status === 'provisioning' ? 202 : 200);
}

const MAX_CONTENT_BYTES = 64 * 1024;
const CANONICAL_READ_CACHE_TTL = 31_536_000;
const CANONICAL_READ_LRU_LIMIT = 200;
const canonicalReadLruBySql = new WeakMap<SqlStorage, Map<string, CanonicalReadData>>();
type CanonicalReadData = Record<string, unknown>;
function cacheLru(sql: SqlStorage): Map<string, CanonicalReadData> {
  let cache = canonicalReadLruBySql.get(sql);
  if (!cache) { cache = new Map(); canonicalReadLruBySql.set(sql, cache); }
  return cache;
}
function cacheLruGet(sql: SqlStorage, key: string): CanonicalReadData | undefined {
  const lru = cacheLru(sql);
  const value = lru.get(key);
  if (value) {
    lru.delete(key);
    lru.set(key, value);
  }
  return value;
}
function cacheLruPut(sql: SqlStorage, key: string, value: CanonicalReadData): void {
  const lru = cacheLru(sql);
  lru.delete(key);
  lru.set(key, value);
  if (lru.size > CANONICAL_READ_LRU_LIMIT) {
    lru.delete(lru.keys().next().value!);
  }
}
function canonicalReadCacheKey(storageName: string, commitOid: string, kind: string, path: string): string {
  return `https://concord-cache.invalid/canonical-read/${encodeURIComponent(storageName)}/${commitOid}/${kind}/${encodeURIComponent(path)}`;
}
async function canonicalReadCachedData(context: ModuleContext, key: string): Promise<CanonicalReadData | undefined> {
  const memory = cacheLruGet(context.sql, key);
  if (memory) return memory;
  try {
    const cached = await (caches as CacheStorage & { default: Cache }).default.match(key);
    if (!cached) return undefined;
    const data = await cached.json() as CanonicalReadData;
    cacheLruPut(context.sql, key, data);
    return data;
  } catch { return undefined; }
}
async function cacheCanonicalReadData(context: ModuleContext, key: string, data: CanonicalReadData): Promise<void> {
  cacheLruPut(context.sql, key, data);
  try {
    await (caches as CacheStorage & { default: Cache }).default.put(key, new Response(JSON.stringify(data), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${CANONICAL_READ_CACHE_TTL}, immutable` },
    }));
  } catch { /* Cache API availability must not affect a successful canonical read. */ }
}
function canonicalPath(value: string | null, allowEmpty = false): string {
  if (value === null && allowEmpty) return '';
  if (!isRepoPath(value, allowEmpty)) {
    return fail(400, 'INVALID_PATH', 'Invalid repository path');
  }
  return value;
}
async function canonicalRead(context: ModuleContext, request: Request, kind: 'tree' | 'file' | 'readme'): Promise<Response> {
  const repo = await catalogRepo(context, 60_000);
  requireReady(repo);
  const params = new URL(request.url).searchParams;
  const requestedOid = params.get('oid');
  // A present OID is validated before touching main, including the empty string.
  const commitOid = requestedOid === null ? null : oid(requestedOid);
  const contentPath = kind === 'tree' ? canonicalPath(params.get('path'), true) : kind === 'readme' ? 'README.md' : canonicalPath(params.get('path'));
  const knownCanonicalOid = requestedOid === null || requestedOid === repo.observedCanonicalOid ? repo.observedCanonicalOid : null;
  const resolvedOid = commitOid ?? knownCanonicalOid ?? await context.storage.resolveRef(repo.canonicalStorageName, 'refs/heads/main');
  if (!resolvedOid) return fail(404, 'MAIN_NOT_FOUND', 'Canonical main is empty');
  const knownCanonicalCommit = knownCanonicalOid === resolvedOid;
  const cacheKey = canonicalReadCacheKey(repo.canonicalStorageName, resolvedOid, kind, contentPath);
  const cacheHeaders = requestedOid !== null ? { 'cache-control': 'private, max-age=86400, immutable' } : undefined;
  let unitFiles: Record<string, string> | undefined;
  let rowTables: Record<string, string> | undefined;
  if (kind === 'tree') {
    const policy = context.trusted.policies[repo.policyId];
    if (!policy || policy.digest !== repo.policyDigest) return fail(503, 'UNIT_POLICY_UNAVAILABLE', 'Trusted unit policy unavailable');
    unitFiles = Object.fromEntries(Object.values(policy.units).map(unit => [unit.canonicalKey, unit.file]));
    rowTables = Object.fromEntries((policy.tables ?? []).map(table => [table.name, table.file]));
  }
  const cachedData = await canonicalReadCachedData(context, cacheKey);
  if (cachedData) return respond(context, kind === 'tree' ? { ...cachedData, unitFiles, rowTables } : cachedData, 200, cacheHeaders);
  const commit = knownCanonicalCommit ? null : await context.storage.readCommit(repo.canonicalStorageName, resolvedOid);
  if (!knownCanonicalCommit && !commit) return fail(404, 'COMMIT_NOT_FOUND', 'Commit not found');
  if (kind === 'tree') {
    const path = contentPath;
    const allEntries = await context.storage.listTree(repo.canonicalStorageName, resolvedOid, path, commit?.treeOid);
    if (!allEntries) return fail(404, 'TREE_NOT_FOUND', 'Directory not found');
    const data = { oid: resolvedOid, path, entries: allEntries.slice(0, 1000), truncated: allEntries.length > 1000, unitFiles, rowTables };
    await cacheCanonicalReadData(context, cacheKey, data);
    return respond(context, data, 200, cacheHeaders);
  }
  const path = contentPath;
  let bytes: Uint8Array | null;
  try {
    bytes = await context.storage.readFile(repo.canonicalStorageName, resolvedOid, path, MAX_CONTENT_BYTES);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('FILE_TOO_LARGE')) return fail(413, 'FILE_TOO_LARGE', 'File exceeds the 64 KiB display limit');
    throw cause;
  }
  if (!bytes) return fail(404, 'FILE_NOT_FOUND', 'File not found');
  if (bytes.byteLength > MAX_CONTENT_BYTES) return fail(413, 'FILE_TOO_LARGE', 'File exceeds the 64 KiB display limit');
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail(415, 'BINARY_FILE', 'Binary files cannot be displayed'); }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(content)) fail(415, 'BINARY_FILE', 'Binary files cannot be displayed');
  const data = { oid: resolvedOid, path, content, size: bytes.byteLength };
  await cacheCanonicalReadData(context, cacheKey, data);
  return respond(context, data, 200, cacheHeaders);
}

function declaredUnitKeys(raw: unknown, policy: TrustedPolicy, allowUnknown = false): string[] {
  if (!Array.isArray(raw) || raw.some(key => typeof key !== 'string' ||
      !(/^[A-Za-z0-9._:/-]{1,128}$/.test(key) || parseSymbolKey(key) !== null)) ||
    new Set(raw).size !== raw.length) fail(400, 'INVALID_INPUT', 'unitKeys must contain unique identifiers');
  const rawKeys = raw as string[];
  const registry = unitRegistry(policy);
  const unitKeys = [...new Set(rawKeys.map(key => {
    try { return resolveUnit(registry, key).key; }
    catch (error) {
      if (allowUnknown && error instanceof HttpError && error.code === 'UNKNOWN_UNIT') return key;
      throw error;
    }
  }))].sort();
  if (unitKeys.length > MAX_NORMALIZED_UNITS) fail(422, 'INVALID_UNITS', unitsOverCapMessage(unitKeys.length));
  return unitKeys;
}

function changeInput(body: CreateChangeBody, policy: TrustedPolicy) {
  const intentKey = text(body.intentKey, 'intentKey', 128);
  const intentText = text(body.intentText, 'intentText');
  const baseOid = body.baseOid === null ? null : oid(body.baseOid);
  const ref = branch(body.branch);
  const unitKeys = declaredUnitKeys(body.unitKeys, policy, true);
  const dependencyChangeIds = ids(body.dependencyChangeIds, 'dependencyChangeIds');
  const attempt = body.attempt === undefined ? 1 : body.attempt;
  const startScope = (body as CreateChangeBody & { startScope?: unknown }).startScope;
  if (startScope !== undefined && startScope !== true) fail(400, 'INVALID_INPUT', 'startScope must be true');
  if (body.issueNumber !== undefined && (!Number.isSafeInteger(body.issueNumber) || body.issueNumber < 1)) fail(400, 'INVALID_ISSUE_NUMBER', 'issueNumber must be a positive integer');
  if (!Number.isSafeInteger(attempt) || attempt < 1) fail(400, 'INVALID_ATTEMPT', 'attempt must be a positive integer');
  return { intentKey, intentText, baseOid, branch: ref, unitKeys, dependencyChangeIds, attempt, issueNumber: body.issueNumber ?? null, startScope: startScope === true };
}

async function authorizeIntentContest(context: ModuleContext, body: Record<string, unknown>): Promise<Response> {
  requireRole(context.principal, 'owner');
  const repo = await catalogRepo(context);
  requireReady(repo);
  if (repo.policyId !== 'dispatch-lab' || repo.profileId !== 'dispatch-lab') {
    fail(409, 'CONTEST_REPO_REQUIRED', 'Intent contests require the dispatch-lab repository configuration');
  }
  const key = text(body.intentKey, 'intentKey', 128);
  const authors = ids(body.childAuthorIds, 'childAuthorIds');
  if (authors.length !== 2 || authors.some(author => !/^[A-Za-z0-9_-]{1,64}$/.test(author))) {
    fail(400, 'INVALID_CONTEST', 'Exactly two distinct child authors are required');
  }
  if (intentContests(context).some(item => item.intentKey === key)) {
    fail(409, 'CONTEST_EXISTS', 'Intent contest already exists');
  }
  const contest: IntentContest = { repoId: repo.repoId, intentKey: key,
    childAuthorIds: [authors[0], authors[1]], ownerId: context.principal.principalId };
  context.state.put('intent-contests', [...intentContests(context), contest]);
  versioned(context, 'repo.intent_contest_authorized', [repo.repoId, key], { childAuthorIds: authors });
  return respond(context, contest, 201);
}

async function changeCreate(context: ModuleContext, body: CreateChangeBody): Promise<Response> {
  requireRole(context.principal, 'owner', 'agent');
  const repo = await catalogRepo(context);
  requireReady(repo);
  const input = changeInput(body, context.trusted.policies[repo.policyId]);
  if (input.issueNumber !== null) {
    const linked = context.call('issues.validate', input.issueNumber);
    if (linked.status === 'blocked') fail(409, linked.code, linked.reason);
  }
  const all = list<Change>(context, 'changes');
  const matchingIntents = list<Intent>(context, 'intents').filter(item => item.intentKey === input.intentKey);
  const ownIntent = matchingIntents.find(item => all.some(change =>
    change.changeId === item.changeId && change.authorId === context.principal.principalId));
  const otherIntent = matchingIntents.find(item => all.some(change =>
    change.changeId === item.changeId && change.authorId !== context.principal.principalId));
  const otherChange = otherIntent ? getChange(context, otherIntent.changeId) : null;
  const contest = intentContests(context).find(item => item.repoId === repo.repoId && item.intentKey === input.intentKey);
  const contestChild = repo.policyId === 'dispatch-lab' && repo.profileId === 'dispatch-lab' &&
    contest?.ownerId !== undefined && contest.childAuthorIds.includes(context.principal.principalId) &&
    otherIntent !== undefined && !otherIntent.terminal && otherChange !== null &&
    contest.childAuthorIds.includes(otherChange.authorId) &&
    matchingIntents.every(item => {
      const change = all.find(candidate => candidate.changeId === item.changeId);
      return change && contest.childAuthorIds.includes(change.authorId);
    }) && otherChange.baseOid === input.baseOid && sameTask(otherChange, input);
  if (otherIntent && !contestChild) fail(409, 'INTENT_OWNED', 'Intent key belongs to another author');
  const priorIntent = ownIntent;
  if (priorIntent) {
    const prior = getChange(context, priorIntent.changeId);
    if ((prior.issueNumber ?? null) !== input.issueNumber) fail(409, 'INTENT_CONFLICT', 'Intent key was used with another issue');
    if (Boolean((prior as StartedChange).startUnitKeys) !== input.startScope) fail(409, 'INTENT_CONFLICT', 'Intent key was used with another start scope');
    if (!sameTask(prior, input)) fail(409, 'INTENT_CONFLICT', 'Intent key was used with different task content');
    if (!terminal(prior)) {
      if (body.attempt !== undefined && input.attempt !== priorIntent.attempt) fail(409, 'ATTEMPT_CONFLICT', 'Active intent attempt differs');
      const pending = intents(context)[intentKey('fork', prior.candidateStorageName)];
      if (!pending) fail(503, 'PROVISIONING_INTENT_MISSING', 'Candidate fork provisioning intent missing');
      await reconcile(context, pending, true);
      const provisioning = intents(context)[intentKey('fork', prior.candidateStorageName)];
      if (provisioning?.state === 'failed') fail(503, 'PROVISIONING_FAILED', 'Candidate fork provisioning failed; retry the same intent');
      return respond(context, { ...changeResponse(prior), provisioning }, provisioning?.state === 'observed' ? 200 : 202);
    }
    if (body.attempt === undefined || input.attempt !== priorIntent.attempt + 1) fail(409, 'ATTEMPT_REQUIRED', 'Terminal intent needs the next explicit attempt');
  } else if (input.attempt !== 1) fail(409, 'ATTEMPT_CONFLICT', 'First attempt must be 1');
  const main = await context.storage.resolveRef(repo.canonicalStorageName, 'refs/heads/main');
  if (main === null) {
    requireRole(context.principal, 'owner');
    if (input.baseOid !== null) fail(409, 'BASE_MISMATCH', 'Empty repository requires a seed draft');
  } else {
    if (input.baseOid === null) fail(409, 'BASE_REQUIRED', 'An initialized repository requires a base OID');
    if (!await context.storage.readCommit(repo.canonicalStorageName, input.baseOid as string)) fail(422, 'BASE_NOT_FOUND', 'Base commit does not exist');
  }
  const active = all.filter(change => !terminal(change)).length;
  const limit = activeChangeLimit(context.trusted, repo.repoId);
  if (active >= limit) fail(429, 'CHANGE_LIMIT', 'Active change limit reached', { limit, active });
  await reserveFork(context);
  const changeId = crypto.randomUUID();
  const candidateStorageName = `concord-f-${changeId}`;
  const requestDigest = await digest({ kind: 'fork', sourceName: repo.canonicalStorageName, storageName: candidateStorageName });
  const change: StartedChange = {
    changeId, repoId: repo.repoId, authorId: context.principal.principalId, authorModel: context.principal.model ?? null,
    ...(context.principal.agent ? { authorAgent: { ...context.principal.agent, startedAt: context.principal.agentStartedAt ?? context.now(),
      ...(context.principal.agentName ? { name: context.principal.agentName } : {}) } } : {}), intentKey: input.intentKey,
    intentText: input.intentText, candidateStorageName, branch: input.branch, baseOid: input.baseOid,
    headOid: null, revision: 0, unitKeys: input.unitKeys, ...(input.startScope ? { startUnitKeys: [...input.unitKeys] } : {}), dependencyChangeIds: input.dependencyChangeIds,
    status: 'draft', version: 0, issueNumber: input.issueNumber,
  };
  context.transaction(() => {
    change.version = versioned(context, 'change.draft', [changeId], { candidateStorageName });
    storeChange(context, change);
    context.state.put('intents', [...list<Intent>(context, 'intents').filter(item => item.changeId !== priorIntent?.changeId),
      { repoId: repo.repoId, intentKey: input.intentKey, changeId, attempt: input.attempt, terminal: false, version: change.version } satisfies Intent]);
    saveIntent(context, { kind: 'fork', sourceName: repo.canonicalStorageName, storageName: candidateStorageName, requestDigest, state: 'intent', retryAt: context.now(), polls: 0 });
  });
  await reconcile(context, intents(context)[intentKey('fork', candidateStorageName)], true);
  if (intents(context)[intentKey('fork', candidateStorageName)].state === 'failed') fail(503, 'PROVISIONING_FAILED', 'Candidate fork provisioning failed; retry the same intent');
  return respond(context, { ...changeResponse(change), provisioning: intents(context)[intentKey('fork', candidateStorageName)] }, intents(context)[intentKey('fork', candidateStorageName)].state === 'observed' ? 201 : 202);
}

/** Owner-triggered, idempotent repair for landings made before changes were marked merged. */
async function repairLandedChanges(context: ModuleContext): Promise<Response> {
  requireRole(context.principal, 'owner');
  const repo = await catalogRepo(context);
  requireReady(repo);
  const changes = list<Change>(context, 'changes').filter(change => change.status !== 'merged');
  const queueState = sqlState(context.sql).get<{ entries: Array<{ changeId: string; state: string }> }>('module:queue:data');
  const landed = new Set((queueState?.entries ?? []).filter(entry => entry.state === 'landed').map(entry => entry.changeId));
  const outstanding = new Set(changes.filter(change => landed.has(change.changeId)).map(change => change.changeId));
  if (!outstanding.size) return respond(context, { repairedChangeIds: [] });
  const events = context.sql.exec<{ related_ids: string; payload: string }>(
    "SELECT related_ids, payload FROM concord_events WHERE kind = 'queue.promotion_applied' ORDER BY sequence",
  ).toArray();
  const evidence = new Map<string, string>();
  for (const event of events) {
    const payload = JSON.parse(event.payload) as { canonicalOid?: string };
    if (!payload.canonicalOid || !/^[a-f0-9]{40}$/.test(payload.canonicalOid)) continue;
    for (const id of JSON.parse(event.related_ids) as string[]) if (outstanding.has(id)) evidence.set(id, payload.canonicalOid);
  }
  const main = await context.storage.resolveRef(repo.canonicalStorageName, 'refs/heads/main');
  if (!main) return respond(context, { repairedChangeIds: [] });
  const targets = new Set(evidence.values());
  const found = new Set<string>();
  const seen = new Set<string>();
  const pending = [main];
  while (pending.length && found.size < targets.size) {
    const commitOid = pending.pop()!;
    if (seen.has(commitOid)) continue;
    seen.add(commitOid);
    if (targets.has(commitOid)) found.add(commitOid);
    const commit = await context.storage.readCommit(repo.canonicalStorageName, commitOid);
    if (!commit) throw new HttpError(503, 'CANONICAL_HISTORY_UNAVAILABLE', 'Canonical commit history is unavailable');
    pending.push(...commit.parents);
  }
  const repairedChangeIds = context.transaction(() => {
    const repaired: string[] = [];
    for (const [changeId, canonicalOid] of evidence) {
      if (found.has(canonicalOid)) repaired.push(...mergeLandedChanges(context, [changeId], canonicalOid));
    }
    return repaired;
  });
  return respond(context, { repairedChangeIds });
}

async function registerBranch(context: ModuleContext, body: Record<string, unknown>): Promise<Response> {
  const repo = await catalogRepo(context);
  requireReady(repo);
  const storageName = text(body.storageName, 'storageName', 128);
  const ref = branch(body.ref);
  const head = oid(body.observedHead);
  const ownerId = text(body.ownerId, 'ownerId', 64);
  if (ownerId !== context.principal.principalId) fail(403, 'FORBIDDEN', 'Branch owner must be the caller');
  const change = list<Change>(context, 'changes').find(item => item.candidateStorageName === storageName && item.authorId === ownerId);
  if (!change || change.branch !== ref || terminal(change)) return fail(403, 'FORK_NOT_OWNED', 'Branch is outside the caller’s active candidate fork');
  if (change.status === 'queued' || change.status === 'checking') fail(409, 'CHANGE_FROZEN', 'Candidate branch cannot change during queue or promotion');
  if ((await context.storage.info(storageName))?.status !== 'ready') fail(409, 'FORK_NOT_READY', 'Candidate fork is not ready');
  if (await context.storage.resolveRef(storageName, ref) !== head || !await context.storage.readCommit(storageName, head)) fail(422, 'HEAD_NOT_FOUND', 'Candidate ref does not resolve to the supplied commit');
  const branches = list<Branch>(context, 'branches');
  const existing = branches.find(item => item.storageName === storageName && item.ref === ref);
  if (existing && existing.observedHead === head) return respond(context, existing);
  const record: Branch = { logicalRepoId: repo.repoId, storageName, ref, ownerId, observedHead: head, version: 0 };
  context.transaction(() => {
    record.version = versioned(context, 'branch.registered', [change.changeId], { ref, head });
    context.state.put('branches', [...branches.filter(item => item !== existing), record]);
    if (existing && existing.observedHead !== head) {
      change.status = 'draft';
      change.version = record.version;
      storeChange(context, change);
      context.state.delete(`review:${change.changeId}`);
      context.state.delete(`inspection:${change.changeId}`);
      context.state.delete(`inspection-job:${change.changeId}`);
      context.state.delete(`verified:${change.changeId}`);
      context.state.put('queueGeneration', (context.state.get<number>('queueGeneration') ?? 0) + 1);
    }
  });
  return respond(context, record, existing ? 200 : 201);
}

export async function reserveTokenMint(context: ModuleContext): Promise<void> {
  // Module-only fixtures omit CONCORD_MODE; actual Worker contexts always supply it.
  if (!context.env?.CONCORD_MODE) return;
  if (!context.env.TENANT_CATALOG) fail(503, 'CATALOG_UNAVAILABLE', 'Token quota unavailable');
  const quota = context.env.TENANT_CATALOG.get(context.env.TENANT_CATALOG.idFromName(`tenant:${context.tenantId}`));
  const reservation = await quota.fetch(new Request('https://concord.test/internal/token-quota', { method: 'POST', headers: {
    'x-concord-principal': JSON.stringify(context.principal), 'x-concord-tenant': context.tenantId,
  } }));
  if (!reservation.ok) {
    if (reservation.status === 429) fail(429, 'TENANT_TOKEN_LIMIT', 'Tenant daily token mint limit reached');
    fail(503, 'CATALOG_UNAVAILABLE', 'Token quota unavailable');
  }
}

async function reserveFork(context: ModuleContext): Promise<void> {
  if (!context.env?.CONCORD_MODE) return;
  if (!context.env.TENANT_CATALOG) fail(503, 'CATALOG_UNAVAILABLE', 'Fork quota unavailable');
  const quota = context.env.TENANT_CATALOG.get(context.env.TENANT_CATALOG.idFromName(`tenant:${context.tenantId}`));
  const reservation = await quota.fetch(new Request('https://concord.test/internal/fork-quota', { method: 'POST', headers: {
    'x-concord-principal': JSON.stringify(context.principal), 'x-concord-tenant': context.tenantId,
  } }));
  if (!reservation.ok) {
    if (reservation.status === 429) fail(429, 'TENANT_FORK_LIMIT', 'Tenant fork limit reached');
    fail(503, 'CATALOG_UNAVAILABLE', 'Fork quota unavailable');
  }
}

async function gitToken(context: ModuleContext, body: Record<string, unknown>): Promise<Response> {
  const repo = await catalogRepo(context);
  requireReady(repo);
  const storageName = text(body.storageName, 'storageName', 128);
  const scope = body.scope;
  const ttlSeconds = body.ttlSeconds;
  if (scope !== 'read' && scope !== 'write') fail(400, 'INVALID_SCOPE', 'Scope must be read or write');
  if (!Number.isInteger(ttlSeconds) || Number(ttlSeconds) < 60 || Number(ttlSeconds) > 600) fail(400, 'INVALID_TTL', 'Token TTL must be 60 to 600 seconds');
  const change = list<Change>(context, 'changes').find(item => item.candidateStorageName === storageName && !terminal(item));
  const own = change?.authorId === context.principal.principalId;
  if (storageName === repo.canonicalStorageName) {
    if (scope !== 'read') fail(403, 'CANONICAL_WRITE_FORBIDDEN', 'Canonical write tokens are reserved for the promoter');
    if (!context.principal.roles.some(role => role === 'agent' || role === 'owner')) {
      fail(403, 'FORK_NOT_OWNED', 'The caller does not own this candidate fork');
    }
  } else if (!own && !(scope === 'read' && change && context.principal.roles.some(role => role === 'reviewer' || role === 'owner'))) {
    fail(403, 'FORK_NOT_OWNED', 'The caller does not own this candidate fork');
  }
  const storageRepo = await context.storage.info(storageName);
  if (storageRepo?.status !== 'ready') fail(409, 'STORAGE_NOT_READY', 'Storage is not ready');
  const mintKey = `mint-token:${storageName}`;
  const prior = context.state.get<string>(mintKey);
  if (prior) {
    if (!await context.storage.revokeToken(storageName, prior)) fail(503, 'TOKEN_REVOCATION_FAILED', 'Token cleanup is pending');
    context.state.delete(mintKey);
  }
  await reserveTokenMint(context);
  const token = await context.storage.mintToken(storageName, scope as 'read' | 'write', Number(ttlSeconds));
  if (token[pendingResultFailure]) {
    context.state.put(mintKey, token.secret);
    if (await context.storage.revokeToken(storageName, token.secret)) context.state.delete(mintKey);
    fail(503, 'TOKEN_RESULT_INVALID', 'Token provider response was invalid');
  }
  return respond(context, { storageName, remote: storageRepo!.remote, scope, ...token });
}

async function publish(context: ModuleContext, changeId: string, body: Record<string, unknown>): Promise<Response> {
  const repo = await catalogRepo(context);
  requireReady(repo);
  const change = getChange(context, changeId);
  ownChange(context, change);
  if (change.status !== 'draft' && change.status !== 'ready' && change.status !== 'blocked') fail(409, 'CHANGE_FROZEN', 'Change is frozen or terminal');
  const baseOid = body.baseOid === null ? null : oid(body.baseOid);
  const headOid = oid(body.headOid);
  const ref = branch(body.branch);
  const unitKeys = declaredUnitKeys(body.unitKeys, context.trusted.policies[repo.policyId]);
  const startScope = (change as StartedChange).startUnitKeys;
  if (startScope) {
    const scopeRegistry = unitRegistry(context.trusted.policies[repo.policyId]);
    const outside = unitKeys.filter(key => !startScope.some(scope => covers(resolveUnit(scopeRegistry, scope), resolveUnit(scopeRegistry, key))));
    if (outside.length) fail(409, 'START_SCOPE_CONFLICT', `Units outside the original start scope: ${outside.join(', ')}`);
  }
  if (!body.leaseFences || typeof body.leaseFences !== 'object' || Array.isArray(body.leaseFences)) fail(400, 'INVALID_LEASE_FENCES', 'leaseFences must be a map');
  const leaseFences = body.leaseFences as Record<string, unknown>;
  if (unitKeys.length > 0 && Object.keys(leaseFences).length === 0 ||
      Object.values(leaseFences).some(value => !Number.isSafeInteger(value) || Number(value) < 1))
    fail(400, 'INVALID_LEASE_FENCES', 'leaseFences must contain positive fences');
  if (baseOid === null || change.baseOid === null) fail(409, 'SEED_REQUIRES_BOOTSTRAP', 'Seed drafts use owner bootstrap');
  if (ref !== change.branch) fail(409, 'BRANCH_MISMATCH', 'Change branch differs');
  const registry = unitRegistry(context.trusted.policies[repo.policyId]);
  const claims = Object.keys(leaseFences).map(key => resolveUnit(registry, key));
  if (unitKeys.some(key => !claims.some(claim => covers(claim, resolveUnit(registry, key))))) fail(400, 'INVALID_LEASE_FENCES', 'leaseFences must cover every declared unit');
  const registered = list<Branch>(context, 'branches').find(item => item.storageName === change.candidateStorageName && item.ref === ref && item.ownerId === change.authorId);
  if (!registered || registered.observedHead !== headOid) fail(409, 'BRANCH_NOT_REGISTERED', 'Register the current fork branch before publishing');
  if (await context.storage.resolveRef(change.candidateStorageName, ref) !== headOid) fail(409, 'HEAD_MOVED', 'Registered candidate ref changed');
  const head = await context.storage.readCommit(change.candidateStorageName, headOid);
  if (!head) fail(422, 'HEAD_NOT_FOUND', 'Head commit does not exist');
  if (!await context.storage.readCommit(repo.canonicalStorageName, baseOid as string)) fail(422, 'BASE_NOT_FOUND', 'Base commit does not exist');
  if (change.headOid === headOid && change.baseOid === baseOid && JSON.stringify(change.unitKeys) === JSON.stringify(unitKeys)) {
    const pending = context.state.get<InspectionPending>(`inspection:${changeId}`);
    if (pending && !pending.scheduled) {
      const stored = context.state.get<InspectCandidateJob>(`inspection-job:${changeId}`);
      if (!stored) return fail(503, 'INSPECTION_JOB_MISSING', 'Inspection job intent missing');
      const pendingJob = withJobPolicy(context.trusted, stored);
      return scheduleInspection(context, change, pendingJob);
    }
    return respond(context, changeResponse(change));
  }
  const profile = context.trusted.profiles[repo.profileId];
  const policy = context.trusted.policies[repo.policyId];
  const remote = (await context.storage.info(change.candidateStorageName))?.remote;
  const canonicalRemote = (await context.storage.info(repo.canonicalStorageName))?.remote;
  if (!remote || !canonicalRemote) fail(409, 'STORAGE_NOT_READY', 'Storage remote is not ready');
  const revision = change.revision + 1;
  const jobId = crypto.randomUUID();
  const job: InspectCandidateJob = {
    kind: 'inspect-candidate', jobId, repoId: repo.repoId, changeId, revision,
    candidate: { changeId, revision, baseOid: baseOid as string, headOid, storageName: change.candidateStorageName, ref },
    inputDigest: policy.digest, generation: revision, profileDigest: profile.digest,
    policyId: policy.id, policyDigest: policy.digest, unitPolicy: policy,
    expectedRefs: { [change.candidateStorageName]: headOid, [repo.canonicalStorageName]: baseOid },
    storageRemotes: { [change.candidateStorageName]: remote!, [repo.canonicalStorageName]: canonicalRemote! },
    checkerId: policy.checkerId, checkerDigest: policy.checkerDigest, oracleDigest: profile.oracleDigest,
    toolchainDigest: profile.toolchainDigest, environmentDigest: profile.environmentDigest,
    timeoutMs: profile.timeoutMs, maxOutputBytes: profile.maxOutputBytes,
    ...(policy.checkerId === 'dispatch-lab' ? { caseId: 'seed' } : {}),
    state: 'pending', attempt: 0, runnerId: null, fence: 0, expiresAt: null, version: 1,
  };
  job.inputDigest = await jobDigest(job);
  context.transaction(() => {
    change.baseOid = baseOid;
    change.headOid = headOid;
    change.unitKeys = unitKeys;
    change.revision = revision;
    change.status = 'draft';
    change.version = versioned(context, 'change.published', [changeId], { revision, headOid, baseOid });
    storeChange(context, change);
    context.state.put(`inspection:${changeId}`, { changeId, revision, jobId, inputDigest: job.inputDigest, sourceTreeOid: head!.treeOid, headOid, baseOid: baseOid as string, unitKeys, scheduled: false } satisfies InspectionPending);
    context.state.put(`inspection-job:${changeId}`, storedJob(job));
    context.state.delete(`review:${changeId}`);
    context.state.delete(`verified:${changeId}`);
    context.state.put('queueGeneration', (context.state.get<number>('queueGeneration') ?? 0) + 1);
  });
  return scheduleInspection(context, change, job);
}

async function bootstrap(context: ModuleContext, body: BootstrapBody): Promise<Response> {
  requireRole(context.principal, 'owner');
  const repo = await catalogRepo(context);
  requireReady(repo);
  if (body.policyId !== repo.policyId || body.profileId !== repo.profileId) fail(409, 'CONFIG_MISMATCH', 'Bootstrap policy/profile differ from repository');
  if (await context.storage.resolveRef(repo.canonicalStorageName, 'refs/heads/main')) fail(409, 'ALREADY_INITIALIZED', 'Canonical main already exists');
  const seedStorageName = text(body.seedStorageName, 'seedStorageName', 128);
  const seedRef = branch(body.seedRef);
  const headOid = oid(body.headOid);
  const change = list<Change>(context, 'changes').find(item => item.candidateStorageName === seedStorageName && item.baseOid === null && item.authorId === context.principal.principalId);
  if (!change) return fail(403, 'SEED_NOT_OWNED', 'Seed must be an owner draft fork');
  if (change.status !== 'draft') fail(409, 'SEED_NOT_OPEN', 'Seed must be an open draft');
  const registered = list<Branch>(context, 'branches').find(item => item.storageName === seedStorageName && item.ref === seedRef && item.observedHead === headOid);
  if (!registered || await context.storage.resolveRef(seedStorageName, seedRef) !== headOid) fail(422, 'SEED_REF_MISMATCH', 'Registered seed ref does not match');
  const head = await context.storage.readCommit(seedStorageName, headOid);
  if (body.withHistory !== undefined && typeof body.withHistory !== 'boolean') fail(400, 'INVALID_INPUT', 'withHistory must be a boolean');
  if (!head || (!body.withHistory && head.parents.length !== 0)) fail(422, 'SEED_NOT_ROOT', 'Seed must be an existing root commit');
  const policy = context.trusted.policies[repo.policyId];
  const profile = context.trusted.profiles[repo.profileId];
  const seedRemote = (await context.storage.info(seedStorageName))?.remote;
  const canonicalRemote = (await context.storage.info(repo.canonicalStorageName))?.remote;
  if (!seedRemote || !canonicalRemote) fail(409, 'STORAGE_NOT_READY', 'Storage remote is not ready');
  const existing = context.state.get<BootstrapPending>('bootstrap');
  if (existing) {
    if (existing.changeId !== change.changeId || existing.headOid !== headOid || existing.seedRef !== seedRef || existing.seedStorageName !== seedStorageName || Boolean(existing.withHistory) !== Boolean(body.withHistory)) fail(409, 'BOOTSTRAP_PENDING', 'Another bootstrap is already requested');
    if (existing.status === 'requested') {
      const status = context.call('queue.bootstrapStatus');
      if (status.status === 'blocked') throw new HttpError(409, status.code, status.reason);
      const pinned = status.value;
      if (!pinned || pinned.jobId !== existing.jobId) throw new HttpError(409, 'BOOTSTRAP_PENDING', 'Bootstrap handoff is unavailable');
      if (pinned.policyDigest !== policy.digest || pinned.profileDigest !== profile.digest || pinned.blockedReason === 'INVALID_JOB') {
        const replacementId = crypto.randomUUID();
        context.transaction(() => {
          const gate = context.handoffBootstrap?.({ seedStorageName, seedRef, headOid, canonicalStorageName: repo.canonicalStorageName,
            scratchStorageName: existing.scratchStorageName!, policyId: policy.id, profileId: profile.id,
            jobId: replacementId, repin: true });
          if (!gate) throw new HttpError(501, 'MODULE_UNAVAILABLE', 'Queue bootstrap handoff unavailable');
          if (gate.status === 'blocked') throw new HttpError(409, gate.code, gate.reason);
          context.state.put('bootstrap', { ...existing, jobId: replacementId, status: 'requested' } satisfies BootstrapPending);
        });
        return respond(context, { jobId: replacementId, state: 'requested' }, 202);
      }
      return respond(context, { jobId: existing.jobId, state: 'requested' }, 202);
    }
  }
  const jobId = existing?.jobId ?? crypto.randomUUID();
  const scratchStorageName = existing?.scratchStorageName ?? `concord-s-${jobId}`;
  if (!existing) {
    const requestDigest = await digest({ kind: 'ensure-repo', storageName: scratchStorageName });
    context.transaction(() => {
      if (context.state.get<BootstrapPending>('bootstrap')) fail(409, 'BOOTSTRAP_PENDING', 'A bootstrap is already requested');
      context.state.put('bootstrap', { changeId: change.changeId, headOid, seedRef, seedStorageName, withHistory: body.withHistory === true, jobId, scratchStorageName, status: 'provisioning' } satisfies BootstrapPending);
      saveIntent(context, { kind: 'ensure-repo', storageName: scratchStorageName, requestDigest, state: 'intent', retryAt: context.now(), polls: 0 });
    });
  }
  const scratchIntent = intents(context)[intentKey('ensure-repo', scratchStorageName)];
  if (!scratchIntent) fail(503, 'PROVISIONING_INTENT_MISSING', 'Scratch provisioning intent missing');
  const scratch = await reconcile(context, scratchIntent, true);
  if (intents(context)[intentKey('ensure-repo', scratchStorageName)].state === 'failed') fail(503, 'PROVISIONING_FAILED', 'Scratch provisioning failed; retry the same request');
  if (scratchIntent.state !== 'observed' || !scratch) return respond(context, { jobId, state: 'provisioning' }, 202);
  const seed: BootstrapHandoff = { seedStorageName, seedRef, headOid, canonicalStorageName: repo.canonicalStorageName,
    scratchStorageName, policyId: policy.id, profileId: profile.id, jobId };
  if (await context.storage.resolveRef(repo.canonicalStorageName, 'refs/heads/main')) fail(409, 'ALREADY_INITIALIZED', 'Canonical main appeared');
  context.transaction(() => {
    const pending = context.state.get<BootstrapPending>('bootstrap');
    if (!pending || pending.jobId !== jobId || !['provisioning', 'blocked'].includes(pending.status)) fail(409, 'BOOTSTRAP_PENDING', 'Bootstrap provisioning was superseded');
    context.state.put('bootstrap', { ...pending!, status: 'requested' } satisfies BootstrapPending);
    versioned(context, 'repo.bootstrap.requested', [repo.repoId, change.changeId], { headOid, jobId });
  });
  return scheduleBootstrap(context, context.state.get<BootstrapPending>('bootstrap')!, seed);
}

function close(context: ModuleContext, changeId: string, body: Record<string, unknown>): Response {
  const change = getChange(context, changeId);
  ownChange(context, change);
  if (context.state.get<BootstrapPending>('bootstrap')?.changeId === changeId) fail(409, 'BOOTSTRAP_FROZEN', 'Seed draft has a pending bootstrap request');
  if (!['draft', 'ready'].includes(change.status)) fail(409, 'CHANGE_FROZEN', 'Only unfrozen draft or ready changes can close');
  const reason = body.reason == null ? null : (() => {
    const value = body.reason;
    if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 2000 || !value.trim()) fail(422, 'INVALID_REASON', 'reason is invalid');
    return value as string;
  })();
  context.transaction(() => {
    try {
      const release = context.call('leases.releaseForChange', changeId, 'change-closed');
      if (release.status === 'blocked' && release.code !== 'MODULE_UNAVAILABLE') fail(409, release.code, release.reason);
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'MODULE_UNAVAILABLE') throw error;
    }
    change.status = 'closed';
    change.closeReason = reason;
    change.version = versioned(context, 'change.closed', [changeId], { reason });
    storeChange(context, change);
    context.state.put('intents', list<Intent>(context, 'intents').map(item => item.changeId === changeId ? { ...item, terminal: true, version: change.version } : item));
    context.state.delete(`inspection:${changeId}`);
    context.state.delete(`inspection-job:${changeId}`);
    context.state.delete(`review:${changeId}`);
    context.state.put('queueGeneration', (context.state.get<number>('queueGeneration') ?? 0) + 1);
  });
  return respond(context, changeResponse(change));
}

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
function evidenceHash(value: string): string {
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
function inspectRevision(context: ModuleContext, result: InspectionResult) {
  if (!result || !context.state) return unavailableGate();
  const { resultDigest, ...preimage } = result;
  const pending = list<Change>(context, 'changes').map(change => context.state.get<InspectionPending>(`inspection:${change.changeId}`)).find(value => value?.jobId === result.jobId);
  if (!pending) return { status: 'blocked' as const, version: context.version(), code: 'UNKNOWN_INSPECTION', reason: 'No matching pending inspection', evidenceIds: [] };
  const change = getChange(context, pending.changeId);
  if (change.status !== 'draft' && change.status !== 'ready') return { status: 'blocked' as const, version: context.version(), code: 'CHANGE_FROZEN', reason: 'Change is no longer open for inspection', evidenceIds: [result.jobId] };
  const repo = context.state.get<Repo>('repo');
  const policy = repo && context.trusted.policies[repo.policyId];
  const profile = repo && context.trusted.profiles[repo.profileId];
  const valid = result.kind === 'inspect-candidate' && result.outcome === 'PASS' && result.jobId === pending.jobId &&
    pending.scheduled &&
    result.inputDigest === pending.inputDigest && result.observedHeadOid === pending.headOid &&
    result.sourceTreeOid === pending.sourceTreeOid && !!result.reviewManifestDigest && /^sha256:[a-f0-9]{64}$/.test(result.reviewManifestDigest) &&
    !!result.resultDigest && result.resultDigest === evidenceHash(stableJson(preimage)) &&
    !!result.reviewManifest && result.reviewManifest.coverage === 'complete' && !!policy && !!profile &&
    result.reviewManifestDigest === evidenceHash(stableJson(result.reviewManifest)) &&
    result.checkerDigest === policy.checkerDigest && result.oracleDigest === profile.oracleDigest &&
    result.toolchainDigest === profile.toolchainDigest && result.environmentDigest === profile.environmentDigest &&
    result.reviewManifest.policyDigest === policy.digest && result.reviewManifest.checkerDigest === policy.checkerDigest &&
    result.reviewManifest.oracleDigest === profile.oracleDigest && result.reviewManifest.toolchainDigest === profile.toolchainDigest &&
    result.unitKeys.every(key => { try { resolveUnit(unitRegistry(policy), key); return true; } catch { return false; } }) &&
    JSON.stringify([...new Set(result.reviewManifest.changedUnits.map(unit => unit.unitKey))].sort()) === JSON.stringify([...result.unitKeys].sort()) &&
    JSON.stringify([...result.unitKeys].sort()) === JSON.stringify([...pending.unitKeys].sort()) &&
    change.revision === pending.revision && change.headOid === pending.headOid;
  if (!valid) return { status: 'blocked' as const, version: context.version(), code: 'INSPECTION_MISMATCH', reason: 'Inspection evidence is incomplete or stale', evidenceIds: [result.jobId] };
  if (change.status === 'ready') {
    if (context.state.get<string>(`review:${change.changeId}`) !== result.reviewManifestDigest) return { status: 'blocked' as const, version: context.version(), code: 'REVIEW_EVIDENCE_CONFLICT', reason: 'Ready revision already has different evidence', evidenceIds: [result.jobId] };
    return { status: 'eligible' as const, version: context.version(), evidenceIds: [result.jobId], value: { changeId: change.changeId, revision: change.revision, reviewManifestDigest: result.reviewManifestDigest! } };
  }
  context.transaction(() => {
    const handoff = context.call('verdicts.recordInspection', {
      changeId: change.changeId, revision: change.revision,
      candidate: { changeId: change.changeId, revision: change.revision, baseOid: pending.baseOid,
        headOid: pending.headOid, storageName: change.candidateStorageName, ref: change.branch },
      canonicalStorageName: repo!.canonicalStorageName, policyId: repo!.policyId, profileId: repo!.profileId,
      reviewManifest: result.reviewManifest!, reviewManifestDigest: result.reviewManifestDigest!, outcome: 'PASS',
    });
    if (handoff.status === 'blocked') fail(409, handoff.code, handoff.reason);
    change.status = 'ready';
    change.version = versioned(context, 'change.ready', [change.changeId], { revision: change.revision, jobId: result.jobId });
    storeChange(context, change);
    context.state.put(`review:${change.changeId}`, result.reviewManifestDigest);
    context.state.put(`verified:${change.changeId}`, { changeId: change.changeId, revision: change.revision,
      headOid: change.headOid!, policyDigest: policy!.digest, unitKeys: [...result.unitKeys], verifiedBy: 'checker' });
  });
  return { status: 'eligible' as const, version: context.version(), evidenceIds: [result.jobId], value: { changeId: change.changeId, revision: change.revision, reviewManifestDigest: result.reviewManifestDigest! } };
}

export const repos: FeatureModule = {
  name: 'repos', migrations: [],
  routes: [
    { method: 'POST', pattern: /^\/v1\/repos$/, handle: (context, _request, _match, body) => catalogCreate(context, body as unknown as CreateRepoBody) },
    { method: 'GET', pattern: /^\/v1\/repos\/([^/]+)$/, handle: context => repoDetail(context) },
    { method: 'GET', pattern: /^\/v1\/repos\/([^/]+)\/tree$/, handle: (context, request) => canonicalRead(context, request, 'tree') },
    { method: 'GET', pattern: /^\/v1\/repos\/([^/]+)\/file$/, handle: (context, request) => canonicalRead(context, request, 'file') },
    { method: 'GET', pattern: /^\/v1\/repos\/([^/]+)\/readme$/, handle: (context, request) => canonicalRead(context, request, 'readme') },
    { method: 'POST', pattern: /^\/v1\/repos\/([^/]+)\/bootstrap$/, handle: (context, _request, _match, body) => bootstrap(context, body as unknown as BootstrapBody) },
    { method: 'GET', pattern: /^\/v1\/repos\/([^/]+)\/branches$/, handle: async (context, request) => { await catalogRepo(context, 60_000); return respond(context, page(list<Branch>(context, 'branches'), request)); } },
    { method: 'POST', pattern: /^\/v1\/repos\/([^/]+)\/branches$/, handle: (context, _request, _match, body) => registerBranch(context, body as Record<string, unknown>) },
    { method: 'POST', pattern: /^\/v1\/repos\/([^/]+)\/git-token$/, handle: (context, _request, _match, body) => gitToken(context, body as Record<string, unknown>) },
    { method: 'GET', pattern: /^\/v1\/repos\/([^/]+)\/changes$/, handle: async (context, request) => { await catalogRepo(context, 60_000); return respond(context, page(list<Change>(context, 'changes').map(changeResponse), request)); } },
    { method: 'POST', pattern: /^\/v1\/repos\/([^/]+)\/changes$/, handle: (context, _request, _match, body) => changeCreate(context, body as unknown as CreateChangeBody) },
    { method: 'POST', pattern: /^\/v1\/repos\/([^/]+)\/changes\/repair-landed$/, handle: context => repairLandedChanges(context) },
    { method: 'POST', pattern: /^\/v1\/repos\/([^/]+)\/intent-contests$/, handle: (context, _request, _match, body) => authorizeIntentContest(context, body as Record<string, unknown>) },
    { method: 'GET', pattern: /^\/v1\/repos\/([^/]+)\/changes\/([^/]+)$/, handle: async (context, _request, match) => { await catalogRepo(context, 60_000); const change = getChange(context, match[2]); return respond(context, { ...changeResponse(change), ...humanApprovalStatus(context, change.changeId, change.revision), inspection: inspectionResponse(context, change), provisioning: intents(context)[intentKey('fork', change.candidateStorageName)] }); } },
    { method: 'POST', pattern: /^\/v1\/repos\/([^/]+)\/changes\/([^/]+)\/publish$/, handle: (context, _request, match, body) => publish(context, match[2], body as Record<string, unknown>) },
    { method: 'POST', pattern: /^\/v1\/repos\/([^/]+)\/changes\/([^/]+)\/close$/, handle: (context, _request, match, body) => close(context, match[2], body as Record<string, unknown>) },
  ],
  snapshot: context => ({ repo: context.state.get<Repo>('repo'),
    unitPolicy: context.trusted.policies[context.state.get<Repo>('repo')?.policyId ?? ''],
    branches: list<Branch>(context, 'branches'), changes: list<Change>(context, 'changes').map(change => ({ ...changeResponse(change), ...(['merged', 'closed'].includes(change.status)
      ? { awaitingHumanApproval: [], protectedFiles: [], protectedDiffSummary: [], reviewManifestDigest: null }
      : humanApprovalStatus(context, change.changeId, change.revision)) })),
    provisioning: Object.values(intents(context)), bootstrap: context.state.get<BootstrapPending>('bootstrap') }),
  nextDeadline: context => Object.values(intents(context)).filter(activeProvisioning).reduce<number | null>((earliest, intent) => earliest === null ? intent.retryAt : Math.min(earliest, intent.retryAt), null),
  onAlarm: async context => {
    const all = Object.values(intents(context)).filter(intent => activeProvisioning(intent) && intent.retryAt <= context.now());
    for (const intent of all) {
      await reconcile(context, intent, false);
      if (context.repoId === '') {
        const repos = list<Repo>(context, 'catalog:index');
        const repo = repos.find(item => item.canonicalStorageName === intent.storageName);
        const status = intent.state === 'observed' ? 'ready' : intent.state === 'failed' ? 'blocked' : 'provisioning';
        if (repo && repo.status !== status) {
          repo.status = status;
          repo.version = versioned(context, `repo.${status}`, [repo.repoId], {});
          context.state.put('catalog:index', repos);
        }
      }
    }
  },
  hooks: { 'repos.inspectRevision': inspectRevision, },
  changeView: (context, changeId) => {
    const change = list<Change>(context, 'changes').find(item => item.changeId === changeId);
    const repo = context.state.get<Repo>('repo');
    if (!change || !repo) return { status: 'blocked', version: context.version(), code: 'CHANGE_NOT_FOUND', reason: 'Change not found', evidenceIds: [] };
    return { status: 'eligible', version: context.version(), evidenceIds: [changeId], value: {
      authorId: change.authorId, headOid: change.headOid, revision: change.revision,
      status: change.status, unitKeys: change.unitKeys, frozen: !['draft', 'ready'].includes(change.status) || context.state.get<BootstrapPending>('bootstrap')?.changeId === changeId,
      baseOid: change.baseOid, candidateStorageName: change.candidateStorageName, branch: change.branch,
      dependencyChangeIds: change.dependencyChangeIds, canonicalStorageName: repo.canonicalStorageName,
      scratchStorageName: context.state.get<BootstrapPending>('bootstrap')?.scratchStorageName ?? `concord-s-${repo.repoId}`,
      policyId: repo.policyId, profileId: repo.profileId,
      intentKey: change.intentKey, ...(change.issueNumber != null ? { issueNumber: change.issueNumber } : {}),
    } };
  },
};
