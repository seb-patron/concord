import type { Change, Digest, Oid, Repo } from '../contracts';
import { HttpError } from '../http';

/** Internal-only handoff of an Artifacts create token awaiting handle readiness. */
export const pendingInitialToken: unique symbol = Symbol('pendingInitialToken');
/** Internal Artifacts cleanup after a create response was lost before its token was received. */
export const revokeOrphanTokens: unique symbol = Symbol('revokeOrphanTokens');

export interface ProvisioningIntent {
  kind: 'ensure-repo' | 'fork';
  storageName: string;
  sourceName?: string;
  requestDigest: Digest;
  state: 'pending' | 'observed' | 'failed';
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
  jobId: string;
  status: 'requested' | 'blocked';
}

export const terminal = (change: Change): boolean => ['merged', 'superseded', 'closed'].includes(change.status);
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
