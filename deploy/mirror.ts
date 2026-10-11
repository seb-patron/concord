import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ConcordClient } from '../cli/client.ts';
import { childEnvironment, command } from '../runner/git.ts';

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export type MirrorPlan = { sourceOid: string; destinationOid: string | null; action: 'create' | 'advance' | 'already-current'; executed: boolean };

export function validateDemoRemote(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('demo remote must be an HTTPS GitHub URL'); }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash ||
      !/^\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+(?:\.git)?$/.test(url.pathname) || url.pathname.includes('..')) {
    throw new Error('demo remote must be a credential-free HTTPS github.com/OWNER/REPO URL');
  }
  return url.toString();
}

function validateSourceRemote(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('canonical Git remote is invalid'); }
  if (!['https:', 'file:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (url.protocol === 'file:' && url.hostname && url.hostname !== 'localhost')) throw new Error('canonical Git remote is unsafe');
  return value;
}

function gitEnvironment(token?: string, github = false): NodeJS.ProcessEnv {
  const env = childEnvironment();
  if (token) {
    env.GIT_CONFIG_COUNT = '2';
    env.GIT_CONFIG_KEY_1 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_1 = github
      ? `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
      : `Authorization: Bearer ${token}`;
  }
  return env;
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const result = await command('git', args, cwd, 30000, env);
  if (result.code !== 0 || result.timedOut || result.truncated) throw new Error('Git mirror operation failed');
  return result.stdout.trim();
}

async function remoteHead(cwd: string, remote: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const result = await command('git', ['ls-remote', '--exit-code', '--heads', remote, 'main'], cwd, 30000, env);
  if (result.timedOut || result.truncated || ![0, 2].includes(result.code)) throw new Error('Git remote main read failed');
  if (result.code === 2) return null;
  const match = /^([0-9a-f]{40}|[0-9a-f]{64})\s+refs\/heads\/main$/m.exec(result.stdout.trim());
  if (!match) throw new Error('Git remote main response is invalid');
  return match[1];
}

/** Uses only temporary Git objects. It cannot mutate Concord's canonical repository. */
export async function mirrorGit(input: { sourceRemote: string; sourceOid: string; destinationRemote: string; execute?: boolean; sourceToken?: string; destinationToken?: string }): Promise<MirrorPlan> {
  const { sourceOid, execute = false } = input;
  if (!oidPattern.test(sourceOid)) throw new Error('confirmed canonical SHA is required');
  const sourceRemote = validateSourceRemote(input.sourceRemote);
  const directory = await mkdtemp(join(tmpdir(), 'concord-mirror-'));
  try {
    const sourceEnv = gitEnvironment(input.sourceToken);
    const destinationEnv = gitEnvironment(input.destinationToken, true);
    await git(directory, ['init', '--quiet'], childEnvironment());
    const observedSource = await remoteHead(directory, sourceRemote, sourceEnv);
    if (observedSource !== sourceOid) throw new Error('canonical main no longer matches the confirmed SHA');
    const destinationOid = await remoteHead(directory, input.destinationRemote, destinationEnv);
    if (destinationOid === sourceOid) return { sourceOid, destinationOid, action: 'already-current', executed: false };
    await git(directory, ['fetch', '--no-tags', sourceRemote, sourceOid], sourceEnv);
    if (await git(directory, ['rev-parse', 'FETCH_HEAD^{commit}'], childEnvironment()) !== sourceOid) throw new Error('canonical commit fetch mismatch');
    if (destinationOid) {
      await git(directory, ['fetch', '--no-tags', input.destinationRemote, destinationOid], destinationEnv);
      const ancestry = await command('git', ['merge-base', '--is-ancestor', destinationOid, sourceOid], directory, 30000, childEnvironment());
      if (ancestry.timedOut || ancestry.code !== 0) throw new Error('destination main diverged from canonical history');
    }
    const action = destinationOid ? 'advance' : 'create';
    if (!execute) return { sourceOid, destinationOid, action, executed: false };
    if (await remoteHead(directory, sourceRemote, sourceEnv) !== sourceOid) throw new Error('canonical main moved before mirror push');
    if (await remoteHead(directory, input.destinationRemote, destinationEnv) !== destinationOid) throw new Error('destination main moved before mirror push');
    await git(directory, ['push', '--porcelain', '--no-follow-tags', input.destinationRemote, `${sourceOid}:refs/heads/main`], destinationEnv);
    if (await remoteHead(directory, input.destinationRemote, destinationEnv) !== sourceOid) throw new Error('mirror push did not read back the confirmed SHA');
    return { sourceOid, destinationOid, action, executed: true };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs({ args: argv, options: {
      repo: { type: 'string' }, remote: { type: 'string' }, execute: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    }, strict: true });
    if (parsed.positionals.length || !parsed.values.repo || !parsed.values.remote || (parsed.values.execute && parsed.values['dry-run']) ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(parsed.values.repo)) throw new Error('usage: npm run mirror -- --repo ID --remote https://github.com/OWNER/DEMO.git [--dry-run|--execute]');
    const destinationRemote = validateDemoRemote(parsed.values.remote);
    const apiUrl = process.env.CONCORD_URL;
    const apiToken = process.env.CONCORD_TOKEN;
    if (!apiUrl || !apiToken) throw new Error('CONCORD_URL and CONCORD_TOKEN are required');
    const client = new ConcordClient({ url: apiUrl, token: apiToken });
    const repoId = parsed.values.repo;
    const response = await client.request<{ data: { status: string; version: number; canonicalStorageName: string; observedCanonicalOid: string | null } }>('GET', `/repos/${repoId}`);
    const repo = response.data;
    if (repo.status !== 'ready' || !repo.observedCanonicalOid || !oidPattern.test(repo.observedCanonicalOid)) throw new Error('canonical main is not confirmed');
    const access = await client.request<{ data: { remote: string; secret: string } }>('POST', `/repos/${repoId}/git-token`, {
      body: { storageName: repo.canonicalStorageName, scope: 'read', ttlSeconds: 300 },
      expectedVersion: repo.version, idempotencyKey: `mirror-read-${repoId}-${repo.observedCanonicalOid}`,
    });
    const plan = await mirrorGit({ sourceRemote: access.data.remote, sourceToken: access.data.secret,
      sourceOid: repo.observedCanonicalOid, destinationRemote, destinationToken: process.env.CONCORD_MIRROR_TOKEN,
      execute: parsed.values.execute === true });
    console.log(JSON.stringify({ repoId, destinationRemote, mode: parsed.values.execute ? 'execute' : 'dry-run', ...plan }));
    return 0;
  } catch (error) {
    // Never forward Git/provider stderr or response bodies: they may contain credentials.
    const safe = error instanceof Error && /^(usage:|demo remote|CONCORD_URL|canonical main|destination main|Git mirror|Git remote|mirror push)/.test(error.message)
      ? error.message : 'mirror failed; canonical history is unchanged';
    console.error(safe);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main();
}
