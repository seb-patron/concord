import type { Principal } from './contracts';
import { HttpError } from './http';
import { loadTrustedConfig } from './state';

const unauthorized = () => new HttpError(401, 'UNAUTHORIZED', 'Invalid Access assertion');
type AccessJwk = JsonWebKey & { kid?: string };
const certCache = new Map<string, { keys: AccessJwk[]; until: number }>();
const unknownKidRefresh = new Map<string, number>();

function decodePart(part: string): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw unauthorized();
  try {
    const bytes = Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw unauthorized(); }
}

async function fetchKeys(team: string, now: number): Promise<AccessJwk[]> {
  let response: Response;
  try { response = await fetch(`https://${team}/cdn-cgi/access/certs`); }
  catch { throw new HttpError(503, 'ACCESS_CERTS_UNAVAILABLE', 'Access certificates unavailable'); }
  if (!response.ok) throw new HttpError(503, 'ACCESS_CERTS_UNAVAILABLE', 'Access certificates unavailable');
  let body: unknown;
  try { body = await response.json(); } catch { throw new HttpError(503, 'ACCESS_CERTS_UNAVAILABLE', 'Access certificates unavailable'); }
  if (!body || typeof body !== 'object' || !('keys' in body) || !Array.isArray(body.keys)) {
    throw new HttpError(503, 'ACCESS_CERTS_UNAVAILABLE', 'Access certificates unavailable');
  }
  const keys = body.keys as AccessJwk[];
  certCache.set(team, { keys, until: now + 60_000 });
  return keys;
}

export function accessConfigured(env: Env): boolean {
  return !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
}

export function accessLogoutUrl(env: Env): string | null {
  return accessConfigured(env) ? `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/logout` : null;
}

export function clearAccessCookie(): string {
  return 'concord_access=; HttpOnly; Secure; SameSite=Strict; Path=/v1; Max-Age=0';
}

export function accessCookie(assertion: string, expiresAt: number, nowMs: number): string {
  const maxAge = Math.max(0, Math.floor(expiresAt / 1000 - nowMs / 1000));
  return `concord_access=${assertion}; HttpOnly; Secure; SameSite=Strict; Path=/v1; Max-Age=${maxAge}`;
}

export async function authenticateAccess(request: Request, env: Env, nowMs: number): Promise<Principal> {
  const team = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  if (!team || !audience || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.cloudflareaccess\.com$/i.test(team)) {
    throw new HttpError(503, 'ACCESS_CONFIG_INVALID', 'Access configuration unavailable');
  }
  const cookies = request.headers.get('cookie')?.split(';').map(part => part.trim()) ?? [];
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion') ||
    cookies.find(part => part.startsWith('CF_Authorization='))?.slice('CF_Authorization='.length) ||
    cookies.find(part => part.startsWith('concord_access='))?.slice('concord_access='.length);
  if (!assertion) throw unauthorized();
  const parts = assertion.split('.');
  if (parts.length !== 3 || parts.some(part => !part)) throw unauthorized();
  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  if (!header || typeof header !== 'object' || Array.isArray(header) ||
    !('alg' in header) || header.alg !== 'RS256' || !('kid' in header) || typeof header.kid !== 'string' ||
    !claims || typeof claims !== 'object' || Array.isArray(claims)) throw unauthorized();
  const jwt = claims as Record<string, unknown>;
  const seconds = nowMs / 1000;
  if (jwt.iss !== `https://${team}` ||
    !(typeof jwt.aud === 'string' ? jwt.aud === audience : Array.isArray(jwt.aud) && jwt.aud.includes(audience)) ||
    typeof jwt.exp !== 'number' || !Number.isSafeInteger(jwt.exp) || jwt.exp + 60 <= seconds ||
    (jwt.nbf !== undefined && (typeof jwt.nbf !== 'number' || !Number.isSafeInteger(jwt.nbf) || jwt.nbf - 60 > seconds)) ||
    typeof jwt.email !== 'string') throw unauthorized();
  let keys = certCache.get(team);
  if (!keys || keys.until <= nowMs) keys = { keys: await fetchKeys(team, nowMs), until: nowMs + 60_000 };
  let key = keys.keys.find(candidate => candidate.kid === header.kid);
  if (!key) {
    const lastRefresh = unknownKidRefresh.get(team) ?? 0;
    if (unknownKidRefresh.has(team) && nowMs - lastRefresh < 30_000) {
      key = undefined;
    } else {
      unknownKidRefresh.set(team, nowMs);
      key = (await fetchKeys(team, nowMs)).find(candidate => candidate.kid === header.kid);
    }
  }
  if (!key || key.kty !== 'RSA' || (key.alg !== undefined && key.alg !== 'RS256') ||
    (key.use !== undefined && key.use !== 'sig') || !key.n || !key.e) throw unauthorized();
  let valid = false;
  try {
    const imported = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signature = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', imported, signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { throw unauthorized(); }
  if (!valid) throw unauthorized();
  let humans;
  try { humans = loadTrustedConfig(env).humans ?? []; }
  catch { throw new HttpError(503, 'AUTH_CONFIG_INVALID', 'Authentication configuration unavailable'); }
  const human = humans.find(entry => entry.email.toLowerCase() === (jwt.email as string).toLowerCase());
  if (!human) throw new HttpError(403, 'HUMAN_NOT_MAPPED', 'Human identity is not mapped');
  return { tenantId: human.tenantId, principalId: human.principalId, roles: human.roles,
    repoIds: human.repoIds, expiresAt: jwt.exp * 1000, authMethod: 'access' };
}
