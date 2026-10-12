import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import type { Event } from '../../src/contracts';
import { measureEvents, metricsWindow } from '../../src/features/metrics';
import { apiRequest, responseBody } from '../helpers';

const base = Date.parse('2026-10-12T00:00:00.000Z');
let sequence = 0;
function event(at: number, kind: string, relatedIds: string[], payload: Record<string, unknown> = {}): Event {
  return { sequence: ++sequence, timestamp: base + at, kind, actorId: 'fixture', version: sequence, relatedIds, payload };
}

describe('repository event metrics', () => {
  it('returns all zeros and n=0 for an empty window', () => {
    const metrics = measureEvents([], base, base + 100_000);
    expect(metrics.changesLanded).toEqual({ value: 0, n: 0, eventKinds: ['queue.promotion_applied'] });
    for (const [name, value] of Object.entries(metrics)) {
      if (name === 'since' || name === 'until') continue;
      expect(value.n, name).toBe(0);
      expect(Object.values(value).some(item => typeof item === 'number' && !Number.isFinite(item)), name).toBe(false);
      expect(value.eventKinds.length, name).toBeGreaterThan(0);
    }
  });

  it('measures one landed change from claim, publish, approval, enqueue and land events', () => {
    const events = [
      event(1000, 'lease.claimed', ['l1', 'c1'], { changeId: 'c1' }),
      event(2000, 'change.published', ['c1'], { revision: 1 }),
      event(3000, 'verdict.created', ['v1', 'c1'], { decision: 'approve', revision: 1 }),
      event(4000, 'queue.enqueued', ['c1']),
      event(10_000, 'queue.promotion_applied', ['c1']),
      event(10_000, 'issue.closed', ['1', 'c1'], { closedBy: { changeId: 'c1' } }),
    ];
    const metrics = measureEvents(events, base, base + 20_000);
    expect(metrics.changesLanded.value).toBe(1);
    expect(metrics.publishToLand).toMatchObject({ medianMs: 8000, p90Ms: 8000, n: 1 });
    expect(metrics.claimToLand).toMatchObject({ medianMs: 9000, n: 1 });
    expect(metrics.reviewWait).toMatchObject({ medianMs: 1000, n: 1 });
    expect(metrics.queueWait).toMatchObject({ medianMs: 6000, n: 1 });
    expect(metrics.revisionsPerLandedChange).toMatchObject({ median: 1, mean: 1, n: 1 });
    expect(metrics.issuesClosedByLand.value).toBe(1);
  });

  it('counts recorded rebases, carried approvals, rework and prior-window origins', () => {
    const events = [
      event(1000, 'change.published', ['c2'], { revision: 1 }),
      event(2000, 'change.published', ['c2'], { revision: 2 }),
      event(3000, 'queue.auto_rebased', ['c2']),
      event(4000, 'verdict.created', ['v2', 'c2'], { decision: 'approve', carriedFrom: { method: 'patch-id' } }),
      event(5000, 'queue.enqueued', ['c2']),
      event(10_000, 'queue.promotion_applied', ['c2']),
    ];
    const metrics = measureEvents(events, base + 3000, base + 20_000);
    expect(metrics.changesLanded.value).toBe(1);
    expect(metrics.publishToLand.medianMs).toBe(9000);
    expect(metrics.automaticRebases).toMatchObject({ value: 1, n: 1 });
    expect(metrics.approvalsCarriedByPatchId).toMatchObject({ value: 1, n: 1 });
    expect(metrics.revisionsPerLandedChange).toMatchObject({ median: 2, mean: 2, n: 1 });
    expect(metrics.reworkRevisions.value).toBe(1);
  });

  it('measures refused claims and waits only when a grant is logged', () => {
    const events = [
      event(1000, 'lease.refused', ['c3'], { issueNumber: 57 }),
      event(2000, 'lease.refused', ['c3'], { issueNumber: 57 }),
      event(6000, 'lease.claimed', ['l3', 'c3'], { changeId: 'c3' }),
      event(7000, 'lease.refused', ['c4'], { issueNumber: 58 }),
    ];
    const metrics = measureEvents(events, base, base + 20_000);
    expect(metrics.leaseClaimsRefused).toMatchObject({ value: 3, n: 3 });
    expect(metrics.distinctIssuesWithRefusedClaims).toMatchObject({ value: 2, n: 2 });
    expect(metrics.refusalWait).toMatchObject({ medianMs: 4500, p90Ms: 4900, totalMs: 9000, n: 2 });
  });

  it('counts failed combined-tree checks and bisect blame without claiming main was red', () => {
    const events = [
      event(1000, 'queue.result_received', ['c5', 'c6'], { purpose: 'stack', outcome: 'FAIL' }),
      event(2000, 'queue.diagnostic_result', ['c5'], { outcome: 'FAIL' }),
      event(3000, 'queue.diagnosis', ['c5', 'c6'], { reason: 'SINGLETON', blame: ['c5'] }),
    ];
    const metrics = measureEvents(events, base, base + 20_000);
    expect(metrics.combinedTreeCheckFailures).toMatchObject({ value: 1, n: 1 });
    expect(metrics.bisectBlames).toMatchObject({ value: 1, n: 1 });
    expect(metrics.mainRedTime).toMatchObject({ totalMs: 0, n: 0 });
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
});
