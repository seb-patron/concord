import type { ReplayExport } from './schema.ts';

export interface SimulationOptions { workerCapacity: number; checkerCapacity: number }
export interface SimulatedTask {
  taskId: string;
  status: 'simulated' | 'unknown';
  outcome: 'landed' | 'refused' | 'unknown';
  workStartMs?: number;
  workFinishMs?: number;
  checkerStartMs?: number;
  checkerFinishMs?: number;
  reason?: string;
}
export interface SimulationResult {
  label: 'simulated';
  assumptions: SimulationOptions & { timeOrigin: 'zero'; ordering: string };
  tasks: SimulatedTask[];
  makespanMs: number | null;
}

export function simulateReplay(data: ReplayExport, options: SimulationOptions = { workerCapacity: 2, checkerCapacity: 1 }): SimulationResult {
  if (!Number.isInteger(options.workerCapacity) || options.workerCapacity < 1 || !Number.isInteger(options.checkerCapacity) || options.checkerCapacity < 1) throw new Error('workerCapacity and checkerCapacity must be positive integers');
  const order = [...data.header.selected.taskIds].sort((a, b) => {
    const at = Math.min(...data.events.filter(e => e.taskId === a).map(e => Date.parse(e.occurredAt)));
    const bt = Math.min(...data.events.filter(e => e.taskId === b).map(e => Date.parse(e.occurredAt)));
    return at - bt || a.localeCompare(b);
  });
  const workSlots = Array<number>(options.workerCapacity).fill(0);
  const checkerSlots = Array<number>(options.checkerCapacity).fill(0);
  const tasks: SimulatedTask[] = [];
  const finishByTask = new Map<string, number>();
  const rows = new Map(order.map(id => [id, data.events.filter(e => e.taskId === id)]));
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  const overlapPeers = new Map(order.map(id => [id, new Set<string>()]));
  for (const event of data.events) for (const peer of event.overlapTaskIds ?? []) {
    overlapPeers.get(event.taskId)?.add(peer);
    overlapPeers.get(peer)?.add(event.taskId);
  }

  for (const taskId of order) {
    const events = rows.get(taskId)!;
    const work = events.find(e => e.durationMetric === 'work' && e.durationMs !== undefined);
    const check = events.find(e => e.durationMetric === 'checker' && e.durationMs !== undefined);
    const outcome = events.find(e => e.type === 'merged' || e.type === 'task_finished' || e.type === 'task_refused')?.outcome ??
      (events.some(e => e.type === 'merged') ? 'landed' : 'unknown');
    const dependencies = [...new Set(events.flatMap(e => e.dependencyTaskIds ?? []))];
    const overlaps = [...(overlapPeers.get(taskId) ?? [])];
    const unresolvedDependency = dependencies.find(id => !finishByTask.has(id));
    const unresolvedOverlap = overlaps.find(id => (orderIndex.get(id) ?? Infinity) < orderIndex.get(taskId)! && !finishByTask.has(id));
    if (unresolvedDependency || unresolvedOverlap) {
      tasks.push({ taskId, status: 'unknown', outcome, reason: unresolvedDependency ? `dependency timing unknown: ${unresolvedDependency}` : `overlap timing unknown: ${unresolvedOverlap}` });
      continue;
    }
    if (!work || !check) {
      tasks.push({ taskId, status: 'unknown', outcome, reason: !work && !check ? 'work and checker durations missing' : !work ? 'work duration missing' : 'checker duration missing' });
      continue;
    }
    const depReady = Math.max(0, ...dependencies.map(id => finishByTask.get(id) ?? 0));
    const overlapReady = Math.max(0, ...overlaps.filter(id => (orderIndex.get(id) ?? Infinity) < orderIndex.get(taskId)!).map(id => finishByTask.get(id) ?? 0));
    const slot = workSlots.indexOf(Math.min(...workSlots));
    const workStartMs = Math.max(workSlots[slot], depReady, overlapReady);
    const workFinishMs = workStartMs + work.durationMs!;
    workSlots[slot] = workFinishMs;
    const checkSlot = checkerSlots.indexOf(Math.min(...checkerSlots));
    const checkerStartMs = Math.max(checkerSlots[checkSlot], workFinishMs);
    const checkerFinishMs = checkerStartMs + check.durationMs!;
    checkerSlots[checkSlot] = checkerFinishMs;
    finishByTask.set(taskId, checkerFinishMs);
    tasks.push({ taskId, status: 'simulated', outcome, workStartMs, workFinishMs, checkerStartMs, checkerFinishMs });
  }
  const known = tasks.filter(t => t.status === 'simulated');
  return {
    label: 'simulated',
    assumptions: { ...options, timeOrigin: 'zero', ordering: 'first observed event; explicit dependencies constrain start; capacities bound slots' },
    tasks,
    makespanMs: known.length === data.header.selected.taskIds.length ? Math.max(0, ...known.map(t => t.checkerFinishMs!)) : null,
  };
}
