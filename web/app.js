/**
 * Concord fleet coordination UI.
 *
 * One static page over the frozen snapshot/events contract. Every panel
 * renders fetched backend data; fixture or invented outcomes are never used.
 * Feature slices that have not landed report MODULE_UNAVAILABLE and render
 * as explicit unavailable states.
 *
 * - Session token: entered once, kept in api.js module memory only.
 * - Poll: incremental GET events every second; snapshot refresh on version
 *   movement, on demand, and after every mutation outcome (including 409).
 * - Re-renders preserve the selected change, focused control, and scroll.
 * - All untrusted text (intents, errors, OIDs) is set via textContent only.
 */
import {
  allowedActions, clearSessionToken, claimUnits, enqueueChange, getEvents,
  getHealth, getSnapshot, hasToken, isForbidden, isStaleConflict, isUnavailable,
  listRepos, newIdempotencyKey, redactError, setSessionToken, submitVerdict,
  withdrawChange,
} from './api.js';
import {
  activeElementId, captureScroll, changeNextAction, describeBisection,
  environmentBadge, leaseCountdown, panelCopy, projectionItems, repairStatus,
  restoreFocus, restoreScroll, safeText, snapshotCollections, mutationEvidence, verdictProvenance,
} from './views.js';

const $ = (id) => document.getElementById(id);

const state = {
  repos: [],
  repoId: null,
  snapshot: null,
  snapshotCurrent: false,
  version: 0,
  observedVersion: 0,
  eventSeq: 0,
  lastEventSeq: 0,
  selectedChangeId: null,
  connected: true,
  failCount: 0,
  pollCount: 0,
  sessionGeneration: 0,
  repoGeneration: 0,
  evidenceEvents: new Map(),
};

function generation() {
  return { session: state.sessionGeneration, repo: state.repoGeneration, repoId: state.repoId };
}

function current(g) {
  return g.session === state.sessionGeneration && g.repo === state.repoGeneration;
}

function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = safeText(text);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'tabIndex') node.tabIndex = value;
    else node.setAttribute(key, value);
  }
  return node;
}

function setStatus(message) {
  $('mutation-status').textContent = safeText(message);
}

function showSessionError(info) {
  const box = $('session-error');
  if (!info) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.textContent = info;
}

function emptyInto(container, kind) {
  container.replaceChildren();
  const copy = panelCopy(kind);
  const item = el('li', '', { class: 'card' });
  item.append(el('strong', copy.title), el('p', copy.hint, { class: 'muted' }));
  container.append(item);
}

function markDisconnected(container, listId) {
  const containerEl = typeof container === 'string' ? $(container) : container;
  containerEl.replaceChildren();
  const copy = panelCopy('disconnected');
  const item = el('li', '', { class: 'card' });
  item.append(el('strong', copy.title), el('p', copy.hint, { class: 'muted' }));
  containerEl.append(item);
  void listId;
}

// --- Environment badge ---

async function refreshBadge() {
  const g = generation();
  const badge = $('env-badge');
  try {
    const body = await getHealth();
    if (!current(g)) return;
    const data = body && body.data ? body.data : {};
    const badgeInfo = environmentBadge(data, false);
    badge.textContent = `Backend: ${badgeInfo.label} — ${badgeInfo.detail}`;
  } catch {
    if (!current(g)) return;
    const badgeInfo = environmentBadge(null, false);
    badge.textContent = `Backend: ${badgeInfo.label} — ${badgeInfo.detail}`;
  }
}

// --- Repo switcher ---

async function refreshRepos() {
  const g = generation();
  const select = $('repo-select');
  const currentRepo = state.repoId;
  let items = [];
  try {
    const body = await listRepos();
    if (!current(g)) return false;
    const page = body && body.data ? body.data : {};
    items = Array.isArray(page.items) ? page.items : [];
    state.repos = items;
    showSessionError(null);
  } catch (error) {
    if (!current(g)) return false;
    state.repos = [];
    const redacted = redactError(error);
    showSessionError(isForbidden(error) ? `Repository catalog authentication failed (${redacted.code}). Check the session token.` : `Repository catalog failed (${redacted.code}). Retry by entering a token.`);
  }
  select.replaceChildren();
  if (items.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = $('session-error').hidden ? 'No repos listed — enter a repo ID' : 'Repository catalog unavailable';
    select.append(option);
  } else {
    for (const repo of items) {
      const option = document.createElement('option');
      option.value = repo.repoId ?? repo.displayName ?? '';
      option.textContent = safeText(repo.displayName ?? repo.repoId ?? 'unnamed repo');
      select.append(option);
    }
  }
  if (currentRepo) {
    const match = [...select.options].find(o => o.value === currentRepo);
    if (match) select.value = currentRepo;
    else state.repoId = items.length > 0 ? select.value : null;
  }
  if (!state.repoId && items.length > 0) {
    state.repoId = select.value;
  }
  return true;
}

