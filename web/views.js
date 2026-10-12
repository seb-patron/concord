/**
 * Concord web view helpers.
 *
 * Pure, DOM-free derivations over the frozen v1 contract (src/contracts.ts).
 * Product screens fetch the backend via web/api.js; these helpers only shape
 * what was fetched (or clearly labelled test fixtures) into renderable cards.
 * They never invent green outcomes: unknown, inconclusive, and unavailable
 * states are explicit values, not absences.
 */

/** Pass untrusted text through unchanged; callers must use textContent. */
export function safeText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** True when text contains markup-looking content (rendered literally, never parsed). */
export function looksLikeMarkup(value) {
  return /[<>&]/.test(safeText(value));
}

/**
 * Normalize one module projection from GET snapshot.
 * Current backend modules return { status: 'unavailable', items: [] };
 * later slices may return item arrays under their own keys.
 */
export function projectionItems(projection) {
  if (!projection || typeof projection !== 'object') return { state: 'unknown', items: [] };
  if (projection.status === 'unavailable') return { state: 'unavailable', items: [] };
  const keys = ['items', 'changes', 'leases', 'entries', 'findings', 'verdicts', 'runners', 'rounds', 'jobs', 'events', 'repos'];
  for (const key of keys) {
    if (Array.isArray(projection[key])) {
      return { state: projection[key].length === 0 ? 'empty' : 'ready', items: projection[key] };
    }
  }
  if (Array.isArray(projection)) return { state: projection.length === 0 ? 'empty' : 'ready', items: projection };
  return { state: 'unknown', items: [] };
}

/** Snapshot ownership is fixed by the six registered coordinator modules. */
export function snapshotCollections(envelope) {
  const p = envelope?.data?.projections ?? {};
  return {
    changes: projectionItems(p.repos?.status === 'unavailable' ? p.repos : p.repos?.changes),
    repairs: p.findings?.status === 'unavailable' ? { state: 'unavailable', items: [] } : projectionItems(p.findings?.rounds),
    findingSetVersions: p.findings?.findingSetVersions,
  };
}

/** Queue diagnoses use reason/blame in production; older exports used classification. */
export function normalizeDiagnosis(raw) {
  const reason = raw?.reason ?? raw?.classification ?? null;
  const ids = reason === 'SINGLETON' ? raw?.blame ?? raw?.culpritChangeIds :
    raw?.blame ?? raw?.failingSet ?? raw?.suspects;
  return { reason, ids: Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [] };
}

export function boardStage(change) {
  switch (change?.status) {
    case 'merged': return 'Landed';
    case 'queued': return 'Queued';
    case 'checking': return 'Checking';
    default: return 'Working';
  }
}

