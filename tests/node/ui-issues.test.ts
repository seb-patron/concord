import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as any;
const { renderIssues } = require('../../web/issues.js') as any;

const makeFixture = () => {
  const now = Date.now();
  return { data: { projections: {
    issues: { items: [
      { number: 1, title: 'Improve lease view', body: 'Search lease information safely.', state: 'open', labels: ['ui', 'leases'], milestoneId: 'm1', createdAt: now - 86_400_000, updatedAt: now - 86_400_000, closedAt: null },
      { number: 2, title: 'Add dark polish', body: 'Tune contrast.', state: 'open', labels: ['ui'], milestoneId: 'm1', createdAt: now - 80_000_000, updatedAt: now - 80_000_000, closedAt: null },
      { number: 3, title: 'Document import', body: 'Update docs.', state: 'open', labels: ['docs'], milestoneId: 'm2', createdAt: now - 70_000_000, updatedAt: now - 70_000_000, closedAt: null },
      { number: 4, title: 'Close old bug', body: 'Fixed.', state: 'closed', labels: ['bug'], milestoneId: 'm2', createdAt: now - 90_000_000, updatedAt: now - 10_000, closedAt: now - 10_000 },
      { number: 5, title: 'Retire lease API', body: 'Old lease route.', state: 'closed', labels: ['leases'], milestoneId: 'm1', createdAt: now - 100_000_000, updatedAt: now - 20_000, closedAt: now - 20_000 },
    ], milestones: [
      { milestoneId: 'm1', title: 'Launch' }, { milestoneId: 'm2', title: 'Polish' },
    ] },
    repos: { changes: [
      { changeId: 'change-1', issueNumber: 1, intentText: 'Implement issue #1', authorModel: 'Codex Luna', status: 'ready' },
      { changeId: 'change-3', intentText: 'Work on issue #3', authorModel: 'Agent Z', status: 'checking' },
    ] },
    leases: { heldItems: [
      { leaseId: 'l1', issueNumber: 1, changeId: 'change-1', holderId: 'holder-a', state: 'active', expiresAt: now + 120_000 },
      { leaseId: 'l3', issueNumber: 3, changeId: 'change-3', holderId: 'holder-z', state: 'reserved', expiresAt: now + 120_000 },
      { leaseId: 'expired', issueNumber: 2, holderId: 'gone', state: 'active', expiresAt: now - 1 },
    ] },
  } }, version: 1, eventSeq: 1 };
};

let dom: any;
afterEach(() => { dom?.window.close(); dom = null; });

