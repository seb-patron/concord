import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
// @ts-ignore web/api.js is a browser JavaScript module without declarations.
import { clearSessionToken, getSnapshot, setSessionToken } from '../../web/api.js';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;

describe('UI snapshot loading', () => {
  it('shares one in-flight snapshot fetch', async () => {
    let calls = 0;
    const fetcher = async (_input: RequestInfo | URL) => { calls++; await Promise.resolve(); return Response.json({ data: {}, version: 1 }, { headers: { etag: '"v1"' } }); };
    setSessionToken('ui-test');
    try {
      await Promise.all([getSnapshot('demo', fetcher), getSnapshot('demo', fetcher)]);
      expect(calls).toBe(1);
    } finally { clearSessionToken(); }
  });

  it('starts a new snapshot read for a refresh after a mutation', async () => {
    let calls = 0;
    const fetcher = async (_input: RequestInfo | URL) => { calls++; await Promise.resolve(); return Response.json({ data: {}, version: calls }); };
    setSessionToken('ui-test-fresh');
    try {
      await Promise.all([getSnapshot('demo', fetcher), getSnapshot('demo', fetcher, false, false)]);
      expect(calls).toBe(2);
    } finally { clearSessionToken(); }
  });

  it('loads the Work tab with minimal requests and fetches Fleet data only when shown', async () => {
    clearSessionToken();
    const dom = new JSDOM(readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/' });
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    Object.assign(globalThis, { document: dom.window.document, window: dom.window });
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.scrollTo = () => {};
    dom.window.setInterval = (() => 1) as any;
    let visibility = 'visible';
    Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, get: () => visibility });
    const requests: string[] = [];
    globalThis.fetch = (async (url: string) => {
      requests.push(url);
      if (url === '/health') return Response.json({ data: { accessSignIn: true } });
      if (url === '/v1/session') return Response.json({ data: { principalId: 'load-owner', roles: ['owner'], authMethod: 'access',
        expiresAt: Date.now() + 600_000, logoutUrl: '/v1/session/signout' } });
      if (url === '/v1/me') return Response.json({ data: { principalId: 'load-owner', roles: ['owner'], repoIds: '*' } });
      if (url === '/v1/repos') return Response.json({ data: { items: [{ repoId: 'load-repo' }] } });
      if (url === '/v1/repos/load-repo/snapshot') return Response.json({ data: { projections: {} }, version: 3, eventSeq: 0 });
      if (url.startsWith('/v1/repos/load-repo/events')) return Response.json({ data: { items: [] }, version: 3, eventSeq: 0 });
      if (url.startsWith('/v1/repos/load-repo/metrics')) return Response.json({ data: {}, version: 3 });
      if (url.startsWith('/v1/principals')) return Response.json({ data: { items: [], nextCursor: null } });
      if (url.includes('/verdicts')) return Response.json({ data: { items: [], nextCursor: null }, version: 3 });
      return Response.json({ data: {} });
    }) as any;
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    const count = (match: (url: string) => boolean) => requests.filter(match).length;
    const snapshots = () => count(url => url.endsWith('/snapshot'));
    const events = () => count(url => url.includes('/events?'));
    const metrics = () => count(url => url.includes('/metrics'));
    const principals = () => count(url => url.startsWith('/v1/principals'));
    const verdicts = () => count(url => url.includes('/verdicts'));
    try {
      // @ts-expect-error Browser JS is intentionally untyped.
      await import('../../web/app.js?ui-load-minimal');
      for (let i = 0; i < 6; i++) await flush();
      const doc = dom.window.document;
      expect(doc.getElementById('desk')!.hidden).toBe(false);
      expect(count(url => url === '/v1/me')).toBe(1);
      expect(count(url => url === '/v1/repos')).toBe(1);
      expect(snapshots()).toBe(1);
      expect(events()).toBe(1);
      expect([metrics(), principals(), verdicts()]).toEqual([0, 0, 0]);

      (doc.querySelector('[data-tab="fleet"]') as HTMLButtonElement).click();
      for (let i = 0; i < 4; i++) await flush();
      expect(metrics()).toBe(1);
      expect(principals()).toBeGreaterThan(0);

      visibility = 'hidden';
      const before = requests.length;
      doc.dispatchEvent(new dom.window.Event('visibilitychange'));
      dom.window.dispatchEvent(new dom.window.Event('focus'));
      (doc.getElementById('refresh-button') as HTMLButtonElement).click();
      for (let i = 0; i < 4; i++) await flush();
      expect(requests.length).toBe(before);

      visibility = 'visible';
      (doc.querySelector('[data-tab="work"]') as HTMLButtonElement).click();
      const snapshotsBefore = snapshots();
      const eventsBefore = events();
      (doc.getElementById('refresh-button') as HTMLButtonElement).click();
      for (let i = 0; i < 4; i++) await flush();
      expect(events()).toBe(eventsBefore + 1);
      expect(snapshots()).toBe(snapshotsBefore);
    } finally {
      clearSessionToken();
      Object.assign(globalThis, previous);
      dom.window.close();
    }
  });
});
