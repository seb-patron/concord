import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { checkLocal, checkRemote, main } from '../../deploy/preflight.ts';

function documentedCommand(command: string, env: NodeJS.ProcessEnv = {}) {
  mkdirSync('.wrangler', { recursive: true });
  return spawnSync('sh', ['-c', command], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, TMPDIR: '.wrangler', XDG_CONFIG_HOME: tmpdir(), CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '',
      AUTH_TOKENS_FILE: '', TRUSTED_CONFIG_FILE: '', CONCORD_URL: '', CONCORD_TOKEN: '', ...env },
  });
}

// These account-requiring commands are reviewed as complete lines. Wrangler's
// --help exits successfully even when the command also contains an invalid flag.
const reviewedAccountWranglerCommands = [
  'npx wrangler versions upload --config wrangler.jsonc',
  'npx wrangler versions secret put AUTH_TOKENS --config wrangler.jsonc < "$AUTH_TOKENS_FILE"',
  'npx wrangler versions secret put TRUSTED_CONFIG --config wrangler.jsonc < "$TRUSTED_CONFIG_FILE"',
  'npx wrangler deploy --config wrangler.jsonc',
  'npx wrangler deployments list --config wrangler.jsonc',
  'npx wrangler rollback \'<PRIOR_WORKER_VERSION_ID>\' --config wrangler.jsonc --message \'rollback Concord Worker\'',
];

function assertReviewedAccountWranglerCommand(command: string) {
  if (!reviewedAccountWranglerCommands.includes(command)) {
    throw new Error(`unreviewed Wrangler command: ${command}`);
  }
}

