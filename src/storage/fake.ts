import type { Oid, RepoStorage, StorageCommit, StorageRepo, StorageToken, StorageTreeEntry } from '../contracts';
import type { StateStore } from '../state';

interface FakeRepo {
  name: string;
  refs: Record<string, Oid>;
  commits: Record<Oid, StorageCommit>;
  files: Record<Oid, Record<string, number[]>>;
  tokens: Record<string, { scope: 'read' | 'write'; expiresAt: number }>;
}

const encoder = new TextEncoder();
const hex = (bytes: Uint8Array): Oid => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = (oid: Oid): Uint8Array => new Uint8Array(oid.match(/../g)!.map(pair => parseInt(pair, 16)));
/** Real Git object identity so fake trees and blobs advertise usable 40-hex OIDs. */
async function objectOid(kind: 'blob' | 'tree', body: Uint8Array): Promise<Oid> {
  const header = encoder.encode(`${kind} ${body.byteLength}\0`);
  const payload = new Uint8Array(header.byteLength + body.byteLength);
  payload.set(header); payload.set(body, header.byteLength);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-1', payload)));
}

/** Test provider. Its remotes are identifiers, never smart HTTP Git endpoints. */
export class FakeStorage implements RepoStorage {
  constructor(private readonly state: StateStore, private readonly now: () => number = Date.now) {}

  private repo(name: string): FakeRepo | null { return this.state.get<FakeRepo>(`fake:repo:${name}`); }
  private save(repo: FakeRepo): void { this.state.put(`fake:repo:${repo.name}`, repo); }
  private fault(operation: string): void {
    const key = `fake:fault:${operation}`;
    const remaining = this.state.get<number>(key) ?? 0;
    if (remaining > 0) { this.state.put(key, remaining - 1); throw new Error(`FAKE_FAULT:${operation}`); }
  }

  failNext(operation: keyof RepoStorage | 'conditionalUpdateRef', times = 1): void {
    this.state.put(`fake:fault:${operation}`, times);
  }

  async ensureRepo(name: string): Promise<StorageRepo> {
    this.fault('ensureRepo');
    let repo = this.repo(name);
    if (!repo) { repo = { name, refs: {}, commits: {}, files: {}, tokens: {} }; this.save(repo); }
    return { name, remote: `fake://${encodeURIComponent(name)}`, status: 'ready' };
  }

  async fork(sourceName: string, targetName: string): Promise<StorageRepo> {
    this.fault('fork');
    const source = this.repo(sourceName);
    if (!source) throw new Error('FAKE_SOURCE_MISSING');
    if (!this.repo(targetName)) this.save({ ...structuredClone(source), name: targetName, tokens: {} });
    return { name: targetName, remote: `fake://${encodeURIComponent(targetName)}`, status: 'ready' };
  }

  async info(name: string): Promise<StorageRepo | null> {
    this.fault('info');
    return this.repo(name) ? { name, remote: `fake://${encodeURIComponent(name)}`, status: 'ready' } : null;
  }

  async resolveRef(name: string, ref: string): Promise<Oid | null> {
    this.fault('resolveRef');
    return this.repo(name)?.refs[ref] ?? null;
  }

  async readCommit(name: string, oid: Oid): Promise<StorageCommit | null> {
    this.fault('readCommit');
    return this.repo(name)?.commits[oid] ?? null;
  }

  async readFile(name: string, oid: Oid, path: string, maxBytes?: number): Promise<Uint8Array | null> {
    this.fault('readFile');
    const bytes = this.repo(name)?.files[oid]?.[path];
    if (!bytes) return null;
    if (maxBytes !== undefined && bytes.length > maxBytes) throw new Error('FILE_TOO_LARGE');
    return new Uint8Array(bytes);
  }

