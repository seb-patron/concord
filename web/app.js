import {
  allowedActions, clearSessionToken, enqueueChange, getEvents, getHealth, getMe,
  getSnapshot, getVerdicts, hasToken, isForbidden, listRepos, newIdempotencyKey,
  redactError, setSessionToken, submitVerdict, withdrawChange,
} from './api.js';
import {
  boardStage, deriveInbox, environmentBadge, leaseCountdown, mutationEvidence,
  normalizeDiagnosis, projectionItems, safeText, snapshotCollections, verdictProvenance,
} from './views.js';

const $ = id => document.getElementById(id);
const state = { generation: 0, repoId: null, repos: [], identity: null, snapshot: null,
  events: [], seq: 0, version: 0, verdicts: {}, verdictErrors: {}, selected: null,
  inboxSelected: null, view: 'desk', tab: 'work', connected: true, busy: false, deskMessage: null };
const demo = typeof window.CONCORD_DEMO_VIEWER_TOKEN === 'string' && window.CONCORD_DEMO_VIEWER_TOKEN.trim()
  ? window.CONCORD_DEMO_VIEWER_TOKEN.trim() : null;
const node = (tag, value, className) => {
  const n = document.createElement(tag);
  if (value !== undefined && value !== null) n.textContent = safeText(value);
  if (className) n.className = className;
  return n;
};
const list = value => Array.isArray(value) ? value : [];
const projections = () => state.snapshot?.data?.projections ?? {};
const changes = () => snapshotCollections(state.snapshot).changes.items;
const leases = () => projectionItems(projections().leases).items;
const entries = () => projectionItems(projections().queue).items;
const roles = () => list(state.identity?.roles);
const actions = () => allowedActions(roles());
const changeFor = id => changes().find(c => c?.changeId === id);
const modelFor = change => change?.authorModel ?? change?.model ?? null;
const canWithdraw = change => actions().withdraw &&
  (roles().includes('owner') || state.identity?.principalId === change?.authorId);
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
  const signedIn = hasToken() && !!state.identity;
  $('signed-out').hidden = signedIn;
  $('desk').hidden = !signedIn;
  $('repo-picker').hidden = !signedIn;
  $('principal').hidden = !signedIn;
  $('token-clear').hidden = !signedIn;
  if (signedIn) $('principal').textContent = state.identity.principalId
    ? `Signed in as ${state.identity.principalId}${state.identity.model ? ` · ${state.identity.model}` : ''} · token in memory`
    : `Signed in · ${roles().join(', ') || 'role unverified'} · token in memory`;
}
function signOut(message) {
  ++state.generation; clearSessionToken();
  state.repoId = null; state.snapshot = null; state.identity = null; state.repos = [];
  state.verdicts = {}; state.verdictErrors = {}; state.events = []; state.seq = 0;
  state.selected = null; state.inboxSelected = null;
  state.deskMessage = null;
  $('token-input').value = '';
  sessionError(message); showSession();
}
async function signIn(token, preferredRepo) {
  const gen = ++state.generation;
  setSessionToken(token); $('token-input').value = ''; sessionError(null);
  try {
    let identity;
    try { identity = (await getMe()).data; }
    catch (error) {
      if (error.status !== 404) throw error;
      identity = { principalId: null, roles: ['viewer'], repoIds: null };
    }
    const page = await listRepos();
    if (gen !== state.generation) return;
    state.identity = identity;
    state.repos = list(page?.data?.items).filter(repo => !Array.isArray(identity.repoIds) || identity.repoIds.includes(repo.repoId));
    const select = $('repo-select'); select.replaceChildren();
    for (const repo of state.repos) {
      const option = node('option', repo.displayName ?? repo.repoId);
      option.value = repo.repoId; select.append(option);
    }
    state.repoId = state.repos.find(r => r.repoId === preferredRepo)?.repoId ?? state.repos[0]?.repoId ?? null;
    if (state.repoId) select.value = state.repoId;
    showSession();
    if (state.repoId) await loadRepo(gen);
    else render();
  } catch (error) {
    if (gen !== state.generation) return;
    const message = error.status === 403 ? 'Your token cannot see this repository.' :
      error.status === 401 ? 'Sign in again: this token is invalid or expired.' :
      `Could not sign in (${redactError(error).code}).`;
    signOut(message);
  }
}
async function loadRepo(gen = state.generation, resetSelection = true) {
  state.snapshot = null; state.verdicts = {}; state.verdictErrors = {}; state.events = [];
  state.seq = 0; state.version = 0; state.deskMessage = null;
  if (resetSelection) { state.selected = null; state.inboxSelected = null; }
  render();
  try {
    const body = await getSnapshot(state.repoId);
    if (gen !== state.generation) return;
    state.snapshot = body; state.version = body.version ?? 0; state.connected = true;
    state.deskMessage = null;
    render();
    await Promise.allSettled([refreshVerdicts(gen), poll(gen)]);
  } catch (error) {
    if (gen !== state.generation) return;
    if (error.status === 401) return signOut('Sign in again: this token is invalid or expired.');
    state.deskMessage = error.status === 403 ? 'Your token cannot see this repository.' :
      `Snapshot unavailable (${redactError(error).code}).`;
    render();
  }
}
async function refreshVerdicts(gen = state.generation) {
  const ids = new Set(changes().filter(c => c?.status === 'ready').map(c => c.changeId));
  if (state.selected) ids.add(state.selected);
  if (state.inboxSelected) {
    const item = deriveInbox(state.snapshot, state.verdicts).find(i => i.id === state.inboxSelected);
    if (item?.changeId) ids.add(item.changeId);
  }
  await Promise.all([...ids].map(async id => {
    try {
      const page = await getVerdicts(state.repoId, id);
      if (gen !== state.generation) return;
      state.verdicts[id] = list(page?.data?.items);
      delete state.verdictErrors[id];
    } catch (error) {
      if (gen !== state.generation) return;
      state.verdictErrors[id] = error.status === 403 ? 'Approval history is visible to reviewers' :
        `Approval history unavailable (${redactError(error).code})`;
    }
  }));
  if (gen === state.generation) render();
}
async function poll(gen = state.generation) {
  if (!state.repoId || gen !== state.generation || state.busy) return;
  state.busy = true;
  try {
    let page;
    for (let i = 0; i < 20; i++) {
      page = await getEvents(state.repoId, state.seq);
      if (gen !== state.generation) return;
      const items = list(page?.data?.items);
      if (items.length === 0) break;
      const last = items.at(-1)?.sequence;
      if (!Number.isSafeInteger(last) || last <= state.seq) break;
      state.events.push(...items); state.events = state.events.slice(-2000); state.seq = last;
      if (last >= (page.eventSeq ?? last)) break;
    }
    if (page?.version > state.version) {
      const body = await getSnapshot(state.repoId);
      if (gen !== state.generation || body.version < page.version) return;
      state.snapshot = body; state.version = body.version;
      await refreshVerdicts(gen);
    }
    state.connected = true; render();
  } catch (error) {
    if (gen !== state.generation) return;
    if (error.status === 401) return signOut('Sign in again: this token is invalid or expired.');
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
  const live = leases().filter(l => ['active','reserved'].includes(l.state) && l.expiresAt > Date.now());
  const working = new Set(changes().filter(c => ['draft','ready','checking'].includes(c.status)).map(c => c.authorId).filter(Boolean));
  const queued = entries().filter(e => ['admitted','reserved','checking','waiting'].includes(e.state));
  const today = new Date().toDateString();
  const landed = state.events.filter(e => e.kind === 'queue.promotion_applied' && new Date(e.timestamp).toDateString() === today)
    .flatMap(e => list(e.relatedIds));
  const main = projections().queue?.observedMain ?? projections().queue?.finalCanonicalOid ??
    projections().repos?.repo?.observedCanonicalOid ?? null;
  const diagnosis = normalizeDiagnosis(projections().queue?.diagnosis);
  const mainState = diagnosis.reason === 'BASE_RED' ? 'red' :
    projections().queue?.activeStackJobId ? 'checking' :
    state.events.some(e => e.kind === 'queue.promotion_applied') ? 'green' : 'unknown';
  $('stat-strip').replaceChildren(
    stat('Agents working', working.size, 'active changes'),
    stat('Leases held', live.length, live.length ? `shortest ${leaseCountdown(live.reduce((a,b) => a.expiresAt < b.expiresAt ? a : b), Date.now()).text}` : 'no active leases'),
    stat('In queue', queued.length, 'ordered for checking'),
    stat('Landed today', landed.length, 'from observed events'),
    stat('Main', mainState, main ? `tip ${String(main).slice(0,9)}` : 'tip unavailable'),
  );
  const red = state.events.filter(e => e.kind === 'queue.diagnosis' && e.payload?.reason === 'BASE_RED' && new Date(e.timestamp).toDateString() === today).length;
  $('main-footer').replaceChildren(node('strong','main'), document.createTextNode(`${landed.length} landings today · ${red} red events · tip ${main ? String(main).slice(0,9) : 'unavailable'}`));
}
function statusFor(change) {
  const diag = normalizeDiagnosis(projections().queue?.diagnosis);
  if (diag.reason === 'SINGLETON' && diag.ids.includes(change.changeId)) return ['Blamed by bisection','red'];
  if (change.status === 'ready' && Array.isArray(state.verdicts[change.changeId]) && !state.verdicts[change.changeId].some(v => v.decision === 'approve' && v.revision === change.revision)) return ['Ready for review','blue'];
  return [change.status === 'merged' ? 'Landed' : change.status ?? 'Unknown','green'];
}
function renderBoard() {
  const board = $('work-board'); board.replaceChildren();
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
  if (!byAgent.size) box.append(node('li','No agents in this repo.','muted'));
}
function renderLeases() {
  const box=$('lease-list'); box.replaceChildren();
  const active=leases().filter(l => ['active','reserved'].includes(l.state) && l.expiresAt > Date.now());
  for (const lease of active) {
    const row=node('div',null,'lease-row');
    row.append(node('code',lease.unitKey),node('span',lease.holderId),node('span',leaseCountdown(lease,Date.now()).text));
    box.append(row);
  }
  if (!active.length) box.append(node('p','No active leases.','muted'));
  for (const refusal of list(projections().leases?.refusals)) {
    const conflict=list(refusal.conflicts)[0];
    if (!conflict || conflict.expiresAt <= Date.now() ||
      !active.some(l => l.holderId === conflict.holderId && list(refusal.keys).includes(l.unitKey))) continue;
    box.append(node('p',`${refusal.requesterId ?? 'Agent'} waits for ${list(refusal.keys).join(', ') || 'a unit'} · ${conflict?.holderId ?? 'another holder'} holds it`,'wait-note'));
  }
}
function renderQueue() {
  const box=$('queue-list'); box.replaceChildren();
  const diag=normalizeDiagnosis(projections().queue?.diagnosis);
  const active=entries().filter(e => !['withdrawn','landed'].includes(e.state));
  active.forEach((entry,index)=>{
    const c=changeFor(entry.changeId);
    const row=node('div',null,'queue-row');
    const highlight=diag.ids.includes(entry.changeId);
    if (highlight) row.classList.add('highlight');
    row.append(node('span',index+1),node('span',c?.intentText ?? entry.changeId,'row-main'),
      node('span',highlight ? diag.reason === 'SINGLETON' ? 'culprit' : 'failing set' : entry.state,highlight ? 'tone-red' : 'tone-green'));
    box.append(row);
  });
  if (!active.length) box.append(node('p','Queue empty.','muted'));
  const labels={SINGLETON:'One change failed alone',INTERACTION:'Interaction set failed together',DEPENDENCY_GROUP:'Dependency group blocked',BASE_RED:'Main baseline failed',INCONCLUSIVE:'Diagnosis inconclusive'};
  $('diagnosis').textContent=diag.reason ? `${labels[diag.reason] ?? diag.reason}: ${diag.ids.join(', ') || 'no change blamed'}` : '';
}
function renderVerdicts(id, target) {
  target.replaceChildren();
  if (state.verdictErrors[id]) { target.append(node('p',state.verdictErrors[id],'muted')); return; }
  const items=state.verdicts[id];
  if (!Array.isArray(items)) { target.append(node('p','Loading approval history…','muted')); return; }
  if (!items.length) { target.append(node('p','No verdict recorded.','muted')); return; }
  for (const v of items) {
    const card=node('div',null,'verdict-record');
    card.append(node('strong',`${v.decision} · ${v.reviewerId}`),node('p',verdictProvenance(v).summary));
    if (v.parentVerdictId) card.append(node('p',`Parent review: ${v.parentVerdictId} · delta evidence: ${v.deltaResultId ?? 'unavailable'}`));
    target.append(card);
  }
}
function addAction(target,label,handler,primary=false) {
  const b=node('button',label,primary?'primary':''); b.type='button'; b.addEventListener('click',handler); target.append(b);
}
function renderActions(target,change) {
  target.replaceChildren();
  if (!change || !state.connected) return;
  const buttons=node('div',null,'action-buttons');
  const approved=list(state.verdicts[change.changeId]).find(v => v.decision==='approve' && v.revision===change.revision);
  if (change.status==='ready' && actions().enqueue && approved) addAction(buttons,'Enqueue',()=>doEnqueue(change,approved.verdictId),true);
  if (canWithdraw(change) && entries().some(e => e.changeId===change.changeId && !['withdrawn','landed'].includes(e.state))) addAction(buttons,'Withdraw',()=>doWithdraw(change));
  target.append(buttons);
  if (change.status==='ready' && actions().verdict && state.identity?.principalId !== change.authorId) {
    const form=node('form',null,'action-form');
    const decision=node('select'); decision.name='decision';
    for(const v of ['approve','reject']) {const o=node('option',v); o.value=v; decision.append(o);}
    const manifest=node('input'); manifest.name='manifest'; manifest.required=true; manifest.placeholder='sha256:…';
    const evidence=node('input'); evidence.name='evidence'; evidence.required=true; evidence.placeholder='sha256:…';
    for(const [label,input] of [['Decision',decision],['Review manifest digest',manifest],['Evidence digest',evidence]]) {
      const wrapper=node('label',label); wrapper.append(input); form.append(wrapper);
    }
    const submit=node('button','Submit verdict','primary'); submit.type='submit'; form.append(submit);
    form.addEventListener('submit',e=>{e.preventDefault(); void doVerdict(change,decision.value,manifest.value,evidence.value);});
    target.append(form);
  }
}
function renderDetail() {
  const change=changeFor(state.selected);
  $('change-detail').hidden=!change;
  if (!change) return;
  const body=$('detail-body'); body.replaceChildren();
  body.append(node('h3',change.intentText ?? change.intentKey ?? change.changeId));
  const grid=node('div',null,'detail-grid');
  for(const [label,value] of [['Change',change.changeId],['Agent',change.authorId],['Model',modelFor(change)],['Status',change.status],['Units',list(change.unitKeys).join(', ')],['Revision',change.revision],['Base',change.baseOid],['Head',change.headOid]]) {
    if (value===null || value===undefined || value==='') continue;
    const p=node('p'); p.append(node('strong',`${label}: `),node('span',value)); grid.append(p);
  }
  body.append(grid); renderVerdicts(change.changeId,$('verdict-list')); renderActions($('action-panel'),change);
}
function renderInbox() {
  const items=deriveInbox(state.snapshot,state.verdicts);
  $('alert-count').textContent=`${items.length} decision${items.length===1?'':'s'} need you`;
  $('alert-preview').textContent=items.slice(0,3).map(i=>i.kind).join(' · ');
  $('inbox-count').textContent=`${items.length} decisions · ${state.repos.find(r=>r.repoId===state.repoId)?.displayName ?? state.repoId ?? ''}`;
  if (!items.some(i=>i.id===state.inboxSelected)) state.inboxSelected=items[0]?.id ?? null;
  const nav=$('inbox-list'); nav.replaceChildren();
  for(const item of items) {
    const b=node('button',null,'inbox-item'); b.type='button'; b.id=`inbox-${item.id.replace(/[^A-Za-z0-9_-]/g,'-')}`;
    b.setAttribute('aria-current',String(item.id===state.inboxSelected));
    b.append(node('span',item.kind,`tone-${item.tone}`),node('strong',item.title));
    b.addEventListener('click',()=>{state.inboxSelected=item.id;renderInbox();});
    nav.append(b);
  }
  const detail=$('inbox-detail'); detail.replaceChildren();
  const item=items.find(i=>i.id===state.inboxSelected);
  if (!item) {detail.append(node('p','Nothing needs a decision right now.'));return;}
  detail.append(node('span',item.kind,`tone-${item.tone}`),node('h2',item.title),node('p',item.why),node('div',item.evidence,'evidence'));
  const c=changeFor(item.changeId);
  if (c) {
    const approval=node('div'); approval.append(node('h3','Approval history')); renderVerdicts(c.changeId,approval); detail.append(approval);
    renderActions(detail,c);
  }
}
function renderTabs() {
  for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-current',String(b.dataset.tab===state.tab));
  for (const pane of document.querySelectorAll('[data-pane]')) pane.classList.toggle('active-pane',pane.dataset.pane===state.tab);
}
function render() {
  preserve(()=>{
    showSession();
    if (!hasToken() || !state.identity) return;
    $('desk-message').hidden = !state.deskMessage;
    $('desk-message').textContent = state.deskMessage ?? '';
    $('desk-view').hidden=state.view!=='desk'; $('inbox-view').hidden=state.view!=='inbox';
    if (!state.snapshot) return;
    renderStats();renderBoard();renderFleet();renderLeases();renderQueue();renderDetail();renderInbox();renderTabs();
  });
}
function selectChange(id) {
  state.selected=id; render(); $('change-detail').hidden=false;
  if (!Object.hasOwn(state.verdicts,id) && !state.verdictErrors[id]) void refreshVerdicts();
  $('change-detail').scrollIntoView?.({block:'nearest'});
}
function mutationStatus(message) { $('mutation-status').textContent=message; }
async function mutate(label,call) {
  if (!state.connected || !state.snapshot) return mutationStatus('Current snapshot is unavailable. Refresh before acting.');
  const gen=state.generation; mutationStatus(`${label}…`);
  try {
    await call(); if(gen!==state.generation)return;
    await loadRepo(gen,false); mutationStatus(`${label}: accepted.`);
  } catch(error) {
    if(gen!==state.generation)return;
    mutationStatus(`${label}: ${error.status===409?'stale or conflicting context':'failed'} (${redactError(error).code}). Refreshing.`);
    await loadRepo(gen,false);
  }
}
function doEnqueue(change,verdictId) {
  const version=state.snapshot?.version;
  const findingSetVersion=projections().findings?.findingSetVersions?.[change.changeId];
  const evidence=mutationEvidence(change,leases(),findingSetVersion);
  if(evidence.error || !Number.isSafeInteger(version)) return mutationStatus(evidence.error ?? 'Current version unavailable.');
  void mutate('Enqueue',()=>enqueueChange(state.repoId,{changeId:change.changeId,expectedVersion:version,verdictId,leaseFences:evidence.leaseFences},newIdempotencyKey()));
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
  $('demo-open').hidden=!demo;
  $('demo-open').addEventListener('click',()=>{if(demo) void signIn(demo,window.CONCORD_DEMO_REPO_ID);});
  $('token-form').addEventListener('submit',e=>{e.preventDefault();const token=$('token-input').value.trim();if(token)void signIn(token);});
  $('token-clear').addEventListener('click',()=>signOut());
  $('repo-select').addEventListener('change',()=>{state.repoId=$('repo-select').value; ++state.generation;void loadRepo();});
  $('inbox-alert').addEventListener('click',()=>{state.view='inbox';render();});
  $('back-desk').addEventListener('click',()=>{state.view='desk';render();});
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
  window.setInterval(()=>{if(hasToken()&&state.repoId)void poll();},1000);
  void getHealth().then(body=>{const info=environmentBadge(body?.data,false);$('env-badge').textContent=info.label==='live Artifacts'?'Live · Cloudflare Artifacts':info.label;}).catch(()=>{$('env-badge').textContent='Backend unavailable';});
  render();
}
boot();
