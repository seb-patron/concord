/** One on-screen verdict-history loader shared by the desk, inbox, and tracker. */
export function createVerdictLoader({ fetchPage, onResult, onEvict = () => {}, maxConcurrency = 4, maxPages = 10 }) {
  let generation = 0;
  let active = 0;
  let queue = [];
  const queued = new Set();
  const inFlight = new Set();
  const cache = new Map();
  const errors = new Map();
  const terminal = new Set();
  let snapshotVersion = null;

  function reset() {
    generation++;
    queue = [];
    queued.clear();
    inFlight.clear();
    cache.clear();
    errors.clear();
    terminal.clear();
    snapshotVersion = null;
  }

  function advanceVersion(version) {
    if (!Number.isSafeInteger(version) || (snapshotVersion !== null && version <= snapshotVersion)) return;
    snapshotVersion = version;
    const evicted = new Set();
    for (const id of cache.keys()) if (!terminal.has(id)) { cache.delete(id); evicted.add(id); }
    for (const id of errors.keys()) { errors.delete(id); evicted.add(id); }
    for (const id of evicted) onEvict(id);
  }

  function drain() {
    while (active < maxConcurrency && queue.length) {
      const id = queue.shift();
      queued.delete(id);
      if (cache.has(id) || inFlight.has(id)) continue;
      const run = generation;
      active++;
      inFlight.add(id);
      void (async () => {
        const items = [];
        const cursors = new Set();
        let cursor = null;
        let olderNotLoaded = false;
        try {
          for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
            const page = await fetchPage(id, cursor);
            if (run !== generation) return;
            items.push(...(Array.isArray(page?.data?.items) ? page.data.items : []));
            cursor = page?.data?.nextCursor ?? null;
            if (!cursor) break;
            if (cursors.has(cursor)) throw Object.assign(new Error('Repeated verdict cursor'), { code: 'INVALID_CURSOR' });
            cursors.add(cursor);
            if (pageNumber === maxPages - 1) olderNotLoaded = true;
          }
          if (run !== generation) return;
          items.olderNotLoaded = olderNotLoaded;
          cache.set(id, items);
          errors.delete(id);
          onResult(id, items, null);
        } catch (error) {
          if (run === generation) {
            const message = error?.status === 403 ? 'Approval history is visible to reviewers' :
              `Approval history unavailable (${error?.code ?? 'UNKNOWN'})`;
            errors.set(id, message);
            onResult(id, null, message);
          }
        } finally {
          active--;
          if (run === generation) {
            inFlight.delete(id);
          }
          drain();
        }
      })();
    }
  }

  function request(ids, terminalIds = []) {
    for (const id of terminalIds) if (id) terminal.add(id);
    for (const id of new Set(Array.isArray(ids) ? ids : [])) {
      if (!id || cache.has(id) || errors.has(id) || inFlight.has(id) || queued.has(id)) continue;
      queue.push(id);
      queued.add(id);
    }
    drain();
  }

  return { request, reset, advanceVersion, cache, errors, inFlight, get terminal() { return terminal; } };
}
