import type { Principal } from './contracts';
import { authenticate, clock, requireRepo, requireRouteRole, requireTenant } from './auth';
import { failure, HttpError, json } from './http';

const MAX_REQUEST_BODY_BYTES = 256 * 1024;

async function limitAuthFailure(request: Request, env: Env): Promise<void> {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const result = await env.AUTH_RATE_LIMIT.limit({ key: ip });
  if (!result.success) throw new HttpError(429, 'RATE_LIMITED', 'Authentication rate limit reached');
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

function forward(request: Request, principal: Principal, stub: DurableObjectStub): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  headers.set('x-concord-principal', JSON.stringify(principal));
  headers.set('x-concord-tenant', principal.tenantId);
  return stub.fetch(new Request(request, { headers }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
        return json({ status: 'ok', mode: env.CONCORD_MODE, storageBackend: env.STORAGE_BACKEND });
      }
      if (!url.pathname.startsWith('/v1/')) {
        if (request.method === 'GET' || request.method === 'HEAD') return env.ASSETS.fetch(request);
        throw new HttpError(404, 'NOT_FOUND', 'Unknown route');
      }
      let principal: Principal;
      try {
        principal = await authenticate(request, env, clock(env));
      } catch (error) {
        if (error instanceof HttpError && (error.status === 401 || error.status === 403)) await limitAuthFailure(request, env);
        throw error;
      }
      requireTenant(principal, request.headers.get('x-tenant-id') ?? undefined);
      requireRouteRole(principal, request.method, url.pathname);
      if (request.method === 'GET' && url.pathname === '/v1/me') {
        const { principalId, tenantId, roles, repoIds, expiresAt } = principal;
        return json({ principalId, tenantId, roles, repoIds, expiresAt: expiresAt ?? null, model: principal.model ?? null });
      }
      const repoMatch = /^\/v1\/repos\/([A-Za-z0-9_-]{1,64})(?:\/|$)/.exec(url.pathname);
      if (repoMatch) requireRepo(principal, repoMatch[1]);
      request = await enforceBodyLimit(request);
      if (url.pathname === '/v1/repos') {
        const name = `tenant:${principal.tenantId}`;
        return forward(request, principal, env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName(name)));
      }
      const match = /^\/v1\/repos\/([A-Za-z0-9_-]{1,64})(?:\/|$)/.exec(url.pathname);
      if (!match) throw new HttpError(404, 'NOT_FOUND', 'Unknown route');
      const name = `repo:${principal.tenantId}:${match[1]}`;
      return forward(request, principal, env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(name)));
    } catch (error) {
      return failure(error instanceof HttpError ? error : new HttpError(503, 'PLATFORM_UNAVAILABLE', 'Platform component unavailable'));
    }
  },
} satisfies ExportedHandler<Env>;
