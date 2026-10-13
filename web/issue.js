/**
 * Concord issue editor.
 *
 * Human screen for one issue, better than GitHub's: title, markdown spec
 * with Write / Preview / 'What the agent sees' tabs, the units the agent
 * may touch (add/remove with live free/held state), milestone, labels,
 * plus overlaps with other open issues and the change timeline.
 *
 * All data comes from the issues API and the coordinator snapshot; the
 * module never invents units, holders, or history. Edits save through
 * PATCH /issues/:number with the loaded optimistic version. A stale
 * version shows the newer server copy and lets the human merge — the
 * editor never silently overwrites.
 */

import {
  getEvents, getIssue, getSnapshot, listIssues, listMilestones, newIdempotencyKey, redactError, updateIssue,
} from './api.js';
import {
  agentSpecText, formatLabelsInput, issueOverlaps, issueTimeline, parseLabelsInput, parseUnitEntry,
  renderMarkdown, safeText, snapshotCollections, unitLeaseState,
} from './views.js';

const liveLeases = snapshot => snapshot?.data?.projections?.leases?.heldItems ??
  snapshot?.data?.projections?.leases?.items ?? [];
const openIssues = snapshot => (Array.isArray(snapshot?.data?.projections?.issues?.items)
  ? snapshot.data.projections.issues.items : []).filter(issue => issue?.state === 'open');
/** Union helpers: the editor's own fetches must not clobber the desk's fuller live buffer. */
const eventKey = event => event?.sequence ?? JSON.stringify(event);
const unionEvents = (current, fresh) => {
  const seen = new Set(current.map(eventKey));
  return [...current, ...fresh.filter(event => !seen.has(eventKey(event)))];
};
const unionIssues = (fresh, current) => {
  const seen = new Set(fresh.map(issue => issue?.number));
  return [...fresh, ...current.filter(issue => !seen.has(issue?.number))];
};
const leaseKey = lease => lease?.leaseId ?? [lease?.unitKey, lease?.holderId, lease?.changeId].join(':');
const unionLeases = (current, fresh) => {
  const merged = new Map(current.map(lease => [leaseKey(lease), lease]));
  for (const lease of fresh) {
    const key = leaseKey(lease);
    const prev = merged.get(key);
    if (!prev || (lease?.version ?? 0) >= (prev?.version ?? 0)) merged.set(key, lease);
  }
  return [...merged.values()];
};
const unionChanges = (fresh, current) => {
  const seen = new Set(fresh.map(change => change?.changeId));
  return [...fresh, ...current.filter(change => !seen.has(change?.changeId))];
};
/**
 * Cheap poll signature over exactly the fields the editor renders, never
 * full payloads. A match means the panels would render identically, so
 * skipping the re-render discards nothing observable.
 */
const liveSignature = (leases, changes, issues, events) => [
  leases.map(lease => [lease?.leaseId, lease?.version, lease?.state, lease?.expiresAt,
    lease?.unitKey, lease?.holderId, lease?.changeId, lease?.issueNumber].join(':')).join(','),
  changes.map(change => [change?.changeId, change?.status, change?.revision,
    [...(change?.dependencyChangeIds ?? [])].sort().join(';')].join(':')).join(','),
  issues.map(issue => [issue?.number, issue?.state, issue?.title,
    [...(issue?.allowedFiles ?? [])].sort().join(';')].join(':')).join(','),
  // Events are an append-only log, so length plus boundary sequences suffice.
  events.length, events.length ? events[0]?.sequence : null,
  events.length ? events[events.length - 1]?.sequence : null,
].join('|');
const milestoneTitle = (editor, id) =>
  (editor.milestones.find(item => item?.milestoneId === id)?.title ?? null);

const kindLabel = kind => ({ file: 'file', section: 'section', row: 'row', unknown: 'unknown', empty: 'empty' }[kind] ?? kind);

