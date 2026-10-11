import type { DelegatedPrincipal, ModuleContext, Principal, Role, TrustedConfiguration } from '../contracts';
import { requireTenant } from '../auth';
import { encodeCursor, HttpError, json, parseCursor, readJson } from '../http';
import { eventSequence } from '../state';

const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACTIVE_LIMIT = 100;
const MAX_TOTAL_LIMIT = 1000;
const PAGE_SIZE = 25;
const MAX_REPO_IDS = 100;

interface Row extends Record<string, SqlStorageValue> {
  id: string; token_digest: string; roles: string; repo_ids: string;
  expires_at: number; parent_id: string; created_at: number;
  revoked_at: number | null; name: string | null;
}

export function initializePrincipals(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS principals_records (
    id TEXT PRIMARY KEY, token_digest TEXT NOT NULL UNIQUE, roles TEXT NOT NULL,
    repo_ids TEXT NOT NULL, expires_at INTEGER NOT NULL, parent_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, revoked_at INTEGER, name TEXT,
    idempotency_key TEXT,
    UNIQUE(parent_id, idempotency_key)
  )`);
  sql.exec('CREATE INDEX IF NOT EXISTS principals_parent_idx ON principals_records(parent_id)');
}

function publicRecord(row: Row): DelegatedPrincipal {
  return {
    id: row.id, roles: JSON.parse(row.roles) as Role[],
    repoIds: JSON.parse(row.repo_ids) as string[] | '*', expiresAt: row.expires_at,
    parentId: row.parent_id, createdAt: row.created_at, revokedAt: row.revoked_at,
    ...(row.name === null ? {} : { name: row.name }),
  };
}

function limits(config: TrustedConfiguration): { maxTtlMs: number; activeLimit: number; totalLimit: number } {
  const maxTtlMs = config.delegatedPrincipals?.maxTtlMs ?? DEFAULT_TTL_MS;
  const activeLimit = config.delegatedPrincipals?.activeLimit ?? DEFAULT_ACTIVE_LIMIT;
  const totalLimit = config.delegatedPrincipals?.totalLimit ?? MAX_TOTAL_LIMIT;
  if (!Number.isSafeInteger(maxTtlMs) || maxTtlMs < 1000 || !Number.isSafeInteger(activeLimit) || activeLimit < 1 ||
    !Number.isSafeInteger(totalLimit) || totalLimit < 1 || totalLimit > MAX_TOTAL_LIMIT) {
    throw new HttpError(503, 'TRUSTED_CONFIG_INVALID', 'Invalid delegated principal limits');
  }
  return { maxTtlMs, activeLimit, totalLimit };
}

/** Only the catalog's internal lookup path calls this, after checking its tenant identity. */
export function lookupPrincipal(sql: SqlStorage, digest: string, tenantId: string, now: number): Principal | null {
  if (!/^[a-f0-9]{64}$/.test(digest)) return null;
  const row = sql.exec<Row>('SELECT * FROM principals_records WHERE token_digest = ?', digest).toArray()[0];
  if (!row || row.revoked_at !== null || row.expires_at <= now) return null;
  return { tenantId, principalId: row.id, roles: JSON.parse(row.roles) as Role[],
    repoIds: JSON.parse(row.repo_ids) as string[] | '*', expiresAt: row.expires_at };
}

export async function handlePrincipalRoute(context: ModuleContext, request: Request, path: string): Promise<Response> {
  const { principal, sql } = context;
  const now = context.now();
  if (path === '/v1/principals' && request.method === 'GET') {
    const cursor = parseCursor(new URL(request.url).searchParams.get('cursor'));
    // Rows are never deleted, so SQLite rowids give stable, increasing page positions.
    const rows = sql.exec<Row & { page_cursor: number }>(
      'SELECT rowid AS page_cursor, * FROM principals_records WHERE rowid > ? ORDER BY rowid LIMIT ?', cursor, PAGE_SIZE + 1,
    ).toArray();
    const items = rows.slice(0, PAGE_SIZE);
    const nextCursor = rows.length > PAGE_SIZE ? encodeCursor(items[items.length - 1].page_cursor) : null;
    return json({ items: items.map(publicRecord), nextCursor }, context.version(), eventSequence(sql));
  }
  if (path === '/v1/principals' && request.method === 'POST') {
    if (!principal.roles.includes('owner') && !principal.roles.includes('agent')) {
      throw new HttpError(403, 'FORBIDDEN', 'Principal cannot mint');
    }
    const body = await readJson(request);
    requireTenant(principal, body.tenantId);
    const roles = body.roles;
    if (!Array.isArray(roles) || roles.length === 0 || new Set(roles).size !== roles.length ||
      roles.some(role => !['agent', 'reviewer', 'viewer'].includes(role)) ||
      roles.some(role => !principal.roles.includes(role)) ||
      (principal.roles.includes('agent') && !principal.roles.includes('owner') && roles.some(role => !['agent', 'viewer'].includes(role)))) {
      throw new HttpError(403, 'SCOPE_ESCALATION', 'Roles exceed caller scope');
    }
    const repoIds = body.repoIds === undefined ? principal.repoIds : body.repoIds;
    if (repoIds !== '*' && (!Array.isArray(repoIds) || repoIds.length > MAX_REPO_IDS || repoIds.some(id => typeof id !== 'string' || !idPattern.test(id)) || new Set(repoIds).size !== repoIds.length)) {
      throw new HttpError(400, 'INVALID_SCOPE', 'Invalid repoIds');
    }
    if (principal.repoIds !== '*' && (repoIds === '*' || (repoIds as string[]).some(id => !principal.repoIds.includes(id)))) {
      throw new HttpError(403, 'SCOPE_ESCALATION', 'Repositories exceed caller scope');
    }
    const { maxTtlMs, activeLimit, totalLimit } = limits(context.trusted);
    const ttlSeconds = body.ttlSeconds === undefined ? Math.floor(Math.min(DEFAULT_TTL_MS, maxTtlMs) / 1000) : body.ttlSeconds;
    if (!Number.isSafeInteger(ttlSeconds) || (ttlSeconds as number) < 1 || (ttlSeconds as number) * 1000 > maxTtlMs) {
      throw new HttpError(400, 'INVALID_TTL', 'TTL exceeds trusted maximum');
    }
    const expiresAt = now + (ttlSeconds as number) * 1000;
    if (!Number.isSafeInteger(expiresAt) || expiresAt > principal.expiresAt) {
      throw new HttpError(403, 'SCOPE_ESCALATION', 'Expiry exceeds caller scope');
    }
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 128)) {
      throw new HttpError(400, 'INVALID_NAME', 'Name must be 1 to 128 characters');
    }
    const key = request.headers.get('idempotency-key');
    if (key !== null && (key.length < 1 || key.length > 128)) throw new HttpError(400, 'INVALID_KEY', 'Invalid idempotency key');
    const random = crypto.getRandomValues(new Uint8Array(32));
    const token = `cct_${principal.tenantId}_${Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    const digest = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
    const id = crypto.randomUUID();
    context.transaction(() => {
      const parent = sql.exec<Row>('SELECT * FROM principals_records WHERE id = ?', principal.principalId).toArray()[0];
      if (parent && (parent.revoked_at !== null || parent.expires_at <= now)) throw new HttpError(401, 'UNAUTHORIZED', 'Parent principal inactive');
      if (key && sql.exec<{ id: string }>('SELECT id FROM principals_records WHERE parent_id = ? AND idempotency_key = ?', principal.principalId, key).toArray()[0]) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Mint request was already completed; token cannot be shown again');
      }
      const count = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM principals_records WHERE revoked_at IS NULL AND expires_at > ?', now).toArray()[0].count;
      if (count >= activeLimit) throw new HttpError(409, 'PRINCIPAL_CAP', 'Active principal cap reached');
      const total = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM principals_records').toArray()[0].count;
      if (total >= totalLimit) throw new HttpError(409, 'PRINCIPAL_CAP', 'Total principal cap reached');
      sql.exec('INSERT INTO principals_records(id, token_digest, roles, repo_ids, expires_at, parent_id, created_at, revoked_at, name, idempotency_key) VALUES(?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
        id, digest, JSON.stringify(roles), JSON.stringify(repoIds), expiresAt, principal.principalId, now, body.name ?? null, key);
      context.appendEvent('principal.minted', [id], { parentId: principal.principalId, roles, repoIds, expiresAt }, context.nextVersion());
    });
    return json({ ...publicRecord({ id, token_digest: digest, roles: JSON.stringify(roles), repo_ids: JSON.stringify(repoIds), expires_at: expiresAt,
      parent_id: principal.principalId, created_at: now, revoked_at: null, name: (body.name as string | undefined) ?? null }), token }, context.version(), eventSequence(sql), 201);
  }
  const match = /^\/v1\/principals\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (match && request.method === 'DELETE') {
    const target = sql.exec<Row>('SELECT * FROM principals_records WHERE id = ?', match[1]).toArray()[0];
    if (!target) throw new HttpError(404, 'NOT_FOUND', 'Principal not found');
    if (!principal.roles.includes('owner') && target.parent_id !== principal.principalId && target.id !== principal.principalId) {
      throw new HttpError(403, 'FORBIDDEN', 'Cannot revoke this principal');
    }
    const revoked: string[] = [];
    context.transaction(() => {
      const pending = [target.id];
      while (pending.length) {
        const id = pending.pop()!;
        const row = sql.exec<Row>('SELECT * FROM principals_records WHERE id = ?', id).toArray()[0];
        if (!row || row.revoked_at !== null) continue;
        revoked.push(id);
        pending.push(...sql.exec<{ id: string }>('SELECT id FROM principals_records WHERE parent_id = ?', id).toArray().map(child => child.id));
        sql.exec('UPDATE principals_records SET revoked_at = ? WHERE id = ?', now, id);
      }
      if (revoked.length) context.appendEvent('principal.revoked', revoked, { rootId: target.id }, context.nextVersion());
    });
    return json({ revokedIds: revoked }, context.version(), eventSequence(sql));
  }
  throw new HttpError(404, 'NOT_FOUND', 'Unknown principal route');
}
