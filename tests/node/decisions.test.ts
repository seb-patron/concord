import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCallback);
const temporary: string[] = [];
const script = join(process.cwd(), 'scripts/decision-status.ts');
const decision = `## D-EXAMPLE — Example decision\n\n- **Date (CT):** 2026-10-13.\n- **Owner's words:** "approved".\n- **Decision:** Keep the example policy.\n- **What it changes:** The example behavior.\n- **Options not chosen:** Not recorded.\n- **Status:** active\n- **Delivered by:** Not yet.\n- **Source:** Owner chat.\n`;
const secondDecision = decision.replace('D-EXAMPLE — Example decision', 'D-SECOND — Second decision');
const header = 'id\tcheck\targument\texpected\tnext_action';

async function fixture(row: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'concord-decisions-'));
  temporary.push(root);
  await mkdir(join(root, 'docs'), { recursive: true });
  await mkdir(join(root, 'tests/node'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'docs/decisions.md'), decision);
  await writeFile(join(root, 'docs/decision-status.tsv'), `${header}\n${row}${row ? '\n' : ''}`);
  return root;
}

async function run(root: string) {
  try {
    const result = await execFile(process.execPath, ['--import', 'tsx', script], {
      cwd: process.cwd(), env: { ...process.env, DECISIONS_ROOT: root },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('owner decision status checker', () => {
  it('exits 2 for malformed TSV rows, missing rows, duplicate IDs and unknown check kinds', async () => {
    const cases = [
      'D-EXAMPLE\tmanual\tlive\ttoo-few',
      '',
      'D-EXAMPLE\tmanual\tpolicy\tlive\tNone\nD-EXAMPLE\tmanual\tpolicy\tlive\tNone',
      'D-EXAMPLE\tunknown\tpolicy\tlive\tNone',
    ];
    for (const row of cases) expect((await run(await fixture(row))).code).toBe(2);
  });

  it('reports a missing status row and a status row without a decision clearly', async () => {
    const missing = await fixture('D-OTHER\tmanual\tother policy\tpending\tNone.');
    const missingResult = await run(missing);
    expect(missingResult.code).toBe(2);
    expect(missingResult.stderr).toContain('missing status row for D-EXAMPLE');

    const extra = await fixture('D-EXAMPLE\tmanual\tpolicy\tpending\tNone.');
    await writeFile(join(extra, 'docs/decisions.md'), decision + secondDecision);
    await writeFile(join(extra, 'docs/decision-status.tsv'), `${header}\nD-EXAMPLE\tmanual\tpolicy\tpending\tNone.\nD-SECOND\tmanual\tpolicy\tpending\tNone.\nD-THIRD\tmanual\tpolicy\tpending\tNone.`);
    const extraResult = await run(extra);
    expect(extraResult.code).toBe(2);
    expect(extraResult.stderr).toContain('status row has no decision D-THIRD');
  });

  it('treats matching file checks as live and lists nonmatching checks', async () => {
    const root = await fixture('D-EXAMPLE\tfile\tdocs/policy.txt:^approved\tpresent\tShip the policy.');
    await writeFile(join(root, 'docs/policy.txt'), 'approved policy\n');
    expect((await run(root)).stdout).toBe('Decision status:\nD-EXAMPLE — live\nApproved but not live:\n');
    await writeFile(join(root, 'docs/policy.txt'), 'policy not approved\n');
    expect((await run(root)).stdout).toContain('D-EXAMPLE — Example decision — Ship the policy.');
  });

  it('treats a missing file as absent and not present', async () => {
    const absent = await fixture('D-EXAMPLE\tfile\tdocs/missing.txt:^\tabsent\tNone.');
    expect((await run(absent)).stdout).toContain('D-EXAMPLE — live');

    const present = await fixture('D-EXAMPLE\tfile\tdocs/missing.txt:^\tpresent\tCreate the file.');
    const result = await run(present);
    expect(result.stdout).toContain('D-EXAMPLE — not live');
    expect(result.stdout).toContain('D-EXAMPLE — Example decision — Create the file.');
  });

  it('reports non-ENOENT file read errors with the decision ID and error code', async () => {
    const root = await fixture('D-EXAMPLE\tfile\tdocs/directory:^\tabsent\tNone.');
    await mkdir(join(root, 'docs/directory'));
    const result = await run(root);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('D-EXAMPLE');
    expect(result.stderr).toContain('EISDIR');
  });

  it('requires a Status field and names the decision when it is missing', async () => {
    const root = await fixture('D-EXAMPLE\tmanual\tpolicy\tactive\tNone.');
    await writeFile(join(root, 'docs/decisions.md'), decision.replace('- **Status:** active\n', ''));
    const result = await run(root);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('D-EXAMPLE');
    expect(result.stderr).toContain('missing or has an invalid required field');
  });

  it('finds an existing test name and validates the seeded decision records', async () => {
    const root = await fixture('D-EXAMPLE\ttest\tkeeps the recorded policy\tpass\tNone');
    await writeFile(join(root, 'tests/node/policy.test.ts'), "it('keeps the recorded policy', () => {});\n");
    expect((await run(root)).stdout).toBe('Decision status:\nD-EXAMPLE — live\nApproved but not live:\n');
    const seeded = await run(process.cwd());
    expect(seeded.code).toBe(0);
    expect(seeded.stdout).toContain('D-DECISIONS-IN-GIT — live');
    expect(seeded.stdout).toContain('Approved but not live:\n');
  });

  it('matches indented route table entries and reports missing routes as not live', async () => {
    const root = await fixture('D-EXAMPLE\troute\tPOST /v1/repos/:r/queue/enqueue\tregistered\tNone.');
    await writeFile(join(root, 'src/routes.ts'), `export const routes = [
      {
        method: 'POST',
        pattern: /^\\/v1\\/repos\\/[^/]+\\/queue\\/enqueue$/,
        handle: () => {},
      },
    ];\n`);
    expect((await run(root)).stdout).toContain('D-EXAMPLE — live');

    await writeFile(join(root, 'docs/decision-status.tsv'), `${header}\nD-EXAMPLE\troute\tPOST /v1/repos/:r/queue/absent\tregistered\tImplement the route.\n`);
    const missing = await run(root);
    expect(missing.stdout).toContain('D-EXAMPLE — not live');
    expect(missing.stdout).toContain('D-EXAMPLE — Example decision — Implement the route.');
  });

  it('lists manual rows by next action and preserves the final TSV row without a newline', async () => {
    const root = await fixture('D-EXAMPLE\tmanual\tactive policy\tactive\tNone.');
    await writeFile(join(root, 'docs/decisions.md'), decision + secondDecision);
    await writeFile(join(root, 'docs/decision-status.tsv'), `${header}\nD-EXAMPLE\tmanual\tactive policy\tactive\tNone.\nD-SECOND\tmanual\tpending policy\tpending\tDeliver the policy.`);
    const result = await run(root);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('D-EXAMPLE — active');
    expect(result.stdout).toContain('D-SECOND — pending');
    expect(result.stdout).not.toContain('D-EXAMPLE — Example decision —');
    expect(result.stdout).toContain('D-SECOND — Second decision — Deliver the policy.');
  });
});
