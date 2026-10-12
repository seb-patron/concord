import type { Principal, Role } from './contracts';
import { HttpError } from './http';

const local: Record<string, Omit<Principal, 'expiresAt'>> = {
  'local-owner': { tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*' },
  'local-agent-a': { tenantId: 'local', principalId: 'agent-a', roles: ['agent'], repoIds: '*' },
  'local-agent-b': { tenantId: 'local', principalId: 'agent-b', roles: ['agent'], repoIds: '*' },
  'local-agent-c': { tenantId: 'local', principalId: 'agent-c', roles: ['agent'], repoIds: '*' },
  'local-contest-low': { tenantId: 'local', principalId: 'contest-agent-low', roles: ['agent'], repoIds: '*' },
  'local-contest-high': { tenantId: 'local', principalId: 'contest-agent-high', roles: ['agent'], repoIds: '*' },
  'local-mock-aw': { tenantId: 'local', principalId: 'mock-aw', roles: ['agent'], repoIds: '*' },
  'local-reviewer': { tenantId: 'local', principalId: 'reviewer', roles: ['reviewer'], repoIds: '*' },
  'local-checker': { tenantId: 'local', principalId: 'checker', roles: ['checker'], repoIds: '*' },
  'local-promoter': { tenantId: 'local', principalId: 'promoter', roles: ['promoter'], repoIds: '*' },
  'local-viewer': { tenantId: 'local', principalId: 'viewer', roles: ['viewer'], repoIds: '*' },
};

const localTenants = new Set(Object.values(local).map(principal => principal.tenantId));
let configured: { raw: string | undefined; mappings: Record<string, Principal>; tenants: ReadonlySet<string> } | undefined;

function configuredAuth(env: Env): NonNullable<typeof configured> {
  const cached = configured;
  if (cached && cached.raw === env.AUTH_TOKENS) return cached;
  let mappings: Record<string, Principal> = {};
  if (env.AUTH_TOKENS) {
    try { mappings = JSON.parse(env.AUTH_TOKENS) as Record<string, Principal>; }
    catch { throw new HttpError(503, 'AUTH_CONFIG_INVALID', 'Authentication configuration unavailable'); }
  }
  const tenants = new Set<string>();
  for (const principal of Object.values(mappings)) {
    if (principal && typeof principal.tenantId === 'string') tenants.add(principal.tenantId);
  }
  configured = { raw: env.AUTH_TOKENS, mappings, tenants };
  return configured;
}

export function clock(env: Pick<Env, 'CONCORD_MODE' | 'CONCORD_TEST_NOW'>): () => number {
  if (env.CONCORD_MODE === 'local' && env.CONCORD_TEST_NOW !== undefined) {
    const fixed = Number(env.CONCORD_TEST_NOW);
    if (!Number.isFinite(fixed)) throw new Error('Invalid local clock');
    return () => fixed;
  }
  return Date.now;
}

export async function authenticate(request: Request, env: Env, now: () => number = clock(env)): Promise<Principal> {
  const match = /^Bearer (\S+)$/i.exec(request.headers.get('authorization') ?? '');
  if (!match) throw new HttpError(401, 'UNAUTHORIZED', 'Bearer credential required');
  const secret = match[1];
  let principal: Principal | undefined;
  let key: string | undefined;
  if (env.CONCORD_MODE === 'local') {
    const fixture = local[secret];
    if (fixture) principal = { ...fixture, expiresAt: Number.MAX_SAFE_INTEGER };
  } else if (secret.startsWith('local-')) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Fixture credential is not valid in production');
  }
  const auth = !principal ? configuredAuth(env) : undefined;
  if (!principal && env.AUTH_TOKENS) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    key = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    principal = auth?.mappings[key];
  }
  if (!principal) {
    const delegated = /^cct_([A-Za-z0-9_-]{1,64})_([a-f0-9]{64})$/.exec(secret);
    if (delegated) {
      const tenantId = delegated[1];
      if (!auth?.tenants.has(tenantId) && !(env.CONCORD_MODE === 'local' && localTenants.has(tenantId))) {
        throw new HttpError(401, 'UNAUTHORIZED', 'Invalid credential');
      }
      if (!key) {
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
        key = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
      }
      const stub = env.TENANT_CATALOG.get(env.TENANT_CATALOG.idFromName(`tenant:${tenantId}`));
      const lookup = await stub.fetch(new Request('https://concord.internal/internal/principals/lookup', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-concord-tenant': tenantId },
        body: JSON.stringify({ digest: key }),
      }));
      if (lookup.ok) principal = (await lookup.json() as { data: Principal | null }).data ?? undefined;
    }
  }
  const validId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  const validRoles: Role[] = ['owner', 'agent', 'reviewer', 'checker', 'promoter', 'viewer'];
  if (!principal || !validId(principal.principalId) || !validId(principal.tenantId) ||
    !Array.isArray(principal.roles) || principal.roles.length === 0 || principal.roles.some(role => !validRoles.includes(role)) ||
    (principal.repoIds !== '*' && (!Array.isArray(principal.repoIds) || principal.repoIds.some(repoId => !validId(repoId))))) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Invalid credential');
  }
  if (!Number.isFinite(principal.expiresAt) || principal.expiresAt <= now()) {
    throw new HttpError(401, 'CREDENTIAL_EXPIRED', 'Credential expired');
  }
  return principal;
}

export function requireRole(principal: Principal, ...roles: Role[]): void {
  if (!roles.some(role => principal.roles.includes(role))) throw new HttpError(403, 'FORBIDDEN', 'Role not permitted');
}

export function requireRepo(principal: Principal, repoId: string): void {
  if (principal.repoIds !== '*' && !principal.repoIds.includes(repoId)) {
    throw new HttpError(403, 'FORBIDDEN', 'Repository not permitted');
  }
}

export function requireTenant(principal: Principal, claimedTenant: unknown): void {
  if (claimedTenant !== undefined && claimedTenant !== principal.tenantId) {
    throw new HttpError(403, 'TENANT_MISMATCH', 'Tenant does not match credential');
  }
}

/** Coarse role boundary. Feature handlers enforce author/reviewer and job fences. */
export function requireRouteRole(principal: Principal, method: string, path: string): void {
  if (method === 'GET' || method === 'HEAD') return;
  if (path === '/v1/repos' || /\/bootstrap$|\/(?:intent-)?contests$/.test(path)) return requireRole(principal, 'owner');
  if (/\/runner\/|\/jobs\//.test(path)) return requireRole(principal, 'checker', 'promoter');
  if (/\/findings$|\/verdicts$|\/carry$|\/repairs\/[^/]+\/review$/.test(path)) return requireRole(principal, 'reviewer');
  return requireRole(principal, 'agent', 'owner');
}
