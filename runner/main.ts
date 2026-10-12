import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Job, JobResult } from '../src/contracts';
import { executeJob, type Credential, type CredentialProvider } from './execute';
import { loadProfile, type LocalProfile } from './profiles';

type Options = { repo: string; role: 'checker' | 'promoter'; profileFile?: string; profileDigest?: string;
  once: boolean; maxJobs: number; idleTimeoutSeconds: number; runnerId: string };

export function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  let once = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--once') { once = true; continue; }
    if (!['--repo', '--role', '--profile', '--profile-digest', '--max-jobs', '--idle-timeout-seconds', '--runner-id'].includes(arg) ||
      !args[index + 1]) throw new Error('INVALID_ARGUMENT: ' + arg);
    values.set(arg, args[++index]);
  }
  const role = values.get('--role');
  const repo = values.get('--repo');
  if (!repo || !/^[A-Za-z0-9_-]{1,64}$/.test(repo) || !['checker', 'promoter'].includes(role ?? '')) throw new Error('REPO_AND_ROLE_REQUIRED');
  const maxJobs = values.has('--max-jobs') ? Number(values.get('--max-jobs')) : values.has('--idle-timeout-seconds') ? 1000 : 1;
  const idleTimeoutSeconds = values.has('--idle-timeout-seconds') ? Number(values.get('--idle-timeout-seconds')) : 0;
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 1000 ||
    !Number.isSafeInteger(idleTimeoutSeconds) || idleTimeoutSeconds < 0 || idleTimeoutSeconds > 86_400) throw new Error('INVALID_BOUND');
  if (!once && !values.has('--max-jobs') && !values.has('--idle-timeout-seconds')) once = true;
  if (role === 'checker' && !values.get('--profile')) throw new Error('CHECKER_PROFILE_REQUIRED');
  if (role === 'promoter' && values.get('--profile')) throw new Error('PROMOTER_PROFILE_FORBIDDEN');
  const runnerId = values.get('--runner-id') ?? 'runner-' + randomUUID();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(runnerId)) throw new Error('INVALID_RUNNER_ID');
  return { repo, role: role as Options['role'], profileFile: values.get('--profile'), profileDigest: values.get('--profile-digest') ?? process.env.CONCORD_PROFILE_DIGEST,
    once, maxJobs, idleTimeoutSeconds, runnerId };
}

export type Transport = (path: string, body: unknown, key: string) => Promise<{ status: number; data?: any; error?: { code: string }; retryAfterMs?: number }>;

type RetryOptions = { sleep?: (ms: number) => Promise<void>; random?: () => number };
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function networkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return (error instanceof TypeError && /(?:fetch failed|failed to fetch|network|terminated|socket closed)/i.test(error.message)) ||
    error.name === 'TimeoutError' || error.name === 'AbortError' ||
    (!!code && /^(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_\w+)$/.test(code)) ||
    /(?:fetch failed|socket closed|timed out)/i.test(error.message) ||
    ('cause' in error && networkFailure(error.cause));
}

export function retryTransport(transport: Transport, { sleep = defaultSleep, random = Math.random }: RetryOptions = {}): Transport {
  return async (path, body, key) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Awaited<ReturnType<Transport>>;
      try { response = await transport(path, body, key); }
      catch (error) {
        if (attempt === 2 || !networkFailure(error)) throw error;
        await sleep((attempt === 0 ? 250 : 1000) * (0.5 + random()));
        continue;
      }
      if (attempt === 2 || ![429, 502, 503, 504].includes(response.status)) return response;
      const backoff = (attempt === 0 ? 250 : 1000) * (0.5 + random());
      await sleep(response.status === 429 && response.retryAfterMs !== undefined
        ? Math.min(5000, Math.max(0, response.retryAfterMs)) : backoff);
    }
    throw new Error('RETRY_EXHAUSTED');
  };
}

export function apiTransport(base: string, token: string, repo: string, fetcher: typeof fetch = fetch): Transport {
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
    }) as { data?: unknown; error?: { code: string } };
    return { status: response.status, data: parsed.data, error: parsed.error,
      retryAfterMs: Number.isFinite(retryAfterMs) ? retryAfterMs : undefined };
  };
}