describe('deployment preflight', () => {
  it('runs deploy-owned local and dry-run docs commands and parses account commands', async () => {
    const instructions = await readFile('docs/deploy.md', 'utf8');
    expect(instructions).toMatch(/<!-- verified-by: 12c -->\s*```sh\s*export CONCORD_RUN_DIR=[^\n]+\nexport CONCORD_URL=[^\n]+\nexport CONCORD_TOKEN=[^\n]+\nexport CONCORD_SHOW_DECOMPILED_C=0\nnpm run demo -- seed /);
    const commands = [...instructions.matchAll(/```sh\n([\s\S]*?)\n```/g)]
      .flatMap(match => match[1].split('\n'))
      .filter(line => /^(?:CONCORD_TOKEN="\$\w+" )?(?:npm run (?:deploy:check|mirror|runner) |npx wrangler )/.test(line));
    expect(commands).toEqual([
      'npm run deploy:check -- --local',
      'npm run deploy:check -- --remote',
      'npx wrangler deploy --dry-run --config wrangler.jsonc',
      'npx wrangler versions upload --config wrangler.jsonc',
      'npx wrangler versions secret put AUTH_TOKENS --config wrangler.jsonc < "$AUTH_TOKENS_FILE"',
      'npx wrangler versions secret put TRUSTED_CONFIG --config wrangler.jsonc < "$TRUSTED_CONFIG_FILE"',
      'npx wrangler deploy --config wrangler.jsonc',
      'npm run deploy:check -- --remote',
      'CONCORD_TOKEN="$CHECKER_TOKEN" npm run runner -- --repo "$CONCORD_REPO_ID" --role checker --profile "$CONCORD_HOME/checker-profile.json" --once',
      'CONCORD_TOKEN="$PROMOTER_TOKEN" npm run runner -- --repo "$CONCORD_REPO_ID" --role promoter --profile-digest "$PROFILE_DIGEST" --once',
      'npm run mirror -- --repo \'<CONCORD_REPO_ID>\' --remote "$CONCORD_MIRROR_REMOTE" --dry-run',
      'npm run mirror -- --repo \'<CONCORD_REPO_ID>\' --remote "$CONCORD_MIRROR_REMOTE" --execute',
      'npx wrangler deployments list --config wrangler.jsonc',
      'npx wrangler rollback \'<PRIOR_WORKER_VERSION_ID>\' --config wrangler.jsonc --message \'rollback Concord Worker\'',
    ]);

    const local = documentedCommand(commands[0]);
    expect(local.status, local.stderr).toBe(0);
    expect(local.stdout).toContain('"status":"ready"');
    const dryRun = documentedCommand(commands[2]);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toContain('--dry-run: exiting now.');

    for (const command of [commands[1], commands[7]]) {
      const result = documentedCommand(command);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('owner credentials required');
    }
    const accountWranglerCommands = commands.filter(command => command.startsWith('npx wrangler ') && command !== commands[2]);
    expect(accountWranglerCommands).toEqual(reviewedAccountWranglerCommands);
    for (const command of accountWranglerCommands) assertReviewedAccountWranglerCommand(command);

    const directory = await mkdtemp(join(resolve(tmpdir()), 'concord-deploy-docs-'));
    try {
      expect(isAbsolute(directory)).toBe(true);
      await writeFile(join(directory, 'checker-profile.json'), '{}');
      const checker = documentedCommand(commands[8], { CONCORD_HOME: directory, CONCORD_REPO_ID: 'demo',
        CHECKER_TOKEN: 'test-checker', CONCORD_URL: 'https://concord.test' });
      expect(checker.status).toBe(1);
      expect(checker.stderr).toContain('INVALID_PROFILE');
      expect(checker.stderr).not.toContain('PROFILE_ABSOLUTE_PATH_REQUIRED');
    } finally { await rm(directory, { recursive: true, force: true }); }

    const promoter = documentedCommand(commands[9], { CONCORD_REPO_ID: 'demo', PROMOTER_TOKEN: 'test-promoter',
      PROFILE_DIGEST: `sha256:${'a'.repeat(64)}` });
    expect(promoter.status).toBe(1);
    expect(promoter.stderr).toContain('CONCORD_URL_AND_TOKEN_REQUIRED');
    for (const command of [commands[10], commands[11]]) {
      const mirror = documentedCommand(command.replace("'<CONCORD_REPO_ID>'", "'demo'"),
        { CONCORD_MIRROR_REMOTE: 'https://github.com/example/demo.git' });
      expect(mirror.status).toBe(1);
      expect(mirror.stderr).toContain('CONCORD_URL and CONCORD_TOKEN are required');
    }
  }, 120_000);

  it('rejects unreviewed Wrangler flags and subcommands without executing them', () => {
    expect(() => assertReviewedAccountWranglerCommand(
      'npx wrangler versions secret put AUTH_TOKENS --definitely-invalid --config wrangler.jsonc < "$AUTH_TOKENS_FILE"',
    )).toThrow(/unreviewed Wrangler command/);
    expect(() => assertReviewedAccountWranglerCommand(
      'npx wrangler secret put AUTH_TOKENS --config wrangler.jsonc < "$AUTH_TOKENS_FILE"',
    )).toThrow(/unreviewed Wrangler command/);
  });

  it('documents the production profile pin required by the promoter smoke command', async () => {
    const instructions = await readFile('docs/deploy.md', 'utf8');
    expect(instructions).toMatch(/PROFILE_ID="\$\(curl[^\n]+\/v1\/repos\/\$CONCORD_REPO_ID" \| jq -er '\.data\.profileId'\)"/);
    expect(instructions).toMatch(/PROFILE_DIGEST="\$\(jq -er --arg id "\$PROFILE_ID" '\.profiles\[\$id\]\.digest[^\n]+"\$TRUSTED_CONFIG_FILE"\)"/);
    expect(instructions).toMatch(/--role promoter --profile-digest "\$PROFILE_DIGEST" --once/);
  });

  it('accepts the checked-in local and production configurations without account credentials', async () => {
    const result = await checkLocal(process.cwd(), { ...process.env, CLOUDFLARE_ACCOUNT_ID: undefined, CLOUDFLARE_API_TOKEN: undefined });
    expect(result).toMatchObject({ status: 'ready', reason: 'remote deployment unavailable: owner credentials required' });
    expect(result.checks).toContain('content and credentials: safe defaults');
  });

  it('rejects unsafe content and bridge use in production mode', async () => {
    expect((await checkLocal(process.cwd(), { ...process.env, CONCORD_SHOW_DECOMPILED_C: '1' })).reason).toMatch(/decompiled C/);
    expect((await checkLocal(process.cwd(), { ...process.env, CONCORD_MODE: 'production', STORAGE_BACKEND: 'bridge', BRIDGE_URL: 'http://127.0.0.1:8788' })).reason).toMatch(/local Git bridge/);
    expect((await checkLocal(process.cwd(), { ...process.env, AUTH_TOKENS: 'local-owner' })).reason).toMatch(/fixture credentials/);
    const fixtureDigest = createHash('sha256').update('local-owner').digest('hex');
    expect((await checkLocal(process.cwd(), { ...process.env, AUTH_TOKENS: JSON.stringify({ [fixtureDigest]: { principalId: 'owner' } }) })).reason).toMatch(/fixture credentials/);
  });

  it('reports missing owner credentials without probing the network', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await checkRemote({ ...process.env, CLOUDFLARE_ACCOUNT_ID: undefined, CLOUDFLARE_API_TOKEN: undefined }, fetcher);
    expect(result).toMatchObject({ status: 'unavailable', reason: 'owner credentials required' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('checks the owner account Artifacts namespace using only supplied credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: true, result: { namespace: 'concord-demo' } }), { status: 200 }));
    const result = await checkRemote({ ...process.env, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'private-token' }, fetcher);
    expect(result.status).toBe('ready');
    expect(fetcher).toHaveBeenCalledWith('https://api.cloudflare.com/client/v4/accounts/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/artifacts/namespaces/concord-demo',
      expect.objectContaining({ headers: { Authorization: 'Bearer private-token' } }));
  });

  it('reports an unavailable namespace without exposing provider response content', async () => {
    const result = await checkRemote({ ...process.env, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'private-token' },
      async () => new Response('private-token', { status: 403 }));
    expect(result).toMatchObject({ status: 'unavailable', reason: 'Artifacts namespace unavailable (HTTP 403)' });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('requires one explicit mode', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { expect(await main([])).toBe(2); expect(await main(['--local', '--remote'])).toBe(2); }
    finally { error.mockRestore(); }
  });
});
