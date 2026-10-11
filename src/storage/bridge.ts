import type { RepoStorage, StorageCommit, StorageRepo, StorageToken } from '../contracts';

/** Worker-safe HTTP client for the authenticated loopback development bridge. */
export function bridgeStorage(rawUrl: string): RepoStorage {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) throw new Error('BRIDGE_LOOPBACK_REQUIRED');
  const token = url.searchParams.get('token');
  if (!token) throw new Error('BRIDGE_ADAPTER_UNAVAILABLE: token required');
  const endpoint = `${url.origin}/rpc`;
  async function call<T>(operation: string, args: Record<string, unknown>): Promise<T> {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ operation, ...args }),
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`BRIDGE_${response.status}:${(await response.text()).slice(0, 120)}`);
    return response.json() as Promise<T>;
  }
  return {
    ensureRepo: name => call<StorageRepo>('ensureRepo', { name }),
    fork: (sourceName, targetName) => call<StorageRepo>('fork', { sourceName, targetName }),
    info: name => call<StorageRepo | null>('info', { name }),
    resolveRef: (name, ref) => call<string | null>('resolveRef', { name, ref }),
    readCommit: (name, oid) => call<StorageCommit | null>('readCommit', { name, oid }),
    async readFile(name, oid, path) {
      const value = await call<{ bytes: number[] } | null>('readFile', { name, oid, path });
      return value ? new Uint8Array(value.bytes) : null;
    },
    mintToken: (name, scope, ttlSeconds) => call<StorageToken>('mintToken', { name, scope, ttlSeconds }),
    revokeToken: (name, tokenIdOrSecret) => call<boolean>('revokeToken', { name, tokenIdOrSecret }),
  };
}