function currentRoles() {
  return [$('role-select').value];
}

function refreshAffordances() {
  const actions = allowedActions(currentRoles());
  const authed = hasToken();
  const evidenceReady = authed && state.connected && state.snapshotCurrent;
  // No identity/roles endpoint exists in v1. A chosen role is an unverified intent.
  $('claim-form').hidden = !(authed && actions.claim);
  $('enqueue-form').hidden = !(authed && (actions.enqueue));
  $('verdict-form').hidden = !(authed && actions.verdict);
  for (const button of [$('claim-form').querySelector('button'), $('enqueue-submit'), $('withdraw-submit'), $('verdict-form').querySelector('button')]) {
    button.disabled = !evidenceReady;
  }
  $('token-state').textContent = authed ? 'Token stored in memory.' : 'No token stored.';
  const note = $('mutation-note');
  if (!authed) note.textContent = 'Enter a session token to enable mutation controls. Viewers browse without them.';
  else if (!state.connected) note.textContent = 'Disconnected: mutation controls are disabled until reconnect.';
  else if (!state.snapshotCurrent) note.textContent = 'Current snapshot evidence is unavailable. Refresh before acting; mutation controls are disabled.';
  else if (!actions.claim && !actions.enqueue && !actions.verdict) {
    note.textContent = 'Viewer mode: browse only. Credential roles are not verified by this page.';
  } else {
    note.textContent = 'Requested role is unverified. The server decides whether this credential may act. Mutations use current snapshot evidence.';
  }
}

// --- Snapshot + events polling ---

function projections() {
  const data = state.snapshot && state.snapshot.data ? state.snapshot.data : {};
  return data.projections && typeof data.projections === 'object' ? data.projections : {};
}

function selectedChange() {
  return snapshotCollections(state.snapshot).changes.items.find(change => change?.changeId === state.selectedChangeId);
}

async function refreshSnapshot(g = generation()) {
  if (!g.repoId || !current(g)) return false;
  const body = await getSnapshot(g.repoId);
  if (!current(g)) return false;
  if (Number.isSafeInteger(body?.version) && body.version < state.observedVersion) return false;
  state.snapshot = body;
  state.snapshotCurrent = Number.isSafeInteger(body?.version) && body.version >= 0;
  if (state.snapshotCurrent) {
    state.version = body.version;
    state.observedVersion = Math.max(state.observedVersion, body.version);
  }
  if (body && typeof body.eventSeq === 'number') {
    state.eventSeq = Math.max(state.eventSeq, body.eventSeq);
  }
  refreshAffordances();
  return true;
}

function appendEvents(items) {
  const log = $('event-log');
  for (const event of items) {
    if (Array.isArray(event.relatedIds)) {
      for (const id of event.relatedIds) if (typeof id === 'string') state.evidenceEvents.set(id, event);
    }
  }
  for (const event of items.slice(-100)) {
    const line = el('li', `#${event.sequence} ${event.kind} by ${event.actorId} (v${event.version})`);
    line.id = `event-${event.sequence}`;
    line.dataset.relatedIds = JSON.stringify(event.relatedIds ?? []);
    log.append(line);
  }
  while (log.children.length > 100) log.firstChild.remove();
}

async function pollOnce(g = generation()) {
  if (!g.repoId || !current(g)) return;
  let moved = false;
  let received = false;
  while (current(g)) {
    const previousSeq = state.lastEventSeq;
    const body = await getEvents(g.repoId, state.lastEventSeq);
    if (!current(g)) return;
    const page = body && body.data ? body.data : {};
    const items = Array.isArray(page.items) ? page.items : [];
    const last = items.at(-1)?.sequence;
    if (Number.isSafeInteger(last) && last > state.lastEventSeq) {
      state.lastEventSeq = last;
      appendEvents(items);
      received = true;
    }
    if (body && typeof body.eventSeq === 'number') state.eventSeq = Math.max(state.eventSeq, body.eventSeq);
    if (Number.isSafeInteger(body?.version)) state.observedVersion = Math.max(state.observedVersion, body.version);
    if (body && typeof body.version === 'number' && body.version !== state.version) {
      moved = true;
      state.snapshotCurrent = false;
      refreshAffordances();
    }
    // Follow pages until the announced head, but stop on a non-advancing page.
    if (!Number.isSafeInteger(last) || last >= state.eventSeq || last <= previousSeq) break;
  }
  if (moved && !await refreshSnapshot(g)) return;
  if (current(g) && (moved || received)) renderAll();
}

