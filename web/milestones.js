import { createMilestone, newIdempotencyKey, redactError, updateMilestoneSettings } from './api.js';

let creating = false;
let saving = false;
let expanded = false;
let pinnedRepo = null;
let pinnedSettingsVersion = null;
let settingsMessage = '';
let errorCode = '';

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
    pinnedSettingsVersion = settings.version;
    expanded = false;
    creating = false;
    saving = false;
    settingsMessage = '';
    errorCode = '';
  }
  const prev = new Map([...root.querySelectorAll('[data-field]')].map(input => [input.dataset.field, input.value]));
  const focused = root.contains(document.activeElement) ? document.activeElement?.dataset?.field : null;
  root.replaceChildren();

  const milestones = Array.isArray(snapshot.milestones) ? [...snapshot.milestones] : [];
  const issues = Array.isArray(snapshot.items) ? snapshot.items : [];
  const leaseProjection = ctx.snapshot?.data?.projections?.leases;
  const heldLeases = Array.isArray(leaseProjection?.heldItems) ? leaseProjection.heldItems : [];
  milestones.sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || a.title.localeCompare(b.title));
  const canCreate = ctx.roles.includes('owner') || (ctx.roles.includes('agent') && settings.create === 'agents');
  if (ctx.roles.includes('owner')) {
    const control = element('section', undefined, 'milestone-settings');
    const label = element('label', 'Who can create milestones:');
    const select = element('select');
    select.dataset.field = 'create-setting';
    select.setAttribute('aria-label', 'Who can create milestones');
    for (const [value, text] of [['agents', 'Agents and owners'], ['owners', 'Owners only']]) {
      const option = element('option', text);
      option.value = value;
      option.selected = prev.has('create-setting') ? prev.get('create-setting') === value : settings.create === value;
      select.append(option);
    }
    label.append(select);
    const save = element('button', saving ? 'Saving…' : 'Save');
    save.type = 'button'; save.disabled = saving;
    save.addEventListener('click', async () => {
      if (saving) return;
      saving = true; errorCode = ''; settingsMessage = ''; renderMilestones(ctx);
      try {
        const result = await updateMilestoneSettings(ctx.repoId, { create: select.value, expectedVersion: pinnedSettingsVersion }, newIdempotencyKey());
        pinnedSettingsVersion = result.data?.version ?? settings.version;
        settingsMessage = 'Milestone permissions updated.';
        await ctx.refresh();
      } catch (error) {
        if (error.status === 409 && error.code === 'STALE_VERSION') settingsMessage = 'Changed by someone else; reloaded';
        else errorCode = redactError(error).code;
        const refreshed = await ctx.refresh();
        const refreshedSettings = refreshed?.data?.projections?.issues?.milestoneSettings
          ?? ctx.snapshot?.data?.projections?.issues?.milestoneSettings;
        if (Number.isSafeInteger(refreshedSettings?.version)) pinnedSettingsVersion = refreshedSettings.version;
      } finally { saving = false; renderMilestones(ctx); }
    });
    control.append(label, save);
    if (settingsMessage) control.append(element('p', settingsMessage, settingsMessage.startsWith('Changed') ? 'milestone-error' : 'muted'));
    root.append(control);
  }

  if (canCreate) {
    const form = element('form', undefined, 'milestone-form action-form');
    form.append(element('h2', 'New milestone'));
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
    form.append(title, description, dueDate, submit);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (creating) return;
      creating = true; errorCode = ''; renderMilestones(ctx);
      try {
        await createMilestone(ctx.repoId, { title: titleInput.value, description: descriptionInput.value, dueDate: dueDateInput.value || null }, newIdempotencyKey());
        await ctx.refresh();
      } catch (error) { errorCode = redactError(error).code; }
      finally { creating = false; renderMilestones(ctx); }
    });
    root.append(form);
  } else {
    root.append(element('p', 'Only owners can create milestones here.', 'muted'));
  }

  if (errorCode) root.append(element('p', errorCode, 'milestone-error'));
  const list = element('div', undefined, 'milestone-list');
  const visible = expanded ? milestones : milestones.slice(0, 50);
  for (const item of visible) {
    const card = element('article', undefined, 'milestone-card');
    card.append(element('h2', item.title), element('p', item.state, 'milestone-state'));
    if (item.dueDate) card.append(element('p', `Due ${item.dueDate}`));
    card.append(element('p', item.description ?? '', 'milestone-description'));
    const progress = item.progress ?? {};
    const milestoneIssues = issues.filter(issue => issue.milestoneId === item.milestoneId);
    const hasIssueRows = milestoneIssues.length > 0;
    const linkedLanded = milestoneIssues.filter(issue => !!issue.closedBy || issue.changes?.some(change => ['merged', 'landed'].includes(change.status))).length;
    const landedChanges = Number.isFinite(progress.landedChanges) ? progress.landedChanges : linkedLanded;
    const landed = hasIssueRows ? linkedLanded : landedChanges;
    const claimed = milestoneIssues.filter(issue => issue.state === 'open' && heldLeases.some(lease => lease.issueNumber === issue.number)).length;
    const review = milestoneIssues.filter(issue => issue.state === 'open' &&
      !heldLeases.some(lease => lease.issueNumber === issue.number) && issue.changes?.some(change => ['checking', 'ready', 'queued'].includes(change.status))).length;
    const openIssues = milestoneIssues.filter(issue => issue.state === 'open' &&
      !heldLeases.some(lease => lease.issueNumber === issue.number) &&
      !issue.changes?.some(change => ['checking', 'ready', 'queued', 'merged', 'landed'].includes(change.status))).length;
    const open = hasIssueRows ? openIssues : Number(progress.openIssues ?? 0);
    const total = landed + claimed + review + open;
    const bar = element('div', undefined, 'milestone-progress-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${landed} landed, ${review} in review, ${claimed} claimed, ${open} open`);
    for (const [count, color, label] of [[landed, 'landed', 'Landed'], [review, 'review', 'In review'], [claimed, 'claimed', 'Claimed']]) {
      const segment = element('span', undefined, `milestone-progress-segment ${color}`);
      segment.style.width = total ? `${Math.round(100 * count / total)}%` : '0%';
      segment.setAttribute('aria-label', `${label} ${count}`);
      bar.append(segment);
    }
    card.append(bar, element('p', `Landed ${landed} · ${landedChanges} landed changes · In review ${review} · Claimed ${claimed} · Open ${open} · ${landed} / ${total} total`, 'milestone-progress'));
    list.append(card);
  }
  root.append(list);
  if (!expanded && milestones.length > 50) {
    const more = element('button', `Show ${milestones.length - 50} more`);
    more.type = 'button'; more.addEventListener('click', () => { expanded = true; renderMilestones(ctx); });
    root.append(more);
  }
  if (focused) root.querySelector(`[data-field="${focused}"]`)?.focus({ preventScroll: true });
}
