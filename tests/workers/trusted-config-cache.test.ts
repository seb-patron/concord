import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleContext, Principal, TrustedConfiguration } from '../../src/contracts';
import { RepoCoordinator } from '../../src/coordinator';
import { loadTrustedConfig, localFixtureConfig, trustedConfig } from '../../src/state';
import worker from '../../src/worker';
import { apiRequest, mutation } from '../helpers';

const runtime = env as Env;
const originalConfig = runtime.TRUSTED_CONFIG;
afterEach(() => {
  runtime.TRUSTED_CONFIG = originalConfig;
  vi.restoreAllMocks();
});

const configText = (maxLeaseHoldSeconds: number) => JSON.stringify({
  ...localFixtureConfig('local'), costLimits: { maxLeaseHoldSeconds },
});
const maxLeaseHoldSeconds = (config: TrustedConfiguration) =>
  (config.costLimits as (TrustedConfiguration['costLimits'] & { maxLeaseHoldSeconds?: number }) | undefined)?.maxLeaseHoldSeconds;
const fetchApi = (request: Request) => worker.fetch(request, env);
const countParses = (parse: { mock: { calls: unknown[][] } }, text: string) =>
  parse.mock.calls.filter(([input]) => input === text).length;

describe('trusted config cache', () => {
  it('parses the trusted config once per config text across requests, alarms and the catalog', async () => {
    const originalText = runtime.TRUSTED_CONFIG;
    const text = configText(3601);
    const updatedText = configText(3602);
    runtime.TRUSTED_CONFIG = text;
    const parse = vi.spyOn(JSON, 'parse');
    const repoId = `parse-${crypto.randomUUID().replaceAll('-', '')}`;
    const poll = (key: string) => fetchApi(mutation(`/v1/repos/${repoId}/runner/poll`, {
      runnerId: 'parse-count', role: 'checker', supportedProfileDigests: [],
    }, key, 'local-checker'));

    parse.mockClear();
    expect((await poll('parse-once-first')).status).toBe(204);
    expect(countParses(parse, text)).toBe(1);

    parse.mockClear();
    expect((await poll('parse-once-second')).status).toBe(204);
    expect(countParses(parse, text)).toBe(0);

    parse.mockClear();
    expect((await fetchApi(apiRequest(`/v1/repos/${repoId}/queue`))).status).toBe(200);
    expect(countParses(parse, text)).toBe(0);

    const stub = runtime.REPO_COORDINATOR.get(runtime.REPO_COORDINATOR.idFromName(`repo:local:${repoId}`));
    parse.mockClear();
    await runInDurableObject<RepoCoordinator, void>(stub, async instance => { await instance.alarm(); });
    expect(countParses(parse, text)).toBe(0);

    parse.mockClear();
    expect((await fetchApi(apiRequest('/v1/repos'))).status).toBe(200);
    expect(countParses(parse, text)).toBe(0);

    runtime.TRUSTED_CONFIG = updatedText;
    parse.mockClear();
    expect((await poll('parse-once-updated')).status).toBe(204);
    expect(countParses(parse, updatedText)).toBe(1);
    expect(countParses(parse, text)).toBe(0);
    await runInDurableObject<RepoCoordinator, void>(stub, async instance => {
      const principal: Principal = { tenantId: 'local', principalId: 'checker', roles: ['checker'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
      const context = (instance as unknown as { context(name: 'repos', principal: Principal, repoId: string): ModuleContext })
        .context('repos', principal, repoId);
      expect(maxLeaseHoldSeconds(context.trusted)).toBe(3602);
    });
    runtime.TRUSTED_CONFIG = originalText;
  });

  it('memoizes by exact config inputs, never caches failures, and freezes the result', () => {
    const textA = configText(3603);
    const textB = configText(3604);
    const envA: Pick<Env, 'CONCORD_MODE' | 'TRUSTED_CONFIG' | 'TRUSTED_CONFIG_PARTS'> = { CONCORD_MODE: 'production', TRUSTED_CONFIG: textA };
    const parse = vi.spyOn(JSON, 'parse');

    const first = trustedConfig(envA);
    expect(trustedConfig(envA)).toBe(first);
    expect(countParses(parse, textA)).toBe(1);
    expect(trustedConfig({ ...envA })).toBe(first);
    envA.TRUSTED_CONFIG = textB;
    const second = trustedConfig(envA);
    expect(second).not.toBe(first);
    expect(maxLeaseHoldSeconds(second)).toBe(3604);

    const parts = (text: string): Pick<Env, 'CONCORD_MODE' | 'TRUSTED_CONFIG' | 'TRUSTED_CONFIG_PARTS'> & {
      TRUSTED_CONFIG_PART_0: string; TRUSTED_CONFIG_PART_1: string;
    } => ({
      CONCORD_MODE: 'production', TRUSTED_CONFIG_PARTS: '2',
      TRUSTED_CONFIG_PART_0: text.slice(0, Math.floor(text.length / 2)),
      TRUSTED_CONFIG_PART_1: text.slice(Math.floor(text.length / 2)),
    });
    const partsEnv = parts(textA);
    const fromParts = trustedConfig(partsEnv);
    expect(trustedConfig(partsEnv)).toBe(fromParts);
    partsEnv.TRUSTED_CONFIG_PART_1 += ' ';
    expect(trustedConfig(partsEnv)).not.toBe(fromParts);

    const invalid = { CONCORD_MODE: 'production', TRUSTED_CONFIG: 'invalid' } as const;
    parse.mockClear();
    expect(() => trustedConfig(invalid)).toThrow('TRUSTED_CONFIG_INVALID');
    expect(() => trustedConfig(invalid)).toThrow('TRUSTED_CONFIG_INVALID');
    expect(countParses(parse, 'invalid')).toBe(2);
    expect(maxLeaseHoldSeconds(trustedConfig({ CONCORD_MODE: 'production', TRUSTED_CONFIG: textA }))).toBe(3603);

    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.policies['local-demo'])).toBe(true);
    expect(Object.isFrozen(first.policies['local-demo'].acceptance.gates)).toBe(true);
    expect(() => { first.policies['local-demo'].version = 9; }).toThrow(TypeError);
    const loaded = loadTrustedConfig(envA);
    expect(loaded).not.toBe(second);
    expect(Object.isFrozen(loaded)).toBe(false);
  });
});