async function tick() {
  const g = generation();
  if (!g.repoId) return;
  state.pollCount += 1;
  try {
    await pollOnce(g);
    if (!current(g)) return;
    // Periodic full refresh keeps slow-moving projections honest.
    if (state.pollCount % 10 === 0) {
      if (!await refreshSnapshot(g)) return;
      renderAll();
    }
    if (!state.connected) {
      state.connected = true;
      refreshAffordances();
      showSessionError(null);
      renderAll();
    }
    state.failCount = 0;
  } catch (error) {
    if (!current(g)) return;
    state.failCount += 1;
    if (state.failCount >= 3 && state.connected) {
      state.connected = false;
      refreshAffordances();
      const redacted = redactError(error);
      showSessionError(`Disconnected: ${redacted.code} — browsing last snapshot; mutations disabled until reconnect.`);
      ['lease-list', 'change-list', 'queue-list', 'runner-list'].forEach(id => markDisconnected(id));
    }
  }
}

// --- Renderers (textContent only; no innerHTML anywhere) ---

function findById(items, id, keys) {
  return items.find(item => keys.some(key => item && item[key] === id));
}

function stateBadge(status) {
  return el('span', status ?? 'unknown', { class: 'state' });
}

function renderLeases() {
  const list = $('lease-list');
  const { state: kind, items } = projectionItems(projections().leases);
  if (kind === 'unavailable') return emptyInto(list, 'unavailable');
  if (kind === 'unknown') return emptyInto(list, 'unknown');
  if (items.length === 0) return emptyInto(list, 'empty');
  list.replaceChildren();
  const now = Date.now();
  for (const lease of items) {
    const card = el('li', '', { class: 'card' });
    if (lease.leaseId) card.id = `lease-${encodeURIComponent(lease.leaseId)}`;
    const countdown = leaseCountdown(lease, now);
    card.append(stateBadge(lease.state), el('strong', lease.unitKey ?? 'unknown unit'));
    const facts = el('dl');
    const addFact = (term, value) => { facts.append(el('dt', term), el('dd', value)); };
    addFact('Holder:', lease.holderId ?? 'unknown');
    addFact('Intent:', lease.intentText ?? 'no intent recorded');
    addFact('Change:', lease.changeId ?? 'unlinked');
    addFact('Fence:', String(lease.fence ?? '?'));
    addFact('Expires:', countdown.text);
    card.append(facts);
    card.append(el('p', countdown.expired ? 'Next: re-acquire the unit or pick another.' : 'Next: renew before expiry; expiry invalidates the old fence.', { class: 'next' }));
    list.append(card);
  }
}

function changeContext(change) {
  const projs = projections();
  const leases = projectionItems(projs.leases).items;
  const queue = projectionItems(projs.queue).items;
  const conflict = leases.find(l => l && l.holderId && l.changeId !== change.changeId &&
    (change.unitKeys ?? []).includes(l.unitKey) && (l.state === 'active' || l.state === 'reserved'));
  const queueEntry = queue.find(e => e && e.changeId === change.changeId);
  return {
    leases,
    leaseConflict: conflict ? { holderId: conflict.holderId, intentText: conflict.intentText, unitKeys: [conflict.unitKey] } : null,
    queueEntry,
    verdictGate: null,
    findingsGate: null,
  };
}

function renderChanges() {
  const list = $('change-list');
  const { state: kind, items } = snapshotCollections(state.snapshot).changes;
  if (kind === 'unavailable' || kind === 'unknown') return emptyInto(list, kind === 'unavailable' ? 'unavailable' : 'unknown');
  if (items.length === 0) return emptyInto(list, 'empty');
  const selected = state.selectedChangeId;
  list.replaceChildren();
  items.forEach((change, index) => {
    const action = changeNextAction(change, changeContext(change));
    const card = el('li', '', {
      class: 'card', role: 'option', id: `change-${change.changeId ?? index}`,
      'aria-selected': change.changeId === selected ? 'true' : 'false', tabindex: '-1',
    });
    card.dataset.changeId = change.changeId ?? '';
    card.append(stateBadge(change.status), el('strong', change.intentText || change.intentKey || 'untitled change'));
    const facts = el('dl');
    const addFact = (term, value) => { facts.append(el('dt', term), el('dd', value)); };
    addFact('Agent:', change.authorId ?? 'unknown');
    addFact('Units:', (change.unitKeys ?? []).join(', ') || 'none declared');
    addFact('Revision:', `r${change.revision ?? '?'} @ ${change.headOid ?? 'no head'}`);
    card.append(facts);
    const next = el('p', '', { class: 'next' });
    next.append(el('strong', `Next: ${action.label} — `), document.createTextNode(action.detail));
    card.append(next);
    card.addEventListener('click', () => selectChange(change.changeId));
    list.append(card);
  });
  if (selected && !findById(items, selected, ['changeId'])) {
    // Selected change left the projection: keep the id but say so honestly.
    renderDetailUnknown(selected);
  } else if (selected) {
    renderDetail(findById(items, selected, ['changeId']));
  }
}

