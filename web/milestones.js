/**
 * Concord milestones screen.
 *
 * Renders each milestone's progress split by landed / manually closed /
 * in review or queued / claimed / open, its due date, a pace note, and an editable description,
 * following the approved prototype. Data comes from the repository snapshot's
 * `issues.milestones` projection (the same milestone views the milestones API
 * returns, including progress counts) plus issue, change, lease, and queue
 * state. Milestone titles hand off to the Tracker through the host-supplied
 * `openTracker` callback. Mutations use the ordinary milestone API with
 * optimistic object versions; refusals and unavailable routes are shown as
 * explicit status, never faked.
 */
import { createMilestone, newIdempotencyKey, redactError, updateMilestone } from './api.js';
import { panelCopy } from './views.js';

const arr = value => Array.isArray(value) ? value : [];
const el = (tag, value, className) => {
  const item = document.createElement(tag);
  if (value !== undefined && value !== null) item.textContent = String(value);
  if (className) item.className = className;
  return item;
};
const live = (lease, now) => ['active', 'reserved'].includes(lease?.state) && lease.expiresAt > now;
const sameDay = (value, now) => Number.isFinite(value) && new Date(value).toDateString() === new Date(now).toDateString();
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dueText = dueDate => {
  if (!dueDate) return 'No due date';
  const date = new Date(`${dueDate}T00:00:00Z`);
  return Number.isFinite(date.valueOf())
    ? `Due ${WEEKDAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`
    : `Due ${dueDate}`;
};

/** One open issue counts toward exactly one bar segment. */
const openBucket = (issue, held) => {
  const linked = arr(issue.changes).map(change => change.changeId);
  const statuses = new Set(arr(issue.changes).map(change => change.status));
  if (['ready', 'checking', 'queued'].some(status => statuses.has(status))) return 'review';
  const heldNow = held.some(item => item.issueNumber === issue.number || linked.includes(item.changeId));
  if (heldNow || ['draft', 'blocked'].some(status => statuses.has(status))) return 'claimed';
  return 'open';
};

/**
 * Pure milestones projection. Bar counts split each milestone's issues into
 * landed (API landedChanges), closed without landing, in review or queued,
 * claimed, and still open;
 * totals come from the milestone progress counts, not invented data.
 */
export function milestoneModel(snapshot, events = [], now = Date.now()) {
  const projection = snapshot?.data?.projections?.issues;
  const issues = arr(projection?.items);
  const milestones = arr(projection?.milestones);
  const held = arr(snapshot?.data?.projections?.leases?.heldItems ?? snapshot?.data?.projections?.leases?.items)
    .filter(item => live(item, now));
  const rows = milestones.map(milestone => {
    const progress = milestone.progress ?? {};
    const members = issues.filter(issue => issue.milestoneId === milestone.milestoneId);
    const closedIssues = Number.isFinite(progress.closedIssues)
      ? progress.closedIssues : members.filter(issue => issue.state === 'closed').length;
    const landings = Number.isFinite(progress.landedChanges)
      ? progress.landedChanges : members.filter(issue => issue.state === 'closed' && arr(issue.changes).some(change => change.status === 'merged')).length;
    const landed = Math.min(closedIssues, landings);
    const closed = Math.max(0, closedIssues - landed);
    const openIssues = Number.isFinite(progress.openIssues)
      ? progress.openIssues : members.filter(issue => issue.state === 'open').length;
    const changeIds = new Set(members.flatMap(issue => arr(issue.changes).map(change => change.changeId)));
    const issueNumbers = new Set(members.map(issue => String(issue.number)));
    let review = 0; let claimed = 0;
    const workers = new Set();
    for (const issue of members.filter(item => item.state === 'open')) {
      const bucket = openBucket(issue, held);
      if (bucket === 'review') review++;
      else if (bucket === 'claimed') claimed++;
      for (const item of held) {
        if (item.holderId && (item.issueNumber === issue.number || changeIds.has(item.changeId))) workers.add(item.holderId);
      }
    }
    const open = Math.max(0, openIssues - review - claimed);
    const landingsToday = events.filter(event => event.kind === 'queue.promotion_applied' && sameDay(event.timestamp, now)
      && arr(event.relatedIds).some(id => changeIds.has(id) || issueNumbers.has(id))).length;
    const pace = landingsToday > 0 ? `On pace: about ${landingsToday} landing${landingsToday === 1 ? '' : 's'} a day`
      : workers.size > 0 ? `${workers.size} agent${workers.size === 1 ? '' : 's'} working`
        : landed + review + claimed === 0 && open > 0 ? `Not started: ${open} issue${open === 1 ? '' : 's'} claimable now`
          : 'No landings observed today';
    const total = landed + closed + review + claimed + open;
    return { milestone, landed, closed, review, claimed, open, total, pace, due: dueText(milestone.dueDate),
      barLabel: `${landed} landed, ${closed} closed without landing, ${review} in review, ${claimed} claimed, ${open} open` };
  });
  const state = !snapshot ? 'loading'
    : projection?.status === 'unavailable' ? 'unavailable'
      : !projection ? 'unknown' : rows.length ? 'ready' : 'empty';
  return { rows, state };
}

