import { randomUUID } from 'node:crypto';

export type ConcordErrorKind = 'usage' | 'conflict' | 'auth' | 'transport' | 'server';
export class ConcordError extends Error {
  readonly kind: ConcordErrorKind;
  readonly status?: number;
  readonly payload?: unknown;
  readonly omittedMembers: number;
  constructor(message: string, kind: ConcordErrorKind, status?: number, payload?: unknown, omittedMembers = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.payload = payload;
    this.omittedMembers = omittedMembers;
    this.name = 'ConcordError';
  }
  get exitCode(): number {
    return this.kind === 'usage' ? 2 : this.kind === 'conflict' ? 3 : this.kind === 'auth' ? 4 : 5;
  }
}

export interface ConcordClientOptions {
  url: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  expectedVersion?: number;
  retryMode?: 'default' | 'transport-only';
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const credentials = new Set<string>();
export function rememberCredential(value: string): void {
  if (value.trim().length < 8) return;
  credentials.add(value);
  const bearer = /^Bearer\s+(.+)$/i.exec(value);
  if (bearer) rememberCredential(bearer[1]);
}
export function rememberCredentialsIn(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) rememberCredentialsIn(item); return; }
  for (const [key, item] of Object.entries(value)) {
    if (/(?:token|secret|plaintext|password|credential|api[_-]?key|authorization)/i.test(key)) rememberCredentialValues(item);
    else rememberCredentialsIn(item);
  }
}
function rememberCredentialValues(value: unknown): void {
  if (typeof value === 'string') rememberCredential(value);
  else if (Array.isArray(value)) for (const item of value) rememberCredentialValues(item);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) rememberCredentialValues(item);
}
const normalizedEscapes = (value: string) => value.replace(/%[0-9a-f]{2}/gi, match => match.toUpperCase());
const decodeEscapesOnce = (value: string) => value.replace(/(?:%[0-9a-f]{2})+/gi, run => {
  try { return decodeURIComponent(run); } catch { return run; }
});
function percentDecoded(value: string): { decoded: string; exhausted: boolean } {
  let decoded = value;
  for (let i = 0; i < 10; i++) {
    const next = decodeEscapesOnce(decoded);
    if (next === decoded) return { decoded, exhausted: false };
    decoded = next;
  }
  return { decoded, exhausted: /%[0-9a-f]{2}/i.test(decoded) };
}
export function redactString(value: string): string {
  const normalized = normalizedEscapes(value);
  const { decoded, exhausted } = percentDecoded(value);
  if (exhausted) return '[REDACTED]';
  for (const secret of credentials) {
    let encoded = '';
    try { encoded = encodeURIComponent(secret); } catch { /* A lone surrogate cannot be URI encoded. */ }
    const allEncoded = [...Buffer.from(secret)].map(byte => `%${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('');
    const formEncoded = new URLSearchParams({ value: secret }).toString().slice('value='.length);
    const base64 = Buffer.from(secret).toString('base64');
    const base64url = Buffer.from(secret).toString('base64url');
    if (value.includes(secret) || decoded.includes(secret) || decoded.replace(/\+/g, ' ').includes(secret) || (encoded && normalized.includes(normalizedEscapes(encoded))) || normalized.includes(allEncoded) || normalized.includes(normalizedEscapes(formEncoded)) || decoded.includes(base64) || decoded.includes(base64url)) return '[REDACTED]';
  }
  if (/Bearer\s+\S+/i.test(value) || /(https?:\/\/)[^\s"'@/]+:[^\s"'@/]+@/i.test(value) || /[?&](?:access_token|token|api_key|secret|password)=[^&\s"']+/i.test(value) || /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{12,})\b/.test(value) || /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(value)) return '[REDACTED]';
  return value;
}
// Redact values before JSON.stringify so a credential can never replace JSON syntax.
export interface RedactionCount { omittedMembers: number }
export function redactOutput(value: unknown, count: RedactionCount = { omittedMembers: 0 }): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return redactString(String(value)) === '[REDACTED]' ? '[REDACTED]' : value;
  if (Array.isArray(value)) {
    const safe: unknown[] = [];
    for (const item of value) {
      if (typeof item === 'string' && percentDecoded(item).exhausted) { count.omittedMembers++; continue; }
      safe.push(redactOutput(item, count));
    }
    return safe;
  }
  if (value && typeof value === 'object') {
    const safe: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (redactString(key) === '[REDACTED]' || (typeof item === 'string' && percentDecoded(item).exhausted)) { count.omittedMembers++; continue; }
      Object.defineProperty(safe, key, { value: redactOutput(item, count), enumerable: true, writable: true, configurable: true });
    }
    return safe;
  }
  return value;
}

export class ConcordClient {
  readonly baseUrl: string;
  private readonly options: ConcordClientOptions;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ConcordClientOptions) {
    this.options = options;
    if (options.token) rememberCredential(options.token);
    try { this.baseUrl = new URL(options.url).toString().replace(/\/$/, ''); }
    catch { throw new ConcordError('CONCORD_URL must be a valid absolute URL', 'usage'); }
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? delay;
  }

  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const verb = method.toUpperCase();
    const invalidPath = () => new ConcordError('API path must be an absolute Concord path without traversal', 'usage');
    if (!/^\/(?:v1\/)?[A-Za-z0-9_./:%?=&-]*$/.test(path) || path.includes('\\')) {
      throw invalidPath();
    }
    let decodedPath = path.split('?')[0];
    for (let i = 0; i < 10; i++) {
      let next: string;
      try { next = decodeURIComponent(decodedPath); } catch { throw invalidPath(); }
      if (next === decodedPath) break;
      decodedPath = next;
    }
    if (decodedPath.startsWith('//') || decodedPath.includes('\\') || decodedPath.split('/').some(segment => segment === '.' || segment === '..') || /%[0-9a-f]{2}/i.test(decodedPath)) {
      throw invalidPath();
    }
    const base = new URL(this.baseUrl);
    const url = new URL(path.startsWith('/v1/') ? path : `/v1${path}`, base);
    if (url.origin !== base.origin || !url.pathname.startsWith('/v1/')) {
      throw invalidPath();
    }
    const headers = new Headers({ accept: 'application/json' });
    if (this.options.token) headers.set('authorization', `Bearer ${this.options.token}`);
    let body: string | undefined;
    if (options.body !== undefined) {
      rememberCredentialsIn(options.body);
      const payload = options.expectedVersion === undefined || options.body === null || typeof options.body !== 'object' || Array.isArray(options.body)
        ? options.body
        : { ...options.body as Record<string, unknown>, expectedVersion: options.expectedVersion };
      body = JSON.stringify(payload);
      headers.set('content-type', 'application/json');
    }
    const retryable = verb === 'GET' || (Boolean(options.idempotencyKey) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(verb));
    if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
    let lastError: unknown;
    for (let attempt = 0; attempt < (retryable ? 3 : 1); attempt++) {
      let receivedResponse = false;
      let responseStatus: number | undefined;
      try {
        const response = await this.fetcher(url, { method: verb, headers, body });
        receivedResponse = true;
        responseStatus = response.status;
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        let payload: unknown = text;
        if (text) { try { payload = JSON.parse(text); } catch { /* preserve plain server text */ } }
        rememberCredentialsIn(payload);
        if (response.ok) return payload as T;
        if (retryable && options.retryMode !== 'transport-only' && attempt < 2 && (response.status === 429 || response.status >= 500)) {
          const wait = this.retryDelay(response.headers.get('retry-after'), attempt);
          await this.sleep(wait);
          continue;
        }
        const kind: ConcordErrorKind = response.status === 409 ? 'conflict' : response.status === 401 || response.status === 403 ? 'auth' : 'server';
        if (url.pathname.endsWith('/git-token')) {
          const source = payload && typeof payload === 'object' ? (payload as { error?: unknown }).error : undefined;
          const errorPayload = source && typeof source === 'object' ? source as Record<string, unknown> : {};
          const code = typeof errorPayload.code === 'string' ? errorPayload.code : undefined;
          const safeError: Record<string, unknown> = {};
          if (code !== undefined) safeError.code = code;
          if (typeof errorPayload.message === 'string') safeError.message = errorPayload.message;
          if (errorPayload.details !== undefined) safeError.details = errorPayload.details;
          const count = { omittedMembers: 0 };
          const safePayload = { error: redactOutput(safeError, count) };
          throw new ConcordError(`Git token request failed with HTTP ${response.status}${code ? ` ${code}` : ''}`, kind, response.status, safePayload, count.omittedMembers);
        }
        const count = { omittedMembers: 0 };
        const safePayload = redactOutput(payload, count);
        throw new ConcordError(errorMessage(safePayload, response.status), kind, response.status, safePayload, count.omittedMembers);
      } catch (error) {
        if (error instanceof ConcordError) throw error;
        if (receivedResponse && options.retryMode === 'transport-only') throw new ConcordError('Concord response could not be read', 'server', responseStatus);
        lastError = error;
        if (!retryable || attempt >= 2) break;
        await this.sleep(250 * (2 ** attempt));
      }
    }
    if (url.pathname.endsWith('/git-token')) throw new ConcordError('Git token request failed during transport', 'transport');
    throw new ConcordError(`Concord transport failed: ${safeMessage(lastError)}`, 'transport', undefined, { message: safeMessage(lastError) });
  }

  private retryDelay(value: string | null, attempt: number): number {
    if (value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
      const date = Date.parse(value);
      if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 30_000));
    }
    return 250 * (2 ** attempt);
  }
}

export function idempotencyKey(value?: string): string { return value ?? randomUUID(); }

function errorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const error = (payload as { error?: { message?: unknown; code?: unknown } }).error;
    if (error) {
      const code = typeof error.code === 'string' ? `${error.code}: ` : '';
      if (typeof error.message === 'string') return `${code}${error.message}`;
    }
  }
  return `Concord returned HTTP ${status}`;
}
function safeMessage(error: unknown): string {
  return redactString(String(error instanceof Error ? error.message : error ?? 'unknown error'));
}