function renderDetail(change) {
  const body = $('detail-body');
  body.replaceChildren();
  if (!change) {
    body.append(el('p', 'No change selected.'));
    return;
  }
  const action = changeNextAction(change, changeContext(change));
  body.append(el('h3', change.intentText || change.intentKey || 'Untitled change'));
  const facts = el('dl');
  const addFact = (term, value) => { facts.append(el('dt', term), el('dd', value)); };
  addFact('Change:', change.changeId ?? '?');
  addFact('Agent:', change.authorId ?? 'unknown');
  addFact('Units:', (change.unitKeys ?? []).join(', ') || 'none declared');
  addFact('State:', change.status ?? 'unknown');
  addFact('Base:', change.baseOid ?? 'none (seed draft)');
  addFact('Head:', change.headOid ?? 'no head yet');
  body.append(facts);
  const next = el('p', '', { class: 'next' });
  next.append(el('strong', `Next: ${action.label} — `), document.createTextNode(action.detail));
  body.append(next);
  if (action.kind === 'conflict' && action.holderId) {
    const lease = changeContext(change).leases.find(l => l?.holderId === action.holderId && action.conflictingKeys.includes(l.unitKey));
    const line = el('p', 'Lease holder: ', { class: 'next' });
    if (lease?.leaseId) line.append(el('a', action.holderId, { href: `#lease-${encodeURIComponent(lease.leaseId)}` }));
    else line.append(document.createTextNode(action.holderId));
    body.append(line);
  }
}

function renderDetailUnknown(selectedId) {
  const body = $('detail-body');
  body.replaceChildren();
  body.append(el('p', `Change ${selectedId} is no longer in the live projection; keeping the selection while it is gone.`));
}

function renderFindings() {
  const list = $('finding-list');
  const projs = projections();
  const findings = projectionItems(projs.findings);
  const repairs = snapshotCollections(state.snapshot).repairs;
  if (findings.state === 'unavailable') return emptyInto(list, 'unavailable');
  if (findings.state === 'unknown') return emptyInto(list, 'unknown');
  if (repairs.state === 'unknown') return emptyInto(list, 'unknown');
  const scoped = state.selectedChangeId
    ? findings.items.filter(f => f && f.changeId === state.selectedChangeId)
    : findings.items;
  const rounds = state.selectedChangeId
    ? repairs.items.filter(round => round && round.changeId === state.selectedChangeId)
    : repairs.items;
  const status = repairStatus(scoped, rounds);
  list.replaceChildren();
  const summary = el('li', '', { class: 'card' });
  summary.append(el('strong', `Repair state: ${status.status} — `), document.createTextNode(status.summary));
  list.append(summary);
  if (scoped.length === 0) {
    const item = el('li', '', { class: 'card' });
    item.append(el('p', state.selectedChangeId ? 'No findings for the selected change.' : 'No open findings.', { class: 'muted' }));
    list.append(item);
    return;
  }
  for (const finding of scoped) {
    const card = el('li', '', { class: 'card' });
    card.append(stateBadge(finding.status), el('strong', finding.findingId ?? 'finding'));
    const facts = el('dl');
    const addFact = (term, value) => { facts.append(el('dt', term), el('dd', value)); };
    addFact('Unit:', finding.unitKey ?? '?');
    addFact('Origin revision:', `r${finding.originRevision ?? '?'}`);
    addFact('Text:', finding.text ?? '');
    card.append(facts);
    list.append(card);
  }
}

