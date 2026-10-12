import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Digest, TrustedPolicy } from '../src/contracts';
import { digest } from '../src/http';
import { declaredGenerators } from '../src/leases/units';
import { childEnvironment, command, git, MAX_INSPECTED_BLOB_BYTES, OUTPUT_CAP } from './git';
import type { LocalProfile } from './profiles';

export type GeneratedOutput = { id: string; outputDigest: Digest };

async function snapshot(repo: string, paths: string[], allowMissing = false) {
  const entries = [];
  const root = await realpath(repo);
  for (const path of paths) {
    const full = resolve(repo, path);
    if (!full.startsWith(resolve(repo) + sep)) throw new Error('GENERATOR_FAILED: unsafe output path');
    const info = await lstat(full).catch(() => null);
    if (!info && allowMissing) { entries.push({ path, mode: 'missing', contentDigest: '' }); continue; }
    if (!info?.isFile()) throw new Error(`GENERATOR_FAILED: ${path}: output missing or not a regular file`);
    if (!(await realpath(full)).startsWith(root + sep)) throw new Error(`GENERATOR_FAILED: ${path}: output escapes repository`);
    if (info.size > MAX_INSPECTED_BLOB_BYTES) throw new Error(`GENERATOR_FAILED: ${path}: output exceeds size cap`);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of createReadStream(full)) {
      size += chunk.length;
      if (size > MAX_INSPECTED_BLOB_BYTES) throw new Error(`GENERATOR_FAILED: ${path}: output exceeds size cap`);
      hash.update(chunk);
    }
    entries.push({ path, mode: info.mode & 0o111 ? '100755' : '100644',
      contentDigest: 'sha256:' + hash.digest('hex') });
  }
  return entries;
}

/** Execute only owner-pinned argv, twice; the second run must leave every output unchanged. */
export async function regenerate(repo: string, policy: TrustedPolicy, profile: LocalProfile,
  maxOutputBytes = OUTPUT_CAP): Promise<GeneratedOutput[]> {
  const entries = declaredGenerators(policy);
  if (!entries.length) return [];
  if (profile.kind !== 'command') throw new Error('GENERATOR_PROFILE_REQUIRED');
  const outputPaths = new Set(entries.flatMap(entry => entry.outputs));
  const ordered = [...entries].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const entry of ordered) {
    const argv = profile.generatorCommands?.[entry.command];
    if (!argv) throw new Error(`GENERATOR_COMMAND_UNAVAILABLE: ${entry.command}`);
    const env: NodeJS.ProcessEnv = {};
    for (const name of profile.env!) if (process.env[name] !== undefined) env[name] = process.env[name];
    const secrets = [...new Set(profile.env!.map(name => process.env[name]).filter((value): value is string => !!value))];
    const otherPaths = [...outputPaths].filter(path => !entry.outputs.includes(path));
    let first: Awaited<ReturnType<typeof snapshot>> | null = null;
    for (let pass = 0; pass < 2; pass++) {
      const othersBefore = await snapshot(repo, otherPaths, true);
      const result = await command(profile.executable!, argv, repo, profile.timeoutSeconds! * 1000, env,
        { outputCap: Math.min(profile.outputCap!, maxOutputBytes), tail: true, redact: secrets });
      if (result.code !== 0 || result.timedOut) throw new Error(`GENERATOR_FAILED: ${entry.id}: exit=${result.code}${result.timedOut ? ' timeout' : ''}\n${result.outputTail ?? ''}`);
      const current = await snapshot(repo, entry.outputs);
      if (first && JSON.stringify(first) !== JSON.stringify(current)) throw new Error(`GENERATOR_NONDETERMINISTIC: ${entry.id}`);
      if (JSON.stringify(othersBefore) !== JSON.stringify(await snapshot(repo, otherPaths, true)))
        throw new Error(`GENERATOR_FAILED: ${entry.id}: undeclared output modified`);
      first = current;
    }
  }
  const changed = (await git(repo, ['diff', '--name-only', '-z', 'HEAD', '--'])).split('\0').filter(Boolean);
  const untracked = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  if ([...changed, ...untracked].some(path => !outputPaths.has(path))) throw new Error('GENERATOR_FAILED: undeclared file modified');
  return Promise.all(ordered.map(async entry => ({ id: entry.id, outputDigest: await digest(await snapshot(repo, entry.outputs)) })));
}

export async function commitGenerated(repo: string, policy: TrustedPolicy): Promise<string> {
  const paths = declaredGenerators(policy).flatMap(entry => entry.outputs);
  if (!paths.length) return git(repo, ['rev-parse', 'HEAD']);
  await git(repo, ['add', '--', ...paths]);
  const diff = await command('git', ['diff', '--cached', '--quiet'], repo, 30_000);
  if (diff.code === 0) return git(repo, ['rev-parse', 'HEAD']);
  if (diff.code !== 1) throw new Error('GENERATOR_COMMIT_FAILED');
  const env = childEnvironment({ GIT_AUTHOR_NAME: 'Concord Runner', GIT_AUTHOR_EMAIL: 'runner@concord.invalid',
    GIT_COMMITTER_NAME: 'Concord Runner', GIT_COMMITTER_EMAIL: 'runner@concord.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' });
  await git(repo, ['commit', '-m', 'Regenerate declared outputs'], 60_000, env);
  return git(repo, ['rev-parse', 'HEAD']);
}
