import { getRepoFile, getRepoReadme, getRepoTree, redactError } from './api.js';
import { approximateTokens, redactForDisplay } from './views.js';

const element = (tag, value, className) => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = String(value);
  if (className) node.className = className;
  return node;
};
const array = value => Array.isArray(value) ? value : [];
const errorCopy = error => error?.status === 404 ? 'Not found on canonical main.' :
  error?.status === 403 ? 'Your token cannot read this repository.' :
    error?.code === 'READ_RATE_LIMITED' ? `Busy, retrying in ${error.retryAfter ?? 60}s` :
    `Could not load (${error?.code ?? redactError(error).code}).`;

/** Small Markdown subset. Text nodes keep raw HTML inert. */
function renderSafeMarkdown(target, source) {
  const doc = target.ownerDocument;
  target.replaceChildren();
  let list = null;
  let code = null;
  for (const line of String(source ?? '').split(/\r?\n/)) {
    if (line.startsWith('```')) { code = code ? null : target.appendChild(doc.createElement('pre')); list = null; continue; }
    if (code) { code.textContent += `${line}\n`; continue; }
    if (!line.trim()) { list = null; continue; }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { const h = doc.createElement(`h${heading[1].length}`); h.textContent = heading[2]; target.append(h); list = null; continue; }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) { if (!list) { list = doc.createElement('ul'); target.append(list); } const li = doc.createElement('li'); li.textContent = bullet[1]; list.append(li); continue; }
    const paragraph = doc.createElement('p'); paragraph.textContent = line; target.append(paragraph); list = null;
  }
}

