import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import type { Event, ModuleContext, Principal, StackResult } from '../../src/contracts';
import { METRIC_EVENT_LIMIT, METRIC_SAMPLE_LIMIT, MetricSample, measureSqlMetrics,
  metricPriorRedStart, metricWindowEvents, metricsWindow } from '../../src/features/metrics';
import { queue } from '../../src/features/queue';
import type { RepoCoordinator } from '../../src/coordinator';
import { FakeStorage } from '../../src/storage/fake';
import { hashCanonical } from '../../src/verdicts/manifest';
import { apiRequest, responseBody } from '../helpers';

const base = Date.parse('2026-10-12T00:00:00.000Z');
let sequence = 0;
function event(at: number, kind: string, relatedIds: string[], payload: Record<string, unknown> = {}): Event {
  return { sequence: ++sequence, timestamp: base + at, kind, actorId: 'fixture', version: sequence, relatedIds, payload };
}

let fixtureRepo = 0;
async function measureEvents(events: Event[], since: number, until: number) {
  const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:metric-fixture-${++fixtureRepo}`));
  return runInDurableObject(stub, (_instance, durable) => {
    const sql = durable.storage.sql;
    for (const item of events) sql.exec(
      'INSERT INTO concord_events(kind, actor_id, timestamp, version, related_ids, payload) VALUES(?, ?, ?, ?, ?, ?)',
      item.kind, item.actorId, item.timestamp, item.version, JSON.stringify(item.relatedIds), JSON.stringify(item.payload));
    return measureSqlMetrics(sql, since, until);
  });
}

describe('repository event metrics', () => {
  it('keeps a deterministic 2000-value reservoir with exact counts and totals', async () => {
    const first = new MetricSample(42); const second = new MetricSample(42);
    for (let i = 0; i < 10_000; i++) { first.add(i); second.add(i); }
    expect(first.sampleSize).toBe(METRIC_SAMPLE_LIMIT);
    expect(first.duration(['test'])).toEqual(second.duration(['test']));
    expect(first.duration(['test'])).toMatchObject({ n: 10_000, totalMs: 49_995_000 });
  });

  it('stops a valid indexed window at 20000 events and reports truncation', async () => {
    const repo = 'metrics_event_cap';
    const created = await worker.fetch(apiRequest('/v1/repos', 'local-owner', {
      method: 'POST', headers: { 'idempotency-key': 'metrics-event-cap' },
      body: JSON.stringify({ name: repo, policyId: 'local-demo', profileId: 'local-demo' }),
    }), env);
    expect(created.status).toBe(201);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repo}`));
    await runInDurableObject(stub, (_instance, durable) => {
      const sql = durable.storage.sql;
      sql.exec('INSERT INTO concord_events(kind, actor_id, timestamp, version, related_ids, payload) VALUES(?, ?, ?, ?, ?, ?)',
        'lease.refused', 'fixture', base + 500, 1, '["after-cap"]', '{"keys":["unit"],"issueNumber":57}');
      for (let batch = 0; batch < METRIC_EVENT_LIMIT / 1000; batch++) {
        sql.exec(`WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM n WHERE x < 999)
          INSERT INTO concord_events(kind, actor_id, timestamp, version, related_ids, payload)
          SELECT 'lease.claimed', 'fixture', ?, 1, json_array('lease', 'c' || (? + x)),
            json_object('changeId', 'c' || (? + x), 'unitKey', 'unit') FROM n`,
        base + 1000 + batch, batch * 1000, batch * 1000);
      }
      sql.exec('INSERT INTO concord_events(kind, actor_id, timestamp, version, related_ids, payload) VALUES(?, ?, ?, ?, ?, ?)',
        'lease.claimed', 'fixture', base + 1800, 1, '["lease","after-cap"]', '{"changeId":"after-cap","unitKey":"unit"}');
      sql.exec('INSERT INTO concord_events(kind, actor_id, timestamp, version, related_ids, payload) VALUES(?, ?, ?, ?, ?, ?)',
        'queue.promotion_applied', 'fixture', base + 2000, 1, '["after-cap"]', '{}');
    });
    const path = `/v1/repos/${repo}/metrics?since=${encodeURIComponent(new Date(base).toISOString())}&until=${encodeURIComponent(new Date(base + 3000).toISOString())}`;
    const response = await worker.fetch(apiRequest(path, 'local-viewer'), env);
    expect(response.status).toBe(200);
    expect((await responseBody(response)).data).toMatchObject({ truncated: true,
      changesLanded: { value: 0 }, leaseClaimsRefused: { value: 1 },
      distinctIssuesWithRefusedClaims: { value: 1 }, refusalWait: { n: 0 } });
    await runInDurableObject(stub, (_instance, durable) => {
      const window = metricWindowEvents(durable.storage.sql, base, base + 3000);
      let count = 0;
      for (const item of window) { expect(item.kind).toBe(count === 0 ? 'lease.refused' : 'lease.claimed'); count++; }
      expect(count).toBe(METRIC_EVENT_LIMIT);
    });
  });

  it('returns all zeros and n=0 for an empty window', async () => {
    const metrics = await measureEvents([], base, base + 100_000);
    expect(metrics.changesLanded).toEqual({ value: 0, n: 0, eventKinds: ['queue.promotion_applied'] });
    for (const [name, value] of Object.entries(metrics)) {
      if (name === 'since' || name === 'until' || name === 'truncated') continue;
      expect(value.n, name).toBe(0);
      expect(Object.values(value).some(item => typeof item === 'number' && !Number.isFinite(item)), name).toBe(false);
      expect(value.eventKinds.length, name).toBeGreaterThan(0);
    }
  });

  it('measures one landed change from claim, publish, approval, enqueue and land events', async () => {
    const events = [
      event(1000, 'lease.claimed', ['l1', 'c1'], { changeId: 'c1' }),
      event(2000, 'change.published', ['c1'], { revision: 1 }),
      event(3000, 'verdict.created', ['v1', 'c1'], { decision: 'approve', revision: 1 }),
      event(4000, 'queue.enqueued', ['c1']),
      event(10_000, 'queue.promotion_applied', ['c1']),
      event(10_000, 'issue.closed', ['1', 'c1'], { closedBy: { changeId: 'c1' } }),
    ];
    const metrics = await measureEvents(events, base, base + 20_000);
    expect(metrics.changesLanded.value).toBe(1);
    expect(metrics.publishToLand).toMatchObject({ medianMs: 8000, p90Ms: 8000, n: 1 });
    expect(metrics.claimToLand).toMatchObject({ medianMs: 9000, n: 1 });
    expect(metrics.reviewWait).toMatchObject({ medianMs: 1000, n: 1 });
    expect(metrics.queueWait).toMatchObject({ medianMs: 6000, n: 1 });
    expect(metrics.revisionsPerLandedChange).toMatchObject({ median: 1, mean: 1, n: 1 });
    expect(metrics.issuesClosedByLand.value).toBe(1);
  });

  it('counts recorded rebases, carried approvals, rework and prior-window origins', async () => {
    const events = [
      event(1000, 'change.published', ['c2'], { revision: 1 }),
      event(2000, 'change.published', ['c2'], { revision: 2 }),
      event(3000, 'queue.auto_rebased', ['c2']),
      event(4000, 'verdict.created', ['v2', 'c2'], { decision: 'approve', carriedFrom: { method: 'patch-id' } }),
      event(5000, 'queue.enqueued', ['c2']),
      event(10_000, 'queue.promotion_applied', ['c2']),
    ];
    const metrics = await measureEvents(events, base + 3000, base + 20_000);
    expect(metrics.changesLanded.value).toBe(1);
    expect(metrics.publishToLand.medianMs).toBe(9000);
    expect(metrics.automaticRebases).toMatchObject({ value: 1, n: 1 });
    expect(metrics.approvalsCarriedByPatchId).toMatchObject({ value: 1, n: 1 });
    expect(metrics.revisionsPerLandedChange).toMatchObject({ median: 2, mean: 2, n: 1 });
    expect(metrics.reworkRevisions.value).toBe(1);
  });

  it('measures refused claims and waits only when a grant is logged', async () => {
    const events = [
      event(1000, 'lease.refused', ['c3'], { issueNumber: 57, keys: ['A'] }),
      event(2000, 'lease.refused', ['c3'], { issueNumber: 57, keys: ['A'] }),
      event(6000, 'lease.claimed', ['l3', 'c3'], { changeId: 'c3', unitKey: 'A' }),
      event(7000, 'lease.refused', ['c4'], { issueNumber: 58, keys: ['B'] }),
    ];
    const metrics = await measureEvents(events, base, base + 20_000);
    expect(metrics.leaseClaimsRefused).toMatchObject({ value: 3, n: 3 });
    expect(metrics.distinctIssuesWithRefusedClaims).toMatchObject({ value: 2, n: 2 });
    expect(metrics.refusalWait).toMatchObject({ medianMs: 4500, p90Ms: 4900, totalMs: 9000, n: 2 });
  });

  it('does not resolve a refused unit with a grant for another unit of the same change', async () => {
    const events = [
      event(1000, 'lease.refused', ['c1'], { keys: ['A'] }),
      event(2000, 'lease.claimed', ['l1', 'c1'], { changeId: 'c1', unitKey: 'B' }),
      event(3000, 'lease.claimed', ['l2', 'c1'], { changeId: 'c1', unitKey: 'A' }),
      event(4000, 'lease.refused', ['c1'], { keys: ['C'] }),
      event(5000, 'lease.claimed', ['l3', 'c1'], { changeId: 'c1', unitKey: 'B' }),
    ];
    expect((await measureEvents(events, base, base + 10_000)).refusalWait).toMatchObject({ totalMs: 2000, n: 1 });
  });

  it('counts failed combined-tree checks and bisect blame without claiming main was red', async () => {
    const events = [
      event(1000, 'queue.result_received', ['c5', 'c6'], { purpose: 'stack', outcome: 'FAIL', bootstrap: false, candidateCount: 2,
        composedTreeOid: 'tree-1', sourceTreeOid: 'tree-1' }),
      event(2000, 'queue.diagnostic_result', ['c5'], { outcome: 'FAIL' }),
      event(3000, 'queue.diagnosis', ['c5', 'c6'], { reason: 'SINGLETON', blame: ['c5'] }),
    ];
    const metrics = await measureEvents(events, base, base + 20_000);
    expect(metrics.combinedTreeCheckFailures).toMatchObject({ value: 1, n: 1 });
    expect(metrics.bisectBlames).toMatchObject({ value: 1, n: 1 });
    expect(metrics.mainRedTime).toMatchObject({ totalMs: 0, n: 0 });
  });

  it('counts only failures with checked combined trees and reports infrastructure failures separately', async () => {
    const events = [
      event(1000, 'queue.result_received', ['c1'], { purpose: 'stack', outcome: 'ENV_ERROR', bootstrap: false, candidateCount: 1,
        composedTreeOid: null, sourceTreeOid: null }),
      event(2000, 'queue.result_received', ['c1'], { purpose: 'stack', outcome: 'TIMEOUT', bootstrap: false, candidateCount: 1,
        composedTreeOid: null, sourceTreeOid: null }),
      event(3000, 'queue.result_received', ['c1'], { purpose: 'stack', outcome: 'MERGE_CONFLICT', bootstrap: false, candidateCount: 1,
        composedTreeOid: null, sourceTreeOid: null }),
      event(4000, 'queue.result_received', ['c1'], { purpose: 'stack', outcome: 'FAIL', bootstrap: false, candidateCount: 0,
        composedTreeOid: 'base-tree', sourceTreeOid: 'base-tree' }),
      event(5000, 'queue.result_received', ['c1'], { purpose: 'stack', outcome: 'FAIL', bootstrap: false, candidateCount: 1,
        composedTreeOid: 'tree-1', sourceTreeOid: null }),
      event(6000, 'queue.result_received', ['c1'], { purpose: 'stack', outcome: 'FAIL', bootstrap: false, candidateCount: 1,
        composedTreeOid: 'tree-1', sourceTreeOid: 'tree-1' }),
      event(7000, 'queue.result_received', ['seed'], { purpose: 'stack', outcome: 'FAIL', bootstrap: true, candidateCount: 1,
        composedTreeOid: 'seed-tree', sourceTreeOid: 'seed-tree' }),
    ];
    const metrics = await measureEvents(events, base, base + 10_000);
    expect(metrics.combinedTreeCheckFailures).toMatchObject({ value: 1, n: 1 });
    expect(metrics.stackInfrastructureFailures).toMatchObject({ value: 2, n: 2 });
  });

  it('measures recovered red time across windows and marks an unresolved red interval', async () => {
    const events = [
      event(1000, 'queue.diagnosis', ['c1'], { reason: 'BASE_RED' }),
      event(2000, 'queue.diagnosis', ['c2'], { reason: 'BASE_RED' }),
      event(6000, 'queue.main_green', [], { jobId: 'baseline-1' }),
      event(8000, 'queue.diagnosis', ['c3'], { reason: 'BASE_RED' }),
    ];
    expect((await measureEvents(events, base + 3000, base + 7000)).mainRedTime).toMatchObject({ totalMs: 3000, n: 1,
      unresolved: false });
    expect((await measureEvents(events, base, base + 10_000)).mainRedTime).toMatchObject({ totalMs: 5000, n: 1,
      unresolved: true });
    expect((await measureEvents(events, base + 8000, base + 10_000)).mainRedTime).toMatchObject({ totalMs: 0, n: 0,
      unresolved: true });
  });

  it('records checked tree evidence and emits recovery after a passing baseline check', async () => {
    const repo = 'metrics_recovery_producer';
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repo}`));
    const principal: Principal = { tenantId: 'local', principalId: 'checker', roles: ['checker'],
      repoIds: '*', expiresAt: Number.MAX_SAFE_INTEGER };
    const oid = '1'.repeat(40);
    const tree = '2'.repeat(40);
    await runInDurableObject<RepoCoordinator, void>(stub, async instance => {
      const internal = instance as unknown as { context(name: 'queue', actor: Principal, repoId: string): ModuleContext };
      const context = internal.context('queue', principal, repo);
      const storage = context.storage as FakeStorage;
      await storage.ensureRepo('metrics-canonical');
      await storage.ensureRepo('metrics-scratch');
      storage.putCommit('metrics-canonical', { oid, treeOid: tree, parents: [] });
      storage.conditionalUpdateRef('metrics-canonical', 'refs/heads/main', null, oid);
      storage.putCommit('metrics-scratch', { oid, treeOid: tree, parents: [] });
      storage.conditionalUpdateRef('metrics-scratch', 'refs/heads/baseline', null, oid);
      const policy = context.trusted.policies['local-demo'];
      const profile = context.trusted.profiles['local-demo'];
      const job = { kind: 'validate-stack', jobId: 'baseline-job', generation: 0,
        inputDigest: 'input', checkerDigest: policy.checkerDigest, toolchainDigest: profile.toolchainDigest,
        oracleDigest: profile.oracleDigest, environmentDigest: profile.environmentDigest,
        policyDigest: policy.digest, unitPolicy: policy, bootstrap: false, baseCheck: true,
        canonicalBaseOid: oid, candidates: [], scratchStorageName: 'metrics-scratch', scratchRef: 'refs/heads/baseline' };
      context.state.put('data', { generation: 0, observedMain: oid, entries: [{ state: 'blocked', canonicalStorageName: 'metrics-canonical' }],
        jobs: [{ job, purpose: 'diagnostic', memberIds: [], admissionIds: [], consumed: false }],
        contests: [], ticket: null, bootstrap: null, activeStackJobId: 'baseline-job',
        diagnosis: { original: [], suspects: [], excluded: [], phase: 'done', left: [], right: [], leftGreen: false,
          jobs: 1, reason: 'INTERACTION', blame: [], survivors: [] }, diagnosticResults: [],
        finalCanonicalOid: null, coalesceUntil: null, blockedReason: null });
      const preimage = { kind: 'validate-stack' as const, jobId: job.jobId, attempt: 1, fence: 1,
        inputDigest: job.inputDigest, checkerDigest: job.checkerDigest, toolchainDigest: job.toolchainDigest,
        oracleDigest: job.oracleDigest, environmentDigest: job.environmentDigest, sourceTreeOid: tree,
        durationMs: 1, log: '', outcome: 'PASS' as const, composedOid: oid, composedTreeOid: tree,
        gateResults: policy.acceptance.gates.map(gate => ({ gateId: gate.id, outcome: gate.requiredOutcome })),
        score: null, bootstrap: false as const, canonicalBaseOid: oid };
      const result = { ...preimage, resultDigest: hashCanonical(preimage) } as StackResult;
      expect(context.call('queue.onResult', result).status).toBe('eligible');
      const recorded = context.sql.exec<{ payload: string }>("SELECT payload FROM concord_events WHERE kind = 'queue.result_received'").toArray();
      expect(JSON.parse(recorded[0].payload)).toMatchObject({ bootstrap: false, candidateCount: 0,
        composedTreeOid: tree, sourceTreeOid: tree });
      await queue.onAlarm(context);
      expect(context.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM concord_events WHERE kind = 'queue.main_green'").toArray()[0].count).toBe(1);
    });
  });

  it('validates the bounded window and serves cached metrics to a repo reader', async () => {
    expect(() => metricsWindow(new URLSearchParams({ since: '2026-10-01T00:00:00.000Z', until: '2026-11-02T00:00:00.000Z' }))).toThrow();
    const repo = 'metrics_case';
    const created = await worker.fetch(apiRequest('/v1/repos', 'local-owner', {
      method: 'POST', headers: { 'idempotency-key': 'metrics-repo' },
      body: JSON.stringify({ name: repo, policyId: 'local-demo', profileId: 'local-demo' }),
    }), env);
    expect(created.status).toBe(201);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repo}`));
    await runInDurableObject(stub, (_instance, durable) => {
      durable.storage.sql.exec('INSERT INTO concord_events(kind, actor_id, timestamp, version, related_ids, payload) VALUES(?, ?, ?, ?, ?, ?)',
        'queue.promotion_applied', 'fixture', base + 1000, 1, '["c1"]', '{}');
    });
    const path = `/v1/repos/${repo}/metrics?since=2026-10-12T00%3A00%3A00.000Z&until=2026-10-13T00%3A00%3A00.000Z`;
    const first = await worker.fetch(apiRequest(path, 'local-viewer'), env);
    expect(first.status).toBe(200);
    expect((await responseBody(first)).data.changesLanded.value).toBe(1);
    await runInDurableObject(stub, (_instance, durable) => {
      durable.storage.sql.exec('INSERT INTO concord_events(kind, actor_id, timestamp, version, related_ids, payload) VALUES(?, ?, ?, ?, ?, ?)',
        'queue.promotion_applied', 'fixture', base + 2000, 2, '["c2"]', '{}');
    });
    expect((await responseBody(await worker.fetch(apiRequest(path, 'local-viewer'), env))).data.changesLanded.value).toBe(1);
    expect((await worker.fetch(apiRequest(`/v1/repos/${repo}/metrics?since=bad&until=bad`, 'local-viewer'), env)).status).toBe(400);
  });

  it('streams the indexed window without unrelated prior events and bounds cached windows', async () => {
    const repo = 'metrics_paged';
    const created = await worker.fetch(apiRequest('/v1/repos', 'local-owner', {
      method: 'POST', headers: { 'idempotency-key': 'metrics-paged-repo' },
      body: JSON.stringify({ name: repo, policyId: 'local-demo', profileId: 'local-demo' }),
    }), env);
    expect(created.status).toBe(201);
    const stub = env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repo}`));
    await runInDurableObject(stub, (_instance, durable) => {
      const sql = durable.storage.sql;
      const insert = (kind: string, timestamp: number, relatedIds: string[], payload: Record<string, unknown> = {}) =>
        sql.exec('INSERT INTO concord_events(kind, actor_id, timestamp, version, related_ids, payload) VALUES(?, ?, ?, ?, ?, ?)',
          kind, 'fixture', timestamp, 1, JSON.stringify(relatedIds), JSON.stringify(payload));
      for (let i = 0; i < 260; i++) insert('unrelated', base - 100_000 + i, ['other']);
      insert('lease.claimed', base - 9000, ['lease', 'landed'], { changeId: 'landed' });
      insert('change.published', base - 8000, ['landed'], { revision: 1 });
      insert('verdict.created', base - 7000, ['verdict', 'landed'], { decision: 'approve' });
      insert('queue.enqueued', base - 6000, ['landed']);
      insert('queue.diagnosis', base - 5000, [], { reason: 'BASE_RED' });
      for (let i = 0; i < 260; i++) insert('unrelated', base + 1000, ['other']);
      insert('queue.main_green', base + 5000, []);
      insert('queue.promotion_applied', base + 10_000, ['landed']);
      insert('queue.promotion_applied', base + 21_000, ['late']);
      let reads = 0;
      const boundedSql = { exec: (query: string, ...args: (string | number)[]) => {
        reads++;
        expect(query).toContain('timestamp >= ? AND timestamp < ?');
        expect(query).toContain('LIMIT ?');
        expect(args.at(-1)).toBe(METRIC_EVENT_LIMIT);
        return sql.exec(query, ...args);
      } } as unknown as SqlStorage;
      const window = Array.from(metricWindowEvents(boundedSql, base, base + 20_000));
      expect(window).toHaveLength(262);
      expect(window.every(item => item.timestamp >= base && item.timestamp < base + 20_000)).toBe(true);
      expect(reads).toBe(1);
      expect(metricPriorRedStart(sql, base)).toBe(base - 5000);
    });
    const path = (since: number) => `/v1/repos/${repo}/metrics?since=${encodeURIComponent(new Date(since).toISOString())}&until=${encodeURIComponent(new Date(base + 20_000).toISOString())}`;
    const response = await worker.fetch(apiRequest(path(base), 'local-viewer'), env);
    expect(response.status).toBe(200);
    expect((await responseBody(response)).data).toMatchObject({
      changesLanded: { value: 1 }, publishToLand: { medianMs: 18_000 }, claimToLand: { medianMs: 19_000 },
      reviewWait: { medianMs: 1000 }, queueWait: { medianMs: 16_000 }, mainRedTime: { totalMs: 5000, unresolved: false },
    });
    for (let i = 1; i <= 18; i++) {
      expect((await worker.fetch(apiRequest(path(base + i), 'local-viewer'), env)).status).toBe(200);
    }
    await runInDurableObject<RepoCoordinator, void>(stub, instance => {
      const cache = (instance as unknown as { metricsCache: Map<string, unknown> }).metricsCache;
      expect(cache.size).toBe(16);
      expect(cache.has(`${new Date(base).toISOString()}/${new Date(base + 20_000).toISOString()}`)).toBe(false);
    });
  });
});
