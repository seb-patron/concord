import type { Event, FeatureModule, Migration, ModuleContext, PromotionFreezeProvider, TrustedConfiguration } from './contracts';

/** Queue's slice-01 placeholder until its promotion ticket state exists. */
export const unfrozenPromotion: PromotionFreezeProvider = () => ({ frozen: false });

export interface StateStore {
  get<T>(key: string): T | null;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
}

export function initialize(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS concord_migrations (namespace TEXT PRIMARY KEY, version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS concord_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS concord_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, actor_id TEXT NOT NULL, timestamp INTEGER NOT NULL, version INTEGER NOT NULL, related_ids TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS concord_requests (principal_id TEXT NOT NULL, route TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, status INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(principal_id, route, idempotency_key));`);
}

export function applyMigrations(storage: DurableObjectStorage, module: FeatureModule): void {
  for (const migration of [...module.migrations].sort((a, b) => a.version - b.version)) {
    applyMigration(storage, module.name, migration);
  }
}

function applyMigration(storage: DurableObjectStorage, namespace: string, migration: Migration): void {
  storage.transactionSync(() => {
    const row = storage.sql.exec<{ version: number }>('SELECT version FROM concord_migrations WHERE namespace = ?', namespace).toArray()[0];
    if ((row?.version ?? 0) >= migration.version) return;
    for (const statement of migration.statements) {
      // Feature-owned tables and indexes are namespaced, so independent slices cannot collide.
      if (statement.trim().replace(/;$/, '').includes(';')) throw new Error(`Invalid ${namespace} migration statement`);
      const match = /^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w]+)/i.exec(statement);
      if (!match || !match[1].startsWith(`${namespace}_`)) throw new Error(`Invalid ${namespace} migration namespace`);
      if (/^\s*CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(statement) && !new RegExp(`\\bON\\s+${namespace}_[\\w]+\\b`, 'i').test(statement)) throw new Error(`Invalid ${namespace} migration index`);
      storage.sql.exec(statement);
    }
    storage.sql.exec('INSERT INTO concord_migrations(namespace, version) VALUES(?, ?) ON CONFLICT(namespace) DO UPDATE SET version = excluded.version', namespace, migration.version);
  });
}

export function sqlState(sql: SqlStorage): StateStore {
  return {
    get<T>(key: string): T | null {
      const row = sql.exec<{ value: string }>('SELECT value FROM concord_state WHERE key = ?', key).toArray()[0];
      return row ? JSON.parse(row.value) as T : null;
    },
    put<T>(key: string, value: T): void {
      sql.exec('INSERT INTO concord_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
    },
    delete(key: string): void { sql.exec('DELETE FROM concord_state WHERE key = ?', key); },
  };
}

export function appendEvent(context: Pick<ModuleContext, 'sql' | 'principal' | 'now'>, kind: string, relatedIds: string[], payload: Record<string, unknown>, version: number): Event {
  const timestamp = context.now();
  context.sql.exec('INSERT INTO concord_events(kind, actor_id, timestamp, version, related_ids, payload) VALUES(?, ?, ?, ?, ?, ?)', kind, context.principal.principalId, timestamp, version, JSON.stringify(relatedIds), JSON.stringify(payload));
  const row = context.sql.exec<{ sequence: number }>('SELECT last_insert_rowid() AS sequence').toArray()[0];
  return { sequence: row.sequence, kind, actorId: context.principal.principalId, timestamp, version, relatedIds, payload };
}

export function eventSequence(sql: SqlStorage): number {
  return sql.exec<{ sequence: number }>('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM concord_events').toArray()[0].sequence;
}

export function eventsAfter(sql: SqlStorage, after: number, limit = 100): Event[] {
  return sql.exec<{ sequence: number; kind: string; actor_id: string; timestamp: number; version: number; related_ids: string; payload: string }>(
    'SELECT sequence, kind, actor_id, timestamp, version, related_ids, payload FROM concord_events WHERE sequence > ? ORDER BY sequence LIMIT ?', after, Math.min(101, limit),
  ).toArray().map(row => ({ sequence: row.sequence, kind: row.kind, actorId: row.actor_id, timestamp: row.timestamp, version: row.version, relatedIds: JSON.parse(row.related_ids) as string[], payload: JSON.parse(row.payload) as Record<string, unknown> }));
}

const fixtureDigest = `sha256:${'0'.repeat(64)}` as const;
export const MAX_RESULT_OUTPUT_BYTES = 16 * 1024;
export interface CostLimits { maxReposPerTenant: number; maxForksPerTenant: number; maxTokenMintsPerTenantPerDay: number }
const defaultCostLimits: CostLimits = { maxReposPerTenant: 100, maxForksPerTenant: 1000, maxTokenMintsPerTenantPerDay: 1000 };
export function costLimits(config: TrustedConfiguration): CostLimits {
  const supplied = (config as TrustedConfiguration & { costLimits?: Partial<CostLimits> }).costLimits;
  return { ...defaultCostLimits, ...supplied };
}
export function localFixtureConfig(mode: Env['CONCORD_MODE']): TrustedConfiguration {
  if (mode !== 'local') throw new Error('LOCAL_FIXTURE_FORBIDDEN');
  return {
    policies: {
      'local-demo': { id: 'local-demo', digest: fixtureDigest, version: 1, units: {}, checkerId: 'local-demo', checkerDigest: fixtureDigest, acceptance: { kind: 'hard-gates', gates: [{ id: 'default', requiredOutcome: 'PASS' }] } },
    },
    profiles: {
      'local-demo': { id: 'local-demo', digest: fixtureDigest, toolchainDigest: fixtureDigest, oracleDigest: fixtureDigest, environmentDigest: fixtureDigest, timeoutMs: 120000, maxOutputBytes: MAX_RESULT_OUTPUT_BYTES },
    },
  };
}

export function loadTrustedConfig(env: Pick<Env, 'CONCORD_MODE' | 'TRUSTED_CONFIG'>): TrustedConfiguration {
  if (!env.TRUSTED_CONFIG) {
    if (env.CONCORD_MODE === 'local') return localFixtureConfig(env.CONCORD_MODE);
    throw new Error('TRUSTED_CONFIG_REQUIRED');
  }
  let value: unknown;
  try { value = JSON.parse(env.TRUSTED_CONFIG); } catch { throw new Error('TRUSTED_CONFIG_INVALID'); }
  if (!value || typeof value !== 'object') throw new Error('TRUSTED_CONFIG_INVALID');
  const config = value as TrustedConfiguration;
  if (!config.policies || !config.profiles || typeof config.policies !== 'object' || typeof config.profiles !== 'object') throw new Error('TRUSTED_CONFIG_INVALID');
  const limits = (config as TrustedConfiguration & { costLimits?: Record<string, unknown> }).costLimits;
  if (limits !== undefined && (!limits || typeof limits !== 'object' || Array.isArray(limits) ||
    Object.keys(limits).some(key => !['maxReposPerTenant', 'maxForksPerTenant', 'maxTokenMintsPerTenantPerDay'].includes(key)) ||
    Object.values(limits).some(value => !Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10000))) throw new Error('TRUSTED_CONFIG_INVALID');
  for (const [id, policy] of Object.entries(config.policies)) {
    if (!policy || typeof policy !== 'object') throw new Error('TRUSTED_CONFIG_INVALID');
    if (id !== policy.id || !/^sha256:[a-f0-9]{64}$/.test(policy.digest) || !/^sha256:[a-f0-9]{64}$/.test(policy.checkerDigest) || !policy.units || typeof policy.units !== 'object' || Array.isArray(policy.units)) throw new Error('TRUSTED_CONFIG_INVALID');
    const acceptance = policy.acceptance;
    if (!acceptance || !['hard-gates', 'score'].includes(acceptance.kind) || !Array.isArray(acceptance.gates) || acceptance.gates.length === 0 || !acceptance.gates.every(gate => gate && typeof gate.id === 'string' && gate.id.length > 0 && ['MATCH', 'PASS'].includes(gate.requiredOutcome))) throw new Error('TRUSTED_CONFIG_INVALID');
    if (acceptance.kind === 'score' && (!Number.isSafeInteger(acceptance.fixedDenominator) || acceptance.fixedDenominator <= 0)) throw new Error('TRUSTED_CONFIG_INVALID');
  }
  for (const [id, profile] of Object.entries(config.profiles)) {
    if (!profile || typeof profile !== 'object') throw new Error('TRUSTED_CONFIG_INVALID');
    if (id !== profile.id || ![profile.digest, profile.toolchainDigest, profile.oracleDigest, profile.environmentDigest].every(digest => /^sha256:[a-f0-9]{64}$/.test(digest)) || !Number.isSafeInteger(profile.maxOutputBytes) || profile.maxOutputBytes < 1 || profile.maxOutputBytes > MAX_RESULT_OUTPUT_BYTES) throw new Error('TRUSTED_CONFIG_INVALID');
  }
  return config;
}
