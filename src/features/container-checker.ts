export const CHECKER_WORKDIR = '/work/repo';
export const CHECKER_GIT_ASKPASS = '/usr/local/bin/git-askpass';
export const CHECKER_LOG_CAP = 16 * 1024;
export const CHECKER_REPO_URL = 'https://github.com/seb-patron/concord-v2.git';

export type CheckerInput = { repoUrl: string; sha: string; gitToken: string; timeoutSeconds: number };
export type CheckerPhase = 'coldStart' | 'fetch' | 'install' | 'check';
export type CheckerExec = (argv: string[], options: {
  cwd: string; env?: Record<string, string>; timeoutMs: number;
}) => Promise<{ code: number | null; output: string; timedOut: boolean; readyAt?: number }>;
export type CheckerExecution = {
  exitCode: number | null;
  timedOut: boolean;
  logTail: string;
  phaseMs: Record<CheckerPhase, number>;
};
export type CheckerProgress = {
  phaseMs: Record<CheckerPhase, number>;
  currentPhase: CheckerPhase | null;
  phaseStartedAt: number | null;
};

const encoder = new TextEncoder();

/** Read a stream while retaining no more than cap bytes, even for a single huge chunk. */
export async function readBoundedTail(
  stream: ReadableStream<Uint8Array>, cap = CHECKER_LOG_CAP, onRetainedBytes?: (length: number) => void,
): Promise<string> {
  const reader = stream.getReader();
  const ring = new Uint8Array(cap);
  let length = 0;
  let next = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const byte of value) {
        ring[next] = byte;
        next = (next + 1) % cap;
        length = Math.min(cap, length + 1);
      }
      onRetainedBytes?.(length);
    }
  } finally {
    reader.releaseLock();
  }
  const tail = new Uint8Array(length);
  const start = length === cap ? next : 0;
  for (let i = 0; i < length; i++) tail[i] = ring[(start + i) % cap];
  let result = new TextDecoder().decode(tail);
  while (encoder.encode(result).byteLength > cap) result = result.slice(1);
  return result;
}

function appendTail(current: string, next: string, cap = CHECKER_LOG_CAP): string {
  const combined = encoder.encode(current + next.slice(-cap));
  if (combined.byteLength <= cap) return current + next;
  let result = new TextDecoder().decode(combined.subarray(combined.byteLength - cap));
  while (encoder.encode(result).byteLength > cap) result = result.slice(1);
  return result;
}

function redact(value: string, token: string): string {
  return token ? value.replaceAll(token, '[REDACTED]') : value;
}

const deadline = (argv: string[], timeoutMs: number) => [
  'timeout', '--kill-after=5', '--signal=KILL', String(Math.max(1, Math.ceil(timeoutMs / 1000))), ...argv,
];

/** Clone the exact commit and run the fixed concord-v2 validation command. */
export async function runChecker(
  exec: CheckerExec,
  input: CheckerInput,
  now: () => number = Date.now,
  coldStartStartedAt?: number,
  onProgress?: (progress: CheckerProgress) => void | Promise<void>,
): Promise<CheckerExecution> {
  const phaseMs: Record<CheckerPhase, number> = { coldStart: 0, fetch: 0, install: 0, check: 0 };
  let logTail = '';
  let firstExec = true;
  const gitEnv = {
    GIT_TERMINAL_PROMPT: '0', GIT_TOKEN: input.gitToken,
    GIT_ASKPASS: CHECKER_GIT_ASKPASS, GIT_USERNAME: 'x-access-token',
  };
  const runStep = async (phase: CheckerPhase, argv: string[], cwd: string, timeoutMs: number, env?: Record<string, string>) => {
    const started = now();
    await onProgress?.({ phaseMs: { ...phaseMs }, currentPhase: phase, phaseStartedAt: started });
    const result = await exec(deadline(argv, timeoutMs), { cwd, timeoutMs, ...(env ? { env } : {}) });
    const completedAt = now();
    let elapsed = Math.max(0, completedAt - started);
    if (firstExec) {
      firstExec = false;
      if (coldStartStartedAt !== undefined) {
        const readyAt = result.readyAt ?? completedAt;
        phaseMs.coldStart = Math.max(0, readyAt - coldStartStartedAt);
        elapsed = Math.max(0, completedAt - Math.max(started, readyAt));
      }
    }
    phaseMs[phase] += elapsed;
    await onProgress?.({ phaseMs: { ...phaseMs }, currentPhase: null, phaseStartedAt: null });
    logTail = appendTail(logTail, redact(result.output, input.gitToken));
    return { code: result.code, timedOut: result.timedOut };
  };

  const clone = await runStep('fetch', ['git', 'clone', '--quiet', '--no-checkout', input.repoUrl, CHECKER_WORKDIR], '/work', 120_000, gitEnv);
  if (clone.code !== 0 || clone.timedOut) return failed(clone, phaseMs, logTail);
  const checkout = await runStep('fetch', ['git', '-C', CHECKER_WORKDIR, 'checkout', '--quiet', '--detach', input.sha], '/work', 120_000, gitEnv);
  if (checkout.code !== 0 || checkout.timedOut) return failed(checkout, phaseMs, logTail);
  const install = await runStep('install', ['npm', 'ci', '--no-audit', '--no-fund'], CHECKER_WORKDIR, 240_000);
  if (install.code !== 0 || install.timedOut) return failed(install, phaseMs, logTail);
  const check = await runStep('check', ['sh', 'scripts/validate.sh'], CHECKER_WORKDIR, input.timeoutSeconds * 1000);
  return {
    exitCode: check.code,
    timedOut: check.timedOut || check.code === 124 || check.code === 137,
    logTail,
    phaseMs,
  };
}

function failed(
  result: { code: number | null; timedOut: boolean }, phaseMs: Record<CheckerPhase, number>, logTail: string,
): CheckerExecution {
  return {
    exitCode: result.code,
    timedOut: result.timedOut || result.code === 124 || result.code === 137,
    logTail,
    phaseMs,
  };
}
