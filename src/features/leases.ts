import type { Change, FeatureModule, Gate, Lease, ModuleContext, Repo, TrustedPolicy } from '../contracts';
import { failure, HttpError, json, unavailableGate } from '../http';
import { eventSequence, sqlState } from '../state';
import { covers, normalizeUnits, overlaps, resolveUnit, unitRegistry, type UnitIdentity } from '../leases/units';

const DEFAULT_TTL_SECONDS = 120;
const MAX_TTL_SECONDS = 300;
const RENEW_AFTER_SECONDS = 40;
const RESERVATION_MS = 30 * 60 * 1000;
const MAX_LIVE_LEASES = 128;

type LeaseRow = {
  lease_id: string; unit_key: string; holder_id: string; change_id: string;
  intent_text: string; fence: number; expires_at: number;
  state: Lease['state']; version: number; created_at: number; updated_at: number;
};
type RefusalRow = { id: number; change_id: string; requester_id: string; intent_text: string; keys: string; conflicts: string; created_at: number };
type VerifiedFootprint = {
  changeId: string; revision: number; headOid: string; policyDigest: string;
  unitKeys: string[]; verifiedBy: 'checker';
};
type QueueEntryEvidence = { changeId: string; state: 'waiting' | 'checking' | 'blocked' | 'merged' | 'withdrawn' };
type ContestEvidence = { contestId: string; parentChangeId: string; childChangeIds: [string, string]; selectedChangeId: string | null; ownerCreated: true; closed?: boolean };

function policy(context: ModuleContext): TrustedPolicy {
  const repo = sqlState(context.sql).get<Repo>('module:repos:repo');
  const policies = context.trusted.policies;
  const policyId = repo?.policyId ?? (Object.keys(policies).length === 1 ? Object.keys(policies)[0] : undefined);
  const selected = policyId ? policies[policyId] : undefined;
  if (!selected || (repo && selected.digest !== repo.policyDigest)) throw new HttpError(503, 'UNIT_POLICY_UNAVAILABLE', 'Trusted unit policy unavailable');
  return selected;
}

function asLease(row: LeaseRow): Lease {
  return {
    leaseId: row.lease_id, unitKey: row.unit_key, holderId: row.holder_id,
    changeId: row.change_id, intentText: row.intent_text, fence: row.fence,
    expiresAt: row.expires_at, state: row.state, version: row.version,
  };
}

function rows(context: ModuleContext, query: string, ...args: (string | number)[]): LeaseRow[] {
  return context.sql.exec<LeaseRow>(query, ...args).toArray();
}

function activeRows(context: ModuleContext, now: number): LeaseRow[] {
  return rows(context, "SELECT * FROM leases_claims WHERE state IN ('active','reserved') AND expires_at > ? ORDER BY unit_key", now);
}

function makeEvent(context: ModuleContext, kind: string, row: LeaseRow, version: number): number {
  return context.appendEvent(kind, [row.lease_id, row.change_id], {
    unitKey: row.unit_key, holderId: row.holder_id, changeId: row.change_id,
    intentText: row.intent_text, fence: row.fence, expiresAt: row.expires_at,
  }, version).sequence;
}

function expireDue(context: ModuleContext, now: number): void {
  for (const row of rows(context, "SELECT * FROM leases_claims WHERE state IN ('active','reserved') AND expires_at <= ? ORDER BY expires_at, lease_id LIMIT 128", now)) {
    const version = context.nextVersion();
    context.sql.exec("UPDATE leases_claims SET state = 'expired', version = ?, updated_at = ? WHERE lease_id = ?", version, now, row.lease_id);
    makeEvent(context, row.state === 'reserved' ? 'lease.reservationExpired' : 'lease.expired', row, version);
  }
}

function ttl(raw: unknown): number {
  if (raw === undefined) return DEFAULT_TTL_SECONDS;
  if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > MAX_TTL_SECONDS) {
    throw new HttpError(422, 'INVALID_TTL', `ttlSeconds must be 1 to ${MAX_TTL_SECONDS}`);
  }
  return raw as number;
}

