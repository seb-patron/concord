import {
  allowedActions, claimUnits, clearSessionToken, enqueueChange, getEvents, getHealth, getMe, getSession,
  getSnapshot, getMetrics, getVerdicts, getHumanApprovalDiff, hasToken, isForbidden, listPrincipals, listRepos, newIdempotencyKey,
  putSettings, redactError, redactText, setSessionToken, setAnonymousReadBudget, submitHumanApproval, submitVerdict, withdrawChange,
} from './api.js';
import {
  boardStage, deriveInbox, environmentBadge, leaseCountdown, mutationEvidence,
  liveLeaseHolders, normalizeDiagnosis, openIssueRows, panelCopy, projectionItems, repairStatus, safeText, snapshotCollections, verdictProvenance,
} from './views.js';
import { createRepoPage } from './repo.js';
import { appendObservedEvents, createTracker, observedDailyCount } from './tracker.js';
import { createVerdictLoader } from './verdicts.js';
import { renderMilestones } from './milestones.js';

const $ = id => document.getElementById(id);
const repoPage = createRepoPage($('code-view'));
const state = { generation: 0, repoId: null, repos: [], principals: [], identity: null, snapshot: null,
  events: [], seq: 0, version: 0, observedVersions: new Map(), verdicts: {}, verdictErrors: {}, selected: null,
  inboxSelected: null, view: 'tracker', tab: 'work', connected: true, busy: false, deskMessage: null,
  awaitingFreshSnapshot: false, accessSignIn: false, metrics: null, metricsFetchedAt: 0,
  publicRead: false, publicPollAt: 0, publicRequestTimes: [] };
// Keep anonymous traffic below the Worker's shared authentication limit.
function publicRequestAvailable() {
  if (!state.publicRead) return true;
  const now = Date.now();
  state.publicRequestTimes = state.publicRequestTimes.filter(time => now - time < 60_000);
  if (state.publicRequestTimes.length >= 18) return false;
  state.publicRequestTimes.push(now);
  return true;
}
setAnonymousReadBudget(() => publicRequestAvailable());
const demo = typeof window.CONCORD_DEMO_VIEWER_TOKEN === 'string' && window.CONCORD_DEMO_VIEWER_TOKEN.trim()
  ? window.CONCORD_DEMO_VIEWER_TOKEN.trim() : null;
const node = (tag, value, className) => {
  const n = document.createElement(tag);
  if (value !== undefined && value !== null) n.textContent = safeText(value);
  if (className) n.className = className;
  return n;
};
const verdictLoader = createVerdictLoader({
  fetchPage: (id, cursor) => getVerdicts(state.repoId, id, cursor),
  onEvict: id => { delete state.verdicts[id]; delete state.verdictErrors[id]; },
  onResult: (id, items, error) => {
    if (error) state.verdictErrors[id] = error;
    else { state.verdicts[id] = items; delete state.verdictErrors[id]; }
    render();
  },
});
const tracker = createTracker($('tracker-view'), {
  refresh: () => loadRepo(state.generation, false),
  loadVerdicts: (ids, terminalIds) => verdictLoader.request(ids, terminalIds),
});
const views = {
  code: { render: () => repoPage.show(state.repoId, state.snapshot) },
  tracker: { render: context => tracker.render(context) },
  milestones: { render: context => renderMilestones(context) },
  desk: { render: () => {} },
  inbox: { render: () => {} },
};
const list = value => Array.isArray(value) ? value : [];
const projections = () => state.snapshot?.data?.projections ?? {};
const changes = () => snapshotCollections(state.snapshot).changes.items;
const leases = () => projectionItems(projections().leases).items;
const entries = () => projectionItems(projections().queue).items;
const snapshotCurrent = () => !!state.snapshot && state.connected && !state.awaitingFreshSnapshot &&
  state.snapshot.version >= (state.observedVersions.get(state.repoId) ?? 0);
const roles = () => list(state.identity?.roles);
const actions = () => state.identity?.unverified
  ? { claim: true, enqueue: true, withdraw: true, verdict: true }
  : allowedActions(roles());
const changeFor = id => changes().find(c => c?.changeId === id);
const modelFor = change => change?.authorModel ?? change?.model ?? null;
const canManage = change => state.identity?.unverified || roles().includes('owner') ||
  state.identity?.principalId === change?.authorId;
