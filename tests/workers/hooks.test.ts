import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import type { FeatureModule, ModuleRoute } from '../../src/contracts';
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
      const pending = fetchApi(mutation(mutatePath, { expectedVersion: 0, tenantId: 'local' }, 'slow-body'))
        .then(async response => ({ status: response.status, body: await responseBody(response) }));
      await reading;
      const frozen = await fetchApi(mutation(freezePath, { tenantId: 'local', expectedVersion: 0 }, 'start-freeze'));
      expect(frozen.status).toBe(200);
      expect((await responseBody(frozen)).data).toEqual({ frozen: true });
      releaseBody?.();
      const blocked = await pending;
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('PROMOTION_IN_PROGRESS');
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

  it('keeps an awaited mutation handler exclusive until it finishes', async () => {
    const path = '/v1/repos/hooks_awaited_handler/test-mutate';
    let active = 0;
    let overlap = false;
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstEntered = new Promise<void>(resolve => { signalFirst = resolve; });
    const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve; });
    const route: ModuleRoute = {
      method: 'POST', pattern: /^\/v1\/repos\/hooks_awaited_handler\/test-mutate$/,
      handle: async (_context, _request, _match, body) => {
        active++;
        if (active > 1) overlap = true;
        if (body && typeof body === 'object' && 'order' in body && body.order === 'first') {
          signalFirst();
          await firstMayFinish;
        }
        active--;
        return json({ accepted: true });
      },
    };
    repos.routes.unshift(route);
    try {
      const first = fetchApi(mutation(path, { expectedVersion: 0, order: 'first' }, 'first'));
      await firstEntered;
      const second = fetchApi(mutation(path, { expectedVersion: 0, order: 'second' }, 'second'));
      await new Promise(resolve => setTimeout(resolve, 100));
      releaseFirst();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect(overlap).toBe(false);
    } finally {
      releaseFirst();
      repos.routes.splice(repos.routes.indexOf(route), 1);
    }
  });

  it('preserves an empty runner poll response on the first call and idempotency replay', async () => {
    const path = '/v1/repos/hooks_empty_poll/runner/poll';
    const nativeResponse = globalThis.Response;
    let polls = 0;
    const route: ModuleRoute = {
      method: 'POST', pattern: /^\/v1\/repos\/hooks_empty_poll\/runner\/poll$/,
      handle: () => {
        polls++;
        return new nativeResponse(null, { status: 204 });
      },
    };
    runners.routes.unshift(route);
    // Enforce the standard null-body rule even when the local Workers runtime only warns.
    globalThis.Response = new Proxy(nativeResponse, {
      construct(target, args, newTarget) {
        if (args[1]?.status === 204 && args[0] !== null) throw new TypeError('204 responses require a null body');
        return Reflect.construct(target, args, newTarget) as Response;
      },
    });
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName('repo:local:hooks_empty_poll'));
    const poll = () => runInDurableObject<RepoCoordinator, Response>(stub, instance => instance.fetch(new Request(`https://concord.test${path}`, {
      method: 'POST',
      headers: {
        'x-concord-principal': JSON.stringify({ tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER }),
        'content-type': 'application/json',
        'idempotency-key': 'empty-poll',
      },
      body: JSON.stringify({ tenantId: 'local' }),
    })));
    try {
      const first = await poll();
      expect(first.status).toBe(204);
      expect(first.body).toBeNull();
      const replay = await poll();
      expect(replay.status).toBe(204);
      expect(replay.body).toBeNull();
      expect(polls).toBe(1);
    } finally {
      globalThis.Response = nativeResponse;
      runners.routes.splice(runners.routes.indexOf(route), 1);
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
        expect(blocked.status, path).toBe(409);
        expect((await responseBody(blocked)).error.code).toBe('PROMOTION_IN_PROGRESS');
        const read = await fetchApi(apiRequest(path));
        expect(read.status).toBe(200);
        expect((await responseBody(read)).data).toEqual({ readable: true });
      }
      const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repoId}`));
      const routeCases: Array<[FeatureModule, string]> = [
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
        expect(blocked.status, path).toBe(409);
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

  it('lets findings read a detached repos change view with queue fields', async () => {
    const repoId = 'hooks_change';
    const createdRepo = await fetchApi(mutation('/v1/repos', { name: repoId, policyId: 'local-demo', profileId: 'local-demo' }, 'hooks-create'));
    expect(createdRepo.status).toBe(201);
    const repo = (await responseBody(createdRepo)).data;
    const createdChange = await fetchApi(mutation(`/v1/repos/${repoId}/changes`, {
      intentKey: 'seed', intentText: 'test view', baseOid: null, branch: 'refs/heads/seed', unitKeys: [], dependencyChangeIds: ['dependency-a'],
    }, 'hooks-seed'));
    expect(createdChange.status).toBe(201);
    const change = (await responseBody(createdChange)).data;
    const inspect: ModuleRoute = {
      method: 'GET', pattern: /^\/v1\/repos\/hooks_change\/test-view$/,
      handle: context => {
        const missing = context.readChange!('missing');
        const gate = context.readChange!(change.changeId);
        if (gate.status === 'blocked') return json({ gate, missing });
        const writable = Reflect.set(gate.value, 'authorId', 'intruder');
        const writableUnit = Reflect.set(gate.value.unitKeys, '0', 'row:intruder');
        const writableDependency = Reflect.set(gate.value.dependencyChangeIds!, '0', 'intruder');
        return json({ gate, missing, writable, writableUnit, writableDependency, ownState: context.state.get('changes') });
      },
    };
    findings.routes.unshift(inspect);
    try {
      const available = await fetchApi(apiRequest(`/v1/repos/${repoId}/test-view`));
      expect(available.status).toBe(200);
      expect((await responseBody(available)).data).toEqual({
        gate: { status: 'eligible', version: 1, evidenceIds: [change.changeId], value: {
          authorId: 'owner', headOid: null, revision: 0, status: 'draft', unitKeys: [], frozen: false,
          baseOid: null, candidateStorageName: change.candidateStorageName, branch: 'refs/heads/seed',
          dependencyChangeIds: ['dependency-a'], canonicalStorageName: repo.canonicalStorageName,
        } },
        missing: { status: 'blocked', version: 1, code: 'CHANGE_NOT_FOUND', reason: 'Change not found', evidenceIds: [] },
        writable: false, writableUnit: false, writableDependency: false, ownState: null,
      });
      const again = await fetchApi(apiRequest(`/v1/repos/${repoId}/test-view`));
      expect((await responseBody(again)).data.gate.value.dependencyChangeIds).toEqual(['dependency-a']);
    } finally {
      findings.routes.splice(findings.routes.indexOf(inspect), 1);
    }
  });
});
