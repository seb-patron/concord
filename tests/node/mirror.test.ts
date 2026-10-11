import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { mirrorGit, validateDemoRemote } from '../../deploy/mirror.ts';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: 'Mirror Test', GIT_AUTHOR_EMAIL: 'mirror@example.test',
    GIT_COMMITTER_NAME: 'Mirror Test', GIT_COMMITTER_EMAIL: 'mirror@example.test',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  } }).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'concord-mirror-test-'));
  directories.push(root);
  const work = join(root, 'work');
  const source = join(root, 'source.git');
  const destination = join(root, 'destination.git');
  git(root, 'init', '--quiet', '--bare', source);
  git(root, 'init', '--quiet', '--bare', destination);
  git(root, 'init', '--quiet', '-b', 'main', work);
  await writeFile(join(work, 'sample.txt'), 'first\n');
  git(work, 'add', 'sample.txt');
  git(work, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'seed');
  const first = git(work, 'rev-parse', 'HEAD');
  git(work, 'push', source, 'HEAD:refs/heads/main');
  return { root, work, source: pathToFileURL(source).href, destination: pathToFileURL(destination).href, first };
}

describe('one-way mirror', () => {
  it('requires an owner-supplied credential-free GitHub demo URL', () => {
    expect(validateDemoRemote('https://github.com/example/dispatch-lab.git')).toBe('https://github.com/example/dispatch-lab.git');
    for (const value of ['https://token@github.com/a/b.git', 'https://github.com/a/b.git?token=x', 'https://evil.example/a/b.git', 'git@github.com:a/b.git', 'https://github.com/a/../b.git']) {
      expect(() => validateDemoRemote(value)).toThrow();
    }
  });

  it('defaults to dry run, then pushes only main and reads back the exact SHA', async () => {
    const f = await fixture();
    const input = { sourceRemote: f.source, sourceOid: f.first, destinationRemote: f.destination };
    expect(await mirrorGit(input)).toEqual({ sourceOid: f.first, destinationOid: null, action: 'create', executed: false });
    expect(git(f.root, 'ls-remote', '--heads', f.destination)).toBe('');
    expect(await mirrorGit({ ...input, execute: true })).toEqual({ sourceOid: f.first, destinationOid: null, action: 'create', executed: true });
    expect(git(f.root, 'ls-remote', '--heads', f.destination)).toBe(`${f.first}\trefs/heads/main`);
    expect(await mirrorGit(input)).toEqual({ sourceOid: f.first, destinationOid: f.first, action: 'already-current', executed: false });
  });

  it('blocks divergence and a stale confirmed canonical SHA without changing either remote', async () => {
    const f = await fixture();
    await mirrorGit({ sourceRemote: f.source, sourceOid: f.first, destinationRemote: f.destination, execute: true });
    await writeFile(join(f.work, 'sample.txt'), 'second\n');
    git(f.work, 'add', 'sample.txt');
    git(f.work, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'second');
    const second = git(f.work, 'rev-parse', 'HEAD');
    git(f.work, 'push', f.source.replace('file://', ''), 'HEAD:refs/heads/main');
    await expect(mirrorGit({ sourceRemote: f.source, sourceOid: f.first, destinationRemote: f.destination })).rejects.toThrow(/no longer matches/);
    // An independent destination commit is never overwritten by a source advancement.
    const other = join(f.root, 'other');
    git(f.root, 'clone', '--quiet', '--branch', 'main', f.destination, other);
    await writeFile(join(other, 'other.txt'), 'other\n');
    git(other, 'add', 'other.txt');
    git(other, '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'diverge');
    git(other, 'push', f.destination.replace('file://', ''), 'HEAD:refs/heads/main');
    const before = git(f.root, 'ls-remote', f.destination, 'refs/heads/main');
    await expect(mirrorGit({ sourceRemote: f.source, sourceOid: second, destinationRemote: f.destination, execute: true })).rejects.toThrow(/diverged/);
    expect(git(f.root, 'ls-remote', f.destination, 'refs/heads/main')).toBe(before);
  });
});
