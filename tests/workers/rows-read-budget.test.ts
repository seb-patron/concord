import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/worker';
import type { Change } from '../../src/contracts';
import { sqlState } from '../../src/state';
import { apiRequest, mutation, responseBody } from '../helpers';

const fetchApi = (request: Request) => worker.fetch(request, env);
const digest = `sha256:${'0'.repeat(64)}`;
const HOUR = 60 * 60 * 1000;
const measured: Array<[string, number]> = [];

type CountedSql = SqlStorage & { budgetCursors?: Array<{ rowsRead: number }> };

function stubFor(repo: string) {
  return env.REPO_COORDINATOR.get(env.REPO_COORDINATOR.idFromName(`repo:local:${repo}`));
}

// Count rows read by every statement the DO runs while one request is served.
async function instrument(repo: string): Promise<void> {
  await runInDurableObject(stubFor(repo), (_instance, state) => {
    const prototype = Object.getPrototypeOf(state.storage.sql) as { exec: SqlStorage['exec']; budgetPatched?: boolean };
    if (prototype.budgetPatched) return;
    const exec = prototype.exec;
    prototype.exec = function (this: CountedSql, query: string, ...bindings: unknown[]) {
      const cursor = exec.call(this, query, ...bindings);
      (globalThis as { budgetCursors?: Array<{ rowsRead: number }> }).budgetCursors?.push(cursor);
      return cursor;
    } as SqlStorage['exec'];
    prototype.budgetPatched = true;
  });
}

async function rowsFor(label: string, run: () => Promise<Response>): Promise<{ response: Response; rows: number }> {
  const cursors: Array<{ rowsRead: number }> = [];
  (globalThis as { budgetCursors?: Array<{ rowsRead: number }> }).budgetCursors = cursors;
  try {
    const response = await run();
    const body = await response.clone().arrayBuffer();
    void body;
    const rows = cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
    measured.push([label, rows]);
    console.log(`rows-read ${label}: ${rows}`);
    return { response, rows };
  } finally {
    (globalThis as { budgetCursors?: Array<{ rowsRead: number }> }).budgetCursors = undefined;
  }
}

function change(repo: string, index: number, status: Change['status']): Change {
  return {
    changeId: `budget-change-${index}`, repoId: repo, authorId: 'agent-a', intentKey: `budget-${index}`,
    intentText: `Budget change ${index}`, candidateStorageName: `candidate-${index}`, branch: 'main',
    baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40), revision: 1, unitKeys: [], dependencyChangeIds: [],
    status, version: 1,
  };
}