function fence(raw: unknown): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 1) throw new HttpError(422, 'INVALID_FENCE', 'Current positive fence required');
  return raw as number;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function claim(context: ModuleContext, body: unknown): Response {
  const input = body as Record<string, unknown>;
  if (!validId(input?.changeId) || typeof input.intentText !== 'string' ||
    input.intentText.trim().length === 0 || input.intentText.length > 2000) {
    throw new HttpError(422, 'INVALID_CLAIM', 'changeId and nonempty intentText are required');
  }
  const state = sqlState(context.sql);
  const repo = state.get<Repo>('module:repos:repo');
  if (!repo || repo.repoId !== context.repoId || repo.tenantId !== context.tenantId || repo.status !== 'ready') {
    throw new HttpError(404, 'REPO_NOT_FOUND', 'A ready repository record is required');
  }
  if (!context.readChange) throw new HttpError(501, 'MODULE_UNAVAILABLE', 'Repos change view unavailable');
  const change = context.readChange(input.changeId);
  if (change.status === 'blocked' && change.code === 'MODULE_UNAVAILABLE') {
    throw new HttpError(501, 'MODULE_UNAVAILABLE', 'Repos change view unavailable');
  }
  if (change.status !== 'eligible' || change.value.authorId !== context.principal.principalId ||
    !['draft', 'ready'].includes(change.value.status)) {
    throw new HttpError(403, 'CHANGE_NOT_OWNED', 'An active change owned by the claimant is required');
  }
  const registry = unitRegistry(policy(context));
  const units = normalizeUnits(registry, input.unitKeys);
  const ttlSeconds = ttl(input.ttlSeconds);
  return context.transaction(() => {
    const now = context.now();
    expireDue(context, now);
    const current = activeRows(context, now);
    const conflicts = current.flatMap(row => {
      const identity = resolveUnit(registry, row.unit_key);
      const keys = units.filter(unit => overlaps(identity, unit)).map(unit => unit.key);
      return keys.length ? [{ holderId: row.holder_id, intentText: row.intent_text,
        expiresAt: row.expires_at, keys, leaseId: row.lease_id, state: row.state }] : [];
    });
    if (conflicts.length) {
      const keys = [...new Set(conflicts.flatMap(item => item.keys))].sort();
      context.sql.exec('INSERT INTO leases_refusals(change_id, requester_id, intent_text, keys, conflicts, created_at) VALUES(?, ?, ?, ?, ?, ?)',
        input.changeId as string, context.principal.principalId, input.intentText as string,
        JSON.stringify(units.map(unit => unit.key)), JSON.stringify(conflicts), now);
      const version = context.nextVersion();
      context.appendEvent('lease.refused', [input.changeId as string], {
        intentText: input.intentText as string, keys, conflicts,
        nextAction: "Wait for the holder's lease to expire or be released, then retry the claim.",
      }, version);
      return failure(new HttpError(409, 'LEASE_CONFLICT', 'One or more units are already claimed', {
        holderId: conflicts[0].holderId, intentText: conflicts[0].intentText,
        expiresAt: conflicts[0].expiresAt, keys, conflicts,
        nextAction: `Wait until ${new Date(Math.max(...conflicts.map(item => item.expiresAt))).toISOString()} or ask the holder to release, then retry.`,
      }));
    }
    if (current.length + units.length > MAX_LIVE_LEASES) {
      return failure(new HttpError(429, 'LEASE_CAPACITY', 'Repository has too many live leases'));
    }
    const granted: Lease[] = [];
    let sequence = eventSequence(context.sql);
    for (const unit of units) {
      const previous = context.sql.exec<{ fence: number }>('SELECT fence FROM leases_fences WHERE unit_key = ?', unit.key).toArray()[0];
      const nextFence = (previous?.fence ?? 0) + 1;
      context.sql.exec('INSERT INTO leases_fences(unit_key, fence) VALUES(?, ?) ON CONFLICT(unit_key) DO UPDATE SET fence = excluded.fence', unit.key, nextFence);
      const version = context.nextVersion();
      const row: LeaseRow = {
        lease_id: crypto.randomUUID(), unit_key: unit.key,
        holder_id: context.principal.principalId, change_id: input.changeId as string,
        intent_text: input.intentText as string, fence: nextFence,
        expires_at: now + ttlSeconds * 1000, state: 'active', version,
        created_at: now, updated_at: now,
      };
      context.sql.exec('INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        row.lease_id, row.unit_key, row.holder_id, row.change_id, row.intent_text,
        row.fence, row.expires_at, row.state, row.version, row.created_at, row.updated_at);
      sequence = makeEvent(context, 'lease.claimed', row, version);
      granted.push(asLease(row));
    }
    return json({ leases: granted, renewAfterSeconds: RENEW_AFTER_SECONDS }, context.version(), sequence, 201);
  });
}