function renderVerdicts() {
  const list = $('verdict-list');
  const archive = $('event-evidence');
  archive.replaceChildren();
  const { state: kind, items } = projectionItems(projections().verdicts);
  if (kind === 'unavailable') return emptyInto(list, 'unavailable');
  if (kind === 'unknown') return emptyInto(list, 'unknown');
  const scoped = state.selectedChangeId ? items.filter(v => v && v.changeId === state.selectedChangeId) : items;
  // A parent review must remain in the rendered set for its anchor to resolve.
  for (let i = 0; i < scoped.length; i++) {
    const parent = items.find(v => v?.verdictId === scoped[i]?.parentVerdictId);
    if (parent && !scoped.includes(parent)) scoped.push(parent);
  }
  if (scoped.length === 0) return emptyInto(list, 'empty');
  list.replaceChildren();
  for (const verdict of scoped) {
    const provenance = verdictProvenance(verdict);
    const card = el('li', '', { class: 'card' });
    if (verdict.verdictId) card.id = `verdict-${encodeURIComponent(verdict.verdictId)}`;
    card.append(stateBadge(verdict.decision), el('strong', verdict.verdictId ?? 'verdict'));
    card.append(el('p', provenance.summary));
    if (provenance.kind === 'carried') {
      const line = el('p', '', { class: 'next' });
      line.append(document.createTextNode('Original review: '));
      const parent = items.find(v => v?.verdictId === provenance.parentVerdictId);
      if (parent) line.append(el('a', provenance.parentVerdictId, { href: `#verdict-${encodeURIComponent(provenance.parentVerdictId)}` }));
      else line.append(document.createTextNode(`${provenance.parentVerdictId ?? 'missing'} (record unavailable)`));
      line.append(document.createTextNode('; delta evidence: '));
      const event = state.evidenceEvents.get(provenance.deltaResultId);
      if (event && provenance.deltaResultId) {
        const anchor = `event-${event.sequence}`;
        if (!document.getElementById(anchor)) {
          archive.append(el('li', `#${event.sequence} ${event.kind} by ${event.actorId} (v${event.version})`, { id: anchor }));
        }
        line.append(el('a', provenance.deltaResultId, { href: `#${anchor}` }));
      }
      else line.append(document.createTextNode(`${provenance.deltaResultId ?? 'missing'} (record unavailable)`));
      card.append(line);
    }
    list.append(card);
  }
}

function renderQueue() {
  const list = $('queue-list');
  const tree = $('queue-tree');
  const { state: kind, items } = projectionItems(projections().queue);
  tree.replaceChildren();
  if (kind === 'unavailable') {
    tree.append(el('p', 'Bisection tree: unavailable — the queue slice has not landed.', { class: 'muted' }));
    return emptyInto(list, 'unavailable');
  }
  if (kind === 'unknown') {
    tree.append(el('p', 'Bisection tree: unknown projection shape.', { class: 'muted' }));
    return emptyInto(list, 'unknown');
  }
  const rawQueue = projections().queue;
  const rawDiagnosis = rawQueue && typeof rawQueue === 'object' && !Array.isArray(rawQueue) ? rawQueue.diagnosis : null;
  if (items.length === 0 && !rawDiagnosis) {
    tree.append(el('p', 'Queue empty: no admitted candidates.', { class: 'muted' }));
    return emptyInto(list, 'empty');
  }
  const diagnosis = describeBisection(rawDiagnosis ?? null);
  const headline = el('p', '');
  headline.append(el('strong', `${diagnosis.headline} — `), document.createTextNode(diagnosis.note));
  tree.append(headline);
  if (items.length === 0) return emptyInto(list, 'empty');
  list.replaceChildren();
  const entries = Array.isArray(items) ? items : [];
  for (const entry of entries) {
    const highlighted = diagnosis.highlightIds.includes(entry.changeId);
    const card = el('li', '', { class: 'card' });
    const label = highlighted ? diagnosis.classification === 'SINGLETON' ? ' (isolated)' : diagnosis.classification === 'INTERACTION' ? ' (failing set)' : ' (dependency group)' : '';
    card.append(stateBadge(entry.state), el('strong', `${entry.changeId ?? 'entry'}${label}`));
    const facts = el('dl');
    const addFact = (term, value) => { facts.append(el('dt', term), el('dd', value)); };
    addFact('Revision:', `r${entry.admittedRevision ?? '?'}`);
    addFact('Sequence:', String(entry.sequence ?? '?'));
    addFact('Blocked reason:', entry.blockedReason ?? 'none');
    card.append(facts);
    list.append(card);
  }
}

function renderRunners() {
  const list = $('runner-list');
  const { state: kind, items } = projectionItems(projections().runners);
  if (kind === 'unavailable') return emptyInto(list, 'unavailable');
  if (kind === 'unknown') return emptyInto(list, 'unknown');
  if (items.length === 0) return emptyInto(list, 'empty');
  list.replaceChildren();
  for (const runner of items) {
    const card = el('li', '', { class: 'card' });
    card.append(stateBadge(runner.state), el('strong', `${runner.runnerId ?? 'runner'} (${runner.role ?? '?'})`));
    const facts = el('dl');
    const addFact = (term, value) => { facts.append(el('dt', term), el('dd', value)); };
    addFact('Last seen:', runner.lastSeenAt ? new Date(runner.lastSeenAt).toISOString() : 'never');
    addFact('Active job:', runner.activeJobId ?? 'none');
    card.append(facts);
    list.append(card);
  }
}

function renderTip() {
  const box = $('canonical-tip');
  box.replaceChildren();
  const repos = projectionItems(projections().repos);
  const candidate = repos.items.find(r => r && (r.observedCanonicalOid !== undefined || r.canonicalStorageName !== undefined));
  if (!candidate) {
    const copy = panelCopy(repos.state === 'unavailable' ? 'unavailable' : 'empty');
    box.append(el('strong', `Canonical tip: ${copy.title} — `), document.createTextNode(copy.hint));
    return;
  }
  const facts = el('dl');
  facts.append(el('dt', 'Observed OID:'), el('dd', candidate.observedCanonicalOid ?? 'none yet'));
  facts.append(el('dt', 'Status:'), el('dd', candidate.status ?? 'unknown'));
  box.append(facts);
}

