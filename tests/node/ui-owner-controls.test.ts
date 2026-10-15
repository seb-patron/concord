import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;
const { createTracker } = require('../../web/tracker.js') as any;

function setup(repoId: string, identity: any, queueState?: string, changeStatus = 'draft') {
  const dom = new JSDOM('<main id="tracker"></main>');
  const root = dom.window.document.getElementById('tracker') as HTMLElement;
  const snapshot = { version: 7, data: { projections: {
    issues: { items: [{ number: 2, title: 'Held work', body: '', state: 'open', milestoneId: 'm', labels: [], allowedFiles: ['web/held.js'], version: 2 }] , milestones: [{ milestoneId: 'm', title: 'Milestone', state: 'open' }] },
    repos: { changes: [{ changeId: 'c2', issueNumber: 2, authorId: 'agent-a', status: changeStatus, revision: 1, unitKeys: ['web/held.js'] }] },
    leases: { heldItems: [{ leaseId: 'lease-2', changeId: 'c2', issueNumber: 2, holderId: 'agent-a', unitKey: 'web/held.js', state: 'active', expiresAt: Date.now() + 120000 }] },
    queue: { entries: queueState ? [{ changeId: 'c2', revision: 1, admittedRevision: 1, state: queueState }] : [] },
  } } };
  const calls: Array<{ url: string; init: any }> = [];
  let refreshes = 0;
  const fetchImpl = async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ version: 8 }) };
  };
  const tracker = createTracker(root, { fetchImpl, refresh: async () => { refreshes++; } });
  const context = { repoId, snapshot, events: [], identity, verdicts: {} };
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  tracker.render(context);
  return { dom, root, tracker, context, calls, get refreshes() { return refreshes; }, restore: () => { globalThis.document = previous; dom.window.close(); } };
}

function openCancel(view: ReturnType<typeof setup>) {
  const card = Array.from(view.root.querySelectorAll('.tracker-card')).find(item => item.textContent?.includes('#2')) as HTMLButtonElement;
  card.click();
  (view.root.querySelector('.owner-controls button') as HTMLButtonElement).click();
}

function confirmWithReason(view: ReturnType<typeof setup>, reasonText = 'stop') {
  const input = view.root.querySelector('.owner-controls input[name=reason]') as HTMLInputElement;
  input.value = reasonText;
  input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
  (view.root.querySelector('.owner-controls .tracker-submit') as HTMLButtonElement).click();
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe('Tracker owner controls', () => {
  it('closes a draft directly and refreshes after the owner confirms', async () => {
    const view = setup('owner-draft', { principalId: 'owner', roles: ['owner'] });
    try {
      openCancel(view);
      expect(view.root.textContent).toContain('Owner controls');
      expect(view.root.textContent).toContain('Cancel work');
      expect(view.root.textContent).toContain('The issue stays open for another agent.');
      confirmWithReason(view);
      await settle();
      expect(view.calls).toHaveLength(1);
      expect(view.calls[0].url).toBe('/v1/repos/owner-draft/changes/c2/close');
      expect(view.calls[0].init.method).toBe('POST');
      expect(JSON.parse(view.calls[0].init.body)).toEqual({ expectedVersion: 7, reason: 'stop' });
      expect(view.refreshes).toBe(1);
    } finally { view.restore(); }
  });

  it('withdraws an active queue entry before close and uses its returned version', async () => {
    const view = setup('owner-reserved', { principalId: 'owner', roles: ['owner'] }, 'reserved');
    try {
      openCancel(view);
      confirmWithReason(view);
      await settle();
      expect(view.calls.map(call => call.url)).toEqual([
        '/v1/repos/owner-reserved/queue/withdraw',
        '/v1/repos/owner-reserved/changes/c2/close',
      ]);
      expect(view.calls.map(call => call.init.method)).toEqual(['POST', 'POST']);
      expect(JSON.parse(view.calls[0].init.body)).toEqual({ changeId: 'c2', expectedVersion: 7, reason: 'stop' });
      expect(JSON.parse(view.calls[1].init.body)).toEqual({ expectedVersion: 8, reason: 'stop' });
      expect(view.refreshes).toBe(1);
    } finally { view.restore(); }
  });

  it('shows an inline error and sends no request for an empty reason', () => {
    const view = setup('owner-empty', { principalId: 'owner', roles: ['owner'] });
    try {
      openCancel(view);
      confirmWithReason(view, '   ');
      expect(view.calls).toHaveLength(0);
      expect(view.root.textContent).toContain('Enter a reason between 1 and 500 characters.');
    } finally { view.restore(); }
  });

  it('releases a selected live lease with the supplied reason', async () => {
    const view = setup('owner-release', { principalId: 'owner', roles: ['owner'] });
    try {
      openCancel(view);
      const row = Array.from(view.root.querySelectorAll('.owner-control-lease'))[0] as HTMLElement;
      (row.querySelector('button') as HTMLButtonElement).click();
      const input = view.root.querySelector('.owner-control-lease input[name=reason]') as HTMLInputElement;
      input.value = 'stale lease';
      input.dispatchEvent(new view.dom.window.Event('input', { bubbles: true }));
      (view.root.querySelector('.owner-control-lease .tracker-submit') as HTMLButtonElement).click();
      await settle();
      expect(view.calls).toHaveLength(1);
      expect(view.calls[0].url).toBe('/v1/repos/owner-release/leases/lease-2/force-release');
      expect(view.calls[0].init.method).toBe('POST');
      expect(JSON.parse(view.calls[0].init.body)).toEqual({ reason: 'stale lease', expectedVersion: 7 });
      expect(view.refreshes).toBe(1);
    } finally { view.restore(); }
  });

  it('hides owner controls for agents and viewers and hides cancel for merged changes', () => {
    for (const [repo, identity, status, hasControls, hasCancel] of [
      ['agent-view', { principalId: 'agent', roles: ['agent'] }, 'draft', false, false],
      ['viewer-view', { principalId: 'viewer', roles: ['viewer'] }, 'draft', false, false],
      ['owner-merged', { principalId: 'owner', roles: ['owner'] }, 'merged', true, false],
    ] as const) {
      const view = setup(repo, identity, undefined, status);
      try {
        (Array.from(view.root.querySelectorAll('.tracker-card')).find(item => item.textContent?.includes('#2')) as HTMLButtonElement).click();
        expect(!!view.root.querySelector('.owner-controls')).toBe(hasControls);
        expect(!!Array.from(view.root.querySelectorAll('.owner-controls button')).find(button => button.textContent === 'Cancel work')).toBe(hasCancel);
      } finally { view.restore(); }
    }
  });
});
