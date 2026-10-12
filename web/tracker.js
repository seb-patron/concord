import { createFrictionIssue, newIdempotencyKey, redactError, updateIssue } from './api.js';

const lanes = [
  ['Ready to claim', 'Open issues whose units are free. `concord next` hands these out.'],
  ['Claimed', 'An agent holds the units. Nobody else can edit them.'],
  ['Checking & review', 'Checked on main + the queue ahead. Independent reviewer.'],
  ['Queued', 'Approved. Concord rebases it if main moves.'],
  ['Landed', 'On main. Issue closed by the land.'],
];
const arr = value => Array.isArray(value) ? value : [];
const el = (tag, value, className) => {
  const item = document.createElement(tag);
  if (value !== undefined && value !== null) item.textContent = String(value);
  if (className) item.className = className;
  return item;
};
const live = (lease, now) => ['active', 'reserved'].includes(lease?.state) && lease.expiresAt > now;
const time = value => Number.isFinite(value) ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—';
const today = (value, now) => Number.isFinite(value) && new Date(value).toDateString() === new Date(now).toDateString();
const eventIssue = (event, number, changeIds) => arr(event.relatedIds).some(id => id === String(number) || changeIds.includes(id));
const matches = (event, kinds) => kinds.includes(event.kind);

/** Pure tracker projection. Unknown event kinds never count as completed work. */
export function trackerModel(snapshot, events = [], identity = null, milestoneId = '', now = Date.now(), principals = [], verdicts = {}) {
  const p = snapshot?.data?.projections ?? {};
  const issues = arr(p.issues?.items);
  const milestones = arr(p.issues?.milestones);
  const changes = arr(p.repos?.changes);
  const held = arr(p.leases?.heldItems ?? p.leases?.items).filter(item => live(item, now));
  const entries = arr(p.queue?.entries);
  const selectedMilestone = milestoneId === '*' ? '*' : milestoneId || milestones.find(item => item.state === 'open')?.milestoneId || milestones[0]?.milestoneId || '*';
  const inMilestone = issue => selectedMilestone === '*' || issue.milestoneId === selectedMilestone;
  const cards = issues.filter(issue => inMilestone(issue) && !arr(issue.labels).includes('friction')).map(issue => {
    const linked = changes.filter(change => change.issueNumber === issue.number);
    const linkedIds = linked.map(change => change.changeId);
    const queue = entries.filter(entry => linkedIds.includes(entry.changeId) && entry.state !== 'withdrawn').at(-1);
    const active = linked.filter(change => !['merged', 'closed', 'superseded'].includes(change.status)).at(-1);
    const leases = held.filter(item => item.issueNumber === issue.number || linkedIds.includes(item.changeId));
    const holder = leases[0]?.holderId ?? null;
    const agent = active?.authorId ?? linked.at(-1)?.authorId ?? null;
    const landed = issue.state === 'closed' && !!issue.closedBy;
    const stage = landed ? 'Landed' : queue?.state === 'checking' || active?.status === 'checking' || active?.status === 'ready'
      ? 'Checking & review' : ['waiting', 'reserved'].includes(queue?.state) || active?.status === 'queued'
        ? 'Queued' : leases.length ? 'Claimed' : 'Ready to claim';
    const units = leases.length ? leases.map(item => item.unitKey) : arr(active?.unitKeys).length ? active.unitKeys : arr(issue.allowedFiles);
    const expiry = leases.length ? Math.min(...leases.map(item => item.expiresAt)) : null;
    const carried = queue?.carriedFrom || active?.carriedFrom || arr(verdicts[active?.changeId]).some(item => item.carriedFrom);
    const timeline = events.filter(event => eventIssue(event, issue.number, linkedIds));
    const principal = arr(principals).find(item => item.id === (holder ?? agent) || item.principalId === (holder ?? agent));
    return { issue, stage, holder, agent, harness: principal?.name ?? active?.authorModel ?? active?.model ?? '', units,
      expiry, meta: landed ? time(timeline.findLast(e => e.kind === 'issue.closed')?.timestamp) :
        stage === 'Queued' && carried ? 'rebased · carried' :
          stage === 'Claimed' && expiry ? `${Math.max(0, Math.ceil((expiry - now) / 60000))}m left` :
            stage === 'Ready to claim' ? 'free' : stage === 'Checking & review' ? 'review' : '',
      timeline, leases, changeIds: linkedIds };
  });
  const todayEvents = events.filter(event => today(event.timestamp, now));
  const statDefs = [
    ['Agents working', new Set(held.map(item => item.holderId).filter(Boolean)).size, todayEvents.filter(e => e.kind === 'lease.claimed')],
    ['Collisions avoided', todayEvents.filter(e => e.kind === 'lease.refused').length, todayEvents.filter(e => e.kind === 'lease.refused')],
    ['Rebases by Concord', todayEvents.filter(e => matches(e, ['change.rebased', 'queue.rebased'])).length, todayEvents.filter(e => matches(e, ['change.rebased', 'queue.rebased']))],
    ['Approvals carried', todayEvents.filter(e => e.kind === 'verdict.carried').length, todayEvents.filter(e => e.kind === 'verdict.carried')],
    ['Landed today', todayEvents.filter(e => e.kind === 'queue.promotion_applied').reduce((n, e) => n + arr(e.relatedIds).length, 0), todayEvents.filter(e => e.kind === 'queue.promotion_applied')],
  ];
  const friction = events.filter(e => matches(e, ['lease.refused', 'change.rebased', 'queue.rebased', 'verdict.carried',
    'verdict.carry-review-required', 'queue.entry_blocked', 'queue.blocked', 'queue.promotion_retry', 'queue.suspected_flake',
    'queue.result_rejected']) || e.kind === 'queue.result_received' && e.payload?.outcome === 'FAIL').map(e => {
    const id = arr(e.relatedIds)[0] ?? '';
    const descriptions = {
      'lease.refused': [`Claim refused for ${id}`, 'wait for lease', 'Refused before edit'],
      'change.rebased': [`Main moved under ${id}`, '0 worker runs', 'Rebased change'],
      'queue.rebased': [`Main moved under ${id}`, '0 worker runs', 'Rebased queue entry'],
      'verdict.carried': [`Review carried for ${id}`, '0 re-reviews', 'Carried approval'],
      'verdict.carry-review-required': [`Carry needed review for ${id}`, 'review required', 'Requested independent review'],
      'queue.entry_blocked': [`Queue blocked ${id}`, 'land delayed', 'Recorded blocked reason'],
      'queue.blocked': [`Queue blocked ${id}`, 'land delayed', 'Recorded blocked reason'],
      'queue.promotion_retry': [`Promotion retried for ${id}`, '1 retry', 'Retried promotion'],
      'queue.suspected_flake': [`Check varied for ${id}`, '1 retry', 'Flagged suspected flake'],
      'queue.result_rejected': [`Check result rejected for ${id}`, 'check delayed', 'Rejected result'],
      'queue.result_received': [`Check failed for ${id}`, 'repair needed', 'Recorded failure'],
    };
    const [what, cost, did] = descriptions[e.kind];
    return { event: e, when: time(e.timestamp), what, cost, did };
  }).reverse();
  const manual = issues.filter(issue => arr(issue.labels).includes('friction')).map(issue => {
    const created = events.find(event => event.kind === 'issue.created' && arr(event.relatedIds).includes(String(issue.number)));
    const cost = /^Cost: (.*)$/m.exec(issue.body ?? '')?.[1] ?? issue.body ?? '—';
    const did = /^Concord did: (.*)$/m.exec(issue.body ?? '')?.[1] ?? `Added by ${issue.authorId ?? 'a contributor'}`;
    return { issue, when: created ? time(created.timestamp) : 'issue', what: issue.title, cost, did };
  });
  return { cards, lanes, milestones, selectedMilestone, stats: statDefs, friction: [...friction, ...manual],
    working: cards.filter(card => card.leases.length), principalId: identity?.principalId ?? null };
}