export function createMilestones(root, callbacks) {
  let formOpen = false;
  let editing = null;
  let status = '';
  let currentRepo = null;
  let lastFormKey = '';
  const keyed = (item, key) => { item.dataset.focusKey = key; return item; };
  const button = (label, action, className = '') => {
    const item = el('button', label, className); item.type = 'button'; item.addEventListener('click', action); return item;
  };
  function render(context) {
    if (currentRepo !== context.repoId) { currentRepo = context.repoId; formOpen = false; editing = null; status = ''; }
    const model = milestoneModel(context.snapshot, context.events ?? [], Date.now());
    const canEdit = !!context.identity?.unverified || arr(context.identity?.roles).includes('owner');
    const formKey = `${currentRepo}:${formOpen}:${editing}`;
    const active = document.activeElement;
    const activeKey = root.contains(active) ? active?.dataset?.focusKey : null;
    const activeName = formKey === lastFormKey && root.contains(active) ? active?.name : null;
    const savedForm = {};
    if (formKey === lastFormKey) {
      for (const form of root.querySelectorAll('.milestone-form')) {
        savedForm[form.dataset.formId] = Object.fromEntries([...form.elements].filter(item => item.name).map(item => [item.name, item.value]));
      }
    }
    const savedDesc = Object.fromEntries([...root.querySelectorAll('textarea[data-desc-for]')]
      .filter(item => item.value !== item.dataset.lastValue).map(item => [item.dataset.descFor, item.value]));
    lastFormKey = formKey;
    root.replaceChildren();
    if (!context.repoId) { root.append(el('p', 'Choose a repository to see its milestones.', 'milestone-empty')); return; }
    if (!context.snapshot) { root.append(el('p', context.message || 'Loading milestones…', 'milestone-empty')); return; }
    const head = el('div', null, 'milestone-head');
    head.append(el('h1', 'Milestones'));
    if (canEdit) head.append(keyed(button(formOpen ? 'Cancel' : 'New milestone', () => { formOpen = !formOpen; status = ''; render(context); }, 'milestone-new'), 'new-milestone'));
    root.append(head);
    if (context.message) root.append(el('p', context.message, 'milestone-error'));
    if (status) root.append(el('p', status, 'milestone-status'));
    if (formOpen) {
      const form = el('form', null, 'milestone-form'); form.dataset.formId = 'new';
      form.append(el('h2', 'New milestone'));
      const titleLabel = el('label', 'Title'); const title = el('input'); title.name = 'title'; title.required = true; title.maxLength = 256; titleLabel.append(title);
      const dueLabel = el('label', 'Due date (optional)'); const due = el('input'); due.name = 'dueDate'; due.type = 'date'; dueLabel.append(due);
      const descLabel = el('label', 'Description'); const desc = el('textarea'); desc.name = 'description'; descLabel.append(desc);
      form.append(titleLabel, dueLabel, descLabel);
      const controls = el('div', null, 'milestone-controls');
      const submit = el('button', 'Create milestone', 'milestone-create'); submit.type = 'submit';
      controls.append(submit, button('Cancel', () => { formOpen = false; render(context); }, 'milestone-cancel'));
      form.append(controls);
      form.addEventListener('submit', event => { event.preventDefault(); void submitCreate(form, context); });
      root.append(form);
    }
    if (model.state === 'unavailable' || model.state === 'unknown') {
      const copy = panelCopy(model.state);
      root.append(el('p', `${copy.title} — ${copy.hint}`, 'milestone-empty'));
    } else if (!model.rows.length) {
      root.append(el('p', canEdit ? 'No milestones yet. Create one with New milestone.' : 'No milestones yet.', 'milestone-empty'));
    }
    const list = el('div', null, 'milestones-list');
    for (const row of model.rows) list.append(milestoneCard(row, context, canEdit));
    root.append(list);
    for (const form of root.querySelectorAll('.milestone-form')) {
      const saved = savedForm[form.dataset.formId];
      if (!saved) continue;
      for (const input of [...form.elements].filter(item => item.name)) {
        if (Object.hasOwn(saved, input.name)) input.value = saved[input.name];
        if (input.name === activeName) input.focus({ preventScroll: true });
      }
    }
    for (const field of root.querySelectorAll('textarea[data-desc-for]')) {
      if (Object.hasOwn(savedDesc, field.dataset.descFor)) field.value = savedDesc[field.dataset.descFor];
    }
    if (activeKey) [...root.querySelectorAll('[data-focus-key]')].find(item => item.dataset.focusKey === activeKey)?.focus({ preventScroll: true });
  }
  function milestoneCard(row, context, canEdit) {
    const milestone = row.milestone;
    const card = el('section', null, 'milestone-card'); card.setAttribute('aria-label', milestone.title);
    const top = el('div', null, 'milestone-top');
    const heading = el('h2');
    if (callbacks.openTracker && (callbacks.hasTracker?.() ?? true)) {
      const link = el('a', milestone.title); link.href = '#';
      link.setAttribute('aria-label', `Open tracker filtered to ${milestone.title}`);
      link.addEventListener('click', event => { event.preventDefault(); callbacks.openTracker(milestone.milestoneId); });
      heading.append(link);
    } else heading.textContent = milestone.title;
    top.append(heading, el('span', row.due, 'milestone-due'), el('span', `${row.landed} / ${row.total} landed`, 'milestone-count'));
    if (milestone.state === 'closed') top.append(el('span', 'Closed', 'milestone-closed'));
    card.append(top);
    const bar = el('div', null, 'milestone-bar'); bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', row.barLabel);
    const segment = (count, className) => {
      const item = el('span', null, className);
      item.style.width = `${row.total ? Math.round(100 * count / row.total) : 0}%`;
      return item;
    };
    bar.append(segment(row.landed, 'seg-landed'), segment(row.closed, 'seg-closed'), segment(row.review, 'seg-review'), segment(row.claimed, 'seg-claimed'));
    card.append(bar);
    const legend = el('div', null, 'milestone-legend');
    const dot = (className, text) => {
      const item = el('span');
      item.append(el('span', null, `milestone-dot ${className}`), document.createTextNode(` ${text}`));
      return item;
    };
    legend.append(dot('dot-landed', `Landed ${row.landed}`), dot('dot-closed', `Closed without landing ${row.closed}`), dot('dot-review', `In review or queued ${row.review}`),
      dot('dot-claimed', `Claimed ${row.claimed}`), el('span', `Open ${row.open}`), el('span', row.pace, 'milestone-pace'));
    card.append(legend);
    const descLabel = el('label', 'Description', 'milestone-desc-label');
    const desc = el('textarea', null, 'milestone-desc');
    desc.id = `desc-${milestone.milestoneId}`; desc.name = 'description'; desc.value = milestone.description ?? '';
    desc.dataset.descFor = milestone.milestoneId; desc.dataset.lastValue = milestone.description ?? '';
    descLabel.htmlFor = desc.id;
    if (!canEdit) desc.readOnly = true;
    card.append(descLabel, desc);
    if (canEdit) {
      const controls = el('div', null, 'milestone-controls');
      controls.append(keyed(button('Save description', () => void submitDesc(milestone, desc, context), 'milestone-save'), `save-${milestone.milestoneId}`),
        keyed(button(editing === milestone.milestoneId ? 'Cancel edit' : 'Edit title and due date',
          () => { editing = editing === milestone.milestoneId ? null : milestone.milestoneId; status = ''; render(context); }, 'milestone-edit'), `edit-${milestone.milestoneId}`));
      card.append(controls);
      if (editing === milestone.milestoneId) {
        const form = el('form', null, 'milestone-form'); form.dataset.formId = milestone.milestoneId;
        const titleLabel = el('label', 'Title'); const title = el('input'); title.name = 'title'; title.required = true; title.maxLength = 256; title.value = milestone.title ?? ''; titleLabel.append(title);
        const dueLabel = el('label', 'Due date (optional)'); const due = el('input'); due.name = 'dueDate'; due.type = 'date'; due.value = milestone.dueDate ?? ''; dueLabel.append(due);
        form.append(titleLabel, dueLabel);
        const buttons = el('div', null, 'milestone-controls');
        const submit = el('button', 'Save changes', 'milestone-save'); submit.type = 'submit';
        buttons.append(submit, button('Cancel', () => { editing = null; render(context); }, 'milestone-cancel'));
        form.append(buttons);
        form.addEventListener('submit', event => { event.preventDefault(); void submitEdit(form, context, milestone); });
        card.append(form);
      }
    }
    return card;
  }
  async function submitCreate(form, context) {
    const title = form.elements.namedItem('title').value.trim();
    if (!title) { status = 'Milestone title is required.'; render(context); return; }
    const dueDate = form.elements.namedItem('dueDate').value.trim();
    const body = { title, description: form.elements.namedItem('description').value };
    if (dueDate) body.dueDate = dueDate;
    try {
      await createMilestone(context.repoId, body, newIdempotencyKey());
      formOpen = false; status = 'Milestone created.'; await callbacks.refresh();
    } catch (error) { status = `Could not create milestone (${redactError(error).code}).`; render(context); }
  }
  async function submitDesc(milestone, field, context) {
    if (field.value === (milestone.description ?? '')) { status = 'Description unchanged.'; render(context); return; }
    try {
      await updateMilestone(context.repoId, milestone.milestoneId, { expectedVersion: milestone.version, description: field.value }, newIdempotencyKey());
      status = 'Description saved.'; await callbacks.refresh();
    } catch (error) {
      status = `Could not save milestone (${redactError(error).code}).`;
      if (error?.status === 409) { render(context); await callbacks.refresh?.(); return; }
      render(context);
    }
  }
  async function submitEdit(form, context, milestone) {
    const title = form.elements.namedItem('title').value.trim();
    if (!title) { status = 'Milestone title is required.'; render(context); return; }
    const dueDate = form.elements.namedItem('dueDate').value;
    try {
      await updateMilestone(context.repoId, milestone.milestoneId,
        { expectedVersion: milestone.version, title, dueDate: dueDate || null }, newIdempotencyKey());
      editing = null; status = 'Milestone updated.'; await callbacks.refresh();
    } catch (error) {
      status = `Could not update milestone (${redactError(error).code}).`;
      if (error?.status === 409) { render(context); await callbacks.refresh?.(); return; }
      render(context);
    }
  }
  return { render };
}
