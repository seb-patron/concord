import { describe, expect, it } from 'vitest';
import { CHECKER_LOG_CAP, CHECKER_WORKDIR, readBoundedTail, runChecker, type CheckerExec } from '../../src/features/container-checker';

const token = 'cct_read_0123456789abcdef';
const input = { repoUrl: 'https://github.com/seb-patron/concord-v2.git', sha: 'a'.repeat(40), gitToken: token, timeoutSeconds: 900 };

function fakeExec(outputs: Array<{ code: number | null; output?: string; timedOut?: boolean }> = []) {
  const calls: { argv: string[]; cwd: string; env?: Record<string, string>; timeoutMs: number }[] = [];
  const exec: CheckerExec = async (argv, options) => {
    calls.push({ argv, ...options });
    const next = outputs.shift() ?? { code: 0 };
    return { code: next.code, output: next.output ?? '', timedOut: next.timedOut ?? false };
  };
  return { calls, exec };
}

describe('experiment container checker core', () => {
  it('clones, checks out the exact commit, installs, validates, and passes the Git token only in exec env', async () => {
    const { calls, exec } = fakeExec([{ code: 0 }, { code: 0 }, { code: 0 }, { code: 0, output: 'validation passed\n' }]);
    let now = 0;
    const result = await runChecker(exec, input, () => (now += 25));
    expect(calls).toHaveLength(4);
    expect(calls[0].argv.slice(4)).toEqual(['git', 'clone', '--quiet', '--no-checkout', input.repoUrl, CHECKER_WORKDIR]);
    expect(calls[0].env).toMatchObject({ GIT_TOKEN: token, GIT_TERMINAL_PROMPT: '0' });
    expect(calls[0].argv.join(' ')).not.toContain(token);
    expect(calls[1].argv.slice(4)).toEqual(['git', '-C', CHECKER_WORKDIR, 'checkout', '--quiet', '--detach', input.sha]);
    expect(calls[2].argv.slice(4)).toEqual(['npm', 'ci', '--no-audit', '--no-fund']);
    expect(calls[3].argv.slice(4)).toEqual(['sh', 'scripts/validate.sh']);
    expect(calls[3].timeoutMs).toBe(900_000);
    expect(calls[2].cwd).toBe(CHECKER_WORKDIR);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, logTail: 'validation passed\n' });
    expect(result.phaseMs).toEqual({ coldStart: 0, fetch: 50, install: 25, check: 25 });
  });

  it('caps the byte tail, identifies timeout exits, and redacts the Git token from tool output', async () => {
    const { exec } = fakeExec([{ code: 0, output: `${token}\n` }, { code: 0 }, { code: 0 },
      { code: 124, output: `${'x'.repeat(CHECKER_LOG_CAP)}TAIL ${token}`, timedOut: true }]);
    const result = await runChecker(exec, input);
    expect(result.timedOut).toBe(true);
    expect(result.logTail).toContain('TAIL [REDACTED]');
    expect(result.logTail).not.toContain(token);
    expect(new TextEncoder().encode(result.logTail).byteLength).toBeLessThanOrEqual(CHECKER_LOG_CAP);
  });

  it('streams multi-megabyte output while retaining at most the per-step and overall tail caps', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(1024 * 1024));
    let maxRetained = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(new TextEncoder().encode('TAIL'));
        controller.close();
      },
    });
    const stepTail = await readBoundedTail(stream, CHECKER_LOG_CAP, length => { maxRetained = Math.max(maxRetained, length); });
    expect(maxRetained).toBeLessThanOrEqual(CHECKER_LOG_CAP);
    expect(new TextEncoder().encode(stepTail).byteLength).toBeLessThanOrEqual(CHECKER_LOG_CAP);
    expect(stepTail).toMatch(/TAIL$/);

    const { exec } = fakeExec([
      { code: 0, output: 'a'.repeat(3 * 1024 * 1024) },
      { code: 0, output: 'b'.repeat(3 * 1024 * 1024) },
      { code: 0, output: 'c'.repeat(3 * 1024 * 1024) },
      { code: 0, output: `${'d'.repeat(3 * 1024 * 1024)}FINAL` },
    ]);
    const result = await runChecker(exec, input);
    expect(result.logTail).toMatch(/FINAL$/);
    expect(new TextEncoder().encode(result.logTail).byteLength).toBeLessThanOrEqual(CHECKER_LOG_CAP);
  });

  it('records delayed first-exec readiness as cold start, outside the fetch phase', async () => {
    let elapsed = 0;
    let invocation = 0;
    const exec: CheckerExec = async () => {
      if (invocation++ === 0) {
        elapsed = 75;
        const readyAt = elapsed;
        elapsed += 25;
        return { code: 0, output: '', timedOut: false, readyAt };
      }
      elapsed += 10;
      return { code: 0, output: '', timedOut: false };
    };
    const result = await runChecker(exec, input, () => elapsed, 0);
    expect(result.phaseMs.coldStart).toBe(75);
    expect(result.phaseMs.fetch).toBe(35);
    expect(result.phaseMs.install).toBe(10);
    expect(result.phaseMs.check).toBe(10);
  });

  it('stops at the first failed fetch/install phase', async () => {
    const { calls, exec } = fakeExec([{ code: 128, output: 'clone failed' }]);
    const result = await runChecker(exec, input);
    expect(result.exitCode).toBe(128);
    expect(result.logTail).toContain('clone failed');
    expect(calls).toHaveLength(1);
  });
});
