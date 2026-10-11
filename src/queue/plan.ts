import type { Id } from '../contracts';

export const MAX_CANDIDATES = 8;
export const STACK_WIDTH = 4;
export const COALESCE_MS = 2_000;
export const MAX_DIAGNOSTICS = 8;

export interface PlannedEntry { changeId: Id; sequence: number; dependencyChangeIds: readonly Id[] }

/** Stable, dependency-closed prefix. An unavailable prerequisite leaves its dependent waiting. */
export function selectStack(waiting: readonly PlannedEntry[], available: ReadonlySet<Id>, width = STACK_WIDTH): Id[] {
  const selected: Id[] = [];
  for (const entry of [...waiting].sort((a, b) => a.sequence - b.sequence)) {
    if (selected.length >= width) break;
    if (entry.dependencyChangeIds.every(id => available.has(id) || selected.includes(id))) selected.push(entry.changeId);
  }
  return selected;
}

export function dependencyClosure(ids: readonly Id[], all: readonly PlannedEntry[]): Id[] {
  const wanted = new Set(ids);
  const byId = new Map(all.map(item => [item.changeId, item]));
  const visit = (id: Id, seen: Set<Id>) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const prerequisite of byId.get(id)?.dependencyChangeIds ?? []) if (byId.has(prerequisite)) {
      wanted.add(prerequisite);
      visit(prerequisite, seen);
    }
  };
  for (const id of ids) visit(id, new Set());
  return all.filter(item => wanted.has(item.changeId)).sort((a, b) => a.sequence - b.sequence).map(item => item.changeId);
}

export type DiagnosisReason = 'BASE_RED' | 'INTERACTION' | 'DEPENDENCY_GROUP' | 'INCONCLUSIVE' | 'SINGLETON';
export interface Diagnosis {
  original: Id[]; suspects: Id[]; excluded: Id[];
  /** Queue-owned admission IDs parallel to original; planner fixtures need only change IDs. */
  admissionIds?: Id[];
  phase: 'baseline' | 'left' | 'right' | 'survivors' | 'done';
  left: Id[]; right: Id[]; leftGreen: boolean;
  jobs: number; reason: DiagnosisReason | null; blame: Id[]; survivors: Id[];
}
export interface DiagnosisStep { diagnosis: Diagnosis; next: Id[] | null }

export function startDiagnosis(ids: readonly Id[]): DiagnosisStep {
  const diagnosis: Diagnosis = {
    original: [...ids], suspects: [...ids], excluded: [], phase: 'baseline',
    left: [], right: [], leftGreen: false, jobs: 1, reason: null, blame: [], survivors: [],
  };
  return { diagnosis, next: [] };
}

function finish(state: Diagnosis, reason: DiagnosisReason, blame: Id[] = [], survivors: Id[] = []): DiagnosisStep {
  return { diagnosis: { ...state, phase: 'done', reason, blame, survivors }, next: null };
}

function request(state: Diagnosis, phase: Diagnosis['phase'], subset: Id[], all: readonly PlannedEntry[]): DiagnosisStep {
  if (state.jobs >= MAX_DIAGNOSTICS) return finish(state, 'INCONCLUSIVE');
  return { diagnosis: { ...state, phase, jobs: state.jobs + 1 }, next: dependencyClosure(subset, all) };
}

function split(state: Diagnosis, all: readonly PlannedEntry[]): DiagnosisStep {
  if (state.suspects.length === 1) {
    const closure = dependencyClosure(state.suspects, all);
    if (closure.length > 1) return finish(state, 'DEPENDENCY_GROUP', closure);
    const survivors = state.original.filter(id => id !== state.suspects[0]);
    if (survivors.length === 0) return finish(state, 'SINGLETON', [...state.suspects]);
    if (dependencyClosure(survivors, all).includes(state.suspects[0])) {
      return finish(state, 'DEPENDENCY_GROUP', [...state.original]);
    }
    return request({ ...state, blame: [...state.suspects], survivors }, 'survivors', survivors, all);
  }
  const midpoint = Math.floor(state.suspects.length / 2);
  const left = state.suspects.slice(0, midpoint);
  const right = state.suspects.slice(midpoint);
  const closedLeft = dependencyClosure(left, all);
  const closedRight = dependencyClosure(right, all);
  if (closedLeft.length >= state.suspects.length && closedRight.length >= state.suspects.length) {
    return finish(state, 'DEPENDENCY_GROUP', [...state.suspects]);
  }
  return request({ ...state, left, right }, 'left', left, all);
}

/** Consume one deterministic result. Only a reproduced red singleton receives individual blame. */
export function advanceDiagnosis(state: Diagnosis, green: boolean, all: readonly PlannedEntry[]): DiagnosisStep {
  if (state.phase === 'done') return { diagnosis: state, next: null };
  if (state.phase === 'baseline') return green ? split(state, all) : finish(state, 'BASE_RED');
  if (state.phase === 'left') {
    if (!green) return split({ ...state, suspects: state.left }, all);
    return request({ ...state, leftGreen: true }, 'right', state.right, all);
  }
  if (state.phase === 'right') {
    if (!green) return split({ ...state, suspects: state.right }, all);
    return finish(state, 'INTERACTION', [...state.suspects]);
  }
  if (!green) return finish(state, 'INCONCLUSIVE');
  return finish(state, 'SINGLETON', state.blame, state.survivors);
}
