import type { ApiFailure, ApiSuccess, FeatureModule, ModuleName } from './contracts';

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export function json<T>(data: T, version = 0, eventSeq = 0, status = 200): Response {
  return new Response(JSON.stringify({ data, version, eventSeq } satisfies ApiSuccess<T>), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export function failure(error: HttpError, requestId = crypto.randomUUID()): Response {
  const payload: ApiFailure = { error: { code: error.code, message: error.message }, requestId };
  if (error.details !== undefined) payload.error.details = error.details;
  const response = new Response(JSON.stringify(payload), {
    status: error.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
  if (error.status === 503) response.headers.set('Retry-After', '5');
  return response;
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(400, 'INVALID_JSON', 'Expected application/json');
  }
  let value: unknown;
  try { value = await request.json(); } catch { throw new HttpError(400, 'INVALID_JSON', 'Malformed JSON body'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_JSON', 'Expected JSON object');
  }
  return value as Record<string, unknown>;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function digest(value: unknown): Promise<`sha256:${string}`> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function expectVersion(body: Record<string, unknown>, current: number): void {
  if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) {
    throw new HttpError(400, 'EXPECTED_VERSION_REQUIRED', 'expectedVersion must be a nonnegative integer');
  }
  if (body.expectedVersion !== current) throw new HttpError(409, 'STALE_VERSION', 'Object version is stale', { currentVersion: current });
}

/** Creation and runner claim/result calls do not mutate an existing domain object. */
export function requiresExpectedVersion(method: string, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') return false;
  if (/^\/v1\/repos\/[A-Za-z0-9_-]{1,64}\/(changes|leases|contests|runner\/poll)$/.test(path)) return false;
  if (/^\/v1\/repos\/[A-Za-z0-9_-]{1,64}\/(issues|milestones|milestone-settings)$/.test(path) || /^\/v1\/repos\/[A-Za-z0-9_-]{1,64}\/(issues\/\d+|milestones\/[A-Za-z0-9_-]+(?:\/close)?)(?:\/(?:close|reopen))?$/.test(path)) return false;
  if (/^\/v1\/repos\/[A-Za-z0-9_-]{1,64}\/jobs\/[A-Za-z0-9_-]{1,64}\/(heartbeat|result|credentials)$/.test(path)) return false;
  if (/^\/v1\/repos\/[A-Za-z0-9_-]{1,64}\/leases\/renew-batch$/.test(path)) return false;
  return true;
}

export function parseCursor(raw: string | null): number {
  if (raw === null) return 0;
  try {
    const decoded = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    if (!/^\d+$/.test(decoded)) throw new Error('invalid');
    const value = Number(decoded);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid');
    return value;
  } catch { throw new HttpError(400, 'INVALID_CURSOR', 'Invalid event cursor'); }
}

export function encodeCursor(sequence: number): string {
  return btoa(String(sequence)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function unavailableGate(version = 0) {
  return { status: 'blocked' as const, version, code: 'MODULE_UNAVAILABLE', reason: 'Feature is not implemented', evidenceIds: [] };
}

export function unavailableModule(name: ModuleName, patterns: RegExp[]): FeatureModule {
  return {
    name,
    migrations: [],
    routes: patterns.map(pattern => ({
      method: '*', pattern,
      handle: (context, _request, _match, body) => {
        if (body && typeof body === 'object' && 'expectedVersion' in body) {
          expectVersion(body as Record<string, unknown>, context.version());
        }
        return failure(new HttpError(501, 'MODULE_UNAVAILABLE', `${name} is not implemented`));
      },
    })),
    snapshot: () => ({ status: 'unavailable', items: [] }),
    nextDeadline: () => null,
    onAlarm: () => undefined,
    hooks: {},
  };
}
