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

export class ConcordClient {
  readonly baseUrl: string;
  private readonly options: ConcordClientOptions;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ConcordClientOptions) {
    this.options = options;
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
        if (response.ok) return payload as T;
        if (retryable && attempt < 2 && (response.status === 429 || response.status >= 500)) {
          const wait = this.retryDelay(response.headers.get('retry-after'), attempt);
          await this.sleep(wait);
          continue;
        }
        const safePayload = redactSecret(payload, this.options.token);
        const kind: ConcordErrorKind = response.status === 409 ? 'conflict' : response.status === 401 || response.status === 403 ? 'auth' : 'server';
        throw new ConcordError(errorMessage(safePayload, response.status), kind, response.status, safePayload);
      } catch (error) {
        if (error instanceof ConcordError) throw error;
        lastError = error;
        if (!retryable || attempt >= 2) break;
        await this.sleep(250 * (2 ** attempt));
      }
    }
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
