const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
};
const items = value => Array.isArray(value) ? value : [];
const labelColor = label => {
  let hash = 2166136261;
  for (const char of String(label)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `hsl(${(hash >>> 0) % 360} 52% 88%)`;
};
const issueTime = value => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
const relativeTime = value => {
  const timestamp = issueTime(value);
  if (timestamp === null) return null;
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60]];
  const [unit, size] = units.find(([, secondsPerUnit]) => Math.abs(seconds) >= secondsPerUnit) ?? ['second', 1];
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(seconds / size), unit);
};

function safeMarkdown(target, source) {
  target.replaceChildren();
  let list = null;
  let code = null;
  for (const line of String(source ?? '').split(/\r?\n/)) {
    if (line.startsWith('```')) { code = code ? null : target.appendChild(document.createElement('pre')); list = null; continue; }
    if (code) { code.textContent += `${line}\n`; continue; }
    if (!line.trim()) { list = null; continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { target.append(el(`h${heading[1].length}`, heading[2])); list = null; continue; }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (!list) { list = document.createElement('ul'); target.append(list); }
      list.append(el('li', bullet[1])); continue;
    }
    list = null;
    target.append(el('p', line));
  }
}

/** Render the repository's issues from its current snapshot without additional requests. */
export function renderIssues(root, ctx) {
  if (!root) return;
  const repoId = String(ctx.repoId ?? '');
  const p = ctx.snapshot?.data?.projections ?? {};
  const issues = items(p.issues?.items);
  const milestones = items(p.issues?.milestones);
  const changes = items(p.repos?.changes);
  const now = Date.now();
  const leases = items(p.leases?.heldItems ?? p.leases?.items).filter(lease =>
    ['active', 'reserved'].includes(lease.state) && Number(lease.expiresAt) > now);
  const labelSet = new Set(issues.flatMap(issue => items(issue.labels)));
  const milestoneSet = new Set(milestones.map(item => item.milestoneId));
  const assignees = issue => {
    const names = new Set();
    for (const lease of leases.filter(item => item.issueNumber === issue.number)) {
      const change = changes.find(item => item.changeId === lease.changeId);
      const name = change?.authorModel || lease.holderId;
      if (name) names.add(name);
    }
    return [...names];
  };
  const assigneeSet = new Set(issues.flatMap(assignees));
  const previous = root.dataset;
  const sameRepo = previous.repoId === repoId;
  const state = sameRepo ? {
    query: previous.query ?? '', status: previous.status === 'closed' ? 'closed' : 'open',
    label: labelSet.has(previous.label) ? previous.label : '',
    milestone: milestoneSet.has(previous.milestone) ? previous.milestone : '',
    assignee: assigneeSet.has(previous.assignee) ? previous.assignee : '',
    selected: issues.some(issue => String(issue.number) === previous.selected) ? previous.selected : '',
  } : { query: '', status: 'open', label: '', milestone: '', assignee: '', selected: '' };
  root.dataset.repoId = repoId;
  root.replaceChildren();
  const header = el('div', undefined, 'issues-heading');
  header.append(el('p', `${issues.filter(item => item.state === 'open').length} open · ${issues.filter(item => item.state === 'closed').length} closed`, 'issues-count'));
  const controls = el('div', undefined, 'issues-controls');
  const search = el('input'); search.type = 'search'; search.placeholder = 'Search issues'; search.setAttribute('aria-label', 'Search issues'); search.value = state.query;
  const toggle = el('div', undefined, 'issues-state-toggle'); toggle.setAttribute('role', 'group'); toggle.setAttribute('aria-label', 'Issue state');
  const listRoot = el('div', undefined, 'issues-list');
  const drawer = el('aside', undefined, 'issues-drawer');
  const makeLabel = label => {
    const chip = el('span', label, 'issue-label');
    chip.style.setProperty('--issue-label-color', labelColor(label));
    chip.dataset.label = label;
    return chip;
  };
  const select = (label, key, values) => {
    const wrap = el('label', label, 'issues-filter');
    const control = el('select'); control.setAttribute('aria-label', label);
    const any = el('option', `All ${label.toLowerCase()}`); any.value = ''; control.append(any);
    for (const [value, title] of values) { const option = el('option', title); option.value = value; control.append(option); }
    control.value = state[key];
    control.addEventListener('change', () => { state[key] = control.value; renderList(); });
    wrap.append(control); return wrap;
  };
  const labelValues = [...labelSet].sort((a, b) => a.localeCompare(b)).map(label => [label, label]);
  const milestoneValues = milestones.map(item => [item.milestoneId, item.title]);
  const assigneeValues = [...assigneeSet].sort().map(name => [name, name]);
  controls.append(search, select('Label', 'label', labelValues), select('Milestone', 'milestone', milestoneValues), select('Assignee', 'assignee', assigneeValues));
  header.append(controls);
  for (const status of ['open', 'closed']) {
    const button = el('button', `${status === 'open' ? 'Open' : 'Closed'} ${issues.filter(item => item.state === status).length}`);
    button.type = 'button'; button.setAttribute('aria-pressed', String(state.status === status));
    button.addEventListener('click', () => { state.status = status; renderList(); });
    toggle.append(button);
  }
  root.append(header, toggle);
  const layout = el('div', undefined, 'issues-layout'); layout.append(listRoot, drawer); root.append(layout);
  const renderDrawer = issue => {
    drawer.replaceChildren();
    if (!issue) { drawer.hidden = true; return; }
    drawer.hidden = false;
    const close = el('button', 'Close'); close.type = 'button'; close.setAttribute('aria-label', 'Close issue details');
    close.addEventListener('click', () => { state.selected = ''; renderList(); });
    drawer.append(close, el('p', `#${issue.number}`, 'issues-number'), el('h2', issue.title));
    const body = el('div', undefined, 'issues-body'); safeMarkdown(body, issue.body); drawer.append(body);
    const labels = el('div', undefined, 'issues-chips');
    for (const label of items(issue.labels)) labels.append(makeLabel(label));
    drawer.append(labels);
    drawer.append(el('p', `Milestone: ${milestones.find(item => item.milestoneId === issue.milestoneId)?.title ?? '—'}`, 'issues-meta'));
    drawer.append(el('h3', 'Linked changes'));
    const linkedIds = new Set(leases.filter(lease => lease.issueNumber === issue.number).map(lease => lease.changeId).filter(Boolean));
    const linked = changes.filter(change => change.issueNumber === issue.number || linkedIds.has(change.changeId) ||
      new RegExp(`\\bissue\\s+#${Number(issue.number)}\\b`, 'i').test(change.intentText ?? change.intent ?? ''));
    if (!linked.length) drawer.append(el('p', 'No linked changes.', 'issues-meta'));
    for (const change of linked) drawer.append(el('p', `${change.changeId ?? 'Change'} · ${change.status ?? 'status unavailable'}`, 'issues-change'));
  };
  const renderList = () => {
    root.dataset.query = state.query; root.dataset.status = state.status; root.dataset.label = state.label;
    root.dataset.milestone = state.milestone; root.dataset.assignee = state.assignee; root.dataset.selected = state.selected;
    for (const button of toggle.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.textContent.toLowerCase().startsWith(state.status)));
    const query = state.query.trim().toLocaleLowerCase();
    const visible = issues.filter(issue => {
      const names = assignees(issue);
      const haystack = [issue.title, issue.body, issue.number, `#${issue.number}`, ...items(issue.labels)].join(' ').toLocaleLowerCase();
      return issue.state === state.status && (!query || haystack.includes(query)) &&
        (!state.label || items(issue.labels).includes(state.label)) && (!state.milestone || issue.milestoneId === state.milestone) &&
        (!state.assignee || names.includes(state.assignee));
    });
    listRoot.replaceChildren();
    if (!visible.length) listRoot.append(el('p', 'No issues match these filters.', 'issues-empty'));
    for (const issue of visible) {
      const row = el('button', undefined, 'issue-row'); row.type = 'button'; row.dataset.issueNumber = issue.number;
      row.setAttribute('aria-pressed', String(state.selected === String(issue.number)));
      const icon = el('span', issue.state === 'open' ? '●' : '✓', `issue-state-icon ${issue.state}`); icon.setAttribute('aria-label', issue.state);
      const main = el('span', undefined, 'issue-row-main');
      main.append(el('strong', issue.title, 'issue-title'));
      const closed = issue.state === 'closed';
      const time = relativeTime(closed ? issue.closedAt : issue.createdAt);
      const metadata = `#${issue.number}${time ? ` · ${closed ? 'Closed' : 'Opened'} ${time}` : ''}`;
      main.append(el('span', metadata, 'issues-meta'));
      const chips = el('span', undefined, 'issues-chips');
      for (const label of items(issue.labels)) chips.append(makeLabel(label));
      const milestoneTitle = milestones.find(item => item.milestoneId === issue.milestoneId)?.title;
      if (milestoneTitle) chips.append(el('span', milestoneTitle, 'issue-milestone'));
      const people = el('span', undefined, 'issues-chips');
      const assigned = assignees(issue);
      if (!assigned.length) people.append(el('span', '—', 'issues-meta'));
      for (const name of assigned) people.append(el('span', name, 'issue-assignee'));
      row.append(icon, main, chips, people);
      row.addEventListener('click', () => { state.selected = String(issue.number); renderList(); });
      listRoot.append(row);
    }
    renderDrawer(issues.find(issue => String(issue.number) === state.selected));
  };
  search.addEventListener('input', () => { state.query = search.value; renderList(); search.focus(); });
  renderList();
}
