import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;
const dom = new JSDOM('<!doctype html><main><div id="milestones-content"></div><div id="milestone-settings-content"></div></main>', { url: 'http://localhost/' });
const oldFetch = globalThis.fetch;
globalThis.document = dom.window.document;

const { renderMilestones, renderMilestoneSettings } = require('../../web/milestones.js') as any;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(status >= 400
  ? { error: data } : { data, version: 1, eventSeq: 1 }), { status, headers: { 'content-type': 'application/json' } });
let repoNumber = 0;
const fixture = (roles: string[], create = 'agents', count = 2) => ({
  repoId: `repo-${++repoNumber}`, roles, refresh: async () => {}, snapshot: { data: { projections: { issues: {
    milestoneSettings: { create, version: 3 },
    milestones: Array.from({ length: count }, (_, index) => ({ milestoneId: `m${index}`, title: `Milestone ${index}`,
      state: index === 0 ? 'closed' : 'open', description: 'A useful description that should stay plain text in the list.',
      dueDate: index === 0 ? null : '2026-12-01', progress: { openIssues: 1, closedIssues: 0, landedChanges: index === 1 ? 2 : 0 } })),
    items: [
      { number: 1, milestoneId: 'm1', state: 'open' },
      { number: 2, milestoneId: 'm1', state: 'closed' },
    ],
  } } } },
});
const root = () => document.getElementById('milestones-content')!;
const settingsRoot = () => document.getElementById('milestone-settings-content')!;
const text = () => root().textContent ?? '';
const click = (target: Element) => target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const submit = (form: HTMLFormElement) => form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
afterEach(() => { globalThis.fetch = oldFetch; root().replaceChildren(); settingsRoot().replaceChildren(); vi.restoreAllMocks(); });

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
    const ctx = fixture(['viewer']) as any;
    renderMilestoneSettings(ctx);
    expect(settingsRoot().textContent).toContain('Who can create milestones:');
    expect((settingsRoot().querySelector('select') as HTMLSelectElement).disabled).toBe(true);
    expect(settingsRoot().textContent).toContain('Only repository owners can change milestone permissions.');
  });

  it('renders compact rows with due dates, progress, counts, and open/closed filtering', () => {
    renderMilestones(fixture(['agent']) as any);
    expect(root().querySelectorAll('.milestone-row')).toHaveLength(1);
    expect(text()).toContain('Milestone 1');
    expect(text()).toContain('Due 2026-12-01');
    expect(text()).toContain('1 open · 1 closed');
    expect(root().querySelector('.milestone-progress-bar')?.getAttribute('aria-label')).toBe('1 of 2 issues closed');
    expect((root().querySelector('.milestone-progress-segment') as HTMLElement).style.width).toBe('50%');
    expect(root().querySelector('.milestone-description')?.textContent).toContain('A useful description');

    click(root().querySelector('.milestone-filters button:last-child')!);
    expect(root().querySelectorAll('.milestone-row')).toHaveLength(1);
    expect(text()).toContain('No due date');
    expect(text()).toContain('Milestone 0');
    expect(text()).not.toContain('Milestone 1');
  });

  it('shows creation only after New milestone is clicked and focuses the created row', async () => {
    const fetch = vi.fn(async (..._args: any[]) => json({ milestoneId: 'new-milestone' }));
    globalThis.fetch = fetch as any;
    const ctx = fixture(['agent']) as any;
    renderMilestones(ctx);
    expect((root().querySelector('[role="dialog"]') as HTMLElement).hidden).toBe(true);
    click(root().querySelector('.milestone-filters button:last-child')!);
    expect(root().querySelector('.milestone-filters button:last-child')?.getAttribute('aria-pressed')).toBe('true');
    click(root().querySelector('.milestone-new-button')!);
    const dialog = root().querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.hidden).toBe(false);
    const form = dialog.querySelector('form') as HTMLFormElement;
    (form.querySelector('[data-field="title"]') as HTMLInputElement).value = 'M1';
    (form.querySelector('[data-field="description"]') as HTMLTextAreaElement).value = 'A release milestone';
    (form.querySelector('[data-field="dueDate"]') as HTMLInputElement).value = '2026-12-31';
    submit(form);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toMatch(/^\/v1\/repos\/repo-\d+\/milestones$/);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ title: 'M1', description: 'A release milestone', dueDate: '2026-12-31' });
    expect(fetch.mock.calls[0][1].headers['idempotency-key']).toBeTruthy();
    expect((root().querySelector('[role="dialog"]') as HTMLElement)?.hidden).toBe(true);
    expect(root().querySelector('.milestone-filters button:first-child')?.getAttribute('aria-pressed')).toBe('true');
    const createdRow = Array.from(root().querySelectorAll('.milestone-row')).find(row => row.textContent?.includes('M1'))!;
    expect(createdRow).toBeTruthy();
    expect(document.activeElement).toBe(createdRow);
    expect(createdRow.getAttribute('tabindex')).toBe('-1');
  });

  it('submits a single create on a double click from the New milestone dialog', async () => {
    let release!: (response: Response) => void;
    const fetch = vi.fn((..._args: any[]) => new Promise<Response>(resolve => { release = resolve; }));
    globalThis.fetch = fetch as any;
    renderMilestones(fixture(['agent'], 'agents', 2) as any);
    click(root().querySelector('.milestone-new-button')!);
    const form = root().querySelector('[role="dialog"] form') as HTMLFormElement;
    (form.querySelector('[data-field="title"]') as HTMLInputElement).value = 'New release';
    submit(form);
    submit(form);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toMatch(/^\/v1\/repos\/repo-\d+\/milestones$/);
    expect(fetch.mock.calls[0][1].headers['idempotency-key']).toBeTruthy();
    expect((root().querySelector('[role="dialog"] form button[type="submit"]') as HTMLButtonElement | null)?.disabled).toBe(true);
    release(json({ milestoneId: 'new' }));
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('shows create access only to owners and agents allowed by repository policy', () => {
    const owner = fixture(['owner']) as any;
    renderMilestones(owner);
    expect(root().querySelector('.milestone-new-button')).not.toBeNull();
    // Change 172: the creation policy control lives in Settings, not on the Milestones tab.
    expect(root().querySelector('[data-field="create-setting"]')).toBeNull();
    renderMilestoneSettings(owner);
    expect(settingsRoot().querySelector('[data-field="create-setting"]')).not.toBeNull();
    renderMilestones(fixture(['agent'], 'agents') as any);
    expect(root().querySelector('.milestone-new-button')).not.toBeNull();
    renderMilestones(fixture(['agent'], 'owners') as any);
    expect(root().querySelector('.milestone-new-button')).toBeNull();
    expect(text()).toContain('Only owners can create milestones here.');
    renderMilestones(fixture(['viewer']) as any);
    expect(root().querySelector('.milestone-new-button')).toBeNull();
  });

  it('pins settings versions, preserves the choice, and reports stale saves', async () => {
    const fetch = vi.fn(async (..._args: any[]) => json({ code: 'STALE_VERSION', message: 'stale' }, 409));
    globalThis.fetch = fetch as any;
    const ctx = fixture(['owner']) as any;
    ctx.refresh = async () => {
      ctx.snapshot.data.projections.issues.milestoneSettings.version = 4;
      return ctx.snapshot;
    };
    renderMilestoneSettings(ctx);
    const select = settingsRoot().querySelector('[data-field="create-setting"]') as unknown as HTMLSelectElement;
    select.value = 'owners';
    renderMilestoneSettings(ctx);
    expect((settingsRoot().querySelector('[data-field="create-setting"]') as unknown as HTMLSelectElement).value).toBe('owners');
    click(settingsRoot().querySelector('.milestone-settings button')!);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ create: 'owners', expectedVersion: 3 });
    expect(settingsRoot().textContent).toContain('Changed by someone else; reloaded');
  });

  it('pins the settings version when opened and reports a stale save after polling', async () => {
    const fetch = vi.fn(async (..._args: any[]) => json({ code: 'STALE_VERSION', message: 'stale' }, 409));
    globalThis.fetch = fetch as any;
    const ctx = fixture(['owner']) as any;
    ctx.refresh = async () => {
      ctx.snapshot.data.projections.issues.milestoneSettings.version = 4;
      return ctx.snapshot;
    };
    renderMilestoneSettings(ctx);
    settingsRoot().querySelector('.milestone-settings button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ create: 'agents', expectedVersion: 3 });
    expect(settingsRoot().textContent).toContain('Changed by someone else; reloaded');
    fetch.mockImplementation(async (..._args: any[]) => json({ version: 5 }));
    settingsRoot().querySelector('.milestone-settings button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
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
    renderMilestoneSettings(ctx);
    const select = settingsRoot().querySelector('[data-field="create-setting"]') as any as HTMLSelectElement;
    select.value = 'owners';

    renderMilestoneSettings(ctx);
    expect((settingsRoot().querySelector('[data-field="create-setting"]') as any as HTMLSelectElement).value).toBe('owners');

    settingsRoot().querySelector('.milestone-settings button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ create: 'owners', expectedVersion: 3 });
    expect((settingsRoot().querySelector('[data-field="create-setting"]') as any as HTMLSelectElement).value).toBe('owners');
  });

  it('clears milestone errors and settings messages when switching repos', async () => {
    const fetch = vi.fn(async (..._args: any[]) => json({ code: 'FORBIDDEN', message: 'Owner required' }, 403));
    globalThis.fetch = fetch as any;
    const firstRepo = fixture(['owner']) as any;
    renderMilestones(firstRepo);
    renderMilestoneSettings(firstRepo);
    root().querySelector('form')!.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(text()).toContain('FORBIDDEN');

    renderMilestones(fixture(['owner']) as any);
    expect(text()).not.toContain('FORBIDDEN');

    fetch.mockImplementation(async (..._args: any[]) => json({ version: 4 }));
    settingsRoot().querySelector('.milestone-settings button')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settingsRoot().textContent).toContain('Milestone permissions updated.');

    const nextRepo = fixture(['owner']) as any;
    renderMilestoneSettings(nextRepo);
    expect(settingsRoot().textContent).not.toContain('Milestone permissions updated.');
  });

  it('uses light and dark theme tokens for the row and dialog surfaces', () => {
    const css = readFileSync('web/styles.css', 'utf8');
    expect(css).toMatch(/\.milestone-row\s*\{[^}]*color:\s*var\(--text\)/s);
    expect(css).toMatch(/\.milestone-form\s*\{[^}]*background:\s*var\(--card\)/s);
    expect(css).toMatch(/\.milestone-form input,\.milestone-form textarea\s*\{[^}]*background:\s*var\(--card\)[^}]*color:\s*var\(--text\)/s);
  });

  it('expands descriptions, caps long lists, and shows only redacted error codes', async () => {
    const fetch = vi.fn(async (..._args: any[]) => json({ code: 'FORBIDDEN', message: 'Owner required' }, 403));
    globalThis.fetch = fetch as any;
    const ctx = fixture(['owner'], 'agents', 60) as any;
    renderMilestones(ctx);
    expect(root().querySelectorAll('.milestone-row')).toHaveLength(50);
    expect(text()).toContain('Show 9 more');
    const disclosure = root().querySelector('.milestone-description-toggle')!;
    click(disclosure);
    expect(root().querySelector('.milestone-description')?.classList.contains('expanded')).toBe(true);
    click(root().querySelector('.milestone-new-button')!);
    submit(root().querySelector('form') as HTMLFormElement);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(text()).toContain('FORBIDDEN');
    expect(text()).not.toContain('Owner required');
  });
});
