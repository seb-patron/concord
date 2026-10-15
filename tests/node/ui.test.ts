import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;
const { avatarInitials, canRender, chooseInitialRepo, deriveInbox, inboxCount, isDemoRepo, normalizeDiagnosis, orderedRepos, visibleRepos, pickTheme, signOutTarget, trackerLaneForIssue, trackerLaneNames, projectionItems, snapshotCollections, mutationEvidence,
  leaseCountdown, environmentBadge, verdictProvenance, repairStatus, openIssueRows, liveLeaseHolders, changeNextAction } = require('../../web/views.js') as any;
const { apiFetch, clearSessionToken, setSessionToken, redactError, allowedActions, getSettings, getSnapshot, putSettings, submitHumanApproval } = require('../../web/api.js') as any;

describe('view access', () => {
  it('allows token, Access and public sessions, but not anonymous private views', () => {
    expect(canRender({ token: true })).toBe(true);
    expect(canRender({ identity: { authMethod: 'access' } })).toBe(true);
    expect(canRender({ publicRead: true })).toBe(true);
    expect(canRender({})).toBe(false);
  });
});

describe('Work UI theme and tracker lanes', () => {
  it('uses light for missing or invalid theme preferences and defines both token sets', () => {
    for (const value of [null, '', 'garbage', 'light', 'DARK']) expect(pickTheme(value)).toBe('light');
    expect(pickTheme('dark')).toBe('dark');
    const css = readFileSync(new URL('../../web/styles.css', import.meta.url), 'utf8');
    for (const selector of [':root{', ':root[data-theme="dark"]{']) {
      const start = css.indexOf(selector);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = css.indexOf('}', start);
      const block = css.slice(start, end);
      for (const token of ['--page:', '--text:', '--card:', '--border:', '--header:']) expect(block).toContain(token);
    }
    const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
    for (const label of ['Code', 'Issues', 'Tracker', 'Settings']) expect(html).toContain(`>${label}</button>`);
    expect([...html.matchAll(/data-main-view="([^"]+)"/g)].map(([, view]) => view)).toEqual(['code', 'issues', 'tracker', 'settings']);
    expect(html).not.toContain('data-main-view="desk"');
    expect(html).toContain('id="milestone-settings-content"');
    expect(html).toContain('Path protection</h2>');
    expect(html).toContain('id="repository-info"');
    expect(html).toContain('id="back-desk" class="quiet">← Back</button>');
    expect(html).toMatch(/id="theme-toggle"[^>]*aria-label="[^"]+"/);
    expect(html).toContain('id="repo-owner"');
    expect(html).toContain('id="repo-link"');
    expect(html).not.toContain('id="repo-select"');
    for (const selector of ['#settings-panel,.side-panel', '.inbox-alert']) {
      const rule = css.split('}').filter(part => part.includes(selector)).at(-1);
      expect(rule, `${selector} should resolve through theme tokens`).toMatch(/var\(--(card|border|text|alert-bg|alert-border|alert-text)/);
      expect(rule).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
  });
  it('keeps the logo and selected main-nav tab visible in both themes', () => {
    const css = readFileSync(new URL('../../web/styles.css', import.meta.url), 'utf8');
    const finalDeclarations = (selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const declarations = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))]
        .flatMap(([, body]) => (body ?? '').split(';'))
        .map(declaration => declaration.trim().split(/:\s*/, 2))
        .filter(([property, value]) => property && value);
      return Object.fromEntries(declarations);
    };
    const logo = finalDeclarations('.brand svg');
    expect(logo.color).toBe('var(--hex-f5a524)');
    for (const theme of [':root{', ':root[data-theme="dark"]{']) {
      const start = css.indexOf(theme);
      const end = css.indexOf('}', start);
      expect(css.slice(start, end)).toContain('--hex-f5a524:#f5a524');
      expect(css.slice(start, end)).toContain('--hex-2a2e37:#2a2e37');
    }
    const selected = finalDeclarations('.main-nav button[aria-current=true]');
    expect(selected).toMatchObject({ background: 'var(--hex-2a2e37)', color: '#fff', 'font-weight': '600' });
    expect(selected.background).not.toBe(selected.color);
  });
  it('keeps Inbox text at WCAG AA contrast in the light theme', () => {
    const css = readFileSync(new URL('../../web/styles.css', import.meta.url), 'utf8');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
      selectors: selector.split(',').map(value => value.trim()), body,
    }));
    const root = rules.find(rule => rule.selectors.includes(':root'))!.body;
    const tokens = Object.fromEntries([...root.matchAll(/(--[\w-]+):([^;]+);/g)].map(([, name, value]) => [name, value]));
    const declaration = (selector: string, property: string) => {
      const rule = rules.filter(item => item.selectors.includes(selector)).pop();
      expect(rule, `CSS rule for ${selector}`).toBeTruthy();
      return rule!.body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1].trim().replace(/\s*!important$/, '');
    };
    const resolve = (value: string | undefined) => {
      const token = value?.match(/^var\((--[\w-]+)\)$/)?.[1];
      return token ? tokens[token] : value;
    };
    const luminance = (value: string | undefined) => {
      expect(value).toMatch(/^#[\da-f]{6}$/i);
      const channels = [1, 3, 5].map(index => parseInt(value!.slice(index, index + 2), 16) / 255)
        .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const pairs = [
      ['.inbox-item[aria-current=true]', '--text', '--lane'],
      ['.inbox-detail .evidence', '--text', '--lane'],
      ['.inbox-heading .quiet', '--text', '--card'],
      ['.inbox-detail .action-form button.primary', '--text', '--card'],
      ['.inbox-detail .action-form input', '--text', '--card'],
      ['.inbox-detail .action-form select', '--text', '--card'],
    ];
    for (const [selector, foreground, background] of pairs) {
      expect(resolve(declaration(selector, 'color'))).toBe(tokens[foreground]);
      expect(resolve(declaration(selector, 'background'))).toBe(tokens[background]);
      const light = luminance(tokens[foreground]);
      const dark = luminance(tokens[background]);
      expect((Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05), selector).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('keeps five ordered lanes and badges exceptional states in their work lane', () => {
    expect(trackerLaneNames).toEqual(['Ready to claim', 'Claimed', 'Checking & review', 'Queued', 'Landed']);
    expect(trackerLaneForIssue({ status: 'blocked', hasLease: true })).toEqual({ lane: 'Claimed', badge: 'blocked' });
    expect(trackerLaneForIssue({ status: 'stale', queueState: 'queued' })).toEqual({ lane: 'Queued', badge: 'stale' });
  });
});

describe('profile and inbox helpers', () => {
  it('classifies demo repositories and keeps regular repositories first in stable order', () => {
    const repos: Array<{ repoId: string; displayName?: string }> = [{ repoId: 'dispatch_demo-01' }, { repoId: 'dispatch_demo-02' }, { repoId: 'concord-v2' },
      { repoId: 'mother-base-v2' }, { repoId: 'other', displayName: 'landdemo' }];
    expect(isDemoRepo(repos[4])).toBe(true);
    expect(orderedRepos(repos).map((repo: { repoId: string }) => repo.repoId)).toEqual(['concord-v2', 'mother-base-v2', 'dispatch_demo-01', 'dispatch_demo-02', 'other']);
    expect(visibleRepos(repos).map((repo: { repoId: string }) => repo.repoId)).toEqual(['concord-v2', 'mother-base-v2']);
    expect(visibleRepos(repos, true)).toHaveLength(5);
    expect(chooseInitialRepo(repos, 'dispatch_demo-02', 'mother-base-v2')).toBe('dispatch_demo-02');
    expect(chooseInitialRepo(repos, null, 'mother-base-v2')).toBe('mother-base-v2');
    expect(chooseInitialRepo(repos, null, 'missing')).toBe('concord-v2');
  });
  it('counts actionable inbox items and adds exposed planning problems', () => {
    expect(inboxCount(fixture)).toBe(3);
    const blocked = { data: { projections: { queue: { blockedReason: 'PROMOTION_FAILED', contests: [
      { contestId: 'contest-1', intentKey: 'same-file', unitKey: 'file:a', state: 'blocked' },
    ] } } } };
    expect(inboxCount(blocked)).toBe(2);
  });
  it('uses initials without an avatar and selects the Access logout route only for Access identities', () => {
    expect(avatarInitials('Seb Patron Soto')).toBe('SS');
    expect(avatarInitials('  Ada  ')).toBe('AD');
    expect(avatarInitials('')).toBe('?');
    expect(signOutTarget({ authMethod: 'access', logoutUrl: '/v1/session/signout' })).toBe('/v1/session/signout');
    expect(signOutTarget({ principalId: 'token-user' })).toBeNull();
  });

  it('uses a static principal avatar, keeps initials visible until load, and prefers trusted avatar URLs', async () => {
    for (const [identity, expectedSrc] of [
      [{ principalId: 'seb', name: 'Seb Patron Soto' }, '/avatars/seb.jpeg'],
      [{ principalId: 'seb', name: 'Seb Patron Soto', avatarUrl: 'https://avatars.example.com/seb.png' }, 'https://avatars.example.com/seb.png'],
    ] as const) {
      clearSessionToken();
      const dom = new JSDOM(readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/' });
      const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
      Object.assign(globalThis, { document: dom.window.document, window: dom.window });
      dom.window.HTMLElement.prototype.scrollIntoView = () => {};
      dom.window.scrollTo = () => {};
      dom.window.setInterval = (() => 1) as any;
      globalThis.fetch = (async (url: string) => {
        if (url === '/health') return Response.json({ data: { accessSignIn: true } });
        if (url === '/v1/session') return Response.json({ data: { principalId: 'seb', roles: ['owner'], authMethod: 'access', expiresAt: Date.now() + 60_000 } });
        if (url === '/v1/me') return Response.json({ data: { ...identity, roles: ['owner'], repoIds: '*' } });
        if (url === '/v1/repos') return Response.json({ data: { items: [] } });
        return Response.json({ data: {} });
      }) as any;
      try {
        if (expectedSrc.startsWith('/avatars/')) {
          // @ts-expect-error Browser JS is intentionally untyped.
          await import('../../web/app.js?profile-avatar-static');
        } else {
          // @ts-expect-error Browser JS is intentionally untyped.
          await import('../../web/app.js?profile-avatar-trusted');
        }
        await new Promise(resolve => setTimeout(resolve, 0));
        const doc = dom.window.document;
        const avatar = doc.getElementById('profile-avatar') as HTMLImageElement;
        const initials = doc.getElementById('profile-initials')!;
        expect(avatar.getAttribute('src')).toBe(expectedSrc);
        expect(avatar.hidden).toBe(true);
        expect(initials.hidden).toBe(false);
        avatar.onload?.(new dom.window.Event('load') as any);
        expect(avatar.hidden).toBe(false);
        expect(initials.hidden).toBe(true);
        avatar.onerror?.(new dom.window.Event('error') as any);
        expect(avatar.hidden).toBe(true);
        expect(initials.hidden).toBe(false);
        expect(initials.textContent).toBe('SS');
      } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
        clearSessionToken();
      }
    }
  });
});

it('sends versioned settings and owner decisions to same-origin routes', async () => {
  const seen: Array<{ path: string; method: string; body: any }> = [];
  const fake = async (path: string, options: RequestInit) => {
    seen.push({ path, method: options.method ?? 'GET', body: options.body ? JSON.parse(String(options.body)) : null });
    return new Response(JSON.stringify({ data: {}, version: 4 }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await getSettings('repo', fake);
  await putSettings('repo', { expectedVersion: 3, protectedPaths: [{ pattern: 'AGENTS.md', level: 'human-only' }] }, 'key', fake);
  await submitHumanApproval('repo', 'change', { expectedVersion: 4, decision: 'approve' }, 'key2', fake);
  expect(seen.map(call => `${call.method} ${call.path}`)).toEqual([
    'GET /v1/repos/repo/settings', 'PUT /v1/repos/repo/settings', 'POST /v1/repos/repo/changes/change/human-approval',
  ]);
  expect(seen[1].body.protectedPaths[0].level).toBe('human-only');
});

const fixture = {
  data: { projections: {
    repos: { changes: [
      { changeId: 'x', authorId: 'agent-a', authorModel: 'model-from-api', intentText: 'Cap retries', unitKeys: ['fn:retry'], status: 'ready', revision: 2, headOid: 'abc123', baseOid: 'base' },
      { changeId: 'y', authorId: 'agent-b', intentText: 'Rename logs', unitKeys: ['file:log'], status: 'blocked', revision: 1, headOid: 'def456' },
    ], repo: { observedCanonicalOid: 'main123' } },
    leases: { items: [{ leaseId: 'l1', changeId: 'x', holderId: 'agent-a', intentText: 'Protect retry path', unitKey: 'fn:retry', fence: 3, expiresAt: Date.now() + 120000, state: 'active' }],
      heldItems: [
        ...Array.from({ length: 3 }, (_, index) => ({ leaseId: `a${index}`, changeId: 'x', holderId: 'agent-a',
          intentText: 'Protect retry path', unitKey: `fn:retry-${index}`, fence: 3, expiresAt: Date.now() + 120000, state: 'active', issueNumber: 1 })),
        { leaseId: 'b', changeId: 'x', holderId: 'agent-b', intentText: 'Protect retry path', unitKey: 'fn:retry-b', fence: 4, expiresAt: Date.now() + 120000, state: 'reserved', issueNumber: 1 },
        { leaseId: 'expired', changeId: 'x', holderId: 'agent-c', unitKey: 'fn:expired', expiresAt: Date.now() - 1, state: 'active', issueNumber: 1 },
        { leaseId: 'released', changeId: 'x', holderId: 'agent-d', unitKey: 'fn:released', expiresAt: Date.now() + 120000, state: 'released', issueNumber: 1 },
      ],
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
  it('includes the stored close reason in the terminal change detail', () => {
    expect(changeNextAction({ status: 'closed', closeReason: 'dup' }).detail).toContain('dup');
    expect(changeNextAction({ status: 'closed' }).detail).toBe('Closed without landing.');
  });
  it('counts distinct current lease holders and keeps every live lease as evidence', () => {
    const now = new Date('2026-10-13T00:02:00Z').valueOf();
    const held = [
      ...Array.from({ length: 3 }, (_, i) => ({ leaseId: `a${i}`, holderId: 'a', unitKey: `u${i}`, state: 'active', expiresAt: now + 60000 })),
      { leaseId: 'b', holderId: 'b', unitKey: 'ub', state: 'reserved', expiresAt: now + 60000 },
      { leaseId: 'expired', holderId: 'c', state: 'active', expiresAt: now - 1 },
      { leaseId: 'released', holderId: 'd', state: 'released', expiresAt: now + 60000 },
    ];
    const result = liveLeaseHolders(held, now);
    expect(result.count).toBe(2);
    expect(result.evidence).toHaveLength(4);
    expect(result.holders).toEqual(new Set(['a', 'b']));
  });
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
    snapshot.data.projections.leases.heldItems[0].issueNumber = 1;
    const row = openIssueRows(snapshot)[0];
    expect(row).toMatchObject({ number: 1, title: '<task>', milestone: 'Release', changes: [{ status: 'ready' }] });
    expect(row.leases.map((lease: any) => lease.leaseId)).toEqual(['a0', 'a1', 'a2', 'b']);
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
  it('hides demo repos by default and chooses the requested, remembered, or concord repo', async () => {
    const repos: Array<{ repoId: string; displayName?: string }> = [{ repoId: 'dispatch_demo-01' }, { repoId: 'dispatch_demo-02' }, { repoId: 'concord-v2' }, { repoId: 'mother-base-v2' }];
    const mount = async (url: string, storedRepo?: string, brokenStorage = false) => {
      clearSessionToken();
      const dom = new JSDOM(readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'), { url });
      if (brokenStorage) Object.defineProperty(dom.window, 'localStorage', { configurable: true, get() { throw new Error('storage denied'); } });
      else if (storedRepo) dom.window.localStorage.setItem('concord-last-repo', storedRepo);
      const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
      Object.assign(globalThis, { document: dom.window.document, window: dom.window });
      dom.window.HTMLElement.prototype.scrollIntoView = () => {};
      dom.window.setInterval = (() => 1) as any;
      globalThis.fetch = (async (path: string) => {
        if (path === '/v1/session') return new Response('', { status: 401 });
        if (path === '/health') return Response.json({ data: {} });
        if (path === '/v1/me') return Response.json({ data: { principalId: 'owner', roles: ['owner'], repoIds: repos.map(repo => repo.repoId) } });
        if (path === '/v1/repos') return Response.json({ data: { items: repos } });
        if (path.endsWith('/snapshot')) return Response.json({ data: { projections: {} }, version: 0, eventSeq: 0 });
        if (path.includes('/events?')) return Response.json({ data: { items: [] }, version: 0, eventSeq: 0 });
        if (path.startsWith('/v1/principals')) return Response.json({ data: { items: [], nextCursor: null } });
        return new Response('', { status: 404 });
      }) as any;
      try {
        vi.resetModules();
        // @ts-expect-error Browser JS is intentionally untyped.
        await import('../../web/app.js');
        const doc = dom.window.document;
        (doc.getElementById('token-input') as HTMLInputElement).value = 'demo-test-token';
        doc.getElementById('token-form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
        for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0));
        return { dom, doc, restore: () => Object.assign(globalThis, previous) };
      } catch (error) { Object.assign(globalThis, previous); dom.window.close(); throw error; }
    };
    const first = await mount('http://localhost/', undefined, true);
    try {
      expect(first.doc.getElementById('repo-link')?.textContent).toBe('concord-v2');
      first.doc.getElementById('profile-toggle')!.dispatchEvent(new first.dom.window.Event('click', { bubbles: true }));
      expect(first.doc.getElementById('profile-repos')?.textContent).toContain('concord-v2');
      expect(first.doc.getElementById('profile-repos')?.textContent).toContain('mother-base-v2');
      expect(first.doc.getElementById('profile-repos')?.textContent).not.toContain('dispatch_demo');
      const toggle = [...first.doc.querySelectorAll('#profile-repos button')].find(button => button.textContent === 'Show 2 demo repos') as HTMLButtonElement;
      expect(toggle).toBeTruthy(); toggle.click();
      expect(first.doc.getElementById('profile-repos')?.textContent).toContain('dispatch_demo-01');
      ([...first.doc.querySelectorAll('#profile-repos button')].find(button => button.textContent === 'Hide demo repos') as HTMLButtonElement).click();
      first.doc.getElementById('repo-owner')!.dispatchEvent(new first.dom.window.Event('click', { bubbles: true, cancelable: true }));
      expect(first.doc.getElementById('repositories-list')?.textContent).not.toContain('dispatch_demo');
      expect(first.doc.getElementById('repositories-list')?.textContent).toContain('Show 2 demo repos');
      first.doc.getElementById('token-clear')!.click();
    } finally { first.restore(); first.dom.window.close(); }

    clearSessionToken();
  });
  it('uses an Access session on load and leaves the token form for anonymous visitors', async () => {
    for (const [access, enabled] of [[true, true], [false, true], [false, false]]) {
      clearSessionToken();
      const dom = new JSDOM(readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/' });
      const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
      Object.assign(globalThis, { document: dom.window.document, window: dom.window });
      dom.window.HTMLElement.prototype.scrollIntoView = () => {};
      dom.window.scrollTo = () => {};
      dom.window.setInterval = (() => 1) as any;
      const requests: Array<{ url: string; authorization: string | null }> = [];
      globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
        requests.push({ url, authorization: new Headers(init.headers).get('authorization') });
        if (url === '/health') return Response.json({ data: { accessSignIn: enabled } });
        if (url === '/v1/session') return new Response(JSON.stringify(access ? { data: { principalId: 'phone-owner',
          roles: ['owner'], authMethod: 'access', expiresAt: Date.now() + 60_000,
          logoutUrl: '/v1/session/signout' } } :
          { error: { code: 'UNAUTHORIZED' } }), { status: access ? 200 : 401 });
        if (url === '/v1/me') return Response.json({ data: { principalId: 'phone-owner', roles: ['owner'], repoIds: '*',
          avatarUrl: 'https://avatars.example.com/phone-owner.png' } });
        if (url === '/v1/repos') return Response.json({ data: { items: access ? [{ repoId: 'access-repo' }] : [] } });
        if (url === '/v1/repos/access-repo/snapshot') return Response.json({ data: { projections: {} }, version: 0, eventSeq: 0 });
        if (url.startsWith('/v1/repos/access-repo/events')) return Response.json({ data: { items: [] }, version: 0, eventSeq: 0 });
        if (url.startsWith('/v1/repos/access-repo/metrics')) return new Response('', { status: 404 });
        if (url === '/v1/principals') return Response.json({ data: { items: [] } });
        return Response.json({ data: { mode: 'production', storageBackend: 'artifacts' } });
      }) as any;
      try {
        if (access) {
          // @ts-expect-error Browser JS is intentionally untyped.
          await import('../../web/app.js?access-dom-yes');
        } else if (enabled) {
          // @ts-expect-error Browser JS is intentionally untyped.
          await import('../../web/app.js?access-dom-no-enabled');
        } else {
          // @ts-expect-error Browser JS is intentionally untyped.
          await import('../../web/app.js?access-dom-no-disabled');
        }
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 0));
        const doc = dom.window.document;
        expect(doc.getElementById('signed-out')!.hidden).toBe(access);
        expect(doc.getElementById('token-form')!.closest('#signed-out')!.hidden).toBe(access);
        expect((doc.getElementById('access-signin') as HTMLAnchorElement).hidden).toBe(access || !enabled);
        if (access) {
          expect(doc.getElementById('principal')!.textContent).toBe('Signed in as phone-owner via Cloudflare Access');
          expect((doc.getElementById('access-logout') as HTMLAnchorElement).href).toBe('http://localhost/v1/session/signout');
          expect((doc.getElementById('profile-avatar') as HTMLImageElement).alt).toBe('phone-owner');
          expect((doc.getElementById('profile-avatar') as HTMLImageElement).getAttribute('referrerpolicy')).toBe('no-referrer');
          expect(doc.getElementById('inbox-button')!.hidden).toBe(false);
          expect(doc.getElementById('inbox-badge')!.hidden).toBe(true);
          (doc.getElementById('profile-toggle') as HTMLButtonElement).click();
          expect(doc.getElementById('profile-menu')!.hidden).toBe(false);
          doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          expect(doc.getElementById('profile-menu')!.hidden).toBe(true);
          (doc.getElementById('inbox-button') as HTMLButtonElement).click();
          expect(doc.getElementById('desk')!.dataset.mainViewActive).toBe('inbox');
          (doc.querySelector('[data-main-view="issues"]') as HTMLButtonElement).click();
          expect(requests.every(request => request.authorization === null)).toBe(true);
          expect(doc.getElementById('tracker-view')!.hidden).toBe(false);
          for (const view of ['code', 'issues', 'tracker', 'settings']) {
            (doc.querySelector(`[data-main-view="${view}"]`) as HTMLButtonElement).click();
            expect(doc.getElementById('desk')!.dataset.mainViewActive).toBe(view);
            expect(doc.querySelector(`[data-main-view="${view}"]`)!.getAttribute('aria-current')).toBe('true');
            const visibleSection = view === 'issues' ? 'issues-view' : view === 'tracker' ? 'desk-view' : `${view}-view`;
            expect(doc.getElementById(visibleSection)!.hidden).toBe(false);
            expect(doc.getElementById('settings-panel')!.hidden).toBe(view !== 'settings');
          }
          (doc.querySelector('[data-issues-tab="milestones"]') as HTMLButtonElement).click();
          expect(doc.getElementById('milestones-view')!.hidden).toBe(false);
          expect(new URL(doc.location.href).searchParams.get('view')).toBe('milestones');
          (doc.querySelector('[data-issues-tab="issues"]') as HTMLButtonElement).click();
          expect(doc.getElementById('tracker-view')!.hidden).toBe(false);
          (doc.getElementById('inbox-alert') as HTMLButtonElement).click();
          expect(doc.getElementById('desk')!.dataset.mainViewActive).toBe('inbox');
          expect(doc.getElementById('inbox-view')!.hidden).toBe(false);
          expect(doc.getElementById('settings-panel')!.hidden).toBe(true);
        }
      } finally {
        Object.assign(globalThis, previous);
        dom.window.close();
        clearSessionToken();
      }
    }
  });
  it('shows browser sign-in failures safely and refuses malformed pasted tokens before fetching', async () => {
    clearSessionToken();
    const dom = new JSDOM(readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/' });
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    Object.assign(globalThis, { document: dom.window.document, window: dom.window });
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.scrollTo = () => {};
    dom.window.setInterval = (() => 1) as any;
    const requests: string[] = [];
    const secret = 'cct_tenant_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    globalThis.fetch = (async (url: string) => {
      requests.push(url);
      if (url === '/v1/session') return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
      if (url === '/health') return Response.json({ data: { accessSignIn: false } });
      if (url === '/v1/me') throw new TypeError(`Load failed ${secret}`);
      return Response.json({ data: { items: [] } });
    }) as any;
    try {
      // @ts-expect-error Browser JS is intentionally untyped.
      await import('../../web/app.js?access-error-redaction');
      await new Promise(resolve => setTimeout(resolve, 0));
      const doc = dom.window.document;
      (doc.getElementById('token-input') as HTMLInputElement).value = secret;
      doc.getElementById('token-form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
      const message = doc.getElementById('session-error')!.textContent!;
      expect(message).toContain('NETWORK_UNREACHABLE');
      expect(message).toContain('Load failed');
      expect(message).not.toContain(secret);
      const meRequests = requests.filter(url => url === '/v1/me').length;
      Object.defineProperty(doc.getElementById('token-input')!, 'value', { configurable: true, value: 'abc\ndef' });
      doc.getElementById('token-form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      expect(doc.getElementById('session-error')!.textContent).toContain('position 4');
      expect(requests.filter(url => url === '/v1/me')).toHaveLength(meRequests);
    } finally {
      Object.assign(globalThis, previous);
      dom.window.close();
      clearSessionToken();
    }
  });

  it('shows first run on 401, then renders the desk, inbox and verdict route', async () => {
    clearSessionToken();
    const dom = new JSDOM(readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'), { url: 'http://localhost/' });
    dom.window.localStorage.setItem('concord-last-repo', 'demo');
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
    let snapshotVersion = 7;
    let eventVersion = 7;
    let releaseSnapshot8: (() => void) | undefined;
    let releaseSnapshot10: (() => void) | undefined;
    let releaseSecondSnapshot: (() => void) | undefined;
    let delayNextSnapshot8 = true;
    let delayNextSnapshot10 = true;
    let mutationVersion = 7;
    let staleNextEnqueue = false;
    let failNextSnapshot = false;
    let claimConflict = false;
    let interaction = false;
    let changeStatus = 'ready';
    let extraChanges: any[] = [];
    let extraIssues: any[] = [];
    let verdictInflight = 0;
    let verdictMaxInflight = 0;
    const verdictRequests: string[] = [];
    let principalPageCalls = 0;
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
        else body = { data: { principalId: 'reviewer', roles: ['reviewer'], repoIds: ['demo', 'second'], model: null } };
      } else if (url === '/v1/repos') body = { data: { items: token === 'Bearer empty' ? [] : [{ repoId: 'demo', displayName: 'Demo' }, { repoId: 'second', displayName: 'Second' }] } };
      else if (url.startsWith('/v1/principals')) {
        principalPageCalls++;
        body = { data: { items: [], nextCursor: `page-${principalPageCalls}` } };
      }
      else if (url.endsWith('/snapshot')) {
        if (url === '/v1/repos/second/snapshot') return await new Promise<Response>(resolve => {
          releaseSecondSnapshot = () => resolve(new Response(JSON.stringify(fixture)));
        });
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
            changes: [...fixture.data.projections.repos.changes.map(c => c.changeId === 'x'
              ? { ...c, status: changeStatus, intentText: snapshotVersion === 9 ? 'Current version 9' : c.intentText } : c), ...extraChanges] },
          issues: { ...fixture.data.projections.issues,
            items: [...fixture.data.projections.issues.items, ...extraIssues] },
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
      else if (/\/changes\/([^/?]+)\/verdicts/.test(url) && init.method !== 'POST') {
        const id = /\/changes\/([^/?]+)\/verdicts/.exec(url)![1];
        verdictRequests.push(id); verdictInflight += 1;
        verdictMaxInflight = Math.max(verdictMaxInflight, verdictInflight);
        await Promise.resolve();
        verdictInflight -= 1;
        body = { data: { items: [{ verdictId: `v-${id}`, changeId: id, reviewerId: 'other-reviewer',
          decision: 'approve', revision: 1, findingSetVersion: 0, parentVerdictId: `v-parent-${id}` }] } };
      }
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
      vi.resetModules();
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
      expect(principalPageCalls).toBe(0);
      expect(byId('desk').hidden).toBe(false);
      expect(byId('desk-view').hidden).toBe(false);
      expect(byId('repo-owner').textContent).toBe('reviewer');
      expect(byId('repo-link').textContent).toBe('demo');
      expect(doc.querySelector('#repo-select')).toBeNull();
      (doc.querySelector('[data-main-view="issues"]') as HTMLButtonElement).click();
      expect(byId('tracker-view').textContent).toContain('#1 <task>');
      expect(byId('tracker-view').querySelector('task')).toBeNull();
      expect([...doc.querySelectorAll('[data-main-view]')].map((button: any) => button.textContent)).toEqual(['Code', 'Issues', 'Tracker', 'Settings']);
      expect(doc.querySelector('[data-main-view="inflight"]')).toBeNull();
      (doc.querySelector('[data-main-view="issues"]') as HTMLButtonElement).click();
      expect(byId('tracker-view').hidden).toBe(false);
      (doc.querySelector('[data-main-view="settings"]') as HTMLButtonElement).click();
      expect(byId('settings-view').textContent).toContain('Path protection');
      expect(byId('settings-view').textContent).toContain('Who can create milestones:');
      expect(byId('settings-view').textContent).toContain('Repository ID');
      expect(byId('settings-view').textContent).toContain('demo');
      expect((byId('settings-form').querySelector('input') as HTMLInputElement).disabled).toBe(true);
      expect(byId('settings-view').textContent).toContain('Only repository owners can change path protection.');
      expect((byId('milestone-settings-content').querySelector('select') as HTMLSelectElement).disabled).toBe(true);
      (doc.querySelector('[data-main-view="tracker"]') as HTMLButtonElement).click();
      expect(byId('inbox-alert').hidden).toBe(false);
      (doc.querySelector('[data-main-view="tracker"]') as HTMLButtonElement).click();
      expect(byId('desk-view').hidden).toBe(false);
      expect(byId('stat-strip').textContent).toContain('Agents working2');
      expect(byId('stat-strip').textContent).toContain('live lease holders');
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
      await flush(); await flush();
      expect(byId('inbox-detail').textContent).toContain('Cap retries');
      expect(byId('inbox-detail').textContent).toContain('ready for independent review');
      expect(byId('inbox-detail').textContent).toContain('Head: abc123');
      expect(byId('inbox-detail').textContent).toContain('Approval history');
      expect(byId('inbox-detail').textContent).toContain('Direct approve');
      expect(byId('inbox-detail').querySelector('.inbox-actions')).toBeTruthy();
      const inboxManifest = byId('inbox-detail').querySelector('input[name="manifest"]') as HTMLInputElement;
      inboxManifest.value = 'sha256:in-progress'; inboxManifest.focus();
      (byId('refresh-button') as HTMLButtonElement).click(); await flush();
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
      (byId('work-board').querySelector('[data-change-id="x"]') as HTMLButtonElement).click();
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
      manifest.focus(); (byId('refresh-button') as HTMLButtonElement).click(); await flush();
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
      (doc.querySelector('[data-main-view="tracker"]') as HTMLButtonElement).click();
      (byId('work-board').querySelector('[data-change-id="x"]') as HTMLButtonElement).click();
      await flush(); await flush();
      expect(byId('verdict-list').textContent).toContain('Approval history is visible to reviewers');
      expect(byId('inbox-list').textContent).toContain('Review requested');
      byId('token-clear').click();
      (byId('token-input') as HTMLInputElement).value = 'local-agent-a';
      byId('token-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(); await flush();
      expect(byId('principal').textContent).toContain('role unverified');
      (byId('work-board').querySelector('[data-change-id="x"]') as HTMLButtonElement).click();
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
      (byId('work-board').querySelector('[data-change-id="x"]') as HTMLButtonElement).click();
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
      (byId('repo-owner') as HTMLAnchorElement).click();
      expect(byId('repositories-list').textContent).toContain('No repositories yet');
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
      (byId('work-board').querySelector('[data-change-id="x"]') as HTMLButtonElement).click();
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
      (byId('refresh-button') as HTMLButtonElement).click(); await flush(); await flush();
      expect((raceEnqueue.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
      raceEnqueue.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await flush(); await flush();
      expect(requests.filter(r => r.url === '/v1/repos/demo/queue/enqueue' && r.init.method === 'POST')).toHaveLength(requestsBeforeRetry + 1);
      expect(byId('work-board').textContent).toContain('Current version 9');
      expect(byId('work-board').textContent).not.toContain('Stale version 8');
      // An in-flight v10 snapshot cannot clear the v11 requirement from a stale refusal.
      snapshotVersion = 10; eventVersion = 10;
      (byId('refresh-button') as HTMLButtonElement).click();
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
      (byId('refresh-button') as HTMLButtonElement).click(); await flush(); await flush();
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
      (byId('refresh-button') as HTMLButtonElement).click(); await flush();
      expect(byId('action-panel').querySelector('input[name="intentText"]')).toBe(retainedClaim);
      expect(retainedClaim.value).toBe('Unsubmitted lease intent');
      const historyRequests = requests.filter(request => request.url === '/v1/repos/demo/changes/x/verdicts').length;
      changeStatus = 'merged'; snapshotVersion = 12; eventVersion = 12;
      (byId('refresh-button') as HTMLButtonElement).click(); await flush(); await flush();
      expect(requests.filter(request => request.url === '/v1/repos/demo/changes/x/verdicts')).toHaveLength(historyRequests + 1);
      expect(byId('detail-body').textContent).toContain('Status: merged');
      expect(byId('action-panel').textContent).not.toContain('Claim');
      expect(byId('action-panel').textContent).not.toContain('Enqueue');
      expect(byId('action-panel').textContent).not.toContain('Submit verdict');
      expect(byId('action-panel').querySelectorAll('form')).toHaveLength(0);
      extraIssues = [
        { number: 50, title: 'Old landed', state: 'closed', milestoneId: 'm1', closedBy: { changeId: 'm0' }, labels: [] },
        ...Array.from({ length: 8 }, (_, index) => ({ number: 60 + index, title: `Ready ${index}`, state: 'open', milestoneId: 'm1', labels: [] })),
      ];
      extraChanges = [
        { changeId: 'm0', issueNumber: 50, status: 'merged', revision: 1, authorId: 'agent-z' },
        ...Array.from({ length: 8 }, (_, index) => ({ changeId: `r${index}`, issueNumber: 60 + index, status: 'ready', revision: 1, authorId: `agent-${index}` })),
      ];
      snapshotVersion = 13; eventVersion = 13;
      (byId('refresh-button') as HTMLButtonElement).click(); await flush(); await flush(); await flush();
      expect(verdictRequests).not.toContain('m0');
      for (let index = 0; index < 8; index++) expect(verdictRequests).not.toContain(`r${index}`);
      expect(verdictMaxInflight).toBeLessThanOrEqual(4);
      (doc.querySelector('[data-main-view="issues"]') as HTMLButtonElement).click();
      const landedCard = [...byId('tracker-view').querySelectorAll('.tracker-card')]
        .find(card => card.textContent?.includes('#50')) as HTMLButtonElement;
      landedCard.click(); await flush(); await flush(); await flush();
      expect(verdictRequests.filter(id => id === 'm0')).toHaveLength(1);
      expect(byId('tracker-view').querySelector('.tracker-timeline')?.textContent).toContain('verdict.carried');
      snapshotVersion = 14; eventVersion = 14;
      (byId('refresh-button') as HTMLButtonElement).click(); await flush(); await flush();
      expect(verdictRequests.filter(id => id === 'm0')).toHaveLength(1);
      eventVersion = 6; (byId('refresh-button') as HTMLButtonElement).click(); await flush();
      expect(byId('event-log').textContent).not.toContain('stale.event');

      (byId('inbox-alert') as HTMLButtonElement).click();
      (doc.querySelector('[data-main-view="tracker"]') as HTMLButtonElement).click();
      expect(byId('repo-link').textContent).toBe('demo');
      expect(doc.querySelector('#repo-select')).toBeNull();
      (byId('repo-owner') as HTMLAnchorElement).click();
      const secondRepo = [...byId('repositories-list').querySelectorAll('button')]
        .find(button => button.textContent === 'Second') as HTMLButtonElement;
      secondRepo.click();
      expect(byId('repo-link').textContent).toBe('second');
      expect(dom.window.location.search).toBe('?view=code&repo=second');
      expect(byId('inbox-alert').hidden).toBe(true);
      expect(byId('alert-count').textContent).toContain('0 decisions');
      releaseSecondSnapshot?.(); await flush(); await flush(); await flush(); await flush(); await flush();
    } finally {
      releaseSnapshot10?.();
      releaseSecondSnapshot?.();
      clearSessionToken();
      Object.assign(globalThis, previous);
      dom.window.close();
    }
  }, 20_000);

  async function publicDom(repoId: string, isPublic: boolean, readyCount = 1, view?: string) {
    clearSessionToken();
    const dom = new JSDOM(readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'), { url: `http://localhost/?repo=${repoId}${view ? `&view=${view}` : ''}` });
    const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    Object.assign(globalThis, { document: dom.window.document, window: dom.window });
    dom.window.HTMLElement.prototype.scrollIntoView = () => {};
    dom.window.scrollTo = () => {};
    dom.window.setInterval = (() => 1) as any;
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const publicSnapshot = {
      ...fixture,
      data: { projections: {
        ...fixture.data.projections,
        repos: { ...fixture.data.projections.repos,
          changes: [fixture.data.projections.repos.changes[0],
            ...Array.from({ length: readyCount - 1 }, (_, i) => ({ ...fixture.data.projections.repos.changes[0],
              changeId: 'ready-' + i, issueNumber: i + 2 }))] },
      } },
      version: 7, eventSeq: 0,
    };
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      requests.push({ url, authorization: new Headers(init.headers).get('authorization') });
      if (url === '/health') return Response.json({ data: { mode: 'production', storageBackend: 'artifacts' } });
      if (url === '/v1/session') return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
      if (url.endsWith('/snapshot')) return new Response(JSON.stringify(isPublic
        ? publicSnapshot : { error: { code: 'UNAUTHORIZED', message: 'Bearer credential required' } }), { status: isPublic ? 200 : 401 });
      if (url.includes('/events?')) return Response.json({ data: { items: [] }, version: 7, eventSeq: 0 });
      if (url.includes('/metrics?')) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND' } }), { status: 404 });
      if (url.includes('/verdicts')) return Response.json({ data: { items: [], nextCursor: null }, version: 7 });
      return Response.json({ data: {} });
    }) as any;
    const doc = dom.window.document;
    const byId = (id: string) => doc.getElementById(id)!;
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));
    return { dom, doc, byId, flush, requests, previous };
  }

  it('opens the legacy milestones deep link on the Issues Milestones tab', async () => {
    const { dom, doc, flush, previous } = await publicDom('milestone-link', true, 1, 'milestones');
    try {
      vi.resetModules();
      // @ts-expect-error Browser JS is intentionally untyped.
      await import('../../web/app.js?milestones-deep-link');
      await flush(); await flush(); await flush();
      expect(doc.getElementById('issues-view')!.hidden).toBe(false);
      expect(doc.getElementById('milestones-view')!.hidden).toBe(false);
      expect(doc.querySelector('[data-main-view="issues"]')!.getAttribute('aria-current')).toBe('true');
      expect(doc.querySelector('[data-issues-tab="milestones"]')!.getAttribute('aria-current')).toBe('true');
    } finally {
      await flush(); await flush(); await flush();
      clearSessionToken();
      Object.assign(globalThis, previous);
      dom.window.close();
    }
  });

  it('opens public URL reads without a token and labels the view read-only', async () => {
    const { dom, doc, byId, flush, requests, previous } = await publicDom('public-demo', true);
    try {
      vi.resetModules();
      // @ts-expect-error Browser JS is intentionally untyped.
      await import('../../web/app.js');
      await flush(); await flush(); await flush(); await flush();
      (doc.querySelector('[data-main-view="issues"]') as HTMLButtonElement).click();
      expect(byId('desk').hidden).toBe(false);
      expect(byId('signed-out').hidden).toBe(true);
      expect(byId('principal').textContent).toBe('Public, read-only');
      expect(byId('tracker-view').textContent).toContain('#1');
      expect(byId('repo-link').textContent).toBe('public-demo');
      expect(dom.window.document.querySelector('#repo-select')).toBeNull();
      expect(requests.some(request => request.url.endsWith('/snapshot'))).toBe(true);
      expect(requests.every(request => request.authorization === null)).toBe(true);
      expect(byId('tracker-view').querySelectorAll('form')).toHaveLength(0);
    } finally {
      clearSessionToken();
      Object.assign(globalThis, previous);
      dom.window.close();
    }
  });

  it('refreshes on demand and when returning to a visible tab, without background polling', async () => {
    const { dom, byId, flush, requests, previous } = await publicDom('refresh-demo', true);
    try {
      vi.resetModules();
      // @ts-expect-error Browser JS is intentionally untyped.
      await import('../../web/app.js');
      await flush(); await flush(); await flush(); await flush();
      const count = (suffix: string) => requests.filter(request => request.url.includes(suffix)).length;
      const eventsBefore = count('/events?after=0');
      const snapshotsBefore = count('/snapshot');
      Object.defineProperty(dom.window.document, 'visibilityState', { configurable: true, value: 'visible' });
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(count('/events?after=0')).toBe(eventsBefore);
      expect(count('/snapshot')).toBe(snapshotsBefore);

      dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(count('/events?after=0')).toBe(eventsBefore + 1);
      dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
      dom.window.dispatchEvent(new dom.window.Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
      expect(count('/events?after=0')).toBe(eventsBefore + 1);

      expect((byId('refresh-button') as HTMLButtonElement).getAttribute('aria-label')).toBe('Refresh');
      (byId('refresh-button') as HTMLButtonElement).click();
      expect((byId('refresh-button') as HTMLButtonElement).disabled).toBe(true);
      (byId('refresh-button') as HTMLButtonElement).click();
      await vi.advanceTimersByTimeAsync(0);
      expect(count('/events?after=0')).toBe(eventsBefore + 2);
      expect(count('/snapshot')).toBe(snapshotsBefore);
      expect(byId('refresh-status').textContent).toMatch(/^Updated /);
    } finally {
      vi.useRealTimers();
      clearSessionToken();
      Object.assign(globalThis, previous);
      dom.window.close();
    }
  });

  it('shows the sign-in view for a private repo URL', async () => {
    const { dom, byId, flush, requests, previous } = await publicDom('private-demo', false);
    try {
      vi.resetModules();
      // @ts-expect-error Browser JS is intentionally untyped.
      await import('../../web/app.js');
      await flush(); await flush(); await flush();
      expect(byId('desk').hidden).toBe(true);
      expect(byId('signed-out').hidden).toBe(false);
      expect(byId('session-error').textContent).toContain('private or does not exist');
      expect(requests.every(request => request.authorization === null)).toBe(true);
    } finally {
      clearSessionToken();
      Object.assign(globalThis, previous);
      dom.window.close();
    }
  });

  it('shares the anonymous request budget across change selections', async () => {
    const { dom, doc, byId, flush, requests, previous } = await publicDom('crowded-public', true, 19);
    try {
      vi.resetModules();
      // @ts-expect-error Browser JS is intentionally untyped.
      await import('../../web/app.js');
      await flush(); await flush(); await flush(); await flush();
      (doc.querySelector('[data-main-view="issues"]') as HTMLButtonElement).click();
      for (let index = 0; index < 19; index++) {
        const changeId = index === 0 ? 'x' : 'ready-' + (index - 1);
        (doc.querySelector('[data-change-id="' + changeId + '"]') as HTMLElement)?.click();
        await flush();
      }
      const repoRequests = requests.filter(request => request.url.startsWith('/v1/repos/'));
      expect(repoRequests.length).toBeLessThanOrEqual(18);
      expect(repoRequests.some(request => request.url.includes('/changes/ready-17/verdicts'))).toBe(false);
      expect(byId('principal').textContent).toBe('Public, read-only');
    } finally {
      clearSessionToken();
      Object.assign(globalThis, previous);
      dom.window.close();
    }
  });
});

describe('layout and token contract', () => {
  it('documents public repository read authentication', () => {
    const guide = readFileSync(new URL('../../docs/api-repos.md', import.meta.url), 'utf8');
    expect(guide).not.toContain('All routes use `Authorization: Bearer');
    expect(guide).toContain('except credentialless GET reads under a public repository');
  });
  it('keeps the dashboard HTML balanced and all views inside the signed-in shell', () => {
    const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
    const stack: string[] = [];
    const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
    for (const match of html.matchAll(/<!--[\s\S]*?-->|<![^>]*>|<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
      const token = match[0];
      const tag = match[1]?.toLowerCase();
      if (!tag || token.startsWith('<!')) continue;
      if (token.startsWith('</')) expect(stack.pop()).toBe(tag);
      else if (!voidElements.has(tag) && !/\/\s*>$/.test(token)) stack.push(tag);
    }
    expect(stack).toEqual([]);
    const dom = new JSDOM(html);
    const desk = dom.window.document.getElementById('desk')!;
    for (const id of ['desk-view', 'inbox-view', 'code-view']) {
      expect(desk.contains(dom.window.document.getElementById(id))).toBe(true);
    }
  });
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
  it('sends If-None-Match and reuses the cached snapshot body after 304', async () => {
    clearSessionToken();
    const seen: RequestInit[] = [];
    let calls = 0;
    const fetchSnapshot = async (_url: string, init: RequestInit) => {
      seen.push(init);
      calls++;
      if (calls === 1) return Response.json({ data: { projections: { repos: { changes: [{ changeId: 'cached' }] } } }, version: 4, eventSeq: 8 },
        { headers: { etag: '"v4-owner-t3"' } });
      return new Response(null, { status: 304, headers: { etag: '"v4-owner-t3"' } });
    };
    const first = await getSnapshot('snapshot-ui-cache', fetchSnapshot);
    const second = await getSnapshot('snapshot-ui-cache', fetchSnapshot);
    expect(new Headers(seen[1].headers).get('if-none-match')).toBe('"v4-owner-t3"');
    expect(second).toEqual(first);
    expect(snapshotCollections(second).changes.items[0].changeId).toBe('cached');
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
});