describe('GitHub-style Issues list', () => {
  const mount = (): any => {
    dom = new JSDOM('<main id="issues"></main>');
    Object.assign(globalThis, { window: dom.window, document: dom.window.document });
    renderIssues(document.querySelector('#issues'), { repoId: 'repo-a', snapshot: makeFixture() });
    return document.querySelector('#issues');
  };

  it('renders labels, milestones and live assignee chips from authorModel', () => {
    const root = mount();
    expect(root.querySelectorAll('.issue-row')).toHaveLength(3);
    const row = root.querySelector('[data-issue-number="1"]');
    expect(row.textContent).toContain('Improve lease view');
    expect(row.textContent).toContain('ui');
    expect(row.textContent).toContain('Launch');
    expect(row.textContent).toContain('Codex Luna');
    expect(row.textContent).not.toContain('holder-a');
    expect(root.querySelector('[data-issue-number="2"]').textContent).toContain('—');
    expect(row.textContent).toContain('Opened');
    expect(row.textContent).not.toContain('time unavailable');
  });

  it('searches issue text and number, and filters closed, label and assignee', () => {
    const root = mount();
    const search: any = root.querySelector('[aria-label="Search issues"]');
    search.value = 'lease'; search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect([...root.querySelectorAll('.issue-row')].map((row: Element) => row.getAttribute('data-issue-number'))).toEqual(['1']);
    search.value = '#2'; search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    expect([...root.querySelectorAll('.issue-row')].map((row: Element) => row.getAttribute('data-issue-number'))).toEqual(['2']);
    search.value = ''; search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    (root.querySelectorAll('.issues-state-toggle button')[1] as any).click();
    expect([...root.querySelectorAll('.issue-row')].map((row: Element) => row.getAttribute('data-issue-number'))).toEqual(['4', '5']);
    (root.querySelectorAll('.issues-state-toggle button')[0] as any).click();
    const milestone: any = root.querySelector('[aria-label="Milestone"]'); milestone.value = 'm2'; milestone.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect([...root.querySelectorAll('.issue-row')].map((row: Element) => row.getAttribute('data-issue-number'))).toEqual(['3']);
    milestone.value = ''; milestone.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const label: any = root.querySelector('[aria-label="Label"]'); label.value = 'docs'; label.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect([...root.querySelectorAll('.issue-row')].map((row: Element) => row.getAttribute('data-issue-number'))).toEqual(['3']);
    label.value = ''; label.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const assignee: any = root.querySelector('[aria-label="Assignee"]'); assignee.value = 'Codex Luna'; assignee.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect([...root.querySelectorAll('.issue-row')].map((row: Element) => row.getAttribute('data-issue-number'))).toEqual(['1']);
  });

  it('opens details with safe Markdown and changes linked by issue number or lease', () => {
    const root = mount();
    (root.querySelector('[data-issue-number="1"]') as any).click();
    const drawer: any = root.querySelector('.issues-drawer');
    expect(drawer.textContent).toContain('change-1');
    expect(drawer.textContent).toContain('ready');
    expect(drawer.querySelector('.issues-body').textContent).toContain('Search lease information safely.');
    expect(drawer.querySelector('.issues-body p').innerHTML).not.toContain('<script>');
    (root.querySelector('[aria-label="Close issue details"]') as any).click();
    (root.querySelector('[data-issue-number="3"]') as any).click();
    expect(root.querySelector('.issues-drawer').textContent).toContain('change-3');
    expect(root.querySelector('.issues-drawer').textContent).toContain('checking');
  });

  it('resets filters and selected issue when the repository changes', () => {
    const root = mount();
    const label: any = root.querySelector('[aria-label="Label"]');
    label.value = 'ui'; label.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    (root.querySelector('[data-issue-number="1"]') as any).click();
    expect(root.querySelector('.issues-drawer').textContent).toContain('Improve lease view');

    renderIssues(root, { repoId: 'repo-b', snapshot: { data: { projections: {
      issues: { items: [
        { number: 1, title: 'Repo B issue one', body: '', state: 'open', labels: ['general'], milestoneId: null },
        { number: 2, title: 'Repo B issue two', body: '', state: 'open', labels: [], milestoneId: null },
      ], milestones: [] }, repos: { changes: [] }, leases: { heldItems: [] },
    } } } });

    expect([...root.querySelectorAll('.issue-row')].map((row: Element) => row.getAttribute('data-issue-number'))).toEqual(['1', '2']);
    expect((root.querySelector('[aria-label="Label"]') as HTMLSelectElement).value).toBe('');
    expect(root.dataset.label).toBe('');
    expect(root.dataset.selected).toBe('');
    expect(root.querySelector('.issues-drawer').hidden).toBe(true);
  });

  it('omits relative-time text for legacy issues without timestamps', () => {
    const root = document.createElement('main');
    renderIssues(root, { repoId: 'legacy', snapshot: { data: { projections: {
      issues: { items: [{ number: 8, title: 'Legacy task', body: '', state: 'open', labels: [] }], milestones: [] },
      repos: { changes: [] }, leases: { heldItems: [] },
    } } } });
    const row: any = root.querySelector('.issue-row');
    expect(row.textContent).toContain('#8');
    expect(row.textContent).not.toContain('time unavailable');
    expect(row.textContent).not.toContain('Opened');
  });
});