const canWithdraw = change => actions().withdraw && canManage(change);
const fmtTime = ms => Number.isFinite(ms) ? new Date(ms).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' }) : '—';
const age = change => {
  const event = [...state.events].reverse().find(e => list(e.relatedIds).includes(change.changeId));
  if (!event?.timestamp) return 'time unavailable';
  const minutes = Math.max(0, Math.floor((Date.now() - event.timestamp) / 60000));
  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : fmtTime(event.timestamp);
};
function preserve(render) {
  const focused = document.activeElement?.id;
  const y = window.scrollY;
  const boardX = document.querySelector('.board-scroll')?.scrollLeft ?? 0;
  const statX = $('stat-strip').scrollLeft;
  render();
  if (focused) $(focused)?.focus({ preventScroll: true });
  const scroll = document.querySelector('.board-scroll');
  if (scroll) scroll.scrollLeft = boardX;
  $('stat-strip').scrollLeft = statX;
  if (window.scrollY !== y) window.scrollTo?.(0, y);
}
function sessionError(message) { $('session-error').textContent = message ?? ''; $('session-error').hidden = !message; }
function showSession() {
  const publicMode = state.publicRead && !!state.identity && !!state.repoId;
  const signedIn = ((hasToken() || state.identity?.authMethod === 'access') && !!state.identity) || publicMode;
  const access = state.identity?.authMethod === 'access';
  $('signed-out').hidden = signedIn;
  $('desk').hidden = !signedIn;
  $('repo-picker').hidden = !signedIn;
  $('principal').hidden = !signedIn;
  $('token-clear').hidden = !signedIn || access || publicMode;
  $('access-logout').hidden = !signedIn || !access;
  $('access-signin').hidden = signedIn || !state.accessSignIn;
  if (access) {
    $('principal').textContent = `Signed in as ${state.identity.principalId} via Cloudflare Access`;
    $('access-logout').href = state.identity.logoutUrl;
  } else if (publicMode) $('principal').textContent = 'Public, read-only';
  else if (signedIn) $('principal').textContent = state.identity.principalId
    ? `Signed in as ${state.identity.principalId} · ${roles().join(', ') || 'role unverified'}${state.identity.model ? ` · ${state.identity.model}` : ''} · token in memory`
    : `Signed in · ${roles().join(', ') || 'role unverified'} · token in memory`;
}
function signOut(message) {
  ++state.generation; clearSessionToken();
  state.publicRead = false; state.publicPollAt = 0; state.publicRequestTimes = [];
  repoPage.hide();
  state.repoId = null; state.snapshot = null; state.identity = null; state.repos = []; state.principals = [];
  state.verdicts = {}; state.verdictErrors = {}; state.events = []; state.seq = 0; state.version = 0;
  state.metrics = null; state.metricsFetchedAt = 0;
  verdictLoader.reset();
  state.observedVersions.clear();
  state.awaitingFreshSnapshot = false;
  state.selected = null; state.inboxSelected = null; state.view = 'tracker';
  $('action-panel').replaceChildren(); $('action-panel').dataset.changeId = '';
  $('inbox-detail').replaceChildren(); $('inbox-detail').dataset.itemId = '';
  state.deskMessage = null;
  $('token-input').value = '';
  sessionError(message); showSession();
}
async function signIn(token, preferredRepo, accessSession = null) {
  const gen = ++state.generation;
  state.publicRead = false; state.publicRequestTimes = [];
  setSessionToken(token); $('token-input').value = ''; sessionError(null);
  try {
    let identity;
    try { identity = (await getMe()).data; }
    catch (error) {
      if (error.status !== 404) throw error;
      identity = { principalId: null, roles: [], repoIds: null, unverified: true };
    }
    if (accessSession) identity = { ...identity, ...accessSession };
    const page = await listRepos();
    if (gen !== state.generation) return;
    state.identity = identity;
    void refreshPrincipals(gen);
    state.repos = list(page?.data?.items).filter(repo => !Array.isArray(identity.repoIds) || identity.repoIds.includes(repo.repoId));
    const select = $('repo-select'); select.replaceChildren(); select.disabled = false;
    if (!state.repos.length) {
      const option = node('option', 'No repositories yet'); option.value = ''; select.append(option);
    }
    for (const repo of state.repos) {
      const option = node('option', repo.displayName ?? repo.repoId);
      option.value = repo.repoId; select.append(option);
    }
    state.repoId = state.repos.find(r => r.repoId === preferredRepo)?.repoId ?? state.repos[0]?.repoId ?? null;
    if (state.repoId) select.value = state.repoId;
    showSession();
    if (state.repoId) await loadRepo(gen);
    else { state.deskMessage = 'No repositories yet. Create one with concord repo create or the MCP tool.'; render(); }
  } catch (error) {
    if (gen !== state.generation) return;
    const safe = redactError(error);
    const detail = redactText(safe.message).slice(0, 200);
    const message = error.status === 403 ? 'Your identity cannot see this repository.' :
      error.status === 401 ? 'Sign in again: this session is invalid or expired.' :
      `Could not sign in (${safe.code}): ${detail}`;
    signOut(message);
  }
}
async function enterPublicRead(repoId) {
  const gen = ++state.generation;
  state.publicRead = true; state.publicPollAt = 0; state.publicRequestTimes = [];
  state.identity = { principalId: 'anonymous', roles: ['viewer'], repoIds: [repoId] };
  state.repos = [{ repoId, displayName: repoId }];
  state.repoId = repoId;
  const select = $('repo-select'); select.replaceChildren();
  const option = node('option', repoId); option.value = repoId; select.append(option);
  select.value = repoId; select.disabled = true;
  showSession();
  await loadRepo(gen);
}
async function refreshPrincipals(gen) {
  try {
    const items = []; const seen = new Set(); let cursor = null;
    for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
      const page = await listPrincipals(cursor);
      if (gen !== state.generation) return;
      items.push(...list(page?.data?.items)); cursor = page?.data?.nextCursor ?? null;
      if (!cursor || seen.has(cursor)) break;
      if (cursor) seen.add(cursor);
    }
    if (gen === state.generation) { state.principals = items; render(); }
  } catch { /* Principal visibility is narrower than repo visibility for some tokens. */ }
}
async function loadRepo(gen = state.generation, resetSelection = true) {
  if (resetSelection) {
    state.snapshot = null; state.verdicts = {}; state.verdictErrors = {}; state.events = [];
    verdictLoader.reset();
    state.seq = 0; state.version = 0;
    state.metrics = null; state.metricsFetchedAt = 0;
  }
  state.deskMessage = null;
  if (resetSelection) { state.selected = null; state.inboxSelected = null; }
  if (resetSelection) { $('action-panel').replaceChildren(); $('action-panel').dataset.changeId = ''; }
  render();
  try {
    const body = await getSnapshot(state.repoId);
    if (gen !== state.generation) return;
    if (!acceptSnapshot(body, state.repoId)) { render(); return false; }
    state.connected = true;
    state.deskMessage = null;
    render();
    await Promise.allSettled([refreshVerdicts(gen), poll(gen)]);
    return true;
  } catch (error) {
    if (gen !== state.generation) return;
    if (error.status === 401) return signOut(state.publicRead
      ? 'This repository is private or does not exist. Sign in to view it.'
      : 'Sign in again: this token is invalid or expired.');
    state.deskMessage = error.status === 403 ? 'Your token cannot see this repository.' :
      `Snapshot unavailable (${redactError(error).code}).`;
    render();
    return false;
  }
}
function observeVersion(repoId, version) {
  if (!Number.isSafeInteger(version) || version < 0) return;
  state.observedVersions.set(repoId, Math.max(state.observedVersions.get(repoId) ?? 0, version));
}
function acceptSnapshot(body, repoId) {
  if (!Number.isSafeInteger(body?.version) || body.version < (state.observedVersions.get(repoId) ?? 0)) return false;
  observeVersion(repoId, body.version);
  verdictLoader.request([], list(body?.data?.projections?.repos?.changes)
    .filter(change => change?.status === 'merged').map(change => change.changeId));
  verdictLoader.advanceVersion(body.version);
  state.snapshot = body; state.version = body.version;
  state.awaitingFreshSnapshot = false;
  return true;
}
async function refreshVerdicts(gen = state.generation) {
  const ids = [];
  const terminal = [];
  if (state.view === 'desk' && state.selected) ids.push(state.selected);
  if (state.view === 'inbox' && state.inboxSelected) {
    const item = deriveInbox(state.snapshot).find(i => i.id === state.inboxSelected);
    if (item?.changeId) ids.push(item.changeId);
  }
  for (const id of ids) if (changeFor(id)?.status === 'merged') terminal.push(id);
  if (gen === state.generation) verdictLoader.request(ids, terminal);
}
async function poll(gen = state.generation) {
  if (!state.repoId || gen !== state.generation || state.busy) return;
  if (state.publicRead) {
    if (Date.now() - state.publicPollAt < 60_000) return;
    state.publicPollAt = Date.now();
  }
  state.busy = true;
  try {
    let page;
    for (let i = 0; i < (state.publicRead ? 1 : 20); i++) {
      const repoId = state.repoId;
      page = await getEvents(repoId, state.seq);
      if (gen !== state.generation) return;
      if (!Number.isSafeInteger(page?.version) || page.version < (state.observedVersions.get(repoId) ?? 0)) return;
      observeVersion(repoId, page.version);
      render();
      const items = list(page?.data?.items);
      if (items.length === 0) break;
      const last = items.at(-1)?.sequence;
      if (!Number.isSafeInteger(last) || last <= state.seq) break;
      state.events = appendObservedEvents(state.events, items); state.seq = last;
      if (last >= (page.eventSeq ?? last)) break;
    }
    if (page?.version > state.version) {
      const repoId = state.repoId;
      const body = await getSnapshot(repoId);
      if (gen !== state.generation || !acceptSnapshot(body, repoId)) return;
      await refreshVerdicts(gen);
    }
    if (Date.now() - state.metricsFetchedAt >= 60_000) {
      const day = new Date().toISOString().slice(0, 10);
      const since = `${day}T00:00:00.000Z`;
      const until = new Date(Date.parse(since) + 86_400_000).toISOString();
      try {
        const metrics = await getMetrics(state.repoId, since, until);
        if (gen !== state.generation) return;
        state.metrics = metrics.data?.changesLanded && metrics.data?.publishToLand &&
          metrics.data?.leaseClaimsRefused && metrics.data?.automaticRebases &&
          metrics.data?.approvalsCarriedByPatchId ? metrics.data : null;
      } catch (error) {
        if (error.status !== 404) throw error;
        state.metrics = null;
      }
      state.metricsFetchedAt = Date.now();
    }
    state.connected = true; render();
  } catch (error) {
    if (gen !== state.generation) return;
    if (error.status === 401) return signOut(state.publicRead
      ? 'This repository is private or does not exist. Sign in to view it.'
      : 'Sign in again: this token is invalid or expired.');
    state.connected = false;
    state.deskMessage = error.status === 403 ? 'Your token cannot see this repository.' : 'Disconnected. Showing the last known state.';
    render();
  } finally { state.busy = false; }
}
function stat(label, value, sub) {
  const box = node('div', null, 'stat');
  box.append(node('span', label, 'stat-label'), node('span', value, 'stat-value'), node('span', sub, 'stat-sub'));
  return box;
}
function renderStats() {
  const allHeld = projections().leases?.heldItems ?? [];
  const live = liveLeaseHolders(allHeld);
  const working = live;
  const queued = entries().filter(e => ['admitted','reserved','checking','waiting'].includes(e.state));
  const today = new Date().toDateString();
  const landed = observedDailyCount(state.events, 'Landed today');
  const landedToday = state.metrics?.changesLanded?.value ?? landed;
  const main = projections().queue?.observedMain ?? projections().queue?.finalCanonicalOid ??
    projections().repos?.repo?.observedCanonicalOid ?? null;
  const diagnosis = normalizeDiagnosis(projections().queue?.diagnosis);
  const mainState = diagnosis.reason === 'BASE_RED' ? 'red' :
    projections().queue?.activeStackJobId ? 'checking' :
    landed > 0 ? 'green' : 'unknown';
  $('stat-strip').replaceChildren(
    stat('Agents working', working.count, 'live lease holders'),
    stat('Leases held', live.evidence.length, live.evidence.length ? `shortest ${leaseCountdown(live.evidence.reduce((a,b) => a.expiresAt < b.expiresAt ? a : b), Date.now()).text}` : 'no active leases'),
    stat('In queue', queued.length, 'ordered for checking'),
    stat('Landed today', landedToday, state.metrics ? 'from repo metrics' : 'from observed events'),
    ...(state.metrics ? [
      stat('Median lead time', state.metrics.publishToLand.n ? `${Math.round(state.metrics.publishToLand.medianMs / 60000)}m` : '0m', `${state.metrics.publishToLand.n} landed changes`),
      stat('Claims refused', state.metrics.leaseClaimsRefused.value, 'conflicts caught before edit'),
      stat('Auto rebases', state.metrics.automaticRebases.value, 'recorded rebase events'),
      stat('Approvals carried', state.metrics.approvalsCarriedByPatchId.value, 'patch-id evidence'),
    ] : []),
    stat('Main', !state.repoId ? '0' : mainState, main ? `tip ${String(main).slice(0,9)}` : 'tip unavailable'),
  );
  const red = state.events.filter(e => e.kind === 'queue.diagnosis' && e.payload?.reason === 'BASE_RED' && new Date(e.timestamp).toDateString() === today).length;
  $('main-footer').replaceChildren(node('strong','main'), document.createTextNode(!state.repoId
    ? 'No repositories yet. Create one to see main branch activity.'
    : `${landedToday} landings today · ${red} red events · tip ${main ? String(main).slice(0,9) : 'unavailable'}`));
}
function statusFor(change) {
  const diag = normalizeDiagnosis(projections().queue?.diagnosis);
  if (diag.reason === 'SINGLETON' && diag.ids.includes(change.changeId)) return ['Blamed by bisection','red'];
  if (change.status === 'ready') return ['Ready for review or enqueue','blue'];
  return [change.status === 'merged' ? 'Landed' : change.status ?? 'Unknown','green'];
}
function renderBoard() {
  const board = $('work-board'); board.replaceChildren();
  if (!changes().length) {
    board.append(node('p','No changes yet. Agents start one with concord change create or the MCP tool.','empty-state'));
    return;
  }
  const stages = [['Working','Holds a lease, editing.'],['Checking','Checker on the exact head.'],['Queued','Approved, landing in order.'],['Landed','On main.']];
  for (const [stage,hint] of stages) {
    const cards = changes().filter(c => boardStage(c) === stage);
    const section = node('section',null,'board-column');
    section.setAttribute('aria-label',stage);
    const heading = node('h3',stage); heading.append(node('span',cards.length));
    section.append(heading,node('p',hint));
    for (const change of cards) {
      const card = node('button',null,'work-card'); card.type='button';
      card.id = `work-${change.changeId}`; card.dataset.changeId = change.changeId; card.dataset.stage=stage;
      card.setAttribute('aria-selected',String(change.changeId === state.selected));
      card.append(node('strong',change.intentText ?? change.intentKey ?? change.changeId));
      const chips=node('span',null,'chips');
      for (const key of list(change.unitKeys)) chips.append(node('code',key));
      if (!chips.childNodes.length) chips.append(node('span','No units'));
      card.append(chips);
      const meta=node('span',null,'card-meta'); meta.append(node('span',change.authorId ?? 'Unknown agent'));
      if (modelFor(change)) meta.append(node('span',modelFor(change))); card.append(meta);
      const [status,tone]=statusFor(change);
      const foot=node('span',null,'card-foot'); foot.append(node('span',status,`tone-${tone}`),node('span',age(change))); card.append(foot);
      card.addEventListener('click',()=>selectChange(change.changeId));
      section.append(card);
    }
    board.append(section);
  }
}
function renderFleet() {
  const byAgent=new Map();
  for (const c of changes()) if (c.authorId && (!byAgent.has(c.authorId) || c.status !== 'merged')) byAgent.set(c.authorId,c);
  const box=$('fleet-list'); box.replaceChildren();
  for (const [agent,c] of byAgent) {
    const row=node('li',null,'fleet-row'); row.append(node('span',agent[0]?.toUpperCase() ?? '?','avatar'));
    const middle=node('span',null,'row-main'); middle.append(node('span',agent));
    if (modelFor(c)) middle.append(node('span',` · ${modelFor(c)}`,'row-sub'));
    middle.append(node('div',c.intentText ?? c.intentKey,'row-sub'));
    row.append(middle,node('span',c.status,'row-sub')); box.append(row);
  }
  if (!byAgent.size) box.append(node('li',state.repoId ? 'No agents in this repo yet.' : 'No agents yet. Create a repository to get started.','muted'));
}
function renderRunners() {
  const projection = projectionItems(projections().runners);
  const box = $('runner-summary'); box.replaceChildren();
  if (projection.state === 'unavailable' || projection.state === 'unknown') {
    const copy = panelCopy(projection.state);
    box.append(node('strong', 'Runners: '), node('span', `${copy.title} — ${copy.hint}`));
  } else {
    box.append(node('strong', 'Runners: '), node('span', projection.items.length
      ? projection.items.map(r => `${r.runnerId ?? 'runner'} (${r.role ?? '?'}, ${r.state ?? 'unknown'})`).join(' · ')
      : 'No runners reported.'));
  }
  const detail = $('runner-list'); detail.replaceChildren();
  if (projection.state === 'unavailable' || projection.state === 'unknown') {
    const copy = panelCopy(projection.state);
    detail.append(node('p', `${copy.title} — ${copy.hint}`, 'muted'));
    return;
  }
  if (!projection.items.length) detail.append(node('p', 'No runners reported.', 'muted'));
  for (const runner of projection.items) {
    const card = node('div', null, 'evidence-record');
    card.append(node('strong', `${runner.runnerId ?? 'runner'} (${runner.role ?? '?'}) · ${runner.state ?? 'unknown'}`),
      node('p', `Last seen: ${runner.lastSeenAt ? new Date(runner.lastSeenAt).toISOString() : 'never'}`),
      node('p', `Active job: ${runner.activeJobId ?? 'none'}`));
    detail.append(card);
  }
}
function renderFindings(changeId) {
  const box = $('finding-list'); box.replaceChildren();
  const findings = projectionItems(projections().findings);
  const repairs = snapshotCollections(state.snapshot).repairs;
  if (findings.state === 'unavailable' || findings.state === 'unknown' || repairs.state === 'unknown') {
    const copy = panelCopy(findings.state === 'unavailable' ? 'unavailable' : 'unknown');
    box.append(node('p', `${copy.title} — ${copy.hint}`, 'muted'));
    return;
  }
  const scoped = findings.items.filter(f => f?.changeId === changeId);
  const rounds = repairs.items.filter(r => r?.changeId === changeId);
  const status = repairStatus(scoped, rounds);
  box.append(node('p', `Repair state: ${status.status} — ${status.summary}`));
  if (!scoped.length) box.append(node('p', 'No findings for the selected change.', 'muted'));
  for (const finding of scoped) {
    const card = node('div', null, 'evidence-record');
    card.append(node('strong', `${finding.status ?? 'unknown'} · ${finding.findingId ?? 'finding'}`),
      node('p', `Unit: ${finding.unitKey ?? '?'}`),
      node('p', `Origin revision: r${finding.originRevision ?? '?'}`),
      node('p', `Text: ${finding.text ?? ''}`));
    box.append(card);
  }
}
function renderHistory() {
  $('replay-body').replaceChildren(node('p',
    'Historical simulation: unavailable — no replay dataset ships with this view. Recorded aggregates are owner-reported and never computed here.', 'muted'));
}
function renderEvents(changeId) {
  const box = $('event-log'); box.replaceChildren();
  const related = state.events.filter(event => list(event.relatedIds).includes(changeId));
  if (!related.length) box.append(node('li', 'No events for the selected change.', 'muted'));
  for (const event of related.slice(-100)) {
    const item = node('li', `#${event.sequence} ${event.kind} by ${event.actorId ?? 'unknown'} (v${event.version ?? '?'})`);
    item.id = `event-${event.sequence}`;
    box.append(item);
  }
  const archive = $('event-evidence'); archive.replaceChildren();
  for (const verdict of list(state.verdicts[changeId])) {
    if (!verdict.deltaResultId) continue;
    const event = [...state.events].reverse().find(e => list(e.relatedIds).includes(verdict.deltaResultId));
    if (!event || related.slice(-100).includes(event) || archive.querySelector(`[id="event-${event.sequence}"]`)) continue;
    const item = node('li', `#${event.sequence} ${event.kind} by ${event.actorId ?? 'unknown'} (v${event.version ?? '?'})`);
    item.id = `event-${event.sequence}`; archive.append(item);
  }
}
function renderIssues() {
  const target = $('issue-list'); target.replaceChildren();
  const rows = openIssueRows(state.snapshot);
  if (!rows.length) { target.append(node('p', 'No open issues.', 'muted')); return; }
  for (const issue of rows) {
    const card = node('article', null, 'issue-card');
    card.append(node('strong', `#${issue.number} ${issue.title}`));
    if (issue.milestone) card.append(node('p', `Milestone: ${issue.milestone}`, 'muted'));
    for (const change of issue.changes) card.append(node('p', `Change ${change.changeId}: ${change.status}`, 'muted'));
    for (const lease of issue.leases) card.append(node('p', `Held: ${lease.unitKey} by ${lease.holderId}`, 'muted'));
    target.append(card);
  }
}
function renderLeases() {
  const box=$('lease-list'); box.replaceChildren();
  const active=leases().filter(l => ['active','reserved'].includes(l.state) && l.expiresAt > Date.now());
  for (const lease of active) {
    const row=node('div',null,'lease-row');
    row.append(node('code',lease.unitKey),node('span',`Holder: ${lease.holderId ?? 'unknown'}`),
      node('span',`Change: ${lease.changeId ?? 'unknown'}`),node('span',`State: ${lease.state ?? 'unknown'}`),
      node('span',`Intent: ${lease.intentText ?? 'not recorded'}`),node('span',`Fence: ${lease.fence ?? 'unknown'}`),
      node('span',`Expires: ${fmtTime(lease.expiresAt)} (${leaseCountdown(lease,Date.now()).text})`));
    box.append(row);
  }
  if (!active.length) box.append(node('p','No active leases yet. Agents claim units before editing.','muted'));
  for (const refusal of list(projections().leases?.refusals)) {
    const conflict=list(refusal.conflicts)[0];
    if (!conflict || conflict.expiresAt <= Date.now() ||
      !active.some(l => l.holderId === conflict.holderId && list(refusal.keys).includes(l.unitKey))) continue;
    box.append(node('p',`${refusal.requesterId ?? 'Agent'} waits for ${list(refusal.keys).join(', ') || 'a unit'} · Holder: ${conflict.holderId ?? 'unknown'} · Intent: ${conflict.intentText ?? 'not recorded'} · Expires: ${fmtTime(conflict.expiresAt)}`,'wait-note'));
  }
}
function renderQueue() {
  const box=$('queue-list'); box.replaceChildren();
  const diag=normalizeDiagnosis(projections().queue?.diagnosis);
  const active=entries().filter(e => !['withdrawn','landed'].includes(e.state));
  const historical=entries().filter(e => ['withdrawn','landed'].includes(e.state));
  const renderEntry=(entry,index,parent)=>{
    const c=changeFor(entry.changeId);
    const row=node('div',null,'queue-row');
    const highlight=diag.ids.includes(entry.changeId);
    if (highlight) row.classList.add('highlight');
    row.append(node('span',index+1),node('span',c?.intentText ?? entry.changeId,'row-main'),
      node('span',highlight ? `${entry.state} · ${diag.reason === 'SINGLETON' ? 'culprit' : 'failing set'}` : entry.state,highlight ? 'tone-red' : 'tone-green'));
    row.append(node('span',`Change: ${entry.changeId} · Admitted revision: ${entry.admittedRevision ?? entry.revision ?? 'unknown'} · Sequence: ${entry.sequence ?? 'unknown'} · Blocked reason: ${entry.blockedReason ?? 'none'}`,'queue-evidence'));
    parent.append(row);
  };
  active.forEach((entry,index)=>renderEntry(entry,index,box));
  if (!active.length) box.append(node('p','Merge queue empty. Approved changes enter through Enqueue.','muted'));
  if (historical.length) {
    const archive=node('details',null,'queue-history');
    archive.append(node('summary',`Landed and withdrawn (${historical.length})`));
    historical.forEach((entry,index)=>renderEntry(entry,index,archive));
    box.append(archive);
  }
  const labels={SINGLETON:'One change failed alone',INTERACTION:'Interaction set failed together',DEPENDENCY_GROUP:'Dependency group blocked',BASE_RED:'Main baseline failed',INCONCLUSIVE:'Diagnosis inconclusive'};
  $('diagnosis').textContent=diag.reason ? `${labels[diag.reason] ?? diag.reason}: ${diag.ids.join(', ') || 'no change blamed'}` : '';
  const tree=$('queue-tree'); tree.replaceChildren();
  const queue=projections().queue ?? {};
  const results=list(queue.diagnosticResults);
  const members=list(queue.stackMembers);
  if (!members.length && !results.length && !queue.activeStackJobId) return;
  const heading=node('h3','Queue bisection tree'); tree.append(heading);
  const root=node('ul',null,'diagnostic-tree');
  const stack=node('li',`Active job: ${queue.activeStackJobId ?? 'none'} · Members: ${members.join(', ') || 'none'}`);
  root.append(stack);
  const branches=node('ul'); stack.append(branches);
  for (const result of results) {
    const memberIds=list(result.memberIds);
    const branch=node('li',`Diagnostic job ${result.jobId ?? 'unknown'} · Members: ${memberIds.join(', ') || 'none'} · Outcome: ${result.outcome ?? 'unknown'}${result.sequence ? ` · Event #${result.sequence}` : ''}`);
    if (memberIds.some(id=>diag.ids.includes(id))) branch.classList.add('highlight');
    branches.append(branch);
  }
  tree.append(root);
}
function renderVerdicts(id, target) {
  target.replaceChildren();
  if (state.verdictErrors[id]) { target.append(node('p',state.verdictErrors[id],'muted')); return; }
  const items=state.verdicts[id];
  if (!Array.isArray(items)) { target.append(node('p','Loading approval history…','muted')); return; }
  if (items.olderNotLoaded) target.append(node('p','Older approvals not loaded.','muted'));
  if (!items.length) { target.append(node('p','No verdict recorded.','muted')); return; }
  for (const v of items) {
    const card=node('div',null,'verdict-record');
    if (v.verdictId) card.id=`verdict-${encodeURIComponent(v.verdictId)}`;
    card.append(node('strong',`${v.decision} · ${v.reviewerId}`),node('p',verdictProvenance(v).summary));
    if (v.parentVerdictId) {
      const provenance=node('p'); provenance.append(document.createTextNode('Parent review: '));
      const parent=items.find(item=>item.verdictId===v.parentVerdictId);
      if (parent) { const link=node('a',v.parentVerdictId); link.href=`#verdict-${encodeURIComponent(v.parentVerdictId)}`; provenance.append(link); }
      else provenance.append(document.createTextNode(`${v.parentVerdictId} (record unavailable)`));
      provenance.append(document.createTextNode(' · delta evidence: '));
      const event=state.events.find(item=>list(item.relatedIds).includes(v.deltaResultId));
      if (event) { const link=node('a',v.deltaResultId); link.href=`#event-${event.sequence}`; provenance.append(link); }
      else provenance.append(document.createTextNode(`${v.deltaResultId ?? 'missing'} (record unavailable)`));
      card.append(provenance);
    }
    target.append(card);
  }
}
function addAction(target,label,handler,primary=false) {
  const b=node('button',label,primary?'primary':''); b.type='button'; b.addEventListener('click',handler); target.append(b);
}
function renderActions(target,change) {
  const eligibility = change ? {
    enqueue: change.status==='ready' && actions().enqueue && canManage(change) && !!change.headOid,
    claim: ['draft','ready'].includes(change.status) && actions().claim &&
      (state.identity?.unverified || state.identity?.principalId===change.authorId),
    withdraw: !['merged','withdrawn'].includes(change.status) && canWithdraw(change) &&
      entries().some(e => e.changeId===change.changeId && !['withdrawn','landed'].includes(e.state)),
    verdict: change.status==='ready' && actions().verdict && state.identity?.principalId !== change.authorId,
  } : {};
  const signature=JSON.stringify([change?.changeId ?? null,eligibility,change?.awaitingHumanApproval,change?.reviewManifestDigest]);
  if (target.dataset.actionSignature===signature && target.dataset.changeId===(change?.changeId ?? '')) {
    for (const button of target.querySelectorAll('button')) button.disabled=!snapshotCurrent() ||
      (button.closest('.human-approval')?.dataset.previewReady !== undefined && button.closest('.human-approval').dataset.previewReady !== 'true');
    return;
  }
  const retained={};
  if (target.dataset.changeId===change?.changeId) for (const form of target.querySelectorAll('form[data-action]')) {
    retained[form.dataset.action]=Object.fromEntries([...form.elements].filter(el=>el.name).map(el=>[el.name,el.value]));
  }
  target.replaceChildren();
  target.dataset.changeId=change?.changeId ?? '';
  target.dataset.actionSignature=signature;
  if (!change) return;
  if (roles().includes('owner') && list(change.awaitingHumanApproval).length) {
    const panel=node('section',null,'human-approval');
    panel.append(node('h3','Owner approval required'), node('p',`Protected patterns: ${change.awaitingHumanApproval.join(', ')}`));
    const summary=node('ul');
    for (const unit of list(change.protectedDiffSummary)) summary.append(node('li',`${unit.beforePath ?? '(new)'} → ${unit.afterPath ?? '(deleted)'} · ${unit.beforeDigest ?? 'absent'} → ${unit.afterDigest ?? 'absent'}${unit.beforeMode!==unit.afterMode?` · mode ${unit.beforeMode ?? 'absent'} → ${unit.afterMode ?? 'absent'}`:''}`));
    panel.append(summary);
    const preview=node('div','Loading protected text changes…','protected-preview');
    panel.append(preview);
    panel.dataset.previewReady='false';
    void getHumanApprovalDiff(state.repoId,change.changeId).then(response=>{
      if (!panel.isConnected || response?.data?.revision!==change.revision ||
          response?.data?.reviewManifestDigest!==change.reviewManifestDigest) return;
      const items=list(response.data.items);
      preview.replaceChildren();
      for (const item of items) {
        preview.append(node('h4',`${item.beforePath ?? '(new)'} → ${item.afterPath ?? '(deleted)'}${item.beforeMode!==item.afterMode?` · mode ${item.beforeMode ?? 'absent'} → ${item.afterMode ?? 'absent'}`:''}`),node('pre',item.summary));
        if (item.truncated!==false) preview.append(node('p','Preview incomplete; inspect the repository diff before deciding.'));
      }
      if (!items.length) preview.append(node('p','No protected text changes were returned.'));
      panel.dataset.previewReady=items.length>0 && items.every(item=>
        item.truncated===false && typeof item.summary==='string' &&
        !item.summary.startsWith('Preview unavailable') && !item.summary.startsWith('Binary or large')) ? 'true' : 'false';
      for (const button of panel.querySelectorAll('button')) button.disabled=!snapshotCurrent() || panel.dataset.previewReady!=='true';
    }).catch(()=>{ if (panel.isConnected) preview.textContent='Protected text preview unavailable. Refresh and inspect the repository diff.'; });
    const evidence=node('input'); evidence.placeholder='Evidence digest (sha256:…)'; evidence.setAttribute('aria-label','Owner approval evidence digest');
    panel.append(evidence);
    for (const [label,decision] of [['Approve','approve'],['Request changes','reject']]) {
      const button=node('button',label); button.type='button';
      button.disabled=true;
      button.addEventListener('click',()=>void mutate('Owner decision',()=>submitHumanApproval(state.repoId,change.changeId,
        { expectedVersion:state.snapshot.version, revision:change.revision, reviewManifestDigest:change.reviewManifestDigest,
          evidenceDigest:evidence.value.trim(), decision },newIdempotencyKey())));
      panel.append(button);
    }
    target.append(panel);
  }
  const buttons=node('div',null,'action-buttons');
  if (eligibility.enqueue) {
    const form=node('form',null,'action-form');
    form.dataset.action='enqueue';
    const label=node('label','Approved verdict ID');
    const id=node('input'); id.name='verdictId'; id.required=true; id.placeholder='Verdict ID from reviewer';
    id.value=retained.enqueue?.verdictId ?? '';
    label.append(id); form.append(label);
    const submit=node('button','Enqueue','primary'); submit.type='submit'; form.append(submit);
    form.addEventListener('submit',e=>{e.preventDefault();doEnqueue(changeFor(change.changeId) ?? change,id.value.trim());});
    target.append(form);
  }
  if (eligibility.claim) {
    const form=node('form',null,'action-form');
    form.dataset.action='claim';
    const units=node('input'); units.name='unitKeys'; units.required=true; units.value=retained.claim?.unitKeys ?? list(change.unitKeys).join(', ');
    const intent=node('input'); intent.name='intentText'; intent.required=true; intent.maxLength=2000;
    intent.value=retained.claim?.intentText ?? change.intentText ?? '';
    for (const [title,input] of [['Unit keys (comma separated)',units],['Claim intent',intent]]) {
      const label=node('label',title); label.append(input); form.append(label);
    }
    const submit=node('button','Claim'); submit.type='submit'; form.append(submit);
    form.addEventListener('submit',e=>{e.preventDefault();doClaim(changeFor(change.changeId) ?? change,units.value,intent.value);});
    target.append(form);
  }
  if (eligibility.withdraw) addAction(buttons,'Withdraw',()=>doWithdraw(changeFor(change.changeId) ?? change));
  target.append(buttons);
  if (eligibility.verdict) {
    const form=node('form',null,'action-form');
    form.dataset.action='verdict';
    const decision=node('select'); decision.name='decision';
    for(const v of ['approve','reject']) {const o=node('option',v); o.value=v; decision.append(o);}
    decision.value=retained.verdict?.decision ?? 'approve';
    const manifest=node('input'); manifest.name='manifest'; manifest.required=true; manifest.placeholder='sha256:…';
    const evidence=node('input'); evidence.name='evidence'; evidence.required=true; evidence.placeholder='sha256:…';
    manifest.value=retained.verdict?.manifest ?? '';
    evidence.value=retained.verdict?.evidence ?? '';
    for(const [label,input] of [['Decision',decision],['Review manifest digest',manifest],['Evidence digest',evidence]]) {
      const wrapper=node('label',label); wrapper.append(input); form.append(wrapper);
    }
    const submit=node('button','Submit verdict','primary'); submit.type='submit'; form.append(submit);
    form.addEventListener('submit',e=>{e.preventDefault(); void doVerdict(changeFor(change.changeId) ?? change,decision.value,manifest.value,evidence.value);});
    target.append(form);
  }
  for (const button of target.querySelectorAll('button')) button.disabled=!snapshotCurrent();
}
function renderDetail() {
  const change=changeFor(state.selected);
  $('change-detail').hidden=!change;
  if (!change) return;
  const body=$('detail-body'); body.replaceChildren();
  body.append(node('h3',change.intentText ?? change.intentKey ?? change.changeId));
  const grid=node('div',null,'detail-grid');
  const rows=[['Change',change.changeId],['Agent',change.authorId],['Model',modelFor(change)],['Status',change.status],['Units',list(change.unitKeys).join(', ')],['Revision',change.revision],['Base',change.baseOid],['Head',change.headOid]];
  if(change.status==='closed' && change.closeReason) rows.push(['Close reason',change.closeReason]);
  for(const [label,value] of rows) {
    if (value===null || value===undefined || value==='') continue;
    const p=node('p'); p.append(node('strong',`${label}: `),node('span',value)); grid.append(p);
  }
  body.append(grid); renderFindings(change.changeId); renderHistory(); renderEvents(change.changeId);
  renderVerdicts(change.changeId,$('verdict-list')); renderActions($('action-panel'),change);
}
function renderInbox() {
  const items=deriveInbox(state.snapshot);
  $('inbox-alert').hidden=items.length===0 || state.view==='inbox';
  $('alert-count').textContent=`${items.length} decision${items.length===1?'':'s'} need you`;
  $('alert-preview').textContent=items.slice(0,3).map(i=>i.kind).join(' · ');
  $('inbox-count').textContent=`${items.length} decisions · ${state.repos.find(r=>r.repoId===state.repoId)?.displayName ?? state.repoId ?? ''}`;
  if (!items.some(i=>i.id===state.inboxSelected)) state.inboxSelected=items[0]?.id ?? null;
  const nav=$('inbox-list'); nav.replaceChildren();
  for(const item of items) {
    const b=node('button',null,'inbox-item'); b.type='button'; b.id=`inbox-${item.id.replace(/[^A-Za-z0-9_-]/g,'-')}`;
    b.setAttribute('aria-current',String(item.id===state.inboxSelected));
    b.append(node('span',item.kind,`tone-${item.tone}`),node('strong',item.title));
    b.addEventListener('click',()=>{state.inboxSelected=item.id;renderInbox(); void refreshVerdicts();});
    nav.append(b);
  }
  const detail=$('inbox-detail');
  const sameItem=detail.dataset.itemId===state.inboxSelected;
  if (!sameItem) detail.replaceChildren();
  detail.dataset.itemId=state.inboxSelected ?? '';
  const item=items.find(i=>i.id===state.inboxSelected);
  if (!item) {detail.replaceChildren(node('p','Nothing needs a decision right now.'));return;}
  const content=sameItem ? detail.querySelector('.inbox-content') ?? node('div',null,'inbox-content') : node('div',null,'inbox-content');
  content.replaceChildren(node('span',item.kind,`tone-${item.tone}`),node('h2',item.title),node('p',item.why),node('div',item.evidence,'evidence'));
  if (!sameItem || !content.isConnected) detail.prepend(content);
  const c=changeFor(item.changeId);
  if (c) {
    if (state.view === 'inbox' && !Object.hasOwn(state.verdicts,c.changeId) && !state.verdictErrors[c.changeId]) {
      verdictLoader.request([c.changeId], c.status === 'merged' ? [c.changeId] : []);
    }
    const approval=node('div'); approval.append(node('h3','Approval history'));
    const records=node('div'); approval.append(records); renderVerdicts(c.changeId,records); content.append(approval);
    const open=node('button','Open change details'); open.type='button';
    open.addEventListener('click',()=>{state.view='desk';selectChange(c.changeId);$('detail-heading').focus();});
    content.append(open);
    const actionPanel=sameItem ? detail.querySelector('.inbox-actions') ?? node('div',null,'inbox-actions') : node('div',null,'inbox-actions');
    if (!sameItem || !actionPanel.isConnected) detail.append(actionPanel);
    renderActions(actionPanel,c);
  }
}
function renderTabs() {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-current',String(b.dataset.tab===state.tab));
  for (const pane of document.querySelectorAll('[data-pane]')) pane.classList.toggle('active-pane',pane.dataset.pane===state.tab);
}
function render() {
  preserve(()=>{
    showSession();
    if ((!hasToken() && !state.publicRead) || !state.identity) return;
    $('desk').dataset.mainViewActive = state.view;
    const sections = { code: $('code-view'), tracker: $('tracker-view'), milestones: $('milestones-view'), desk: $('desk-view'), inbox: $('inbox-view') };
    for (const [name, section] of Object.entries(sections)) section.hidden = state.view !== name;
    $('stat-strip').hidden = state.view !== 'desk';
    $('inbox-alert').hidden = state.view === 'inbox' || deriveInbox(state.snapshot).length === 0;
    for (const button of document.querySelectorAll('[data-main-view]')) button.setAttribute('aria-current', String(button.dataset.mainView === state.view));
    if (state.view !== 'code') repoPage.hide();
    views[state.view]?.render({ repoId: state.repoId, snapshot: state.snapshot, events: state.events,
      identity: state.identity, principals: state.principals, roles: roles(),
      verdicts: state.verdicts, verdictErrors: state.verdictErrors, message: state.deskMessage,
      refresh: async () => { await loadRepo(state.generation, false); return state.snapshot; } });
    $('desk-message').hidden = !state.deskMessage;
    $('desk-message').textContent = state.deskMessage ?? '';
    $('desk-view').hidden=state.view!=='desk'; $('inbox-view').hidden=state.view!=='inbox';
    if (!state.snapshot) {
      renderInbox();
      if (!state.repoId) {
        renderStats();renderBoard();renderFleet();renderRunners();renderIssues();renderLeases();renderQueue();renderTabs();
      }
      return;
    }
    renderStats();renderBoard();renderFleet();renderRunners();renderIssues();renderLeases();renderQueue();renderDetail();renderInbox();renderSettings();renderTabs();
  });
}
function renderSettings() {
  const panel=$('settings-panel');
  panel.hidden=!roles().includes('owner') || !state.repoId;
  if (panel.hidden) return;
  const rules=list(projections().settings?.protectedPaths);
  const signature=JSON.stringify(rules);
  const target=$('settings-list');
  if (target.dataset.signature===signature) return;
  target.dataset.signature=signature;
  target.replaceChildren();
  for (const rule of rules) {
    const row=node('div',null,'settings-rule');
    row.append(node('strong',rule.pattern),node('span',` · ${rule.level}${rule.note ? ` · ${rule.note}` : ''}`));
    const remove=node('button','Remove'); remove.type='button';
    remove.addEventListener('click',()=>void saveSettings(rules.filter(item=>item.pattern!==rule.pattern)));
    row.append(remove); target.append(row);
  }
}
async function saveSettings(protectedPaths) {
  if (!snapshotCurrent() || !roles().includes('owner')) return;
  $('settings-status').textContent='Saving…';
  try {
    const response=await putSettings(state.repoId,{expectedVersion:state.snapshot.version,protectedPaths},newIdempotencyKey());
    observeVersion(state.repoId,response.version);
    await loadRepo(state.generation,false);
    $('settings-status').textContent='Settings saved.';
  } catch(error) {
    $('settings-status').textContent=`Settings: ${redactError(error).code}.`;
    await loadRepo(state.generation,false);
  }
}
function selectChange(id) {
  state.selected=id; render(); $('change-detail').hidden=false;
  if (!Object.hasOwn(state.verdicts,id) && !state.verdictErrors[id]) void refreshVerdicts();
  $('change-detail').scrollIntoView?.({block:'nearest'});
}
function mutationStatus(message) { $('mutation-status').textContent=message; }
async function mutate(label,call) {
  if (!snapshotCurrent()) return mutationStatus('Current snapshot is unavailable. Refresh before acting.');
  const gen=state.generation; const repoId=state.repoId; mutationStatus(`${label}…`);
  try {
    const response=await call(); if(gen!==state.generation)return;
    observeVersion(repoId,response?.version);
    render();
    const refreshed=await loadRepo(gen,false);
    mutationStatus(refreshed ? `${label}: accepted.` : `${label}: accepted; waiting for a current snapshot.`);
  } catch(error) {
    if(gen!==state.generation)return;
    if(error.status===409 && error.code==='STALE_VERSION') {
      observeVersion(repoId, error.details?.currentVersion);
      state.awaitingFreshSnapshot = true;
      render();
    }
    const refusal=redactError(error);
    const conflict=error.code==='LEASE_CONFLICT' && error.details
      ? ` Holder: ${error.details.holderId ?? 'unknown'}; intent: ${error.details.intentText ?? 'not recorded'}; expires: ${fmtTime(error.details.expiresAt)}.` : '';
    mutationStatus(`${label}: ${error.status===409?'stale or conflicting context':'failed'} (${refusal.code}: ${refusal.message}).${conflict} Refreshing.`);
    await loadRepo(gen,false);
  }
}
function doEnqueue(change,verdictId) {
  if (!verdictId) return mutationStatus('Approved verdict ID is required.');
  const version=state.snapshot?.version;
  const findingSetVersion=projections().findings?.findingSetVersions?.[change.changeId];
  const evidence=mutationEvidence(change,leases(),findingSetVersion);
  if(evidence.error || !Number.isSafeInteger(version)) return mutationStatus(evidence.error ?? 'Current version unavailable.');
  void mutate('Enqueue',()=>enqueueChange(state.repoId,{changeId:change.changeId,expectedVersion:version,verdictId,leaseFences:evidence.leaseFences},newIdempotencyKey()));
}
function doClaim(change,rawUnits,rawIntent) {
  const unitKeys=rawUnits.split(',').map(key=>key.trim());
  const intentText=rawIntent.trim();
  if (!unitKeys.length || unitKeys.some(key=>!key) || new Set(unitKeys).size!==unitKeys.length)
    return mutationStatus('Enter distinct, nonempty unit keys separated by commas.');
  if (!intentText || intentText.length>2000) return mutationStatus('Claim intent must be 1–2000 characters.');
  void mutate('Claim',()=>claimUnits(state.repoId,{changeId:change.changeId,unitKeys,intentText},newIdempotencyKey()));
}
function doWithdraw(change) {
  void mutate('Withdraw',()=>withdrawChange(state.repoId,{changeId:change.changeId,expectedVersion:state.snapshot.version,reason:'withdrawn from Fleet desk'},newIdempotencyKey()));
}
function doVerdict(change,decision,manifest,evidenceDigest) {
  const evidence=mutationEvidence(change,leases(),projections().findings?.findingSetVersions?.[change.changeId],false);
  if(evidence.error)return mutationStatus(evidence.error);
  void mutate('Verdict',()=>submitVerdict(state.repoId,change.changeId,{expectedVersion:state.snapshot.version,revision:evidence.revision,reviewManifestDigest:manifest.trim(),findingSetVersion:evidence.findingSetVersion,decision,evidenceDigest:evidenceDigest.trim()},newIdempotencyKey()));
}
function boot() {
  $('settings-form').addEventListener('submit',event=>{
    event.preventDefault();
    const data=new FormData(event.currentTarget);
    const pattern=String(data.get('pattern') ?? '').trim();
    const level=String(data.get('level') ?? 'agents');
    const note=String(data.get('note') ?? '').trim();
    if (!pattern) return;
    const rules=list(projections().settings?.protectedPaths).filter(rule=>rule.pattern!==pattern);
    rules.push({pattern,level,...(note ? {note} : {})});
    void saveSettings(rules);
  });
  $('desk').addEventListener('click', event => {
    const tab = event.target.closest('[data-main-view]');
    if (!tab || !Object.hasOwn(views, tab.dataset.mainView)) return;
    state.view = tab.dataset.mainView;
    render();
  });
  const logout = node('a', 'Sign out', 'quiet');
  logout.id = 'access-logout'; logout.hidden = true;
  $('token-clear').after(logout);
  const accessSignin = node('a', 'Sign in with Cloudflare Access', 'primary');
  accessSignin.id = 'access-signin'; accessSignin.href = '/v1/session/signin'; accessSignin.hidden = true;
  $('token-form').before(accessSignin);
  $('demo-open').hidden=!demo;
  $('demo-open').addEventListener('click',()=>{if(demo) void signIn(demo,window.CONCORD_DEMO_REPO_ID);});
  $('token-form').addEventListener('submit',e=>{e.preventDefault();const token=$('token-input').value;if(!token)return;const invalid=token.search(/[^\x21-\x7E]/);if(invalid!==-1){sessionError(`The pasted token has a space, line break or non-ASCII character at position ${invalid+1}; copy it again.`);return;}void signIn(token);});
  $('token-clear').addEventListener('click',()=>signOut());
  $('repo-select').addEventListener('change',()=>{state.repoId=$('repo-select').value; state.view='tracker'; ++state.generation;void loadRepo();});
  $('inbox-alert').addEventListener('click',()=>{state.view='inbox';render();});
  $('back-desk').addEventListener('click',()=>{state.view='desk';render();});
  $('detail-close').addEventListener('click',()=>{const id=state.selected;state.selected=null;render();if(id)$(`work-${id}`)?.focus();});
  for(const b of document.querySelectorAll('[data-tab]')) b.addEventListener('click',()=>{state.tab=b.dataset.tab;renderTabs();});
  $('work-board').addEventListener('keydown',e=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Enter'].includes(e.key))return;
    const cards=[...document.querySelectorAll('.work-card')];
    const index=cards.indexOf(document.activeElement);
    if(index<0)return;
    e.preventDefault();
    if(e.key==='Enter'){selectChange(cards[index].dataset.changeId);$('detail-heading').focus();return;}
    const next=cards[(index+(e.key==='ArrowLeft'||e.key==='ArrowUp'?-1:1)+cards.length)%cards.length];
    selectChange(next.dataset.changeId);$(next.id)?.focus();
  });
  window.setInterval(()=>{
    if (!(hasToken() || state.identity?.authMethod === 'access' || state.publicRead) || !state.repoId) return;
    if (state.publicRead && Date.now() - state.publicPollAt < 60_000) return;
    void poll();
  },1000);
  const urlRepo = new URLSearchParams(window.location.search).get('repo');
  const tryPublicRead = () => {
    if (!hasToken() && urlRepo && /^[A-Za-z0-9_-]{1,64}$/.test(urlRepo)) void enterPublicRead(urlRepo);
  };
  void getSession().then(body=>{
    if (body?.data?.authMethod === 'access' && !hasToken()) void signIn(null, null, body.data);
    else tryPublicRead();
  }).catch(tryPublicRead);
  void getHealth().then(body=>{state.accessSignIn=body?.data?.accessSignIn===true;showSession();const info=environmentBadge(body?.data,false);$('env-badge').textContent=info.label==='live Artifacts'?'Live · Cloudflare Artifacts':info.label;}).catch(()=>{$('env-badge').textContent='Backend unavailable';});
  render();
}
boot();