function currentLease(context: ModuleContext, leaseId: string, suppliedFence: unknown): LeaseRow {
  const requestedFence = fence(suppliedFence);
  const row = rows(context, 'SELECT * FROM leases_claims WHERE lease_id = ?', leaseId)[0];
  if (!row) throw new HttpError(404, 'LEASE_NOT_FOUND', 'Lease not found');
  if (row.state !== 'active' || row.expires_at <= context.now() ||
      row.holder_id !== context.principal.principalId || row.fence !== requestedFence) {
    throw new HttpError(409, 'LEASE_STALE', 'Current holder and fence required');
  }
  return row;
}

function renew(context: ModuleContext, leaseId: string, body: unknown): Response {
  const input = body as Record<string, unknown>;
  const ttlSeconds = ttl(input.ttlSeconds);
  return context.transaction(() => {
    const row = currentLease(context, leaseId, input.fence);
    const now = context.now();
    const nextFence = row.fence + 1;
    const version = context.nextVersion();
    context.sql.exec('UPDATE leases_fences SET fence = ? WHERE unit_key = ?', nextFence, row.unit_key);
    context.sql.exec('UPDATE leases_claims SET fence = ?, expires_at = ?, version = ?, updated_at = ? WHERE lease_id = ?',
      nextFence, now + ttlSeconds * 1000, version, now, leaseId);
    const updated = { ...row, fence: nextFence, expires_at: now + ttlSeconds * 1000, version, updated_at: now };
    const sequence = makeEvent(context, 'lease.renewed', updated, version);
    return json({ lease: asLease(updated), renewAfterSeconds: RENEW_AFTER_SECONDS }, version, sequence);
  });
}

function release(context: ModuleContext, leaseId: string, body: unknown): Response {
  const input = body as Record<string, unknown>;
  return context.transaction(() => {
    const row = currentLease(context, leaseId, input.fence);
    const version = context.nextVersion();
    context.sql.exec("UPDATE leases_claims SET state = 'released', version = ?, updated_at = ? WHERE lease_id = ?", version, context.now(), leaseId);
    const sequence = makeEvent(context, 'lease.released', row, version);
    return json({ lease: asLease({ ...row, state: 'released', version }) }, version, sequence);
  });
}

type LeaseCursor = { phase: 0 | 1; createdAt: number; leaseId: string; maxVersion: number; serverTime: number };

function parseLeaseCursor(raw: string | null): LeaseCursor | null {
  if (raw === null) return null;
  try {
    if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('invalid');
    const value: unknown = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    const cursor = value as Record<string, unknown>;
    if ((cursor.phase !== 0 && cursor.phase !== 1) ||
      !Number.isSafeInteger(cursor.createdAt) || !validId(cursor.leaseId) ||
      !Number.isSafeInteger(cursor.maxVersion) || (cursor.maxVersion as number) < 0 ||
      !Number.isSafeInteger(cursor.serverTime) || (cursor.serverTime as number) < 0) throw new Error('invalid');
    return cursor as LeaseCursor;
  } catch { throw new HttpError(400, 'INVALID_CURSOR', 'Invalid lease cursor'); }
}