async function seed(repo: string, terminalLeases: number) {
  const created = await fetchApi(mutation('/v1/repos', { name: repo, policyId: 'local-demo', profileId: 'local-demo' }, `create-${repo}`));
  expect(created.status).toBe(201);
  expect((await fetchApi(apiRequest(`/v1/repos/${repo}`))).status).toBe(200);
  const now = Date.now();
  return runInDurableObject(stubFor(repo), (_instance, state) => {
    const sql = state.storage.sql;
    const store = sqlState(sql);
    for (let index = 0; index < terminalLeases; index++) {
      sql.exec(`INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at)
        VALUES(?, ?, 'agent-b', ?, 'old work', 1, ?, ?, ?, ?, ?)`, `old-${String(index).padStart(6, '0')}`, `file:old/${index}.c`,
        `budget-change-${index % 290}`, now - 2 * HOUR, index % 2 ? 'released' : 'expired', index + 1, now - 3 * HOUR + index, now - HOUR);
    }
    for (let index = 0; index < 5; index++) {
      sql.exec(`INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at)
        VALUES(?, ?, ?, 'budget-change-295', 'live work', 7, ?, 'active', ?, ?, ?)`, `live-${index}`, `file:live/${index}.c`, index ? 'agent-a' : 'owner',
        now + 10 * 60_000, terminalLeases + index + 1, now - 60_000 + index, now - 60_000);
    }
    const changes = Array.from({ length: 300 }, (_, index) => change(repo, index, index < 290 ? (index % 2 ? 'merged' : 'closed') : 'ready'));
    store.put('module:repos:changes', changes);
    for (const item of changes) store.put(`module:repos:change:${item.changeId}`, item);
    const jobIds = Array.from({ length: 500 }, (_, index) => `budget-job-${index}`);
    for (const [index, jobId] of jobIds.entries()) {
      const claimed = index >= 498;
      store.put(`module:runners:job:${jobId}`, { job: {
        kind: 'inspect-candidate', jobId, repoId: repo, inputDigest: digest, generation: 1, profileDigest: digest,
        policyId: 'local-demo', policyDigest: digest, expectedRefs: {}, storageRemotes: {}, checkerId: 'local-demo',
        checkerDigest: digest, oracleDigest: digest, toolchainDigest: digest, environmentDigest: digest, timeoutMs: 120_000,
        maxOutputBytes: 16_384, state: claimed ? 'claimed' : 'completed', attempt: 1, runnerId: claimed ? `runner-${index}` : null,
        fence: 1, expiresAt: claimed ? now + 10 * 60_000 : null, version: 1, changeId: `budget-change-${index % 300}`, revision: 1,
      } });
    }
    store.put('module:runners:ids', jobIds);
    store.put('module:runners:pending-ids', []);
    store.put('module:runners:claimed-ids', [{ id: 'budget-job-498', order: 498 }, { id: 'budget-job-499', order: 499 }]);
    store.put('module:runners:runner:runner-498', { principalId: 'checker', role: 'checker', activeJobId: 'budget-job-498', supportedProfileDigests: [digest], lastSeenAt: now });
    store.put('module:runners:runner:runner-499', { principalId: 'checker', role: 'checker', activeJobId: 'budget-job-499', supportedProfileDigests: [digest], lastSeenAt: now });
    store.put('module:runners:runner-ids', ['runner-498', 'runner-499']);
    store.put('module:issues:items', Array.from({ length: 100 }, (_, index) => ({
      number: index + 1, title: `Issue ${index + 1}`, body: '', labels: [], milestoneId: null, allowedFiles: null,
      state: index < 90 ? 'closed' : 'open', authorId: 'owner', version: 1, createdAt: now - HOUR, updatedAt: now - HOUR,
    })));
    for (let index = 0; index < 2_000; index++) {
      sql.exec(`INSERT INTO concord_events(kind, actor_id, timestamp, version, related_ids, payload) VALUES(?, 'agent-a', ?, ?, ?, '{}')`,
        index % 10 === 0 ? 'change.published' : 'lease.renewed', now - 2 * HOUR + index * 1000, index + 1, JSON.stringify([`budget-change-${index % 300}`]));
    }
    for (let index = 0; index < 1_000; index++) {
      sql.exec(`INSERT INTO concord_requests(principal_id, route, idempotency_key, request_digest, status, body, created_at)
        VALUES('agent-a', 'POST /seed', ?, ?, 200, '{}', ?)`, `seed-${index}`, digest, now - HOUR);
    }
    store.put('repo:version', (store.get<number>('repo:version') ?? 0) + terminalLeases + 10);
    return store.get<number>('repo:version')!;
  });
}

