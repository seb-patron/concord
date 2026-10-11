/**
 * Concord web UI: state/render tests with clearly labelled fixtures.
 *
 * Product screens fetch the backend and never hard-code outcomes; every
 * live-shaped value below is a TEST FIXTURE exercising the view helpers and
 * the API client, not a claim about server behavior.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

// web/ ships plain framework-free JS with no declaration files, so the test
// loads it (and jsdom, likewise untyped) through a typed require handle
// instead of static imports. Fixtures below stay clearly labelled.
const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;
const {
  ApiError, allowedActions, apiFetch, claimUnits, clearSessionToken,
  isForbidden, isStaleConflict, isUnavailable, newIdempotencyKey,
  redactError, redactText, setSessionToken,
} = require('../../web/api.js') as any;
const {
  activeElementId, captureScroll, changeNextAction, describeBisection,
  environmentBadge, leaseCountdown, looksLikeMarkup, panelCopy,
  projectionItems, repairStatus, restoreFocus, restoreScroll, safeText,
  verdictProvenance,
} = require('../../web/views.js') as any;

type Json = Record<string, unknown>;

/** Fixture fetch: maps request paths to canned responses. */
function fixtureFetch(routes: Record<string, { status: number; body: Json }>, seen: { url: string; init: RequestInit }[] = []) {
  return async (url: string, init: RequestInit = {}) => {
    seen.push({ url, init });
    const route = routes[url];
    if (!route) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no fixture' }, requestId: 'req-none' }), { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status });
  };
}

const leaseConflictBody = {
  error: {
    code: 'LEASE_CONFLICT', message: 'Unit row:families:alpha is held',
    details: { holderId: 'agent-a', intentText: 'tune-alpha', expiresAt: 999, conflictingKeys: ['row:families:alpha'] },
  },
  requestId: 'req-conflict',
};

describe('ui api client (fixtures)', () => {
  it('surfaces a rejected claim with holder context instead of success', async () => {
    setSessionToken('local-agent-b');
    try {
      const fetchImpl = fixtureFetch({ '/v1/repos/demo/leases': { status: 409, body: leaseConflictBody } });
      const error = await claimUnits('demo', { changeId: 'x', unitKeys: ['row:families:alpha'], intentText: 'alpha-alternative' }, 'key-1', fetchImpl).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as any;
      expect(apiError.status).toBe(409);
      expect(apiError.code).toBe('LEASE_CONFLICT');
      expect(apiError.requestId).toBe('req-conflict');
    } finally {
      clearSessionToken();
    }
  });

  it('flags stale mutations so callers refresh rather than pretend success', async () => {
    const fetchImpl = fixtureFetch({
      '/v1/repos/demo/queue/enqueue': {
        status: 409,
        body: { error: { code: 'STALE_VERSION', message: 'stale', details: { currentVersion: 7 } }, requestId: 'req-stale' },
      },
    });
    const error = await apiFetch('/v1/repos/demo/queue/enqueue', { method: 'POST', body: { changeId: 'a' }, idempotencyKey: 'k' }, fetchImpl).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isStaleConflict(error)).toBe(true);
    expect(isStaleConflict(new ApiError(409, 'LEASE_CONFLICT', 'held'))).toBe(false);
    expect(isUnavailable(new ApiError(501, 'MODULE_UNAVAILABLE', 'not landed'))).toBe(true);
    expect(isUnavailable(new ApiError(501, 'HTTP_501', 'bare status'))).toBe(true);
    expect(isUnavailable(new ApiError(404, 'NOT_FOUND', 'missing'))).toBe(false);
    expect(isForbidden(new ApiError(403, 'FORBIDDEN', 'no role'))).toBe(true);
  });

  it('keeps the session token out of URLs and sends idempotency keys', async () => {
    setSessionToken('local-agent-a');
    try {
      const seen: { url: string; init: RequestInit }[] = [];
      const fetchImpl = fixtureFetch({ '/v1/repos': { status: 200, body: { data: { items: [] } } } }, seen);
      await apiFetch('/v1/repos', { method: 'POST', body: { name: 'x' }, idempotencyKey: 'idem-1' }, fetchImpl);
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe('/v1/repos');
      expect(seen[0].url).not.toContain('local-agent-a');
      const headers = new Headers(seen[0].init.headers);
      expect(headers.get('authorization')).toBe('Bearer local-agent-a');
      expect(headers.get('idempotency-key')).toBe('idem-1');
    } finally {
      clearSessionToken();
    }
  });

  it('refuses absolute request paths and drops the token after forget', async () => {
    setSessionToken('local-viewer');
    clearSessionToken();
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = fixtureFetch({ '/v1/repos': { status: 200, body: { data: {} } } }, seen);
    await expect(apiFetch('https://evil.test/v1/repos', {}, fetchImpl)).rejects.toMatchObject({ code: 'INVALID_PATH' });
    await apiFetch('/v1/repos', {}, fetchImpl);
    expect(new Headers(seen[0].init.headers).get('authorization')).toBeNull();
  });

  it('recovers from a network failure without reporting success', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ data: { items: [] } }), { status: 200 });
    };
    const first = await apiFetch('/v1/repos', {}, flaky).then(() => null, (e: unknown) => e);
    expect(first).toMatchObject({ code: 'NETWORK_UNREACHABLE', retryable: true });
    const second = await apiFetch('/v1/repos', {}, flaky);
    expect((second as Json).data).toEqual({ items: [] });
    expect(calls).toBe(2);
  });

  it('redacts tokens and raw error details for display', () => {
    expect(redactText('Authorization: Bearer local-owner please')).toBe('Authorization: Bearer [REDACTED] please');
    expect(redactText('call /x?token=abc&y=1')).toBe('call /x?token=[REDACTED]&y=1');
    const redacted = redactError(new ApiError(409, 'LEASE_CONFLICT', 'Bearer local-owner held it', 'req-1'));
    expect(redacted).toEqual({ code: 'LEASE_CONFLICT', message: 'Bearer [REDACTED] held it', requestId: 'req-1' });
    expect(redactError(new Error('boom'))).toMatchObject({ code: 'UNKNOWN', message: 'boom' });
  });

  it('mints unique idempotency keys and gates affordances by role', () => {
    expect(newIdempotencyKey()).not.toBe(newIdempotencyKey());
    expect(allowedActions(['viewer'])).toEqual({ claim: false, enqueue: false, withdraw: false, verdict: false });
    expect(allowedActions(['agent'])).toMatchObject({ claim: true, enqueue: true, verdict: false });
    expect(allowedActions(['reviewer'])).toMatchObject({ verdict: true, claim: false });
    expect(allowedActions(['owner'])).toMatchObject({ claim: true, enqueue: true });
  });
});

