import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import type { ChangeView, FeatureModule, ModuleRoute } from '../../src/contracts';
import { modules } from '../../src/coordinator';
import type { RepoCoordinator } from '../../src/coordinator';
import { repos } from '../../src/features/repos';
import { leases } from '../../src/features/leases';
import { queue } from '../../src/features/queue';
import { runners } from '../../src/features/runners';
import { findings } from '../../src/features/findings';
import { verdicts } from '../../src/features/verdicts';
import { json } from '../../src/http';
import { apiRequest, mutation, responseBody } from '../helpers';

const fetchApi = (request: Request) => worker.fetch(request, env);

describe('cross-module coordinator hooks', () => {
  it('rejects a mutation whose body finishes after promotion freezes the repository', async () => {
    const repoId = 'hooks_freeze_race';
    const mutatePath = `/v1/repos/${repoId}/test-mutate`;
    const freezePath = `/v1/repos/${repoId}/test-freeze`;
    const prior = queue.promotionFreeze;
    const nativeJson = Request.prototype.json;
    let signalReading!: () => void;
    const reading = new Promise<void>(resolve => { signalReading = resolve; });
    let releaseBody: (() => void) | undefined;
    const mutate: ModuleRoute = {
      method: 'POST', pattern: /^\/v1\/repos\/hooks_freeze_race\/test-mutate$/,
      handle: context => {
        context.state.put('mutation', true);
        return json({ accepted: true });
      },
    };
    const inspect: ModuleRoute = {
      method: 'GET', pattern: /^\/v1\/repos\/hooks_freeze_race\/test-mutate$/,
      handle: context => json({ mutated: context.state.get<boolean>('mutation') === true }),
    };
    const freeze: ModuleRoute = {
      method: 'POST', pattern: /^\/v1\/repos\/hooks_freeze_race\/test-freeze$/,
      handle: context => {
        context.state.put('frozen', true);
        return json({ frozen: true });
      },
    };
    repos.routes.unshift(mutate, inspect);
    queue.routes.unshift(freeze);
    queue.promotionFreeze = context => ({ frozen: context.state.get<boolean>('frozen') === true });
    Request.prototype.json = async function () {
      if (new URL(this.url).pathname === mutatePath) {
        await new Promise<void>(resolve => {
          releaseBody = resolve;
          signalReading();
        });
      }
      return nativeJson.call(this);
    };
    try {
      const pending = fetchApi(mutation(mutatePath, { expectedVersion: 0, tenantId: 'local' }, 'slow-body'));
      await reading;
      const frozen = await fetchApi(mutation(freezePath, { tenantId: 'local', expectedVersion: 0 }, 'start-freeze'));
      expect(frozen.status).toBe(200);
      expect((await responseBody(frozen)).data).toEqual({ frozen: true });
      releaseBody?.();
      const blocked = await pending;
      expect(blocked.status).toBe(409);
      const state = await fetchApi(apiRequest(mutatePath));
      expect((await responseBody(state)).data).toEqual({ mutated: false });
      const stillFrozen = await fetchApi(mutation(mutatePath, { expectedVersion: 0, tenantId: 'local' }, 'after-freeze'));
      expect((await responseBody(stillFrozen)).error.code).toBe('PROMOTION_IN_PROGRESS');
    } finally {
      releaseBody?.();
      Request.prototype.json = nativeJson;
      queue.promotionFreeze = prior;
      repos.routes.splice(repos.routes.indexOf(mutate), 1);
      repos.routes.splice(repos.routes.indexOf(inspect), 1);
      queue.routes.splice(queue.routes.indexOf(freeze), 1);
    }
  });

  it('blocks mutations across all modules while frozen and permits reads and the trusted result path', async () => {
    const prior = queue.promotionFreeze;
    const routes = new Map<FeatureModule, ModuleRoute[]>();
    const repoId = 'hooks_freeze';
    const resultPath = `/v1/repos/${repoId}/jobs/test-job/result`;
    try {
      queue.promotionFreeze = (_context, request) => ({
        frozen: true,
        exempt: new URL(request.url).pathname === resultPath,
      });
      for (const module of modules) {
        const path = `/v1/repos/${repoId}/test-${module.name}`;
        const synthetic: ModuleRoute[] = [
          { method: 'POST', pattern: new RegExp(`^${path}$`), handle: () => json({ accepted: true }) },
          { method: 'GET', pattern: new RegExp(`^${path}$`), handle: () => json({ readable: true }) },
        ];
        module.routes.unshift(...synthetic);
        routes.set(module, synthetic);
        const blocked = await fetchApi(mutation(path, {}, `freeze-${module.name}`));
        expect(blocked.status).toBe(409);
        expect((await responseBody(blocked)).error.code).toBe('PROMOTION_IN_PROGRESS');
        const read = await fetchApi(apiRequest(path));
        expect(read.status).toBe(200);
        expect((await responseBody(read)).data).toEqual({ readable: true });
      }
      const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repoId}`));
      const routeCases: Array<[FeatureModule, string]> = [
        [repos, `/v1/repos/${repoId}`],
        [repos, `/v1/repos/${repoId}/bootstrap`],
        [repos, `/v1/repos/${repoId}/changes`],
        [repos, `/v1/repos/${repoId}/changes/c/publish`],
        [leases, `/v1/repos/${repoId}/leases`],
        [queue, `/v1/repos/${repoId}/queue/enqueue`],
        [queue, `/v1/repos/${repoId}/contests`],
        [runners, `/v1/repos/${repoId}/runner/poll`],
        [runners, `/v1/repos/${repoId}/jobs/other-job/heartbeat`],
        [runners, `/v1/repos/${repoId}/jobs/other-job/result`],
        [findings, `/v1/repos/${repoId}/changes/c/findings`],
        [verdicts, `/v1/repos/${repoId}/changes/c/verdicts`],
      ];
      for (const [module, path] of routeCases) {
        expect(module.routes.some(route => route.pattern.test(path))).toBe(true);
        const blocked = await runInDurableObject<RepoCoordinator, Response>(stub, instance => instance.fetch(new Request(`https://concord.test${path}`, {
          method: 'POST',
          headers: { 'x-concord-principal': JSON.stringify({ tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER }) },
        })));
        expect(blocked.status).toBe(409);
        expect((await responseBody(blocked)).error.code).toBe('PROMOTION_IN_PROGRESS');
      }
      const exemptRoute: ModuleRoute = {
        method: 'POST', pattern: /^\/v1\/repos\/hooks_freeze\/jobs\/test-job\/result$/,
        handle: () => json({ resultAccepted: true }),
      };
      runners.routes.unshift(exemptRoute);
      routes.get(runners)!.push(exemptRoute);
      const permitted = await fetchApi(mutation(resultPath, {}, 'promoter-result', 'local-promoter'));
      expect(permitted.status).toBe(200);
      expect((await responseBody(permitted)).data).toEqual({ resultAccepted: true });
      const otherActor = await runInDurableObject<RepoCoordinator, Response>(stub, instance => instance.fetch(new Request(`https://concord.test${resultPath}`, {
        method: 'POST',
        headers: { 'x-concord-principal': JSON.stringify({ tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER }) },
      })));
      expect(otherActor.status).toBe(409);
      expect((await responseBody(otherActor)).error.code).toBe('PROMOTION_IN_PROGRESS');
      const snapshot = await fetchApi(apiRequest(`/v1/repos/${repoId}/snapshot`));
      expect(snapshot.status).toBe(200);
      queue.promotionFreeze = undefined;
      const unfrozen = await fetchApi(mutation(`/v1/repos/${repoId}/test-repos`, { expectedVersion: 0 }, 'default-unfrozen'));
      expect(unfrozen.status).toBe(200);
    } finally {
      queue.promotionFreeze = prior;
      for (const [module, synthetic] of routes) {
        for (const route of synthetic) module.routes.splice(module.routes.indexOf(route), 1);
      }
    }
  });

  it('returns an unavailable change view before registration and a detached read-only repos record afterward', async () => {
    const prior = repos.changeView;
    const repoId = 'hooks_change';
    const changeId = 'c1';
    const stored: ChangeView = {
      authorId: 'agent-a', headOid: 'abc123', revision: 3,
      status: 'ready', unitKeys: ['row:one'], frozen: false,
    };
    const seed: ModuleRoute = {
      method: 'POST', pattern: /^\/v1\/repos\/hooks_change\/test-seed$/,
      handle: context => {
        context.state.put(`change:${changeId}`, stored);
        return json({ seeded: true });
      },
    };
    const inspect: ModuleRoute = {
      method: 'GET', pattern: /^\/v1\/repos\/hooks_change\/test-view$/,
      handle: context => {
        const gate = context.readChange!(changeId);
        if (gate.status === 'blocked') return json(gate);
        const writable = Reflect.set(gate.value, 'authorId', 'intruder');
        const writableUnit = Reflect.set(gate.value.unitKeys, '0', 'row:intruder');
        return json({ gate, writable, writableUnit, ownState: context.state.get(`change:${changeId}`) });
      },
    };
    repos.routes.unshift(seed);
    findings.routes.unshift(inspect);
    try {
      const unavailable = await fetchApi(apiRequest(`/v1/repos/${repoId}/test-view`));
      expect((await responseBody(unavailable)).data).toMatchObject({ status: 'blocked', code: 'MODULE_UNAVAILABLE' });
      expect((await fetchApi(mutation(`/v1/repos/${repoId}/test-seed`, { expectedVersion: 0 }, 'seed'))).status).toBe(200);
      repos.changeView = (context, id) => {
        const value = context.state.get<ChangeView>(`change:${id}`);
        if (!value) return { status: 'blocked', version: context.version(), code: 'CHANGE_NOT_FOUND', reason: 'Missing change', evidenceIds: [] };
        return { status: 'eligible', version: context.version(), evidenceIds: [id], value };
      };
      const available = await fetchApi(apiRequest(`/v1/repos/${repoId}/test-view`));
      expect(available.status).toBe(200);
      expect((await responseBody(available)).data).toEqual({
        gate: { status: 'eligible', version: 0, evidenceIds: [changeId], value: stored },
        writable: false, writableUnit: false, ownState: null,
      });
      const again = await fetchApi(apiRequest(`/v1/repos/${repoId}/test-view`));
      expect((await responseBody(again)).data.gate.value).toEqual(stored);
    } finally {
      repos.changeView = prior;
      repos.routes.splice(repos.routes.indexOf(seed), 1);
      findings.routes.splice(findings.routes.indexOf(inspect), 1);
    }
  });
});
