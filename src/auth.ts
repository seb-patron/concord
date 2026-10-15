import type { Principal, Role } from './contracts';
import { HttpError } from './http';
import { accessConfigured, authenticateAccess } from './access';

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
const modelLabel = /^[A-Za-z0-9._:/-]{1,64}$/;
type TokenPrincipal = Omit<Principal, 'expiresAt'> & { expiresAt: number | null };
type AuthConfig = { source: string; mappings: Record<string, TokenPrincipal>; tenants: ReadonlySet<string> };
let cachedTokens: AuthConfig | undefined;

/** Validate the entire secret mapping when loaded, and cache its operator tenant IDs for delegated-token routing. */
function loadAuthConfig(source: string): AuthConfig {
  if (cachedTokens?.source === source) return cachedTokens;
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new HttpError(503, 'AUTH_CONFIG_INVALID', 'Authentication configuration unavailable'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.values(value).some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      ('model' in entry && (typeof entry.model !== 'string' || !modelLabel.test(entry.model))))) {
    throw new HttpError(503, 'AUTH_CONFIG_INVALID', 'Authentication configuration unavailable');
  }
  const mappings = value as Record<string, TokenPrincipal>;
  const tenants = new Set<string>();
  for (const principal of Object.values(mappings)) {
    if (typeof principal.tenantId === 'string') tenants.add(principal.tenantId);
  }
  cachedTokens = { source, mappings, tenants };
  return cachedTokens;
}

/** Validate the entire secret mapping when loaded, before selecting a credential. */
export function loadAuthTokens(source: string): Record<string, TokenPrincipal> {
  return loadAuthConfig(source).mappings;
}

export function clock(env: Pick<Env, 'CONCORD_MODE' | 'CONCORD_TEST_NOW'>): () => number {
  if (env.CONCORD_MODE === 'local' && env.CONCORD_TEST_NOW !== undefined) {
    const fixed = Number(env.CONCORD_TEST_NOW);
    if (!Number.isFinite(fixed)) throw new Error('Invalid local clock');
    return () => fixed;
  }
  return Date.now;
}

export async function authenticateWithExpiry(request: Request, env: Env, now: () => number = clock(env)):
Promise<{ principal: Principal; expiresAt: number | null }> {
  const authorization = request.headers.get('authorization');
  if (authorization === null && accessConfigured(env)) {
    const principal = await authenticateAccess(request, env, now());
    return { principal, expiresAt: principal.expiresAt };
  }
  const match = /^Bearer (\S+)$/i.exec(authorization ?? '');
  if (!match) throw new HttpError(401, 'UNAUTHORIZED', 'Bearer credential required');
  const secret = match[1];
  let credential: TokenPrincipal | undefined;
  let key: string | undefined;
  if (env.CONCORD_MODE === 'local') {
    const fixture = local[secret];
    if (fixture) credential = { ...fixture, expiresAt: Number.MAX_SAFE_INTEGER };
  } else if (secret.startsWith('local-')) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Fixture credential is not valid in production');
  }
  const auth = !credential && env.AUTH_TOKENS ? loadAuthConfig(env.AUTH_TOKENS) : undefined;
  if (!credential && auth) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    key = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
    credential = auth.mappings[key];
  }
  if (!credential) {
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
      if (lookup.ok) {
        const found = (await lookup.json() as { data: Principal | null }).data;
        if (found && found.tenantId === tenantId && typeof found.principalId === 'string' &&
          Array.isArray(found.roles) && (found.repoIds === '*' || Array.isArray(found.repoIds)) &&
          typeof found.expiresAt === 'number') credential = found;
      }
    }
  }
  const validId = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
  const validRoles: Role[] = ['owner', 'agent', 'reviewer', 'checker', 'promoter', 'viewer'];
  if (!credential || !validId(credential.principalId) || !validId(credential.tenantId) ||
    !Array.isArray(credential.roles) || credential.roles.length === 0 || credential.roles.some(role => !validRoles.includes(role)) ||
    (credential.repoIds !== '*' && (!Array.isArray(credential.repoIds) || credential.repoIds.some(repoId => !validId(repoId))))) {
    throw new HttpError(401, 'UNAUTHORIZED', 'Invalid credential');
  }
  if (credential.expiresAt !== null && (!Number.isFinite(credential.expiresAt) || credential.expiresAt <= now())) {
    throw new HttpError(401, 'CREDENTIAL_EXPIRED', 'Credential expired');
  }
  return { principal: { ...credential, expiresAt: credential.expiresAt ?? Number.MAX_SAFE_INTEGER }, expiresAt: credential.expiresAt };
}

export async function authenticate(request: Request, env: Env, now: () => number = clock(env)): Promise<Principal> {
  return (await authenticateWithExpiry(request, env, now)).principal;
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
  if (method === 'POST' && /\/v1\/repos\/[^/]+\/git-token$/.test(path)) return requireRole(principal, 'agent', 'owner', 'reviewer');
  return requireRole(principal, 'agent', 'owner');
}
