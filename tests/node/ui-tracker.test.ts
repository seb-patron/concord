import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;
const { trackerModel, createTracker, appendObservedEvents, observedDailyCount } = require('../../web/tracker.js') as any;
const { clearSessionToken, setSessionToken } = require('../../web/api.js') as any;
const { createVerdictLoader } = require('../../web/verdicts.js') as any;

function waitForText(root: Element, text: string) {
  if (root.textContent?.includes(text)) return Promise.resolve();
  return new Promise<void>(resolve => {
    const Observer = root.ownerDocument.defaultView!.MutationObserver;
    const observer = new Observer(() => {
      if (root.textContent?.includes(text)) { observer.disconnect(); resolve(); }
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
  });
}

describe('Repository tracker', () => {
  const now = new Date('2026-10-12T15:00:00Z').valueOf();
  const data = { data: { projections: {
    issues: { items: [
      { number: 1, title: 'Free <work>', state: 'open', milestoneId: 'm', allowedFiles: ['web/free.js'], labels: [], changes: [], authorId: 'owner', version: 1 },
      { number: 2, title: 'Held work', state: 'open', milestoneId: 'm', allowedFiles: ['web/held.js'], labels: [], changes: [{ changeId: 'c2', status: 'draft' }], authorId: 'owner', version: 2 },
      { number: 3, title: 'Review work', state: 'open', milestoneId: 'm', labels: [], changes: [{ changeId: 'c3', status: 'ready' }] },
      { number: 4, title: 'Queued work', state: 'open', milestoneId: 'm', labels: [], changes: [{ changeId: 'c4', status: 'ready' }] },
      { number: 5, title: 'Landed work', state: 'closed', milestoneId: 'm', labels: [], closedBy: { changeId: 'c5' }, changes: [{ changeId: 'c5', status: 'merged' }] },
      { number: 6, title: 'Manual wait', state: 'open', milestoneId: 'm', labels: ['friction'], body: '6 minutes', authorId: 'owner' },
    ], milestones: [{ milestoneId: 'm', title: 'Release', state: 'open' }] },
    repos: { changes: [
      { changeId: 'c2', issueNumber: 2, authorId: 'agent-a', authorModel: 'Codex', status: 'draft', unitKeys: ['fn:held'] },
      { changeId: 'c3', issueNumber: 3, authorId: 'agent-b', status: 'ready', unitKeys: ['fn:review'] },
      { changeId: 'c4', issueNumber: 4, authorId: 'agent-c', status: 'ready', unitKeys: ['fn:queue'] },
      { changeId: 'c5', issueNumber: 5, authorId: 'agent-d', status: 'merged', unitKeys: ['fn:land'] },
    ] },
    leases: { heldItems: [{ changeId: 'c2', issueNumber: 2, holderId: 'agent-a', unitKey: 'fn:held', state: 'active', expiresAt: now + 120000 }] },
    queue: { entries: [{ changeId: 'c4', state: 'reserved', verdictId: 'v4' }, { changeId: 'c5', state: 'landed' }] },
  } } };
  const events = [
    { sequence: 1, kind: 'lease.claimed', timestamp: now, relatedIds: ['c2'], actorId: 'agent-a' },
    { sequence: 2, kind: 'lease.refused', timestamp: now, relatedIds: ['c2'], actorId: 'agent-b' },
    { sequence: 3, kind: 'queue.entry_blocked', timestamp: now, relatedIds: ['old-change'], payload: { reason: 'STALE_MAIN' }, actorId: 'concord' },
    { sequence: 4, kind: 'verdict.carried', timestamp: now, relatedIds: ['v4', 'v-old', 'job-4'], actorId: 'reviewer' },
    { sequence: 5, kind: 'queue.promotion_applied', timestamp: now, relatedIds: ['c5'], actorId: 'concord' },
  ];
  it('derives five lanes, live holds, event counts, and friction without sample cards', () => {
    const model = trackerModel(data, events, { principalId: 'agent-a' }, 'm', now, [], {
      c4: [{ verdictId: 'v4', changeId: 'c4', parentVerdictId: 'v-old', deltaResultId: 'job-4' }],
    });
    expect(model.cards.map((card: any) => card.stage)).toEqual(['Ready to claim', 'Claimed', 'Checking & review', 'Queued', 'Landed']);
    expect(model.cards[0].units).toEqual(['web/free.js']);
    expect(model.cards[1]).toMatchObject({ holder: 'agent-a', harness: 'Codex', meta: '2m left' });
    expect(model.cards[3].meta).toBe('carried approval');
    expect(model.cards[3].timeline.map((event: any) => event.kind)).toContain('verdict.carried');
    expect(model.stats.map((stat: any) => stat[1])).toEqual([1, 1, 1, 1, 1]);
    expect(model.friction.map((row: any) => row.what)).toContain('Manual wait');
  });
  it('does not put manually closed issues back into Ready', () => {
    const snapshot = structuredClone(data) as any;
    snapshot.data.projections.issues.items.push({ number: 7, title: 'Closed by owner', state: 'closed',
      closedBy: null, milestoneId: 'm', labels: [] });
    const model = trackerModel(snapshot, [], null, 'm', now);
    expect(model.cards.map((card: any) => card.issue.number)).not.toContain(7);
    expect(model.cards.find((card: any) => card.issue.number === 5).stage).toBe('Landed');
  });
  it('labels a queue entry from its admitted verdict, not an older carry', () => {
    const snapshot = structuredClone(data) as any;
    snapshot.data.projections.queue.entries[0].verdictId = 'v-direct';
    const model = trackerModel(snapshot, events, null, 'm', now, [], { c4: [
      { verdictId: 'v4', changeId: 'c4', parentVerdictId: 'v-old', deltaResultId: 'job-4' },
      { verdictId: 'v-direct', changeId: 'c4', parentVerdictId: null, deltaResultId: null },
    ] });
    expect(model.cards[3].stage).toBe('Queued');
    expect(model.cards[3].meta).not.toBe('carried approval');
  });
  it('shows each live unit with its own holder and includes both in Mine', () => {
    const snapshot = structuredClone(data) as any;
    snapshot.data.projections.leases.heldItems = [
      { changeId: 'c2', issueNumber: 2, holderId: 'alice', unitKey: 'u:a', state: 'active', expiresAt: Math.max(now, Date.now()) + 120000 },
      { changeId: 'c2', issueNumber: 2, holderId: 'bob', unitKey: 'u:b', state: 'active', expiresAt: Math.max(now, Date.now()) + 120000 },
    ];
    const model = trackerModel(snapshot, [], { principalId: 'bob' }, 'm', now);
    expect(model.working).toEqual([
      { issue: snapshot.data.projections.issues.items[1], holder: 'alice', units: ['u:a'] },
      { issue: snapshot.data.projections.issues.items[1], holder: 'bob', units: ['u:b'] },
    ]);
    const dom = new JSDOM('<main id="tracker"></main>');
    const previous = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      const root = dom.window.document.getElementById('tracker')!;
      const tracker = createTracker(root, { refresh: async () => {} });
      tracker.render({ repoId: 'repo', snapshot, events: [], identity: { principalId: 'bob' } });
      expect(root.querySelector('.tracker-working')?.textContent).toContain('#2 · alice · u:a');
      expect(root.querySelector('.tracker-working')?.textContent).toContain('#2 · bob · u:b');
      expect(root.querySelectorAll('.tracker-card')[1].textContent).toContain('u:b · bob');
      (root.querySelectorAll('.tracker-filters button')[3] as HTMLButtonElement).click();
      expect(root.querySelectorAll('.tracker-card')).toHaveLength(1);
    } finally { globalThis.document = previous; dom.window.close(); }
  });
  it('counts lease holders across midnight and links all four live lease records', () => {
    const before = new Date('2026-10-12T23:58:00').valueOf();
    const after = new Date('2026-10-13T00:02:00').valueOf();
    const snapshot = structuredClone(data) as any;
    snapshot.data.projections.leases.heldItems = [
      ...Array.from({ length: 3 }, (_, index) => ({ leaseId: `a${index}`, changeId: 'c2', holderId: 'a', unitKey: `u${index}`, state: 'active', expiresAt: after + 60000 })),
      { leaseId: 'b', changeId: 'c2', holderId: 'b', unitKey: 'ub', state: 'reserved', expiresAt: after + 60000 },
    ];
    for (const now of [before, after]) {
      const tile = trackerModel(snapshot, [], null, 'm', now).stats[0];
      expect(tile[1]).toBe(2);
      expect(tile[2].map((lease: any) => lease.leaseId)).toEqual(['a0', 'a1', 'a2', 'b']);
    }
  });
  it('counts all 2,001 events while retaining only 500 events and 40 evidence records', () => {
    const refusals = Array.from({ length: 2001 }, (_, index) => ({ sequence: index + 1, kind: 'lease.refused',
      timestamp: now, relatedIds: ['c2'] }));
    const observed = appendObservedEvents(appendObservedEvents([], refusals.slice(0, 1000)), refusals.slice(1000));
    const model = trackerModel(data, observed, null, 'm', now);
    expect(observed).toHaveLength(500);
    const tile = model.stats.find((stat: any) => stat[0] === 'Collisions avoided');
    expect(tile[1]).toBe(2001);
    expect(tile[2]).toHaveLength(40);
  });
  it('uses exact daily landed counts after the capped event evidence rolls over', () => {
    const promotions = Array.from({ length: 501 }, (_, index) => ({ sequence: index + 1,
      kind: 'queue.promotion_applied', timestamp: now, relatedIds: [`change-${index}`] }));
    const observed = appendObservedEvents([], promotions);
    expect(observed).toHaveLength(500);
    expect(observedDailyCount(observed, 'Landed today', now)).toBe(501);
  });
  it('derives every swarm tile from its current supporting record across midnight and event pages', () => {
    const midnight = new Date('2026-10-13T00:02:00').valueOf();
    const snapshot = structuredClone(data) as any;
    snapshot.data.projections.leases.heldItems[0].expiresAt = midnight + 120000;
    snapshot.data.projections.leases.heldItems[0].leaseId = 'lease-midnight';
    snapshot.data.projections.issues.items.push({ number: 7, title: 'Repaired', state: 'open', milestoneId: 'm', labels: [] });
    snapshot.data.projections.repos.changes.push(
      { changeId: 'old', issueNumber: 7, status: 'blocked', revision: 1 },
      { changeId: 'new', issueNumber: 7, status: 'draft', revision: 2 });
    snapshot.data.projections.queue.entries.push({ changeId: 'old', admittedRevision: 1, state: 'blocked', blockedReason: 'STALE_MAIN' });
    const records = [
      { sequence: 10, kind: 'lease.refused', timestamp: midnight, relatedIds: ['c2'] },
      { sequence: 11, kind: 'queue.entry_blocked', timestamp: midnight, relatedIds: ['old'], payload: { reason: 'STALE_MAIN' } },
      { sequence: 12, kind: 'verdict.carried', timestamp: midnight, relatedIds: ['v4'] },
      { sequence: 13, kind: 'queue.promotion_applied', timestamp: midnight, relatedIds: ['c5'] },
      { sequence: 14, kind: 'runner.result', timestamp: midnight, relatedIds: ['inspect-job'], payload: { outcome: 'FAIL' } },
    ];
    const irrelevant = Array.from({ length: 600 }, (_, i) => ({ sequence: i + 15, kind: 'issue.updated', timestamp: midnight, relatedIds: ['1'] }));
    const observed = appendObservedEvents([], [...records, ...irrelevant]);
    const model = trackerModel(snapshot, observed, null, 'm', midnight);
    const stats = model.stats;
    const cases = [
      ['Agents working', 1, 'lease-midnight'],
      ['Collisions avoided', 1, 10],
      ['Stale main blocks', 1, 11],
      ['Approvals carried', 1, 12],
      ['Landed today', 1, 13],
    ] as const;
    for (const [label, value, id] of cases) {
      const tile = stats.find((item: any) => item[0] === label);
      expect(tile?.[1], label).toBe(value);
      expect(tile?.[2].some((record: any) => record.leaseId === id || record.sequence === id), label).toBe(true);
    }
    expect(observed.length).toBeLessThanOrEqual(500);
    expect(stats[0][2][0].expiresAt).toBeGreaterThan(midnight);
    expect(model.cards.find((card: any) => card.issue.number === 7)?.stage).toBe('Awaiting claim');
    expect(model.friction.some((row: any) => row.event?.kind === 'runner.result')).toBe(false);
    expect(trackerModel(snapshot, records, null, 'm', midnight).friction.some((row: any) => row.event?.kind === 'runner.result')).toBe(true);
  });
  it('uses the current change revision and blocked reason after a repaired draft', () => {
    const snapshot = structuredClone(data) as any;
    snapshot.data.projections.issues.items.push({ number: 7, title: 'Repaired', state: 'open', milestoneId: 'm', labels: [] });
    snapshot.data.projections.repos.changes.push(
      { changeId: 'old', issueNumber: 7, status: 'blocked', revision: 1 },
      { changeId: 'new', issueNumber: 7, status: 'draft', revision: 2 });
    snapshot.data.projections.queue.entries.push({ changeId: 'old', admittedRevision: 1, state: 'blocked', blockedReason: 'STALE_MAIN' });
    let card = trackerModel(snapshot, [], null, 'm', now).cards.find((item: any) => item.issue.number === 7);
    expect(card.stage).toBe('Awaiting claim');
    expect(card.meta).not.toBe('STALE_MAIN');
    snapshot.data.projections.queue.entries.push({ changeId: 'new', admittedRevision: 1, state: 'blocked', blockedReason: 'OLD_REVISION' });
    card = trackerModel(snapshot, [], null, 'm', now).cards.find((item: any) => item.issue.number === 7);
    expect(card.stage).toBe('Awaiting claim');
    snapshot.data.projections.queue.entries.push({ changeId: 'new', admittedRevision: 2, state: 'blocked', blockedReason: 'CHECK_FAILED' });
    snapshot.data.projections.repos.changes.at(-1).status = 'ready';
    card = trackerModel(snapshot, [], null, 'm', now).cards.find((item: any) => item.issue.number === 7);
    expect(card).toMatchObject({ stage: 'Blocked', meta: 'CHECK_FAILED' });
  });
  it('uses the newest terminal change when an older withdrawn attempt has a blocked entry', () => {
    const snapshot = structuredClone(data) as any;
    snapshot.data.projections.issues.items.push({ number: 10, title: 'Withdrawn then closed', state: 'open', milestoneId: 'm', labels: [] });
    snapshot.data.projections.repos.changes.push(
      { changeId: 'withdrawn-old', issueNumber: 10, status: 'withdrawn', revision: 1 },
      { changeId: 'closed-new', issueNumber: 10, status: 'closed', revision: 2 });
    snapshot.data.projections.queue.entries.push({ changeId: 'withdrawn-old', state: 'blocked', revision: 1, blockedReason: 'STALE_MAIN' });
    expect(trackerModel(snapshot, [], null, 'm', now).cards.find((card: any) => card.issue.number === 10))
      .toMatchObject({ stage: 'Ready to claim', change: { changeId: 'closed-new' } });
  });
  it('classifies lane rules by current revision and state priority', () => {
    const cases = [
      ['reserved ready', 'ready', 'reserved', 2, 'Queued'],
      ['blocked entry before ready', 'ready', 'blocked', 2, 'Blocked'],
      ['landed entry before merged status', 'ready', 'landed', 2, 'Landed'],
      ['ready after inspection', 'ready', undefined, 2, 'Checking & review'],
      ['checking entry', 'checking', 'checking', 2, 'Checking & review'],
      ['queued change', 'queued', undefined, 2, 'Queued'],
      ['draft awaits lease', 'draft', undefined, 2, 'Awaiting claim'],
    ] as const;
    for (const [label, status, queueState, revision, expected] of cases) {
      const snapshot = structuredClone(data) as any;
      snapshot.data.projections.issues.items.push({ number: 7, title: label, state: 'open', milestoneId: 'm', labels: [] });
      snapshot.data.projections.repos.changes.push({ changeId: 'case', issueNumber: 7, status, revision });
      if (queueState) snapshot.data.projections.queue.entries.push({ changeId: 'case', revision, state: queueState, blockedReason: 'CHECK_FAILED' });
      const card = trackerModel(snapshot, [], null, 'm', now).cards.find((item: any) => item.issue.number === 7);
      expect(card.stage, label).toBe(expected);
    }
    const manuallyClosed = structuredClone(data) as any;
    manuallyClosed.data.projections.issues.items.push({ number: 9, state: 'closed', closedBy: null, labels: [] });
    expect(trackerModel(manuallyClosed, [], null, 'm', now).cards.some((card: any) => card.issue.number === 9)).toBe(false);
  });
  it('describes Checking & review as pending inspection or review, never a finished main check', () => {
    const model = trackerModel(data, events, null, 'm', now);
    const card = model.cards.find((item: any) => item.issue.number === 3);
    expect(card.change.status).toBe('ready');
    expect(card.stage).toBe('Checking & review');
    const hint = model.lanes.find((lane: any) => lane[0] === 'Checking & review')?.[1];
    expect(hint).not.toContain('Checked on main');
    expect(hint).toMatch(/inspection|review/i);
  });
  it('labels failed runner results by the job kind recorded in the snapshot', () => {
    const snapshot = structuredClone(data) as any;
    snapshot.data.projections.runners = { jobs: [
      { jobId: 'stack-job', kind: 'validate-stack' },
      { jobId: 'inspect-job', kind: 'inspect-candidate' },
      { jobId: 'delta-job', kind: 'delta-check' },
      { jobId: 'promote-job', kind: 'promote' },
    ] };
    const results = [
      { sequence: 21, kind: 'runner.result', timestamp: now, relatedIds: ['stack-job'], payload: { outcome: 'FAIL' } },
      { sequence: 22, kind: 'runner.result', timestamp: now, relatedIds: ['inspect-job'], payload: { outcome: 'FAIL' } },
      { sequence: 23, kind: 'runner.result', timestamp: now, relatedIds: ['delta-job'], payload: { outcome: 'FAIL' } },
      { sequence: 24, kind: 'runner.result', timestamp: now, relatedIds: ['promote-job'], payload: { outcome: 'FAIL' } },
      { sequence: 25, kind: 'runner.result', timestamp: now, relatedIds: ['gone-job'], payload: { outcome: 'FAIL' } },
    ];
    const what = trackerModel(snapshot, results, null, 'm', now).friction
      .filter((row: any) => row.event?.kind === 'runner.result').map((row: any) => row.what);
    expect(what).toEqual(['Check failed for gone-job', 'Promotion failed for promote-job',
      'Delta check failed for delta-job', 'Inspection failed for inspect-job', 'Stack check failed for stack-job']);
  });
  it('records every unsuccessful runner outcome as friction', () => {
    const snapshot = structuredClone(data) as any;
    snapshot.data.projections.runners = { jobs: [{ jobId: 'timed-out', kind: 'inspect-candidate' }] };
    const timeout = { sequence: 26, kind: 'runner.result', timestamp: now, relatedIds: ['timed-out'], payload: { outcome: 'TIMEOUT' } };
    expect(trackerModel(snapshot, [timeout], null, 'm', now).friction)
      .toContainEqual(expect.objectContaining({ event: timeout, what: 'Inspection failed for timed-out' }));
  });
  it('keeps manual friction rows visible when event rows exceed the evidence cap', () => {
    const snapshot = structuredClone(data) as any;
    snapshot.data.projections.issues.items.push({ number: 50, title: 'Manual follow-up', state: 'open', labels: ['friction'] });
    const refusals = Array.from({ length: 45 }, (_, index) => ({ sequence: index + 1, kind: 'lease.refused', timestamp: now, relatedIds: [`c${index}`] }));
    const friction = trackerModel(snapshot, refusals, null, 'm', now).friction;
    expect(friction).toHaveLength(40);
    expect(friction.some((row: any) => row.issue?.number === 50)).toBe(true);
  });
  it('never offers an issue whose current change already landed as Ready to claim', () => {
    const snapshot = structuredClone(data) as any;
    snapshot.data.projections.issues.items.push({ number: 8, title: 'Landed, still open', state: 'open', milestoneId: 'm', labels: [] });
    snapshot.data.projections.repos.changes.push({ changeId: 'c8', issueNumber: 8, status: 'merged', revision: 2 });
    snapshot.data.projections.queue.entries.push({ changeId: 'c8', state: 'landed', admittedRevision: 2 });
    const card = trackerModel(snapshot, [], null, 'm', now).cards.find((item: any) => item.issue.number === 8);
    expect(card.stage).toBe('Landed');
  });
  it('asks for the selected issue\'s missing approval history exactly once', () => {
    const dom = new JSDOM('<main id="tracker"></main>');
    const previous = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      const root = dom.window.document.getElementById('tracker')!;
      const asked: string[][] = [];
      const tracker = createTracker(root, { refresh: async () => {},
        loadVerdicts: async (ids: string[]) => { asked.push(ids); } });
      const render = (verdicts: any, verdictErrors: any = {}) =>
        tracker.render({ repoId: 'repo', snapshot: data, events: [], identity: null, verdicts, verdictErrors });
      render({});
      expect(asked).toEqual([['c4']]);
      render({ c4: [] });
      ([...root.querySelectorAll('.tracker-card')].find(card => card.textContent?.includes('#5')) as HTMLButtonElement).click();
      expect(asked).toEqual([['c4'], ['c5']]);
      render({ c4: [], c5: [] });
      expect(asked).toHaveLength(2);
      render({ c4: [] }, { c5: 'Approval history is visible to reviewers' });
      expect(asked).toHaveLength(2);
      render({ c5: [{ verdictId: 'v-land', changeId: 'c5', parentVerdictId: 'v-prev' }] });
      expect(root.querySelector('.tracker-timeline')?.textContent).toContain('verdict.carried');
    } finally { globalThis.document = previous; dom.window.close(); }
  });
  it('requests at most the current and closing change histories for a 12-change issue', () => {
    const snapshot = structuredClone(data) as any;
    const changes = Array.from({ length: 12 }, (_, index) => ({ changeId: `linked-${index}`, issueNumber: 20,
      status: index === 11 ? 'merged' : 'superseded', revision: index + 1 }));
    snapshot.data.projections.issues.items = [{ number: 20, title: 'Many revisions', state: 'closed',
      closedBy: { changeId: 'linked-11' }, milestoneId: 'm', labels: [] }];
    snapshot.data.projections.repos.changes = changes;
    const dom = new JSDOM('<main id="tracker"></main>'); const previous = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      const requested: string[][] = [];
      const tracker = createTracker(dom.window.document.getElementById('tracker'), { loadVerdicts: (ids: string[]) => requested.push(ids) });
      tracker.render({ repoId: 'repo', snapshot, events: [], identity: null });
      expect(requested.flat()).toEqual(['linked-11']);
      expect(requested.flat().length).toBeLessThanOrEqual(2);
    } finally { globalThis.document = previous; dom.window.close(); }
  });
  it('shows failed inspection in friction and carries approval for both agent and owner views', () => {
    const failed = { sequence: 20, kind: 'runner.result', timestamp: now, relatedIds: ['inspect-job'], payload: { outcome: 'FAIL' } };
    const verdicts = { c4: [{ verdictId: 'v4', changeId: 'c4', revision: 1, parentVerdictId: 'v-old' }] };
    for (const identity of [{ principalId: 'agent-a', roles: ['agent'] }, { principalId: 'owner', roles: ['owner'] }]) {
      const model = trackerModel(data, [failed, events[3]], identity, 'm', now, [], verdicts);
      expect(model.friction.some((row: any) => row.event === failed)).toBe(true);
      expect(model.cards[3].meta).toBe('carried approval');
    }
    const landed = structuredClone(data) as any;
    landed.data.projections.repos.changes[3].revision = 1;
    const history = { c5: [{ verdictId: 'v-land', changeId: 'c5', revision: 1, parentVerdictId: 'v-prev' }] };
    expect(trackerModel(landed, [], null, 'm', now, [], history).cards[4].timeline.map((e: any) => e.kind)).toContain('verdict.carried');
  });
  it('renders filters, drawer, event evidence, edit and friction submissions, and empty/error states', async () => {
    const dom = new JSDOM('<main id="tracker"></main>', { url: 'http://localhost/' });
    const previous = { document: globalThis.document, fetch: globalThis.fetch };
    Object.assign(globalThis, { document: dom.window.document });
    const calls: any[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: {}, version: 4 }), { status: 200 });
    }) as any;
    setSessionToken('test-token');
    const root = dom.window.document.getElementById('tracker')!;
    let refreshed = 0;
    const refreshResolvers: Array<() => void> = [];
    const refreshes = [1, 2].map(() => new Promise<void>(resolve => refreshResolvers.push(resolve)));
    const tracker = createTracker(root, { refresh: async () => { refreshed++; refreshResolvers[refreshed - 1]?.(); } });
    const snapshot = structuredClone(data) as any;
    snapshot.data.projections.leases.heldItems[0].expiresAt = Date.now() + 120000;
    const context = { repoId: 'repo', snapshot, events, identity: { principalId: 'owner', roles: ['owner'] }, message: null };
    try {
      tracker.render(context);
      expect(root.textContent).toContain('Release');
      expect(root.querySelectorAll('.tracker-card')).toHaveLength(5);
      expect(root.querySelector('free')).toBeNull();
      (root.querySelector('.tracker-stat') as HTMLButtonElement).click();
      expect(root.querySelector('.tracker-evidence')?.textContent).toContain('Live lease');
      ([...root.querySelectorAll('.tracker-source')].find(item => item.textContent?.includes('lease.refused')) as HTMLButtonElement).click();
      expect(root.querySelector('.tracker-evidence')?.textContent).toContain('lease.refused');
      (root.querySelectorAll('.tracker-filters button')[1] as HTMLButtonElement).click();
      expect(root.querySelectorAll('.tracker-card')).toHaveLength(1);
      (root.querySelectorAll('.tracker-filters button')[0] as HTMLButtonElement).click();
      (root.querySelectorAll('.tracker-card')[1] as HTMLButtonElement).click();
      expect(root.querySelector('.tracker-drawer')?.textContent).toContain('lease.claimed');
      (root.querySelector('.tracker-open') as HTMLAnchorElement).click();
      expect(root.querySelector('.tracker-issue-detail')?.textContent).toContain('Issue #2');
      (root.querySelector('.tracker-edit') as HTMLButtonElement).click();
      const edit = root.querySelector('.tracker-drawer form') as HTMLFormElement;
      (edit.elements.namedItem('title') as HTMLInputElement).value = 'Revised title';
      tracker.render(context);
      expect((root.querySelector('.tracker-drawer input[name=title]') as HTMLInputElement).value).toBe('Revised title');
      const firstRefresh = refreshes[0];
      (root.querySelector('.tracker-drawer .tracker-submit') as HTMLButtonElement).click();
      await firstRefresh;
      expect(calls[0].url).toBe('/v1/repos/repo/issues/2');
      expect(JSON.parse(String(calls[0].init.body)).expectedVersion).toBe(2);
      expect(refreshed).toBe(1);
      (root.querySelector('.tracker-friction>button') as HTMLButtonElement).click();
      const friction = root.querySelector('.tracker-friction form') as HTMLFormElement;
      (friction.elements.namedItem('title') as HTMLInputElement).value = 'Slow check';
      (friction.elements.namedItem('cost') as HTMLInputElement).value = '3 minutes';
      (friction.elements.namedItem('did') as HTMLTextAreaElement).value = 'Retried check';
      const secondRefresh = refreshes[1];
      (root.querySelector('.tracker-friction .tracker-submit') as HTMLButtonElement).click();
      await secondRefresh;
      expect(calls[1].url).toBe('/v1/repos/repo/issues');
      expect(JSON.parse(String(calls[1].init.body)).labels).toEqual(['friction']);
      expect(JSON.parse(String(calls[1].init.body)).body).toContain('Concord did: Retried check');
      expect(refreshed).toBe(2);
      tracker.render({ ...context, snapshot: null, message: 'Snapshot unavailable' });
      expect(root.textContent).toContain('Snapshot unavailable');
      tracker.render({ ...context, repoId: null, snapshot: null });
      expect(root.textContent).toContain('Choose a repository');
    } finally { clearSessionToken(); Object.assign(globalThis, previous); dom.window.close(); }
  });
  it('limits each lane to 50 cards with the remaining count and paginates verdicts to ten pages', async () => {
    const dom = new JSDOM('<main id="tracker"></main>');
    const previous = globalThis.document; globalThis.document = dom.window.document;
    try {
      const root = dom.window.document.getElementById('tracker')!;
      const snapshot = structuredClone(data) as any;
      snapshot.data.projections.issues.items = Array.from({ length: 120 }, (_, index) => ({ number: index + 1,
        title: `Landed ${index + 1}`, state: 'closed', closedBy: { changeId: `land-${index}` }, milestoneId: 'm', labels: [] }));
      snapshot.data.projections.repos.changes = Array.from({ length: 120 }, (_, index) => ({ changeId: `land-${index}`,
        issueNumber: index + 1, status: 'merged', revision: 1 }));
      snapshot.data.projections.queue.entries = [];
      const tracker = createTracker(root, { refresh: async () => {}, loadVerdicts: () => {} });
      tracker.render({ repoId: 'repo', snapshot, events: [], identity: null, verdicts: {} });
      expect(root.querySelectorAll('[aria-label="Landed"] .tracker-card')).toHaveLength(50);
      expect(root.querySelector('[aria-label="Landed"] .tracker-more')?.textContent).toBe('Show 70 more');
      const olderHistory: any = [];
      olderHistory.olderNotLoaded = true;
      const oneIssue = structuredClone(snapshot) as any;
      oneIssue.data.projections.issues.items = [oneIssue.data.projections.issues.items[0]];
      oneIssue.data.projections.repos.changes = [oneIssue.data.projections.repos.changes[0]];
      tracker.render({ repoId: 'repo', snapshot: oneIssue, events: [], identity: null, verdicts: { 'land-0': olderHistory } });
      expect(root.querySelector('.tracker-approval-history')?.textContent).toContain('Older approvals not loaded.');
    } finally { globalThis.document = previous; dom.window.close(); }
    let active = 0; let maximum = 0; let requests = 0; let truncated: any; const loaded = new Set<string>();
    let releaseDelayedBatch!: () => void;
    const delayedBatch = new Promise<void>(resolve => { releaseDelayedBatch = resolve; });
    let signalInitialBatch!: () => void;
    const initialBatchRequested = new Promise<void>(resolve => { signalInitialBatch = resolve; });
    let resolveAllLoaded!: () => void;
    const allLoaded = new Promise<void>(resolve => { resolveAllLoaded = resolve; });
    const loader = createVerdictLoader({ maxConcurrency: 4, maxPages: 10,
      fetchPage: async (id: string, cursor: string | null) => {
        active++; maximum = Math.max(maximum, active); requests++;
        if (requests === 4) signalInitialBatch();
        if (requests <= 4) await delayedBatch;
        else await Promise.resolve();
        active--;
        return { data: { items: [{ verdictId: `${id}-${cursor ?? 0}` }], nextCursor: cursor === null ? '1' : null } };
      }, onResult: (id: string, items: any) => { loaded.add(id); truncated = items; if (loaded.size === 10) resolveAllLoaded(); } });
    loader.request(Array.from({ length: 10 }, (_, index) => `c${index}`));
    await initialBatchRequested;
    releaseDelayedBatch();
    await allLoaded;
    expect(maximum).toBeLessThanOrEqual(4);
    expect(requests).toBe(20);
    expect(loaded.size).toBe(10);
    let resolvePagesLoaded!: () => void;
    const pagesLoaded = new Promise<void>(resolve => { resolvePagesLoaded = resolve; });
    let pageRequests = 0;
    const pages = createVerdictLoader({ maxPages: 10, fetchPage: async (_id: string, cursor: string | null) => {
      pageRequests++;
      return { data: { items: [], nextCursor: String(Number(cursor ?? 0) + 1) } };
    }, onResult: (_id: string, items: any) => { truncated = items; resolvePagesLoaded(); } });
    pages.request(['many']);
    await pagesLoaded;
    expect(pageRequests).toBe(10);
    expect(truncated.olderNotLoaded).toBe(true);
  });
  it('loads verdict history when a queued card enters the rendered window', () => {
    const dom = new JSDOM('<main id="tracker"></main>');
    const previous = globalThis.document; globalThis.document = dom.window.document;
    try {
      const snapshot = structuredClone(data) as any;
      snapshot.data.projections.issues.items = Array.from({ length: 51 }, (_, index) => ({ number: index + 1,
        title: `Queued ${index + 1}`, state: 'open', milestoneId: 'm', labels: [] }));
      snapshot.data.projections.repos.changes = Array.from({ length: 51 }, (_, index) => ({ changeId: `queued-${index + 1}`,
        issueNumber: index + 1, status: 'queued', revision: 1 }));
      snapshot.data.projections.queue.entries = Array.from({ length: 51 }, (_, index) => ({ changeId: `queued-${index + 1}`,
        state: 'admitted', admittedRevision: 1, verdictId: `verdict-${index + 1}` }));
      const requested = new Set<string>();
      const tracker = createTracker(dom.window.document.getElementById('tracker'), {
        loadVerdicts: (ids: string[]) => ids.forEach(id => requested.add(id)),
      });
      tracker.render({ repoId: 'repo', snapshot, events: [], identity: null, verdicts: {} });
      expect(requested.has('queued-51')).toBe(false);
      (dom.window.document.querySelector('.tracker-more') as HTMLButtonElement).click();
      expect(requested.has('queued-51')).toBe(true);
    } finally { globalThis.document = previous; dom.window.close(); }
  });
  it('refreshes non-terminal history and transient errors after a version bump, retaining terminal history', async () => {
    const calls: string[] = [];
    const loader = createVerdictLoader({ fetchPage: async (id: string) => {
      calls.push(id);
      if (['retry', 'terminal-error'].includes(id) && calls.filter(item => item === id).length === 1) throw new Error('temporary');
      return { data: { items: [] } };
    }, onResult: () => {} });
    const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
    loader.advanceVersion(1);
    loader.request(['live', 'terminal', 'retry', 'terminal-error'], ['terminal', 'terminal-error']);
    await settle();
    expect(calls).toHaveLength(4);
    loader.advanceVersion(2);
    loader.request(['live', 'terminal', 'retry', 'terminal-error']);
    await settle();
    expect(calls.filter(id => id === 'live')).toHaveLength(2);
    expect(calls.filter(id => id === 'terminal')).toHaveLength(1);
    expect(calls.filter(id => id === 'retry')).toHaveLength(2);
    expect(calls.filter(id => id === 'terminal-error')).toHaveLength(2);
  });
  it('refreshes the tracker drawer mirror when a verdict lands and the snapshot version advances', async () => {
    const dom = new JSDOM('<main id="tracker"></main>');
    const previous = globalThis.document; globalThis.document = dom.window.document;
    try {
      const snapshot = { data: { projections: { issues: { items: [
        { number: 1, title: 'Ready for review', state: 'open', labels: [], changes: [] },
      ] }, repos: { changes: [{ changeId: 'ready-change', issueNumber: 1, status: 'ready', revision: 1 }] }, queue: { entries: [] } } } };
      const mirror: Record<string, any> = {};
      let tracker: any;
      let version = 1;
      let fetchCount = 0;
      const render = () => tracker.render({ repoId: 'repo', snapshot: { ...snapshot, version }, events: [], identity: null,
        verdicts: mirror, verdictErrors: {} });
      const loader = createVerdictLoader({
        fetchPage: async () => ({ data: { items: ++fetchCount === 1 ? [] : [{ verdictId: 'landed-verdict', decision: 'approve', reviewerId: 'reviewer' }] } }),
        onResult: (id: string, items: any) => { mirror[id] = items; render(); },
        onEvict: (id: string) => { delete mirror[id]; },
      });
      tracker = createTracker(dom.window.document.getElementById('tracker'), {
        loadVerdicts: (ids: string[], terminals: string[]) => loader.request(ids, terminals),
      });
      render();
      await waitForText(dom.window.document.getElementById('tracker')!, 'No verdict recorded.');
      expect(fetchCount).toBe(1);
      version = 2;
      loader.advanceVersion(version);
      render();
      await waitForText(dom.window.document.getElementById('tracker')!, 'approve');
      expect(fetchCount).toBe(2);
      expect(dom.window.document.querySelector('.tracker-approval-history')?.textContent).toContain('approve');
      expect(mirror['ready-change'][0].verdictId).toBe('landed-verdict');
    } finally { globalThis.document = previous; dom.window.close(); }
  });
  it('pins the issue version when edit opens and reports a stale save after polling', async () => {
    const dom = new JSDOM('<main id="tracker"></main>');
    const previous = { document: globalThis.document, fetch: globalThis.fetch };
    globalThis.document = dom.window.document;
    const calls: any[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ error: { code: 'STALE_VERSION' } }), { status: 409 });
    }) as any;
    setSessionToken('agent');
    try {
      const root = dom.window.document.getElementById('tracker')!;
      const snapshot = structuredClone(data) as any;
      snapshot.data.projections.issues.items[0].version = 1;
      const tracker = createTracker(root, { refresh: async () => {} });
      const context = { repoId: 'repo', snapshot, events: [], identity: { roles: ['agent'] } };
      tracker.render(context);
      (root.querySelector('.tracker-edit') as HTMLButtonElement).click();
      snapshot.data.projections.issues.items[0].version = 2;
      tracker.render(context);
      const staleMessage = waitForText(root, 'Issue changed while you were editing');
      (root.querySelector('.tracker-submit') as HTMLButtonElement).click();
      await staleMessage;
      expect(JSON.parse(String(calls[0].init.body)).expectedVersion).toBe(1);
      expect(root.textContent).toContain('Issue changed while you were editing');
    } finally { clearSessionToken(); Object.assign(globalThis, previous); dom.window.close(); }
  });
  it('keeps the edit and friction form titles separate across a re-render', () => {
    const dom = new JSDOM('<main id="tracker"></main>');
    const previous = globalThis.document; globalThis.document = dom.window.document;
    try {
      const root = dom.window.document.getElementById('tracker')!;
      const snapshot = structuredClone(data) as any;
      const tracker = createTracker(root, {});
      const context = { repoId: 'repo', snapshot, events: [], identity: { roles: ['owner'] } };
      tracker.render(context);
      (root.querySelector('.tracker-edit') as HTMLButtonElement).click();
      (root.querySelector('.tracker-friction>button') as HTMLButtonElement).click();
      (root.querySelector('.tracker-drawer input[name=title]') as HTMLInputElement).value = 'Issue title';
      (root.querySelector('.tracker-friction input[name=title]') as HTMLInputElement).value = 'Friction title';
      tracker.render(context);
      expect((root.querySelector('.tracker-drawer input[name=title]') as HTMLInputElement).value).toBe('Issue title');
      expect((root.querySelector('.tracker-friction input[name=title]') as HTMLInputElement).value).toBe('Friction title');
    } finally { globalThis.document = previous; dom.window.close(); }
  });
});
