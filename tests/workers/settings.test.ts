import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import type { ModuleContext, Principal } from '../../src/contracts';
import type { RepoCoordinator } from '../../src/coordinator';
import { protectionFor, repoSettings } from '../../src/features/settings';
import { humanApprovalStatus, verdicts } from '../../src/features/verdicts';
import { repos } from '../../src/features/repos';
import { localFixtureConfig, sqlState } from '../../src/state';
import { manifestDigest } from '../../src/verdicts/manifest';
import type { ReviewManifest } from '../../src/contracts';
import { apiRequest, mutation, responseBody } from '../helpers';

const repo = 'settings_protection';
const path = `/v1/repos/${repo}/settings`;
const request = (token: string, method = 'GET', body?: unknown) => apiRequest(path, token, {
  method, headers: method === 'GET' ? undefined : { 'idempotency-key': crypto.randomUUID() },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const fileDigest = async (text: string): Promise<`sha256:${string}`> => {
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return `sha256:${Array.from(hashed, byte => byte.toString(16).padStart(2, '0')).join('')}`;
};

describe('repository path settings', () => {
  it('requires a current owner decision for an inspected protected file', async () => {
    const id = 'settings_approval';
    const changeId = 'change';
    const head = 'a'.repeat(40);
    const config = localFixtureConfig('local');
    const files: Record<string, { before: string; after: string; beforeMode: string; afterMode: string }> = {
      'AGENTS.md': { before: 'rule: old\n', after: 'rule: new\n', beforeMode: '100644', afterMode: '100644' },
      'docs/long.md': {
        before: Array.from({ length: 40 }, (_value, index) => `line ${index}`).join('\n'),
        after: Array.from({ length: 40 }, (_value, index) => index === 1 ? 'early change' : index === 38 ? 'late change' : `line ${index}`).join('\n'),
        beforeMode: '100644', afterMode: '100644' },
      'docs/mode.md': { before: 'mode text\n', after: 'mode text\n', beforeMode: '100644', afterMode: '100755' },
    };
    const unitKeys = Object.keys(files).map(file => `file:${file}`);
    for (const [file, unitKey] of Object.entries(files).map(([file]) => [file, `file:${file}`] as const)) {
      config.policies['local-demo'].units[unitKey] = { canonicalKey: unitKey, file, resources: [], dependencyKeys: [] };
    }
    const changedUnits = [];
    for (const [file, entry] of Object.entries(files)) {
      changedUnits.push({ unitKey: `file:${file}`, beforePath: file, afterPath: file, beforeMode: entry.beforeMode,
        afterMode: entry.afterMode, beforeDigest: await fileDigest(entry.before), afterDigest: await fileDigest(entry.after) });
    }
    const manifest: ReviewManifest = { changedUnits,
      policyVersion: config.policies['local-demo'].version, policyDigest: config.policies['local-demo'].digest,
      checkerDigest: config.policies['local-demo'].checkerDigest, oracleDigest: config.profiles['local-demo'].oracleDigest,
      toolchainDigest: config.profiles['local-demo'].toolchainDigest, coverage: 'complete', dependencyScope: [] };
    const digest = manifestDigest(manifest, config.policies['local-demo'], unitKeys);
    const priorConfig = (env as Env).TRUSTED_CONFIG;
    const priorView = repos.changeView;
    (env as Env).TRUSTED_CONFIG = JSON.stringify(config);
    repos.changeView = context => ({ status: 'eligible', version: context.version(), evidenceIds: [changeId], value: {
      authorId: 'agent-a', headOid: head, revision: 1, status: 'ready', unitKeys, frozen: false,
    } });
    try {
      const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${id}`));
      await runInDurableObject<RepoCoordinator, void>(stub, async instance => {
        const principal: Principal = { tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
        const context = (instance as unknown as { context(name: 'verdicts', principal: Principal, repoId: string): ModuleContext }).context('verdicts', principal, id);
        const store = sqlState(context.sql);
        store.put('repo:version', 1);
        store.put('module:settings:record', { version: 1, protectedPaths: [{ pattern: '**/*.md', level: 'human-approval' }] });
        context.state.put(`inspection:${changeId}`, { changeId, revision: 1,
          candidate: { changeId, revision: 1, baseOid: '0'.repeat(40), headOid: head, storageName: 'candidate', ref: 'refs/heads/work' },
          canonicalStorageName: 'canonical', policyId: 'local-demo', profileId: 'local-demo', reviewManifest: manifest,
          reviewManifestDigest: digest, outcome: 'PASS' });
        expect(humanApprovalStatus(context, changeId, 1).awaitingHumanApproval).toEqual(['**/*.md']);
        const diffPath = `/v1/repos/${id}/changes/${changeId}/human-approval/diff`;
        const diffRoute = verdicts.routes.find(route => route.method === 'GET' && route.pattern.test(diffPath))!;
        const storage = (readFile: ModuleContext['storage']['readFile']) =>
          ({ ...context, storage: { ...context.storage, readFile } as ModuleContext['storage'] });
        const previewContext = storage(async (_name, oid, file) =>
          new TextEncoder().encode(oid === head ? files[file].after : files[file].before));
        const preview = await diffRoute.handle(previewContext, new Request(`https://concord.test${diffPath}`),
          diffPath.match(diffRoute.pattern)!, null);
        const items = (await responseBody(preview)).data.items;
        expect(items).toHaveLength(3);
        expect(items[0]).toMatchObject({ truncated: false,
          summary: expect.stringContaining('- rule: old\n+ rule: new') });
        expect(items[1].truncated).toBe(true);
        expect(items[1].summary).toContain('early change');
        expect(items[1].summary).not.toContain('late change');
        expect(items[2]).toMatchObject({ beforeMode: '100644', afterMode: '100755', truncated: false,
          summary: expect.stringContaining('mode 100644 → 100755') });
        const staleContext = storage(async (_name, oid, file) =>
          new TextEncoder().encode(oid === head && file === 'AGENTS.md' ? 'tampered\n' :
            oid === head ? files[file].after : files[file].before));
        const stalePreview = await diffRoute.handle(staleContext, new Request(`https://concord.test${diffPath}`),
          diffPath.match(diffRoute.pattern)!, null);
        const staleItems = (await responseBody(stalePreview)).data.items;
        expect(staleItems[0].truncated).toBe(true);
        expect(staleItems[0].summary).toContain('do not match the inspected digest');
        expect(staleItems[1].truncated).toBe(true);
        expect(staleItems[1].summary).toContain('early change');
      });
      const route = `/v1/repos/${id}/changes/${changeId}/human-approval`;
      const body = { expectedVersion: 1, revision: 1, reviewManifestDigest: digest, evidenceDigest: `sha256:${'3'.repeat(64)}`, decision: 'approve' };
      const denied = await worker.fetch(mutation(route, body, crypto.randomUUID(), 'local-agent-a'), env);
      expect(denied.status).toBe(403);
      const approved = await worker.fetch(mutation(route, body, crypto.randomUUID(), 'local-owner'), env);
      expect(approved.status).toBe(201);
      const approvedBody = await responseBody(approved);
      expect(approvedBody.data.evidenceDigest).toBe(body.evidenceDigest);
      const rejectedDigest = `sha256:${'4'.repeat(64)}`;
      const rejected = await worker.fetch(mutation(route, { ...body, expectedVersion: approvedBody.version,
        evidenceDigest: rejectedDigest, decision: 'reject' }, crypto.randomUUID(), 'local-owner'), env);
      expect(rejected.status).toBe(201);
      const history = await worker.fetch(apiRequest(route, 'local-owner'), env);
      expect((await responseBody(history)).data.items.map((item: { evidenceDigest: string; decision: string }) =>
        [item.decision, item.evidenceDigest])).toEqual([['approve', body.evidenceDigest], ['reject', rejectedDigest]]);
      await runInDurableObject<RepoCoordinator, void>(stub, instance => {
        const principal: Principal = { tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
        const context = (instance as unknown as { context(name: 'verdicts', principal: Principal, repoId: string): ModuleContext }).context('verdicts', principal, id);
        context.appendEvent('verdict.human_approval', [changeId], { decision: 'approve', evidenceDigest: rejectedDigest }, context.nextVersion());
      });
      const viewerEvents = await worker.fetch(apiRequest(`/v1/repos/${id}/events`, 'local-viewer'), env);
      expect(viewerEvents.status).toBe(200);
      const approvalEvents = (await responseBody(viewerEvents)).data.items.filter((item: { kind: string }) => item.kind === 'verdict.human_approval');
      expect(approvalEvents).toHaveLength(3);
      expect(approvalEvents.every((item: { payload: Record<string, unknown> }) => !('evidenceDigest' in item.payload))).toBe(true);
      expect(JSON.stringify(approvalEvents)).not.toContain(rejectedDigest);
      const ownerEvents = await worker.fetch(apiRequest(`/v1/repos/${id}/events`, 'local-owner'), env);
      expect(JSON.stringify((await responseBody(ownerEvents)).data.items)).toContain(rejectedDigest);
      expect((await worker.fetch(apiRequest(route, 'local-viewer'), env)).status).toBe(403);
      await runInDurableObject<RepoCoordinator, void>(stub, instance => {
        const principal: Principal = { tenantId: 'local', principalId: 'owner', roles: ['owner'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
        const context = (instance as unknown as { context(name: 'verdicts', principal: Principal, repoId: string): ModuleContext }).context('verdicts', principal, id);
        expect(humanApprovalStatus(context, changeId, 1).awaitingHumanApproval).toEqual(['**/*.md']);
        const store = sqlState(context.sql);
        store.put('module:settings:record', { version: 3, protectedPaths: [{ pattern: 'AGENTS.md', level: 'human-approval' }, { pattern: '**/*.md', level: 'human-approval' }] });
        expect(humanApprovalStatus(context, changeId, 1).awaitingHumanApproval).toEqual(['**/*.md', 'AGENTS.md']);
        store.put('module:settings:record', { version: 4, protectedPaths: [{ pattern: 'AGENTS.md', level: 'agents' }] });
        expect(humanApprovalStatus(context, changeId, 1).awaitingHumanApproval).toEqual([]);
      });
    } finally { (env as Env).TRUSTED_CONFIG = priorConfig; repos.changeView = priorView; }
  });
  it('versions owner edits, exposes rules to readers and applies specific globs', async () => {
    const initial = await worker.fetch(request('local-viewer'), env);
    expect((await responseBody(initial)).data).toEqual({ version: 0, protectedPaths: [] });
    const denied = await worker.fetch(request('local-agent-a', 'PUT', { expectedVersion: 0, protectedPaths: [] }), env);
    expect(denied.status).toBe(403);
    const rules = [
      { pattern: 'docs/**', level: 'human-approval', note: 'review docs' },
      { pattern: 'docs/private/', level: 'human-only' },
      { pattern: 'docs/private/README.md', level: 'agents' },
      { pattern: 'AGENTS.md', level: 'human-only' },
    ];
    const saved = await worker.fetch(request('local-owner', 'PUT', { expectedVersion: 0, protectedPaths: rules }), env);
    expect(saved.status).toBe(200);
    const data = (await responseBody(saved)).data;
    expect(data.version).toBeGreaterThan(0);
    expect(data.protectedPaths).toEqual(rules);
    const stale = await worker.fetch(request('local-owner', 'PUT', { expectedVersion: 0, protectedPaths: [] }), env);
    expect((await responseBody(stale)).error.code).toBe('STALE_VERSION');
    const read = await worker.fetch(request('local-viewer'), env);
    expect((await responseBody(read)).data).toEqual(data);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repo}`));
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const principal: Principal = { tenantId: 'local', principalId: 'viewer', roles: ['viewer'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
      const context = (instance as unknown as { context(name: 'settings', principal: Principal, repoId: string): ModuleContext }).context('settings', principal, repo);
      expect(repoSettings(context).protectedPaths).toEqual(rules);
      expect(protectionFor(context, 'docs/readme.md')?.level).toBe('human-approval');
      expect(protectionFor(context, 'docs/private/secret.md')?.level).toBe('human-only');
      expect(protectionFor(context, 'docs/private/README.md')?.level).toBe('agents');
      expect(protectionFor(context, 'src/free.ts')).toBeNull();
    });
    const cleared = await worker.fetch(request('local-owner', 'PUT', { expectedVersion: data.version, protectedPaths: [] }), env);
    expect((await responseBody(cleared)).data.protectedPaths).toEqual([]);
  });
  it('prefers an exact path over overlapping wildcard rules in either order', async () => {
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repo}`));
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const principal: Principal = { tenantId: 'local', principalId: 'viewer', roles: ['viewer'], repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
      const context = (instance as unknown as { context(name: 'settings', principal: Principal, repoId: string): ModuleContext }).context('settings', principal, repo);
      const store = sqlState(context.sql);
      store.put('module:settings:record', { version: 10, protectedPaths: [
        { pattern: '**/AGENTS.md', level: 'agents' },
        { pattern: 'AGENTS.md', level: 'human-only' },
      ] });
      expect(protectionFor(context, 'AGENTS.md')?.level).toBe('human-only');
      expect(protectionFor(context, 'docs/AGENTS.md')?.level).toBe('agents');
      store.put('module:settings:record', { version: 11, protectedPaths: [
        { pattern: 'AGENTS.md', level: 'human-only' },
        { pattern: '**/AGENTS.md', level: 'agents' },
      ] });
      expect(protectionFor(context, 'AGENTS.md')?.level).toBe('human-only');
    });
  });
});