/** Every decision comes from live snapshot evidence, never illustrative mockup data. */
export function deriveInbox(snapshot, verdictsByChange = {}) {
  const p = snapshot?.data?.projections ?? {};
  const changes = snapshotCollections(snapshot).changes.items;
  const queue = p.queue ?? {};
  const diagnosis = normalizeDiagnosis(queue.diagnosis);
  const items = [];
  if (diagnosis.reason === 'SINGLETON') {
    for (const changeId of diagnosis.ids) {
      const change = changes.find(c => c?.changeId === changeId);
      const observations = (Array.isArray(queue.diagnosticResults) ? queue.diagnosticResults : [])
        .filter(r => Array.isArray(r.memberIds) && r.memberIds.includes(changeId))
        .map(r => `${r.memberIds.join(' + ')}: ${r.outcome ?? 'unknown outcome'} (job ${r.jobId ?? '?'})`);
      items.push({ id: `blamed:${changeId}`, kind: 'Blamed by bisection', tone: 'red', changeId,
        title: change?.intentText ?? changeId, why: 'This change failed alone during bisection. Review the checker evidence before deciding whether to withdraw it.',
        evidence: `Change ${changeId} · isolated singleton culprit${observations.length ? `\n${observations.join('\n')}` : ''}` });
    }
  } else if (['INTERACTION', 'DEPENDENCY_GROUP', 'BASE_RED', 'INCONCLUSIVE'].includes(diagnosis.reason)) {
    items.push({ id: `diagnosis:${diagnosis.reason}`, kind: diagnosis.reason.replaceAll('_', ' '), tone: 'red',
      title: diagnosis.reason === 'BASE_RED' ? 'Main branch baseline is red' : 'Queue needs review',
      why: diagnosis.reason === 'INCONCLUSIVE' ? 'Diagnosis could not isolate a culprit.' : 'The queue cannot blame one change from this evidence.',
      evidence: `Classification: ${diagnosis.reason}\nSet: ${diagnosis.ids.join(', ') || 'none identified'}` });
  }
  for (const refusal of Array.isArray(p.leases?.refusals) ? p.leases.refusals : []) {
    const conflict = Array.isArray(refusal.conflicts) ? refusal.conflicts[0] : null;
    if (!conflict || !Number.isFinite(conflict.expiresAt) || conflict.expiresAt <= Date.now()) continue;
    const held = Array.isArray(p.leases?.items) && p.leases.items.some(lease =>
      lease?.holderId === conflict.holderId && ['active', 'reserved'].includes(lease.state) &&
      lease.expiresAt > Date.now() && (refusal.keys ?? []).includes(lease.unitKey));
    if (!held) continue;
    const key = (refusal.keys ?? [])[0] ?? conflict?.unitKey ?? 'a unit';
    const holder = conflict?.holderId ?? 'another holder';
    items.push({ id: `wait:${refusal.changeId}:${refusal.createdAt}`, kind: 'Waiting on a lease', tone: 'amber',
      changeId: refusal.changeId, title: `${refusal.requesterId ?? 'An agent'} is waiting for ${key}`,
      why: `${holder} holds the unit. Wait for release or expiry before retrying the claim.`,
      evidence: `Holder: ${holder}\nUnit: ${key}\nExpires: ${conflict?.expiresAt ? new Date(conflict.expiresAt).toLocaleString() : 'unknown'}` });
  }
  for (const change of changes) {
    if (change?.status !== 'ready' || !change.headOid) continue;
    const verdicts = verdictsByChange[change.changeId];
    if (!Array.isArray(verdicts)) continue;
    if (Array.isArray(verdicts) && verdicts.some(v => v?.decision === 'approve' && v.revision === change.revision)) continue;
    items.push({ id: `review:${change.changeId}`, kind: 'Review requested', tone: 'blue',
      changeId: change.changeId, title: change.intentText ?? change.intentKey ?? change.changeId,
      why: 'The published revision has passed inspection and awaits an independent verdict.',
      evidence: `Head: ${change.headOid}\nRevision: ${change.revision}\nUnits: ${(change.unitKeys ?? []).join(', ') || 'none'}` });
  }
  return items;
}

export function mutationEvidence(change, leases, findingSetVersion, requireFences = true) {
  if (typeof change?.changeId !== 'string' || !change.changeId.trim()) return { error: 'Select a change first.' };
  if (!Number.isSafeInteger(change.revision) || change.revision < 1) return { error: 'Current change revision is unavailable.' };
  if (!Number.isSafeInteger(findingSetVersion) || findingSetVersion < 0) return { error: 'Current finding-set version is unavailable.' };
  if (requireFences && (!Array.isArray(change.unitKeys) || change.unitKeys.length === 0 || !change.unitKeys.every(key => typeof key === 'string' && key.length > 0))) {
    return { error: 'Current change unit keys are unavailable.' };
  }
  const fences = {};
  for (const key of requireFences ? change.unitKeys : []) {
    const lease = leases.find(item => item?.changeId === change.changeId && item.unitKey === key && (item.state === 'active' || item.state === 'reserved'));
    if (!lease || !Number.isSafeInteger(lease.fence) || lease.fence < 1 ||
      !Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now()) {
      return { error: `Current lease fence is unavailable for ${key}.` };
    }
    fences[key] = lease.fence;
  }
  return { revision: change.revision, findingSetVersion, leaseFences: fences };
}

/** Environment badge: local fake vs live Artifacts vs historical simulation. */
export function environmentBadge(health, replayLoaded = false) {
  if (replayLoaded) return { label: 'historical simulation', detail: 'Replayed export; outcomes are recorded, not live.' };
  const mode = health && health.mode;
  const backend = health && health.storageBackend;
  if (mode === 'production' && backend === 'artifacts') {
    return { label: 'live Artifacts', detail: 'Deployed Worker with real Artifacts storage.' };
  }
  if (mode === 'local' && backend === 'bridge') {
    return { label: 'local bridge', detail: 'Local Worker with loopback Git bridge (labelled fake backend).' };
  }
  if (mode === 'local') {
    return { label: 'local fake', detail: 'Local Worker with in-process fake storage. Not Artifacts.' };
  }
  return { label: 'unknown backend', detail: 'Health is unreachable; nothing below is live data.' };
}

