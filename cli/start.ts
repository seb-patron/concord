import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConcordClient, ConcordError, idempotencyKey } from './client.ts';
import { parseAllowed } from './land.ts';
import { MAX_NORMALIZED_UNITS, unitsOverCapMessage } from '../src/leases/units.ts';

type Obj = Record<string, any>;
type Envelope = { data: Obj; version: number };
export type StartOptions = { repo: string; intentKey: string; intent: string; allowedFiles: string;
  base?: string; hold?: string; client?: ConcordClient };
const oid = /^[a-f0-9]{40}$/i;
const keyPattern = /^[A-Za-z0-9_-]{1,128}$/;

function clientFor(input?: ConcordClient): ConcordClient {
  if (input) return input;
  if (!process.env.CONCORD_URL || !process.env.CONCORD_TOKEN) throw new ConcordError('CONCORD_URL and CONCORD_TOKEN are required', 'usage');
  return new ConcordClient({ url: process.env.CONCORD_URL, token: process.env.CONCORD_TOKEN });
}
async function get(client: ConcordClient, path: string): Promise<Envelope> { return client.request('GET', path); }
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
// A pending queue promotion briefly freezes every repository mutation with 409 PROMOTION_IN_PROGRESS.
// Retry for about ten seconds, re-reading the coordinator version that the promotion advances.
async function post(client: ConcordClient, path: string, body: Obj, version?: number, sleep: (ms: number) => Promise<void> = pause): Promise<Envelope> {
  for (let attempt = 0; ; attempt++) {
    try { return await client.request('POST', path, { body, expectedVersion: version, idempotencyKey: idempotencyKey() }); }
    catch (error) {
      if (!(error instanceof ConcordError) || (error.payload as Obj)?.error?.code !== 'PROMOTION_IN_PROGRESS' || attempt >= 19) throw error;
      await sleep(500);
      const root = /^\/repos\/[^/]+/.exec(path)?.[0];
      if (version !== undefined && root) version = (await get(client, `${root}/snapshot`)).version;
    }
  }
}
export function holdSeconds(value = '5m'): number {
  const match = /^([1-9][0-9]*)([smh])$/.exec(value);
  if (!match) throw new ConcordError('--hold must be a positive duration such as 5m or 30m', 'usage');
  const seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2]] ?? 1);
  if (!Number.isSafeInteger(seconds)) throw new ConcordError('--hold is too large', 'usage');
  return seconds;
}
async function pages(client: ConcordClient, root: string, kind: 'changes' | 'leases'): Promise<Obj[]> {
  const items: Obj[] = []; let cursor: string | null = null;
  do {
    const page: Obj = (await get(client, `${root}/${kind}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)).data;
    items.push(...page.items ?? []); cursor = page.nextCursor ?? null;
  } while (cursor);
  return items;
}
export async function changeByIntent(client: ConcordClient, root: string, intentKey: string, includeTerminal = false): Promise<Obj | undefined> {
  return (await pages(client, root, 'changes')).find(item => item.intentKey === intentKey &&
    (includeTerminal || !['landed', 'closed', 'failed'].includes(item.status)));
}
export async function liveLeases(client: ConcordClient, root: string, changeId: string): Promise<Obj[]> {
  return (await pages(client, root, 'leases')).filter(item => item.changeId === changeId && item.state === 'active' && item.expiresAt > Date.now());
}
export function leaseCovers(claim: string, unit: string, policy?: Obj): boolean {
  if (claim === unit) return true;
  if (!claim.startsWith('file:')) return false;
  const file = claim.slice(5);
  if (unit.startsWith('file:')) return unit === claim;
  const registered = Object.entries(policy?.units ?? {}).find(([alias, spec]) => alias === unit || (spec as Obj).canonicalKey === unit);
  if (registered) return (registered[1] as Obj).file === file;
  const table = (policy?.tables ?? []).find((item: Obj) => item.file === file);
  return !!table && unit.startsWith(`row:${table.name}:`);
}
export async function start(input: StartOptions): Promise<Obj> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.repo) || !keyPattern.test(input.intentKey) || !input.intent?.trim())
    throw new ConcordError('valid --repo, --intent-key and --intent are required', 'usage');
  if (input.base && !oid.test(input.base)) throw new ConcordError('--base requires a full 40-hex OID', 'usage');
  const allowed = [...parseAllowed(await readFile(input.allowedFiles, 'utf8'))].sort();
  if (!allowed.length) throw new ConcordError('allowed-files must contain at least 1 path', 'usage');
  if (allowed.length > MAX_NORMALIZED_UNITS) throw new ConcordError(unitsOverCapMessage(allowed.length), 'usage');
  const units = allowed.map(file => `file:${file}`);
  const ttlSeconds = holdSeconds(input.hold);
  const client = clientFor(input.client);
  const root = `/repos/${encodeURIComponent(input.repo)}`;
  const repo = (await get(client, root)).data;
  const existing = await changeByIntent(client, root, input.intentKey);
  const baseOid = input.base ?? existing?.baseOid ?? repo.observedCanonicalOid;
  if (!oid.test(baseOid)) throw new ConcordError('canonical main is unavailable', 'server');
  const branch = `refs/heads/land/${createHash('sha256').update(input.intentKey).digest('hex').slice(0, 16)}`;
  const published = !!existing?.headOid;
  const snapshot = published ? (await get(client, `${root}/snapshot`)).data : undefined;
  const policy = snapshot?.projections?.repos?.unitPolicy ?? (snapshot?.projections?.runners?.jobs ?? [])
    .map((job: Obj) => job.unitPolicy).find((item: Obj | undefined) => item?.digest === repo.policyDigest);
  const sameUnits = existing?.startUnitKeys
    ? JSON.stringify([...existing.startUnitKeys].sort()) === JSON.stringify(units)
    : published
      ? existing.unitKeys.every((unit: string) => units.some(fileUnit => leaseCovers(fileUnit, unit, policy)))
      : JSON.stringify([...(existing?.unitKeys ?? [])].sort()) === JSON.stringify(units);
  if (existing && (existing.baseOid !== baseOid || existing.intentText !== input.intent || existing.branch !== branch || !sameUnits))
    throw new ConcordError('INTENT_CONFLICT: existing change differs from start inputs', 'conflict');
  const change = (await post(client, `${root}/changes`, {
    intentKey: input.intentKey, intentText: input.intent, baseOid, branch,
    unitKeys: published ? existing.unitKeys : units, dependencyChangeIds: [], startScope: true,
  })).data;
  if (existing && change.changeId !== existing.changeId)
    throw new ConcordError('INTENT_CONFLICT: change changed during restart', 'conflict');
  const needed = published ? change.unitKeys as string[] : units;
  const held = (await liveLeases(client, root, change.changeId)).filter(item =>
    needed.some(unit => leaseCovers(item.unitKey, unit, policy)));
  const missing = needed.filter(unit => !held.some(item => leaseCovers(item.unitKey, unit, policy)));
  if (missing.length) {
    const version = (await get(client, `${root}/snapshot`)).version;
    const claim = (await post(client, `${root}/leases`, { changeId: change.changeId, unitKeys: missing,
      intentText: input.intent, ttlSeconds }, version)).data;
    held.push(...claim.leases);
  }
  if (needed.some(unit => !held.some(item => leaseCovers(item.unitKey, unit, policy))))
    throw new ConcordError('claim response did not cover every required unit', 'server');
  const needsRenewal = held.some(item => item.expiresAt <= Date.now() + Math.max(ttlSeconds / 2, ttlSeconds - 60) * 1000);
  if (needsRenewal) {
    const renewed = (await post(client, `${root}/leases/renew-batch`,
      { changeId: change.changeId, ttlSeconds })).data.leases ?? [];
    for (const item of renewed) {
      const adopted = held.find(value => value.leaseId === item.leaseId || value.unitKey === item.unitKey);
      if (adopted) Object.assign(adopted, item);
    }
  }
  return { changeId: change.changeId, base: change.baseOid, leases: held, expiry: Math.min(...held.map(item => item.expiresAt)) };
}
export async function releaseByIntent(repo: string, intentKey: string, clientInput?: ConcordClient): Promise<Obj> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(repo) || !keyPattern.test(intentKey)) throw new ConcordError('valid --repo and --intent-key are required', 'usage');
  const client = clientFor(clientInput); const root = `/repos/${encodeURIComponent(repo)}`;
  const change = await changeByIntent(client, root, intentKey);
  if (!change) throw new ConcordError('change for intent key was not found', 'usage');
  const reused = (await post(client, `${root}/changes`, {
    intentKey: change.intentKey, intentText: change.intentText, baseOid: change.baseOid,
    branch: change.branch, unitKeys: change.unitKeys,
    dependencyChangeIds: change.dependencyChangeIds ?? [], ...(change.startUnitKeys ? { startScope: true } : {}),
  })).data;
  if (reused.changeId !== change.changeId)
    throw new ConcordError('INTENT_CONFLICT: change changed during release', 'conflict');
  const held = await liveLeases(client, root, change.changeId);
  for (const item of held) {
    const version = (await get(client, `${root}/snapshot`)).version;
    await post(client, `${root}/leases/${encodeURIComponent(item.leaseId)}/release`, { fence: item.fence }, version);
  }
  return { changeId: change.changeId, released: held.map(item => item.unitKey) };
}

export type RenewOptions = { repo: string; intentKey: string; hold?: string; every?: number; whilePid?: number;
  client?: ConcordClient; sleep?: (ms: number) => Promise<void>; alive?: (pid: number) => boolean };
export async function renewByIntent(input: RenewOptions): Promise<Obj> {
  const { repo, intentKey } = input;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(repo) || !keyPattern.test(intentKey))
    throw new ConcordError('valid --repo and --intent-key are required', 'usage');
  if (input.every !== undefined && (!Number.isSafeInteger(input.every) || input.every < 10 || input.every > 3600))
    throw new ConcordError('--every must be an integer from 10 to 3600 seconds', 'usage');
  if (input.whilePid !== undefined && (!Number.isSafeInteger(input.whilePid) || input.whilePid < 1))
    throw new ConcordError('--while-pid must be a positive process ID', 'usage');
  const ttlSeconds = holdSeconds(input.hold ?? '5m');
  const client = clientFor(input.client); const root = `/repos/${encodeURIComponent(repo)}`;
  const sleep = input.sleep ?? pause;
  const alive = input.alive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  const change = await changeByIntent(client, root, intentKey, true);
  if (!change) throw new ConcordError('change for intent key was not found', 'usage');
  const round = async (): Promise<Obj> => {
    let response: Envelope;
    try { response = await post(client, `${root}/leases/renew-batch`, { changeId: change.changeId, ttlSeconds }, undefined, sleep); }
    catch (error) {
      if (error instanceof ConcordError && error.payload && (error.payload as Obj)?.error?.code === 'PROMOTION_IN_PROGRESS') throw error;
      throw error;
    }
    const leases = (response.data.leases ?? []) as Obj[];
    const reserved = (response.data.reserved ?? []) as Obj[];
    if (!leases.length && reserved.length) return { changeId: change.changeId, renewed: [], status: 'queued' };
    if (!leases.length && !reserved.length) {
      const current = (await get(client, `${root}/changes/${encodeURIComponent(change.changeId)}`)).data;
      if (['merged', 'closed', 'superseded'].includes(current.status)) return current;
    }
    const scope = (change.headOid ? change.unitKeys : change.startUnitKeys ?? change.unitKeys) as string[];
    const coverageRows = [...leases, ...reserved];
    let policy: Obj | undefined;
    if (scope.some(unit => coverageRows.some(item => typeof item.unitKey === 'string' && item.unitKey.startsWith('file:') && item.unitKey !== unit))) {
      const snapshot = (await get(client, `${root}/snapshot`)).data;
      policy = snapshot.projections?.repos?.unitPolicy ?? (snapshot.projections?.runners?.jobs ?? [])
        .map((job: Obj) => job.unitPolicy).find((item: Obj | undefined) => item?.digest === change.policyDigest);
    }
    const missing = scope.filter(unit => !coverageRows.some(item => typeof item.unitKey === 'string' && leaseCovers(item.unitKey, unit, policy)));
    if (missing.length) throw new ConcordError(`LEASE_LOST: ${missing.join(', ')}; re-run concord start to claim them again`, 'conflict');
    return { changeId: change.changeId, renewed: [...new Set(scope)], expiry: Math.min(...leases.map(item => Number(item.expiresAt))) };
  };
  if (input.every === undefined) return round();
  const pid = input.whilePid ?? process.ppid;
  let stopped = false;
  let last: Obj = { changeId: change.changeId, renewed: [], status: 'stopped' };
  let wake: (() => void) | undefined;
  const stop = () => { stopped = true; wake?.(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    while (!stopped && alive(pid)) {
      try {
        const result = await round();
        if (result.status === 'queued' || ['merged', 'closed', 'superseded'].includes(String(result.status))) return result;
        last = result;
      } catch (error) {
        const code = error instanceof ConcordError ? (error.payload as Obj)?.error?.code : undefined;
        const retryable = error instanceof ConcordError &&
          ((error.kind === 'transport' && error.status === undefined) || (error.status === 409 && code === 'PROMOTION_IN_PROGRESS'));
        if (!retryable) throw error;
        // A heartbeat can recover from transport failures and promotion freezes on its next round.
      }
      if (!stopped) await Promise.race([sleep(input.every * 1000), new Promise<void>(resolve => { wake = resolve; })]);
      wake = undefined;
    }
    return last;
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
