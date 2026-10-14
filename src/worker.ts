import type { Principal, Repo } from './contracts';
import { PUBLIC_DIRECTORY_NAME } from './contracts';
import { authenticateWithExpiry, clock, requireRepo, requireRouteRole, requireTenant } from './auth';
import { failure, HttpError, json } from './http';
import { accessCookie, accessConfigured, accessLogoutUrl, authenticateAccess, clearAccessCookie } from './access';

const MAX_REQUEST_BODY_BYTES = 256 * 1024;
const repoPath = /^\/v1\/repos\/([A-Za-z0-9_-]{1,64})(?:\/|$)/;

async function limitAuthFailure(request: Request, env: Env): Promise<void> {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const result = await env.AUTH_RATE_LIMIT.limit({ key: ip });
  if (!result.success) throw new HttpError(429, 'RATE_LIMITED', 'Authentication rate limit reached');
}

async function limitAnonymousRead(request: Request, env: Env, repoId: string): Promise<void> {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const result = await env.ANON_READ_LIMIT.limit({ key: `${ip}:${repoId}` });
  if (!result.success) throw new HttpError(429, 'READ_RATE_LIMITED', 'Anonymous repository read limit reached');
}

async function enforceBodyLimit(request: Request): Promise<Request> {
  const length = request.headers.get('content-length');
  if (length !== null && Number(length) > MAX_REQUEST_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 256 KiB');
  if (!request.body) return request;
  const reader = request.body.getReader();
  let size = 0;
  const chunks: ArrayBuffer[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BODY_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 256 KiB');
      }
      const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
      copy.set(value);
      chunks.push(copy.buffer);
    }
  } finally { reader.releaseLock(); }
  return new Request(request, { body: new Blob(chunks) });
}

export { TenantCatalog } from './catalog';
export { RepoCoordinator } from './coordinator';

/**
 * Tenant lookup for a credentialless repo GET. Returns null for private and
 * unknown repositories alike so the caller can answer both with the same 401.
 */
async function publicRepoTenant(env: Env, repoId: string): Promise<string | null> {
  const directory = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName(PUBLIC_DIRECTORY_NAME));
  const response = await directory.fetch(new Request(
    `https://concord.internal/internal/repo-directory?repoId=${encodeURIComponent(repoId)}`,
    { headers: { 'x-concord-tenant': PUBLIC_DIRECTORY_NAME } }));
  if (!response.ok) return null;
  const entry = (await response.json() as { data?: { tenantId?: unknown } }).data;
  const tenantId = typeof entry?.tenantId === 'string' ? entry.tenantId : null;
  if (!tenantId) return null;
  // The catalog is authoritative: a failed directory deletion must never keep
  // an already revoked repository available to anonymous readers.
  const catalog = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName(`tenant:${tenantId}`));
  const check = await catalog.fetch(new Request(
    `https://concord.internal/internal/public-repo?repoId=${encodeURIComponent(repoId)}`,
    { headers: { 'x-concord-tenant': tenantId } }));
  if (!check.ok) return null;
  const current = (await check.json() as { data?: { public?: unknown } }).data;
  return current?.public === true ? tenantId : null;
}

const anonymousHiddenKeys = /(?:storageName$|sourceName$|remote|token|secret|credential|password|authorization|checkerConfig|checkerConfiguration|runnerConfig|runnerConfiguration|environmentConfig|environmentConfiguration)/i;
const anonymousHiddenExact = new Set([
  'unitPolicy', 'checkerId', 'checkerDigest', 'oracleDigest', 'toolchainDigest', 'environmentDigest',
  'expectedRefs', 'jobs', 'log', 'principalId', 'runners',
]);

/** Strip credential material, storage locations, and runner/checker configuration from anonymous responses. */
function scrubAnonymousValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubAnonymousValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !anonymousHiddenExact.has(key) && !anonymousHiddenKeys.test(key))
      .map(([key, item]) => [key, scrubAnonymousValue(item)]));
  }
  return value;
}

async function scrubAnonymousResponse(response: Response): Promise<Response> {
  if (!response.headers.get('content-type')?.includes('application/json')) return response;
  let body: unknown;
  try { body = await response.json(); } catch { return response; }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(JSON.stringify(scrubAnonymousValue(body)), { status: response.status, headers });
}

function forward(request: Request, principal: Principal, stub: DurableObjectStub): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  headers.delete('cf-access-jwt-assertion');
  headers.delete('cookie');
  headers.set('x-concord-principal', JSON.stringify(principal));
  headers.set('x-concord-tenant', principal.tenantId);
  return stub.fetch(new Request(request, { headers }));
}