export function createRepoPage(root, api = { getRepoTree, getRepoFile, getRepoReadme }, selectChange = null) {
  const element = (tag, value, className) => {
    const node = root.ownerDocument.createElement(tag);
    if (value !== undefined) node.textContent = String(value);
    if (className) node.className = className;
    return node;
  };
  let repoId = null;
  let oid = null;
  let path = '';
  let audience = 'human';
  let snapshot = null;
  let version = null;
  let generation = 0;
  let tree = null;
  let readme = null;
  let readmeError = null;
  let docs = [];
  let docsError = null;
  let unitFiles = {};
  let rowTables = {};
  let selectedFile = null;
  let error = null;
  let retryMessage = null;
  let cloneOpen = false;
  let cloneTab = 'Git';
  const expandedChanges = new Set();
  const codeReadCache = new Map();
  const button = (label, action, className) => { const b = element('button', label, className); b.type = 'button'; b.addEventListener('click', action); return b; };
  const card = (title, className = '') => { const section = element('section', undefined, `repo-card ${className}`); section.setAttribute('aria-label', title); section.append(element('h2', title)); return section; };
  const held = () => array(snapshot?.data?.projections?.leases?.heldItems ?? snapshot?.data?.projections?.leases?.items)
    .filter(lease => ['active', 'reserved'].includes(lease.state) && lease.expiresAt > Date.now());
  const workingNow = () => held().filter(lease => lease.state === 'active');
  const workingGroups = () => {
    const changes = array(snapshot?.data?.projections?.repos?.changes);
    const issues = array(snapshot?.data?.projections?.issues?.items);
    const groups = new Map();
    for (const lease of workingNow()) {
      if (!lease.changeId) continue;
      const group = groups.get(lease.changeId) ?? { changeId: lease.changeId, leases: [], latest: 0 };
      group.leases.push(lease);
      group.latest = Math.max(group.latest, Number(lease.createdAt ?? lease.expiresAt ?? 0));
      groups.set(lease.changeId, group);
    }
    const result = [...groups.values()].map(group => {
      const change = changes.find(item => item.changeId === group.changeId) ?? {};
      const issueNumber = change.issueNumber ?? group.leases.find(lease => lease.issueNumber != null)?.issueNumber;
      const issue = issues.find(item => item.number === issueNumber);
      const lease = group.leases[0];
      return { ...group, change, issueNumber, issueTitle: issue?.title ?? lease.issueTitle ?? null };
    }).sort((a, b) => b.leases.length - a.leases.length || b.latest - a.latest);
    const active = new Set(result.map(group => group.changeId));
    for (const changeId of expandedChanges) if (!active.has(changeId)) expandedChanges.delete(changeId);
    return result;
  };
  const timeLeft = lease => {
    const seconds = Number.isFinite(lease.remainingSeconds)
      ? lease.remainingSeconds : Math.max(0, Math.ceil((lease.expiresAt - Date.now()) / 1000));
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    return `${minutes} min left`;
  };
  const claimed = entryPath => held().filter(lease => {
    const key = String(lease.unitKey ?? '');
    const rowTable = key.startsWith('row:') ? key.split(':')[1] : null;
    const file = unitFiles[key] ?? (rowTable ? rowTables[rowTable] : null);
    return typeof file === 'string' && (file === entryPath || file.startsWith(`${entryPath}/`));
  });
  const latest = () => {
    const landings = array(snapshot?.data?.projections?.queue?.entries).filter(item => item.state === 'landed');
    const entry = landings.at(-1);
    const change = array(snapshot?.data?.projections?.repos?.changes).find(item => item.changeId === entry?.changeId);
    return { entry, change };
  };
  const relativeTime = timestamp => {
    const value = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp ?? '');
    if (!Number.isFinite(value)) return null;
    const minutes = Math.max(0, Math.floor((Date.now() - value) / 60000));
    return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
  };
  function drawClonePanel() {
    if (!cloneOpen) return;
    const panel = element('section', undefined, 'clone-panel');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'clone-heading');
    const heading = element('div', undefined, 'clone-heading-row');
    const title = element('h2', 'Clone repository'); title.id = 'clone-heading';
    heading.append(title, button('Close', closeClone, 'clone-close'));
    panel.append(heading);
    const tabs = element('div', undefined, 'clone-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Clone options');
    for (const name of ['Git', 'Concord', 'GitHub mirror']) {
      const tab = button(name, () => { cloneTab = name; draw(); });
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(cloneTab === name)); tab.id = `clone-tab-${name.toLowerCase().replaceAll(' ', '-')}`;
      tabs.append(tab);
    }
    panel.append(tabs);
    const command = cloneTab === 'Git'
      ? `npm run concord -- repo clone --repo ${repoId} --path ./${repoId}`
      : cloneTab === 'Concord'
        ? `npm run concord -- start --repo ${repoId} --intent-key task-17 --intent 'Tune gamma safely' --allowed-files allowed-files.txt --json\nnpm run concord -- land --repo ${repoId} --source . --commit FULL_OID --intent-key task-17 --intent 'Tune gamma safely' --allowed-files allowed-files.txt`
        : repoId === 'concord-v2' ? 'https://github.com/seb-patron/concord' : 'No mirror configured';
    const code = element('pre', command); code.id = 'clone-command'; panel.append(code);
    if (cloneTab === 'Concord') panel.append(element('p', 'Commands follow docs/cli.md.', 'clone-source'));
    const copy = button('Copy', async () => {
      try { await navigator.clipboard.writeText(command); copy.textContent = 'Copied'; }
      catch { copy.textContent = 'Copy unavailable'; }
    }, 'clone-copy');
    copy.setAttribute('aria-label', `Copy ${cloneTab} ${cloneTab === 'GitHub mirror' ? 'URL' : 'commands'}`);
    panel.append(copy); root.append(panel);
    panel.querySelector('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }
  function closeClone() { cloneOpen = false; draw(); root.querySelector('.code-button')?.focus(); }
  function onCloneKey(event) {
    if (!cloneOpen) return;
    if (event.key === 'Escape') { event.preventDefault(); closeClone(); }
    if (event.key === 'Tab') {
      const focusable = [...root.querySelectorAll('.clone-panel button')];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && root.ownerDocument.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && root.ownerDocument.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
  root.ownerDocument.addEventListener('keydown', onCloneKey);
  function draw() {
    root.replaceChildren();
    if (!repoId) { root.append(element('p', 'Choose a repository to view its code.')); return; }
    const top = element('div', undefined, 'repo-toolbar');
    const group = element('div', undefined, 'repo-audience'); group.setAttribute('role', 'group'); group.setAttribute('aria-label', 'Audience');
    for (const [value, label] of [['human', 'For humans'], ['agent', 'For agents']]) {
      const control = button(label, () => { audience = value; selectedFile = null; draw(); if (value === 'agent' && !docs.length && repoId) void load(); });
      control.setAttribute('aria-pressed', String(audience === value)); group.append(control);
    }
    top.append(group, element('span', audience === 'human' ? 'README, files and activity, written for humans.' : 'Repository snapshot (GET /snapshot, what repo_context fetches; MCP also redacts registered secrets).', 'repo-note'));
    const meta = element('div', undefined, 'repo-meta');
    const details = element('div', undefined, 'repo-code-details');
    details.append(element('span', 'main', 'branch-chip'), element('code', oid ? oid.slice(0, 7) : 'empty', 'commit-oid'));
    const recent = latest();
    const landingLabel = recent.change ? `${recent.change.intentText ?? `Change ${recent.change.changeId}`} · ${recent.change.authorModel ?? recent.change.authorId ?? 'author unavailable'}` : recent.entry ? `Change ${recent.entry.changeId} landed` : 'No landing recorded yet';
    const age = relativeTime(recent.change?.updatedAt ?? recent.change?.landedAt ?? recent.entry?.landedAt ?? recent.entry?.createdAt ?? recent.entry?.timestamp);
    details.append(element('span', age ? `${landingLabel} · ${age}` : landingLabel, 'latest-landing'));
    const changes = array(snapshot?.data?.projections?.repos?.changes);
    const landedCount = array(snapshot?.data?.projections?.queue?.entries).filter(item => item.state === 'landed').length;
    const openCount = changes.filter(change => !['merged', 'closed', 'withdrawn'].includes(change.status)).length;
    const fileCount = tree ? tree.filter(entry => entry.type === 'blob').length : null;
    details.append(element('span', `${landedCount} changes landed · ${openCount} open changes · ${fileCount ?? '—'} ${fileCount === 1 ? 'file' : 'files'}`, 'repo-counts'));
    meta.append(details);
    const cloneButton = button('Code', () => { cloneOpen = true; draw(); }, 'code-button');
    cloneButton.setAttribute('aria-haspopup', 'dialog'); cloneButton.setAttribute('aria-expanded', String(cloneOpen));
    meta.append(cloneButton); top.append(meta); root.append(top);
    drawClonePanel();
    if (error) root.append(element('p', error, 'repo-error'));
    if (retryMessage) root.append(element('p', retryMessage, 'repo-error'));
    if (audience === 'agent') drawAgent(); else drawHuman();
  }
  async function readWithRetry(read) {
    try { return await read(); }
    catch (cause) {
      if (cause?.code !== 'READ_RATE_LIMITED') throw cause;
      const seconds = Number.isSafeInteger(cause.retryAfter) && cause.retryAfter >= 0 ? cause.retryAfter : 60;
      retryMessage = `Busy, retrying in ${seconds}s`;
      draw();
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      retryMessage = null;
      draw();
      return read();
    }
  }
  function drawHuman() {
    const layout = element('div', undefined, 'repo-layout');
    const primary = element('div', undefined, 'repo-primary');
    const files = card('Files');
    const recent = latest();
    files.append(element('p', recent.change ? `${recent.change.intentText ?? 'Change'} landed by ${recent.change.authorModel ?? recent.change.authorId ?? 'author unavailable'}` : recent.entry ? `Change ${recent.entry.changeId} landed` : 'No landing recorded yet.', 'repo-landing'));
    const crumbs = element('nav', undefined, 'repo-crumbs'); crumbs.setAttribute('aria-label', 'Directory');
    crumbs.append(button(repoId, () => navigate('')));
    let current = '';
    for (const part of path.split('/').filter(Boolean)) { current = current ? `${current}/${part}` : part; const next = current; crumbs.append(element('span', '/'), button(part, () => navigate(next))); }
    files.append(crumbs);
    if (tree === null) files.append(element('p', error ? 'Could not list this directory.' : oid ? 'Loading files…' : 'Canonical main has no files yet.', 'repo-empty'));
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
    else if (readmeError && !selectedFile) documentBody.append(element('p', readmeError, 'repo-error'));
    else documentBody.append(element('p', oid ? 'README.md is unavailable or has not loaded.' : 'README.md will appear after the first landing.'));
    documentCard.append(documentBody); primary.append(documentCard);
    const aside = element('aside', undefined, 'repo-aside');
    const about = card('About');
    const issues = array(snapshot?.data?.projections?.issues?.items).filter(item => item.state === 'open');
    const groups = workingGroups();
    const landings = array(snapshot?.data?.projections?.queue?.entries).filter(item => item.state === 'landed');
    const stats = element('dl', undefined, 'repo-stats');
    for (const [label, value] of [['Open issues', issues.length], ['Agents now', groups.length], ['Observed landings', landings.length], ['Backup', 'Not reported']]) {
      const cell = element('div'); cell.append(element('dt', label), element('dd', value)); stats.append(cell);
    }
    about.append(stats); aside.append(about);
    const working = card(`Working now · ${groups.length} agents`, 'repo-working-card');
    if (!groups.length) working.append(element('p', 'No agents hold a live claim.', 'repo-empty'));
    else {
      const list = element('ul', undefined, `repo-working-list${groups.length >= 8 ? ' repo-working-list-scroll' : ''}`);
      for (const group of groups) {
        const row = element('li', undefined, `repo-working-row${expandedChanges.has(group.changeId) ? ' repo-working-row-expanded' : ''}`);
        const disclosure = button(expandedChanges.has(group.changeId) ? '▾' : '▸', () => {
          if (expandedChanges.has(group.changeId)) expandedChanges.delete(group.changeId);
          else expandedChanges.add(group.changeId);
          draw();
        }, 'repo-working-disclosure');
        disclosure.setAttribute('aria-expanded', String(expandedChanges.has(group.changeId)));
        disclosure.setAttribute('aria-label', `${expandedChanges.has(group.changeId) ? 'Collapse' : 'Expand'} files for ${group.changeId}`);
        const model = group.change.authorModel ?? group.leases[0].holderId;
        const effort = group.change.authorEffort ?? group.change.effort;
        const modelLabel = effort ? `${model} · ${effort}` : model;
        const modelChip = element('span', modelLabel, 'repo-working-model');
        const title = group.issueNumber != null
          ? `${group.issueTitle ?? ''}`
          : group.change.intentText ?? group.leases[0].intentText ?? group.changeId;
        const shortTitle = group.issueNumber != null ? `#${group.issueNumber}${title ? ` ${title}` : ''}` : title;
        const titleButton = button(shortTitle, () => selectChange?.(group.changeId), 'repo-working-title');
        titleButton.title = shortTitle;
        const count = element('span', `${group.leases.length} ${group.leases.length === 1 ? 'file' : 'files'}`, 'repo-working-count');
        row.append(disclosure, modelChip, titleButton, count);
        if (expandedChanges.has(group.changeId)) {
          const branch = String(group.change.branch ?? 'Branch unavailable').split('/').at(-1);
          row.append(element('div', branch, 'repo-working-branch'));
          const units = element('ul', undefined, 'repo-working-units');
          for (const lease of group.leases) {
            const unit = element('li'); unit.append(element('code', lease.unitKey), element('span', timeLeft(lease)));
            units.append(unit);
          }
          row.append(units);
        }
        list.append(row);
      }
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
    const context = card('Repository snapshot');
    const json = snapshot ? JSON.stringify(redactForDisplay(snapshot), null, 2) : '';
    context.append(element('p', snapshot ? `${approximateTokens(json)} estimated tokens · generated from main ${oid?.slice(0, 7) ?? 'empty'} · credentials shown as [REDACTED] like the MCP output` : 'Context unavailable.', 'repo-note'));
    context.append(element('pre', json || 'Load a repository to see its context.'));
    primary.append(context);
    const agentDocs = card('Agent docs (agents/ and AGENTS.md)');
    agentDocs.append(element('p', 'Short, imperative, checkable. A convention here can carry a check, so the queue enforces it rather than hoping an agent reads it.'));
    if (docsError) agentDocs.append(element('p', docsError, 'repo-error'));
    if (!docs.length && !docsError) agentDocs.append(element('p', 'No agent docs on canonical main.', 'repo-empty'));
    if (docs.length) {
      const list = element('ul', undefined, 'repo-doc-list');
      for (const doc of docs) {
        const item = element('li');
        item.append(button(doc.path, () => { selectedFile = doc; draw(); }), element('span', doc.missing ? 'not present' : `${approximateTokens(doc.content)} estimated tokens`));
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
    tree = null; readme = null; readmeError = null; docs = []; docsError = null; unitFiles = {}; rowTables = {}; selectedFile = null; error = null; draw();
    if (!repoId) return;
    const currentRepo = repoId, currentOid = oid;
    const readFailure = settled => settled.status === 'rejected' && settled.reason?.status !== 404 ? errorCopy(settled.reason) : null;
    const rootResult = await Promise.allSettled([readWithRetry(() => api.getRepoTree(currentRepo, path, currentOid))]).then(items => items[0]);
    if (run !== generation) return;
    if (rootResult.status === 'rejected' && rootResult.reason?.status === 404 && path) { path = ''; return load(); }
    if (rootResult.status === 'fulfilled') {
      tree = array(rootResult.value.data.entries);
      unitFiles = rootResult.value.data.unitFiles ?? {};
      rowTables = rootResult.value.data.rowTables ?? {};
    } else error = errorCopy(rootResult.reason);
    const resolvedOid = rootResult.status === 'fulfilled' ? rootResult.value.data.oid : currentOid;
    if (resolvedOid) oid = resolvedOid;
    const cacheKey = `${currentRepo}:${resolvedOid}`;
    const cached = codeReadCache.get(cacheKey) ?? { docsLoaded: false };
    if (!path && !cached.readmeLoaded) {
      const readmeResult = await Promise.allSettled([readWithRetry(() => api.getRepoReadme(currentRepo, resolvedOid))]).then(items => items[0]);
      if (run !== generation) return;
      cached.readme = readmeResult.status === 'fulfilled' ? readmeResult.value.data : null;
      cached.readmeError = readFailure(readmeResult); cached.readmeLoaded = true;
    }
    if (audience === 'agent' && !cached.docsLoaded) {
      const result = await Promise.allSettled([
        readWithRetry(() => api.getRepoTree(currentRepo, 'agents', resolvedOid)),
        readWithRetry(() => api.getRepoFile(currentRepo, 'AGENTS.md', resolvedOid)),
      ]);
      if (run !== generation) return;
      const paths = result[0].status === 'fulfilled' ? array(result[0].value.data.entries).filter(entry => entry.type === 'blob' && entry.name.endsWith('.md')).slice(0, 20).map(entry => `agents/${entry.name}`) : [];
      cached.docs = result[1].status === 'fulfilled' ? [result[1].value.data] : [];
      if (result[1].status === 'rejected' && result[1].reason?.status === 404) cached.docs.push({ path: 'AGENTS.md', content: '', missing: true });
      cached.docsError = readFailure(result[0]) ?? readFailure(result[1]);
      for (let at = 0; at < paths.length; at += 4) {
        const found = await Promise.allSettled(paths.slice(at, at + 4).map(doc => readWithRetry(() => api.getRepoFile(currentRepo, doc, resolvedOid))));
        if (run !== generation) return;
        cached.docs.push(...found.filter(item => item.status === 'fulfilled').map(item => item.value.data));
        cached.docsError = cached.docsError ?? found.map(readFailure).find(message => message !== null) ?? null;
      }
      cached.docsLoaded = true;
    }
    codeReadCache.set(cacheKey, cached);
    readme = cached.readme ?? null; readmeError = cached.readmeError ?? null;
    docs = cached.docs ?? []; docsError = cached.docsError ?? null;
    draw();
  }
  function navigate(next) { path = next; void load().catch(cause => { error = errorCopy(cause); draw(); }); }
  async function openFile(next) {
    const run = ++generation;
    try { const response = await readWithRetry(() => api.getRepoFile(repoId, next, oid)); if (run !== generation) return; selectedFile = response.data; error = null; }
    catch (cause) { if (run !== generation) return; error = errorCopy(cause); }
    draw();
  }
  return {
    show(nextRepoId, nextSnapshot) {
      const observedOid = nextSnapshot?.data?.projections?.queue?.observedMain ??
        nextSnapshot?.data?.projections?.repos?.repo?.observedCanonicalOid ?? null;
      const repoChanged = nextRepoId !== repoId;
      const nextOid = repoChanged ? observedOid : observedOid ?? oid;
      const changed = repoChanged || nextOid !== oid;
      const nextVersion = nextSnapshot?.version ?? null;
      if (!changed && nextVersion === version && root.childNodes.length) return;
      repoId = nextRepoId; oid = nextOid; snapshot = nextSnapshot; version = nextVersion;
      if (changed) { if (repoChanged) path = ''; void load().catch(cause => { error = errorCopy(cause); draw(); }); } else draw();
    },
    hide() { ++generation; cloneOpen = false; repoId = null; oid = null; version = null; root.replaceChildren(); },
  };
}
