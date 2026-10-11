import type { RepoStorage } from '../contracts';

/** Slice 02 replaces this with HTTP calls to the local native-Git bridge. */
export function bridgeStorage(_url: string): RepoStorage {
  throw new Error('BRIDGE_ADAPTER_UNAVAILABLE');
}