/** A snapshot's synchronous module projection can predate a catalog flag update. */
async function currentRepo(env: Env, principal: Principal, repoId: string): Promise<Repo | null> {
  const catalog = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName(`tenant:${principal.tenantId}`));
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const url = `https://concord.internal/v1/repos${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    const response = await forward(new Request(url), principal, catalog);
    if (!response.ok) throw new HttpError(503, 'CATALOG_UNAVAILABLE', 'Repository catalog unavailable');
    const envelope = await response.json() as { data?: { items?: Repo[]; nextCursor?: string | null } };
    const repo = envelope.data?.items?.find(item => item.repoId === repoId);
    if (repo) return repo;
    cursor = envelope.data?.nextCursor ?? null;
    if (!cursor) break;
  }
  return null;
}

async function refreshSnapshotRepo(response: Response, repo: Repo): Promise<Response> {
  if (!response.ok) return response;
  const body = await response.clone().json() as { data?: { projections?: { repos?: Record<string, unknown> } }; version: number; eventSeq: number };
  if (!body.data?.projections?.repos) return response;
  body.data.projections.repos.repo = repo;
  return json(body.data, body.version, body.eventSeq, response.status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
        return json({ status: 'ok', mode: env.CONCORD_MODE, storageBackend: env.STORAGE_BACKEND, accessSignIn: accessConfigured(env) });
      }
      if (url.pathname === '/v1/session/signout' && request.method === 'GET') {
        return new Response(null, { status: 302, headers: { location: accessLogoutUrl(env) ?? '/', 'set-cookie': clearAccessCookie() } });
      }
      if (url.pathname === '/v1/session/signin' && request.method === 'GET') {
        const now = clock(env)();
        const principal = await authenticateAccess(request, env, now);
        const assertion = request.headers.get('Cf-Access-Jwt-Assertion') || request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('CF_Authorization='))?.slice('CF_Authorization='.length);
        if (!assertion) throw new HttpError(401, 'UNAUTHORIZED', 'Invalid Access assertion');
        return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': accessCookie(assertion, principal.expiresAt, now) } });
      }
      if (!url.pathname.startsWith('/v1/')) {
        if (request.method === 'GET' || request.method === 'HEAD') return env.ASSETS.fetch(request);
        throw new HttpError(404, 'NOT_FOUND', 'Unknown route');
      }
      let principal: Principal | undefined;
      let credentialExpiresAt: number | null = null;
      let anonymous = false;
      let metered = false;
      // Only a genuinely absent Authorization header can resolve anonymously; any
      // presented credential is authenticated (and rejected) exactly as before.
      const anonymousRepoId = request.method === 'GET' && request.headers.get('authorization') === null
        ? repoPath.exec(url.pathname)?.[1] ?? null
        : null;
      try {
        if (anonymousRepoId) {
          await limitAnonymousRead(request, env, anonymousRepoId);
          metered = true;
          const tenantId = await publicRepoTenant(env, anonymousRepoId);
          if (tenantId) {
            principal = { tenantId, principalId: 'anonymous', roles: ['viewer'], repoIds: [anonymousRepoId], expiresAt: Number.MAX_SAFE_INTEGER };
            anonymous = true;
          }
        }
        if (!principal) ({ principal, expiresAt: credentialExpiresAt } = await authenticateWithExpiry(request, env, clock(env)));
      } catch (error) {
        if (error instanceof HttpError && (error.status === 401 || error.status === 403) && !metered) await limitAuthFailure(request, env);
        throw error;
      }
      requireTenant(principal, request.headers.get('x-tenant-id') ?? undefined);
      if (principal.authMethod === 'access' && !['GET', 'HEAD'].includes(request.method) &&
        request.headers.get('origin') !== url.origin) throw new HttpError(403, 'ORIGIN_REJECTED', 'Request origin rejected');
      requireRouteRole(principal, request.method, url.pathname);
      if (request.method === 'GET' && url.pathname === '/v1/session') {
        return json({ principalId: principal.principalId, roles: principal.roles,
          authMethod: principal.authMethod ?? 'bearer', expiresAt: credentialExpiresAt,
          ...(principal.authMethod === 'access' ? { logoutUrl: '/v1/session/signout' } : {}) });
      }
      if (request.method === 'GET' && url.pathname === '/v1/me') {
        const { principalId, tenantId, roles, repoIds, avatarUrl } = principal;
        return json({ principalId, tenantId, roles, repoIds, expiresAt: credentialExpiresAt, model: principal.model ?? null,
          ...(avatarUrl ? { avatarUrl } : {}) });
      }
      const repoMatch = repoPath.exec(url.pathname);
      if (repoMatch) requireRepo(principal, repoMatch[1]);
      request = await enforceBodyLimit(request);
      if (url.pathname === '/v1/events' || url.pathname === '/v1/repos' || url.pathname === '/v1/principals' || /^\/v1\/principals\/[A-Za-z0-9_-]{1,64}$/.test(url.pathname)) {
        const name = `tenant:${principal.tenantId}`;
        return forward(request, principal, env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName(name)));
      }
      const match = repoPath.exec(url.pathname);
      if (!match) throw new HttpError(404, 'NOT_FOUND', 'Unknown route');
      const name = `repo:${principal.tenantId}:${match[1]}`;
      const snapshot = request.method === 'GET' && url.pathname === `/v1/repos/${match[1]}/snapshot`;
      const repo = anonymous && snapshot ? await currentRepo(env, principal, match[1]) : null;
      if (anonymous && snapshot && repo?.public !== true) throw new HttpError(401, 'UNAUTHORIZED', 'Bearer credential required');
      let response = await forward(request, principal, env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(name)));
      if (repo) response = await refreshSnapshotRepo(response, repo);
      return anonymous ? scrubAnonymousResponse(response) : response;
    } catch (error) {
      const response = failure(error instanceof HttpError ? error : new HttpError(503, 'PLATFORM_UNAVAILABLE', 'Platform component unavailable'));
      if (error instanceof HttpError && error.code === 'READ_RATE_LIMITED') response.headers.set('Retry-After', '60');
      return response;
    }
  },
} satisfies ExportedHandler<Env>;
