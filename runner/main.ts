import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCredential } from '../cli/profile.ts';
import type { Job, JobResult } from '../src/contracts';
import { executeJob, type Credential, type CredentialProvider } from './execute';
import { createCommandProfile, loadProfile, type LocalProfile } from './profiles';

type Options = { repo: string; role: 'checker' | 'promoter'; profileFile?: string; profileDigest?: string;
  once: boolean; maxJobs: number; idleTimeoutSeconds: number; idleMaxDelaySeconds: number; idleMinDelayMs: number; runnerId: string };

export function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  let once = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--once') { once = true; continue; }
    if (!['--repo', '--role', '--profile', '--profile-digest', '--max-jobs', '--idle-timeout-seconds',
      '--idle-max-delay-seconds', '--idle-min-delay-ms', '--runner-id'].includes(arg) ||
      !args[index + 1]) throw new Error('INVALID_ARGUMENT: ' + arg);
    values.set(arg, args[++index]);
  }
  const role = values.get('--role');
  const repo = values.get('--repo');
  if (!repo || !/^[A-Za-z0-9_-]{1,64}$/.test(repo) || !['checker', 'promoter'].includes(role ?? '')) throw new Error('REPO_AND_ROLE_REQUIRED');
  const maxJobs = values.has('--max-jobs') ? Number(values.get('--max-jobs')) : values.has('--idle-timeout-seconds') ? 1000 : 1;
  const idleTimeoutSeconds = values.has('--idle-timeout-seconds') ? Number(values.get('--idle-timeout-seconds')) : 0;
  const idleMaxDelaySeconds = values.has('--idle-max-delay-seconds') ? Number(values.get('--idle-max-delay-seconds')) : 30;
  const idleMinDelayMs = values.has('--idle-min-delay-ms') ? Number(values.get('--idle-min-delay-ms')) : 1000;
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 1000 ||
    !Number.isSafeInteger(idleTimeoutSeconds) || idleTimeoutSeconds < 0 || idleTimeoutSeconds > 86_400 ||
    !Number.isSafeInteger(idleMaxDelaySeconds) || idleMaxDelaySeconds < 1 || idleMaxDelaySeconds > 300 ||
    !Number.isSafeInteger(idleMinDelayMs) || idleMinDelayMs < 1 || idleMinDelayMs > 300_000 ||
    idleMinDelayMs > idleMaxDelaySeconds * 1000) throw new Error('INVALID_BOUND');
  if (!once && !values.has('--max-jobs') && !values.has('--idle-timeout-seconds')) once = true;
  if (role === 'checker' && !values.get('--profile')) throw new Error('CHECKER_PROFILE_REQUIRED');
  if (role === 'promoter' && values.get('--profile')) throw new Error('PROMOTER_PROFILE_FORBIDDEN');
  const runnerId = values.get('--runner-id') ?? 'runner-' + randomUUID();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runnerId)) throw new Error('INVALID_RUNNER_ID');
  return { repo, role: role as Options['role'], profileFile: values.get('--profile'), profileDigest: values.get('--profile-digest') ?? process.env.CONCORD_PROFILE_DIGEST,
    once, maxJobs, idleTimeoutSeconds, idleMaxDelaySeconds, idleMinDelayMs, runnerId };
}

export type Transport = (path: string, body: unknown, key: string) => Promise<{ status: number; data?: any; error?: { code: string }; retryAfterMs?: number }>;

type RetryOptions = { sleep?: (ms: number) => Promise<void>; random?: () => number;
  log?: (line: string) => void; now?: () => number };
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const defaultLog = (line: string) => { console.error(line); };

// Backoff for transient runner HTTP failures: start 1 s, double per attempt, cap 30 s.
const BACKOFF_START_MS = 1000;
const BACKOFF_CAP_MS = 30_000;

// 409 conflict codes that mean "the server is briefly busy, try again" rather
// than "this runner is rejected". PROMOTION_IN_PROGRESS is returned by the
// coordinator while a repository promotion holds its lock (checker polls are
// frozen; the promoter's own routes are exempt). RUNNER_BUSY means this
// runner ID still has an active claim; the claim expires or completes, so a
// later poll succeeds. Every other 409 (RUNNER_ID_CONFLICT, STALE_JOB,
// RESULT_* and friends) is fatal to the current attempt.
const RETRYABLE_CONFLICT_CODES = new Set(['PROMOTION_IN_PROGRESS', 'RUNNER_BUSY']);

