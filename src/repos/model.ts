import type { Change, Digest, Intent, ModuleContext, Oid, Repo } from '../contracts';
import { HttpError } from '../http';
import { sqlState } from '../state';

export { pendingInitialToken, pendingResultFailure } from '../contracts';
/** Internal Artifacts cleanup after a create response was lost before its token was received. */
export const revokeOrphanTokens: unique symbol = Symbol('revokeOrphanTokens');

export interface ProvisioningIntent {
  kind: 'ensure-repo' | 'fork';
  storageName: string;
  sourceName?: string;
  requestDigest: Digest;
  state: 'intent' | 'creating' | 'token-held' | 'revoking' | 'observed' | 'failed';
  everObserved?: boolean;
  polls: number;
  retryAt: number;
  error?: string;
}

export interface InspectionPending {
  changeId: string;
  revision: number;
  jobId: string;
  inputDigest: string;
  sourceTreeOid: Oid;
  headOid: Oid;
  baseOid: Oid;
  unitKeys: string[];
  scheduled: boolean;
}

export interface BootstrapPending {
  changeId: string;
  headOid: Oid;
  seedRef: string;
  seedStorageName: string;
  withHistory?: boolean;
  jobId: string;
  scratchStorageName?: string;
  status: 'provisioning' | 'requested' | 'blocked';
}

export const terminal = (change: Change): boolean => ['merged', 'superseded', 'closed'].includes(change.status);

/** Keep the repo projection and intent index in step with a verified queue landing. */
export function mergeLandedChanges(context: ModuleContext, changeIds: string[], canonicalOid: Oid): string[] {
  const state = sqlState(context.sql);
  const changesKey = 'module:repos:changes';
  const changes = state.get<Array<Change & { canonicalOid?: Oid }>>(changesKey) ?? [];
  const landed = new Set(changeIds);
  const changed: string[] = [];
  for (const change of changes) {
    if (!landed.has(change.changeId) || (change.status === 'merged' && change.canonicalOid === canonicalOid)) continue;
    change.status = 'merged';
    change.canonicalOid = canonicalOid;
    change.version = context.nextVersion();
    context.appendEvent('change.merged', [change.changeId], { canonicalOid }, change.version);
    state.put(`module:repos:change:${change.changeId}`, change);
    try {
      const release = context.call('leases.releaseForChange', change.changeId, 'change-merged');
      if (release.status === 'blocked' && release.code !== 'MODULE_UNAVAILABLE') {
        throw new HttpError(409, release.code, release.reason);
      }
    } catch (error) {
      if (!(error instanceof HttpError) || error.code !== 'MODULE_UNAVAILABLE') throw error;
    }
    changed.push(change.changeId);
  }
  if (changed.length) {
    state.put(changesKey, changes);
    const intentsKey = 'module:repos:intents';
    const intents = state.get<Intent[]>(intentsKey) ?? [];
    for (const intent of intents) {
      const change = changes.find(item => item.changeId === intent.changeId && changed.includes(item.changeId));
      if (change) { intent.terminal = true; intent.version = change.version; }
    }
    state.put(intentsKey, intents);
  }
  return changed;
}
export const repoName = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new HttpError(400, 'INVALID_REPO_NAME', 'Repository name must be 1 to 64 letters, digits, underscores, or hyphens');
  return value;
};
export const oid = (value: unknown): Oid => {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new HttpError(400, 'INVALID_OID', 'Expected a 40-character Git SHA-1 OID');
  return value;
};
export const branch = (value: unknown): string => {
  if (typeof value !== 'string' || !value.startsWith('refs/heads/') ||
    value.slice('refs/heads/'.length).split('/').some(segment => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) || segment.includes('..') || segment.endsWith('.') || segment.endsWith('.lock'))) {
    throw new HttpError(400, 'INVALID_BRANCH', 'Expected a valid refs/heads/ branch');
  }
  return value;
};
export const text = (value: unknown, field: string, max = 2048): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, 'INVALID_INPUT', `${field} is required and must be at most ${max} characters`);
  return value;
};
export const ids = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length > 128 || value.some(item => typeof item !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(item)) || new Set(value).size !== value.length) throw new HttpError(400, 'INVALID_INPUT', `${field} must contain unique identifiers`);
  return value as string[];
};
export function requireReady(repo: Repo): void {
  if (repo.status !== 'ready') throw new HttpError(409, 'REPO_NOT_READY', 'Repository provisioning is not ready');
}

export function sameTask(change: Change, input: { intentText: string; branch: string; unitKeys: string[]; dependencyChangeIds: string[] }): boolean {
  return change.intentText === input.intentText && change.branch === input.branch &&
    JSON.stringify([...change.unitKeys].sort()) === JSON.stringify([...input.unitKeys].sort()) &&
    JSON.stringify([...change.dependencyChangeIds].sort()) === JSON.stringify([...input.dependencyChangeIds].sort());
}
