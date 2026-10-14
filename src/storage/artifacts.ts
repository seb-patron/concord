import type { RepoStorage, StorageRepo } from '../contracts';
import { pendingInitialToken, pendingResultFailure, revokeOrphanTokens } from '../repos/model';

const progress = new Set(['CREATE_IN_PROGRESS', 'IMPORT_IN_PROGRESS', 'FORK_IN_PROGRESS']);
const code = (error: unknown): string | undefined => typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
const pending = (name: string): StorageRepo => ({ name, remote: '', status: 'provisioning' });
type Captured<T> = { ok: true; value: T; credential: string | null } | { ok: false; reason: string; credential: string | null };
const field = (raw: unknown, key: string): unknown => raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined;

/** Capture a credential before inspecting any other provider response field. */
function capture<T>(raw: unknown, credentialField: string | null, reason: string, validate: (raw: unknown) => T, suppliedCredential?: string): Captured<T> {
  const extracted = credentialField ? field(raw, credentialField) : suppliedCredential;
  const credential = typeof extracted === 'string' && extracted.length > 0 ? extracted : null;
  try { return { ok: true, value: validate(raw), credential }; }
  catch { return { ok: false, reason, credential }; }
}

function record(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') throw new Error('INVALID_RESULT');
  return raw as Record<string, unknown>;
}

function revoked(raw: unknown, tokenIdOrSecret: string): boolean {
  const checked = capture(raw, null, 'ARTIFACTS_REVOKE_RESULT_INVALID', value => {
    if (typeof value !== 'boolean') throw new Error('INVALID_RESULT');
    return value;
  }, tokenIdOrSecret);
  return checked.ok ? checked.value : false;
}

/** A failed handle cleanup must not discard a credential returned by the provider. */
function disposeCredentialHandle(repo: ArtifactsRepo, operation: 'fork' | 'mintToken'): boolean {
  try { repo[Symbol.dispose](); return false; }
  catch {
    console.warn('ARTIFACTS_DISPOSE_FAILED', operation);
    return true;
  }
}

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

  async function created(result: unknown, expectedName: string): Promise<StorageRepo> {
    const checked = capture(result, 'token', 'ARTIFACTS_CREATE_RESULT_INVALID', raw => {
      const value = record(raw);
      if (value.name !== expectedName || typeof value.remote !== 'string' || !value.remote.startsWith('https://') || typeof value.token !== 'string' || !value.token) throw new Error('INVALID_RESULT');
      return value;
    });
    if (!checked.ok) {
      if (checked.credential) return Object.assign(pending(expectedName), { [pendingInitialToken]: checked.credential, [pendingResultFailure]: checked.reason });
      throw new Error(checked.reason);
    }
    // The coordinator must persist the token before attempting revocation.
    // Even if the first status lookup fails, return the credential for retry.
    let observed: StorageRepo | null;
    try { observed = await info(expectedName); }
    catch { observed = null; }
    return Object.assign(observed ?? pending(expectedName), { [pendingInitialToken]: checked.credential! });
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
        let result: StorageRepo;
        let disposalFailed = false;
        try { result = await created(await source.fork(targetName, { readOnly: false, defaultBranchOnly: false }), targetName); }
        finally { disposalFailed = disposeCredentialHandle(source, 'fork'); }
        if (disposalFailed) result[pendingResultFailure] ??= 'ARTIFACTS_DISPOSE_FAILED';
        return result;
      } catch (error) {
        if (code(error) === 'ALREADY_EXISTS') return await info(targetName) ?? pending(targetName);
        throw error;
      }
    },
    info,
    async resolveRef(name, ref) {
      if (!ref.startsWith('refs/heads/') || ref.slice('refs/heads/'.length).split('/').some(segment => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) || segment.includes('..') || segment.endsWith('.') || segment.endsWith('.lock'))) throw new Error('INVALID_REF');
      using repo = await binding.get(name);
      return (await repo.log({ ref: ref.slice('refs/heads/'.length), limit: 1 }))[0]?.hash ?? null;
    },
    async readCommit(name, oid) {
      using repo = await binding.get(name);
      const commit = await repo.readCommit(oid);
      return commit ? { oid: commit.hash, treeOid: commit.treeHash, parents: commit.parents } : null;
    },
    async listTree(name, oid, path, knownTreeOid) {
      using repo = await binding.get(name);
      let treeOid = knownTreeOid;
      if (!treeOid) {
        const commit = await repo.readCommit(oid);
        if (!commit) return null;
        treeOid = commit.treeHash;
      }
      for (const segment of path ? path.split('/') : []) {
        const entries = await repo.readTree(treeOid);
        const child = entries?.find(entry => entry.name === segment && entry.type === 'tree');
        if (!child) return null;
        treeOid = child.hash;
      }
      return (await repo.readTree(treeOid))?.slice(0, 1001).map(entry => ({ name: entry.name, type: entry.type, oid: entry.hash })) ?? null;
    },
    async readFile(name, oid, path, maxBytes) {
      using repo = await binding.get(name);
      const file = await repo.readFile({ ref: oid, path });
      if (!file) return null;
      if (maxBytes !== undefined && file.size > maxBytes) throw new Error('FILE_TOO_LARGE');
      return new Uint8Array(await file.arrayBuffer());
    },
    async mintToken(name, scope, ttlSeconds) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 600) throw new Error('INVALID_TOKEN_TTL');
      const repo = await binding.get(name);
      let checked: Captured<{ secret: string; expiresAt: number }>;
      let disposalFailed = false;
      try {
        checked = capture(await repo.createToken(scope, ttlSeconds), 'plaintext', 'ARTIFACTS_TOKEN_RESULT_INVALID', raw => {
          const value = record(raw);
          if (typeof value.plaintext !== 'string' || !value.plaintext || typeof value.expiresAt !== 'string') throw new Error('INVALID_RESULT');
          const expiresAt = Date.parse(value.expiresAt);
          if (!Number.isFinite(expiresAt)) throw new Error('INVALID_RESULT');
          return { secret: value.plaintext, expiresAt };
        });
      } finally { disposalFailed = disposeCredentialHandle(repo, 'mintToken'); }
      if (checked.ok) return disposalFailed ? { ...checked.value, [pendingResultFailure]: 'ARTIFACTS_DISPOSE_FAILED' } : checked.value;
      if (checked.credential) return { secret: checked.credential, expiresAt: NaN, [pendingResultFailure]: checked.reason };
      throw new Error(checked.reason);
    },
    async revokeToken(name, tokenIdOrSecret) {
      using repo = await binding.get(name);
      return revoked(await repo.revokeToken(tokenIdOrSecret), tokenIdOrSecret);
    },
  };
  storage[revokeOrphanTokens] = async name => {
    using repo = await binding.get(name);
    const listing = await repo.listTokens();
    if (listing.total > 100) throw new Error('ARTIFACTS_TOKEN_AUDIT_REQUIRED');
    for (const token of listing.tokens) {
      if (token.state === 'active' && !revoked(await repo.revokeToken(token.id), token.id)) throw new Error('ARTIFACTS_ORPHAN_TOKEN_REVOCATION_FAILED');
    }
  };
  return storage;
}
