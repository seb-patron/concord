/**
 * Concord web API client.
 *
 * Framework-free fetch wrapper over the frozen v1 contract
 * (src/contracts.ts, docs/ARCHITECTURE.md "HTTP and agent interface").
 *
 * Security rules enforced here:
 * - The session Bearer token lives only in module memory (`setSessionToken`).
 *   It is never written to the URL, localStorage, or sessionStorage, and it
 *   is never rendered. All requests are same-origin relative paths so the
 *   token cannot leak to another origin.
 * - Failures are redacted before display: only `code`, a generic `message`,
 *   and `requestId` survive. `details` payloads may carry OIDs or internal
 *   state and are dropped; anything credential-shaped is scrubbed.
 */

// Token lives in module memory only. Nothing here touches URL or storage.
let sessionToken = null;

/** Store the session token in memory. Pass null/'' to forget it. */
export function setSessionToken(token) {
  sessionToken = typeof token === 'string' && token.length > 0 ? token : null;
}

/** Forget the session token. */
export function clearSessionToken() {
  sessionToken = null;
}

/** True when a session token is present in memory. */
export function hasToken() {
  return sessionToken !== null;
}

export class ApiError extends Error {
  constructor(status, code, message, requestId = null, retryable = false, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryable = retryable;
    this.details = details;
  }
}

/**
 * Scrub credential-shaped text. OIDs, digests, and IDs are evidence, not
 * secrets, and are preserved; Bearer values and token query params are not.
 */
export function redactText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:token|secret|authorization)=)[^&\s]*/gi, '$1[REDACTED]');
}

/** Reduce any failure to a display-safe { code, message, requestId }. */
export function redactError(error) {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: redactText(error.message),
      requestId: error.requestId,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: 'UNKNOWN', message: redactText(message), requestId: null };
}

/** Fresh idempotency key per mutation attempt; reused only for same-body retry. */
export function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `key-${Date.now().toString(36)}-${Math.floor(Math.random() * 2 ** 32).toString(36)}`;
}

/**
 * Same-origin JSON fetch. `path` must be a relative /v1 or /health path;
 * absolute URLs are rejected so the in-memory token cannot leave this origin.
 */
export async function apiFetch(path, options = {}, fetchImpl = fetch) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || !/^\/(?:v1(?:\/|\?|$)|health(?:\?|$))/.test(path)) {
    throw new ApiError(400, 'INVALID_PATH', 'Refusing non-local request path');
  }
  const { method = 'GET', body, idempotencyKey } = options;
  const headers = { accept: 'application/json' };
  if (sessionToken) headers.authorization = `Bearer ${sessionToken}`;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  } else if (method !== 'GET' && method !== 'HEAD' && idempotencyKey) {
    headers['idempotency-key'] = idempotencyKey;
  }
  let response;
  try {
    response = await fetchImpl(path, { method, headers, body: payload });
  } catch (error) {
    // Network failure: retryable, never a success, token-free message.
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(0, 'NETWORK_UNREACHABLE', `Network request failed: ${message}`, null, true);
  }
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const failure = parsed && typeof parsed === 'object' ? parsed.error : null;
    const code = failure && typeof failure.code === 'string' ? failure.code : `HTTP_${response.status}`;
    const message = failure && typeof failure.message === 'string' ? failure.message : `Request failed (${response.status})`;
    const requestId = parsed && typeof parsed === 'object' && typeof parsed.requestId === 'string' ? parsed.requestId : null;
    // Keep only documented conflict evidence, never arbitrary server details.
    const raw = response.status === 409 && failure?.details;
    const details = raw && typeof raw === 'object' && code === 'LEASE_CONFLICT' ? {
      holderId: typeof raw.holderId === 'string' ? redactText(raw.holderId) : null,
      intentText: typeof raw.intentText === 'string' ? redactText(raw.intentText) : null,
      expiresAt: Number.isFinite(raw.expiresAt) ? raw.expiresAt : null,
      conflictingKeys: Array.isArray(raw.conflictingKeys) ? raw.conflictingKeys.filter(key => typeof key === 'string').slice(0, 16).map(redactText) : [],
    } : raw && typeof raw === 'object' && code === 'STALE_VERSION' && Number.isSafeInteger(raw.currentVersion) && raw.currentVersion >= 0
      ? { currentVersion: raw.currentVersion } : null;
    throw new ApiError(response.status, code, message, requestId, response.status === 429 || response.status >= 500, details);
  }
  return parsed;
}

/** True for a stale-version conflict: caller must refresh, never fake success. */
export function isStaleConflict(error) {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    (error.code === 'STALE_VERSION' ||
      error.code === 'PROMOTION_IN_PROGRESS' ||
      error.code === 'IDEMPOTENCY_CONFLICT')
  );
}

