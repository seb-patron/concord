import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;
const dom = new JSDOM('<!doctype html><main><div id="milestones-content"></div></main>');
const oldFetch = globalThis.fetch;
globalThis.document = dom.window.document;

const { renderMilestones } = require('../../web/milestones.js') as any;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status >= 400
  ? { error: data } : { data, version: 1, eventSeq: 1 }), { status, headers: { 'content-type': 'application/json' } });
let repoNumber = 0;
const fixture = (roles: string[], create = 'agents', count = 1) => ({
  repoId: `repo-${++repoNumber}`, roles, refresh: async () => {}, snapshot: { data: { projections: { issues: {
    milestoneSettings: { create, version: 3 },
    milestones: Array.from({ length: count }, (_, index) => ({ milestoneId: `m${index}`, title: `Milestone ${index}`,
      state: index === 0 ? 'closed' : 'open', description: '<script>plain text</script>', dueDate: '2026-12-01',
      progress: { openIssues: 1, closedIssues: 0, landedChanges: index === 1 ? 2 : 0 } })),
  } } } },
});
const root = () => document.getElementById('milestones-content')!;
const text = () => root().textContent ?? '';
afterEach(() => { globalThis.fetch = oldFetch; root().replaceChildren(); vi.restoreAllMocks(); });

describe('Milestones screen', () => {
  it('shows create for owners and agents by default, and hides it from viewers or locked agents', () => {
    renderMilestones(fixture(['owner']) as any);
    expect(root().querySelector('form')).not.toBeNull();
    renderMilestones(fixture(['agent'], 'agents', 2) as any);
    expect(root().querySelector('form')).not.toBeNull();
    renderMilestones(fixture(['agent'], 'owners') as any);
    expect(root().querySelector('form')).toBeNull();
    expect(text()).toContain('Only owners can create milestones here.');
    renderMilestones(fixture(['viewer']) as any);
    expect(root().querySelector('form')).toBeNull();
  });

  it('renders landed changes distinctly and submits a single create on a double click', async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn((..._args: any[]) => new Promise<Response>(resolve => { release = resolve; }));
    globalThis.fetch = fetch as any;
    renderMilestones(fixture(['agent'], 'agents', 2) as any);
    expect(text()).toContain('2 landed changes');
    expect(text()).not.toContain('2 issues');
    const form = root().querySelector('form')!;
    (form.querySelector('[data-field="title"]') as HTMLInputElement).value = 'New release';
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toMatch(/^\/v1\/repos\/repo-\d+\/milestones$/);
    expect(fetch.mock.calls[0][1].headers['idempotency-key']).toBeTruthy();
    expect((root().querySelector('form button') as HTMLButtonElement | null)?.disabled).toBe(true);
    release(json({ milestoneId: 'new' }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('pins the settings version when opened and reports a stale save after polling', async () => {
    const fetch = vi.fn(async (..._args: any[]) => json({ code: 'STALE_VERSION', message: 'stale' }, 409));
    globalThis.fetch = fetch as any;
    const ctx = fixture(['owner']) as any;
    ctx.refresh = async () => {
      ctx.snapshot.data.projections.issues.milestoneSettings.version = 4;
      return ctx.snapshot;
    };
    renderMilestones(ctx);
    root().querySelector('.milestone-settings button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ create: 'agents', expectedVersion: 3 });
    expect(text()).toContain('Changed by someone else; reloaded');
    fetch.mockImplementation(async (..._args: any[]) => json({ version: 5 }));
    root().querySelector('.milestone-settings button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ create: 'agents', expectedVersion: 4 });
  });

  it('keeps an unsaved create permission choice across renders and shows it after save', async () => {
    const fetch = vi.fn(async (..._args: any[]) => json({ version: 4 }));
    globalThis.fetch = fetch as any;
    const ctx = fixture(['owner']) as any;
    ctx.refresh = async () => {
      ctx.snapshot.data.projections.issues.milestoneSettings.create = 'owners';
    };
    renderMilestones(ctx);
    const select = root().querySelector('[data-field="create-setting"]') as any as HTMLSelectElement;
    select.value = 'owners';

    renderMilestones(ctx);
    expect((root().querySelector('[data-field="create-setting"]') as any as HTMLSelectElement).value).toBe('owners');

    root().querySelector('.milestone-settings button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ create: 'owners', expectedVersion: 3 });
    expect((root().querySelector('[data-field="create-setting"]') as any as HTMLSelectElement).value).toBe('owners');
  });

  it('clears milestone errors and settings messages when switching repos', async () => {
    const fetch = vi.fn(async (..._args: any[]) => json({ code: 'FORBIDDEN', message: 'Owner required' }, 403));
    globalThis.fetch = fetch as any;
    const firstRepo = fixture(['owner']) as any;
    renderMilestones(firstRepo);
    root().querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(text()).toContain('FORBIDDEN');

    renderMilestones(fixture(['owner']) as any);
    expect(text()).not.toContain('FORBIDDEN');

    fetch.mockImplementation(async (..._args: any[]) => json({ version: 4 }));
    root().querySelector('.milestone-settings button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(text()).toContain('Milestone permissions updated.');

    renderMilestones(fixture(['owner']) as any);
    expect(text()).not.toContain('Milestone permissions updated.');
  });

  it('renders 50 milestones with a remaining count and shows only the redacted error code', async () => {
    const fetch = vi.fn(async (..._args: any[]) => json({ code: 'FORBIDDEN', message: 'Owner required' }, 403));
    globalThis.fetch = fetch as any;
    const ctx = fixture(['owner'], 'agents', 60) as any;
    renderMilestones(ctx);
    expect(root().querySelectorAll('.milestone-card')).toHaveLength(50);
    expect(text()).toContain('Show 10 more');
    const form = root().querySelector('form')!;
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(text()).toContain('FORBIDDEN');
    expect(text()).not.toContain('Owner required');
  });
});