function renderReplay() {
  const box = $('replay-body');
  box.replaceChildren();
  box.append(el('p', 'Historical simulation: unavailable — no replay dataset ships with this view. Recorded aggregates are owner-reported and never computed here.', { class: 'muted' }));
}

function renderAll() {
  // Preserve focus and scroll across the 1s re-render.
  const focusedId = activeElementId(document);
  const scrolled = new Map();
  for (const id of ['lease-list', 'change-list', 'queue-list', 'runner-list', 'finding-list', 'verdict-list', 'event-log']) {
    scrolled.set(id, { top: $(id).scrollTop, left: $(id).scrollLeft });
  }
  renderLeases();
  renderChanges();
  renderQueue();
  renderRunners();
  renderFindings();
  renderVerdicts();
  renderTip();
  renderReplay();
  for (const [id, saved] of scrolled) {
    const node = $(id);
    node.scrollTop = saved.top;
    node.scrollLeft = saved.left;
  }
  restoreScroll($('change-list'), captureScroll($('change-list')));
  restoreFocus(document, focusedId);
}

function selectChange(changeId) {
  state.selectedChangeId = changeId ?? null;
  renderChanges();
  renderFindings();
  renderVerdicts();
  const selected = document.querySelector('#change-list [aria-selected="true"]');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

// --- Mutations: real routes, idempotency keys, expected versions ---

async function runMutation(label, call) {
  const g = generation();
  if (!state.connected) {
    setStatus('Disconnected: mutation disabled until reconnect.');
    return;
  }
  if (!hasToken()) {
    setStatus('Enter a session token first.');
    return;
  }
  setStatus(`${label}…`);
  try {
    await call();
    if (!current(g)) return;
    state.snapshotCurrent = false;
    refreshAffordances();
    try {
      if (!await refreshSnapshot(g)) {
        if (current(g)) setStatus(`${label}: accepted; current snapshot unavailable. Refresh before acting again.`);
        return;
      }
      renderAll();
      setStatus(`${label}: accepted.`);
    } catch (refreshError) {
      if (!current(g)) return;
      const redacted = redactError(refreshError);
      setStatus(`${label}: accepted; snapshot refresh failed (${redacted.code}). Refresh before acting again.`);
    }
  } catch (error) {
    if (!current(g)) return;
    if (isStaleConflict(error)) {
      // Stale 409: refresh context, never pretend success.
      state.snapshotCurrent = false;
      refreshAffordances();
      try {
        if (!await refreshSnapshot(g)) {
          if (current(g)) setStatus(`${label}: stale context (409 ${error.code}); current snapshot unavailable. Refresh before acting.`);
          return;
        }
        renderAll();
        setStatus(`${label}: stale context (409 ${error.code}). Refreshed — review the new state and retry.`);
      } catch (refreshError) {
        if (!current(g)) return;
        const redacted = redactError(refreshError);
        setStatus(`${label}: stale context (409 ${error.code}); refresh failed (${redacted.code}). Retry refresh before acting.`);
      }
    } else {
      // Every failed mutation also invalidates the context until refreshed.
      state.snapshotCurrent = false;
      refreshAffordances();
      try {
        if (await refreshSnapshot(g) && current(g)) renderAll();
      } catch { /* Keep controls disabled and report the original failure. */ }
      if (!current(g)) return;
      reportMutationFailure(label, error);
    }
  }
}

function reportMutationFailure(label, error) {
  if (error?.code === 'LEASE_CONFLICT') {
    const d = error.details;
    const status = $('mutation-status');
    status.replaceChildren(document.createTextNode(`${label}: lease conflict. `));
    if (d?.holderId) {
      const lease = projectionItems(projections().leases).items.find(l => l?.holderId === d.holderId && d.conflictingKeys?.includes(l.unitKey));
      if (lease?.leaseId) status.append(el('a', d.holderId, { href: `#lease-${encodeURIComponent(lease.leaseId)}` }));
      else status.append(document.createTextNode(d.holderId));
    } else status.append(document.createTextNode('Holder unknown'));
    status.append(document.createTextNode(`; intent: ${d?.intentText ?? 'unknown'}; expires: ${d?.expiresAt ? new Date(d.expiresAt).toLocaleString() : 'unknown'}; units: ${d?.conflictingKeys?.join(', ') || 'unknown'}.`));
  } else if (isUnavailable(error)) {
    setStatus(`${label}: unavailable — the owning feature slice has not landed (MODULE_UNAVAILABLE).`);
  } else if (isForbidden(error)) {
    setStatus(`${label}: refused (${error.status} ${error.code}). This credential lacks the required role; the server enforces it.`);
  } else {
    const redacted = redactError(error);
    setStatus(`${label}: failed (${redacted.code}). Request ${redacted.requestId ?? 'unlogged'}; details redacted. Retry is safe with a fresh key.`);
  }
}

function parseUnitKeys(raw) {
  const keys = raw.split(',').map(s => s.trim());
  return keys.some(key => !key) ? [] : [...new Set(keys)];
}

function requireSnapshot(label) {
  if (state.snapshotCurrent) return true;
  setStatus(`${label}: current snapshot evidence is unavailable. Refresh before acting.`);
  return false;
}

function wireMutations() {
  $('claim-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!requireSnapshot('Claim')) return;
    const unitKeys = parseUnitKeys($('claim-units').value);
    const intentText = $('claim-intent').value.trim();
    const change = selectedChange();
    if (typeof change?.changeId !== 'string' || !change.changeId.trim()) {
      setStatus('Claim needs a selected change from the current snapshot.');
      return;
    }
    if (unitKeys.length === 0 || unitKeys.length > 16 || !intentText) {
      setStatus('Claim needs 1–16 unit keys and intent text.');
      return;
    }
    if (!Array.isArray(change.unitKeys) || !unitKeys.every(key => change.unitKeys.includes(key))) {
      setStatus('Claim: selected change unit keys are unavailable or do not include the requested units.');
      return;
    }
    const body = {
      changeId: change.changeId,
      unitKeys,
      intentText,
    };
    void runMutation('Claim', () => claimUnits(state.repoId, body, newIdempotencyKey()));
  });
  $('enqueue-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!requireSnapshot('Enqueue')) return;
    const verdictId = $('enqueue-verdict').value.trim();
    if (!state.selectedChangeId || !verdictId) {
      setStatus('Enqueue needs the selected change and a verdict ID.');
      return;
    }
    if (!Number.isSafeInteger(state.snapshot?.version) || state.snapshot.version < 0) return setStatus('Enqueue: current repo version is unavailable.');
    const change = selectedChange();
    const evidence = mutationEvidence(change, projectionItems(projections().leases).items, snapshotCollections(state.snapshot).findingSetVersions?.[change?.changeId]);
    if (evidence.error) return setStatus(`Enqueue: ${evidence.error}`);
    const verdict = projectionItems(projections().verdicts).items.find(item => item?.verdictId === verdictId && item.changeId === change.changeId &&
      item.decision === 'approve' && item.revision === evidence.revision && item.findingSetVersion === evidence.findingSetVersion);
    if (!verdict) return setStatus('Enqueue: approved verdict evidence for this change and revision is unavailable.');
    const body = { changeId: change.changeId, expectedVersion: state.version, verdictId, leaseFences: evidence.leaseFences };
    void runMutation('Enqueue', () => enqueueChange(state.repoId, body, newIdempotencyKey()));
  });
  $('withdraw-submit').addEventListener('click', () => {
    if (!requireSnapshot('Withdraw')) return;
    const change = selectedChange();
    if (typeof change?.changeId !== 'string' || !change.changeId.trim()) {
      setStatus('Withdraw needs a selected change from the current snapshot.');
      return;
    }
    if (!Number.isSafeInteger(state.snapshot?.version) || state.snapshot.version < 0) return setStatus('Withdraw: current repo version is unavailable.');
    const body = { changeId: change.changeId, expectedVersion: state.version, reason: 'withdrawn from UI' };
    void runMutation('Withdraw', () => withdrawChange(state.repoId, body, newIdempotencyKey()));
  });
  $('verdict-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!requireSnapshot('Verdict')) return;
    if (!state.selectedChangeId) {
      setStatus('Verdict needs the selected change.');
      return;
    }
    if (!Number.isSafeInteger(state.snapshot?.version) || state.snapshot.version < 0) return setStatus('Verdict: current repo version is unavailable.');
    const change = selectedChange();
    const evidence = mutationEvidence(change, projectionItems(projections().leases).items, snapshotCollections(state.snapshot).findingSetVersions?.[change?.changeId], false);
    if (evidence.error) return setStatus(`Verdict: ${evidence.error}`);
    const body = {
      expectedVersion: state.version,
      revision: evidence.revision,
      reviewManifestDigest: $('verdict-manifest').value.trim(),
      findingSetVersion: evidence.findingSetVersion,
      decision: $('verdict-decision').value,
      evidenceDigest: $('verdict-evidence').value.trim(),
    };
    if (!body.reviewManifestDigest || !body.evidenceDigest || !['approve', 'reject'].includes(body.decision)) {
      return setStatus('Verdict: decision and both evidence digests are required.');
    }
    void runMutation('Verdict', () => submitVerdict(state.repoId, change.changeId, body, newIdempotencyKey()));
  });
}