export function createIssueEditor(root, api = {}, hooks = {}) {
  const calls = {
    getIssue: api.getIssue ?? getIssue,
    listIssues: api.listIssues ?? listIssues,
    listMilestones: api.listMilestones ?? listMilestones,
    updateIssue: api.updateIssue ?? updateIssue,
    getSnapshot: api.getSnapshot ?? getSnapshot,
    getEvents: api.getEvents ?? getEvents,
    newKey: api.newIdempotencyKey ?? newIdempotencyKey,
  };
  const doc = () => root.ownerDocument;
  const editor = {
    root, repoId: null, number: null, issue: null, milestones: [], issues: [], leases: [], events: [], changes: [],
    tab: 'write', draft: null, addValue: '', conflict: null, message: null, error: null, saving: false,
    liveSignature: null,
  };

  const el = (tag, value, className) => {
    const n = doc().createElement(tag);
    if (value !== undefined && value !== null) n.textContent = safeText(value);
    if (className) n.className = className;
    return n;
  };
  const setMessage = (message, error = null) => { editor.message = message; editor.error = error; };
  const draftFrom = issue => ({
    title: issue?.title ?? '',
    body: issue?.body ?? '',
    labels: formatLabelsInput(issue?.labels),
    milestoneId: issue?.milestoneId ?? null,
    units: Array.isArray(issue?.allowedFiles) ? [...issue.allowedFiles] : [],
  });

  function preserveFocus(render) {
    const focused = doc().activeElement?.id;
    render();
    if (focused) doc().getElementById(focused)?.focus({ preventScroll: true });
  }

  async function open(repoId, number) {
    // Keep live buffers when re-opening the same issue so a failed fetch
    // cannot wipe newer poll data; a different issue starts empty.
    const switching = editor.repoId !== repoId || editor.number !== number;
    Object.assign(editor, { repoId, number, issue: null, milestones: [],
      issues: switching ? [] : editor.issues, leases: switching ? [] : editor.leases,
      events: switching ? [] : editor.events, changes: switching ? [] : editor.changes,
      tab: 'write', draft: null, addValue: '', conflict: null, message: 'Loading issue…', error: null, saving: false, liveSignature: null });
    render();
    try {
      const [issueRes, milestoneRes, issueListRes, snapshotRes, eventsRes] = await Promise.all([
        calls.getIssue(repoId, number),
        calls.listMilestones(repoId).catch(error => ({ error })),
        calls.listIssues(repoId, { state: 'open', limit: 100 }).catch(error => ({ error })),
        calls.getSnapshot(repoId).catch(error => ({ error })),
        calls.getEvents(repoId, 0).catch(error => ({ error })),
      ]);
      if (editor.repoId !== repoId || editor.number !== number) return;
      editor.issue = issueRes?.data ?? null;
      if (!editor.issue) throw new Error('Issue not found');
      editor.draft = draftFrom(editor.issue);
      editor.milestones = milestoneRes?.data?.items ?? milestoneRes?.data?.milestones ?? [];
      if (milestoneRes?.error) editor.milestones = [];
      // Union, never clobber: desk polls may already hold fuller live data.
      // The snapshot issues projection is the complete open list, so it
      // supplements the paged listIssues and drops server-side closures;
      // only a failed list fetch falls back to the retained buffer.
      const snapshot = snapshotRes && !snapshotRes.error ? snapshotRes : null;
      const freshList = issueListRes && !issueListRes.error ? (issueListRes?.data?.items ?? []) : null;
      const snapOpens = openIssues(snapshot);
      editor.issues = freshList
        ? unionIssues([...freshList, ...snapOpens], [])
        : unionIssues(snapOpens, editor.issues);
      if (snapshot?.data?.projections?.leases) editor.leases = unionLeases(editor.leases, liveLeases(snapshot));
      if (snapshot?.data?.projections?.repos) {
        editor.changes = unionChanges(snapshotCollections(snapshot).changes.items, editor.changes);
      }
      editor.events = unionEvents(editor.events, eventsRes?.data?.items ?? []);
      if (milestoneRes?.error || issueListRes?.error || snapshotRes?.error || eventsRes?.error) {
        setMessage('Issue loaded; some panels show fallbacks because a supporting request failed.');
      } else setMessage(null);
    } catch (error) {
      if (editor.repoId !== repoId || editor.number !== number) return;
      setMessage(null, `Could not load issue #${number} (${redactError(error).code}).`);
    }
    render();
  }

  function setLive({ snapshot = null, events = null } = {}) {
    // A missing projection keeps the last list; only a present one replaces.
    const leases = snapshot?.data?.projections?.leases ? liveLeases(snapshot) : editor.leases;
    const changes = snapshot?.data?.projections?.repos ? snapshotCollections(snapshot).changes.items : editor.changes;
    // The snapshot issues projection is the complete list, so an empty
    // one clears stale issues; a missing projection keeps the last list.
    const raw = snapshot?.data?.projections?.issues?.items;
    const issues = snapshot && Array.isArray(raw) ? openIssues(snapshot) : editor.issues;
    const nextEvents = events ? unionEvents(editor.events, events) : editor.events;
    // Polls arrive every second: skip the re-render when nothing the
    // editor shows has changed, and never re-render under a text field
    // (the caret would jump; fresh data applies on the next action).
    const signature = liveSignature(leases, changes, issues, nextEvents);
    if (signature === editor.liveSignature) return;
    editor.liveSignature = signature;
    Object.assign(editor, { leases, changes, issues, events: nextEvents });
    if (!editor.issue || !root.isConnected) return;
    const active = doc().activeElement;
    if (active && root.contains(active) && /^(TEXTAREA|INPUT|SELECT)$/.test(active.tagName)) return;
    preserveFocus(render);
  }

  function close() {
    Object.assign(editor, { repoId: null, number: null, issue: null, draft: null, conflict: null, message: null, error: null });
    root.replaceChildren();
  }

  function saveBody() {
    return {
      expectedVersion: editor.issue.version,
      title: editor.draft.title.trim(),
      body: editor.draft.body,
      labels: parseLabelsInput(editor.draft.labels),
      milestoneId: editor.draft.milestoneId,
      allowedFiles: [...editor.draft.units],
    };
  }

  async function save(retrying = false) {
    if (editor.saving || !editor.issue || !editor.draft) return;
    if (!editor.draft.title.trim()) { setMessage(null, 'Title is required.'); render(); return; }
    editor.saving = true;
    if (!retrying) setMessage('Saving…');
    render();
    try {
      const response = await calls.updateIssue(editor.repoId, editor.number, saveBody(), calls.newKey());
      editor.issue = response?.data ?? editor.issue;
      editor.draft = draftFrom(editor.issue);
      editor.conflict = null;
      setMessage('Saved.');
    } catch (error) {
      if (error?.status === 409 && error?.code === 'STALE_VERSION') {
        try {
          const fresh = await calls.getIssue(editor.repoId, editor.number);
          editor.conflict = { server: fresh?.data ?? null, local: { ...editor.draft } };
          setMessage(null, 'Someone else saved a newer version. Merge below — nothing was overwritten.');
        } catch {
          setMessage(null, 'Save conflicted and the newer version could not be loaded. Reload and retry.');
        }
      } else {
        // 422 and other refusals surface the server's reason verbatim (redacted).
        const refusal = redactError(error);
        setMessage(null, `Save refused (${refusal.code}: ${refusal.message}).`);
      }
    }
    editor.saving = false;
    render();
  }

  function addUnit() {
    const entry = parseUnitEntry(editor.addValue);
    if (entry.kind === 'empty') { setMessage(null, 'Type a file path, “path § Section”, or row key first.'); render(); return; }
    if (editor.draft.units.some(unit => parseUnitEntry(unit).key === entry.key)) {
      setMessage(null, `Already listed: ${entry.key}`); render(); return;
    }
    editor.draft.units.push(entry.key);
    editor.addValue = '';
    setMessage('Unit added. Save to persist it.');
    render();
  }

  function removeUnit(key) {
    editor.draft.units = editor.draft.units.filter(unit => unit !== key);
    setMessage('Unit removed. Save to persist it.');
    render();
  }

  function renderTabs(host) {
    const tabs = [['write', 'Write'], ['preview', 'Preview'], ['agent', 'What the agent sees']];
    const list = el('div', null, 'issue-tabs');
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', 'Spec view');
    for (const [id, label] of tabs) {
      const button = el('button', label);
      button.type = 'button';
      button.id = `issue-tab-${id}`;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(editor.tab === id));
      button.addEventListener('click', () => { editor.tab = id; preserveFocus(render); });
      list.append(button);
    }
    host.append(list);
    if (editor.tab === 'write') {
      const label = el('label', 'Spec', 'offscreen');
      label.htmlFor = 'issue-body';
      const area = doc().createElement('textarea');
      area.id = 'issue-body';
      area.value = editor.draft.body;
      area.addEventListener('input', () => { editor.draft.body = area.value; });
      host.append(label, area);
    } else if (editor.tab === 'preview') {
      const preview = el('div', null, 'issue-preview');
      preview.innerHTML = renderMarkdown(editor.draft.body);
      host.append(preview);
    } else {
      const note = el('p', 'Exactly what an agent fetches for this issue. Read-only.', 'muted');
      const pre = el('pre', agentSpecText(editor.issue, milestoneTitle(editor, editor.issue.milestoneId)), 'evidence');
      pre.id = 'issue-agent-view';
      host.append(note, pre);
    }
  }

  function renderUnits(host) {
    host.append(el('h2', 'What the agent may touch'));
    host.append(el('p', 'Claimed all at once when an agent starts. Only live leases say free or held.', 'muted'));
    const rows = el('div', null, 'issue-units');
    if (!editor.draft.units.length) rows.append(el('p', 'No units declared. Agents cannot claim work from this issue until some are saved.', 'muted'));
    editor.draft.units.forEach((key, index) => {
      const entry = parseUnitEntry(key);
      const live = unitLeaseState(entry, editor.leases);
      const row = el('div', null, 'issue-unit');
      row.append(el('code', entry.label));
      row.append(el('span', kindLabel(entry.kind), 'unit-kind'));
      const note = live.state === 'held'
        ? live.holders.map(holder => `held by ${holder.holderId ?? 'unknown'}${holder.issueNumber ? ` · issue #${holder.issueNumber}` : ''}${holder.changeId ? ` · change ${holder.changeId}` : ''}`).join('; ')
        : entry.kind === 'unknown'
          ? 'The server decides at claim time (UNKNOWN_UNIT when unregistered).'
          : 'free · no live lease covers it';
      const tone = live.state === 'held' ? 'tone-amber' : entry.kind === 'unknown' ? 'tone-red' : 'tone-green';
      row.append(el('span', note, tone));
      const remove = el('button', '✕');
      remove.type = 'button';
      remove.id = `issue-remove-${index}-${key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
      remove.setAttribute('aria-label', `Remove ${key}`);
      remove.addEventListener('click', () => removeUnit(key));
      row.append(remove);
      rows.append(row);
    });
    host.append(rows);
    const label = el('label', 'Add a file, section or row', 'offscreen');
    label.htmlFor = 'issue-addunit';
    const input = doc().createElement('input');
    input.id = 'issue-addunit';
    input.value = editor.addValue;
    input.placeholder = 'Add a file, § section or row…  e.g. docs/architecture.md § Storage and time';
    input.addEventListener('input', () => { editor.addValue = input.value; });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addUnit(); } });
    const add = el('button', 'Add', 'primary');
    add.type = 'button';
    add.id = 'issue-add';
    add.addEventListener('click', addUnit);
    const form = el('div', null, 'issue-addrow');
    form.append(label, input, add);
    host.append(form);
  }

  function renderDetails(host) {
    host.append(el('h2', 'Details'));
    const grid = el('div', null, 'issue-details');
    const milestoneLabel = el('label', 'Milestone');
    const select = doc().createElement('select');
    select.id = 'issue-milestone';
    const none = el('option', 'No milestone');
    none.value = '';
    select.append(none);
    for (const milestone of editor.milestones) {
      const option = el('option', milestone?.title ?? milestone?.milestoneId);
      option.value = milestone?.milestoneId;
      select.append(option);
    }
    select.value = editor.draft.milestoneId ?? '';
    select.addEventListener('change', () => { editor.draft.milestoneId = select.value || null; });
    milestoneLabel.append(select);
    grid.append(milestoneLabel);
    const labelsLabel = el('label', 'Labels (comma separated)');
    const labels = doc().createElement('input');
    labels.id = 'issue-labels';
    labels.value = editor.draft.labels;
    labels.addEventListener('input', () => { editor.draft.labels = labels.value; });
    labelsLabel.append(labels);
    grid.append(labelsLabel);
    const priorityLabel = el('label', 'Priority');
    const priority = doc().createElement('select');
    priority.disabled = true;
    priority.title = 'The issues API has no priority field; milestones and labels carry scheduling instead.';
    priority.append(el('option', 'Normal'));
    priorityLabel.append(priority, el('small', 'Not stored: the issues API has no priority field.', 'muted'));
    grid.append(priorityLabel);
    const dependsLabel = el('label', 'Depends on');
    const linked = Array.isArray(editor.issue?.changes) ? editor.issue.changes : [];
    const matched = linked.filter(change => editor.changes.some(candidate => candidate?.changeId === change?.changeId));
    const deps = [...new Set(matched.flatMap(change =>
      editor.changes.find(candidate => candidate?.changeId === change?.changeId)?.dependencyChangeIds ?? []))];
    const depends = doc().createElement('input');
    depends.disabled = true;
    depends.title = 'The issues API has no dependency field; linked changes carry queue dependencies instead.';
    const missing = linked.length - matched.length;
    const parts = [];
    if (deps.length) parts.push(deps.join(', '));
    if (missing > 0) parts.push(`(+${missing} linked change${missing === 1 ? '' : 's'} not in snapshot)`);
    depends.value = parts.join(' ') || '—';
    dependsLabel.append(depends, el('small', 'Read-only: from linked changes, not stored on the issue.', 'muted'));
    grid.append(dependsLabel);
    host.append(grid);
  }

  function renderOverlaps(host) {
    host.append(el('h2', 'Overlaps with other open work'));
    // Draft units: shows the effect of unsaved edits before any agent starts.
    const overlaps = issueOverlaps({ ...editor.issue, allowedFiles: editor.draft.units }, editor.issues);
    if (!overlaps.length) {
      host.append(el('p', editor.draft.units.length
        ? 'No other open issue declares the same units.'
        : 'Declare units above to compare with other open work.', 'muted'));
      return;
    }
    const list = el('ul', null, 'issue-overlaps');
    for (const overlap of overlaps) {
      const item = el('li');
      item.append(el('strong', `#${overlap.number} ${overlap.title}`));
      item.append(el('p', overlap.explanation));
      list.append(item);
    }
    host.append(list);
  }

  function renderTimeline(host) {
    host.append(el('h2', 'Timeline'));
    const entries = issueTimeline(editor.number, editor.issue?.changes, editor.events);
    if (!entries.length) {
      host.append(el('p', 'No observed events for this issue or its linked changes yet.', 'muted'));
      return;
    }
    const list = el('ol', null, 'issue-timeline');
    for (const entry of entries) {
      const item = el('li');
      item.append(el('span', entry.kind));
      item.append(el('span', entry.actorId ?? 'unknown', 'muted'));
      item.append(el('span', entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'time unavailable', 'muted'));
      list.append(item);
    }
    host.append(list);
  }

  function renderConflict(host) {
    if (!editor.conflict?.server) return;
    const panel = el('div', null, 'issue-conflict');
    panel.setAttribute('role', 'alert');
    panel.append(el('h2', 'Newer version on the server'));
    panel.append(el('p', `Server version ${editor.conflict.server.version}: “${editor.conflict.server.title}”. Your edits are kept below — choose what wins.`, 'muted'));
    const useServer = el('button', 'Discard mine, use server version');
    useServer.type = 'button';
    useServer.id = 'issue-use-server';
    useServer.addEventListener('click', () => {
      editor.issue = editor.conflict.server;
      editor.draft = draftFrom(editor.issue);
      editor.conflict = null;
      setMessage('Loaded the server version.');
      render();
    });
    const keepMine = el('button', 'Save mine over the server version', 'primary');
    keepMine.type = 'button';
    keepMine.id = 'issue-keep-mine';
    keepMine.addEventListener('click', () => {
      editor.issue = editor.conflict.server;
      editor.draft = { ...editor.conflict.local };
      editor.conflict = null;
      void save(true);
    });
    panel.append(useServer, keepMine);
    host.append(panel);
  }

  function render() {
    root.replaceChildren();
    if (!editor.issue || !editor.draft) {
      const back = el('button', '← Back', 'quiet');
      back.type = 'button';
      back.id = 'issue-back';
      back.addEventListener('click', () => hooks.onBack?.());
      root.append(back);
      if (editor.error) root.append(el('p', editor.error, 'issue-error'));
      else root.append(el('p', editor.message ?? 'Loading issue…', 'muted'));
      return;
    }
    const crumbs = el('p', null, 'issue-crumbs');
    const back = el('button', '← Back', 'quiet');
    back.type = 'button';
    back.id = 'issue-back';
    back.addEventListener('click', () => hooks.onBack?.());
    crumbs.append(back, el('span', `Issue #${editor.number} · ${editor.issue.state} · version ${editor.issue.version}`));
    root.append(crumbs);
    renderConflict(root);

    const titleLabel = el('label', 'Title');
    titleLabel.htmlFor = 'issue-title';
    const title = doc().createElement('input');
    title.id = 'issue-title';
    title.value = editor.draft.title;
    title.addEventListener('input', () => { editor.draft.title = title.value; });
    root.append(titleLabel, title);

    const spec = el('section', null, 'issue-card');
    spec.setAttribute('aria-label', 'Spec');
    renderTabs(spec);
    root.append(spec);

    const units = el('section', null, 'issue-card');
    units.setAttribute('aria-label', 'Units this issue may touch');
    renderUnits(units);
    root.append(units);

    const details = el('section', null, 'issue-card');
    details.setAttribute('aria-label', 'Details');
    renderDetails(details);
    root.append(details);

    const overlaps = el('section', null, 'issue-card issue-overlaps-panel');
    overlaps.setAttribute('aria-label', 'Overlaps');
    renderOverlaps(overlaps);
    root.append(overlaps);

    const timeline = el('section', null, 'issue-card');
    timeline.setAttribute('aria-label', 'Timeline');
    renderTimeline(timeline);
    root.append(timeline);

    const bar = el('div', null, 'issue-savebar');
    const saveButton = el('button', editor.saving ? 'Saving…' : 'Save changes', 'primary');
    saveButton.type = 'button';
    saveButton.id = 'issue-save';
    saveButton.disabled = editor.saving;
    saveButton.addEventListener('click', () => save());
    bar.append(saveButton);
    const status = el('p', editor.error ?? editor.message ?? '', editor.error ? 'issue-error' : 'muted');
    status.setAttribute('role', 'status');
    status.id = 'issue-status';
    bar.append(status);
    root.append(bar);
    if (typeof hooks.onRender === 'function') hooks.onRender(editor);
  }

  return { open, close, setLive, render, state: editor };
}