/** Human countdown for a lease; explicit when already expired. */
export function leaseCountdown(lease, nowMs) {
  const remaining = Math.max(0, (lease.expiresAt ?? 0) - nowMs);
  const seconds = Math.floor(remaining / 1000);
  if ((lease.state !== 'active' && lease.state !== 'reserved') || remaining <= 0) {
    return { text: 'expired', expired: true };
  }
  return { text: seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s left` : `${seconds}s left`, expired: false };
}

/**
 * Next useful action for one change card.
 * `ctx` carries related records when the snapshot provides them:
 * { leases, leaseConflict, findingsGate, verdictGate, queueEntry, promotionState }.
 * Every branch returns { label, kind, detail }; unknown states say so.
 */
export function changeNextAction(change, ctx = {}) {
  const status = change && change.status;
  const terminal = { merged: 'Landed to canonical history.', superseded: 'Superseded by a competing candidate.', closed: 'Closed without landing.' };
  if (status && terminal[status]) {
    return { label: status === 'merged' ? 'Landed' : `No action (${status})`, kind: 'terminal', detail: terminal[status] };
  }
  if (status === 'blocked') {
    if (ctx.leaseConflict) {
      const holder = ctx.leaseConflict.holderId ?? 'unknown holder';
      return {
        label: 'Resolve lease conflict', kind: 'conflict', detail: `Unit held by ${holder}: ${ctx.leaseConflict.intentText ?? 'no intent recorded'}. Wait for expiry or pick an unclaimed unit.`,
        holderId: holder, conflictingKeys: ctx.leaseConflict.unitKeys ?? [],
      };
    }
    if (ctx.findingsGate && ctx.findingsGate.unresolvedIds && ctx.findingsGate.unresolvedIds.length > 0) {
      return { label: 'Complete the repair round', kind: 'repair', detail: `${ctx.findingsGate.unresolvedIds.length} finding(s) still open; one repair submission must cover every open finding.` };
    }
    return { label: 'Unknown block', kind: 'unknown', detail: 'Blocked for an unrecognized reason; inspect the event log.' };
  }
  if (status === 'queued' || status === 'checking') {
    return { label: 'Await checker', kind: 'wait', detail: 'Admitted to the queue; the composed-stack check decides.' };
  }
  if (status === 'draft') {
    return { label: 'Publish a revision', kind: 'publish', detail: 'Push the candidate fork, then publish its base/head OIDs with current lease fences.' };
  }
  if (status === 'ready') {
    if (!ctx.verdictGate || !ctx.verdictGate.verdictId) {
      return { label: 'Request independent review', kind: 'review', detail: 'No valid approval on this revision; the author cannot approve their own change.' };
    }
    return { label: 'Enqueue with fences', kind: 'enqueue', detail: 'Approval and lease fences look present; enqueue for the speculative stack.' };
  }
  return { label: 'Unknown state', kind: 'unknown', detail: `Change state ${JSON.stringify(status) ?? 'missing'} is not recognized; labelled explicitly, not guessed.` };
}

/**
 * Bounded-bisection display. Only the classification the backend supports is
 * highlighted; anything else is an explicit unknown/inconclusive label.
 * `diagnosis` shape: { classification, culpritChangeIds, failingSet, note }.
 */
export function describeBisection(diagnosis) {
  const d = diagnosis && typeof diagnosis === 'object' ? diagnosis : {};
  switch (d.classification) {
    case 'SINGLETON':
      return {
        classification: 'SINGLETON',
        headline: `Culprit: ${(d.culpritChangeIds ?? []).join(', ') || 'unidentified'}`,
        highlightIds: d.culpritChangeIds ?? [],
        note: d.note ?? 'Isolated by bisection; every other candidate recomposes without it.',
      };
    case 'INTERACTION':
      return {
        classification: 'INTERACTION',
        headline: `Failing set: ${(d.failingSet ?? []).join(' + ') || 'unidentified'}`,
        highlightIds: d.failingSet ?? [],
        note: 'Both halves pass alone; the combination fails. The set stays blocked for review, never single-blamed.',
      };
    case 'DEPENDENCY_GROUP':
      return {
        classification: 'DEPENDENCY_GROUP',
        headline: 'Dependency group blocked',
        highlightIds: d.failingSet ?? [],
        note: 'Prerequisite closure prevents isolation; the group is blocked as a whole.',
      };
    case 'BASE_RED':
      return {
        headline: 'Baseline itself fails',
        highlightIds: [],
        note: 'The canonical base fails the checker; the queue is paused, no candidate is blamed.',
      };
    case 'INCONCLUSIVE':
      return {
        headline: 'Inconclusive',
        highlightIds: [],
        note: 'Diagnostic budget exhausted without an attributable cause. No culprit is named.',
      };
    default:
      return {
        headline: 'Bisection unknown',
        highlightIds: [],
        note: 'No supported bisection classification was reported; labelled explicitly.',
      };
  }
}

/**
 * Approval provenance. Carried verdicts link to the parent review and the
 * delta evidence; invalidated carry states the concrete reason.
 */
export function verdictProvenance(verdict) {
  if (!verdict || typeof verdict !== 'object') {
    return { kind: 'unknown', summary: 'No verdict recorded.', parentVerdictId: null, deltaResultId: null };
  }
  if (verdict.parentVerdictId) {
    return {
      kind: 'carried', parentVerdictId: verdict.parentVerdictId, deltaResultId: verdict.deltaResultId ?? null,
      summary: `Carried from review ${verdict.parentVerdictId} with delta evidence ${verdict.deltaResultId ?? 'missing'}.`,
    };
  }
  if (verdict.carryInvalidation) {
    return {
      kind: 'invalidated', parentVerdictId: verdict.parentVerdictId ?? null, deltaResultId: verdict.deltaResultId ?? null,
      summary: `Carry refused: ${verdict.carryInvalidation}`,
    };
  }
  return {
    kind: 'direct', parentVerdictId: null, deltaResultId: null,
    summary: `Direct ${verdict.decision ?? 'unknown'} by ${verdict.reviewerId ?? 'unknown reviewer'} at revision ${verdict.revision ?? '?'} (finding set v${verdict.findingSetVersion ?? '?'}).`,
  };
}

/** Repair-round state for the findings card. */
export function repairStatus(findings, rounds) {
  const list = Array.isArray(findings) ? findings : [];
  const open = list.filter(f => f && f.status === 'open');
  const pending = Array.isArray(rounds) ? rounds.find(r => r && r.status === 'pending') : null;
  if (open.length === 0) return { status: 'resolved', openCount: 0, pendingRound: null, summary: 'No open findings.' };
  if (pending) {
    return {
      status: 'pending-review', openCount: open.length, pendingRound: pending.roundId ?? null,
      summary: `${open.length} open finding(s); repair round ${pending.roundId ?? '?'} awaits the independent reviewer.`,
    };
  }
  return {
    status: 'unresolved', openCount: open.length, pendingRound: null,
    summary: `${open.length} open finding(s); one repair submission must cover every open finding or the round stays unresolved (409 leaves it untouched).`,
  };
}

/** Readable copy for empty/loading/error/disconnected panels. */
export function panelCopy(kind) {
  const copies = {
    loading: { title: 'Loading…', hint: 'Fetching live projections from the backend.' },
    empty: { title: 'Nothing here', hint: 'The backend returned no records for this panel.' },
    unavailable: { title: 'Unavailable', hint: 'This feature slice has not landed (MODULE_UNAVAILABLE). Shown explicitly, never faked.' },
    error: { title: 'Request failed', hint: 'The backend refused or the network dropped. Details are redacted; retry is safe.' },
    disconnected: { title: 'Disconnected', hint: 'Polling lost contact. Browsing the last snapshot; mutations are disabled until reconnect.' },
    unknown: { title: 'Unknown state', hint: 'The backend returned a shape this view does not recognize.' },
  };
  return copies[kind] ?? copies.unknown;
}

/** Focus helpers: capture the focused control id before re-render, restore after. */
export function activeElementId(doc) {
  try {
    const el = doc && doc.activeElement;
    return el && typeof el.id === 'string' && el.id.length > 0 ? el.id : null;
  } catch {
    return null;
  }
}

export function restoreFocus(doc, id) {
  if (!id || !doc || typeof doc.getElementById !== 'function') return false;
  const el = doc.getElementById(id);
  if (!el || typeof el.focus !== 'function') return false;
  el.focus();
  return true;
}

/** Scroll offsets worth preserving across the 1s re-render. */
export function captureScroll(el) {
  if (!el) return null;
  return { top: el.scrollTop, left: el.scrollLeft };
}

export function restoreScroll(el, saved) {
  if (!el || !saved) return false;
  el.scrollTop = saved.top;
  el.scrollLeft = saved.left;
  return true;
}
