import { getRepoFile, getRepoReadme, getRepoTree, redactError } from './api.js';
import { approximateTokens } from './views.js';

const element = (tag, value, className) => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = String(value);
  if (className) node.className = className;
  return node;
};
const array = value => Array.isArray(value) ? value : [];
const errorCopy = error => error?.status === 404 ? 'Not found on canonical main.' :
  error?.status === 403 ? 'Your token cannot read this repository.' :
    `Could not load (${redactError(error).code}).`;

/** Small Markdown subset. Text nodes keep raw HTML inert. */
function renderSafeMarkdown(target, source) {
  target.replaceChildren();
  let list = null;
  let code = null;
  for (const line of String(source ?? '').split(/\r?\n/)) {
    if (line.startsWith('```')) { code = code ? null : target.appendChild(document.createElement('pre')); list = null; continue; }
    if (code) { code.textContent += `${line}\n`; continue; }
    if (!line.trim()) { list = null; continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { const h = document.createElement(`h${heading[1].length}`); h.textContent = heading[2]; target.append(h); list = null; continue; }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) { if (!list) { list = document.createElement('ul'); target.append(list); } const li = document.createElement('li'); li.textContent = bullet[1]; list.append(li); continue; }
    const paragraph = document.createElement('p'); paragraph.textContent = line; target.append(paragraph); list = null;
  }
}