function isTransientResponse(response: { status: number; error?: { code: string } }): boolean {
  if (response.status === 429) return true;
  if (response.status >= 500 && response.status <= 599) return true;
  return response.status === 409 && !!response.error && RETRYABLE_CONFLICT_CODES.has(response.error.code);
}

function responseCode(response: { status: number; error?: { code: string } }): string {
  return response.error?.code ?? String(response.status);
}

function networkCode(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError' ||
    /timed out/i.test(error.message))) return 'TIMEOUT';
  return 'NETWORK_ERROR';
}

function backoffDelayMs(attempt: number, random: () => number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(BACKOFF_CAP_MS, Math.max(0, retryAfterMs));
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** attempt * (0.5 + random()));
}

function networkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return (error instanceof TypeError && /(?:fetch failed|failed to fetch|network|terminated|socket closed)/i.test(error.message)) ||
    error.name === 'TimeoutError' || error.name === 'AbortError' ||
    (!!code && /^(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_\w+)$/.test(code)) ||
    /(?:fetch failed|socket closed|timed out)/i.test(error.message) ||
    ('cause' in error && networkFailure(error.cause));
}

export function retryTransport(transport: Transport, { sleep = defaultSleep, random = Math.random, log = defaultLog }: RetryOptions = {}): Transport {
  return async (path, body, key) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Awaited<ReturnType<Transport>>;
      try { response = await transport(path, body, key); }
      catch (error) {
        if (attempt === 2 || !networkFailure(error)) throw error;
        const delay = backoffDelayMs(attempt, random);
        // Code and next delay only: the body and idempotency key stay out of logs.
        log(`TRANSPORT_RETRY route=${path} code=${networkCode(error)} delayMs=${Math.round(delay)}`);
        await sleep(delay);
        continue;
      }
      if (attempt === 2 || !isTransientResponse(response)) return response;
      const delay = backoffDelayMs(attempt, random, response.retryAfterMs);
      log(`TRANSPORT_RETRY route=${path} code=${responseCode(response)} delayMs=${Math.round(delay)}`);
      await sleep(delay);
    }
    throw new Error('RETRY_EXHAUSTED');
  };
}

// Poll until the server answers with something other than a transient failure.
// The same idempotency key and body are reused across retries. In --once mode
// a single transient failure is retried once; a second one ends the cycle so
// the caller sees the error. Long-running callers retry until the server
// answers. Returns the elapsed time from each failed request through its
// retry delay so callers can exclude the full retry interval from idle time.
async function pollWithRetry(transport: Transport, body: unknown, key: string,
  { sleep, random, log, now, once }: { sleep: (ms: number) => Promise<void>; random: () => number;
    log: (line: string) => void; now: () => number; once: boolean }):
  Promise<{ response: Awaited<ReturnType<Transport>>; retryMs: number }> {
  let retryMs = 0;
  let attempt = 0;
  for (;;) {
    const attemptStarted = now();
    try {
      const response = await transport('runner/poll', body, key);
      if (!isTransientResponse(response) || (once && attempt >= 1)) return { response, retryMs };
      const delay = backoffDelayMs(attempt, random, response.retryAfterMs);
      attempt++;
      // Code and next delay only: the body and idempotency key stay out of logs.
      log(`POLL_RETRY code=${responseCode(response)} delayMs=${Math.round(delay)}`);
      await sleep(delay);
      retryMs += now() - attemptStarted;
    } catch (error) {
      if (!networkFailure(error) || (once && attempt >= 1)) throw error;
      const delay = backoffDelayMs(attempt, random);
      attempt++;
      log(`POLL_RETRY code=${networkCode(error)} delayMs=${Math.round(delay)}`);
      await sleep(delay);
      retryMs += now() - attemptStarted;
    }
  }
}

