import { createMilestone, newIdempotencyKey, redactError, updateMilestoneSettings } from './api.js';

let creating = false;
let saving = false;
let expanded = false;
let dialogOpen = false;
let statusFilter = 'open';
let pinnedRepo = null;
let settingsRepo = null;
let pinnedSettingsVersion = null;
let settingsError = '';
let settingsMessage = '';
let errorCode = '';
let createdMilestones = [];
let focusMilestoneId = null;
const expandedDescriptions = new Set();

const element = (tag, text, className) => {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = String(text);
  if (className) item.className = className;
  return item;
};

export function renderMilestones(ctx) {
  const root = document.getElementById('milestones-content');
  if (!root) return;
  const snapshot = ctx.snapshot?.data?.projections?.issues ?? {};
  const settings = snapshot.milestoneSettings ?? { create: 'agents', version: 0 };
  if (pinnedRepo !== ctx.repoId) {
    pinnedRepo = ctx.repoId;
    expanded = false;
    dialogOpen = false;
    statusFilter = 'open';
    creating = false;
    errorCode = '';
    createdMilestones = [];
    focusMilestoneId = null;
    expandedDescriptions.clear();
  }
  const prev = new Map([...root.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.value]));
  const focused = root.contains(document.activeElement) ? document.activeElement?.dataset?.field : null;
  root.replaceChildren();

  const milestonesById = new Map((Array.isArray(snapshot.milestones) ? snapshot.milestones : []).map(item => [item.milestoneId, item]));
  for (const item of createdMilestones) if (!milestonesById.has(item.milestoneId)) milestonesById.set(item.milestoneId, item);
  const milestones = [...milestonesById.values()];
  const issues = Array.isArray(snapshot.items) ? snapshot.items : [];
  milestones.sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || a.title.localeCompare(b.title));
  const canCreate = ctx.roles.includes('owner') || (ctx.roles.includes('agent') && settings.create === 'agents');

  const heading = element('div', undefined, 'milestones-heading');
  const headingCopy = element('div', undefined, 'milestones-heading-copy');
  headingCopy.append(element('h1', 'Milestones'), element('p', 'Track progress across your repository milestones.', 'muted'));
  heading.append(headingCopy);
  if (canCreate) {
    const newButton = element('button', 'New milestone', 'milestone-new-button');
    newButton.type = 'button';
    newButton.addEventListener('click', () => { dialogOpen = true; renderMilestones(ctx); root.querySelector('[data-field="title"]')?.focus(); });
    heading.append(newButton);
  }
  root.append(heading);

  // Change 172 moved the creation policy control to Settings (renderMilestoneSettings).
  if (!canCreate) root.append(element('p', 'Only owners can create milestones here.', 'muted milestone-settings'));

  if (canCreate) {
    const dialog = element('section', undefined, 'milestone-dialog-backdrop');
    dialog.hidden = !dialogOpen;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'milestone-dialog-title');
    const form = element('form', undefined, 'milestone-form action-form');
    const dialogTitle = element('h2', 'New milestone');
    dialogTitle.id = 'milestone-dialog-title';
    const close = element('button', 'Close', 'milestone-dialog-close');
    close.type = 'button'; close.setAttribute('aria-label', 'Close new milestone dialog');
    close.addEventListener('click', () => { dialogOpen = false; errorCode = ''; renderMilestones(ctx); });
    const field = (name, title, tag = 'input') => {
      const label = element('label', title);
      const input = element(tag);
      input.dataset.field = name;
      if (name === 'title') { input.required = true; input.maxLength = 256; }
      if (name === 'dueDate') input.type = 'date';
      if (name === 'description') input.rows = 4;
      if (prev.has(name)) input.value = prev.get(name);
      label.append(input);
      return [label, input];
    };
    const [title, titleInput] = field('title', 'Title');
    const [description, descriptionInput] = field('description', 'Description', 'textarea');
    const [dueDate, dueDateInput] = field('dueDate', 'Due date');
    const submit = element('button', creating ? 'Creating…' : 'Create milestone', 'primary');
    submit.type = 'submit'; submit.disabled = creating;
    const actions = element('div', undefined, 'milestone-dialog-actions');
    const cancel = element('button', 'Cancel');
    cancel.type = 'button'; cancel.addEventListener('click', () => { dialogOpen = false; errorCode = ''; renderMilestones(ctx); });
    actions.append(cancel, submit);
    form.append(close, dialogTitle, title, description, dueDate, actions);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (creating) return;
      const body = { title: titleInput.value, description: descriptionInput.value, dueDate: dueDateInput.value || null };
      creating = true; errorCode = ''; renderMilestones(ctx);
      try {
        const result = await createMilestone(ctx.repoId, body, newIdempotencyKey());
        const returned = result.data?.milestone ?? result.data;
        const milestoneId = returned?.milestoneId;
        if (milestoneId) {
          const created = { ...body, ...returned, milestoneId, state: returned.state ?? 'open' };
          createdMilestones.push(created);
          focusMilestoneId = milestoneId;
        }
        statusFilter = 'open';
        dialogOpen = false;
        await ctx.refresh();
      } catch (error) { errorCode = redactError(error).code; }
      finally { creating = false; renderMilestones(ctx); }
    });
    dialog.addEventListener('click', event => { if (event.target === dialog) { dialogOpen = false; renderMilestones(ctx); } });
    dialog.append(form);
    root.append(dialog);
  }

  if (errorCode) root.append(element('p', errorCode, 'milestone-error'));
  const filters = element('div', undefined, 'milestone-filters');
  for (const [value, label] of [['open', 'Open'], ['closed', 'Closed']]) {
    const button = element('button', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(statusFilter === value));
    button.addEventListener('click', () => { statusFilter = value; expanded = false; renderMilestones(ctx); });
    filters.append(button);
  }
  root.append(filters);

  const list = element('div', undefined, 'milestone-list');
  const filtered = milestones.filter(item => item.state === statusFilter);
  const visible = expanded ? filtered : filtered.slice(0, 50);
  for (const item of visible) {
    const row = element('article', undefined, 'milestone-row');
    row.tabIndex = -1;
    row.dataset.milestoneId = item.milestoneId;
    const titleWrap = element('div', undefined, 'milestone-row-title');
    titleWrap.append(element('h2', item.title), element('span', item.state, `milestone-state ${item.state}`));
    row.append(titleWrap);
    row.append(element('p', item.dueDate ? `Due ${item.dueDate}` : 'No due date', 'milestone-due-date'));
    const milestoneIssues = issues.filter(issue => issue.milestoneId === item.milestoneId);
    const progress = item.progress ?? {};
    const issueOpen = milestoneIssues.filter(issue => issue.state === 'open').length;
    const issueClosed = milestoneIssues.filter(issue => issue.state !== 'open').length;
    const open = milestoneIssues.length ? issueOpen : Number(progress.openIssues ?? 0);
    const closed = milestoneIssues.length ? issueClosed : Number(progress.closedIssues ?? progress.landedChanges ?? 0);
    const total = open + closed;
    const bar = element('div', undefined, 'milestone-progress-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${closed} of ${total} issues closed`);
    const segment = element('span', undefined, 'milestone-progress-segment closed');
    segment.style.width = total ? `${Math.round(100 * closed / total)}%` : '0%';
    bar.append(segment);
    const counts = element('p', `${open} open · ${closed} closed`, 'milestone-progress');
    const summary = element('div', undefined, 'milestone-progress-summary');
    summary.append(bar, counts);
    row.append(summary);
    const description = item.description ?? '';
    if (description) {
      const isExpanded = expandedDescriptions.has(item.milestoneId);
      const disclosure = element('button', isExpanded ? 'Show less' : 'Show more', 'milestone-description-toggle');
      disclosure.type = 'button';
      disclosure.setAttribute('aria-expanded', String(isExpanded));
      disclosure.addEventListener('click', () => {
        if (expandedDescriptions.has(item.milestoneId)) expandedDescriptions.delete(item.milestoneId);
        else expandedDescriptions.add(item.milestoneId);
        renderMilestones(ctx);
      });
      row.append(element('p', description, `milestone-description${isExpanded ? ' expanded' : ''}`), disclosure);
    }
    list.append(row);
  }
  root.append(list);
  if (!filtered.length) root.append(element('p', `No ${statusFilter} milestones.`, 'muted milestone-empty'));
  if (!expanded && filtered.length > 50) {
    const more = element('button', `Show ${filtered.length - 50} more`, 'milestone-more');
    more.type = 'button'; more.addEventListener('click', () => { expanded = true; renderMilestones(ctx); });
    root.append(more);
  }
  if (focused) root.querySelector(`[data-field="${focused}"]`)?.focus({ preventScroll: true });
  if (focusMilestoneId) {
    const createdRow = [...root.querySelectorAll('.milestone-row')].find(row => row.dataset.milestoneId === focusMilestoneId);
    if (createdRow) {
      createdRow.focus();
      focusMilestoneId = null;
    }
  }
}

