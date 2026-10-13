/**
 * Concord plan screen.
 *
 * A human plans a batch of issues like a spreadsheet: title, touches (declared
 * units), depends on, and milestone. Before any agent starts, the screen shows
 * which rows collide over shared units, which wait on dependencies, and how
 * many agents could start at once. Publishing creates or updates issues one
 * row at a time and reports per-row errors.
 *
 * Data conventions (documented in docs/ui.md):
 * - "Touches" is persisted as the issue's `allowedFiles` list.
 * - "Depends on" is persisted as `dep:NUMBER` labels; other labels are kept.
 * - Unit text separates entries with `·`, `,`, or newlines. `path` or
 *   `file:path` is a whole-file unit that covers `path § section`,
 *   `row:path:name`, `fn:path:name`, and `section:path:name`. A bare
 *   `§ section` is its own unit.
 *
 * Pure helpers are exported for tests; `mountPlan` wires the DOM. Nothing here
 * renders markup text as HTML — every value goes through textContent.
 */

import { createIssue, newIdempotencyKey, redactError, updateIssue } from './api.js';
import { safeText } from './views.js';

const DEP_LABEL = /^dep:(\d+)$/;
const SUB_PREFIX = /^(row|fn|section|sym|test):(.+)$/;
const MAX_UNITS = 100;
const MAX_UNIT_LENGTH = 256;
const MAX_TITLE = 256;
const MAX_IMPORT_TITLES = 50;

/** Issue numbers referenced by `dep:NUMBER` labels on one issue. */
export function depNumbers(labels) {
  const deps = [];
  for (const label of Array.isArray(labels) ? labels : []) {
    const match = DEP_LABEL.exec(String(label));
    if (match) deps.push(Number(match[1]));
  }
  return [...new Set(deps)];
}

/** Split a touches cell into unit entries. Entries keep their typed label. */
export function parseUnits(text) {
  return String(text ?? '').split(/[·,\n]/).map(part => part.trim()).filter(Boolean).map(normalizeUnit);
}

/** Split a depends-on cell into issue numbers (`#275`, `275`, comma lists). */
export function parseDepends(text) {
  const deps = [];
  for (const token of String(text ?? '').split(/[,\s]+/).map(part => part.trim()).filter(Boolean)) {
    const match = /^#?(\d+)$/.exec(token);
    if (match) deps.push(Number(match[1]));
  }
  return [...new Set(deps)];
}

/**
 * One normalized unit. `key` is the identity used for equality; `file` is set
 * when the unit names a repository file so whole-file units can cover
 * sections, rows, and functions inside it.
 */
export function normalizeUnit(raw) {
  const label = String(raw ?? '').trim();
  const sectionInFile = /^(.+?)\s*§\s*(.+)$/.exec(label);
  if (sectionInFile) return { label, key: `sec:${sectionInFile[1].trim()}:${sectionInFile[2].trim()}`, file: sectionInFile[1].trim(), kind: 'section' };
  if (label.startsWith('§')) return { label, key: `sec:*:${label.slice(1).trim()}`, file: null, kind: 'section' };
  const file = /^file:(.+)$/.exec(label);
  if (file) return { label, key: `file:${file[1].trim()}`, file: file[1].trim(), kind: 'file' };
  const sub = SUB_PREFIX.exec(label);
  if (sub && sub[2].includes(':')) {
    const cut = sub[2].lastIndexOf(':');
    const inner = sub[2].slice(0, cut).trim();
    const name = sub[2].slice(cut + 1).trim();
    if (inner && name) {
      return sub[1] === 'section'
        ? { label, key: `sec:${inner}:${name}`, file: inner, kind: 'section' }
        : { label, key: `sub:${sub[1]}:${inner}:${name}`, file: inner, kind: 'sub' };
    }
  }
  if (/[/\\]/.test(label) || /\.[A-Za-z0-9]{1,12}$/.test(label)) {
    return { label, key: `file:${label}`, file: label, kind: 'file' };
  }
  return { label, key: `key:${label}`, file: null, kind: 'opaque' };
}

/** The label of the shared unit when two units collide, else null. */
export function sharedUnit(a, b) {
  if (a.key === b.key) return a.label;
  if (a.kind === 'file' && b.file === a.file && (b.kind === 'section' || b.kind === 'sub')) return b.label;
  if (b.kind === 'file' && a.file === b.file && (a.kind === 'section' || a.kind === 'sub')) return a.label;
  return null;
}