export async function runLoop(options: Options, transport: Transport, profile: LocalProfile | null, retryOptions?: RetryOptions): Promise<number> {
  transport = retryTransport(transport, retryOptions);
  const profileDigest = profile?.digest ?? options.profileDigest;
  if (!profileDigest || !/^sha256:[a-f0-9]{64}$/.test(profileDigest)) throw new Error('PROFILE_DIGEST_REQUIRED');
  const started = Date.now();
  let count = 0;
  let idleSince = Date.now();
  while (count < options.maxJobs) {
    const poll = await transport('runner/poll', { runnerId: options.runnerId, role: options.role,
      supportedProfileDigests: [profileDigest], maxJobs: 1 }, randomUUID());
    if (poll.status === 204) {
      if (options.once || options.idleTimeoutSeconds === 0 || Date.now() - idleSince >= options.idleTimeoutSeconds * 1000) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, options.idleTimeoutSeconds * 1000)));
      continue;
    }
    if (poll.status !== 200 || !poll.data?.job) throw new Error('POLL_FAILED:' + (poll.error?.code ?? poll.status));
    const job = poll.data.job as Job;
    if ((job.kind === 'promote') !== (options.role === 'promoter') || job.profileDigest !== profileDigest) throw new Error('JOB_ROLE_OR_PROFILE_MISMATCH');
    idleSince = Date.now();
    let heartbeatFailure: Error | null = null;
    let inFlight: Promise<void> | null = null;
    const fence = { attempt: job.attempt, fence: job.fence, inputDigest: job.inputDigest };
    const heartbeat = () => {
      if (inFlight) return;
      inFlight = (async () => {
        try {
          const response = await transport('jobs/' + job.jobId + '/heartbeat', fence, randomUUID());
          if (response.status !== 200) heartbeatFailure = new Error('HEARTBEAT_FAILED:' + (response.error?.code ?? response.status));
        } catch { heartbeatFailure = new Error('HEARTBEAT_UNAVAILABLE'); }
      })().finally(() => { inFlight = null; });
    };
    const timer = setInterval(heartbeat, 20_000);
    const credentials: CredentialProvider = async operation => {
      if (heartbeatFailure) throw heartbeatFailure;
      const response = await transport('jobs/' + job.jobId + '/credentials', { attempt: job.attempt, fence: job.fence, operation }, randomUUID());
      if (response.status !== 200 || !Array.isArray(response.data?.credentials)) throw new Error('CREDENTIALS_FAILED:' + (response.error?.code ?? response.status));
      return response.data.credentials as Credential[];
    };
    let result: JobResult;
    try { result = await executeJob(job, profile, credentials); }
    finally { clearInterval(timer); if (inFlight) await inFlight; }
    if (heartbeatFailure) throw heartbeatFailure;
    const body = { ...fence, resultDigest: result.resultDigest, result };
    const key = 'result-' + job.jobId + '-' + job.attempt + '-' + result.resultDigest.slice(7, 39);
    const response = await transport('jobs/' + job.jobId + '/result', body, key);
    if (response.status === 409) throw new Error('STALE_RESULT:' + (response.error?.code ?? 'CONFLICT'));
    if (response.status !== 200) throw new Error('RESULT_FAILED:' + (response.error?.code ?? response.status));
    count++;
    if (options.once) break;
    if (options.idleTimeoutSeconds > 0 && Date.now() - started > 86_400_000) break;
  }
  return count;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const url = process.env.CONCORD_URL;
  const token = process.env.CONCORD_TOKEN;
  if (!url || !token) throw new Error('CONCORD_URL_AND_TOKEN_REQUIRED');
  const profile = options.profileFile ? await loadProfile(options.profileFile) : null;
  const count = await runLoop(options, apiTransport(url, token, options.repo), profile);
  process.stdout.write('Completed ' + count + ' job(s)\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write((error instanceof Error ? error.message : 'Runner failed') + '\n'); process.exitCode = 1; });
}
