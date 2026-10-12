import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;
const { deriveInbox, normalizeDiagnosis, projectionItems, snapshotCollections, mutationEvidence,
  leaseCountdown, environmentBadge, verdictProvenance, repairStatus, openIssueRows,
  parseUnitEntry, unitLeaseState, issueOverlaps, agentSpecText, issueTimeline,
  parseLabelsInput, formatLabelsInput, renderMarkdown } = require('../../web/views.js') as any;
const { apiFetch, clearSessionToken, setSessionToken, redactError, allowedActions,
  getIssue, listIssues, updateIssue, listMilestones, ApiError } = require('../../web/api.js') as any;
const { createIssueEditor } = require('../../web/issue.js') as any;

const fixture = {
  data: { projections: {
    repos: { changes: [
      { changeId: 'x', authorId: 'agent-a', authorModel: 'model-from-api', intentText: 'Cap retries', unitKeys: ['fn:retry'], status: 'ready', revision: 2, headOid: 'abc123', baseOid: 'base' },
      { changeId: 'y', authorId: 'agent-b', intentText: 'Rename logs', unitKeys: ['file:log'], status: 'blocked', revision: 1, headOid: 'def456' },
    ], repo: { observedCanonicalOid: 'main123' } },
    leases: { items: [{ leaseId: 'l1', changeId: 'x', holderId: 'agent-a', intentText: 'Protect retry path', unitKey: 'fn:retry', fence: 3, expiresAt: Date.now() + 120000, state: 'active' }],
      refusals: [{ changeId: 'x', requesterId: 'agent-c', keys: ['fn:retry'], createdAt: Date.now(), conflicts: [{ holderId: 'agent-a', intentText: 'Protect retry path', expiresAt: Date.now() + 120000 }] }] },
    queue: { entries: [
      { changeId: 'y', state: 'blocked', revision: 1, sequence: 41, blockedReason: 'CHECK_FAILED' },
      { changeId: 'landed-id', state: 'landed', admittedRevision: 2, sequence: 42, blockedReason: null },
      { changeId: 'withdrawn-id', state: 'withdrawn', admittedRevision: 3, sequence: 43, blockedReason: 'author request' },
    ], diagnosis: { reason: 'SINGLETON', blame: ['y'] }, observedMain: 'main123',
      activeStackJobId: 'job-2', stackMembers: ['x', 'y'], diagnosticResults: [{ jobId: 'job-1', memberIds: ['x', 'y'], outcome: 'FAIL', sequence: 4 }] },
    issues: { items: [{ number: 1, title: '<task>', state: 'open', milestoneId: 'm1', changes: [{ changeId: 'x', status: 'ready' }] }], milestones: [{ milestoneId: 'm1', title: 'Release' }] },
    findings: { findingSetVersions: { x: 0 }, findings: [
      { findingId: 'f1', changeId: 'x', status: 'open', unitKey: 'fn:retry', originRevision: 1, text: 'Retry evidence needs repair' },
    ], rounds: [] },
    runners: { items: [{ runnerId: 'checker-1', role: 'checker', state: 'idle', lastSeenAt: 1700000000000, activeJobId: null }] },
  } },
  version: 7, eventSeq: 0,
};

describe('Fleet desk derivation', () => {
  it('derives blamed changes, lease waits, and ready changes without reading verdicts', () => {
    const items = deriveInbox(fixture);
    expect(items.map((item: any) => item.kind)).toEqual(['Blamed by bisection', 'Waiting on a lease', 'Review requested']);
    expect(items[0].title).toBe('Rename logs');
    expect(items[1].evidence).toContain('agent-a');
    expect(items[2].title).toBe('Cap retries');
    expect(deriveInbox(fixture).map((item: any) => item.kind)).toContain('Review requested');
  });
  it('keeps queue classifications honest', () => {
    expect(normalizeDiagnosis({ reason: 'INTERACTION', blame: ['a', 'b'] })).toEqual({ reason: 'INTERACTION', ids: ['a', 'b'] });
    expect(normalizeDiagnosis({ reason: 'BASE_RED', blame: [] }).ids).toEqual([]);
    expect(normalizeDiagnosis({ reason: 'SINGLETON', blame: ['b'] }).ids).toEqual(['b']);
  });
  it('keeps interaction and red baseline as group decisions', () => {
    for (const reason of ['INTERACTION', 'DEPENDENCY_GROUP', 'BASE_RED', 'INCONCLUSIVE']) {
      const snapshot = structuredClone(fixture) as any;
      snapshot.data.projections.queue.diagnosis = { reason, blame: reason === 'BASE_RED' ? [] : ['x', 'y'] };
      const decisions = deriveInbox(snapshot);
      expect(decisions[0].evidence).toContain(`Classification: ${reason}`);
      expect(decisions[0].kind).not.toBe('Blamed by bisection');
    }
  });
  it('labels missing, unavailable, and empty projections explicitly', () => {
    expect(projectionItems(null).state).toBe('unknown');
    expect(projectionItems({ status: 'unavailable', items: [] }).state).toBe('unavailable');
    expect(projectionItems({ items: [] }).state).toBe('empty');
    expect(snapshotCollections({ data: { projections: {} } }).changes.state).toBe('unknown');
  });
  it('derives open issue cards with milestone, change and held lease', () => {
    const snapshot = structuredClone(fixture) as any;
    snapshot.data.projections.leases.items[0].issueNumber = 1;
    expect(openIssueRows(snapshot)[0]).toMatchObject({ number: 1, title: '<task>', milestone: 'Release', changes: [{ status: 'ready' }], leases: [{ leaseId: 'l1' }] });
  });
  it('uses the complete held lease projection for issue cards beyond the first page', () => {
    for (const count of [100, 101, 128]) {
      const snapshot = structuredClone(fixture) as any;
      const held = Array.from({ length: count }, (_, index) => ({
        leaseId: `held-${index}`, issueNumber: 1, unitKey: `unit:${index}`,
        holderId: 'agent-a', state: 'active', expiresAt: Date.now() + 120_000,
      }));
      snapshot.data.projections.leases.items = held.slice(0, 100);
      snapshot.data.projections.leases.heldItems = held;
      const card = openIssueRows(snapshot)[0];
      expect(card.leases).toHaveLength(count);
      expect(card.leases.at(-1).leaseId).toBe(`held-${count - 1}`);
    }
  });
  it('requires live fences and current finding versions for enqueue evidence', () => {
    const change = fixture.data.projections.repos.changes[0];
    expect(mutationEvidence(change, fixture.data.projections.leases.items, 0).leaseFences).toEqual({ 'fn:retry': 3 });
    expect(mutationEvidence(change, [], 0).error).toContain('lease fence');
    expect(mutationEvidence(change, fixture.data.projections.leases.items, undefined).error).toContain('finding-set version');
  });
  it('reports expired leases without negative countdowns', () => {
    expect(leaseCountdown({ state: 'active', expiresAt: Date.now() - 1000 }, Date.now())).toEqual({ text: 'expired', expired: true });
  });
  it('does not label an unknown backend as live', () => {
    expect(environmentBadge(null).label).toBe('unknown backend');
    expect(environmentBadge({ mode: 'local', storageBackend: 'bridge' }).label).toBe('local bridge');
  });
  it('distinguishes direct, carried, and invalidated approval provenance', () => {
    expect(verdictProvenance({ decision: 'approve', reviewerId: 'r', revision: 2 }).summary).toContain('Direct approve');
    expect(verdictProvenance({ parentVerdictId: 'v1', deltaResultId: 'd1' }).summary).toContain('delta evidence d1');
    expect(verdictProvenance({ carryInvalidation: 'head changed' }).summary).toContain('head changed');
  });
  it('keeps open findings unresolved until a pending repair exists', () => {
    const findings = [{ findingId: 'f1', status: 'open' }];
    expect(repairStatus(findings, []).status).toBe('unresolved');
    expect(repairStatus(findings, [{ roundId: 'r1', status: 'pending' }]).status).toBe('pending-review');
    expect(repairStatus([], []).status).toBe('resolved');
  });
});