const refOf = row => row.number != null ? `#${row.number}` : 'a new row';

/**
 * Read the issues projection into plan inputs. Returns the open issues to
 * edit, every issue keyed by number for dependency resolution, open
 * milestones for the picker, a state for honest fallbacks, and a signature so
 * the table only rebuilds when issue data actually changes.
 */
export function planIssues(snapshot) {
  const projection = snapshot?.data?.projections?.issues;
  const empty = { open: [], all: [], byNumber: new Map(), milestones: [], signature: 'none' };
  if (!snapshot || !projection || typeof projection !== 'object') return { ...empty, state: 'unknown' };
  if (projection.status === 'unavailable') return { ...empty, state: 'unavailable' };
  if (!Array.isArray(projection.items)) return { ...empty, state: 'unknown' };
  const all = projection.items.filter(item => item && typeof item === 'object');
  const byNumber = new Map();
  for (const item of all) if (Number.isSafeInteger(item.number)) byNumber.set(item.number, item);
  const open = all.filter(item => item.state === 'open');
  const milestones = (Array.isArray(projection.milestones) ? projection.milestones : [])
    .filter(item => item && typeof item === 'object');
  const signature = JSON.stringify([
    all.map(item => [item.number, item.state, item.version, item.title, item.milestoneId,
      (item.labels ?? []).join('|'), (item.allowedFiles ?? []).join('|')]),
    milestones.map(item => [item.milestoneId, item.state, item.version, item.title]),
  ]);
  return { open, all, byNumber, milestones, signature, state: 'ready' };
}

/**
 * Collision and dependency analysis over the planned rows.
 * `collides`: row key -> [{ ref, unit }] shared-unit hits against other rows.
 * `waits`: row key -> [{ dep, state }] unresolved dependencies (open target or
 * a number that is not an issue in this repository).
 * `cycles`: row keys whose dependency chain loops back to the row.
 * `startable`: greedy maximal set of dependency-free rows that do not collide
 * with an earlier startable row.
 */
export function analyzePlan(rows, byNumber = new Map()) {
  const collides = new Map();
  const waits = new Map();
  const rowFor = number => rows.find(row => row.number === number) ?? byNumber.get(number);
  for (const row of rows) {
    const hits = [];
    const seen = new Set();
    if (!row.closed) for (const other of rows) {
      if (other === row || other.closed) continue;
      for (const unit of row.units) for (const candidate of other.units) {
        const shared = sharedUnit(unit, candidate);
        const mark = shared ? `${refOf(other)}|${shared}` : null;
        if (mark && !seen.has(mark)) { seen.add(mark); hits.push({ ref: refOf(other), unit: shared }); }
      }
    }
    if (hits.length) collides.set(row.key, hits);
    const pending = [];
    for (const dep of row.deps) {
      const target = rowFor(dep);
      if (!target) pending.push({ dep, state: 'unknown' });
      else if ((target.state ?? 'open') !== 'closed') pending.push({ dep, state: 'open' });
    }
    if (pending.length) waits.set(row.key, pending);
  }
  const cycles = new Set();
  for (const row of rows) {
    const seen = new Set();
    const stack = [row];
    while (stack.length) {
      const current = stack.pop();
      for (const dep of current.deps ?? []) {
        const target = rows.find(candidate => candidate.number === dep);
        if (!target) continue;
        if (target.key === row.key) { cycles.add(row.key); continue; }
        if (!seen.has(target.key)) { seen.add(target.key); stack.push(target); }
      }
    }
  }
  const startable = new Set();
  const chosen = [];
  for (const row of rows) {
    if (row.closed || (waits.get(row.key) ?? []).length) continue;
    let blocked = false;
    for (const unit of row.units) for (const claimed of chosen) {
      if (sharedUnit(unit, claimed)) { blocked = true; break; }
    }
    if (blocked) continue;
    startable.add(row.key);
    chosen.push(...row.units);
  }
  return { collides, waits, cycles, startable };
}