  /** The Git tree OID of a directory inside the flat per-commit file map. */
  private async treeOid(files: Record<string, number[]>, prefix: string): Promise<Oid> {
    const base = prefix ? `${prefix}/` : '';
    const children = new Map<string, 'blob' | 'tree'>();
    for (const file of Object.keys(files)) {
      if (prefix && !file.startsWith(base)) continue;
      const [segment, ...rest] = file.slice(base.length).split('/');
      if (segment) children.set(segment, rest.length ? 'tree' : 'blob');
    }
    const parts: Uint8Array[] = [];
    let length = 0;
    // Git sorts tree entries by name with an implicit trailing slash on subtrees.
    const ordered = [...children.keys()].sort((a, b) => {
      const left = children.get(a) === 'tree' ? `${a}/` : a;
      const right = children.get(b) === 'tree' ? `${b}/` : b;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    for (const child of ordered) {
      const kind = children.get(child)!;
      const childOid = kind === 'tree' ? await this.treeOid(files, `${base}${child}`) : await objectOid('blob', new Uint8Array(files[`${base}${child}`]));
      const head = encoder.encode(`${kind === 'tree' ? '40000' : '100644'} ${child}\0`);
      parts.push(head, unhex(childOid));
      length += head.byteLength + 20;
    }
    const body = new Uint8Array(length);
    let at = 0;
    for (const part of parts) { body.set(part, at); at += part.byteLength; }
    return objectOid('tree', body);
  }

  async listTree(name: string, oid: Oid, path: string): Promise<StorageTreeEntry[] | null> {
    this.fault('listTree');
    const files = this.repo(name)?.files[oid];
    if (!files || (path && !Object.keys(files).some(file => file.startsWith(`${path}/`)))) return null;
    const entries = new Map<string, StorageTreeEntry>();
    for (const file of Object.keys(files)) {
      if (path && !file.startsWith(`${path}/`)) continue;
      const remainder = path ? file.slice(path.length + 1) : file;
      const [segment, ...rest] = remainder.split('/');
      if (!segment) continue;
      const entryPath = path ? `${path}/${segment}` : segment;
      entries.set(segment, rest.length
        ? { name: segment, type: 'tree', oid: await this.treeOid(files, entryPath) }
        : { name: segment, type: 'blob', oid: await objectOid('blob', new Uint8Array(files[file])) });
    }
    return [...entries.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).slice(0, 1001);
  }

  async mintToken(name: string, scope: 'read' | 'write', ttlSeconds: number): Promise<StorageToken> {
    this.fault('mintToken');
    const repo = this.repo(name);
    if (!repo) throw new Error('FAKE_REPO_MISSING');
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) throw new Error('FAKE_TTL_INVALID');
    const counter = (this.state.get<number>('fake:token-counter') ?? 0) + 1;
    this.state.put('fake:token-counter', counter);
    const secret = `fake-token:${name}:${counter}`;
    const expiresAt = this.now() + ttlSeconds * 1000;
    repo.tokens[secret] = { scope, expiresAt };
    this.save(repo);
    return { secret, expiresAt };
  }

  async revokeToken(name: string, tokenIdOrSecret: string): Promise<boolean> {
    this.fault('revokeToken');
    const repo = this.repo(name);
    if (!repo || !repo.tokens[tokenIdOrSecret]) return false;
    delete repo.tokens[tokenIdOrSecret];
    this.save(repo);
    return true;
  }

  /** Inject immutable Git objects. Reusing an OID with different bytes fails. */
  putCommit(name: string, commit: StorageCommit, files: Record<string, Uint8Array> = {}): void {
    const repo = this.repo(name);
    if (!repo) throw new Error('FAKE_REPO_MISSING');
    const encoded = Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, Array.from(bytes)]));
    const previous = repo.commits[commit.oid];
    if (previous && JSON.stringify({ commit: previous, files: repo.files[commit.oid] }) !== JSON.stringify({ commit, files: encoded })) {
      throw new Error('FAKE_IMMUTABLE_OBJECT');
    }
    repo.commits[commit.oid] = structuredClone(commit);
    repo.files[commit.oid] = encoded;
    this.save(repo);
  }

  /** Test-only old-OID compare-and-swap, including expected absence for bootstrap. */
  conditionalUpdateRef(name: string, ref: string, expectedOldOid: Oid | null, nextOid: Oid): boolean {
    this.fault('conditionalUpdateRef');
    const repo = this.repo(name);
    if (!repo || !repo.commits[nextOid]) throw new Error('FAKE_COMMIT_MISSING');
    if ((repo.refs[ref] ?? null) !== expectedOldOid) return false;
    repo.refs[ref] = nextOid;
    this.save(repo);
    return true;
  }
}
