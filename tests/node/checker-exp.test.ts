import { describe, expect, it } from 'vitest';
import worker, { CheckerExperiment } from '../../src/experiments/checker-exp-worker';
import { CHECKER_REPO_URL } from '../../src/features/container-checker';

const secret = 'experiment-secret-value';
const gitToken = 'cct_read_0123456789abcdef';
const baseBody = { repoUrl: CHECKER_REPO_URL, sha: 'a'.repeat(40), gitToken };
const request = (path: string, body?: unknown, token = secret) => new Request(`https://checker.example${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(exec?: (argv: string[]) => Promise<{ code: number; output: string }>) {
  const values = new Map<string, unknown>();
  const starts: unknown[] = [];
  const execCalls: string[][] = [];
  let locked = Promise.resolve();
  let alarm: number | null = null;
  const ctx = {
    storage: {
      get: async <T>(key: string) => values.get(key) as T | undefined,
      put: async (key: string, value: unknown) => { values.set(key, value); },
      delete: async (key: string) => values.delete(key),
      setAlarm: async (value: number) => { alarm = value; },
      deleteAlarm: async () => { alarm = null; },
    },
    blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => {
      const prior = locked;
      let release!: () => void;
      locked = new Promise<void>(resolve => { release = resolve; });
      await prior;
      try { return await fn(); } finally { release(); }
    },
    container: {
      running: true,
      images: { checker: 'local' },
      start(options: unknown) { starts.push(options); this.running = true; },
      async setInactivityTimeout() {},
      async destroy() { this.running = false; },
      async exec(argv: string[]) {
        execCalls.push(argv);
        const value = await (exec?.(argv) ?? Promise.resolve({ code: 0, output: `tool output ${gitToken}` }));
        return { exitCode: Promise.resolve(value.code), stdout: new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode(value.output)); controller.close(); },
        }) };
      },
    },
  };
  const instance = new CheckerExperiment(ctx as never, { EXP_TOKEN: secret, EXP_REPO_URL: CHECKER_REPO_URL });
  const namespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: (req: Request) => instance.fetch(req) }),
  };
  const env = { EXP_TOKEN: secret, CHECKER_EXP: namespace };
  return { instance, env, ctx, values, starts, execCalls, get alarm() { return alarm; } };
}

describe('separate checker experiment Worker', () => {
  it('requires the EXP_TOKEN on both routes', async () => {
    const f = fixture();
    expect((await worker.fetch(request('/status', undefined, ''), f.env as never)).status).toBe(401);
    expect((await worker.fetch(request('/status', undefined, 'wrong'), f.env as never)).status).toBe(401);
    expect((await worker.fetch(request('/status'), f.env as never)).status).toBe(200);
  });

  it('rejects a chunked oversized body after reading only the 16 KiB limit plus one byte', async () => {
    const f = fixture();
    const limit = 16 * 1024;
    const chunks = [4096, 4096, 4096, 4096, 1, 4096];
    let index = 0;
    let bytesRead = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === chunks.length) { controller.close(); return; }
        const size = chunks[index++];
        bytesRead += size;
        controller.enqueue(new Uint8Array(size).fill(120));
      },
    }, { highWaterMark: 0 });
    const response = await f.instance.fetch(new Request('https://checker.example/run', {
      method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body, duplex: 'half',
    } as RequestInit & { duplex: 'half' }));
    expect(response.status).toBe(400);
    expect(bytesRead).toBe(limit + 1);
    expect(bytesRead).toBeLessThan(chunks.reduce((sum, value) => sum + value, 0));
    expect(f.execCalls).toHaveLength(0);
  });

  it('rejects a timeout above 15 minutes and accepts exactly 900 seconds', async () => {
    const f = fixture();
    expect((await f.instance.fetch(request('/run', { ...baseBody, timeoutSeconds: 901 }))).status).toBe(400);
    expect((await f.instance.fetch(request('/run', { ...baseBody, timeoutSeconds: 900 }))).status).toBe(200);
    expect(f.alarm).toBeNull();
  });

  it('rejects a different repository host or path before any container exec', async () => {
    const f = fixture();
    for (const repoUrl of [
      'https://attacker.example/seb-patron/concord-v2.git',
      'https://github.com/other/concord-v2.git',
    ]) {
      const response = await f.instance.fetch(request('/run', { ...baseBody, repoUrl }));
      expect(response.status).toBe(400);
    }
    expect(f.execCalls).toHaveLength(0);
    expect(f.values.get('runCount')).toBeUndefined();
  });

  it('returns BUSY during an active run and caps the persisted count at three including failed runs', async () => {
    const entered = deferred<void>();
    const gate = deferred<{ code: number; output: string }>();
    let first = true;
    const f = fixture(async () => {
      if (first) { first = false; entered.resolve(); return gate.promise; }
      return { code: 1, output: 'failed' };
    });
    const inFlight = f.instance.fetch(request('/run', baseBody));
    await entered.promise;
    expect(f.alarm).not.toBeNull();
    expect((await f.instance.fetch(request('/run', baseBody))).status).toBe(409);
    gate.resolve({ code: 1, output: 'failed' });
    expect((await inFlight).status).toBe(200);
    expect((await f.instance.fetch(request('/run', baseBody))).status).toBe(200);
    expect((await f.instance.fetch(request('/run', baseBody))).status).toBe(200);
    const capped = await f.instance.fetch(request('/run', baseBody));
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ error: 'EXPERIMENT_CAP_REACHED' });
    expect((await f.instance.fetch(request('/status'))).status).toBe(200);
  });

  it('records fetch as the phase that timed out when the overall alarm fires during fetch', async () => {
    const entered = deferred<void>();
    const gate = deferred<{ code: number; output: string }>();
    const f = fixture(async () => { entered.resolve(); return gate.promise; });
    const running = f.instance.fetch(request('/run', baseBody));
    await entered.promise;
    await new Promise(resolve => setTimeout(resolve, 5));
    await f.instance.alarm();
    const saved = f.values.get('lastResult') as Record<string, any>;
    expect(saved.timedOut).toBe(true);
    expect(saved.timedOutPhase).toBe('fetch');
    expect(saved.phaseMs.fetch).toBeGreaterThan(0);
    gate.resolve({ code: 0, output: '' });
    const response = await running;
    expect(response.status).toBe(200);
    const status = await (await f.instance.fetch(request('/status'))).json() as { lastResult: unknown };
    expect(await response.json()).toEqual(status.lastResult);
    expect(status.lastResult).toEqual(saved);
    expect(f.values.get('result:1')).toEqual(saved);
  });

  it('returns the stored alarm timeout result when the in-flight exec rejects afterward', async () => {
    const entered = deferred<void>();
    const gate = deferred<{ code: number; output: string }>();
    const f = fixture(async () => { entered.resolve(); return gate.promise; });
    const running = f.instance.fetch(request('/run', baseBody));
    await entered.promise;
    await f.instance.alarm();
    const saved = f.values.get('lastResult');
    expect(saved).toMatchObject({ runNumber: 1, timedOut: true, timedOutPhase: 'fetch' });
    gate.reject(new Error('exec failed after alarm'));
    const response = await running;
    expect(response.status).toBe(200);
    const status = await (await f.instance.fetch(request('/status'))).json() as { lastResult: unknown };
    expect(await response.json()).toEqual(status.lastResult);
    expect(status.lastResult).toEqual(saved);
    expect(f.values.get('result:1')).toEqual(saved);
    expect(f.values.get('runCount')).toBe(1);
  });

  it('returns the documented result and cost formula without exposing the Git token', async () => {
    const f = fixture();
    const response = await f.instance.fetch(request('/run', baseBody));
    const result = await response.json() as Record<string, any>;
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ runNumber: 1, sha: baseBody.sha, exitCode: 0, timedOut: false,
      phaseMs: { coldStart: expect.any(Number), fetch: expect.any(Number), install: expect.any(Number), check: expect.any(Number) },
      logTail: expect.stringContaining('[REDACTED]'), estimatedCostUsd: expect.any(Number) });
    expect(result.wallMs).toEqual(expect.any(Number));
    expect(result.estimatedCostUsd).toBeCloseTo(result.wallMs / 60_000 * 0.007, 12);
    expect(JSON.stringify(result)).not.toContain(gitToken);
    expect(f.values.get('runCount')).toBe(1);
    const status = await (await f.instance.fetch(request('/status'))).json() as { totalEstimatedCostUsd: number };
    expect(status.totalEstimatedCostUsd).toBeCloseTo(result.estimatedCostUsd, 12);
  });

  it('starts only the named image at standard-4 and destroys the container after the run', async () => {
    const f = fixture();
    f.ctx.container.running = false;
    await f.instance.fetch(request('/run', baseBody));
    expect(f.starts).toEqual([{ image: 'local', entrypoint: ['sleep', 'infinity'], enableInternet: true, instance: 'standard-4' }]);
    expect(f.ctx.container.running).toBe(false);
  });
});