describe('Fleet desk DOM', () => {
  it('shows first run on 401, then renders the desk, inbox and verdict route', async () => {
    clearSessionToken();
    const dom = new JSDOM(readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/' });
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    Object.assign(globalThis, { document: dom.window.document, window: dom.window });
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.scrollTo = () => {};
    let tick: (() => void) | undefined;
    dom.window.setInterval = ((callback: () => void) => { tick = callback; return 1; }) as any;
    const doc = dom.window.document;
    const byId = (id: string) => doc.getElementById(id)!;
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let forbiddenVerdicts = false;
    let snapshotVersion = 7;
    let eventVersion = 7;
    let releaseSnapshot8: (() => void) | undefined;
    let releaseSnapshot10: (() => void) | undefined;
    let delayNextSnapshot8 = true;
    let delayNextSnapshot10 = true;
    let mutationVersion = 7;
    let staleNextEnqueue = false;
    let failNextSnapshot = false;
    let claimConflict = false;
    let interaction = false;
    let changeStatus = 'ready';
    const history = [
      { verdictId: 'v1', changeId: 'x', reviewerId: 'other-reviewer', decision: 'approve', revision: 1, findingSetVersion: 0, parentVerdictId: null },
      { verdictId: 'v2', changeId: 'x', reviewerId: 'other-reviewer', decision: 'reject', revision: 1, findingSetVersion: 0, parentVerdictId: 'v1', deltaResultId: 'delta-1' },
      ...Array.from({ length: 98 }, (_, index) => ({ verdictId: `old-${index}`, changeId: 'x', reviewerId: 'other-reviewer', decision: 'reject', revision: 1, findingSetVersion: 0, parentVerdictId: null })),
    ];
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      requests.push({ url, init });
      const token = new Headers(init.headers).get('authorization');
      let status = 200;
      let body: any = {};
      if (url === '/health') body = { data: { mode: 'production', storageBackend: 'artifacts' } };
      else if (url === '/v1/me') {
        if (token === 'Bearer bad') { status = 401; body = { error: { code: 'UNAUTHORIZED', message: 'bad token' } }; }
        else if (token === 'Bearer local-agent-a') { status = 404; body = { error: { code: 'NOT_FOUND' } }; }
        else if (token === 'Bearer empty') body = { data: { principalId: 'owner', roles: ['owner'], repoIds: '*', model: null } };
        else body = { data: { principalId: 'reviewer', roles: ['reviewer'], repoIds: ['demo'], model: null } };
      } else if (url === '/v1/repos') body = { data: { items: token === 'Bearer empty' ? [] : [{ repoId: 'demo', displayName: 'Demo' }] } };
      else if (url.endsWith('/snapshot')) {
        if (token === 'Bearer restricted') { status = 403; body = { error: { code: 'FORBIDDEN', message: 'no scope' } }; }
        else if (snapshotVersion === 10 && delayNextSnapshot10) return await new Promise<Response>(resolve => {
          delayNextSnapshot10 = false;
          releaseSnapshot10 = () => resolve(new Response(JSON.stringify({ ...fixture, version: 10 })));
        });
        else if (failNextSnapshot) {
          failNextSnapshot = false;
          status = 503; body = { error: { code: 'NETWORK_UNREACHABLE', message: 'refresh failed' } };
        }
        else if (snapshotVersion === 8 && delayNextSnapshot8) return await new Promise<Response>(resolve => {
          delayNextSnapshot8 = false;
          releaseSnapshot8 = () => resolve(new Response(JSON.stringify({ ...fixture, version: 8,
            data: { projections: { ...fixture.data.projections, repos: { ...fixture.data.projections.repos,
              changes: fixture.data.projections.repos.changes.map(c => c.changeId === 'x' ? { ...c, intentText: 'Stale version 8' } : c) } } } })));
        });
        else body = { ...fixture, version: snapshotVersion, data: { projections: {
          ...fixture.data.projections, repos: { ...fixture.data.projections.repos,
            changes: fixture.data.projections.repos.changes.map(c => c.changeId === 'x'
              ? { ...c, status: changeStatus, intentText: snapshotVersion === 9 ? 'Current version 9' : c.intentText } : c) },
          queue: interaction ? { ...fixture.data.projections.queue, diagnosis: { reason: 'INTERACTION', blame: ['x', 'y'] },
            diagnosticResults: [{ jobId: 'job-1', memberIds: ['x'], outcome: 'PASS', sequence: 4 },
              { jobId: 'job-2', memberIds: ['y'], outcome: 'PASS', sequence: 5 },
              { jobId: 'job-3', memberIds: ['x', 'y'], outcome: 'FAIL', sequence: 6 }] } : fixture.data.projections.queue,
        } } };
      }
      else if (url.includes('/events?')) body = { data: { items: eventVersion === 6
        ? [{ sequence: 2, kind: 'stale.event', actorId: 'old', version: 6, relatedIds: ['x'] }]
        : eventVersion === 7 && url.includes('after=0')
          ? [{ sequence: 1, kind: 'change.published', actorId: 'agent-a', version: 7, relatedIds: ['x', 'delta-1'] }]
          : [] }, version: eventVersion, eventSeq: eventVersion === 6 ? 2 : 1 };
      else if (url.includes('/changes/x/verdicts') && init.method !== 'POST' && (forbiddenVerdicts || token === 'Bearer local-agent-a')) {
        status = 403; body = { error: { code: 'FORBIDDEN', message: 'reviewers only' } };
      }
      else if (url.endsWith('/changes/x/verdicts')) body = { data: { items: history, nextCursor: 'MTAw' } };
      else if (url.endsWith('/changes/x/verdicts?cursor=MTAw')) body = { data: { items: [
        { verdictId: 'v101', changeId: 'x', reviewerId: 'other-reviewer', decision: 'approve', revision: 2, findingSetVersion: 0, parentVerdictId: null },
      ], nextCursor: null } };
      else if (url.endsWith('/leases') && init.method === 'POST' && claimConflict) {
        status = 409; body = { error: { code: 'LEASE_CONFLICT', message: 'Already claimed', details: {
          holderId: 'agent-a', intentText: 'Protect retry path', expiresAt: Date.now() + 120000,
        } } };
      }
      else if (url.endsWith('/queue/enqueue') && init.method === 'POST' && staleNextEnqueue) {
        staleNextEnqueue = false;
        status = 409; body = { error: { code: 'STALE_VERSION', message: 'Snapshot is stale', details: { currentVersion: 11 } } };
      }
      else body = { data: {}, version: mutationVersion };
      return new Response(JSON.stringify(body), { status });
    }) as any;
    try {
      // @ts-expect-error Browser JS is intentionally untyped.
      await import('../../web/app.js');
      expect(byId('signed-out').hidden).toBe(false);
      expect(byId('desk').hidden).toBe(true);
      expect((byId('token-input') as HTMLInputElement).type).toBe('password');
      expect(byId('demo-open').hidden).toBe(true);
      (byId('token-input') as HTMLInputElement).value = 'bad';
      byId('token-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(byId('signed-out').hidden).toBe(false);
      expect(doc.body.textContent).not.toContain('Unknown state');
      expect(byId('session-error').textContent).toContain('Sign in again');
      (byId('token-input') as HTMLInputElement).value = 'good';
      byId('token-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(); await flush(); await flush();
      expect(byId('desk').hidden).toBe(false);
      expect(byId('work-board').textContent).toContain('Cap retries');
      expect(byId('issue-list').textContent).toContain('#1 <task>');
      expect(byId('issue-list').textContent).toContain('Milestone: Release');
      expect(byId('issue-list').querySelector('task')).toBeNull();
      expect(byId('work-board').textContent).toContain('model-from-api');
      expect(byId('work-board').textContent).not.toContain('agent-b · model');
      expect(byId('alert-count').textContent).toContain('3 decisions');
      byId('inbox-alert').click();
      expect(byId('inbox-view').hidden).toBe(false);
      expect(byId('inbox-list').textContent).toContain('Waiting on a lease');
      (byId('inbox-list').querySelector('button:last-child') as HTMLButtonElement).click();
      expect(byId('inbox-detail').textContent).toContain('Cap retries');
      expect(byId('inbox-detail').textContent).toContain('ready for independent review');
      expect(byId('inbox-detail').textContent).toContain('Head: abc123');
      expect(byId('inbox-detail').textContent).toContain('Approval history');
      expect(byId('inbox-detail').textContent).toContain('Direct approve');
      expect(byId('inbox-detail').querySelector('.inbox-actions')).toBeTruthy();
      const inboxManifest = byId('inbox-detail').querySelector('input[name="manifest"]') as HTMLInputElement;
      inboxManifest.value = 'sha256:in-progress'; inboxManifest.focus();
      tick!(); await flush();
      expect(byId('inbox-detail').querySelector('input[name="manifest"]')).toBe(inboxManifest);
      expect(inboxManifest.value).toBe('sha256:in-progress');
      expect(doc.activeElement).toBe(inboxManifest);
      (byId('inbox-detail').querySelector('button') as HTMLButtonElement).click();
      expect(byId('inbox-view').hidden).toBe(true);
      expect(byId('change-detail').hidden).toBe(false);
      expect(byId('finding-list').textContent).toContain('Retry evidence needs repair');
      expect(byId('finding-list').textContent).toContain('Repair state: unresolved');
      expect(byId('runner-list').textContent).toContain('checker-1 (checker) · idle');
      expect(byId('runner-summary').textContent).toContain('checker-1');
      const activeLease = byId('lease-list').querySelector('.lease-row')!;
      expect(activeLease.textContent).toContain('Intent: Protect retry path');
      expect(activeLease.textContent).toContain('Change: x');
      expect(activeLease.textContent).toContain('State: active');
      expect(activeLease.textContent).toContain('Fence: 3');
      expect(activeLease.textContent).toContain('Expires:');
      expect(byId('queue-list').querySelector('.queue-row')?.textContent).toContain('Admitted revision: 1 · Sequence: 41 · Blocked reason: CHECK_FAILED');
      expect(byId('queue-list').querySelector('.queue-row')?.textContent).toContain('blocked · culprit');
      const queueHistory = byId('queue-list').querySelector('details')!;
      expect(queueHistory.open).toBe(false);
      expect(queueHistory.textContent).toContain('landed-id');
      expect(queueHistory.textContent).toContain('withdrawn-id');
      expect(queueHistory.textContent).toContain('Admitted revision: 3 · Sequence: 43 · Blocked reason: author request');
      expect(byId('queue-tree').textContent).toContain('Active job: job-2 · Members: x, y');
      expect(byId('queue-tree').textContent).toContain('Diagnostic job job-1 · Members: x, y · Outcome: FAIL');
      expect(byId('replay-body').textContent).toContain('Historical simulation: unavailable');
      expect(byId('event-log').textContent).toContain('change.published by agent-a (v7)');
      expect(byId('verdict-list').querySelector('a[href="#event-1"]')?.textContent).toBe('delta-1');
      byId('detail-close').click();
      expect(byId('change-detail').hidden).toBe(true);
      byId('back-desk').click();
      (doc.querySelector('[data-change-id="x"]') as HTMLButtonElement).click();
      await flush();
      expect(byId('verdict-list').textContent).toContain('Direct approve');
      expect(byId('verdict-list').textContent).toContain('Parent review: v1');
      expect(byId('verdict-list').textContent).toContain('delta-1');
      expect(byId('verdict-list').querySelectorAll('.verdict-record')).toHaveLength(101);
      expect(byId('verdict-list').textContent).toContain('revision 2');
      expect(requests.some(r => r.url === '/v1/repos/demo/changes/x/verdicts?cursor=MTAw')).toBe(true);
      expect(requests.some(r => r.url === '/v1/repos/demo/changes/x/verdicts')).toBe(true);
      const manifest = doc.querySelector('input[name="manifest"]') as HTMLInputElement;
      const evidence = doc.querySelector('input[name="evidence"]') as HTMLInputElement;
      manifest.value = 'sha256:manifest'; evidence.value = 'sha256:evidence';
      manifest.focus(); tick!(); await flush();
      expect(doc.querySelector('input[name="manifest"]')).toBe(manifest);
      expect(manifest.value).toBe('sha256:manifest');
      expect(doc.activeElement).toBe(manifest);
      (byId('action-panel').querySelector('form') as HTMLFormElement).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      const request = requests.find(r => r.url === '/v1/repos/demo/changes/x/verdicts' && r.init.method === 'POST')!;
      expect(request).toBeTruthy();
      expect(new Headers(request.init.headers).get('idempotency-key')).toBeTruthy();
      expect(JSON.parse(String(request.init.body)).expectedVersion).toBe(7);
      byId('token-clear').click();
      expect(byId('signed-out').hidden).toBe(false);
      expect(byId('desk').hidden).toBe(true);
      forbiddenVerdicts = true;
      (byId('token-input') as HTMLInputElement).value = 'good';
      byId('token-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(); await flush();
      (doc.querySelector('[data-change-id="x"]') as HTMLButtonElement).click();
      expect(byId('verdict-list').textContent).toContain('Approval history is visible to reviewers');
      expect(byId('inbox-list').textContent).toContain('Review requested');
      byId('token-clear').click();
      (byId('token-input') as HTMLInputElement).value = 'local-agent-a';
      byId('token-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(); await flush();
      expect(byId('principal').textContent).toContain('role unverified');
      (doc.querySelector('[data-change-id="x"]') as HTMLButtonElement).click();
      expect(byId('action-panel').textContent).toContain('Enqueue');
      expect(byId('action-panel').textContent).toContain('Claim');
      const claimForm = [...byId('action-panel').querySelectorAll('form')].find(form => form.textContent?.includes('Claim'))!;
      (claimForm.querySelector('[name="unitKeys"]') as HTMLInputElement).value = 'fn:retry, fn:retry';
      claimForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      expect(requests.filter(r => r.url === '/v1/repos/demo/leases' && r.init.method === 'POST')).toHaveLength(0);
      (claimForm.querySelector('[name="unitKeys"]') as HTMLInputElement).value = 'fn:retry';
      claimForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      const claim = requests.find(r => r.url === '/v1/repos/demo/leases' && r.init.method === 'POST')!;
      expect(JSON.parse(String(claim.init.body))).toEqual({ changeId: 'x', unitKeys: ['fn:retry'], intentText: 'Cap retries' });
      expect(new Headers(claim.init.headers).get('idempotency-key')).toBeTruthy();
      await flush();
      claimConflict = true;
      claimForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(); await flush();
      expect(byId('mutation-status').textContent).toContain('Holder: agent-a; intent: Protect retry path; expires:');
      claimConflict = false;
      (doc.querySelector('[data-change-id="x"]') as HTMLButtonElement).click();
      const enqueueForm = [...byId('action-panel').querySelectorAll('form')].find(form => form.textContent?.includes('Enqueue'))!;
      (enqueueForm.querySelector('[name="verdictId"]') as HTMLInputElement).value = 'v101';
      enqueueForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      const enqueue = requests.find(r => r.url === '/v1/repos/demo/queue/enqueue' && r.init.method === 'POST')!;
      expect(JSON.parse(String(enqueue.init.body))).toEqual({ changeId: 'x', expectedVersion: 7, verdictId: 'v101', leaseFences: { 'fn:retry': 3 } });
      expect(new Headers(enqueue.init.headers).get('idempotency-key')).toBeTruthy();
      byId('token-clear').click();
      (byId('token-input') as HTMLInputElement).value = 'restricted';
      byId('token-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(); await flush();
      expect(byId('desk-message').textContent).toBe('Your token cannot see this repository.');
      expect(doc.body.textContent).not.toContain('Unknown state');
      byId('token-clear').click();
      (byId('token-input') as HTMLInputElement).value = 'empty';
      byId('token-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(); await flush();
      expect(byId('principal').textContent).toContain('Signed in as owner');
      expect(byId('principal').textContent).toContain('owner · token in memory');
      expect(byId('repo-select').textContent).toContain('No repositories yet');
      expect(byId('desk-message').textContent).toContain('Create one');
      expect(byId('stat-strip').textContent).toContain('Agents working0');
      expect(byId('stat-strip').textContent).toContain('In queue0');
      expect(byId('work-board').textContent).toContain('No changes yet');
      expect(byId('fleet-list').textContent).toContain('No agents yet');
      expect(byId('lease-list').textContent).toContain('No active leases yet');
      expect(byId('queue-list').textContent).toContain('Merge queue empty');
      expect(byId('main-footer').textContent).toContain('No repositories yet');
      expect(byId('inbox-alert').hidden).toBe(true);
      // A mutation reports v9 before its refresh receives an older v8 snapshot.
      byId('token-clear').click();
      (byId('token-input') as HTMLInputElement).value = 'local-agent-a';
      byId('token-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(); await flush();
      snapshotVersion = 8; mutationVersion = 9;
      (doc.querySelector('[data-change-id="x"]') as HTMLButtonElement).click();
      const raceEnqueue = [...byId('action-panel').querySelectorAll('form')].find(form => form.textContent?.includes('Enqueue'))!;
      (raceEnqueue.querySelector('[name="verdictId"]') as HTMLInputElement).value = 'v101';
      raceEnqueue.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(); await flush();
      expect(releaseSnapshot8).toBeTypeOf('function');
      releaseSnapshot8!(); await flush();
      expect(byId('work-board').textContent).toContain('Cap retries');
      expect(byId('work-board').textContent).not.toContain('Stale version 8');
      expect((raceEnqueue.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
      const requestsBeforeRetry = requests.filter(r => r.url === '/v1/repos/demo/queue/enqueue' && r.init.method === 'POST').length;
      raceEnqueue.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(requests.filter(r => r.url === '/v1/repos/demo/queue/enqueue' && r.init.method === 'POST')).toHaveLength(requestsBeforeRetry);
      snapshotVersion = 9; eventVersion = 9;
      tick!(); await flush(); await flush();
      expect((raceEnqueue.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
      raceEnqueue.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(); await flush();
      expect(requests.filter(r => r.url === '/v1/repos/demo/queue/enqueue' && r.init.method === 'POST')).toHaveLength(requestsBeforeRetry + 1);
      expect(byId('work-board').textContent).toContain('Current version 9');
      expect(byId('work-board').textContent).not.toContain('Stale version 8');
      // An in-flight v10 snapshot cannot clear the v11 requirement from a stale refusal.
      snapshotVersion = 10; eventVersion = 10;
      tick!();
      staleNextEnqueue = true; failNextSnapshot = true;
      raceEnqueue.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(); await flush();
      expect(releaseSnapshot10).toBeTypeOf('function');
      expect(byId('desk-message').textContent).toContain('Snapshot unavailable (NETWORK_UNREACHABLE)');
      const actionButtons = [...doc.querySelectorAll('.action-form button, .action-buttons button')] as HTMLButtonElement[];
      expect(actionButtons.length).toBeGreaterThan(1);
      expect(actionButtons.every(button => button.disabled)).toBe(true);
      const postsAfterStale = requests.filter(r => r.url === '/v1/repos/demo/queue/enqueue' && r.init.method === 'POST').length;
      raceEnqueue.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(requests.filter(r => r.url === '/v1/repos/demo/queue/enqueue' && r.init.method === 'POST')).toHaveLength(postsAfterStale);
      releaseSnapshot10!(); await flush();
      expect((raceEnqueue.querySelector('button') as HTMLButtonElement).disabled).toBe(true);
      raceEnqueue.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(requests.filter(r => r.url === '/v1/repos/demo/queue/enqueue' && r.init.method === 'POST')).toHaveLength(postsAfterStale);
      interaction = true; snapshotVersion = 11; eventVersion = 11;
      tick!(); await flush(); await flush();
      const recoveredButtons = [...doc.querySelectorAll('.action-form button, .action-buttons button')] as HTMLButtonElement[];
      expect(recoveredButtons.every(button => !button.disabled)).toBe(true);
      const recoveredEnqueue = [...byId('action-panel').querySelectorAll('form')].find(form => form.textContent?.includes('Enqueue'))!;
      recoveredEnqueue.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(); await flush();
      expect(requests.filter(r => r.url === '/v1/repos/demo/queue/enqueue' && r.init.method === 'POST')).toHaveLength(postsAfterStale + 1);
      expect(byId('diagnosis').textContent).toContain('Interaction set failed together: x, y');
      expect(byId('queue-tree').textContent).toContain('Diagnostic job job-3 · Members: x, y · Outcome: FAIL');
      expect(byId('queue-tree').querySelectorAll('li.highlight')).toHaveLength(3);
      const retainedClaim = byId('action-panel').querySelector('input[name="intentText"]') as HTMLInputElement;
      retainedClaim.value = 'Unsubmitted lease intent';
      tick!(); await flush();
      expect(byId('action-panel').querySelector('input[name="intentText"]')).toBe(retainedClaim);
      expect(retainedClaim.value).toBe('Unsubmitted lease intent');
      changeStatus = 'merged'; snapshotVersion = 12; eventVersion = 12;
      tick!(); await flush(); await flush();
      expect(byId('detail-body').textContent).toContain('Status: merged');
      expect(byId('action-panel').textContent).not.toContain('Claim');
      expect(byId('action-panel').textContent).not.toContain('Enqueue');
      expect(byId('action-panel').textContent).not.toContain('Submit verdict');
      expect(byId('action-panel').querySelectorAll('form')).toHaveLength(0);
      eventVersion = 6; tick!(); await flush();
      expect(byId('event-log').textContent).not.toContain('stale.event');
    } finally {
      releaseSnapshot10?.();
      clearSessionToken();
      Object.assign(globalThis, previous);
      dom.window.close();
    }
  });
});

describe('layout and token contract', () => {
  it('documents the restored lease, queue, and action freshness fields', () => {
    const guide = readFileSync(new URL('../../docs/ui.md', import.meta.url), 'utf8');
    expect(guide).toContain('Active leases retain unit, change ID, state, holder');
    expect(guide).toContain('admitted revision, backend sequence, and blocked reason');
    expect(guide).toContain('including landed and withdrawn rows in a collapsed history');
    expect(guide).toContain('Actions remain disabled after a newer mutation or event version');
    const preRewrite = '025117692ae91d1dfd4b67cfc0cdb1e1833d97a3';
    expect(guide).toContain(`Field parity with the pre-rewrite panels (\`${preRewrite}\`)`);
    expect(guide).not.toContain('HEAD~3');
    expect(execFileSync('git', ['show', `${preRewrite}:web/index.html`], { encoding: 'utf8' })).toContain('id="enqueue-form"');
  });
  it('has a phone breakpoint, tabs, horizontal stat strip and 44px touch targets', () => {
    const css = readFileSync(new URL('../../web/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('@media(max-width:767px)');
    expect(css).toContain('.mobile-tabs');
    expect(css).toMatch(/\.stat-strip\{display:flex;overflow-x:auto/);
    expect(css).toContain('min-height:44px');
    expect(css).toContain('body{overflow-x:hidden}');
  });
  it('sends the token only in the authorization header', async () => {
    setSessionToken('secret');
    try {
      const seen: any[] = [];
      await apiFetch('/v1/me', {}, async (url: string, init: RequestInit) => {
        seen.push({ url, init }); return new Response(JSON.stringify({ data: {} }));
      });
      expect(seen[0].url).toBe('/v1/me');
      expect(new Headers(seen[0].init.headers).get('authorization')).toBe('Bearer secret');
      expect(seen[0].url).not.toContain('secret');
    } finally { clearSessionToken(); }
  });
  it('never sends credentials to an absolute or protocol-relative URL', async () => {
    setSessionToken('secret');
    try {
      for (const path of ['https://example.com/v1/me', '//example.com/v1/me', '/other']) {
        await expect(apiFetch(path, {}, () => { throw new Error('fetch must not run'); })).rejects.toMatchObject({ code: 'INVALID_PATH' });
      }
    } finally { clearSessionToken(); }
  });
  it('preserves only safe lease-conflict details', async () => {
    await expect(apiFetch('/v1/repos/demo/leases', {}, async () => new Response(JSON.stringify({ error: {
      code: 'LEASE_CONFLICT', message: 'Claim refused', details: { holderId: 'agent-a', intentText: 'Protect retry path',
        expiresAt: 1700000000000, unrelatedSecret: 'never expose' },
    } }), { status: 409 }))).rejects.toMatchObject({ status: 409, details: {
      holderId: 'agent-a', intentText: 'Protect retry path', expiresAt: 1700000000000,
    } });
  });
  it('redacts credential-shaped error text and drops arbitrary details', async () => {
    try {
      await apiFetch('/v1/me', {}, async () => new Response(JSON.stringify({ error: {
        code: 'FORBIDDEN', message: 'Bearer secret?token=hidden', details: { private: 'value' },
      } }), { status: 403 }));
      throw new Error('expected rejection');
    } catch (error) {
      expect(redactError(error).message).not.toContain('secret');
      expect((error as any).details).toBeNull();
    }
  });
  it('labels network failures and rejects them as successes', async () => {
    await expect(apiFetch('/v1/me', {}, async () => { throw new Error('offline'); })).rejects.toMatchObject({
      status: 0, code: 'NETWORK_UNREACHABLE', retryable: true,
    });
  });
  it('keeps authentication and authorization failures distinct', async () => {
    for (const [status, code] of [[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN']] as const) {
      await expect(apiFetch('/v1/me', {}, async () => new Response(JSON.stringify({ error: { code } }), { status })))
        .rejects.toMatchObject({ status, code });
    }
  });
  it('limits viewer actions while retaining reviewer verdict access', () => {
    expect(allowedActions(['viewer'])).toEqual({ claim: false, enqueue: false, withdraw: false, verdict: false });
    expect(allowedActions(['reviewer']).verdict).toBe(true);
    expect(allowedActions(['agent']).verdict).toBe(false);
  });
  it('mounts the issue editor shell beside the desk and inbox views', () => {
    const page = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
    expect(page).toContain('id="issue-view"');
    expect(page).toContain('id="issue-editor"');
    const css = readFileSync(new URL('../../web/styles.css', import.meta.url), 'utf8');
    expect(css).toContain('#issue-editor .issue-card');
    expect(css).toContain('.issue-tabs');
    expect(css).toContain('#issue-title');
    expect(css).toContain('.issue-unit button');
    expect(css).toContain('.issue-view');
    expect(css).toMatch(/#issue-list \.issue-card button\{[^}]*min-height:44px/);
    expect(css).toMatch(/\.issue-tabs button\{[^}]*min-height:44px/);
    expect(css).toMatch(/\.issue-unit button\{[^}]*min-height:44px/);
  });
});

describe('Issue API helpers', () => {
  it('fetches one issue, pages issues, patches with a version, and lists milestones', async () => {
    const seen: Array<{ url: string; init: any }> = [];
    const fetchImpl = (async (url: string, init: any) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ data: { number: 277 }, version: 3 }));
    }) as any;
    await getIssue('demo', 277, fetchImpl);
    expect(seen[0].url).toBe('/v1/repos/demo/issues/277');
    await listIssues('demo', { state: 'open', limit: 100 }, fetchImpl);
    expect(seen[1].url).toBe('/v1/repos/demo/issues?state=open&limit=100');
    await updateIssue('demo', 277, { expectedVersion: 3, title: 'New' }, 'key-1', fetchImpl);
    expect(seen[2].url).toBe('/v1/repos/demo/issues/277');
    expect(seen[2].init.method).toBe('PATCH');
    expect(JSON.parse(String(seen[2].init.body))).toEqual({ expectedVersion: 3, title: 'New' });
    expect(new Headers(seen[2].init.headers).get('idempotency-key')).toBe('key-1');
    await listMilestones('demo', fetchImpl);
    expect(seen[3].url).toBe('/v1/repos/demo/milestones');
  });
});

describe('Issue editor derivations', () => {
  it('parses file, section, row, and unknown unit entries', () => {
    expect(parseUnitEntry('src/attention.py')).toMatchObject({ kind: 'file', file: 'src/attention.py' });
    expect(parseUnitEntry('docs/architecture.md § Components')).toMatchObject({ kind: 'section', file: 'docs/architecture.md' });
    expect(parseUnitEntry('row:families:alpha')).toMatchObject({ kind: 'row', key: 'row:families:alpha' });
    expect(parseUnitEntry('/absolute/path')).toMatchObject({ kind: 'unknown' });
    expect(parseUnitEntry('has spaces')).toMatchObject({ kind: 'unknown' });
    expect(parseUnitEntry('  ')).toMatchObject({ kind: 'empty' });
  });
  it('marks units free or held from live leases only', () => {
    const now = Date.now();
    const leases = [
      { unitKey: 'file:src/attention.py', holderId: 'agent-a', changeId: 'x', issueNumber: 277, issueTitle: 'D3', state: 'active', expiresAt: now + 60000 },
      { unitKey: 'file:docs/architecture.md', holderId: 'agent-b', changeId: 'y', issueNumber: 280, state: 'reserved', expiresAt: now + 60000 },
      { unitKey: 'row:families:alpha', holderId: 'agent-c', changeId: 'z', issueNumber: 281, state: 'active', expiresAt: now - 1000 },
    ];
    const held = unitLeaseState(parseUnitEntry('src/attention.py'), leases, now);
    expect(held.state).toBe('held');
    expect(held.holders[0]).toMatchObject({ holderId: 'agent-a', issueNumber: 277 });
    // A whole-file lease covers a section entry of the same file.
    expect(unitLeaseState(parseUnitEntry('docs/architecture.md § Components'), leases, now).state).toBe('held');
    // Expired rows do not hold.
    expect(unitLeaseState(parseUnitEntry('row:families:alpha'), leases, now).state).toBe('free');
    expect(unitLeaseState(parseUnitEntry('src/other.py'), leases, now)).toEqual({ state: 'free', holders: [] });
    // Symmetric file comparison: a file entry sees a section-keyed lease of the same file.
    const sectionLease = [{ unitKey: 'src/other.py § Top', holderId: 'agent-d', changeId: 'w', state: 'active', expiresAt: now + 60000 }];
    expect(unitLeaseState(parseUnitEntry('src/other.py'), sectionLease, now).state).toBe('held');
  });
  it('finds overlapping open issues with a plain explanation', () => {
    const mine: any = { number: 277, state: 'open', allowedFiles: ['src/attention.py', 'docs/architecture.md § Components'] };
    const others: any[] = [
      { number: 280, title: 'D5', state: 'open', allowedFiles: ['docs/architecture.md § Storage'] },
      { number: 281, title: 'J1b', state: 'open', allowedFiles: ['src/unrelated.py'] },
      { number: 270, title: 'Old', state: 'closed', allowedFiles: ['src/attention.py'] },
    ];
    const overlaps = issueOverlaps(mine, others);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].number).toBe(280);
    expect(overlaps[0].explanation).toContain('#280 also declares');
    expect(overlaps[0].explanation).toContain('whichever agent starts first');
    expect(issueOverlaps({ number: 1, state: 'open', allowedFiles: [] }, others)).toEqual([]);
  });
  it('renders the exact agent spec from API fields only', () => {
    const text = agentSpecText({ number: 277, title: 'D3', state: 'open', body: '## Done', labels: ['a'],
      allowedFiles: ['src/x.py'], changes: [{ changeId: 'x', status: 'ready' }] }, 'V1');
    expect(text).toContain('issue: 277');
    expect(text).toContain('milestone: V1');
    expect(text).toContain('- src/x.py');
    expect(text).toContain('## Done');
    expect(text).toContain('- x: ready');
    expect(agentSpecText({ number: 1, title: 'T', state: 'open' }, null)).toContain('(none declared)');
  });
  it('builds the timeline from issue and linked-change events in order', () => {
    const events = [
      { sequence: 9, kind: 'change.published', actorId: 'agent-a', version: 2, timestamp: 1700000009000, relatedIds: ['x'] },
      { sequence: 2, kind: 'issue.created', actorId: 'owner', version: 1, timestamp: 1700000002000, relatedIds: ['277'] },
      { sequence: 5, kind: 'queue.promotion_applied', actorId: 'system', version: 2, timestamp: 1700000005000, relatedIds: ['other'] },
    ];
    const timeline = issueTimeline(277, [{ changeId: 'x' }], events);
    expect(timeline.map((entry: any) => entry.sequence)).toEqual([2, 9]);
    expect(timeline[0]).toMatchObject({ kind: 'issue.created', actorId: 'owner' });
  });
  it('previews markdown while rendering markup literally', () => {
    const html = renderMarkdown('## Outcome\n- one\n- two\n<script>alert(1)</script>');
    expect(html).toContain('<li>one</li>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(renderMarkdown('```\ncode\n```')).toContain('<pre><code>');
  });
  it('parses and formats labels without duplicates', () => {
    expect(parseLabelsInput('a, b, a,')).toEqual(['a', 'b']);
    expect(formatLabelsInput(['a', 'b'])).toBe('a, b');
  });
});

describe('Issue editor DOM', () => {
  const issueData = {
    number: 277, title: 'D3: discovery attention scores', body: '## Outcome\nScore filings.',
    labels: ['discovery'], milestoneId: 'm1', allowedFiles: ['src/attention.py', 'docs/architecture.md § Components'],
    state: 'open', version: 3, authorId: 'owner', changes: [{ changeId: 'x', status: 'ready' }],
  };
  const stubSnapshot = (leases: any[] = []) => ({ data: { projections: {
    leases: { heldItems: leases },
    issues: { items: [
      { ...issueData },
      { number: 280, title: 'D5', state: 'open', allowedFiles: ['docs/architecture.md § Storage'] },
    ] },
    repos: { changes: [{ changeId: 'x', status: 'ready', dependencyChangeIds: ['dep-1'] }] },
  } }, version: 3 });
  const stubEvents = () => ({ data: { items: [
    { sequence: 2, kind: 'issue.created', actorId: 'owner', version: 1, timestamp: 1700000002000, relatedIds: ['277'] },
    { sequence: 9, kind: 'change.published', actorId: 'agent-a', version: 2, timestamp: 1700000009000, relatedIds: ['x'] },
  ], version: 1 } });
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  async function mount(overrides: Record<string, any> = {}) {
    // Local JSDOM only: the editor works off root.ownerDocument, so these
    // tests never touch the globals the fleet-desk test above relies on.
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    const root = dom.window.document.createElement('div');
    dom.window.document.body.append(root);
    const patches: Array<{ body: any }> = [];
    let serverIssue: any = structuredClone(issueData);
    const api = {
      getIssue: async () => ({ data: structuredClone(serverIssue), version: serverIssue.version }),
      listMilestones: async () => ({ data: { items: [{ milestoneId: 'm1', title: 'V1' }] } }),
      listIssues: async () => ({ data: { items: [
        { ...structuredClone(serverIssue) },
        { number: 280, title: 'D5', state: 'open', allowedFiles: ['docs/architecture.md § Storage'] },
      ], nextCursor: null } }),
      getSnapshot: async () => stubSnapshot(overrides.leases ?? []),
      getEvents: async () => stubEvents(),
      updateIssue: async (_repo: string, _number: number, body: any, _key: string) => {
        patches.push({ body });
        if (overrides.updateImpl) return overrides.updateImpl(body, serverIssue);
        serverIssue = { ...serverIssue, ...body, version: serverIssue.version + 1 };
        delete (serverIssue as any).expectedVersion;
        return { data: structuredClone(serverIssue), version: serverIssue.version };
      },
      newIdempotencyKey: () => 'key-1',
      ...overrides.api,
    };
    const editor = createIssueEditor(root, api, overrides.hooks ?? {});
    await editor.open('demo', 277);
    await flush(); await flush();
    return { dom, root, editor, patches, get serverIssue() { return serverIssue; }, setServerIssue(value: any) { serverIssue = value; } };
  }
  function unmount(mounted: Awaited<ReturnType<typeof mount>>) {
    mounted.dom.window.close();
  }

  it('renders fixture data with tabs, live units, overlaps, and timeline', async () => {
    const mounted = await mount({ leases: [
      { unitKey: 'file:src/attention.py', holderId: 'agent-a', changeId: 'x', issueNumber: 277, state: 'active', expiresAt: Date.now() + 60000 },
    ] });
    try {
      const doc = mounted.dom.window.document;
      expect((doc.getElementById('issue-title') as HTMLInputElement).value).toBe('D3: discovery attention scores');
      expect(doc.getElementById('issue-body')).toBeTruthy();
      (doc.getElementById('issue-tab-preview') as HTMLButtonElement).click();
      expect(doc.querySelector('.issue-preview')?.textContent).toContain('Score filings.');
      (doc.getElementById('issue-tab-agent') as HTMLButtonElement).click();
      const agent = doc.getElementById('issue-agent-view')?.textContent ?? '';
      expect(agent).toContain('issue: 277');
      expect(agent).toContain('- src/attention.py');
      expect(agent).toContain('- x: ready');
      expect(doc.body.textContent).toContain('held by agent-a · issue #277 · change x');
      expect(doc.body.textContent).toContain('free · no live lease covers it');
      expect(doc.body.textContent).toContain('#280 D5');
      expect(doc.body.textContent).toContain('whichever agent starts first');
      expect(doc.querySelector('.issue-timeline')?.textContent).toContain('issue.created');
      expect(doc.querySelector('.issue-timeline')?.textContent).toContain('change.published');
    } finally { unmount(mounted); }
  });

  it('adds and removes units in the draft and saves them with the version', async () => {
    const mounted = await mount();
    try {
      const doc = mounted.dom.window.document;
      (doc.getElementById('issue-addunit') as HTMLInputElement).value = 'row:families:alpha';
      doc.getElementById('issue-addunit')!.dispatchEvent(new mounted.dom.window.Event('input', { bubbles: true }));
      (doc.getElementById('issue-add') as HTMLButtonElement).click();
      expect(doc.body.textContent).toContain('row:families:alpha');
      (doc.getElementById('issue-addunit') as HTMLInputElement).value = 'row:families:alpha';
      doc.getElementById('issue-addunit')!.dispatchEvent(new mounted.dom.window.Event('input', { bubbles: true }));
      (doc.getElementById('issue-add') as HTMLButtonElement).click();
      expect(doc.getElementById('issue-status')?.textContent).toContain('Already listed');
      const remove = doc.querySelector('[aria-label="Remove src/attention.py"]') as HTMLButtonElement;
      remove.click();
      expect(doc.body.textContent).not.toContain('src/attention.py');
      (doc.getElementById('issue-save') as HTMLButtonElement).click();
      await flush(); await flush();
      expect(mounted.patches).toHaveLength(1);
      expect(mounted.patches[0].body).toMatchObject({ expectedVersion: 3, title: 'D3: discovery attention scores' });
      expect(mounted.patches[0].body.allowedFiles).toEqual(['docs/architecture.md § Components', 'row:families:alpha']);
      expect(doc.getElementById('issue-status')?.textContent).toContain('Saved.');
    } finally { unmount(mounted); }
  });

  it('merges on a stale version instead of overwriting', async () => {
    let calls = 0;
    const mounted = await mount({ updateImpl: (body: any, server: any) => {
      calls++;
      if (calls === 1) throw new ApiError(409, 'STALE_VERSION', 'Object version is stale', null, false, { currentVersion: 4 });
      return { data: { ...server, ...body, version: 4 }, version: 4 };
    } });
    try {
      const doc = mounted.dom.window.document;
      (doc.getElementById('issue-title') as HTMLInputElement).value = 'Mine';
      doc.getElementById('issue-title')!.dispatchEvent(new mounted.dom.window.Event('input', { bubbles: true }));
      mounted.setServerIssue({ ...mounted.serverIssue, title: 'Theirs', version: 4 });
      (doc.getElementById('issue-save') as HTMLButtonElement).click();
      await flush(); await flush(); await flush();
      expect(doc.body.textContent).toContain('Newer version on the server');
      expect(doc.body.textContent).toContain('Theirs');
      (doc.getElementById('issue-keep-mine') as HTMLButtonElement).click();
      await flush(); await flush(); await flush();
      expect(calls).toBe(2);
      expect(mounted.patches[1].body).toMatchObject({ expectedVersion: 4, title: 'Mine' });
      expect(doc.body.textContent).not.toContain('Newer version on the server');
    } finally { unmount(mounted); }
  });

  it('discards the draft for the server version on request', async () => {
    const mounted = await mount({ updateImpl: () => {
      throw new ApiError(409, 'STALE_VERSION', 'Object version is stale', null, false, { currentVersion: 4 });
    } });
    try {
      const doc = mounted.dom.window.document;
      mounted.setServerIssue({ ...mounted.serverIssue, title: 'Theirs', version: 4 });
      (doc.getElementById('issue-save') as HTMLButtonElement).click();
      await flush(); await flush(); await flush();
      (doc.getElementById('issue-use-server') as HTMLButtonElement).click();
      expect((doc.getElementById('issue-title') as HTMLInputElement).value).toBe('Theirs');
      expect(doc.body.textContent).not.toContain('Newer version on the server');
    } finally { unmount(mounted); }
  });

  it('keeps polls cheap, backfills the timeline, and never re-renders under a text field', async () => {
    let renders = 0;
    const mounted = await mount({ hooks: { onRender: () => { renders++; } } });
    try {
      const doc = mounted.dom.window.document;
      const settled = renders;
      mounted.editor.setLive();
      expect(renders).toBe(settled + 1);
      mounted.editor.setLive();
      expect(renders).toBe(settled + 1);
      const extra = [{ sequence: 12, kind: 'issue.reopened', actorId: 'owner', version: 4, timestamp: 1700000012000, relatedIds: ['277'] }];
      mounted.editor.setLive({ events: extra });
      expect(renders).toBe(settled + 2);
      expect(doc.querySelector('.issue-timeline')?.textContent).toContain('issue.reopened');
      const area = doc.getElementById('issue-body') as HTMLTextAreaElement;
      area.focus();
      const more = [{ sequence: 13, kind: 'issue.closed', actorId: 'owner', version: 5, timestamp: 1700000013000, relatedIds: ['277'] }];
      mounted.editor.setLive({ events: more });
      expect(renders).toBe(settled + 2);
      expect(doc.getElementById('issue-body')).toBe(area);
      expect(doc.activeElement).toBe(area);
    } finally { unmount(mounted); }
  });

  it('keeps id-less leases distinct and prefers newer versions on reopen', async () => {
    let holder = 'agent-a';
    let version = 1;
    const rows = () => stubSnapshot([
      { leaseId: 'l1', unitKey: 'file:src/attention.py', holderId: holder, changeId: 'x', issueNumber: 277, state: 'active', expiresAt: Date.now() + 60000, version },
      { unitKey: 'file:docs/architecture.md', holderId: 'agent-b', changeId: 'y', issueNumber: 280, state: 'reserved', expiresAt: Date.now() + 60000 },
    ]);
    const mounted = await mount({ api: { getSnapshot: async () => rows() } });
    try {
      const doc = mounted.dom.window.document;
      expect(doc.body.textContent).toContain('held by agent-a · issue #277 · change x');
      expect(doc.body.textContent).toContain('held by agent-b · issue #280 · change y');
      holder = 'agent-c'; version = 2;
      await mounted.editor.open('demo', 277);
      expect(doc.body.textContent).toContain('held by agent-c · issue #277 · change x');
      expect(doc.body.textContent).toContain('held by agent-b · issue #280 · change y');
    } finally { unmount(mounted); }
  });

  it('names missing linked changes in Depends on instead of staying silent', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    try {
      const root = dom.window.document.createElement('div');
      dom.window.document.body.append(root);
      const ghost = { ...issueData, changes: [{ changeId: 'x', status: 'ready' }, { changeId: 'ghost', status: 'ready' }] };
      const editor = createIssueEditor(root, {
        getIssue: async () => ({ data: structuredClone(ghost), version: 3 }),
        listMilestones: async () => ({ data: { items: [] } }),
        listIssues: async () => ({ data: { items: [structuredClone(ghost)], nextCursor: null } }),
        getSnapshot: async () => ({ data: { projections: { leases: {}, issues: { items: [] },
          repos: { changes: [{ changeId: 'x', status: 'ready', dependencyChangeIds: ['dep-1'] }] } } }, version: 1 }),
        getEvents: async () => ({ data: { items: [] } }),
        updateIssue: async () => { throw new Error('unreachable'); },
        newIdempotencyKey: () => 'key-1',
      });
      await editor.open('demo', 277);
      await flush(); await flush();
      const disabled = [...dom.window.document.querySelectorAll('.issue-details input')]
        .filter((el) => (el as HTMLInputElement).disabled);
      expect(disabled.map((el) => (el as HTMLInputElement).value)).toContain('dep-1 (+1 linked change not in snapshot)');
      const alone = dom.window.document.createElement('div');
      dom.window.document.body.append(alone);
      const solo = { ...issueData, changes: [{ changeId: 'ghost', status: 'ready' }] };
      const second = createIssueEditor(alone, {
        getIssue: async () => ({ data: structuredClone(solo), version: 3 }),
        listMilestones: async () => ({ data: { items: [] } }),
        listIssues: async () => ({ data: { items: [structuredClone(solo)], nextCursor: null } }),
        getSnapshot: async () => ({ data: { projections: { leases: {}, issues: { items: [] }, repos: { changes: [] } } }, version: 1 }),
        getEvents: async () => ({ data: { items: [] } }),
        updateIssue: async () => { throw new Error('unreachable'); },
        newIdempotencyKey: () => 'key-1',
      });
      await second.open('demo', 277);
      await flush(); await flush();
      const soloDisabled = [...alone.querySelectorAll('.issue-details input')]
        .filter((el) => (el as HTMLInputElement).disabled);
      expect(soloDisabled.map((el) => (el as HTMLInputElement).value)).toContain('(+1 linked change not in snapshot)');
    } finally {
      dom.window.close();
    }
  });

  it('shows the server refusal reason when a save is rejected', async () => {
    const mounted = await mount({ updateImpl: () => {
      throw new ApiError(422, 'INVALID_LABELS', 'labels must be unique strings', null, false, null);
    } });
    try {
      const doc = mounted.dom.window.document;
      (doc.getElementById('issue-save') as HTMLButtonElement).click();
      await flush(); await flush();
      expect(doc.getElementById('issue-status')?.textContent).toContain('INVALID_LABELS');
    } finally { unmount(mounted); }
  });

  it('covers empty and error states without sample data', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
    try {
      const root = dom.window.document.createElement('div');
      dom.window.document.body.append(root);
      const empty = { ...issueData, allowedFiles: [], labels: [], milestoneId: null, changes: [] };
      const editor = createIssueEditor(root, {
        getIssue: async () => ({ data: structuredClone(empty), version: 3 }),
        listMilestones: async () => ({ data: { items: [] } }),
        listIssues: async () => ({ data: { items: [structuredClone(empty)], nextCursor: null } }),
        getSnapshot: async () => ({ data: { projections: { leases: {}, issues: { items: [] }, repos: {} } }, version: 1 }),
        getEvents: async () => ({ data: { items: [] } }),
        updateIssue: async () => { throw new Error('unreachable'); },
        newIdempotencyKey: () => 'key-1',
      });
      await editor.open('demo', 277);
      await flush(); await flush();
      expect(docBody(dom)).toContain('No units declared');
      expect(docBody(dom)).toContain('Declare units above');
      expect(docBody(dom)).toContain('No observed events');
      (dom.window.document.getElementById('issue-tab-agent') as HTMLButtonElement).click();
      expect(docBody(dom)).toContain('(none declared)');
      const failing = dom.window.document.createElement('div');
      dom.window.document.body.append(failing);
      const broken = createIssueEditor(failing, {
        getIssue: async () => { throw new ApiError(0, 'NETWORK_UNREACHABLE', 'offline', null, true, null); },
        listMilestones: async () => ({ data: { items: [] } }),
        listIssues: async () => ({ data: { items: [] } }),
        getSnapshot: async () => ({}),
        getEvents: async () => ({}),
        updateIssue: async () => { throw new Error('unreachable'); },
        newIdempotencyKey: () => 'key-1',
      });
      await broken.open('demo', 999);
      await flush(); await flush();
      expect(failing.textContent).toContain('Could not load issue #999 (NETWORK_UNREACHABLE)');
    } finally {
      dom.window.close();
    }
  });
});

function docBody(dom: any): string {
  return dom.window.document.body.textContent ?? '';
}
