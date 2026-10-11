import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { demoPrincipals, provision } from '../../demo/provision';
import { demoGitRemote, gitWithCredential } from '../../demo/scenarios';
import { gitCredentialEnvironment } from '../../runner/git';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('demo principal provisioning and remote Git transport', () => {
  it('writes fresh scoped token maps with private modes outside the clone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'concord-provision-'));
    directories.push(root);
    const first = await provision(join(root, 'first'));
    const second = await provision(join(root, 'second'));
    for (const path of [first.authTokensFile, first.tokensFile, second.authTokensFile, second.tokensFile]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }
    const tokens = JSON.parse(await readFile(first.tokensFile, 'utf8')) as Record<string, string>;
    const auth = JSON.parse(await readFile(first.authTokensFile, 'utf8')) as Record<string, any>;
    const newer = JSON.parse(await readFile(second.tokensFile, 'utf8')) as Record<string, string>;
    expect(Object.keys(tokens).sort()).toEqual(Object.keys(demoPrincipals).sort());
    expect(Object.keys(auth)).toHaveLength(Object.keys(demoPrincipals).length);
    for (const [alias, [principalId, role]] of Object.entries(demoPrincipals)) {
      expect(tokens[alias]).not.toMatch(/^local-/);
      expect(tokens[alias]).not.toBe(newer[alias]);
      expect(auth[createHash('sha256').update(tokens[alias]).digest('hex')]).toMatchObject({
        tenantId: 'demo', principalId, roles: [role], repoIds: '*',
      });
    }
  });

  it('rejects paths in the repo, including paths through a symlink', async () => {
    await expect(provision(join(resolve('.'), 'private-output'))).rejects.toThrow('PROVISION_DIR_MUST_BE_OUTSIDE_REPO');
    const root = await mkdtemp(join(tmpdir(), 'concord-provision-link-'));
    directories.push(root);
    await symlink(resolve('.'), join(root, 'checkout'));
    await expect(provision(join(root, 'checkout', 'private-output'))).rejects.toThrow('PROVISION_DIR_MUST_BE_OUTSIDE_REPO');
  });

  it('accepts HTTPS Artifacts remotes and passes Git bearer auth only in environment config', async () => {
    const remote = { target: 'remote', url: 'https://concord.example' } as const;
    expect(demoGitRemote(remote, 'https://artifacts.example/repo.git')).toBe('https://artifacts.example/repo.git');
    expect(() => demoGitRemote(remote, 'https://token@artifacts.example/repo.git')).toThrow('INVALID_GIT_REMOTE');
    expect(() => demoGitRemote(remote, 'https://artifacts.example/repo.git?token=x')).toThrow('INVALID_GIT_REMOTE');
    expect(() => demoGitRemote(remote, 'file:///tmp/bridge.git')).toThrow('INVALID_GIT_REMOTE');
    const root = await mkdtemp(join(tmpdir(), 'concord-git-env-'));
    directories.push(root);
    const executable = join(root, 'git');
    await writeFile(executable, '#!/bin/sh\nprintf "ARGS:%s\\n" "$*"\ncase "$GIT_CONFIG_VALUE_0" in "Authorization: Bearer "*) echo AUTH_PRESENT=1;; *) echo AUTH_PRESENT=0;; esac\n', { mode: 0o700 });
    await chmod(executable, 0o700);
    const priorPath = process.env.PATH;
    process.env.PATH = `${root}:${priorPath ?? ''}`;
    try {
      const secret = 'unit-secret-' + createHash('sha256').update(root).digest('hex');
      const output = await gitWithCredential(root, secret, 'fetch', 'https://artifacts.example/repo.git', 'main');
      expect(output).toContain('AUTH_PRESENT=1');
      expect(output).toContain('https://artifacts.example/repo.git');
      expect(output).not.toContain(secret);
      const runnerEnv = await gitCredentialEnvironment(root, secret);
      expect(runnerEnv.GIT_CONFIG_VALUE_1).toBe(`Authorization: Bearer ${secret}`);
      expect(runnerEnv.CONCORD_GIT_TOKEN).toBeUndefined();
      expect(runnerEnv.GIT_ASKPASS).toBeUndefined();
    } finally { process.env.PATH = priorPath; }
  });
});