export function renderMilestoneSettings(ctx) {
  const root = document.getElementById('milestone-settings-content');
  if (!root) return;
  const settings = ctx.snapshot?.data?.projections?.issues?.milestoneSettings ?? { create: 'agents', version: 0 };
  if (settingsRepo !== ctx.repoId) {
    settingsRepo = ctx.repoId;
    pinnedSettingsVersion = settings.version;
    saving = false;
    settingsMessage = '';
    settingsError = '';
  }
  const owner = ctx.roles.includes('owner');
  const previous = root.querySelector('[data-field="create-setting"]')?.value;
  root.replaceChildren();
  const control = element('section', undefined, 'milestone-settings');
  const label = element('label', 'Who can create milestones:');
  const select = element('select');
  select.dataset.field = 'create-setting';
  select.setAttribute('aria-label', 'Who can create milestones');
  select.disabled = !owner;
  for (const [value, text] of [['agents', 'Agents and owners'], ['owners', 'Owners only']]) {
    const option = element('option', text);
    option.value = value;
    option.selected = previous ? previous === value : settings.create === value;
    select.append(option);
  }
  label.append(select);
  const save = element('button', saving ? 'Saving…' : 'Save');
  save.type = 'button'; save.disabled = saving || !owner;
  save.addEventListener('click', async () => {
    if (saving || !owner) return;
    saving = true; settingsError = ''; settingsMessage = ''; renderMilestoneSettings(ctx);
    try {
      const result = await updateMilestoneSettings(ctx.repoId, { create: select.value, expectedVersion: pinnedSettingsVersion }, newIdempotencyKey());
      pinnedSettingsVersion = result.data?.version ?? settings.version;
      settingsMessage = 'Milestone permissions updated.';
      await ctx.refresh();
    } catch (error) {
      if (error.status === 409 && error.code === 'STALE_VERSION') settingsMessage = 'Changed by someone else; reloaded';
      else settingsError = redactError(error).code;
      const refreshed = await ctx.refresh();
      const refreshedSettings = refreshed?.data?.projections?.issues?.milestoneSettings
        ?? ctx.snapshot?.data?.projections?.issues?.milestoneSettings;
      if (Number.isSafeInteger(refreshedSettings?.version)) pinnedSettingsVersion = refreshedSettings.version;
    } finally { saving = false; renderMilestoneSettings(ctx); }
  });
  control.append(label, save);
  if (!owner) control.append(element('p', 'Only repository owners can change milestone permissions.', 'owner-only-hint'));
  if (settingsMessage) control.append(element('p', settingsMessage, settingsMessage.startsWith('Changed') ? 'milestone-error' : 'muted'));
  if (settingsError) control.append(element('p', settingsError, 'milestone-error'));
  root.append(control);
}
