import type { RepoStorage, StorageRepo } from '../contracts';
import { pendingInitialToken, revokeOrphanTokens } from '../repos/model';

const progress = new Set(['CREATE_IN_PROGRESS', 'IMPORT_IN_PROGRESS', 'FORK_IN_PROGRESS']);
const code = (error: unknown): string | undefined => typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
const pending = (name: string): StorageRepo => ({ name, remote: '', status: 'provisioning' });

/** Cloudflare Artifacts binding adapter. Never exposes creation tokens. */
export function artifactsStorage(bindingInput: unknown): RepoStorage {
  if (!bindingInput || typeof bindingInput !== 'object' || !('get' in bindingInput) || !('create' in bindingInput)) throw new Error('ARTIFACTS_ADAPTER_UNAVAILABLE');
  const binding = bindingInput as Artifacts;
  async function open(name: string): Promise<ArtifactsRepo | null> {
    try { return await binding.get(name); }
    catch (error) {
      if (code(error) === 'NOT_FOUND' || progress.has(code(error) ?? '')) return null;
      throw error;
    }
  }

  async function info(name: string): Promise<StorageRepo | null> {
    const handle = await open(name);
    if (handle) {
      using repo = handle;
      const metadata = await repo.info();
      if (metadata.name !== name || !metadata.remote.startsWith('https://')) throw new Error('ARTIFACTS_INFO_MISMATCH');
      return { name: metadata.name, remote: metadata.remote, status: 'ready' };
    }
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const page = await binding.list({ limit: 100, ...(cursor ? { cursor } : {}) });
      const found = page.repos.find(repo => repo.name === name);
      if (found) return pending(name);
      if (!page.cursor) return null;
      cursor = page.cursor;
    }
    return null;
  }

  async function revokeInitial(name: string, token: string): Promise<boolean> {
    if (!token) return true;
    for (let attempt = 0; attempt < 4; attempt++) {
      const handle = await open(name);
      if (handle) {
        using repo = handle;
        if (!await repo.revokeToken(token)) throw new Error('ARTIFACTS_INITIAL_TOKEN_REVOCATION_FAILED');
        return true;
      }
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 50));
    }
    return false;
  }

  async function created(result: ArtifactsCreateRepoResult, expectedName: string): Promise<StorageRepo> {
    if (result.name !== expectedName || !result.remote.startsWith('https://') || !result.token) throw new Error('ARTIFACTS_CREATE_RESULT_INVALID');
    if (!await revokeInitial(result.name, result.token)) {
      return Object.assign(pending(result.name), { [pendingInitialToken]: result.token });
    }
    const observed = await info(result.name);
    return observed?.status === 'ready' ? observed : pending(result.name);
  }

  const storage: RepoStorage & { [revokeOrphanTokens]?: (name: string) => Promise<void> } = {
    async ensureRepo(name) {
      const existing = await info(name);
      if (existing) return existing;
      try { return await created(await binding.create(name, { setDefaultBranch: 'main' }), name); }
      catch (error) {
        if (code(error) === 'ALREADY_EXISTS') return await info(name) ?? pending(name);
        throw error;
      }
    },
    async fork(sourceName, targetName) {
      const existing = await info(targetName);
      if (existing) return existing;
      const source = await open(sourceName);
      if (!source) throw new Error('ARTIFACTS_SOURCE_UNAVAILABLE');
      try {
        using repo = source;
        return await created(await repo.fork(targetName, { readOnly: false, defaultBranchOnly: false }), targetName);
      } catch (error) {
        if (code(error) === 'ALREADY_EXISTS') return await info(targetName) ?? pending(targetName);
        throw error;
      }
    },
    info,
    async resolveRef(name, ref) {
      if (!ref.startsWith('refs/heads/') || ref.slice('refs/heads/'.length).split('/').some(segment => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) || segment.includes('..') || segment.endsWith('.') || segment.endsWith('.lock'))) throw new Error('INVALID_REF');
      using repo = await binding.get(name);
      return (await repo.log({ ref, limit: 1 }))[0]?.hash ?? null;
    },
    async readCommit(name, oid) {
      using repo = await binding.get(name);
      const commit = await repo.readCommit(oid);
      return commit ? { oid: commit.hash, treeOid: commit.treeHash, parents: commit.parents } : null;
    },
    async readFile(name, oid, path) {
      using repo = await binding.get(name);
      const file = await repo.readFile({ ref: oid, path });
      return file ? new Uint8Array(await file.arrayBuffer()) : null;
    },
    async mintToken(name, scope, ttlSeconds) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 600) throw new Error('INVALID_TOKEN_TTL');
      using repo = await binding.get(name);
      const token = await repo.createToken(scope, ttlSeconds);
      return { secret: token.plaintext, expiresAt: Date.parse(token.expiresAt) };
    },
    async revokeToken(name, tokenIdOrSecret) {
      using repo = await binding.get(name);
      return repo.revokeToken(tokenIdOrSecret);
    },
  };
  storage[revokeOrphanTokens] = async name => {
    using repo = await binding.get(name);
    const listing = await repo.listTokens();
    if (listing.total > 100) throw new Error('ARTIFACTS_TOKEN_AUDIT_REQUIRED');
    for (const token of listing.tokens) {
      if (token.state === 'active' && !await repo.revokeToken(token.id)) throw new Error('ARTIFACTS_ORPHAN_TOKEN_REVOCATION_FAILED');
    }
  };
  return storage;
}
