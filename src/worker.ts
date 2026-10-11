import type { Principal } from './contracts';
import { authenticate, clock, requireRepo, requireRouteRole, requireTenant } from './auth';
import { failure, HttpError, json } from './http';

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
      const principal = await authenticate(request, env, clock(env));
      requireTenant(principal, request.headers.get('x-tenant-id') ?? undefined);
      requireRouteRole(principal, request.method, url.pathname);
      if (url.pathname === '/v1/repos') {
        const name = `tenant:${principal.tenantId}`;
        return forward(request, principal, env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName(name)));
      }
      const match = /^\/v1\/repos\/([A-Za-z0-9_-]{1,64})(?:\/|$)/.exec(url.pathname);
      if (!match) throw new HttpError(404, 'NOT_FOUND', 'Unknown route');
      requireRepo(principal, match[1]);
      const name = `repo:${principal.tenantId}:${match[1]}`;
      return forward(request, principal, env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(name)));
    } catch (error) {
      return failure(error instanceof HttpError ? error : new HttpError(503, 'PLATFORM_UNAVAILABLE', 'Platform component unavailable'));
    }
  },
} satisfies ExportedHandler<Env>;
