import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;
const { deriveInbox, normalizeDiagnosis } = require('../../web/views.js') as any;
const { apiFetch, clearSessionToken, setSessionToken } = require('../../web/api.js') as any;

const fixture = {
  data: { projections: {
    repos: { changes: [
      { changeId: 'x', authorId: 'agent-a', authorModel: 'model-from-api', intentText: 'Cap retries', unitKeys: ['fn:retry'], status: 'ready', revision: 2, headOid: 'abc123', baseOid: 'base' },
      { changeId: 'y', authorId: 'agent-b', intentText: 'Rename logs', unitKeys: ['file:log'], status: 'blocked', revision: 1, headOid: 'def456' },
    ], repo: { observedCanonicalOid: 'main123' } },
    leases: { items: [{ leaseId: 'l1', changeId: 'x', holderId: 'agent-a', unitKey: 'fn:retry', fence: 3, expiresAt: Date.now() + 120000, state: 'active' }],
      refusals: [{ changeId: 'x', requesterId: 'agent-c', keys: ['fn:retry'], createdAt: Date.now(), conflicts: [{ holderId: 'agent-a', expiresAt: Date.now() + 120000 }] }] },
    queue: { entries: [{ changeId: 'y', state: 'blocked', sequence: 1 }], diagnosis: { reason: 'SINGLETON', blame: ['y'] }, observedMain: 'main123' },
    findings: { findingSetVersions: { x: 0 } },
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
});

describe('Fleet desk DOM', () => {
  it('shows first run on 401, then renders the desk, inbox and verdict route', async () => {
    clearSessionToken();
    const dom = new JSDOM(readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/' });
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    Object.assign(globalThis, { document: dom.window.document, window: dom.window });
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.scrollTo = () => {};
    dom.window.setInterval = (() => 1) as any;
    const doc = dom.window.document;
    const byId = (id: string) => doc.getElementById(id)!;
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let forbiddenVerdicts = false;
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
        else body = fixture;
      }
      else if (url.includes('/events?')) body = { data: { items: [] }, version: 7, eventSeq: 0 };
      else if (url.includes('/changes/x/verdicts') && init.method !== 'POST' && (forbiddenVerdicts || token === 'Bearer local-agent-a')) {
        status = 403; body = { error: { code: 'FORBIDDEN', message: 'reviewers only' } };
      }
      else if (url.endsWith('/changes/x/verdicts')) body = { data: { items: history, nextCursor: 'MTAw' } };
      else if (url.endsWith('/changes/x/verdicts?cursor=MTAw')) body = { data: { items: [
        { verdictId: 'v101', changeId: 'x', reviewerId: 'other-reviewer', decision: 'approve', revision: 2, findingSetVersion: 0, parentVerdictId: null },
      ], nextCursor: null } };
      else body = { data: {}, version: 8 };
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
      expect(byId('work-board').textContent).toContain('model-from-api');
      expect(byId('work-board').textContent).not.toContain('agent-b · model');
      expect(byId('alert-count').textContent).toContain('3 decisions');
      byId('inbox-alert').click();
      expect(byId('inbox-view').hidden).toBe(false);
      expect(byId('inbox-list').textContent).toContain('Waiting on a lease');
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
    } finally {
      clearSessionToken();
      Object.assign(globalThis, previous);
      dom.window.close();
    }
  });
});

describe('layout and token contract', () => {
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
});