// --- Session + keyboard wiring ---

function wireSession() {
  $('token-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    state.sessionGeneration += 1;
    state.repoGeneration += 1;
    const value = $('token-input').value;
    $('token-input').value = '';
    if (!value) {
      clearSessionToken();
    } else {
      setSessionToken(value);
    }
    state.repoId = null;
    clearSnapshot();
    setStatus('');
    refreshAffordances();
    showSessionError(null);
    void refreshBadge();
    if (hasToken()) {
      if (!await refreshRepos()) return;
      if (state.repoId) await switchRepo(state.repoId);
      else renderAll();
    } else {
      state.repoId = null;
      $('repo-select').replaceChildren(el('option', 'Enter a session token to list repos'));
      renderAll();
    }
  });
  $('token-clear').addEventListener('click', () => {
    state.sessionGeneration += 1;
    state.repoGeneration += 1;
    clearSessionToken();
    $('token-input').value = '';
    for (const id of ['repo-custom', 'claim-units', 'claim-intent', 'enqueue-verdict', 'verdict-manifest', 'verdict-evidence']) $(id).value = '';
    refreshAffordances();
    clearSnapshot();
    setStatus('');
    state.repoId = null;
    $('repo-select').replaceChildren(el('option', 'Enter a session token to list repos'));
    showSessionError(null);
    void refreshBadge();
    renderAll();
  });
  $('role-select').addEventListener('change', refreshAffordances);
  $('repo-select').addEventListener('change', () => {
    if ($('repo-select').value) void switchRepo($('repo-select').value);
  });
  $('repo-use').addEventListener('click', () => {
    const custom = $('repo-custom').value.trim();
    if (custom) void switchRepo(custom);
  });
}