/** Why one row can or cannot start, and the suggested fix. */
export function explainRow(row, analysis) {
  if (row.error) return { why: row.error, fix: 'Fix the row and publish again.' };
  if (row.closed) return { why: 'This issue is closed, so it is no longer part of the batch.', fix: 'Remove the row or reopen the issue before publishing.' };
  const waiting = analysis.waits.get(row.key) ?? [];
  const hits = analysis.collides.get(row.key) ?? [];
  const unknown = waiting.filter(item => item.state === 'unknown').map(item => `#${item.dep}`);
  const open = waiting.filter(item => item.state === 'open').map(item => `#${item.dep}`);
  const reasons = [];
  if (unknown.length) reasons.push(`Depends on ${unknown.join(', ')}, which is not an issue in this repository.`);
  if (open.length) reasons.push(`Depends on ${open.join(', ')}, still open.`);
  if (analysis.cycles.has(row.key)) reasons.push('Its dependencies loop back to this issue.');
  if (hits.length) {
    const [first, ...rest] = hits;
    reasons.push(`Shares ${first.unit} with ${first.ref}${rest.length ? `, plus ${rest.length} more overlap${rest.length === 1 ? '' : 's'}` : ''}.`);
  }
  if (!reasons.length) {
    return { why: 'Its units are free and no open issue touches them.', fix: 'Nothing to do.' };
  }
  const fix = unknown.length ? 'Correct the number or remove the dependency.'
    : analysis.cycles.has(row.key) ? 'Break the cycle: remove one direction of the dependency.'
    : hits.length && !open.length ? `Split ${hits[0].unit}, or let ${hits[0].ref} go first — Concord queues its claim automatically.`
    : `Leave it: it becomes claimable when ${open[0] ?? hits[0]?.ref ?? 'the dependency'} lands.`;
  return { why: reasons.join(' '), fix };
}

/** One-line summary under the startable count, like the approved prototype. */
export function planNote(rows, analysis) {
  if (!rows.length) return 'Add a row to plan the batch.';
  if (analysis.startable.size === rows.length) return 'Every row can start now.';
  const notes = [];
  for (const row of rows) {
    if (analysis.startable.has(row.key) || notes.length >= 2) continue;
    const ref = refOf(row);
    const waiting = analysis.waits.get(row.key) ?? [];
    const hits = analysis.collides.get(row.key) ?? [];
    const open = waiting.filter(item => item.state === 'open').map(item => item.dep);
    const shared = open.length ? hits.find(hit => hit.ref === `#${open[0]}`)?.unit ?? hits[0]?.unit : hits[0]?.unit;
    if (open.length && shared) notes.push(`${ref} waits for #${open[0]} (both edit ${shared}).`);
    else if (open.length) notes.push(`${ref} waits for #${open[0]} (depends on it).`);
    else if (waiting.length) notes.push(`${ref} waits for #${waiting[0].dep} (not an issue here).`);
    else if (hits.length) notes.push(`${ref} shares ${hits[0].unit} with ${hits[0].ref}.`);
    else if (row.closed) notes.push(`${ref} is closed.`);
  }
  return notes.join(' ');
}