export function apiTransport(base: string, token: string, repo: string, fetcher: typeof fetch = fetch, profileName?: string): Transport {
  const endpoint = new URL('/v1/repos/' + repo + '/', base).toString();
  return async (path, body, key) => {
    const response = await fetcher(new URL(path, endpoint), { method: 'POST', headers: {
      authorization: 'Bearer ' + token, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    if (response.status === 204) return { status: 204 };
    const retryAfter = response.headers.get('retry-after');
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    const retryAfterMs = retryAfter === null ? undefined : Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now());
    const parsed = await response.json().catch(error => {
      if (response.status >= 400) return {};
      throw error;
    }) as { data?: unknown; error?: { code: string; details?: unknown; principalId?: unknown; expiresAt?: unknown } };
    let apiError = parsed.error;
    if (response.status === 401 && profileName && profileName !== 'environment' && profileName !== 'stdin' && apiError &&
      (apiError.code === 'CREDENTIAL_EXPIRED' || apiError.code === 'UNAUTHORIZED')) {
      const details = apiError.details && typeof apiError.details === 'object' ? apiError.details as Record<string, unknown> : {};
      const principalId = apiError.principalId ?? details.principalId;
      const expiresAt = apiError.expiresAt ?? details.expiresAt;
      apiError = { code: `credential for profile ${profileName} was rejected (${apiError.code})` +
        (principalId !== undefined ? ` principalId=${String(principalId)}` : '') +
        (expiresAt !== undefined ? ` expiresAt=${String(expiresAt)}` : '') };
    }
    return { status: response.status, data: parsed.data, error: apiError,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined };
  };
}

export async function runLoop(options: Options, transport: Transport, profile: LocalProfile | null, retryOptions: RetryOptions = {}): Promise<number> {
  const { sleep = defaultSleep, random = Math.random, log = defaultLog, now = Date.now } = retryOptions;
  // Polls retry transient failures in the loop below with backoff; job calls
  // (heartbeat, credentials, result) retry the same transient set per call.
  const jobTransport = retryTransport(transport, { sleep, random, log });
  const profileDigest = profile?.digest ?? options.profileDigest;
  if (!profileDigest || !/^sha256:[a-f0-9]{64}$/.test(profileDigest)) throw new Error('PROFILE_DIGEST_REQUIRED');
  const started = now();
  let count = 0;
  let idleSince = now();
  let retryMs = 0;
  let consecutiveEmptyPolls = 0;
  let idleCapLogged = false;
  while (count < options.maxJobs) {
    const answered = await pollWithRetry(transport, { runnerId: options.runnerId, role: options.role,
      supportedProfileDigests: [profileDigest], maxJobs: 1 }, randomUUID(), { sleep, random, log, now, once: options.once });
    retryMs += answered.retryMs;
    const poll = answered.response;
    if (poll.status === 204) {
      consecutiveEmptyPolls++;
      // Failed poll attempts and their backoff do not count towards idle time.
      const idleElapsed = now() - idleSince - retryMs;
      if (options.once || options.idleTimeoutSeconds === 0 || idleElapsed >= options.idleTimeoutSeconds * 1000) break;
      const capMs = options.idleMaxDelaySeconds * 1000;
      const nominalMs = Math.min(capMs, options.idleMinDelayMs * 2 ** Math.min(consecutiveEmptyPolls - 1, 30));
      if (nominalMs >= capMs && !idleCapLogged) {
        log(`idle: polling every ~${options.idleMaxDelaySeconds}s`);
        idleCapLogged = true;
      }
      const jitter = Math.max(0, Math.min(1, random()));
      const delayMs = Math.min(Math.ceil(nominalMs * (0.5 + jitter * 0.5)), options.idleTimeoutSeconds * 1000 - idleElapsed);
      await sleep(delayMs);
      continue;
    }
    if (poll.status !== 200 || !poll.data?.job) throw new Error('POLL_FAILED:' + (poll.error?.code ?? poll.status));
    const job = poll.data.job as Job;
    if ((job.kind === 'promote') !== (options.role === 'promoter') || job.profileDigest !== profileDigest) throw new Error('JOB_ROLE_OR_PROFILE_MISMATCH');
    idleSince = now();
    retryMs = 0;
    consecutiveEmptyPolls = 0;
    idleCapLogged = false;
    let heartbeatFailure: Error | null = null;
    let inFlight: Promise<void> | null = null;
    const fence = { attempt: job.attempt, fence: job.fence, inputDigest: job.inputDigest };
    const heartbeat = () => {
      if (inFlight) return;
      inFlight = (async () => {
        try {
          const response = await jobTransport('jobs/' + job.jobId + '/heartbeat', fence, randomUUID());
          if (response.status !== 200) heartbeatFailure = new Error('HEARTBEAT_FAILED:' + (response.error?.code ?? response.status));
        } catch { heartbeatFailure = new Error('HEARTBEAT_UNAVAILABLE'); }
      })().finally(() => { inFlight = null; });
    };
    const timer = setInterval(heartbeat, 20_000);
    const credentials: CredentialProvider = async operation => {
      if (heartbeatFailure) throw heartbeatFailure;
      const response = await jobTransport('jobs/' + job.jobId + '/credentials', { attempt: job.attempt, fence: job.fence, operation }, randomUUID());
      if (response.status !== 200 || !Array.isArray(response.data?.credentials)) throw new Error('CREDENTIALS_FAILED:' + (response.error?.code ?? response.status));
      return response.data.credentials as Credential[];
    };
    let result: JobResult;
    try { result = await executeJob(job, profile, credentials); }
    finally { clearInterval(timer); if (inFlight) await inFlight; }
    if (heartbeatFailure) throw heartbeatFailure;
    const body = { ...fence, resultDigest: result.resultDigest, result };
    const key = 'result-' + job.jobId + '-' + job.attempt + '-' + result.resultDigest.slice(7, 39);
    const response = await jobTransport('jobs/' + job.jobId + '/result', body, key);
    if (response.status === 409) throw new Error('STALE_RESULT:' + (response.error?.code ?? 'CONFLICT'));
    if (response.status !== 200) throw new Error('RESULT_FAILED:' + (response.error?.code ?? response.status));
    count++;
    idleSince = now();
    retryMs = 0;
    consecutiveEmptyPolls = 0;
    idleCapLogged = false;
    if (options.once) break;
    if (options.idleTimeoutSeconds > 0 && now() - started > 86_400_000) break;
  }
  return count;
}

async function main(): Promise<void> {
  if (process.argv[2] === 'profile') {
    const args = process.argv.slice(3);
    if (args.length !== 4 || args[0] !== '--command-config' || args[2] !== '--out')
      throw new Error('INVALID_ARGUMENT: profile --command-config FILE --out FILE');
    const input = JSON.parse(await readFile(args[1], 'utf8')) as unknown;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_PROFILE: object');
    const profile = await createCommandProfile(input as Record<string, unknown>);
    await writeFile(args[3], JSON.stringify(profile, null, 2) + '\n', { flag: 'wx' });
    process.stdout.write(profile.digest + '\n');
    return;
  }
  const options = parseArgs(process.argv.slice(2));
  let connection: Awaited<ReturnType<typeof resolveCredential>>;
  try { connection = await resolveCredential({}); }
  catch (error) {
    if (error instanceof Error && (/^(PROFILE_NOT_FOUND|PROFILE_TOKEN_UNREADABLE|PROFILE_PERMISSIONS):/.test(error.message) ||
      error.message === 'CONCORD_URL is required'))
      throw new Error('CONCORD_URL_AND_TOKEN_REQUIRED' + (/^PROFILE_/.test(error.message) ? ' ' + error.message : ''));
    throw error;
  }
  if (!connection.url || !connection.url.trim()) throw new Error('CONCORD_URL_AND_TOKEN_REQUIRED');
  const profile = options.profileFile ? await loadProfile(options.profileFile) : null;
  const count = await runLoop(options, apiTransport(connection.url, connection.token, options.repo, fetch, connection.profileName), profile);
  process.stdout.write('Completed ' + count + ' job(s)\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write((error instanceof Error ? error.message : 'Runner failed') + '\n'); process.exitCode = 1; });
}