describe('ui view helpers (fixtures)', () => {
  it('renders unavailable projections explicitly, never as fake data', () => {
    expect(projectionItems({ status: 'unavailable', items: [] })).toEqual({ state: 'unavailable', items: [] });
    expect(projectionItems({ items: [] }).state).toBe('empty');
    expect(projectionItems({ changes: [{ changeId: 'a' }] }).state).toBe('ready');
    expect(projectionItems(null).state).toBe('unknown');
    expect(environmentBadge({ mode: 'local', storageBackend: 'fake' }).label).toBe('local fake');
    expect(environmentBadge({ mode: 'local', storageBackend: 'bridge' }).label).toBe('local bridge');
    expect(environmentBadge({ mode: 'production', storageBackend: 'artifacts' }).label).toBe('live Artifacts');
    expect(environmentBadge(null).label).toBe('unknown backend');
    expect(environmentBadge({ mode: 'local', storageBackend: 'fake' }, true).label).toBe('historical simulation');
  });

  it('links lease conflicts to the holder and labels unknown change states', () => {
    const conflict = changeNextAction(
      { changeId: 'x', status: 'blocked', unitKeys: ['row:families:alpha'] },
      { leaseConflict: { holderId: 'agent-a', intentText: 'tune-alpha', unitKeys: ['row:families:alpha'] } },
    );
    expect(conflict.kind).toBe('conflict');
    expect(conflict.holderId).toBe('agent-a');
    expect(conflict.detail).toContain('agent-a');
    expect(changeNextAction({ status: 'queued' }).kind).toBe('wait');
    expect(changeNextAction({ status: 'merged' }).kind).toBe('terminal');
    expect(changeNextAction({ status: 'ready' }, {}).kind).toBe('review');
    expect(changeNextAction({ status: 'ready' }, { verdictGate: { verdictId: 'v1' } }).kind).toBe('enqueue');
    expect(changeNextAction({ status: 'draft' }).kind).toBe('publish');
    expect(changeNextAction({ status: 'flying' }).kind).toBe('unknown');
    expect(changeNextAction(null).kind).toBe('unknown');
  });

  it('displays bisection outcomes with only the supported culprit or set', () => {
    const singleton = describeBisection({ classification: 'SINGLETON', culpritChangeIds: ['b'] });
    expect(singleton.highlightIds).toEqual(['b']);
    expect(singleton.headline).toContain('b');
    const interaction = describeBisection({ classification: 'INTERACTION', failingSet: ['a', 'c'] });
    expect(interaction.highlightIds).toEqual(['a', 'c']);
    expect(interaction.note).toMatch(/never single-blamed/);
    expect(describeBisection({ classification: 'DEPENDENCY_GROUP', failingSet: ['a', 'b'] }).headline).toMatch(/group/i);
    expect(describeBisection({ classification: 'BASE_RED' }).highlightIds).toEqual([]);
    expect(describeBisection({ classification: 'INCONCLUSIVE' }).headline).toBe('Inconclusive');
    expect(describeBisection(null).headline).toBe('Bisection unknown');
  });

  it('keeps unresolved repairs open and tracks pending review', () => {
    const open = [
      { findingId: 'f1', status: 'open' },
      { findingId: 'f2', status: 'resolved' },
    ];
    const unresolved = repairStatus(open, []);
    expect(unresolved.status).toBe('unresolved');
    expect(unresolved.openCount).toBe(1);
    expect(unresolved.summary).toMatch(/must cover every open finding/);
    const pending = repairStatus(open, [{ roundId: 'r1', status: 'pending' }]);
    expect(pending.status).toBe('pending-review');
    expect(pending.pendingRound).toBe('r1');
    expect(repairStatus([{ status: 'resolved' }], []).status).toBe('resolved');
  });

  it('traces carried verdicts to the original review and states invalidations', () => {
    const carried = verdictProvenance({ verdictId: 'v2', parentVerdictId: 'v1', deltaResultId: 'd9' });
    expect(carried.kind).toBe('carried');
    expect(carried.parentVerdictId).toBe('v1');
    expect(carried.deltaResultId).toBe('d9');
    const invalidated = verdictProvenance({ verdictId: 'v3', carryInvalidation: 'beta dependency changed' });
    expect(invalidated.kind).toBe('invalidated');
    expect(invalidated.summary).toContain('beta dependency changed');
    expect(verdictProvenance({ decision: 'approve', reviewerId: 'r', revision: 2, findingSetVersion: 3 }).kind).toBe('direct');
    expect(verdictProvenance(null).kind).toBe('unknown');
  });

  it('renders script-like intent text literally without parsing markup', () => {
    const hostile = '<script>alert("x")</script><img src=x onerror=y>';
    expect(safeText(hostile)).toBe(hostile);
    expect(looksLikeMarkup(hostile)).toBe(true);
    expect(looksLikeMarkup('Increase gamma retry budget safely')).toBe(false);
    expect(safeText(null)).toBe('');
    const dom = new JSDOM('<body><p id="card"></p></body>');
    const card = dom.window.document.getElementById('card')!;
    card.textContent = safeText(hostile);
    expect(card.querySelector('script')).toBeNull();
    expect(card.querySelector('img')).toBeNull();
    expect(card.textContent).toBe(hostile);
  });

  it('preserves focus across re-renders and never invents it', () => {
    const dom = new JSDOM('<body><button id="a">a</button><button id="b">b</button></body>');
    const doc = dom.window.document;
    expect(activeElementId(doc)).toBeNull();
    (doc.getElementById('b') as HTMLButtonElement).focus();
    expect(activeElementId(doc)).toBe('b');
    expect(restoreFocus(doc, 'a')).toBe(true);
    expect(activeElementId(doc)).toBe('a');
    expect(restoreFocus(doc, 'missing')).toBe(false);
    const box = { scrollTop: 7, scrollLeft: 3 };
    const saved = captureScroll(box);
    box.scrollTop = 0;
    expect(restoreScroll(box, saved)).toBe(true);
    expect(box.scrollTop).toBe(7);
    expect(captureScroll(null)).toBeNull();
  });

  it('counts lease time down and names expiry plainly', () => {
    const active = leaseCountdown({ state: 'active', expiresAt: 200_000 }, 120_000);
    expect(active.expired).toBe(false);
    expect(active.text).toMatch(/left/);
    expect(leaseCountdown({ state: 'active', expiresAt: 100 }, 200).expired).toBe(true);
    expect(leaseCountdown({ state: 'released', expiresAt: 999_999 }, 0).text).toBe('expired');
    expect(panelCopy('disconnected').title).toBe('Disconnected');
    expect(panelCopy('nope').title).toBe('Unknown state');
  });
});