/** Issue titles recoverable from one spec file: markdown headings and tasks. */
export function specTitles(text) {
  const titles = [];
  let fence = false;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const match = /^#{1,6}\s+(.+)$/.exec(line) ?? /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (!match) continue;
    const title = match[1].replace(/[*_`~]/g, '').trim().slice(0, 200);
    if (title && !titles.includes(title)) titles.push(title);
    if (titles.length >= MAX_IMPORT_TITLES) break;
  }
  return titles;
}

/**
 * Mount the plan screen inside `section`. `ctx` supplies live app state:
 * { snapshot, repoId, identity, refresh, onClose }. Returns { render } or null
 * when the section is absent, so callers can wire it unconditionally.
 */
export function mountPlan(section, ctx = {}) {
  if (!section) return null;
  const doc = section.ownerDocument;
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = safeText(text);
    return node;
  };

  const head = el('div', 'plan-head');
  const headText = el('div', 'plan-head-text');
  headText.append(el('h1', null, 'Plan the next batch'),
    el('p', null, 'Edit like a spreadsheet. Concord shows which issues would collide before any agent starts, and how many agents can work at once.'));
  const buttons = el('div', 'plan-actions');
  const back = el('button', 'plan-back', '← Fleet desk'); back.type = 'button';
  const importButton = el('button', null, 'Import from spec files'); importButton.type = 'button';
  const fileInput = el('input'); fileInput.type = 'file'; fileInput.id = 'plan-files';
  fileInput.multiple = true; fileInput.accept = '.md,.markdown,.txt'; fileInput.hidden = true;
  const publishButton = el('button', 'primary'); publishButton.type = 'button'; publishButton.id = 'plan-publish';
  buttons.append(back, importButton, fileInput, publishButton);
  head.append(headText, buttons);
  const status = el('p', 'plan-status'); status.id = 'plan-status'; status.setAttribute('role', 'status');
  const grid = el('div', 'plan-grid');
  const tableWrap = el('section', 'plan-table-wrap'); tableWrap.setAttribute('aria-label', 'Issues table');
  const table = el('table', 'plan-table');
  const thead = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (const label of ['#', 'Title', 'Touches', 'Depends on', 'Milestone', 'Collides with']) {
    headRow.append(el('th', null, label));
  }
  thead.append(headRow);
  const tbody = doc.createElement('tbody');
  table.append(thead, tbody);
  const addWrap = el('div', 'plan-addrow');
  const addButton = el('button', null, '+ Add a row'); addButton.type = 'button'; addButton.id = 'plan-add';
  addWrap.append(addButton);
  tableWrap.append(table, addWrap);
  const aside = el('aside', 'plan-aside');
  const parallel = el('section', 'plan-card'); parallel.setAttribute('aria-label', 'Parallelism');
  const count = el('div', 'plan-count'); count.id = 'plan-count';
  const countNote = el('p', 'plan-note'); countNote.id = 'plan-note';
  parallel.append(el('h2', null, 'How many agents can start now'), count, countNote);
  const selected = el('section', 'plan-card'); selected.setAttribute('aria-label', 'Selected');
  const selNum = el('div', 'plan-numline'); selNum.id = 'plan-sel-num';
  const selTitle = el('h2'); selTitle.id = 'plan-sel-title';
  const selWhyLabel = el('div', 'plan-why-label', 'Why');
  const selWhy = el('p', 'plan-why'); selWhy.id = 'plan-sel-why';
  const selFixLabel = el('div', 'plan-why-label', 'Fix it');
  const selFix = el('p', 'plan-why'); selFix.id = 'plan-sel-fix';
  selected.append(selNum, selTitle, selWhyLabel, selWhy, selFixLabel, selFix);
  aside.append(parallel, selected);
  grid.append(tableWrap, aside);
  section.append(head, status, grid);

  const model = {
    rows: [], byNumber: new Map(), milestones: [], issueSig: null, loadState: 'unknown',
    selected: null, publishing: false, note: null, draftSeq: 0,
  };

  const canEdit = () => {
    const identity = ctx.identity?.();
    if (!identity) return false;
    if (identity.unverified) return true;
    return (Array.isArray(identity.roles) ? identity.roles : []).some(role => role === 'owner' || role === 'agent');
  };

  const issueToRow = issue => {
    const units = Array.isArray(issue.allowedFiles) ? issue.allowedFiles : [];
    const deps = depNumbers(issue.labels);
    return {
      key: `issue:${issue.number}`, number: issue.number,
      title: issue.title ?? '', unitsText: units.join(' · '), units: units.map(normalizeUnit),
      depsText: deps.map(dep => `#${dep}`).join(', '), deps,
      milestoneId: issue.milestoneId ?? null,
      otherLabels: (Array.isArray(issue.labels) ? issue.labels : []).filter(label => !DEP_LABEL.test(String(label))),
      version: issue.version ?? null, authorId: issue.authorId ?? null, state: issue.state ?? 'open',
      draft: false, dirty: false, closed: issue.state === 'closed', published: false, error: null,
      baseSig: JSON.stringify([issue.version, issue.title, units, deps, issue.milestoneId ?? null]),
    };
  };

  const draftRow = title => ({
    key: `draft:${++model.draftSeq}`, number: null,
    title: title ?? '', unitsText: '', units: [], depsText: '', deps: [],
    milestoneId: null, otherLabels: [], version: null, authorId: null, state: 'open',
    draft: true, dirty: true, closed: false, published: false, error: null, baseSig: '',
  });

  /** Fold fresh projection data into edited rows without losing keystrokes. */
  function hydrate(derived) {
    const previous = new Map(model.rows.map(row => [row.key, row]));
    const fresh = derived.open.map(issueToRow);
    const merged = [];
    for (const row of fresh) {
      const old = previous.get(row.key);
      if (old && old.dirty && old.baseSig === row.baseSig) {
        merged.push({ ...row, title: old.title, unitsText: old.unitsText, units: old.units,
          depsText: old.depsText, deps: old.deps, milestoneId: old.milestoneId, dirty: true, error: old.error,
          version: Math.max(old.version ?? 0, row.version ?? 0) });
      } else merged.push(row);
    }
    for (const row of model.rows) {
      if (fresh.some(candidate => candidate.key === row.key)) continue;
      if (row.draft && !row.published) merged.push(row);
      else if (row.published) merged.push({ ...row, pending: true });
      else if (row.dirty) merged.push({ ...row, closed: true });
    }
    model.rows = merged;
  }

  function validateRow(row) {
    const title = row.title.trim();
    if (!title) return 'Title is required.';
    if (new TextEncoder().encode(title).byteLength > MAX_TITLE) return `Title must be at most ${MAX_TITLE} bytes.`;
    const labels = row.units.map(unit => unit.label);
    if (row.units.length > MAX_UNITS) return `Touches allows at most ${MAX_UNITS} units.`;
    if (new Set(labels).size !== labels.length) return 'Touches must be distinct units.';
    if (labels.some(label => !label || label.length > MAX_UNIT_LENGTH)) return `Each unit must be 1–${MAX_UNIT_LENGTH} characters.`;
    const tokens = row.depsText.split(/[,\s]+/).map(part => part.trim()).filter(Boolean);
    if (tokens.some(token => !/^#?\d+$/.test(token))) return 'Depends on accepts issue numbers like #275.';
    for (const dep of row.deps) {
      if (dep === row.number) return 'An issue cannot depend on itself.';
      if (!model.byNumber.has(dep) && !model.rows.some(other => other.number === dep)) {
        return `Depends on #${dep}, which is not an issue in this repository.`;
      }
    }
    if (row.milestoneId && !model.milestones.some(item => item.milestoneId === row.milestoneId)) {
      return 'Milestone not found in this repository.';
    }
    return null;
  }

  function buildRows() {
    tbody.replaceChildren();
    for (const row of model.rows) tbody.append(rowElement(row));
    if (!model.rows.length) {
      const line = doc.createElement('tr'); line.className = 'plan-empty';
      const cell = el('td', null, 'No issues yet — add a row to plan the batch.');
      cell.colSpan = 6; line.append(cell); tbody.append(line);
    }
  }

  function rowElement(row) {
    const tr = doc.createElement('tr');
    tr.dataset.rowKey = row.key;
    const id = part => `plan-${part}-${row.key.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    const pick = el('button', 'plan-num', row.number != null ? `${row.number}` : 'new');
    pick.type = 'button'; pick.id = id('num');
    pick.setAttribute('aria-label', `Explain ${row.number != null ? `issue ${row.number}` : 'new row'}`);
    pick.addEventListener('click', () => { model.selected = row.key; updateComputed(); });
    const pickCell = doc.createElement('td'); pickCell.append(pick);

    const cell = (part, labelText, input) => {
      const td = doc.createElement('td');
      const label = el('label', 'plan-label', labelText); label.htmlFor = id(part);
      input.id = id(part);
      input.disabled = model.publishing || row.closed || !canEdit();
      td.append(label, input);
      return td;
    };

    const title = el('input'); title.value = row.title; title.maxLength = MAX_TITLE;
    title.addEventListener('input', () => { row.title = title.value; row.dirty = true; row.error = null; updateComputed(); });
    const units = el('input', 'plan-mono'); units.value = row.unitsText;
    units.placeholder = 'web/app.js · § Header';
    units.addEventListener('input', () => { row.unitsText = units.value; row.units = parseUnits(units.value); row.dirty = true; row.error = null; updateComputed(); });
    const deps = el('input', 'plan-mono'); deps.value = row.depsText;
    deps.placeholder = '#275';
    deps.addEventListener('input', () => { row.depsText = deps.value; row.deps = parseDepends(deps.value); row.dirty = true; row.error = null; updateComputed(); });

    const milestoneCell = doc.createElement('td');
    const milestoneLabel = el('label', 'plan-label', `Milestone for ${refOf(row)}`); milestoneLabel.htmlFor = id('milestone');
    const milestone = el('select'); milestone.id = id('milestone');
    milestone.disabled = model.publishing || row.closed || !canEdit();
    const none = el('option', null, '— none —'); none.value = ''; milestone.append(none);
    const choices = model.milestones.filter(item => item.state !== 'closed' || item.milestoneId === row.milestoneId);
    for (const item of choices) {
      const option = el('option', null, `${item.title ?? item.milestoneId}${item.state === 'closed' ? ' (closed)' : ''}`);
      option.value = item.milestoneId; milestone.append(option);
    }
    milestone.value = row.milestoneId ?? '';
    milestone.addEventListener('change', () => { row.milestoneId = milestone.value || null; row.dirty = true; row.error = null; updateComputed(); });
    milestoneCell.append(milestoneLabel, milestone);

    const collidesCell = doc.createElement('td'); collidesCell.className = 'plan-collides';
    tr.append(pickCell, cell('title', `Title of ${refOf(row)}`, title),
      cell('units', `Touches for ${refOf(row)}`, units), cell('deps', `Depends on for ${refOf(row)}`, deps),
      milestoneCell, collidesCell);
    return tr;
  }

  function statusMessage() {
    if (model.note) return model.note;
    if (!canEdit()) return 'Read-only: an owner or agent token is required to publish.';
    switch (model.loadState) {
      case 'loading': return 'Loading issues…';
      case 'no-repo': return 'Choose a repository to plan issues.';
      case 'unavailable': return 'Issues are unavailable for this repository (MODULE_UNAVAILABLE). Shown explicitly, never faked.';
      case 'unknown': return 'The issues projection has a shape this screen does not recognize.';
      default: return '';
    }
  }

  function updateComputed() {
    const analysis = analyzePlan(model.rows, model.byNumber);
    for (const tr of tbody.querySelectorAll('tr[data-row-key]')) {
      const row = model.rows.find(item => item.key === tr.dataset.rowKey);
      if (!row) continue;
      tr.dataset.selected = String(row.key === model.selected);
      for (const input of tr.querySelectorAll('input, select')) {
        input.disabled = model.publishing || row.closed || !canEdit();
      }
      const cell = tr.querySelector('.plan-collides');
      cell.replaceChildren();
      const hits = analysis.collides.get(row.key) ?? [];
      const waiting = analysis.waits.get(row.key) ?? [];
      for (const item of waiting) {
        const chip = el('span', 'plan-col plan-col-hit',
          item.state === 'unknown' ? `unknown #${item.dep}` : `waits #${item.dep}`);
        cell.append(chip);
      }
      for (const hit of hits) cell.append(el('span', 'plan-col plan-col-hit', `${hit.ref} · ${hit.unit}`));
      if (!waiting.length && !hits.length) cell.append(el('span', 'plan-col plan-col-free', 'none'));
      if (row.error) {
        const error = el('span', 'plan-row-error', row.error);
        error.setAttribute('role', 'alert');
        cell.append(error);
      }
      if (row.closed) cell.append(el('span', 'plan-col plan-col-hit', 'closed'));
      if (row.pending) cell.append(el('span', 'plan-col plan-col-hit', 'awaiting refresh'));
    }
    count.replaceChildren(safeText(String(analysis.startable.size)), el('span', null, ` of ${model.rows.length}`));
    countNote.textContent = planNote(model.rows, analysis);
    const row = model.rows.find(item => item.key === model.selected);
    if (row) {
      const explain = explainRow(row, analysis);
      selNum.textContent = row.number != null ? `#${row.number}` : 'New row';
      selTitle.textContent = row.title.trim() || 'Untitled issue';
      selWhy.textContent = explain.why;
      selFix.textContent = explain.fix;
    } else {
      selNum.textContent = 'No row selected';
      selTitle.textContent = 'Plan the batch';
      selWhy.textContent = 'Select a row number to see why it can or cannot start.';
      selFix.textContent = '';
    }
    const pending = model.rows.filter(item => item.draft || item.dirty).length;
    publishButton.textContent = `Publish ${pending} issue${pending === 1 ? '' : 's'}`;
    publishButton.disabled = model.publishing || !canEdit() || pending === 0;
    importButton.disabled = model.publishing || !canEdit();
    addButton.disabled = model.publishing || !canEdit();
    status.textContent = statusMessage();
    status.hidden = !status.textContent;
  }

  function render() {
    const snapshot = ctx.snapshot?.() ?? null;
    const repoId = ctx.repoId?.() ?? null;
    if (!snapshot) {
      model.loadState = repoId ? 'loading' : 'no-repo';
      model.rows = model.rows.filter(row => row.draft && !row.published);
      model.byNumber = new Map();
      model.milestones = [];
      model.issueSig = null;
      buildRows();
    } else {
      const derived = planIssues(snapshot);
      model.byNumber = derived.byNumber;
      model.milestones = derived.milestones;
      model.loadState = derived.state;
      if (derived.signature !== model.issueSig) {
        model.issueSig = derived.signature;
        hydrate(derived);
        buildRows();
      }
    }
    if (!model.rows.some(row => row.key === model.selected)) model.selected = model.rows[0]?.key ?? null;
    updateComputed();
  }

  async function publish() {
    if (model.publishing) return;
    const repoId = ctx.repoId?.();
    if (!repoId) { model.note = 'Choose a repository before publishing.'; updateComputed(); return; }
    model.publishing = true;
    model.note = null;
    updateComputed();
    let published = 0;
    let failed = 0;
    for (const row of model.rows) {
      if (!row.draft && !row.dirty) continue;
      row.error = row.closed ? 'This issue is closed; edits cannot be published.' : validateRow(row);
      if (row.error) { failed++; continue; }
      const labels = [...new Set([...row.otherLabels, ...row.deps.map(dep => `dep:${dep}`)])];
      const payload = { title: row.title.trim(), labels, milestoneId: row.milestoneId || null,
        allowedFiles: row.units.length ? row.units.map(unit => unit.label) : null };
      try {
        if (row.draft) {
          const created = await createIssue(repoId, { ...payload, body: '' }, newIdempotencyKey());
          row.number = created?.data?.number ?? row.number;
          row.key = `issue:${row.number}`;
          row.version = created?.data?.version ?? row.version;
          row.draft = false;
        } else {
          const updated = await updateIssue(repoId, row.number, { ...payload, expectedVersion: row.version }, newIdempotencyKey());
          row.version = updated?.data?.version ?? row.version;
        }
        row.dirty = false;
        row.published = true;
        published++;
      } catch (error) {
        const refusal = redactError(error);
        if (Number.isSafeInteger(error.details?.currentVersion)) row.version = error.details.currentVersion;
        row.error = `${refusal.code}: ${refusal.message}`;
        failed++;
      }
    }
    model.publishing = false;
    model.note = failed
      ? `Published ${published} issue${published === 1 ? '' : 's'} · ${failed} row${failed === 1 ? '' : 's'} need${failed === 1 ? 's' : ''} attention.`
      : published ? `Published ${published} issue${published === 1 ? '' : 's'}.` : 'Nothing to publish.';
    if (published) await Promise.resolve(ctx.refresh?.()).catch(() => {});
    model.issueSig = null; // Draft keys became issue numbers; rebuild even if the snapshot is unchanged.
    render();
  }

  async function readFileText(file) {
    if (typeof file.text === 'function') return file.text();
    const Reader = doc.defaultView?.FileReader ?? globalThis.FileReader;
    if (!Reader) throw new Error('FileReader unavailable');
    return new Promise((resolve, reject) => {
      const reader = new Reader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error ?? new Error('Could not read file'));
      reader.readAsText(file);
    });
  }

  back.addEventListener('click', () => ctx.onClose?.());
  addButton.addEventListener('click', () => {
    const row = draftRow();
    model.rows.push(row);
    model.selected = row.key;
    buildRows();
    updateComputed();
    tbody.querySelector(`tr[data-row-key="${row.key}"] input`)?.focus();
  });
  importButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    let added = 0;
    for (const file of files.slice(0, 10)) {
      const text = await readFileText(file).catch(() => null);
      if (text === null) continue;
      for (const title of specTitles(text)) {
        if (added >= MAX_IMPORT_TITLES) break;
        model.rows.push(draftRow(title));
        added++;
      }
    }
    model.note = added
      ? `Imported ${added} draft row${added === 1 ? '' : 's'} from ${files.length} file${files.length === 1 ? '' : 's'}.`
      : 'No issue titles found in spec files.';
    if (added) buildRows();
    render();
  });
  publishButton.addEventListener('click', () => { void publish(); });

  return { render };
}
