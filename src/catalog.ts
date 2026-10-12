import { DurableObject } from 'cloudflare:workers';
import type { HookName, ModuleContext, Principal, Repo, ServiceHooks } from './contracts';
import { clock, requireRole, requireTenant } from './auth';
import { digest, encodeCursor, failure, HttpError, json, parseCursor, readJson } from './http';
import { appendEvent, applyMigrations, catalogVisibility, costLimits, eventSequence, eventsAfter, initialize, loadTrustedConfig, sqlState } from './state';
import { selectStorage } from './coordinator';
import { repos } from './features/repos';
import { handlePrincipalRoute, initializePrincipals, lookupPrincipal } from './features/principals';

/** Tenant-scoped index. Landing authorization remains in RepoCoordinator. */
export class TenantCatalog extends DurableObject<Env> {
  private readonly now: () => number;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.now = clock(env);
    initialize(ctx.storage.sql);
    initializePrincipals(ctx.storage.sql);
    applyMigrations(ctx.storage, repos);
  }

  private context(principal: Principal): ModuleContext {
    const sql = this.ctx.storage.sql;
    const base = sqlState(sql);
    const prefix = 'module:repos:';
    const context: ModuleContext = {
      repoId: '', tenantId: principal.tenantId, principal, env: this.env,
      storage: selectStorage(this.env, sql, this.now),
      trusted: loadTrustedConfig(this.env), now: this.now, sql,
      transaction: <T>(run: () => T) => this.ctx.storage.transactionSync(run),
      version: () => base.get<number>('catalog:version') ?? 0,
      nextVersion: () => { const next = (base.get<number>('catalog:version') ?? 0) + 1; base.put('catalog:version', next); return next; },
      appendEvent: (kind, relatedIds, payload, version) => appendEvent(context, kind, relatedIds, payload, version),
      state: {
        get: <T>(key: string) => base.get<T>(prefix + key),
        put: <T>(key: string, value: T) => base.put(prefix + key, value),
        delete: (key: string) => base.delete(prefix + key),
      },
      call: <K extends HookName>(_name: K, ..._args: Parameters<ServiceHooks[K]> extends [ModuleContext, ...infer A] ? A : never): ReturnType<ServiceHooks[K]> => {
        throw new HttpError(501, 'MODULE_UNAVAILABLE', 'Catalog hook unavailable');
      },
    };
    return context;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/internal/principals/lookup' && request.method === 'POST') {
        const tenantId = request.headers.get('x-concord-tenant');
        const identity = sqlState(this.ctx.storage.sql).get<string>('catalog:tenantId');
        if (!tenantId || tenantId !== identity) throw new HttpError(401, 'UNAUTHORIZED', 'Catalog identity mismatch');
        const { digest: tokenDigest } = await readJson(request);
        const found = lookupPrincipal(this.ctx.storage.sql, tokenDigest as string, tenantId, this.now());
        return json(found);
      }
      const principal = JSON.parse(request.headers.get('x-concord-principal') ?? 'null') as Principal | null;
      if (!principal) throw new HttpError(401, 'UNAUTHORIZED', 'Identity missing');
      requireTenant(principal, request.headers.get('x-concord-tenant') ?? undefined);
      const identityStore = sqlState(this.ctx.storage.sql);
      const identity = identityStore.get<string>('catalog:tenantId');
      if (identity && identity !== principal.tenantId) throw new HttpError(403, 'TENANT_MISMATCH', 'Catalog identity mismatch');
      if (!identity) identityStore.put('catalog:tenantId', principal.tenantId);
      const context = this.context(principal);
      if (path === '/internal/token-quota' && request.method === 'POST') {
        const state = sqlState(context.sql);
        const day = Math.floor(this.now() / 86_400_000);
        const previous = state.get<{ day: number; count: number }>('catalog:tokenQuota');
        const count = previous?.day === day ? previous.count : 0;
        if (count >= costLimits(context.trusted).maxTokenMintsPerTenantPerDay) throw new HttpError(429, 'TENANT_TOKEN_LIMIT', 'Tenant daily token mint limit reached');
        state.put('catalog:tokenQuota', { day, count: count + 1 });
        return json({ reserved: true });
      }
      if (path === '/internal/fork-quota' && request.method === 'POST') {
        const state = sqlState(context.sql);
        const count = state.get<number>('catalog:forkCount') ?? 0;
        if (count >= costLimits(context.trusted).maxForksPerTenant) throw new HttpError(429, 'TENANT_FORK_LIMIT', 'Tenant fork limit reached');
        state.put('catalog:forkCount', count + 1);
        return json({ reserved: true });
      }
      if (path === '/v1/events') {
        if (request.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
        requireRole(principal, 'owner', 'viewer');
        const url = new URL(request.url);
        const after = parseCursor(url.searchParams.get('cursor'));
        const limitRaw = url.searchParams.get('limit');
        const limit = limitRaw === null ? 100 : Number(limitRaw);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, 'INVALID_LIMIT', 'Limit must be 1 to 100');
        const visibility = catalogVisibility(context.sql, principal);
        const page = eventsAfter(context.sql, after, limit + 1, visibility);
        const items = page.slice(0, limit).map(event => {
          const payload = { ...event.payload };
          if (!principal.roles.includes('owner')) {
            for (const key of Object.keys(payload)) if (/storageName$/i.test(key)) delete payload[key];
          }
          if (!visibility.all && event.kind.startsWith('principal.')) {
            return { ...event, relatedIds: event.relatedIds.filter(id => visibility.principalIds.has(id)), payload };
          }
          return { ...event, payload };
        });
        const nextCursor = page.length > limit ? encodeCursor(items[items.length - 1].sequence) : null;
        return json({ items, nextCursor }, context.version(), eventSequence(context.sql));
      }
      if (path === '/v1/principals' || path.startsWith('/v1/principals/')) return await handlePrincipalRoute(context, request, path);
      if (path !== '/v1/repos') throw new HttpError(404, 'NOT_FOUND', 'Unknown catalog route');
      if (request.method === 'GET') {
        const repos = (context.state.get<Repo[]>('catalog:index') ?? []).filter(repo => repo.tenantId === principal.tenantId && (principal.repoIds === '*' || principal.repoIds.includes(repo.repoId)));
        const offset = parseCursor(new URL(request.url).searchParams.get('cursor'));
        const items = repos.slice(offset, offset + 100);
        const nextCursor = offset + items.length < repos.length ? encodeCursor(offset + items.length) : null;
        return json({ items, nextCursor }, context.version(), eventSequence(context.sql));
      }
      if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      const key = request.headers.get('idempotency-key');
      if (!key || key.length > 128) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key required');
      const body = await readJson(request);
      requireTenant(principal, body.tenantId);
      const requestDigest = await digest(body);
      const previous = context.sql.exec<{ request_digest: string; status: number; body: string }>(
        'SELECT request_digest, status, body FROM concord_requests WHERE principal_id = ? AND route = ? AND idempotency_key = ?',
        principal.principalId, 'POST /v1/repos', key,
      ).toArray()[0];
      if (previous) {
        if (previous.request_digest !== requestDigest) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used with another body');
        return new Response(previous.body, { status: previous.status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      }
      const route = repos.routes.find(route => route.pattern.test(path) && (route.method === '*' || route.method === request.method));
      if (!route) throw new HttpError(501, 'MODULE_UNAVAILABLE', 'Repository module unavailable');
      const response = await route.handle(context, request, path.match(route.pattern)!, body);
      const responseBody = await response.clone().text();
      context.sql.exec('INSERT INTO concord_requests(principal_id, route, idempotency_key, request_digest, status, body) VALUES(?, ?, ?, ?, ?, ?)',
        principal.principalId, 'POST /v1/repos', key, requestDigest, response.status, responseBody);
      const deadline = repos.nextDeadline(context);
      const alarm = await this.ctx.storage.getAlarm();
      if (deadline === null) {
        if (alarm !== null) await this.ctx.storage.deleteAlarm();
      } else if (alarm === null || deadline < alarm) await this.ctx.storage.setAlarm(Math.max(this.now() + 1,
        sqlState(context.sql).get<number>('catalog:alarmFloorAt') ?? 0, deadline));
      return response;
    } catch (error) {
      return failure(error instanceof HttpError ? error : new HttpError(503, 'PLATFORM_UNAVAILABLE', 'Platform component unavailable'));
    }
  }

  async alarm(): Promise<void> {
    const tenantId = sqlState(this.ctx.storage.sql).get<string>('catalog:tenantId');
    if (!tenantId) return;
    const principal: Principal = { tenantId, principalId: 'system', roles: [], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
    const context = this.context(principal);
    const state = sqlState(context.sql);
    let failed = false;
    try { await repos.onAlarm(context); }
    catch { failed = true; }
    const failures = failed ? Math.min(7, (state.get<number>('catalog:alarmFailures') ?? 0) + 1) : 0;
    state.put('catalog:alarmFailures', failures);
    const deadline = repos.nextDeadline(context);
    if (deadline === null) await this.ctx.storage.deleteAlarm();
    else {
      const floorAt = this.now() + (failed ? Math.min(60_000, 1000 * 2 ** (failures - 1)) : 1000);
      state.put('catalog:alarmFloorAt', floorAt);
      await this.ctx.storage.setAlarm(Math.max(floorAt, deadline));
    }
  }
}
