import { createServer, type Server } from 'node:http';
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRepoPath } from '../src/repos/paths';

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const oidPattern = /^[a-f0-9]{40}$/;
const MAX_REPO_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = MAX_REPO_BYTES;
const MAX_TREE_ROWS = 1001;
const MAX_TREE_OUTPUT_BYTES = MAX_TREE_ROWS * (4096 + 128);

/** Parse NUL-delimited ls-tree records without splitting or decoding the full listing. */
export function createTreeRowParser(maxRows = MAX_TREE_ROWS) {
  let pending = Buffer.alloc(0);
  let rowsParsed = 0;
  let consumedBytes = 0;
  const entries: { name: string; type: 'tree' | 'blob' | 'exec' | 'symlink' | 'gitlink'; oid: string }[] = [];
  const addRow = (row: Buffer) => {
    const tab = row.indexOf(9);
    const meta = tab === -1 ? [] : row.subarray(0, tab).toString('ascii').split(' ');
    const [mode, kind, hash] = meta;
    const entryName = tab === -1 ? '' : row.subarray(tab + 1).toString('utf8');
    if (meta.length !== 3 || !/^[0-7]+$/.test(mode) || !['blob', 'tree', 'commit'].includes(kind) || !/^[a-f0-9]{40}$/.test(hash) || !entryName) {
      throw new Error('INVALID_TREE_ENTRY');
    }
    const type = kind === 'tree' ? 'tree' : kind === 'commit' ? 'gitlink' : mode === '120000' ? 'symlink' : mode === '100755' ? 'exec' : 'blob';
    entries.push({ name: entryName, type, oid: hash });
  };
  return {
    push(chunk: Uint8Array): boolean {
      if (rowsParsed >= maxRows) return true;
      const incoming = Buffer.from(chunk);
      const data = pending.length ? Buffer.concat([pending, incoming]) : incoming;
      let start = 0;
      while (rowsParsed < maxRows) {
        const end = data.indexOf(0, start);
        if (end === -1) break;
        addRow(data.subarray(start, end));
        rowsParsed++;
        consumedBytes += end + 1 - start;
        start = end + 1;
      }
      pending = rowsParsed >= maxRows ? Buffer.alloc(0) : data.subarray(start);
      return rowsParsed >= maxRows;
    },
    finish() { if (pending.length) throw new Error('INVALID_TREE_ENTRY'); },
    get entries() { return entries; },
    get rowsParsed() { return rowsParsed; },
    get consumedBytes() { return consumedBytes; },
  };
}

export interface GitBridge { server: Server; url: string; close(): Promise<void> }