/** True when the owning feature slice has not landed yet. */
export function isUnavailable(error) {
  return error instanceof ApiError && (error.status === 501 || error.code === 'MODULE_UNAVAILABLE');
}

/** True when the credential lacks the role the server requires. */
export function isForbidden(error) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

// --- Frozen route helpers (docs/ARCHITECTURE.md "HTTP and agent interface") ---

export function getHealth(fetchImpl) {
  return apiFetch('/health', {}, fetchImpl);
}

export function listRepos(fetchImpl) {
  return apiFetch('/v1/repos', {}, fetchImpl);
}

/** Identity is optional during rollout; callers handle a 404 with server-checked actions. */
export function getMe(fetchImpl) {
  return apiFetch('/v1/me', {}, fetchImpl);
}

/** Per-change approval records, including carried verdict provenance. */
export function getVerdicts(repoId, changeId, cursor = null, fetchImpl) {
  const query = typeof cursor === 'string' && cursor ? `?${new URLSearchParams({ cursor })}` : '';
  return apiFetch(`/v1/repos/${encodeURIComponent(repoId)}/changes/${encodeURIComponent(changeId)}/verdicts${query}`,
    {}, typeof cursor === 'function' ? cursor : fetchImpl);
}

export function getSnapshot(repoId, fetchImpl) {
  return apiFetch(`/v1/repos/${encodeURIComponent(repoId)}/snapshot`, {}, fetchImpl);
}

export function getRepoTree(repoId, path = '', oid = null, fetchImpl) {
  const query = new URLSearchParams({ path });
  if (oid) query.set('oid', oid);
  return apiFetch(`/v1/repos/${encodeURIComponent(repoId)}/tree?${query}`, {}, fetchImpl);
}

export function getRepoFile(repoId, path, oid = null, fetchImpl) {
  const query = new URLSearchParams({ path });
  if (oid) query.set('oid', oid);
  return apiFetch(`/v1/repos/${encodeURIComponent(repoId)}/file?${query}`, {}, fetchImpl);
}

export function getRepoReadme(repoId, oid = null, fetchImpl) {
  const query = oid ? `?oid=${encodeURIComponent(oid)}` : '';
  return apiFetch(`/v1/repos/${encodeURIComponent(repoId)}/readme${query}`, {}, fetchImpl);
}

export function getEvents(repoId, after, fetchImpl) {
  const params = new URLSearchParams({ after: String(after), limit: '100' });
  return apiFetch(`/v1/repos/${encodeURIComponent(repoId)}/events?${params}`, {}, fetchImpl);
}

/** POST /v1/repos/:r/leases — creation calls carry no expectedVersion. */
export function claimUnits(repoId, body, idempotencyKey, fetchImpl) {
  return apiFetch(`/v1/repos/${encodeURIComponent(repoId)}/leases`, { method: 'POST', body, idempotencyKey }, fetchImpl);
}

/** POST /v1/repos/:r/queue/enqueue — requires expectedVersion. */
export function enqueueChange(repoId, body, idempotencyKey, fetchImpl) {
  return apiFetch(`/v1/repos/${encodeURIComponent(repoId)}/queue/enqueue`, { method: 'POST', body, idempotencyKey }, fetchImpl);
}

/** POST /v1/repos/:r/queue/withdraw — requires expectedVersion. */
export function withdrawChange(repoId, body, idempotencyKey, fetchImpl) {
  return apiFetch(`/v1/repos/${encodeURIComponent(repoId)}/queue/withdraw`, { method: 'POST', body, idempotencyKey }, fetchImpl);
}

/** POST /v1/repos/:r/changes/:c/verdicts — reviewer role, requires expectedVersion. */
export function submitVerdict(repoId, changeId, body, idempotencyKey, fetchImpl) {
  return apiFetch(
    `/v1/repos/${encodeURIComponent(repoId)}/changes/${encodeURIComponent(changeId)}/verdicts`,
    { method: 'POST', body, idempotencyKey },
    fetchImpl,
  );
}

/**
 * Which minimal actions the server would permit for a set of roles.
 * Mirrors requireRouteRole in src/auth.ts; the server still enforces, so a
 * mismatch surfaces as 401/403 rather than a client-side bypass. Viewers get
 * no mutation affordances.
 */
export function allowedActions(roles) {
  const set = new Set(Array.isArray(roles) ? roles : []);
  return {
    claim: set.has('agent') || set.has('owner'),
    enqueue: set.has('agent') || set.has('owner'),
    withdraw: set.has('agent') || set.has('owner'),
    verdict: set.has('reviewer'),
  };
}
