import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ConcordClient, ConcordError, idempotencyKey } from './client.ts';
import { parseAllowed } from './land.ts';

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
async function post(client: ConcordClient, path: string, body: Obj, version?: number): Promise<Envelope> {
  return client.request('POST', path, { body, expectedVersion: version, idempotencyKey: idempotencyKey() });
}
export function holdSeconds(value = '2h'): number {
  const match = /^([1-9][0-9]*)([smh])$/.exec(value);
  if (!match) throw new ConcordError('--hold must be a positive duration such as 2h', 'usage');
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
export async function changeByIntent(client: ConcordClient, root: string, intentKey: string): Promise<Obj | undefined> {
  return (await pages(client, root, 'changes')).find(item => item.intentKey === intentKey && !['landed', 'closed', 'failed'].includes(item.status));
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
  if (!allowed.length || allowed.length > 16) throw new ConcordError('allowed-files must contain 1 to 16 paths', 'usage');
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
  const sameUnits = published
    ? existing.unitKeys.every((unit: string) => units.some(fileUnit => leaseCovers(fileUnit, unit, policy)))
    : JSON.stringify([...(existing?.unitKeys ?? [])].sort()) === JSON.stringify(units);
  if (existing && (existing.baseOid !== baseOid || existing.intentText !== input.intent || existing.branch !== branch || !sameUnits))
    throw new ConcordError('INTENT_CONFLICT: existing change differs from start inputs', 'conflict');
  const change = (await post(client, `${root}/changes`, {
    intentKey: input.intentKey, intentText: input.intent, baseOid, branch,
    unitKeys: published ? existing.unitKeys : units, dependencyChangeIds: [],
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
  for (const item of held) {
    if (item.expiresAt > Date.now() + Math.max(ttlSeconds / 2, ttlSeconds - 60) * 1000) continue;
    const version = (await get(client, `${root}/snapshot`)).version;
    const renewed = (await post(client, `${root}/leases/${encodeURIComponent(item.leaseId)}/renew`,
      { fence: item.fence, ttlSeconds }, version)).data.lease;
    Object.assign(item, renewed);
  }
  return { changeId: change.changeId, base: change.baseOid, leases: held, expiry: Math.min(...held.map(item => item.expiresAt)) };
}
export async function releaseByIntent(repo: string, intentKey: string, clientInput?: ConcordClient): Promise<Obj> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(repo) || !keyPattern.test(intentKey)) throw new ConcordError('valid --repo and --intent-key are required', 'usage');
  const client = clientFor(clientInput); const root = `/repos/${encodeURIComponent(repo)}`;
  const change = await changeByIntent(client, root, intentKey);
  if (!change) throw new ConcordError('change for intent key was not found', 'usage');
  const held = await liveLeases(client, root, change.changeId);
  for (const item of held) {
    const version = (await get(client, `${root}/snapshot`)).version;
    await post(client, `${root}/leases/${encodeURIComponent(item.leaseId)}/release`, { fence: item.fence }, version);
  }
  return { changeId: change.changeId, released: held.map(item => item.unitKey) };
}