export function createTracker(root, callbacks) {
  let selected = null;
  let filter = 'all';
  let milestoneId = '';
  let eventFilter = null;
  let formOpen = false;
  let status = '';
  let editing = false;
  let issueOpen = false;
  let currentRepo = null;
  let lastFormKey = '';
  const button = (label, action, className = '') => {
    const item = el('button', label, className); item.type = 'button'; item.addEventListener('click', action); return item;
  };
  const keyed = (item, key) => { item.dataset.focusKey = key; return item; };
  function render(context) {
    if (currentRepo !== context.repoId) { currentRepo = context.repoId; selected = null; milestoneId = ''; filter = 'all'; formOpen = false; status = ''; editing = false; issueOpen = false; }
    const model = trackerModel(context.snapshot, context.events, context.identity, milestoneId, Date.now(), context.principals, context.verdicts);
    milestoneId = model.selectedMilestone;
    const formKey = `${currentRepo}:${selected}:${editing}:${formOpen}`;
    const active = document.activeElement;
    const activeKey = root.contains(active) ? active?.dataset?.focusKey : null;
    const activeName = formKey === lastFormKey && root.contains(active) ? active?.name : null;
    const savedForm = formKey === lastFormKey
      ? Object.fromEntries([...root.querySelectorAll('.tracker-form input, .tracker-form textarea')].map(input => [input.name, input.value])) : {};
    lastFormKey = formKey;
    root.replaceChildren();
    if (!context.repoId) { root.append(el('p', 'Choose a repository to see its tracker.', 'tracker-empty')); return; }
    if (!context.snapshot) { root.append(el('p', context.message || 'Loading tracker…', 'tracker-empty')); return; }
    const head = el('div', null, 'tracker-heading');
    const title = el('div'); title.append(el('div', 'Milestone', 'tracker-overline'), el('h1', model.milestones.find(m => m.milestoneId === milestoneId)?.title ?? 'All issues'));
    title.append(el('p', 'The tracker updates itself from claims, checks, reviews and landings. Nobody edits it by hand.'));
    const selector = el('label', 'Milestone', 'tracker-select');
    const select = el('select'); select.setAttribute('aria-label', 'Milestone');
    const all = el('option', 'All milestones'); all.value = '*'; select.append(all);
    for (const milestone of model.milestones) { const option = el('option', milestone.title); option.value = milestone.milestoneId; select.append(option); }
    select.value = milestoneId; select.addEventListener('change', () => { milestoneId = select.value; selected = null; issueOpen = false; render(context); }); selector.append(keyed(select, 'milestone'));
    const filters = el('div', null, 'tracker-filters'); filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', 'Filter');
    for (const [id, label] of [['all', 'All'], ['ready', 'Ready'], ['agents', 'Held by agents'], ['mine', 'Mine']]) {
      const item = keyed(button(label, () => { filter = id; render(context); }), `filter-${id}`); item.setAttribute('aria-pressed', String(filter === id)); filters.append(item);
    }
    head.append(title, selector, filters); root.append(head);
    if (context.message) root.append(el('p', context.message, 'tracker-error'));
    const stats = el('section', null, 'tracker-stats'); stats.setAttribute('aria-label', 'Swarm today');
    for (const [label, value, events] of model.stats) {
      const item = keyed(button('', () => { eventFilter = label; render(context); }, 'tracker-stat'), `stat-${label}`);
      item.replaceChildren(el('span', label), el('strong', value), el('small', label === 'Agents working' ? 'live lease holders' : `${events.length} observed events`)); stats.append(item);
    }
    root.append(stats);
    if (eventFilter) {
      const section = el('section', null, 'tracker-evidence'); section.append(el('h2', eventFilter), keyed(button('Close events', () => { eventFilter = null; render(context); }), 'close-events'));
      const evidence = model.stats.find(s => s[0] === eventFilter)?.[2] ?? [];
      const rows = el('ol'); for (const e of evidence) rows.append(el('li', `${time(e.timestamp)} · ${e.kind} · ${arr(e.relatedIds).join(', ')}`));
      if (!evidence.length) rows.append(el('li', 'No matching events observed today.'));
      section.append(rows); root.append(section);
    }
    const layout = el('div', null, 'tracker-layout'); const scroll = el('div', null, 'tracker-scroll'); const board = el('div', null, 'tracker-board');
    const visible = model.cards.filter(card => filter === 'all' || filter === 'ready' && card.stage === 'Ready to claim' ||
      filter === 'agents' && card.leases.length > 0 || filter === 'mine' && !!model.principalId && card.holder === model.principalId);
    for (const [name, hint] of model.lanes) {
      const lane = el('section', null, 'tracker-lane'); lane.setAttribute('aria-label', name);
      const cards = visible.filter(card => card.stage === name);
      const laneHead = el('div', null, 'tracker-lane-head'); laneHead.append(el('h2', name), el('span', cards.length)); lane.append(laneHead, el('p', hint));
      if (!cards.length) lane.append(el('div', 'No issues here.', 'tracker-lane-empty'));
      for (const card of cards) {
        const item = keyed(button('', () => { selected = card.issue.number; editing = false; issueOpen = false; render(context); }, 'tracker-card'), `card-${card.issue.number}`);
        item.setAttribute('aria-pressed', String(selected === card.issue.number));
        item.append(el('strong', `#${card.issue.number} ${card.issue.title}`));
        const chips = el('span', null, 'tracker-chips'); for (const unit of card.units) chips.append(el('code', unit));
        if (!card.units.length) chips.append(el('span', 'No declared units'));
        item.append(chips, el('span', `${card.holder ?? card.agent ?? 'unclaimed'}${card.harness ? ` · ${card.harness}` : ''} · ${card.meta}`, 'tracker-card-foot'));
        lane.append(item);
      }
      board.append(lane);
    }
    scroll.append(board); layout.append(scroll);
    const picked = model.cards.find(card => card.issue.number === selected) ?? visible[0] ?? null;
    const drawer = el('aside', null, 'tracker-drawer'); drawer.setAttribute('aria-label', 'Selected issue');
    if (!picked) drawer.append(el('p', 'Select an issue to see its timeline.'));
    else {
      drawer.append(el('div', `#${picked.issue.number} · ${picked.stage}`, 'tracker-overline'), el('h2', picked.issue.title),
        el('div', 'Held by', 'tracker-overline'), el('p', `${picked.holder ?? 'unclaimed'}${picked.harness ? ` · ${picked.harness}` : ''}`), el('div', 'Timeline', 'tracker-overline'));
      const timeline = el('ol', null, 'tracker-timeline');
      for (const event of picked.timeline.slice(-30)) timeline.append(el('li', `${time(event.timestamp)} · ${event.kind} · ${event.actorId ?? 'system'}`));
      if (!picked.timeline.length) timeline.append(el('li', 'No activity yet.'));
      drawer.append(timeline);
      const link = keyed(el('a', issueOpen ? 'Close issue' : 'Open issue', 'tracker-open'), `issue-${picked.issue.number}`);
      link.href = `#tracker-issue-${picked.issue.number}`;
      link.addEventListener('click', event => { event.preventDefault(); issueOpen = !issueOpen; render(context); }); drawer.append(link);
      if (issueOpen) {
        const detail = el('article', null, 'tracker-issue-detail'); detail.id = `tracker-issue-${picked.issue.number}`;
        detail.append(el('h3', `Issue #${picked.issue.number}`), el('p', picked.issue.body || 'No description.'),
          el('p', `Labels: ${arr(picked.issue.labels).join(', ') || 'none'}`),
          el('p', `Milestone: ${model.milestones.find(item => item.milestoneId === picked.issue.milestoneId)?.title ?? 'none'}`));
        drawer.append(detail);
      }
      if (context.identity?.roles?.includes('owner') || context.identity?.principalId === picked.issue.authorId) {
        drawer.append(keyed(button(editing ? 'Cancel edit' : 'Edit issue', () => { editing = !editing; render(context); }, 'tracker-edit'), 'edit-issue'));
        if (editing) {
          const form = el('form', null, 'tracker-form');
          const label = (caption, name, value) => { const wrap = el('label', caption); const input = el(name === 'body' ? 'textarea' : 'input'); input.name = name; input.value = value ?? ''; wrap.append(input); return wrap; };
          form.append(label('Title', 'title', picked.issue.title), label('Body', 'body', picked.issue.body), label('Labels (comma separated)', 'labels', arr(picked.issue.labels).join(', ')));
          form.append(button('Save issue', () => { void submitEdit(form, context, picked.issue); }, 'tracker-submit')); drawer.append(form);
          if (status) drawer.append(el('p', status, 'tracker-status'));
        }
      }
    }
    layout.append(drawer); root.append(layout);
    const working = el('section', null, 'tracker-working'); working.append(el('h2', 'Working now'));
    if (!model.working.length) working.append(el('p', 'No live holds.'));
    for (const card of model.working) working.append(el('p', `#${card.issue.number} · ${card.holder} · ${card.units.join(', ') || 'units not recorded'}`));
    root.append(working);
    const friction = el('section', null, 'tracker-friction'); friction.id = 'friction'; friction.append(el('h2', 'Friction log'),
      el('p', 'Recorded automatically: every rebase, retry, blocked claim and repair round. Agents and humans can add rows.'));
    if (context.identity?.roles?.some(role => role === 'owner' || role === 'agent')) friction.append(keyed(button(formOpen ? 'Cancel' : 'Add friction row', () => { formOpen = !formOpen; render(context); }), 'add-friction'));
    if (formOpen) {
      const form = el('form', null, 'tracker-form');
      const what = el('label', 'What slowed us'); const titleInput = el('input'); titleInput.name = 'title'; titleInput.required = true; titleInput.maxLength = 256; what.append(titleInput);
      const cost = el('label', 'Cost'); const costInput = el('input'); costInput.name = 'cost'; cost.append(costInput);
      const did = el('label', 'What Concord did'); const didInput = el('textarea'); didInput.name = 'did'; did.append(didInput);
      form.append(what, cost, did, button('Add row', () => { void submitFriction(form, context); }, 'tracker-submit')); friction.append(form);
    }
    if (status) friction.append(el('p', status, 'tracker-status'));
    const tableWrap = el('div', null, 'tracker-table-wrap'); const table = el('table'); const thead = el('thead'); const tr = el('tr');
    for (const label of ['When', 'What slowed us', 'Cost', 'Concord did']) tr.append(el('th', label)); thead.append(tr); table.append(thead);
    const tbody = el('tbody');
    for (const row of model.friction) { const item = el('tr'); for (const value of [row.when, row.what, row.cost, row.did]) item.append(el('td', value)); tbody.append(item); }
    if (!model.friction.length) { const empty = el('tr'); const cell = el('td', 'No friction recorded yet.'); cell.colSpan = 4; empty.append(cell); tbody.append(empty); }
    table.append(tbody); tableWrap.append(table); friction.append(tableWrap); root.append(friction);
    for (const input of root.querySelectorAll('.tracker-form input, .tracker-form textarea')) {
      if (Object.hasOwn(savedForm, input.name)) input.value = savedForm[input.name];
      if (input.name === activeName) input.focus({ preventScroll: true });
    }
    if (activeKey) [...root.querySelectorAll('[data-focus-key]')].find(item => item.dataset.focusKey === activeKey)?.focus({ preventScroll: true });
  }
  async function submitFriction(form, context) {
    const title = form.elements.namedItem('title').value.trim();
    const cost = form.elements.namedItem('cost').value.trim(); const did = form.elements.namedItem('did').value.trim();
    const body = `Cost: ${cost || '—'}\nConcord did: ${did || 'Not recorded'}`;
    if (!title) { status = 'Describe what slowed us.'; render(context); return; }
    try { await createFrictionIssue(context.repoId, { title, body, milestoneId: milestoneId === '*' ? null : milestoneId }, newIdempotencyKey());
      formOpen = false; status = 'Friction row added.'; await callbacks.refresh(); }
    catch (error) { status = `Could not add row (${redactError(error).code}).`; render(context); }
  }
  async function submitEdit(form, context, issue) {
    const title = form.elements.namedItem('title').value.trim();
    if (!title) { status = 'Issue title is required.'; render(context); return; }
    const body = form.elements.namedItem('body').value;
    const labels = form.elements.namedItem('labels').value.split(',').map(s => s.trim()).filter(Boolean);
    if (new Set(labels).size !== labels.length) { status = 'Labels must be distinct.'; render(context); return; }
    try { await updateIssue(context.repoId, issue.number, { expectedVersion: issue.version, title, body, labels }, newIdempotencyKey());
      editing = false; status = 'Issue updated.'; await callbacks.refresh(); }
    catch (error) { status = `Could not update issue (${redactError(error).code}).`; render(context); }
  }
  return { render };
}
