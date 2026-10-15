import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { RepoCoordinator } from '../../src/coordinator';
import type { ModuleContext, Repo } from '../../src/contracts';
import { repos } from '../../src/features/repos';
import { FakeStorage } from '../../src/storage/fake';
import worker from '../../src/worker';
import { mutation, responseBody } from '../helpers';

const fetchApi = (request: Request) => worker.fetch(request, env);

describe('repo catalog read cache', () => {
  it('reuses fresh records for GETs, refreshes after 60 seconds, and still fetches for mutations', async () => {
    const name = `catalog_cache_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const created = await fetchApi(mutation('/v1/repos', { name, policyId: 'local-demo', profileId: 'local-demo' }, `${name}-create`));
    expect(created.status).toBe(201);
    const repo = (await responseBody(created)).data as Repo;
    const changeResponse = await fetchApi(mutation(`/v1/repos/${name}/changes`, {
      intentKey: 'catalog-cache', intentText: 'cache test', baseOid: null,
      branch: 'refs/heads/catalog-cache', unitKeys: [], dependencyChangeIds: [],
    }, `${name}-change`));
    expect(changeResponse.status).toBe(201);
    const change = (await responseBody(changeResponse)).data;

    const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${name}`));
    await runInDurableObject<RepoCoordinator, void>(coordinator, async instance => {
      const context = (instance as unknown as {
        context(name: 'repos', principal: object, repoId: string): ModuleContext;
      }).context('repos', {
        tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER,
      }, name);
      let now = context.now() + 61_000;
      (context as unknown as { now: () => number }).now = () => now;

      const binding = context.env.TENANT_CATALOG;
      let catalogFetches = 0;
      (context.env as unknown as { TENANT_CATALOG: unknown }).TENANT_CATALOG = {
        idFromName: binding.idFromName.bind(binding),
        get: (id: DurableObjectId) => {
          const stub = binding.get(id);
          return { fetch: (request: Request) => {
            if (new URL(request.url).pathname === '/v1/repos') catalogFetches++;
            return stub.fetch(request);
          } };
        },
      };

      let repoWrites = 0;
      const originalPut = context.state.put;
      context.state.put = (key, value) => {
        if (key === 'repo') repoWrites++;
        originalPut(key, value);
      };

      try {
        const storage = context.storage as FakeStorage;
        storage.putCommit(repo.canonicalStorageName, { oid: 'a'.repeat(40), treeOid: 'b'.repeat(40), parents: [] });
        storage.conditionalUpdateRef(repo.canonicalStorageName, 'refs/heads/main', null, 'a'.repeat(40));
        const route = (pattern: RegExp) => repos.routes.find(item => item.method === 'GET' && item.pattern.source === pattern.source)!;
        const detailRoute = route(/^\/v1\/repos\/([^/]+)\/changes\/([^/]+)$/);
        const treeRoute = route(/^\/v1\/repos\/([^/]+)\/tree$/);
        const detailPath = `/v1/repos/${name}/changes/${change.changeId}`;
        const treePath = `/v1/repos/${name}/tree`;
        const detailMatch = detailPath.match(detailRoute.pattern)!;
        const treeMatch = treePath.match(treeRoute.pattern)!;
        const detailRequest = new Request(`https://concord.test${detailPath}`);
        const treeRequest = new Request(`https://concord.test${treePath}`);

        await detailRoute.handle(context, detailRequest, detailMatch, {});
        const writesAfterFetch = repoWrites;
        await treeRoute.handle(context, treeRequest, treeMatch, {});
        expect(catalogFetches).toBe(1);
        expect(repoWrites).toBe(writesAfterFetch);

        await detailRoute.handle(context, detailRequest, detailMatch, {});
        expect(catalogFetches).toBe(1);
        now += 61_000;
        await treeRoute.handle(context, treeRequest, treeMatch, {});
        expect(catalogFetches).toBe(2);
        expect(repoWrites).toBe(writesAfterFetch);

        const tokenPath = `/v1/repos/${name}/git-token`;
        const tokenRoute = repos.routes.find(item => item.method === 'POST' && item.pattern.test(tokenPath))!;
        const tokenMatch = tokenPath.match(tokenRoute.pattern)!;
        const tokenRequest = new Request(`https://concord.test${tokenPath}`, { method: 'POST' });
        const tokenBody = { storageName: repo.canonicalStorageName, scope: 'read', ttlSeconds: 60 };
        await tokenRoute.handle(context, tokenRequest, tokenMatch, tokenBody);
        const afterFirstMutation = catalogFetches;
        await tokenRoute.handle(context, tokenRequest, tokenMatch, tokenBody);
        expect(afterFirstMutation).toBe(3);
        expect(catalogFetches).toBe(4);
      } finally {
        context.state.put = originalPut;
        (context.env as unknown as { TENANT_CATALOG: unknown }).TENANT_CATALOG = binding;
      }
    });
  });

  it('does not cache a catalog record when fake canonical reconciliation fails', async () => {
    const name = `catalog_missing_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const created = await fetchApi(mutation('/v1/repos', { name, policyId: 'local-demo', profileId: 'local-demo' }, `${name}-create`));
    expect(created.status).toBe(201);
    const repo = (await responseBody(created)).data as Repo;
    const coordinator = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${name}`));

    await runInDurableObject<RepoCoordinator, void>(coordinator, async instance => {
      const context = (instance as unknown as {
        context(name: 'repos', principal: object, repoId: string): ModuleContext;
      }).context('repos', {
        tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER,
      }, name);
      let now = context.now() + 61_000;
      (context as unknown as { now: () => number }).now = () => now;
      context.state.put('fake-canonical-materialized', true);
      context.state.delete(`fake:repo:${repo.canonicalStorageName}`);

      const binding = context.env.TENANT_CATALOG;
      let catalogFetches = 0;
      (context.env as unknown as { TENANT_CATALOG: unknown }).TENANT_CATALOG = {
        idFromName: binding.idFromName.bind(binding),
        get: (id: DurableObjectId) => {
          const stub = binding.get(id);
          return { fetch: (request: Request) => {
            if (new URL(request.url).pathname === '/v1/repos') catalogFetches++;
            return stub.fetch(request);
          } };
        },
      };

      try {
        const detailRoute = repos.routes.find(item => item.method === 'GET' && item.pattern.source === /^\/v1\/repos\/([^/]+)$/.source)!;
        const path = `/v1/repos/${name}`;
        const match = path.match(detailRoute.pattern)!;
        const request = new Request(`https://concord.test${path}`);
        await expect(detailRoute.handle(context, request, match, {})).rejects.toMatchObject({ code: 'PROVIDER_REPO_MISSING' });
        now += 1_000;
        await expect(detailRoute.handle(context, request, match, {})).rejects.toMatchObject({ code: 'PROVIDER_REPO_MISSING' });
        expect(catalogFetches).toBe(2);
      } finally {
        (context.env as unknown as { TENANT_CATALOG: unknown }).TENANT_CATALOG = binding;
      }
    });
  });
});
