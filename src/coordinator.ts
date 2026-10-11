import { DurableObject } from 'cloudflare:workers';
import type { FeatureModule, HookName, ModuleContext, ModuleName, Principal, RepoStorage, ServiceHooks } from './contracts';
import { clock, requireRepo, requireTenant } from './auth';
import { digest, encodeCursor, expectVersion, failure, HttpError, json, parseCursor, readJson, requiresExpectedVersion } from './http';
import { appendEvent, applyMigrations, eventSequence, eventsAfter, initialize, loadTrustedConfig, sqlState, unfrozenPromotion } from './state';
import { FakeStorage } from './storage/fake';
import { artifactsStorage } from './storage/artifacts';
import { bridgeStorage } from './storage/bridge';
import { repos } from './features/repos';
import { leases } from './features/leases';
import { queue } from './features/queue';
import { runners } from './features/runners';
import { findings } from './features/findings';
import { verdicts } from './features/verdicts';

/** The six modules are registered once. Each supplies migrations, routes, alarms and projections. */
export const modules: FeatureModule[] = [repos, leases, queue, runners, findings, verdicts];

export function selectStorage(env: Env, sql: SqlStorage, now: () => number): RepoStorage {
  if (env.CONCORD_MODE === 'local' && env.STORAGE_BACKEND === 'fake') return new FakeStorage(sqlState(sql), now);
  if (env.CONCORD_MODE === 'local' && env.STORAGE_BACKEND === 'bridge' && env.BRIDGE_URL?.startsWith('http://127.0.0.1:')) return bridgeStorage(env.BRIDGE_URL);
  if (env.CONCORD_MODE === 'production' && env.STORAGE_BACKEND === 'artifacts' && env.ARTIFACTS) return artifactsStorage(env.ARTIFACTS);
  throw new Error('STORAGE_BACKEND_UNAVAILABLE');
}