async function requestRows(repo: string): Promise<number> {
  return runInDurableObject(stubFor(repo), (_instance, state) =>
    state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM concord_requests').toArray()[0].n);
}

describe('rows-read budget for hot repository routes', () => {
  it('keeps every hot route proportional to what it returns', async () => {
    const repo = `rows_budget_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await seed(repo, 2_000);
    await instrument(repo);
    const base = `/v1/repos/${repo}`;

    const snapshot = await rowsFor('GET /snapshot uncached', () => fetchApi(apiRequest(`${base}/snapshot`)));
    expect(snapshot.response.status).toBe(200);
    expect(snapshot.rows).toBeLessThanOrEqual(1_500);
    const etag = snapshot.response.headers.get('etag')!;
    const snapshotText = await snapshot.response.text();
    expect(new TextEncoder().encode(snapshotText).byteLength).toBeLessThan(200_000);
    const snapshotBody = JSON.parse(snapshotText);
    expect(snapshotBody.data.projections.repos.changes).toHaveLength(60);
    expect(snapshotBody.data.projections.repos.olderChanges).toBe(240);
    const cached = await rowsFor('GET /snapshot cached', () => fetchApi(apiRequest(`${base}/snapshot`)));
    expect(cached.response.status).toBe(200);
    expect(cached.rows).toBeLessThanOrEqual(10);
    const notModified = await rowsFor('GET /snapshot 304', () => fetchApi(new Request(`https://concord.test${base}/snapshot`, {
      headers: { authorization: 'Bearer local-owner', 'if-none-match': etag } })));
    expect(notModified.response.status).toBe(304);
    expect(notModified.rows).toBeLessThanOrEqual(10);

    const page1 = await rowsFor('GET /leases page 1', () => fetchApi(apiRequest(`${base}/leases`, 'local-viewer')));
    expect(page1.response.status).toBe(200);
    expect(page1.rows).toBeLessThanOrEqual(300);
    const firstPage = (await responseBody(page1.response)).data;
    expect(firstPage.items).toHaveLength(100);
    expect(firstPage.items.slice(0, 5).every((item: { state: string }) => item.state === 'active')).toBe(true);
    const page2 = await rowsFor('GET /leases page 2', () => fetchApi(apiRequest(`${base}/leases?cursor=${encodeURIComponent(firstPage.nextCursor)}`, 'local-viewer')));
    expect(page2.response.status).toBe(200);
    expect(page2.rows).toBeLessThanOrEqual(300);
    expect((await responseBody(page2.response)).data.items).toHaveLength(100);

    const versionNow = async () => (await responseBody(await fetchApi(apiRequest(`${base}/events?after=9007199254740991&limit=1`)))).version;
    const probe = await rowsFor('GET /events probe', () => fetchApi(apiRequest(`${base}/events?after=9007199254740991&limit=1`)));
    expect(probe.response.status).toBe(200);
    expect(probe.rows).toBeLessThanOrEqual(5);

    const renewBatch = await rowsFor('POST /leases/renew-batch (land renew cycle)', () => fetchApi(mutation(`${base}/leases/renew-batch`,
      { changeId: 'budget-change-295', ttlSeconds: 300 }, 'budget-renew-batch', 'local-agent-a')));
    expect(renewBatch.response.status).toBe(200);
    expect(renewBatch.rows).toBeLessThanOrEqual(300);

    const lease = await runInDurableObject(stubFor(repo), (_instance, state) =>
      state.storage.sql.exec<{ fence: number }>("SELECT fence FROM leases_claims WHERE lease_id = 'live-0'").toArray()[0]);
    const renew = await rowsFor('POST /leases/:id/renew', async () => fetchApi(mutation(`${base}/leases/live-0/renew`,
      { expectedVersion: await versionNow(), fence: lease.fence, ttlSeconds: 120 }, 'budget-renew', 'local-owner')));
    if (renew.response.status !== 200) console.log(await renew.response.clone().text());
    expect(renew.response.status).toBe(200);
    expect(renew.rows).toBeLessThanOrEqual(80);

    const requestsBeforePoll = await requestRows(repo);
    const poll = await rowsFor('POST /runner/poll idle', () => fetchApi(mutation(`${base}/runner/poll`,
      { runnerId: 'idle-runner', role: 'checker', supportedProfileDigests: [digest] }, 'budget-poll', 'local-checker')));
    expect(poll.response.status).toBe(204);
    expect(poll.rows).toBeLessThanOrEqual(60);
    expect(await requestRows(repo)).toBe(requestsBeforePoll);

    const versionBeforeHeartbeat = await versionNow();
    const heartbeat = await rowsFor('POST /jobs/:id/heartbeat', () => fetchApi(mutation(`${base}/jobs/budget-job-498/heartbeat`,
      { attempt: 1, fence: 1, inputDigest: digest }, 'budget-heartbeat', 'local-checker')));
    expect(heartbeat.response.status).toBe(200);
    expect(heartbeat.rows).toBeLessThanOrEqual(60);
    expect(await requestRows(repo)).toBe(requestsBeforePoll);
    expect(await versionNow()).toBe(versionBeforeHeartbeat);

    await fetchApi(apiRequest(`${base}/changes/budget-change-295`));
    const changeDetail = await rowsFor('GET /changes/:id', () => fetchApi(apiRequest(`${base}/changes/budget-change-295`)));
    expect(changeDetail.response.status).toBe(200);
    expect(changeDetail.rows).toBeLessThanOrEqual(50);

    const queue = await rowsFor('GET /queue', () => fetchApi(apiRequest(`${base}/queue`)));
    expect(queue.response.status).toBe(200);
    expect(queue.rows).toBeLessThanOrEqual(400);
    const issues = await rowsFor('GET /issues', () => fetchApi(apiRequest(`${base}/issues`)));
    expect(issues.response.status).toBe(200);
    expect(issues.rows).toBeLessThanOrEqual(50);

    const day = new Date().toISOString().slice(0, 10);
    const metrics = await rowsFor('GET /metrics uncached', () => fetchApi(apiRequest(
      `${base}/metrics?since=${day}T00:00:00.000Z&until=${new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString()}`)));
    expect(metrics.response.status).toBe(200);
    expect(metrics.rows).toBeLessThanOrEqual(200);

    console.log(`rows-read summary\n${measured.map(([label, rows]) => `${label}: ${rows}`).join('\n')}`);
  });

  it('renews a land change with the same reads at 2,000 or 20,000 terminal leases', async () => {
    const counts: number[] = [];
    for (const terminal of [2_000, 20_000]) {
      const repo = `rows_renew_${terminal}_${crypto.randomUUID().replaceAll('-', '').slice(0, 6)}`;
      await seed(repo, terminal);
      await instrument(repo);
      const renew = await rowsFor(`POST /leases/renew-batch with ${terminal} terminal leases`, () => fetchApi(mutation(`/v1/repos/${repo}/leases/renew-batch`,
        { changeId: 'budget-change-295', ttlSeconds: 300 }, `renew-${terminal}`, 'local-agent-a')));
      expect(renew.response.status).toBe(200);
      expect(renew.rows).toBeLessThanOrEqual(300);
      counts.push(renew.rows);
    }
    expect(Math.abs(counts[1] - counts[0])).toBeLessThanOrEqual(20);
  });

  it('sweeps terminal leases older than 24 hours through indexes only', async () => {
    const repo = `rows_sweep_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await seed(repo, 10);
    const now = Date.now();
    await runInDurableObject(stubFor(repo), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO leases_claims(lease_id, unit_key, holder_id, change_id, intent_text, fence, expires_at, state, version, created_at, updated_at)
        VALUES('stale-terminal', 'file:stale.c', 'agent-b', 'budget-change-1', 'old', 1, ?, 'released', 99999, ?, ?)`, now - 26 * HOUR, now - 26 * HOUR, now - 25 * HOUR);
    });
    const response = await fetchApi(mutation(`/v1/repos/${repo}/leases/renew-batch`,
      { changeId: 'budget-change-295', ttlSeconds: 300 }, 'sweep-renew', 'local-agent-a'));
    expect(response.status).toBe(200);
    await runInDurableObject(stubFor(repo), (_instance, state) => {
      const sql = state.storage.sql;
      const ids = sql.exec<{ lease_id: string }>('SELECT lease_id FROM leases_claims').toArray().map(row => row.lease_id);
      expect(ids).not.toContain('stale-terminal');
      expect(ids).toContain('old-000000');
      expect(ids.filter(id => id.startsWith('live-'))).toHaveLength(5);
      const plan = (query: string, ...args: (string | number)[]) =>
        sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, ...args).toArray().map(row => row.detail).join(' | ');
      const plans = [
        plan(`SELECT lease_id FROM leases_claims WHERE state NOT IN ('active','reserved') AND updated_at < ? ORDER BY updated_at, lease_id LIMIT 256`, now),
        plan('SELECT version FROM leases_claims ORDER BY version DESC LIMIT 1'),
        plan(`SELECT * FROM leases_claims WHERE state IN ('active','reserved') AND expires_at > ? ORDER BY created_at DESC, lease_id DESC LIMIT ?`, now, 101),
        plan(`SELECT * FROM leases_claims WHERE version <= ? AND NOT (state IN ('active','reserved') AND expires_at > ?) ORDER BY created_at DESC, lease_id DESC LIMIT ?`, 1, now, 101),
        plan(`SELECT * FROM leases_claims WHERE change_id = ? AND holder_id = ? AND state = 'active' AND expires_at > ? ORDER BY unit_key`, 'x', 'y', now),
      ];
      for (const detail of plans) expect(detail).not.toMatch(/SCAN leases_claims(?! USING)/);
    });
  });
});