function clearSnapshot() {
  state.repos = [];
  state.snapshot = null;
  state.snapshotCurrent = false;
  state.version = 0;
  state.observedVersion = 0;
  state.eventSeq = 0;
  state.lastEventSeq = 0;
  state.selectedChangeId = null;
  state.connected = true;
  state.failCount = 0;
  state.pollCount = 0;
  state.evidenceEvents.clear();
  $('event-log').replaceChildren();
  $('event-evidence').replaceChildren();
  $('detail-body').replaceChildren(el('p', 'No change selected.'));
  refreshAffordances();
}

async function switchRepo(repoId) {
  state.repoGeneration += 1;
  state.repoId = repoId;
  clearSnapshot();
  const g = generation();
  void refreshBadge();
  renderLoading();
  try {
    if (!await refreshSnapshot(g)) return;
    await pollOnce(g).catch(() => {});
    if (!current(g)) return;
    renderAll();
    showSessionError(null);
  } catch (error) {
    if (!current(g)) return;
    const redacted = redactError(error);
    showSessionError(`Snapshot failed: ${redacted.code} — ${redacted.message}`);
    renderAll();
  }
}

function wireKeyboard() {
  $('change-list').addEventListener('keydown', (event) => {
    const options = [...document.querySelectorAll('#change-list [role="option"]')];
    if (options.length === 0) return;
    const currentIndex = options.findIndex(o => o.getAttribute('aria-selected') === 'true');
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = event.key === 'ArrowDown'
        ? options[(currentIndex + 1) % options.length]
        : options[(currentIndex - 1 + options.length) % options.length];
      selectChange(next.dataset.changeId || null);
      const selected = [...$('change-list').querySelectorAll('[role="option"]')].find(o => o.dataset.changeId === next.dataset.changeId);
      selected?.focus();
    } else if (event.key === 'Enter' && currentIndex >= 0) {
      event.preventDefault();
      $('detail-heading').setAttribute('tabindex', '-1');
      $('detail-heading').focus();
    }
  });
}

// --- Boot ---

/** Readable loading state before the first fetch resolves. */
function renderLoading() {
  for (const id of ['lease-list', 'change-list', 'queue-list', 'runner-list', 'finding-list', 'verdict-list']) {
    emptyInto($(id), 'loading');
  }
  $('queue-tree').replaceChildren();
  $('queue-tree').append(el('p', 'Bisection tree: loading…', { class: 'muted' }));
  $('canonical-tip').replaceChildren();
  $('canonical-tip').append(el('p', 'Canonical tip: loading…', { class: 'muted' }));
}

function boot() {
  wireSession();
  wireMutations();
  wireKeyboard();
  refreshAffordances();
  $('repo-select').replaceChildren(el('option', 'Enter a session token to list repos'));
  renderAll();
  window.setInterval(tick, 1000);
  void refreshBadge();
}

void boot();
