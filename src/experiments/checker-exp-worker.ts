import { CHECKER_REPO_URL, readBoundedTail, runChecker, type CheckerExecution, type CheckerInput, type CheckerPhase } from '../features/container-checker';

const MAX_RUNTIME_MS = 15 * 60_000;
const COST_PER_MINUTE_USD = 0.007;
const ACTIVE_KEY = 'activeRun';
const COUNT_KEY = 'runCount';
const RESULT_KEY = 'lastResult';
const COST_KEY = 'totalEstimatedCostUsd';
const MAX_BODY_BYTES = 16 * 1024;

function runResultKey(runNumber: number): string { return `result:${runNumber}`; }

type ExpResult = CheckerExecution & {
  runNumber: number; sha: string; wallMs: number; phaseMs: CheckerExecution['phaseMs']; estimatedCostUsd: number;
  timedOutPhase: CheckerPhase | null;
};
type ActiveRun = {
  runNumber: number; sha: string; startedAt: number; phaseMs: CheckerExecution['phaseMs'];
  currentPhase: CheckerPhase | null; phaseStartedAt: number | null;
};
type ExpEnv = { EXP_TOKEN?: string; EXP_REPO_URL?: string; EXP_RUN_LIMIT?: string; CHECKER_EXP?: DurableObjectNamespace };
type ContainerState = Pick<DurableObjectState, 'storage' | 'blockConcurrencyWhile'> & { container?: Container };

function constantTimeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  diff |= Number(left.length > 4096 || right.length > 4096);
  for (let i = 0; i < 4096; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function authorized(request: Request, expected: string | undefined): boolean {
  if (!expected) return false;
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  return !!match && constantTimeEqual(match[1], expected);
}

function runLimit(env: ExpEnv): number {
  const parsed = env.EXP_RUN_LIMIT === undefined ? 3 : Number(env.EXP_RUN_LIMIT);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 3 ? parsed : 3;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

function fail(code: string, status: number): Response { return json({ error: code }, status); }

function isRunInput(value: unknown, expectedRepoUrl: string | undefined): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (!expectedRepoUrl || body.repoUrl !== expectedRepoUrl || typeof body.repoUrl !== 'string' || body.repoUrl.length > 2048) return false;
  try {
    const repoUrl = new URL(body.repoUrl);
    if (repoUrl.protocol !== 'https:' || repoUrl.username || repoUrl.password || repoUrl.hash) return false;
  } catch { return false; }
  if (typeof body.sha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(body.sha)) return false;
  if (typeof body.gitToken !== 'string' || body.gitToken.length < 1 || body.gitToken.length > 4096) return false;
  return body.timeoutSeconds === undefined || (Number.isSafeInteger(body.timeoutSeconds) && Number(body.timeoutSeconds) >= 1 && Number(body.timeoutSeconds) <= 900);
}

function estimatedCost(wallMs: number): number { return wallMs / 60_000 * COST_PER_MINUTE_USD; }

export class CheckerExperiment {
  constructor(private readonly ctx: ContainerState, private readonly env: ExpEnv) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'POST') return fail('METHOD_NOT_ALLOWED', 405);
    if (!authorized(request, this.env.EXP_TOKEN)) return fail('UNAUTHORIZED', 401);
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/status') return this.status();
    if (request.method !== 'POST' || path !== '/run') return fail('NOT_FOUND', 404);
    const contentLength = request.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_BODY_BYTES) return fail('INVALID_REQUEST', 400);
    let body: unknown;
    try {
      const reader = request.body?.getReader();
      if (!reader) return fail('INVALID_REQUEST', 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const remaining = MAX_BODY_BYTES + 1 - size;
          const part = value.subarray(0, remaining);
          chunks.push(part.slice());
          size += part.byteLength;
          if (size > MAX_BODY_BYTES) {
            await reader.cancel();
            return fail('INVALID_REQUEST', 400);
          }
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch { return fail('INVALID_REQUEST', 400); }
    if (!isRunInput(body, this.env.EXP_REPO_URL)) return fail('INVALID_REQUEST', 400);
    const input: CheckerInput = {
      repoUrl: body.repoUrl as string, sha: body.sha as string, gitToken: body.gitToken as string,
      timeoutSeconds: (body.timeoutSeconds as number | undefined) ?? 900,
    };
    const run = await this.reserve(input.sha);
    if (run instanceof Response) return run;
    const startedAt = Date.now();
    const container = this.ctx.container;
    if (!container) return this.finishFailure(run, input.sha, startedAt, 503, 'CONTAINER_UNAVAILABLE');
    try {
      const coldStartStartedAt = Date.now();
      if (!container.running) {
        const image = container.images.checker;
        if (!image) return this.finishFailure(run, input.sha, startedAt, 503, 'CONTAINER_IMAGE_UNAVAILABLE');
        container.start({ image, entrypoint: ['sleep', 'infinity'], enableInternet: true, instance: 'standard-4' });
      }
      await container.setInactivityTimeout(60_000);
      await this.ctx.storage.setAlarm(startedAt + MAX_RUNTIME_MS);
      const execution = await runChecker(async (argv, options) => {
        const controller = new AbortController();
        const process = await container.exec(argv, { cwd: options.cwd, env: options.env, signal: controller.signal, stdout: 'pipe', stderr: 'combined' });
        const readyAt = Date.now();
        let done = false;
        let timedOut = false;
        void process.exitCode.finally(() => { done = true; }).catch(() => undefined);
        const timer = setTimeout(() => { if (!done) { timedOut = true; controller.abort(); } }, options.timeoutMs);
        try {
          const [code, output] = await Promise.all([
            process.exitCode.catch(() => null), process.stdout ? readBoundedTail(process.stdout).catch(() => '') : Promise.resolve(''),
          ]);
          return { code, output, timedOut, readyAt };
        } finally { clearTimeout(timer); }
      }, input, Date.now, coldStartStartedAt, async progress => {
        await this.ctx.blockConcurrencyWhile(async () => {
          const active = await this.ctx.storage.get<ActiveRun>(ACTIVE_KEY);
          if (active?.runNumber === run.runNumber) await this.ctx.storage.put(ACTIVE_KEY, { ...active, ...progress });
        });
      });
      const wallMs = Math.max(0, Date.now() - startedAt);
      const result: ExpResult = { runNumber: run.runNumber, sha: input.sha, ...execution, wallMs,
        estimatedCostUsd: estimatedCost(wallMs), timedOutPhase: null };
      const responseResult = await this.ctx.blockConcurrencyWhile(async () => {
        const active = await this.ctx.storage.get<ActiveRun>(ACTIVE_KEY);
        if (!active || active.runNumber !== run.runNumber) {
          return await this.ctx.storage.get<ExpResult>(runResultKey(run.runNumber)) ?? result;
        }
        await this.destroyContainer();
        await this.ctx.storage.put(RESULT_KEY, result);
        await this.ctx.storage.put(runResultKey(run.runNumber), result);
        await this.addCost(result.estimatedCostUsd);
        await this.ctx.storage.delete(ACTIVE_KEY);
        await this.ctx.storage.deleteAlarm();
        return result;
      });
      return json(responseResult);
    } catch {
      return this.finishFailure(run, input.sha, startedAt, 500, 'CHECK_FAILED');
    }
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const active = await this.ctx.storage.get<ActiveRun>(ACTIVE_KEY);
      if (!active) return;
      await this.destroyContainer();
      const wallMs = Math.max(0, Date.now() - active.startedAt);
      const phaseMs = { ...active.phaseMs };
      if (active.currentPhase && active.phaseStartedAt !== null) {
        phaseMs[active.currentPhase] += Math.max(0, Date.now() - active.phaseStartedAt);
      }
      const result: ExpResult = {
        runNumber: active.runNumber, sha: active.sha, exitCode: null, timedOut: true, wallMs,
        phaseMs, logTail: 'overall 15-minute limit reached', estimatedCostUsd: estimatedCost(wallMs),
        timedOutPhase: active.currentPhase,
      };
      await this.ctx.storage.put(RESULT_KEY, result);
      await this.ctx.storage.put(runResultKey(active.runNumber), result);
      await this.addCost(result.estimatedCostUsd);
      await this.ctx.storage.delete(ACTIVE_KEY);
      await this.ctx.storage.deleteAlarm();
    });
  }

  private async reserve(sha: string): Promise<{ runNumber: number } | Response> {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get<ActiveRun>(ACTIVE_KEY)) return fail('BUSY', 409);
      const count = await this.ctx.storage.get<number>(COUNT_KEY) ?? 0;
      const limit = runLimit(this.env);
      if (count >= limit) return fail('EXPERIMENT_CAP_REACHED', 429);
      const active: ActiveRun = { runNumber: count + 1, sha, startedAt: Date.now(),
        phaseMs: { coldStart: 0, fetch: 0, install: 0, check: 0 }, currentPhase: null, phaseStartedAt: null };
      await this.ctx.storage.put(COUNT_KEY, active.runNumber);
      await this.ctx.storage.put(ACTIVE_KEY, active);
      await this.ctx.storage.setAlarm(active.startedAt + MAX_RUNTIME_MS);
      return { runNumber: active.runNumber };
    });
  }

  private async status(): Promise<Response> {
    const [count, active, lastResult, totalEstimatedCostUsd] = await Promise.all([
      this.ctx.storage.get<number>(COUNT_KEY), this.ctx.storage.get<ActiveRun>(ACTIVE_KEY), this.ctx.storage.get<ExpResult>(RESULT_KEY),
      this.ctx.storage.get<number>(COST_KEY),
    ]);
    return json({ runCount: count ?? 0, runLimit: runLimit(this.env), running: !!active,
      activeRun: active ? { runNumber: active.runNumber, sha: active.sha, startedAt: active.startedAt } : null,
      lastResult: lastResult ?? null,
      totalEstimatedCostUsd: totalEstimatedCostUsd ?? 0,
    });
  }

  private async finishFailure(run: { runNumber: number }, sha: string, startedAt: number, status: number, code: string): Promise<Response> {
    const wallMs = Math.max(0, Date.now() - startedAt);
    const result: ExpResult = { runNumber: run.runNumber, sha, exitCode: null, timedOut: false, wallMs,
      phaseMs: { coldStart: 0, fetch: 0, install: 0, check: 0 }, logTail: code, estimatedCostUsd: estimatedCost(wallMs),
      timedOutPhase: null };
    const responseResult = await this.ctx.blockConcurrencyWhile(async () => {
      const active = await this.ctx.storage.get<ActiveRun>(ACTIVE_KEY);
      if (active?.runNumber !== run.runNumber) {
        return await this.ctx.storage.get<ExpResult>(runResultKey(run.runNumber)) ?? result;
      }
      await this.destroyContainer();
      await this.ctx.storage.put(RESULT_KEY, result);
      await this.ctx.storage.put(runResultKey(run.runNumber), result);
      await this.addCost(result.estimatedCostUsd);
      await this.ctx.storage.delete(ACTIVE_KEY);
      await this.ctx.storage.deleteAlarm();
      return result;
    });
    return json(responseResult, responseResult.timedOut && responseResult.timedOutPhase !== undefined ? 200 : status);
  }

  private async destroyContainer(): Promise<void> {
    if (this.ctx.container?.running) await this.ctx.container.destroy();
  }

  private async addCost(amount: number): Promise<void> {
    const total = await this.ctx.storage.get<number>(COST_KEY) ?? 0;
    await this.ctx.storage.put(COST_KEY, total + amount);
  }
}

export default {
  async fetch(request: Request, env: ExpEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== '/run' && path !== '/status') return fail('NOT_FOUND', 404);
    if (request.method !== 'POST' && request.method !== 'GET') return fail('METHOD_NOT_ALLOWED', 405);
    if (!authorized(request, env.EXP_TOKEN)) return fail('UNAUTHORIZED', 401);
    if (!env.CHECKER_EXP) return fail('CONTAINER_UNAVAILABLE', 503);
    const id = env.CHECKER_EXP.idFromName('exp');
    return env.CHECKER_EXP.get(id).fetch(request);
  },
};
