import { randomUUID } from 'node:crypto';

export type ConcordErrorKind = 'usage' | 'conflict' | 'auth' | 'transport' | 'server';
export class ConcordError extends Error {
  readonly kind: ConcordErrorKind;
  readonly status?: number;
  readonly payload?: unknown;
  constructor(message: string, kind: ConcordErrorKind, status?: number, payload?: unknown) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.payload = payload;
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
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const credentials = new Set<string>();
export function rememberCredential(value: string): void { if (value) credentials.add(value); }
export function rememberCredentialsIn(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) rememberCredentialsIn(item); return; }
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /(?:token|secret|plaintext|password|credential|api[_-]?key|authorization)/i.test(key)) rememberCredential(item);
    else rememberCredentialsIn(item);
  }
}
// The CLI calls this once for each complete JSON line, after serialization.
export function redactOutput(line: string): string {
  let result = line;
  for (const secret of [...credentials].sort((a, b) => b.length - a.length)) {
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])) {
      if (form) result = result.split(form).join('[REDACTED]');
    }
  }
  return result
    .replace(/Bearer\s+[A-Za-z0-9._~+/%=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^\s"'@/]+:[^\s"'@/]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:access_token|token|api_key|secret|password)=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
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
    if (!/^\/(?:v1\/)?[A-Za-z0-9_./:%?=&-]*$/.test(path) || path.includes('..')) {
      throw new ConcordError('API path must be an absolute Concord path without traversal', 'usage');
    }
    const url = new URL(path.startsWith('/v1/') ? path : `/v1${path.startsWith('/') ? path : `/${path}`}`, `${this.baseUrl}/`);
    const headers = new Headers({ accept: 'application/json' });
    if (this.options.token) headers.set('authorization', `Bearer ${this.options.token}`);
    let body: string | undefined;
    if (options.body !== undefined) {
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
      try {
        const response = await this.fetcher(url, { method: verb, headers, body });
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        let payload: unknown = text;
        if (text) { try { payload = JSON.parse(text); } catch { /* preserve plain server text */ } }
        rememberCredentialsIn(payload);
        if (response.ok) return payload as T;
        if (retryable && attempt < 2 && (response.status === 429 || response.status >= 500)) {
          const wait = this.retryDelay(response.headers.get('retry-after'), attempt);
          await this.sleep(wait);
          continue;
        }
        const kind: ConcordErrorKind = response.status === 409 ? 'conflict' : response.status === 401 || response.status === 403 ? 'auth' : 'server';
        if (url.pathname.endsWith('/git-token')) throw new ConcordError(`Git token request failed with HTTP ${response.status}`, kind, response.status);
        const safePayload = redactSecret(payload, this.options.token);
        throw new ConcordError(errorMessage(safePayload, response.status), kind, response.status, safePayload);
      } catch (error) {
        if (error instanceof ConcordError) throw error;
        lastError = error;
        if (!retryable || attempt >= 2) break;
        await this.sleep(250 * (2 ** attempt));
      }
    }
    if (url.pathname.endsWith('/git-token')) throw new ConcordError('Git token request failed during transport', 'transport');
    throw new ConcordError(`Concord transport failed: ${safeMessage(lastError, this.options.token)}`, 'transport', undefined, { message: safeMessage(lastError, this.options.token) });
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
function safeMessage(error: unknown, token?: string): string {
  const message = String(error instanceof Error ? error.message : error ?? 'unknown error').replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  return token ? message.split(token).join('[REDACTED]') : message;
}
function redactSecret(value: unknown, token?: string): unknown {
  if (typeof value === 'string') return token ? value.split(token).join('[REDACTED]') : value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map(item => redactSecret(item, token));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSecret(item, token)]));
  return value;
}
