import { closeChange, forceReleaseLease, newIdempotencyKey, redactError, withdrawChange } from './api.js';

const states = new Map();
const arr = value => Array.isArray(value) ? value : [];
const terminal = new Set(['merged', 'closed', 'superseded', 'withdrawn']);
const activeQueue = new Set(['admitted', 'reserved', 'checking']);
const el = (tag, value, className) => {
  const item = document.createElement(tag);
  if (value !== undefined && value !== null) item.textContent = String(value);
  if (className) item.className = className;
  return item;
};

function stateFor(key) {
  if (!states.has(key)) states.set(key, { open: false, reason: '', error: '', status: '', busy: false });
  return states.get(key);
}

/** Render the owner's cancel and lease release controls for one tracker card. */
export function ownerControls(picked, context, callbacks = {}) {
  const roles = context?.roles ?? context?.identity?.roles;
  if (!roles?.includes('owner') || !picked?.change) return null;
  const section = el('section', null, 'owner-controls');
  section.append(el('h3', 'Owner controls'));
  const change = picked.change;
  const snapshotVersion = context.snapshot?.version;

  function confirmForm(key, submitLabel, action) {
    const state = stateFor(key);
    if (!state.open) return null;
    const form = el('form', null, 'tracker-form');
    form.addEventListener('submit', event => event.preventDefault());
    const label = el('label', 'Reason');
    const reason = el('input');
    reason.name = 'reason';
    reason.required = true;
    reason.minLength = 1;
    reason.maxLength = 500;
    reason.value = state.reason;
    reason.addEventListener('input', () => { state.reason = reason.value; state.error = ''; });
    label.append(reason);
    const submit = el('button', submitLabel, 'tracker-submit');
    submit.type = 'button';
    submit.disabled = state.busy;
    submit.addEventListener('click', () => { void action(state); });
    const keep = el('button', 'Keep working');
    keep.type = 'button';
    keep.disabled = state.busy;
    keep.addEventListener('click', () => { state.open = false; state.error = ''; callbacks.render?.(); });
    form.append(label, submit, keep);
    if (state.error) form.append(el('p', state.error, 'tracker-status'));
    return form;
  }

  if (!terminal.has(change.status)) {
    const cancelKey = `change:${context.repoId}:${change.changeId}`;
    const state = stateFor(cancelKey);
    const cancel = el('button', 'Cancel work');
    cancel.type = 'button';
    cancel.disabled = state.busy;
    cancel.addEventListener('click', () => { state.open = !state.open; state.error = ''; callbacks.render?.(); });
    section.append(cancel);
    if (state.open) {
      section.append(el('p', `Releases ${arr(picked.leases).length} live leases and closes change ${change.changeId}. The issue stays open for another agent.`));
      section.append(confirmForm(cancelKey, 'Confirm cancel', async current => {
        const reason = current.reason.trim();
        if (!reason || reason.length > 500) { current.error = 'Enter a reason between 1 and 500 characters.'; callbacks.render?.(); return; }
        current.busy = true; current.error = ''; callbacks.render?.();
        try {
          let expectedVersion = snapshotVersion;
          if (activeQueue.has(picked.queue?.state)) {
            const withdrawn = await withdrawChange(context.repoId,
              { changeId: change.changeId, expectedVersion, reason }, newIdempotencyKey(), callbacks.fetchImpl);
            expectedVersion = withdrawn?.version ?? snapshotVersion;
          }
          await closeChange(context.repoId, change.changeId, { expectedVersion, reason }, newIdempotencyKey(), callbacks.fetchImpl);
          current.open = false;
          current.status = 'Work cancelled; leases released.';
          await callbacks.refresh?.();
        } catch (error) {
          current.status = `Could not cancel (${redactError(error).code}).`;
        } finally {
          current.busy = false;
          callbacks.render?.();
        }
      }));
    }
    if (state.status) section.append(el('p', state.status, 'tracker-status'));
  }

  for (const lease of arr(picked.leases).filter(item => item?.leaseId)) {
    const row = el('div', null, 'owner-control-lease');
    row.append(el('span', `${lease.unitKey} · ${lease.holderId}`));
    const key = `lease:${context.repoId}:${lease.leaseId}`;
    const state = stateFor(key);
    const release = el('button', 'Release');
    release.type = 'button';
    release.disabled = state.busy;
    release.addEventListener('click', () => { state.open = !state.open; state.error = ''; callbacks.render?.(); });
    row.append(release);
    if (state.open) row.append(confirmForm(key, 'Confirm release', async current => {
      const reason = current.reason.trim();
      if (!reason || reason.length > 500) { current.error = 'Enter a reason between 1 and 500 characters.'; callbacks.render?.(); return; }
      current.busy = true; current.error = ''; callbacks.render?.();
      try {
        await forceReleaseLease(context.repoId, lease.leaseId,
          { reason, expectedVersion: snapshotVersion }, newIdempotencyKey(), callbacks.fetchImpl);
        current.open = false;
        current.status = 'Lease released.';
        await callbacks.refresh?.();
      } catch (error) {
        current.status = `Could not release (${redactError(error).code}).`;
      } finally {
        current.busy = false;
        callbacks.render?.();
      }
    }));
    if (state.status) row.append(el('p', state.status, 'tracker-status'));
    section.append(row);
  }
  return section;
}