export class RepoCoordinator extends DurableObject<Env> {
  private readonly now: () => number;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.now = clock(env);
    initialize(ctx.storage.sql);
    for (const module of modules) applyMigrations(ctx.storage, module);
  }

  private context(name: ModuleName, principal: Principal, repoId: string): ModuleContext {
    const sql = this.ctx.storage.sql;
    const base = sqlState(sql);
    const prefix = `module:${name}:`;
    const context: ModuleContext = {
      repoId, tenantId: principal.tenantId, principal, env: this.env,
      storage: selectStorage(this.env, sql, this.now),
      trusted: loadTrustedConfig(this.env), now: this.now, sql,
      transaction: <T>(run: () => T) => this.ctx.storage.transactionSync(run),
      version: () => base.get<number>('repo:version') ?? 0,
      nextVersion: () => {
        const version = (base.get<number>('repo:version') ?? 0) + 1;
        base.put('repo:version', version);
        return version;
      },
      appendEvent: (kind, relatedIds, payload, version) => appendEvent(context, kind, relatedIds, payload, version),
      state: {
        get: <T>(key: string) => base.get<T>(prefix + key),
        put: <T>(key: string, value: T) => base.put(prefix + key, value),
        delete: (key: string) => base.delete(prefix + key),
      },
      call: <K extends HookName>(hookName: K, ...args: Parameters<ServiceHooks[K]> extends [ModuleContext, ...infer A] ? A : never): ReturnType<ServiceHooks[K]> => {
        const owner = hookName.split('.')[0] as ModuleName;
        const hook = modules.find(module => module.name === owner)?.hooks[hookName];
        if (!hook) throw new HttpError(501, 'MODULE_UNAVAILABLE', `${owner} hook unavailable`);
        return (hook as (...values: unknown[]) => ReturnType<ServiceHooks[K]>)(this.context(owner, principal, repoId), ...args);
      },
      readChange: changeId => {
        const provider = repos.changeView;
        if (!provider) return { status: 'blocked', version: context.version(), code: 'MODULE_UNAVAILABLE', reason: 'Repos change view unavailable', evidenceIds: [] };
        const result = provider(this.context('repos', principal, repoId), changeId);
        if (result.status === 'blocked') return result;
        const value = result.value;
        return {
          ...result,
          value: Object.freeze({
            authorId: value.authorId, headOid: value.headOid, revision: value.revision,
            status: value.status, unitKeys: Object.freeze([...value.unitKeys]), frozen: value.frozen,
            baseOid: value.baseOid, candidateStorageName: value.candidateStorageName, branch: value.branch,
            dependencyChangeIds: value.dependencyChangeIds && Object.freeze([...value.dependencyChangeIds]), canonicalStorageName: value.canonicalStorageName,
          }),
        };
      },
    };
    return context;
  }

  private async scheduleNextAlarm(principal: Principal, repoId: string): Promise<void> {
    const deadlines = modules.map(module => module.nextDeadline(this.context(module.name, principal, repoId))).filter((deadline): deadline is number => deadline !== null && Number.isFinite(deadline));
    const current = await this.ctx.storage.getAlarm();
    if (deadlines.length === 0) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const earliest = Math.max(this.now() + 1, Math.min(...deadlines));
    if (current === null || earliest < current) await this.ctx.storage.setAlarm(earliest);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const principal = JSON.parse(request.headers.get('x-concord-principal') ?? 'null') as Principal | null;
      if (!principal) throw new HttpError(401, 'UNAUTHORIZED', 'Identity missing');
      requireTenant(principal, request.headers.get('x-concord-tenant') ?? undefined);
      const url = new URL(request.url);
      const match = /^\/v1\/repos\/([A-Za-z0-9_-]{1,64})(?:\/|$)/.exec(url.pathname);
      if (!match) throw new HttpError(404, 'NOT_FOUND', 'Unknown repository route');
      const repoId = match[1];
      requireRepo(principal, repoId);
      const identityStore = sqlState(this.ctx.storage.sql);
      const identity = identityStore.get<{ tenantId: string; repoId: string }>('repo:identity');
      if (identity && (identity.tenantId !== principal.tenantId || identity.repoId !== repoId)) throw new HttpError(403, 'TENANT_MISMATCH', 'Repository identity mismatch');
      if (!identity) identityStore.put('repo:identity', { tenantId: principal.tenantId, repoId });
      const core = this.context('repos', principal, repoId);
      const version = core.version();
      if (request.method === 'GET' && url.pathname === `/v1/repos/${repoId}/snapshot`) {
        const projections = Object.fromEntries(modules.map(module => [module.name, module.snapshot(this.context(module.name, principal, repoId))]));
        return json({ repoId, projections }, version, eventSequence(core.sql));
      }
      if (request.method === 'GET' && url.pathname === `/v1/repos/${repoId}/events`) {
        const afterRaw = url.searchParams.get('after');
        const after = afterRaw !== null && /^\d+$/.test(afterRaw) ? Number(afterRaw) : parseCursor(url.searchParams.get('cursor') ?? afterRaw);
        if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'INVALID_CURSOR', 'Invalid event cursor');
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw === null ? 100 : Number(limitRaw);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'INVALID_LIMIT', 'Limit must be 1 to 100');
        const page = eventsAfter(core.sql, after, limit + 1);
        const items = page.slice(0, limit);
        const nextCursor = page.length > limit ? encodeCursor(items[items.length - 1].sequence) : null;
        return json({ items, nextCursor }, version, eventSequence(core.sql));
      }
      const moduleRoute = modules.flatMap(module => module.routes.map(route => ({ module, route }))).find(({ route }) =>
        (route.method === '*' || route.method === request.method) && route.pattern.test(url.pathname));
      if (!moduleRoute) throw new HttpError(404, 'NOT_FOUND', 'Unknown repository route');
      const mutation = !['GET', 'HEAD'].includes(request.method);
      const checkFreeze = () => {
        const decision = (queue.promotionFreeze ?? unfrozenPromotion)(this.context('queue', principal, repoId), request);
        const promoterResult = request.method === 'POST'
          && new RegExp(`^/v1/repos/${repoId}/jobs/[A-Za-z0-9_-]{1,64}/result$`).test(url.pathname)
          && principal.roles.includes('promoter');
        if (decision.frozen && !(decision.exempt && promoterResult)) {
          throw new HttpError(409, 'PROMOTION_IN_PROGRESS', 'Repository promotion is in progress');
        }
      };
      if (mutation) checkFreeze();

      let body: Record<string, unknown> | undefined;
      let key: string | null = null;
      let requestDigest: string | null = null;
      if (mutation) {
        key = request.headers.get('idempotency-key');
        if (!key || key.length > 128) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key required');
        body = await readJson(request);
        requireTenant(principal, body.tenantId);
        requestDigest = await digest(body);
      }
      const dispatch = async (): Promise<Response> => {
        if (mutation) checkFreeze();
        if (key && requestDigest) {
          const previous = core.sql.exec<{ request_digest: string; status: number; body: string }>(
            'SELECT request_digest, status, body FROM concord_requests WHERE principal_id = ? AND route = ? AND idempotency_key = ?',
            principal.principalId, `${request.method} ${url.pathname}`, key,
          ).toArray()[0];
          if (previous) {
            if (previous.request_digest !== requestDigest) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used with another body');
            return new Response(previous.status === 204 ? null : previous.body, { status: previous.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
          }
        }
        const context = this.context(moduleRoute.module.name, principal, repoId);
        if (body && requiresExpectedVersion(request.method, url.pathname)) expectVersion(body, context.version());
        const response = await moduleRoute.route.handle(context, request, url.pathname.match(moduleRoute.route.pattern)!, body);
        if (key && requestDigest) {
          const responseBody = await response.clone().text();
          core.sql.exec('INSERT INTO concord_requests(principal_id, route, idempotency_key, request_digest, status, body) VALUES(?, ?, ?, ?, ?, ?)',
            principal.principalId, `${request.method} ${url.pathname}`, key, requestDigest, response.status, responseBody);
        }
        await this.scheduleNextAlarm(principal, repoId);
        return response;
      };
      if (!mutation) return await dispatch();
      // Keep the final freeze read and the whole handler exclusive across async yields.
      const result = await this.ctx.blockConcurrencyWhile(async () => {
        const serialize = async (response: Response) => {
          const headers: [string, string][] = [];
          response.headers.forEach((value, name) => headers.push([name, value]));
          return { status: response.status, headers, body: response.status === 204 ? null : await response.text() };
        };
        try { return await serialize(await dispatch()); }
        catch (error) { return await serialize(failure(error instanceof HttpError ? error : new HttpError(503, 'PLATFORM_UNAVAILABLE', 'Platform component unavailable'))); }
      });
      return new Response(result.body, { status: result.status, headers: result.headers });
    } catch (error) {
      return failure(error instanceof HttpError ? error : new HttpError(503, 'PLATFORM_UNAVAILABLE', 'Platform component unavailable'));
    }
  }

  async alarm(): Promise<void> {
    const identity = sqlState(this.ctx.storage.sql).get<{ tenantId: string; repoId: string }>('repo:identity');
    if (!identity) return;
    const principal: Principal = { tenantId: identity.tenantId, principalId: 'system', roles: [], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
    let failure: unknown;
    for (const module of modules) {
      try { await module.onAlarm(this.context(module.name, principal, identity.repoId)); }
      catch (error) { failure ??= error; }
    }
    await this.scheduleNextAlarm(principal, identity.repoId);
    if (failure) throw failure;
  }
}