function encodeLeaseCursor(cursor: LeaseCursor): string {
  return btoa(JSON.stringify(cursor)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function projection(context: ModuleContext, cursor: LeaseCursor | null = null) {
  const now = context.now();
  const maxVersion = cursor?.maxVersion ?? context.sql.exec<{ max_version: number }>(
    'SELECT COALESCE(MAX(version), 0) AS max_version FROM leases_claims').toArray()[0].max_version;
  const serverTime = cursor?.serverTime ?? now;
  const after = cursor ? 'AND (created_at < ? OR (created_at = ? AND lease_id < ?))' : '';
  const query = `WITH ordered AS (
    SELECT *, CASE WHEN state IN ('active','reserved') AND expires_at > ? THEN 0 ELSE 1 END AS live_rank
    FROM leases_claims
  ) SELECT * FROM ordered WHERE
    (live_rank = 0 ${cursor?.phase === 1 ? 'AND 0' : after}) OR
    (live_rank = 1 AND version <= ?
      AND NOT (state IN ('active','reserved') AND expires_at > ?)
      ${cursor?.phase === 1 ? after : ''})
    ORDER BY live_rank, created_at DESC, lease_id DESC LIMIT 101`;
  const position = cursor ? [cursor.createdAt, cursor.createdAt, cursor.leaseId] : [];
  const args: (string | number)[] = [now];
  if (cursor?.phase === 0) args.push(...position);
  args.push(maxVersion, serverTime);
  if (cursor?.phase === 1) args.push(...position);
  const page = context.sql.exec<LeaseRow & { live_rank: 0 | 1 }>(query, ...args).toArray();
  const items = page.slice(0, 100)
    .map(row => ({ ...asLease(row),
      state: row.expires_at <= now && (row.state === 'active' || row.state === 'reserved') ? 'expired' : row.state,
      remainingSeconds: row.state === 'active' || row.state === 'reserved' ?
        Math.max(0, Math.ceil((row.expires_at - now) / 1000)) : 0 }));
  const refusals = context.sql.exec<RefusalRow>('SELECT * FROM leases_refusals ORDER BY id DESC LIMIT 20').toArray()
    .map(row => ({ changeId: row.change_id, requesterId: row.requester_id,
      intentText: row.intent_text, keys: JSON.parse(row.keys) as string[],
      conflicts: (JSON.parse(row.conflicts) as Array<{ expiresAt: number }>).map(conflict => ({
        ...conflict, remainingSeconds: Math.max(0, Math.ceil((conflict.expiresAt - now) / 1000)),
      })), createdAt: row.created_at,
      nextAction: 'Wait for the holder to release or the displayed expiry, then retry the claim.' }));
  return { status: items.length || refusals.length || Object.keys(policy(context).units).length ? 'ready' : 'unavailable',
    items, nextCursor: page.length > 100 ? encodeLeaseCursor({
      phase: page[99].live_rank, createdAt: page[99].created_at, leaseId: page[99].lease_id,
      maxVersion, serverTime,
    }) : null,
    refusals, renewAfterSeconds: RENEW_AFTER_SECONDS, serverTime: now };
}

function blocked(context: ModuleContext, code: string, reason: string, evidenceIds: string[] = []): Gate<never> {
  return { status: 'blocked', version: context.version(), code, reason, evidenceIds };
}

/** The repo module writes this record only after checker inspection of the exact revision. */
function verifiedFootprint(context: ModuleContext, changeId: string): { change: Change; verified: VerifiedFootprint; registry: Map<string, UnitIdentity> } | null {
  const state = sqlState(context.sql);
  const change = state.get<Change>(`module:repos:change:${changeId}`);
  const verified = state.get<VerifiedFootprint>(`module:repos:verified:${changeId}`);
  if (!change || !verified || change.changeId !== changeId || change.repoId !== context.repoId ||
    !['ready', 'queued'].includes(change.status) || !change.headOid ||
    verified.verifiedBy !== 'checker' || verified.changeId !== changeId ||
    verified.revision !== change.revision || verified.headOid !== change.headOid ||
    verified.policyDigest !== policy(context).digest || !Array.isArray(verified.unitKeys) ||
    !Array.isArray(change.unitKeys)) return null;
  return { change, verified, registry: unitRegistry(policy(context)) };
}

function reserve(context: ModuleContext, changeId: string, fences: Record<string, number>): Gate<{ reservationFences: Record<string, number> }> {
  if (!context?.sql || !validId(changeId) || !fences || typeof fences !== 'object' || Array.isArray(fences)) return unavailableGate();
  return context.transaction(() => {
    const now = context.now();
    expireDue(context, now);
    const evidence = verifiedFootprint(context, changeId);
    if (!evidence) return blocked(context, 'UNVERIFIED_FOOTPRINT', 'Exact checker-verified write footprint is required');
    const { change, verified, registry } = evidence;
    let writes: UnitIdentity[];
    let declared: UnitIdentity[];
    let claims: UnitIdentity[];
    try {
      writes = normalizeUnits(registry, verified.unitKeys);
      declared = normalizeUnits(registry, change.unitKeys);
      claims = normalizeUnits(registry, Object.keys(fences));
    } catch {
      return blocked(context, 'UNVERIFIED_FOOTPRINT', 'Write or claim identity is invalid');
    }
    if (JSON.stringify(writes.map(unit => unit.key)) !== JSON.stringify(declared.map(unit => unit.key))) {
      return blocked(context, 'UNDECLARED_WRITE', 'Verified writes differ from published units');
    }
    const canonicalFences = new Map<string, number>();
    for (const [key, value] of Object.entries(fences)) {
      if (!Number.isSafeInteger(value) || value < 1) return blocked(context, 'LEASE_STALE', 'Current positive fences required');
      const canonical = resolveUnit(registry, key).key;
      if (canonicalFences.has(canonical)) return blocked(context, 'LEASE_STALE', 'Duplicate alias fences are ambiguous');
      canonicalFences.set(canonical, value);
    }
    if (claims.some(claim => !writes.some(write => covers(claim, write))) ||
        writes.some(write => !claims.some(claim => covers(claim, write)))) {
      return blocked(context, 'UNLEASED_WRITE', 'Fenced claims must cover exactly the verified writes');
    }
    const active = activeRows(context, now);
    const state = sqlState(context.sql);
    const child = state.get<ContestEvidence>(`module:queue:contest-child:${changeId}`);
    const contest = child && state.get<ContestEvidence>(`module:queue:contest:${child.contestId}`);
    if (contest && child?.ownerCreated === true && contest.ownerCreated === true &&
        contest.contestId === child.contestId && contest.parentChangeId === child.parentChangeId &&
        contest.childChangeIds.includes(changeId) && child.childChangeIds.includes(changeId) && !contest.closed) {
      if (contest.selectedChangeId !== null && contest.selectedChangeId !== changeId) {
        return blocked(context, 'LEASE_STALE', 'The selected winner owns this reservation');
      }
      const inherited: Record<string, number> = {};
      const parentRows = active.filter(row => row.state === 'reserved' && row.change_id === contest.parentChangeId);
      for (const claim of claims) {
        const row = parentRows.find(item => item.unit_key === claim.key && item.fence === canonicalFences.get(claim.key));
        if (!row) return blocked(context, 'LEASE_STALE', 'Parent contest reservation and current fences required');
        inherited[claim.key] = row.fence;
      }
      if (active.some(row => !parentRows.includes(row) && writes.some(write => overlaps(resolveUnit(registry, row.unit_key), write)))) {
        return blocked(context, 'LEASE_CONFLICT', 'Contest write overlaps another reservation');
      }
      return { status: 'eligible', version: context.version(), evidenceIds: parentRows.map(row => row.lease_id), value: { reservationFences: inherited } };
    }
    const selected: LeaseRow[] = [];
    for (const claim of claims) {
      const match = active.find(row => row.unit_key === claim.key &&
        row.change_id === changeId && row.holder_id === change.authorId &&
        row.fence === canonicalFences.get(claim.key));
      if (!match) return blocked(context, 'LEASE_STALE', 'Current holder and fence required');
      selected.push(match);
    }
    if (selected.some(row => row.state !== selected[0].state)) {
      return blocked(context, 'LEASE_STALE', 'Claims must have one consistent reservation state');
    }
    for (const row of active) {
      if (selected.includes(row)) continue;
      const unit = resolveUnit(registry, row.unit_key);
      if (writes.some(write => overlaps(unit, write))) return blocked(context, 'LEASE_CONFLICT', 'Verified write overlaps another reservation', [row.lease_id]);
    }
    const reservationFences: Record<string, number> = {};
    if (selected[0].state === 'reserved') {
      for (const row of selected) reservationFences[row.unit_key] = row.fence;
      return { status: 'eligible', version: context.version(), evidenceIds: selected.map(row => row.lease_id), value: { reservationFences } };
    }
    for (const row of selected) {
      const version = context.nextVersion();
      context.sql.exec("UPDATE leases_claims SET state = 'reserved', expires_at = ?, version = ?, updated_at = ? WHERE lease_id = ?",
        now + RESERVATION_MS, version, now, row.lease_id);
      makeEvent(context, 'lease.reserved', { ...row, expires_at: now + RESERVATION_MS }, version);
      reservationFences[row.unit_key] = row.fence;
    }
    return { status: 'eligible', version: context.version(), evidenceIds: selected.map(row => row.lease_id), value: { reservationFences } };
  });
}

function releaseReservation(context: ModuleContext, changeId: string): Gate {
  if (!context?.sql || !validId(changeId)) return unavailableGate();
  return context.transaction(() => {
    const state = sqlState(context.sql);
    const queue = state.get<QueueEntryEvidence>(`module:queue:entry:${changeId}`);
    if (!queue || queue.changeId !== changeId || !['merged', 'withdrawn'].includes(queue.state)) {
      return blocked(context, 'QUEUE_NOT_TERMINAL', 'A terminal queue transition is required');
    }
    const contest = state.get<ContestEvidence>(`module:queue:contest-child:${changeId}`);
    const parent = contest && state.get<ContestEvidence>(`module:queue:contest:${contest.contestId}`);
    const shared = contest?.ownerCreated === true && parent?.ownerCreated === true &&
      parent.contestId === contest.contestId && parent.parentChangeId === contest.parentChangeId &&
      parent.childChangeIds.includes(changeId) && contest.childChangeIds.includes(changeId);
    if (shared && (parent.closed || parent.selectedChangeId !== changeId)) {
      return { status: 'eligible', version: context.version(), evidenceIds: [], value: undefined };
    }
    const reservationChangeId = shared ? parent.parentChangeId : changeId;
    const now = context.now();
    const selected = rows(context, "SELECT * FROM leases_claims WHERE change_id = ? AND state = 'reserved' AND expires_at > ?", reservationChangeId, now);
    if (!selected.length) {
      const previous = rows(context, "SELECT * FROM leases_claims WHERE change_id = ? AND (state IN ('expired','released') OR (state = 'reserved' AND expires_at <= ?))", reservationChangeId, now);
      if (!previous.length) return blocked(context, 'RESERVATION_NOT_FOUND', 'No reservation for this change');
      if (shared) {
        const closed = { ...parent, closed: true };
        state.put(`module:queue:contest:${parent.contestId}`, closed);
        for (const id of parent.childChangeIds) state.put(`module:queue:contest-child:${id}`, closed);
      }
      return { status: 'eligible', version: context.version(), evidenceIds: previous.map(row => row.lease_id), value: undefined };
    }
    for (const row of selected) {
      const version = context.nextVersion();
      context.sql.exec("UPDATE leases_claims SET state = 'released', version = ?, updated_at = ? WHERE lease_id = ?", version, now, row.lease_id);
      makeEvent(context, 'lease.reservationReleased', row, version);
    }
    if (shared) {
      const closed = { ...parent, closed: true };
      state.put(`module:queue:contest:${parent.contestId}`, closed);
      for (const id of parent.childChangeIds) state.put(`module:queue:contest-child:${id}`, closed);
    }
    return { status: 'eligible', version: context.version(), evidenceIds: selected.map(row => row.lease_id), value: undefined };
  });
}

function reservationLive(context: ModuleContext, changeId: string, fences: Record<string, number>): Gate {
  if (!context?.sql || !validId(changeId) || !fences || typeof fences !== 'object' || Array.isArray(fences)) return unavailableGate();
  const state = sqlState(context.sql);
  const child = state.get<ContestEvidence>(`module:queue:contest-child:${changeId}`);
  const contest = child && state.get<ContestEvidence>(`module:queue:contest:${child.contestId}`);
  const shared = child?.ownerCreated === true && contest?.ownerCreated === true &&
    contest.contestId === child.contestId && contest.parentChangeId === child.parentChangeId &&
    contest.childChangeIds.includes(changeId) && child.childChangeIds.includes(changeId) &&
    !contest.closed && (contest.selectedChangeId === null || contest.selectedChangeId === changeId);
  const reservationChangeId = shared ? contest.parentChangeId : changeId;
  const claims = rows(context, "SELECT * FROM leases_claims WHERE change_id = ? AND state = 'reserved' AND expires_at > ?", reservationChangeId, context.now());
  const keys = Object.keys(fences);
  if (!keys.length || claims.length !== keys.length || keys.some(key =>
    !Number.isSafeInteger(fences[key]) || !claims.some(row => row.unit_key === key && row.fence === fences[key]))) {
    return blocked(context, 'LEASE_STALE', 'Live reservation with current fences required');
  }
  return { status: 'eligible', version: context.version(), evidenceIds: claims.map(row => row.lease_id), value: undefined };
}

const collection = /^\/v1\/repos\/[^/]+\/leases$/;
const leaseAction = /^\/v1\/repos\/[^/]+\/leases\/([A-Za-z0-9_-]+)\/(renew|release)$/;

export const leases: FeatureModule = {
  name: 'leases',
  migrations: [{ version: 1, statements: [
    "CREATE TABLE IF NOT EXISTS leases_claims (lease_id TEXT PRIMARY KEY, unit_key TEXT NOT NULL, holder_id TEXT NOT NULL, change_id TEXT NOT NULL, intent_text TEXT NOT NULL, fence INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    'CREATE TABLE IF NOT EXISTS leases_fences (unit_key TEXT PRIMARY KEY, fence INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS leases_refusals (id INTEGER PRIMARY KEY AUTOINCREMENT, change_id TEXT NOT NULL, requester_id TEXT NOT NULL, intent_text TEXT NOT NULL, keys TEXT NOT NULL, conflicts TEXT NOT NULL, created_at INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS leases_claims_live ON leases_claims(state, expires_at)',
  ] }],
  routes: [
    { method: 'GET', pattern: collection, handle: (context, request) => json(projection(context,
      parseLeaseCursor(new URL(request.url).searchParams.get('cursor'))), context.version(), eventSequence(context.sql)) },
    { method: 'POST', pattern: collection, handle: (context, _request, _match, body) => claim(context, body) },
    { method: 'POST', pattern: leaseAction, handle: (context, _request, match, body) => match[2] === 'renew' ? renew(context, match[1], body) : release(context, match[1], body) },
  ],
  snapshot: context => projection(context),
  nextDeadline: context => context.sql.exec<{ deadline: number | null }>("SELECT MIN(expires_at) AS deadline FROM leases_claims WHERE state IN ('active','reserved')").toArray()[0]?.deadline ?? null,
  onAlarm: context => context.transaction(() => expireDue(context, context.now())),
  hooks: { 'leases.reserve': reserve, 'leases.reservationLive': reservationLive, 'leases.releaseReservation': releaseReservation },
};