/** A local fake backend. It never binds a public interface. */
export async function startGitBridge(dataDirectory: string, token: string, port = 0): Promise<GitBridge> {
  if (!token || token.length < 16) throw new Error('BRIDGE_TOKEN_REQUIRED');
  const root = resolve(dataDirectory);
  mkdirSync(root, { recursive: true });
  const tokenFile = join(root, '.bridge-tokens.json');
  const tokens = new Map<string, { name: string; expiresAt: number }>(existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, 'utf8')) as Array<[string, { name: string; expiresAt: number }]> : []);
  const tokenHash = (secret: string) => createHash('sha256').update(secret).digest('hex');
  const saveTokens = () => {
    const staged = `${tokenFile}.tmp`;
    writeFileSync(staged, JSON.stringify([...tokens]), { mode: 0o600 });
    renameSync(staged, tokenFile);
  };
  const name = (value: unknown): string => {
    if (typeof value !== 'string' || !namePattern.test(value) || value === '.' || value === '..') throw new Error('INVALID_STORAGE_NAME');
    return value;
  };
  const repoPath = (value: unknown): string => join(root, `${name(value)}.git`);
  const git = (args: string[], maxBuffer = MAX_REPO_BYTES): Buffer => execFileSync('git', args, {
    timeout: 10_000, maxBuffer,
    env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const size = (path: string): number => readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error('INVALID_STORAGE_PATH');
    return total + (entry.isDirectory() ? size(child) : entry.isFile() ? statSync(child).size : 0);
  }, 0);
  const remote = (value: unknown) => {
    const path = repoPath(value);
    if (!existsSync(path)) throw new Error('UNKNOWN_STORAGE_NAME');
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('INVALID_STORAGE_PATH');
    if (git(['--git-dir', path, 'rev-parse', '--is-bare-repository']).toString().trim() !== 'true') throw new Error('INVALID_STORAGE_PATH');
    if (size(path) > MAX_REPO_BYTES) throw new Error('REPO_TOO_LARGE');
    return { name: name(value), remote: pathToFileURL(path).href, status: 'ready' as const };
  };
  const validOid = (value: unknown) => {
    if (typeof value !== 'string' || !oidPattern.test(value)) throw new Error('INVALID_OID');
    return value;
  };
  const validRef = (value: unknown) => {
    if (typeof value !== 'string' || !value.startsWith('refs/heads/') || value.slice('refs/heads/'.length).split('/').some(segment => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) || segment.includes('..') || segment.endsWith('.') || segment.endsWith('.lock'))) throw new Error('INVALID_REF');
    return value;
  };
  const gitRepo = (storageName: unknown, args: string[], maxBuffer?: number) => git(['--git-dir', repoPath(storageName), ...args], maxBuffer);
  const missing = (error: unknown): boolean => typeof error === 'object' && error !== null && 'status' in error && error.status === 128;
  const streamedTree = (storageName: unknown, object: string): Promise<ReturnType<typeof createTreeRowParser>['entries']> => new Promise((resolveTree, rejectTree) => {
    const child = spawn('git', ['--git-dir', repoPath(storageName), 'ls-tree', '-z', object], {
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parser = createTreeRowParser();
    let receivedBytes = 0;
    let stderr = '';
    let stoppedEarly = false;
    let settled = false;
    const timer = setTimeout(() => { child.kill('SIGTERM'); settle(new Error('GIT_COMMAND_TIMEOUT')); }, 10_000);
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectTree(error); else resolveTree(parser.entries);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled || stoppedEarly) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_TREE_OUTPUT_BYTES) {
        child.kill('SIGTERM'); settle(new Error('TREE_OUTPUT_TOO_LARGE')); return;
      }
      try {
        if (parser.push(chunk)) { stoppedEarly = true; child.kill('SIGTERM'); }
      } catch (error) { child.kill('SIGTERM'); settle(error instanceof Error ? error : new Error('INVALID_TREE_ENTRY')); }
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length); });
    child.once('error', error => settle(error));
    child.once('close', code => {
      if (settled) return;
      if (stoppedEarly) { settle(); return; }
      if (code !== 0) { settle(Object.assign(new Error(stderr.trim() || 'GIT_COMMAND_FAILED'), { status: code })); return; }
      try { parser.finish(); settle(); } catch (error) { settle(error instanceof Error ? error : new Error('INVALID_TREE_ENTRY')); }
    });
  });

  async function dispatch(body: Record<string, unknown>): Promise<unknown> {
    switch (body.operation) {
      case 'ensureRepo': {
        const storageName = name(body.name);
        const path = repoPath(storageName);
        if (!existsSync(path)) git(['init', '--bare', path]);
        return remote(storageName);
      }
      case 'fork': {
        const sourceName = name(body.sourceName);
        const targetName = name(body.targetName);
        const source = remote(sourceName);
        const target = repoPath(targetName);
        if (!existsSync(target)) git(['clone', '--bare', repoPath(sourceName), target]);
        return remote(targetName);
      }
      case 'info': return existsSync(repoPath(body.name)) ? remote(body.name) : null;
      case 'resolveRef': {
        remote(body.name);
        const ref = validRef(body.ref);
        try { return gitRepo(body.name, ['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim(); }
        catch (error) { if (missing(error)) return null; throw error; }
      }
      case 'readCommit': {
        remote(body.name);
        const oid = validOid(body.oid);
        try {
          if (gitRepo(body.name, ['cat-file', '-t', oid]).toString().trim() !== 'commit') return null;
          const raw = gitRepo(body.name, ['cat-file', '-p', oid]).toString();
          if (!raw.startsWith('tree ')) return null;
          const header = raw.split('\n\n', 1)[0];
          const treeOid = /^tree ([a-f0-9]{40})/m.exec(header)?.[1];
          if (!treeOid) throw new Error('INVALID_COMMIT_OBJECT');
          return { oid, treeOid, parents: [...header.matchAll(/^parent ([a-f0-9]{40})/gm)].map(match => match[1]) };
        } catch (error) { if (missing(error)) return null; throw error; }
      }
      case 'readFile': {
        remote(body.name);
        const oid = validOid(body.oid);
        const path = body.path;
        assertRepoPath(path);
        if (body.maxBytes !== undefined && (!Number.isInteger(body.maxBytes) || Number(body.maxBytes) < 0)) throw new Error('INVALID_MAX_BYTES');
        const maxBytes = body.maxBytes === undefined ? null : Number(body.maxBytes);
        try {
          if (gitRepo(body.name, ['cat-file', '-t', `${oid}:${path}`]).toString().trim() !== 'blob') return null;
          if (maxBytes !== null && Number(gitRepo(body.name, ['cat-file', '-s', `${oid}:${path}`]).toString().trim()) > maxBytes) throw new Error('FILE_TOO_LARGE');
          return { bytes: Array.from(gitRepo(body.name, ['show', `${oid}:${path}`], MAX_FILE_BYTES)) };
        }
        catch (error) { if (missing(error)) return null; throw error; }
      }
      case 'listTree': {
        remote(body.name);
        const oid = validOid(body.oid);
        const path = body.path;
        assertRepoPath(path, true);
        try {
          if (gitRepo(body.name, ['cat-file', '-t', oid]).toString().trim() !== 'commit') return null;
          const object = path ? `${oid}:${path}` : `${oid}^{tree}`;
          if (gitRepo(body.name, ['cat-file', '-t', object]).toString().trim() !== 'tree') return null;
          return await streamedTree(body.name, object);
        } catch (error) { if (missing(error)) return null; throw error; }
      }
      case 'mintToken': {
        remote(body.name);
        if (!['read', 'write'].includes(String(body.scope)) || !Number.isInteger(body.ttlSeconds) || Number(body.ttlSeconds) < 60 || Number(body.ttlSeconds) > 600) throw new Error('INVALID_TOKEN_REQUEST');
        const secret = randomBytes(24).toString('hex');
        const expiresAt = Date.now() + Number(body.ttlSeconds) * 1000;
        tokens.set(tokenHash(secret), { name: name(body.name), expiresAt });
        saveTokens();
        return { secret, expiresAt };
      }
      case 'revokeToken': {
        const secret = String(body.tokenIdOrSecret);
        const key = tokenHash(secret);
        const record = tokens.get(key);
        if (!record || record.name !== name(body.name)) return false;
        tokens.delete(key);
        saveTokens();
        return true;
      }
      default: throw new Error('UNKNOWN_OPERATION');
    }
  }

  const server = createServer(async (request, response) => {
    const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const a = Buffer.from(supplied);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) { response.writeHead(401).end('UNAUTHORIZED'); return; }
    if (request.method !== 'POST' || request.url !== '/rpc') { response.writeHead(404).end('NOT_FOUND'); return; }
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk.toString();
        if (raw.length > 64 * 1024) throw new Error('REQUEST_TOO_LARGE');
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      const result = await dispatch(body);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'BRIDGE_ERROR';
      response.writeHead(400, { 'content-type': 'text/plain' }).end(message.slice(0, 120));
    }
  });
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('BRIDGE_LISTEN_FAILED');
  return {
    server,
    url: `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(token)}`,
    close: () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.env.CONCORD_BRIDGE_DATA_DIR;
  const token = process.env.CONCORD_BRIDGE_TOKEN;
  if (!directory || !token) throw new Error('CONCORD_BRIDGE_DATA_DIR and CONCORD_BRIDGE_TOKEN are required');
  const port = Number(process.env.CONCORD_BRIDGE_PORT ?? '8788');
  void startGitBridge(directory, token, port).then(bridge => {
    process.stdout.write(`Local fake Git bridge listening on 127.0.0.1:${new URL(bridge.url).port}\n`);
  });
}