export function createRepoPage(root, api = { getRepoTree, getRepoFile, getRepoReadme }) {
  let repoId = null;
  let oid = null;
  let path = '';
  let audience = 'human';
  let snapshot = null;
  let version = null;
  let generation = 0;
  let tree = null;
  let readme = null;
  let docs = [];
  let unitFiles = {};
  let rowTables = {};
  let selectedFile = null;
  let error = null;
  const button = (label, action, className) => { const b = element('button', label, className); b.type = 'button'; b.addEventListener('click', action); return b; };
  const card = (title, className = '') => { const section = element('section', undefined, `repo-card ${className}`); section.setAttribute('aria-label', title); section.append(element('h2', title)); return section; };
  const held = () => array(snapshot?.data?.projections?.leases?.heldItems ?? snapshot?.data?.projections?.leases?.items)
    .filter(lease => ['active', 'reserved'].includes(lease.state) && lease.expiresAt > Date.now());
  const workingNow = () => held().filter(lease => lease.state === 'active');
  const claimed = entryPath => held().filter(lease => {
    const key = String(lease.unitKey ?? '');
    const rowTable = key.startsWith('row:') ? key.split(':')[1] : null;
    const file = unitFiles[key] ?? (rowTable ? rowTables[rowTable] : null) ?? (key.startsWith('file:') ? key.slice(5) : key);
    return file === entryPath || file.startsWith(`${entryPath}/`);
  });
  const latest = () => {
    const landings = array(snapshot?.data?.projections?.queue?.entries).filter(item => item.state === 'landed');
    const entry = landings.at(-1);
    const change = array(snapshot?.data?.projections?.repos?.changes).find(item => item.changeId === entry?.changeId);
    return change ? `${change.intentText} landed by ${change.authorModel ?? change.authorId}` : entry ? `Change ${entry.changeId} landed` : 'No landing recorded yet.';
  };
  function draw() {
    root.replaceChildren();
    if (!repoId) { root.append(element('p', 'Choose a repository to view its code.')); return; }
    const top = element('div', undefined, 'repo-toolbar');
    const group = element('div', undefined, 'repo-audience'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Audience');
    for (const [value, label] of [['human', 'For humans'], ['agent', 'For agents']]) {
      const control = button(label, () => { audience = value; selectedFile = null; draw(); });
      control.setAttribute('aria-pressed', String(audience === value)); group.append(control);
    }
    top.append(group, element('span', audience === 'human' ? 'README, files and activity, written for humans.' : 'Exactly what an agent gets: small, generated, enforceable.', 'repo-note'));
    const meta = element('div', undefined, 'repo-meta');
    meta.append(element('code', `main · ${oid ? oid.slice(0, 7) : 'empty'}`), element('code', `npm run concord -- repo clone --repo ${repoId} --path './${repoId}'`));
    top.append(meta); root.append(top);
    if (error) root.append(element('p', error, 'repo-error'));
    if (audience === 'agent') drawAgent(); else drawHuman();
  }
  function drawHuman() {
    const layout = element('div', undefined, 'repo-layout');
    const primary = element('div', undefined, 'repo-primary');
    const files = card('Files');
    files.append(element('p', latest(), 'repo-landing'));
    const crumbs = element('nav', undefined, 'repo-crumbs'); crumbs.setAttribute('aria-label', 'Directory');
    crumbs.append(button(repoId, () => navigate('')));
    let current = '';
    for (const part of path.split('/').filter(Boolean)) { current = current ? `${current}/${part}` : part; const next = current; crumbs.append(element('span', '/'), button(part, () => navigate(next))); }
    files.append(crumbs);
    if (tree === null) files.append(element('p', oid ? 'Loading files…' : 'Canonical main has no files yet.', 'repo-empty'));
    else if (!tree.length) files.append(element('p', 'This directory is empty.', 'repo-empty'));
    else {
      const listing = element('ul', undefined, 'repo-files');
      for (const entry of tree) {
        const entryPath = path ? `${path}/${entry.name}` : entry.name;
        const row = element('li');
        row.append(button(`${entry.type === 'tree' ? '▸' : '·'} ${entry.name}${entry.type === 'tree' ? '/' : ''}`, () => entry.type === 'tree' ? navigate(entryPath) : openFile(entryPath)));
        const claims = claimed(entryPath);
        row.append(element('span', claims.length ? `${claims.length} claimed` : 'free', claims.length ? 'repo-claimed' : 'repo-free'));
        listing.append(row);
      }
      files.append(listing);
    }
    primary.append(files);
    const documentCard = card(selectedFile?.path ?? 'README');
    documentCard.append(element('div', selectedFile ? `${selectedFile.path} · for humans` : 'README.md · for humans', 'repo-document-label'));
    const documentBody = element('div', undefined, 'repo-markdown');
    const content = selectedFile?.content ?? readme?.content;
    if (content !== undefined) renderSafeMarkdown(documentBody, content);
    else documentBody.append(element('p', oid ? 'README.md is unavailable or has not loaded.' : 'README.md will appear after the first landing.'));
    documentCard.append(documentBody); primary.append(documentCard);
    const aside = element('aside', undefined, 'repo-aside');
    const about = card('About');
    const issues = array(snapshot?.data?.projections?.issues?.items).filter(item => item.state === 'open');
    const agents = new Set(workingNow().map(lease => lease.holderId));
    const landings = array(snapshot?.data?.projections?.queue?.entries).filter(item => item.state === 'landed');
    const stats = element('dl', undefined, 'repo-stats');
    for (const [label, value] of [['Open issues', issues.length], ['Agents now', agents.size], ['Observed landings', landings.length], ['Backup', 'Not reported']]) {
      const cell = element('div'); cell.append(element('dt', label), element('dd', value)); stats.append(cell);
    }
    about.append(stats); aside.append(about);
    const working = card('Working now');
    if (!workingNow().length) working.append(element('p', 'No agents hold a live claim.', 'repo-empty'));
    else {
      const list = element('ul');
      for (const lease of workingNow()) list.append(element('li', `${lease.holderId} on ${lease.issueNumber ? `#${lease.issueNumber} · ` : ''}${lease.unitKey}`));
      working.append(list);
    }
    aside.append(working);
    const humanDocs = card('Docs for humans');
    humanDocs.append(element('p', 'Browse docs/ in the file list.', 'repo-empty'));
    aside.append(humanDocs);
    layout.append(primary, aside); root.append(layout);
  }
  function drawAgent() {
    const layout = element('div', undefined, 'repo-layout');
    const primary = element('div', undefined, 'repo-primary');
    const context = card('What an agent receives: repo_context');
    const json = snapshot ? JSON.stringify(snapshot, null, 2) : '';
    context.append(element('p', snapshot ? `${approximateTokens(json)} estimated tokens · generated from main ${oid?.slice(0, 7) ?? 'empty'}` : 'Context unavailable.', 'repo-note'));
    context.append(element('pre', json || 'Load a repository to see its context.'));
    primary.append(context);
    const agentDocs = card('Agent docs (agents/ and AGENTS.md)');
    agentDocs.append(element('p', 'Short, imperative, checkable. A convention here can carry a check, so the queue enforces it rather than hoping an agent reads it.'));
    if (!docs.length) agentDocs.append(element('p', 'No agent docs on canonical main.', 'repo-empty'));
    else {
      const list = element('ul', undefined, 'repo-doc-list');
      for (const doc of docs) {
        const item = element('li');
        item.append(button(doc.path, () => { selectedFile = doc; draw(); }), element('span', `${approximateTokens(doc.content)} estimated tokens`));
        list.append(item);
      }
      agentDocs.append(list);
    }
    if (selectedFile && docs.some(doc => doc.path === selectedFile.path)) {
      const preview = card(selectedFile.path); preview.append(element('pre', selectedFile.content)); primary.append(agentDocs, preview);
    } else primary.append(agentDocs);
    const aside = element('aside', undefined, 'repo-aside');
    const separation = card('Kept apart on purpose');
    const points = element('ul');
    for (const point of ['Human docs never enter an agent’s context unless an agent doc links them.', 'Agent context is generated from the policy and main, so it cannot go stale.', 'Humans edit issues and docs in the UI. Agents only see the resulting spec and units.']) points.append(element('li', point));
    separation.append(points); aside.append(separation);
    const connect = card('Connect any agent'); connect.append(element('pre', 'concord connect --agent claude-code\nconcord connect --agent codex\nconcord connect --agent cursor')); aside.append(connect);
    layout.append(primary, aside); root.append(layout);
  }
  async function load() {
    const run = ++generation;
    tree = null; readme = null; docs = []; unitFiles = {}; rowTables = {}; selectedFile = null; error = null; draw();
    if (!repoId || !oid) return;
    const currentRepo = repoId, currentOid = oid;
    const result = await Promise.allSettled([
      api.getRepoTree(currentRepo, path, currentOid), api.getRepoReadme(currentRepo, currentOid), api.getRepoTree(currentRepo, 'agents', currentOid), api.getRepoFile(currentRepo, 'AGENTS.md', currentOid),
    ]);
    if (run !== generation) return;
    tree = result[0].status === 'fulfilled' ? array(result[0].value.data.entries) : [];
    unitFiles = result[0].status === 'fulfilled' ? result[0].value.data.unitFiles ?? {} : {};
    rowTables = result[0].status === 'fulfilled' ? result[0].value.data.rowTables ?? {} : {};
    readme = result[1].status === 'fulfilled' ? result[1].value.data : null;
    if (result[0].status === 'rejected') error = errorCopy(result[0].reason);
    const paths = result[2].status === 'fulfilled' ? array(result[2].value.data.entries).filter(entry => entry.type === 'blob' && entry.name.endsWith('.md')).map(entry => `agents/${entry.name}`) : [];
    docs = result[3].status === 'fulfilled' ? [result[3].value.data] : [];
    const found = await Promise.allSettled(paths.map(doc => api.getRepoFile(currentRepo, doc, currentOid)));
    if (run !== generation) return;
    docs.push(...found.filter(item => item.status === 'fulfilled').map(item => item.value.data));
    draw();
  }
  function navigate(next) { path = next; void load(); }
  async function openFile(next) {
    const run = ++generation;
    try { const response = await api.getRepoFile(repoId, next, oid); if (run !== generation) return; selectedFile = response.data; error = null; }
    catch (cause) { if (run !== generation) return; error = errorCopy(cause); }
    draw();
  }
  return {
    show(nextRepoId, nextSnapshot) {
      const nextOid = nextSnapshot?.data?.projections?.repos?.repo?.observedCanonicalOid ?? null;
      const changed = nextRepoId !== repoId || nextOid !== oid;
      const nextVersion = nextSnapshot?.version ?? null;
      if (!changed && nextVersion === version && root.childNodes.length) return;
      repoId = nextRepoId; oid = nextOid; snapshot = nextSnapshot; version = nextVersion;
      if (changed) { path = ''; void load(); } else draw();
    },
    hide() { ++generation; repoId = null; oid = null; version = null; root.replaceChildren(); },
  };
}
