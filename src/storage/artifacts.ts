import type { RepoStorage } from '../contracts';

/** Slice 02 replaces this with the real Artifacts binding adapter. */
export function artifactsStorage(_binding: unknown): RepoStorage {
  throw new Error('ARTIFACTS_ADAPTER_UNAVAILABLE');
}
