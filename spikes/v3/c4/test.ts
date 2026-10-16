import { strict as assert } from "node:assert";
import { type GrantMode, SeededRandom, WaitLine, percentile, unitsOverlap } from "./waitline.ts";

const makeLine = (mode: GrantMode, overrides: { waitMs?: number; turnMs?: number; leaseMs?: number } = {}) => {
  const q = new WaitLine({ mode, waitMs: overrides.waitMs ?? 100, turnMs: overrides.turnMs ?? 20, leaseMs: overrides.leaseMs ?? 80 });
  for (let i = 0; i < 40; i++) q.registerToken(`t${i}`);
  return q;
};
const queued = (r: ReturnType<WaitLine["claim"]>): string => { assert.equal(r.kind, "queued"); assert.ok(r.waitId); return r.waitId!; };

function testTurnGuardsAndFIFO(): void {
  const q = makeLine("fresh-claim");
  const holder = q.claim("holder", "t0", ["file:x"], "holder");
  const first = queued(q.claim("first", "t1", ["file:x"], "first"));
  const second = queued(q.claim("second", "t2", ["file:x"], "second"));
  q.release(holder.leaseId!);
  assert.equal(q.waits.get(first)?.state, "turn");
  assert.equal(q.waits.get(second)?.state, "waiting");
  // Regression: another authenticated agent cannot claim the owner's turn.
  assert.equal(q.claim("second", "t2", ["file:x"], "foreign", first).kind, "rejected");
  // Regression: a later waiter cannot claim its own ID while the first owns priority.
  assert.equal(q.claim("second", "t2", ["file:x"], "jump", second).kind, "rejected");
  const fixedDeadline = q.waits.get(first)!.turnDeadline;
  q.tick(1);
  assert.equal(q.waits.get(first)!.turnDeadline, fixedDeadline);
  const capped = makeLine("fresh-claim", { waitMs: 5, turnMs: 30 });
  const capHolder = capped.claim("holder", "t0", ["file:cap"], "holder");
  const capWait = queued(capped.claim("waiter", "t1", ["file:cap"], "wait"));
  capped.release(capHolder.leaseId!);
  assert.equal(capped.waits.get(capWait)!.turnDeadline, capped.waits.get(capWait)!.deadline);
  const cancelLine = makeLine("fresh-claim");
  const cancelHolder = cancelLine.claim("holder", "t0", ["file:cancel"], "holder");
  const cancelled = queued(cancelLine.claim("cancel", "t1", ["file:cancel"], "cancel"));
  const follower = queued(cancelLine.claim("follower", "t2", ["file:cancel"], "follower"));
  cancelLine.disconnect("cancel");
  assert.equal(cancelLine.waits.get(cancelled)?.state, "cancelled");
  assert.equal(cancelLine.waits.get(follower)?.state, "waiting");
  cancelLine.release(cancelHolder.leaseId!);
  assert.equal(cancelLine.waits.get(follower)?.state, "turn");

  // Cancelling the active turn advances its follower immediately, with no lease blocking it.
  const immediate = makeLine("fresh-claim");
  const ih = immediate.claim("holder", "t0", ["file:cancel-turn"], "holder");
  const iw1 = queued(immediate.claim("cancel-turn", "t1", ["file:cancel-turn"], "first"));
  const iw2 = queued(immediate.claim("next-turn", "t2", ["file:cancel-turn"], "second"));
  immediate.release(ih.leaseId!);
  assert.equal(immediate.waits.get(iw1)?.state, "turn");
  immediate.disconnect("cancel-turn");
  assert.equal(immediate.waits.get(iw1)?.state, "cancelled");
  assert.equal(immediate.waits.get(iw2)?.state, "turn");
  q.assertSafe();
}

function testSimultaneousDeadlines(): void {
  for (const mode of ["automatic", "fresh-claim"] as const) {
    const q = makeLine(mode, { waitMs: 10, turnMs: 10, leaseMs: 10 });
    const holder = q.claim("holder", "t0", ["file:deadline"], "h");
    const waiting = queued(q.claim("waiting", "t1", ["file:deadline"], "w"));
    q.tick(10); // Holder and waiter deadlines coincide; expiry is processed before grants.
    assert.equal(q.leases.has(holder.leaseId!), false);
    assert.equal(q.waits.get(waiting)?.state, "expired");
    assert.equal(q.waits.get(waiting)?.grantCount, 0);
    q.assertSafe();
  }
}

function testOfflineAgentsCannotClaim(): void {
  const q = makeLine("fresh-claim");
  const holder = q.claim("holder", "t0", ["file:offline"], "holder");
  const waitId = queued(q.claim("offline-agent", "t1", ["file:offline"], "wait"));
  q.release(holder.leaseId!);
  assert.equal(q.waits.get(waitId)?.state, "turn");
  q.setOnline("offline-agent", false);
  assert.equal(q.claim("offline-agent", "t1", ["file:offline"], "turn-claim", waitId).kind, "rejected");
  assert.equal(q.claim("offline-agent", "t1", ["file:other"], "new-direct").kind, "rejected");
  assert.equal(q.waits.get(waitId)?.grantCount, 0);
}

function testOriginalRevocationRiskAndFreshBoundary(): void {
  const auto = makeLine("automatic");
  const ah = auto.claim("holder", "t0", ["file:rev"], "h");
  const aw = queued(auto.claim("agent", "t3", ["file:rev"], "w"));
  auto.revokeToken("t3"); auto.release(ah.leaseId!);
  assert.equal(auto.waits.get(aw)?.state, "granted"); // Faithful original: no recheck on grant.
  assert.equal(auto.waits.get(aw)?.grantCount, 1);

  const fresh = makeLine("fresh-claim");
  const fh = fresh.claim("holder", "t0", ["file:rev"], "h");
  const fw = queued(fresh.claim("agent", "t3", ["file:rev"], "w"));
  fresh.release(fh.leaseId!); fresh.revokeToken("t3");
  assert.equal(fresh.claim("agent", "t3", ["file:rev"], "fresh", fw).kind, "rejected");
  assert.equal(fresh.waits.get(fw)?.grantCount, 0);
  fresh.registerToken("t4");
  assert.equal(fresh.claim("agent", "t4", ["file:rev"], "renewed-credential", fw).kind, "granted");
}

function testRetryIdentityAndTerminalRecovery(): void {
  const q = makeLine("fresh-claim", { waitMs: 10, turnMs: 4 });
  const h = q.claim("holder", "t0", ["file:r"], "h");
  const attempt1 = q.claim("agent", "t1", ["file:r"], "task-1-attempt-1");
  assert.equal(q.claim("agent", "t1", ["file:r"], "task-1-attempt-1").waitId, attempt1.waitId);
  assert.equal(q.claim("agent", "t1", ["file:r"], "task-1-attempt-1", undefined, "other-change").kind, "rejected");
  assert.equal(q.claim("agent", "t1", ["file:r"], "same-change-new-request-key").waitId, attempt1.waitId);
  assert.equal(q.claim("agent", "t1", ["file:other"], "task-1-attempt-1").kind, "rejected");
  q.tick(10);
  assert.equal(q.waits.get(attempt1.waitId!)?.state, "expired");
  const attempt2 = q.claim("agent", "t1", ["file:r"], "task-1-attempt-2");
  assert.notEqual(attempt2.waitId, attempt1.waitId);
  q.release(h.leaseId!);
  assert.equal(q.waits.get(attempt2.waitId!)?.state, "turn");
  const grant = q.claim("agent", "t1", ["file:r"], "claim-2", attempt2.waitId);
  assert.equal(grant.kind, "granted");
  assert.equal(q.events.filter(e => e.waitId === attempt2.waitId && e.type === "fresh_claim_granted").length, 1);
  assert.equal(q.claim("agent", "t1", ["file:r"], "stale-turn-retry", attempt2.waitId).kind, "rejected");
  const foreignChange = makeLine("fresh-claim");
  const fh = foreignChange.claim("holder", "t0", ["file:c"], "h");
  const fw = queued(foreignChange.claim("agent", "t1", ["file:c"], "wait", undefined, "change-a"));
  foreignChange.release(fh.leaseId!);
  assert.equal(foreignChange.claim("agent", "t1", ["file:c"], "claim", fw, "change-b").kind, "rejected");
  assert.equal(foreignChange.waits.get(fw)?.state, "turn");
  q.tick(80); // A later task attempt follows lease expiry; the old wait result is not replayed.
  assert.equal(q.claim("agent", "t1", ["file:r"], "task-1-attempt-3").kind, "granted");
  q.assertSafe();
}

function testQueuedRequestCannotCreateHoldAndWait(): void {
  for (const mode of ["automatic", "fresh-claim"] as const) {
    const q = makeLine(mode);
    const xHolder = q.claim("x-holder", "t0", ["file:x"], "x-holder");
    const waiting = queued(q.claim("agent", "t1", ["file:x"], "wait-x", undefined, "change-a"));
    assert.equal(q.claim("agent", "t1", ["file:y"], "acquire-y", undefined, "change-a").kind, "rejected");
    q.release(xHolder.leaseId!);
    if (mode === "automatic") assert.equal(q.waits.get(waiting)?.state, "granted");
    else {
      assert.equal(q.waits.get(waiting)?.state, "turn");
      assert.equal(q.claim("agent", "t1", ["file:x"], "fresh", waiting, "change-a").kind, "granted");
    }
    assert.equal([...q.leases.values()].filter(l => l.agent === "agent" && l.phase === "writing").length, 1);
    q.assertSafe();

    // Exercise the defensive grant-path guard against state left by an older queued request.
    const defensive = makeLine(mode);
    const blocker = defensive.claim("blocker", "t0", ["file:blocked"], "blocker");
    const queuedWait = queued(defensive.claim("agent", "t1", ["file:blocked"], "wait", undefined, "change-a"));
    defensive.leases.set("legacy-hold", { id: "legacy-hold", agent: "agent", units: ["file:free"], grantedAt: 0, expiresAt: 50, phase: "writing" });
    defensive.release(blocker.leaseId!);
    assert.equal(defensive.waits.get(queuedWait)?.state, "waiting");
    if (mode === "fresh-claim") assert.equal(defensive.claim("agent", "t1", ["file:blocked"], "bypass", queuedWait, "change-a").kind, "rejected");
    defensive.release("legacy-hold");
    if (mode === "automatic") assert.equal(defensive.waits.get(queuedWait)?.state, "granted");
    else {
      assert.equal(defensive.waits.get(queuedWait)?.state, "turn");
      assert.equal(defensive.claim("agent", "t1", ["file:blocked"], "claim", queuedWait, "change-a").kind, "granted");
    }
  }
}

function testMultiUnitNoBargingAndHolderExpiry(): void {
  for (const mode of ["automatic", "fresh-claim"] as const) {
    const q = makeLine(mode, { waitMs: 30, leaseMs: 10 });
    const h1 = q.claim("holder-a", "t0", ["file:a"], "a");
    const h2 = q.claim("holder-b", "t1", ["file:b"], "b");
    const multi = queued(q.claim("multi", "t2", ["file:a", "file:b"], "multi"));
    const late = queued(q.claim("late", "t3", ["file:a"], "barge"));
    assert.equal(q.waits.get(late)?.state, "waiting");
    q.release(h1.leaseId!);
    assert.equal(q.waits.get(multi)?.grantCount, 0, "multi-unit wait must remain all-or-nothing");
    q.tick(10); // The remaining holder expires while the wait is still live.
    if (mode === "automatic") assert.equal(q.waits.get(multi)?.state, "granted");
    else {
      assert.equal(q.waits.get(multi)?.state, "turn");
      assert.equal(q.claim("multi", "t2", ["file:a", "file:b"], "claim", multi).kind, "granted");
    }
    assert.equal(q.waits.get(multi)?.grantCount, 1);
    q.assertSafe();
  }
}

function testPublishedHoldsAndDeadlockRule(): void {
 for (const mode of ["automatic", "fresh-claim"] as const) {
  const q = makeLine(mode);
  const a = q.claim("a", "t0", ["file:a"], "a");
  const b = q.claim("b", "t1", ["file:b"], "b");
  // The model forbids growing a writing hold, so the two-agent cycle cannot form.
  assert.equal(q.claim("a", "t0", ["file:b"], "grow").kind, "rejected");
  assert.equal(q.claim("b", "t1", ["file:a"], "grow").kind, "rejected");
  const publishedWait = queued(q.claim("c", "t2", ["file:a"], "published-wait"));
  assert.equal(q.publish(a.leaseId!), true);
  let overlappingPublishedLease: string;
  if (mode === "automatic") {
    assert.equal(q.waits.get(publishedWait)?.state, "granted");
    overlappingPublishedLease = q.waits.get(publishedWait)!.leaseId!;
  }
  else {
    assert.equal(q.waits.get(publishedWait)?.state, "turn");
    const publishedClaim = q.claim("c", "t2", ["file:a"], "published-claim", publishedWait);
    assert.equal(publishedClaim.kind, "granted"); overlappingPublishedLease = publishedClaim.leaseId!;
  }
  assert.equal(q.publish(overlappingPublishedLease!), true);
  // Both published holds overlap and remain present through the landing phase.
  assert.equal([...q.leases.values()].filter(l => l.phase === "published").length, 2);
  assert.equal(q.setLanding(a.leaseId!), true);
  assert.equal(q.leases.has(a.leaseId!), true);
  assert.equal(q.release(a.leaseId!, "terminal_landing"), true);
  assert.equal(q.leases.has(a.leaseId!), false);
  assert.equal(q.leases.has(overlappingPublishedLease!), true);
  q.assertSafe();
  assert.equal(unitsOverlap(["file:x"], ["symbol:x#one"]), true);
  assert.equal(unitsOverlap(["symbol:x#one"], ["symbol:x#two"]), false);
 }
}

interface PlanEvent { at: number; kind: "arrival" | "crash" | "revoke"; agent: number; task?: number; unit?: number; duration?: number; }
interface Result { completed: number; onlineGrants: number; waitingGrants: number; calls: number; wasted: number; p95: number; revocationGrants: number; }
function plan(seed: number, count: number): PlanEvent[] {
  const arrivals = new SeededRandom(seed ^ 0xA11CE);
  const crashes = new SeededRandom(seed ^ 0xC4A5);
  const revocations = new SeededRandom(seed ^ 0x5E70);
  const events: PlanEvent[] = [];
  for (let a = 0; a < count; a++) {
    // Fixed workload and fault streams are identical for both grant modes.
    let at = arrivals.int(0, 3);
    for (let task = 0; task < 3; task++) {
      at += arrivals.int(4, 10);
      events.push({ at, kind: "arrival", agent: a, task, unit: arrivals.int(0, 4), duration: arrivals.int(4, 12) });
    }
    if (crashes.next() < 0.3) events.push({ at: crashes.int(15, 55), kind: "crash", agent: a });
    if (revocations.next() < 0.2) events.push({ at: revocations.int(12, 70), kind: "revoke", agent: a });
  }
  return events.sort((a, b) => a.at - b.at || a.agent - b.agent || a.kind.localeCompare(b.kind));
}

function simulate(mode: GrantMode, count: number, seed: number, turnMs: number, reactionMs: number, attemptProbability: number): Result {
  const q = new WaitLine({ mode, waitMs: 90, turnMs, leaseMs: 24 });
  const behavior = Array.from({ length: count }, (_, id) => new SeededRandom(seed ^ 0xB311 ^ (id * 0x9E3779B9)));
  const events = plan(seed, count), agents = Array.from({ length: count }, (_, id) => ({
    id, token: `sim-${id}`, online: true, completed: new Set<number>(), activeTask: undefined as number | undefined,
    taskDuration: 7, activeUnit: undefined as string | undefined, waitId: undefined as string | undefined, leaseId: undefined as string | undefined,
    releaseAt: 0, pendingClaimAt: -1, pendingWaitId: undefined as string | undefined, attempts: new Map<number, number>(), pending: [] as PlanEvent[],
  }));
  agents.forEach(a => q.registerToken(a.token));
  const byTime = new Map<number, PlanEvent[]>();
  for (const e of events) byTime.set(e.at, [...(byTime.get(e.at) ?? []), e]);
  const latency: number[] = []; let onlineGrants = 0, wasted = 0, revocationGrants = 0;
  const grantSeen = new Set<string>();
  for (let t = 0; t < 110; t++) {
    if (t) q.tick(1); // One common event clock; per-request latency schedules delivery only.
    for (const event of byTime.get(t) ?? []) {
      const agent = agents[event.agent];
      if (event.kind === "crash") { agent.online = false; q.setOnline(agent.id.toString(), false); }
      else if (event.kind === "revoke") q.revokeToken(agent.token);
      else if (event.kind === "arrival") agent.pending.push(event);
    }
    for (const agent of agents) {
      if (agent.leaseId) {
        const lease = q.leases.get(agent.leaseId);
        if (!lease) {
          agent.leaseId = undefined;
          if (agent.online && agent.activeTask !== undefined && agent.activeUnit) {
            const task = agent.activeTask, attempt = (agent.attempts.get(task) ?? 0) + 1;
            agent.attempts.set(task, attempt);
            const retry = q.claim(agent.id.toString(), agent.token, [agent.activeUnit], `task-${task}-attempt-${attempt}`);
            if (retry.kind === "granted") { agent.leaseId = retry.leaseId; agent.releaseAt = t + agent.taskDuration; }
            else agent.waitId = retry.waitId;
          }
          continue;
        }
        if (!agent.online) continue;
        if (t >= agent.releaseAt) {
          q.release(agent.leaseId, "completed_release");
          if (agent.activeTask !== undefined) agent.completed.add(agent.activeTask);
          agent.activeTask = undefined; agent.leaseId = undefined;
        }
      }
      if (agent.waitId) {
        const w = q.waits.get(agent.waitId)!;
        if (w.state === "granted" && !grantSeen.has(w.id)) {
          grantSeen.add(w.id);
          if (w.onlineAtGrant) { onlineGrants++; latency.push((w.grantedAt ?? t) - w.createdAt); }
          if (!w.authorizedAtGrant) revocationGrants++;
          if (agent.online && w.leaseId) { agent.leaseId = w.leaseId; agent.releaseAt = (w.grantedAt ?? t) + agent.taskDuration; }
          agent.waitId = undefined; agent.pendingClaimAt = -1; agent.pendingWaitId = undefined;
        } else if (["expired", "cancelled", "revoked"].includes(w.state)) {
          agent.waitId = undefined; agent.pendingClaimAt = -1; agent.pendingWaitId = undefined;
          if (agent.online && agent.activeTask !== undefined && agent.activeUnit) {
            const task = agent.activeTask, attempt = (agent.attempts.get(task) ?? 0) + 1;
            agent.attempts.set(task, attempt);
            const retry = q.claim(agent.id.toString(), agent.token, [agent.activeUnit], `task-${task}-attempt-${attempt}`);
            if (retry.kind === "granted") { agent.leaseId = retry.leaseId; agent.releaseAt = t + agent.taskDuration; }
            else agent.waitId = retry.waitId;
          }
        } else if (agent.online && mode === "fresh-claim" && w.state === "turn" && agent.pendingWaitId !== w.id) {
          agent.pendingWaitId = w.id; agent.pendingClaimAt = t + reactionMs;
        } else if (agent.online && mode === "fresh-claim" && w.state === "turn" && t >= agent.pendingClaimAt) {
          if (behavior[agent.id].next() > attemptProbability) { agent.pendingClaimAt = t + reactionMs; continue; }
          const attempt = (agent.attempts.get(agent.activeTask ?? -1) ?? 0) + 1;
          if (agent.activeTask !== undefined) agent.attempts.set(agent.activeTask, attempt);
          const result = q.claim(agent.id.toString(), agent.token, w.units, `turn-${w.id}-attempt-${attempt}`, w.id, w.changeId);
          if (result.kind === "granted") {
            onlineGrants++; latency.push(t - w.createdAt); grantSeen.add(w.id);
            agent.leaseId = result.leaseId; agent.releaseAt = t + agent.taskDuration; agent.waitId = undefined;
            agent.pendingClaimAt = -1; agent.pendingWaitId = undefined;
          } else if (result.kind === "rejected" && w.state !== "turn") { agent.waitId = undefined; agent.pendingClaimAt = -1; agent.pendingWaitId = undefined; }
        }
      }
      if (agent.online && agent.activeTask === undefined && !agent.waitId && !agent.leaseId && agent.pending.length) {
        const task = agent.pending.shift()!;
        if (task.task !== undefined && !agent.completed.has(task.task)) {
          const attempt = (agent.attempts.get(task.task) ?? 0) + 1;
          agent.attempts.set(task.task, attempt); agent.activeTask = task.task;
          agent.taskDuration = task.duration ?? 7; agent.activeUnit = `file:u${task.unit}`;
          const result = q.claim(agent.id.toString(), agent.token, [agent.activeUnit], `task-${task.task}-attempt-${attempt}`);
          if (result.kind === "granted") { agent.leaseId = result.leaseId; agent.releaseAt = t + agent.taskDuration; }
          else if (result.waitId) agent.waitId = result.waitId;
          else agent.activeTask = undefined;
        }
      }
    }
    q.assertSafe();
    // Integrate occupied unit-time over this same fixed 110-tick observation window.
    for (const lease of q.leases.values()) {
      const owner = agents[Number(lease.agent)];
      if (!owner?.online && lease.phase === "writing" && lease.expiresAt > t) wasted += lease.units.length;
    }
    for (const wait of q.liveWaits()) if (wait.state === "turn") wasted += wait.units.length;
  }
  return { completed: agents.reduce((n, a) => n + a.completed.size, 0), onlineGrants, waitingGrants: grantSeen.size,
    calls: q.calls, wasted, p95: percentile(latency, 0.95), revocationGrants };
}

interface Cell { mode: GrantMode; agents: number; turn: number; reaction: number; probability: number; values: Result[]; }
function mean(values: number[]): number { return values.reduce((a, b) => a + b, 0) / Math.max(1, values.length); }
function interval(values: number[]): string {
  const avg = mean(values), half = 1.96 * Math.sqrt(values.reduce((s, v) => s + (v - avg) ** 2, 0) / (values.length - 1) / values.length);
  return `${avg.toFixed(2)} [${Math.max(0, avg - half).toFixed(2)}, ${(avg + half).toFixed(2)}]`;
}
function runExperiments(): string[] {
  const cells: Cell[] = [];
  for (const agents of [2, 5, 10, 25]) for (const mode of ["automatic", "fresh-claim"] as const) {
    const values = Array.from({ length: 200 }, (_, i) => simulate(mode, agents, 0xC0A4 + agents + 7919 * i, 45, 2, 0.6));
    cells.push({ mode, agents, turn: 45, reaction: 2, probability: 0.6, values });
  }
  // Factorial sensitivity on the same 25-agent traces: turn, reaction delay, and polling-attempt probability.
  for (const turn of [9, 45, 90]) for (const reaction of [1, 2, 4]) for (const probability of [0.25, 0.6, 1]) {
    if (turn === 45 && reaction === 2 && probability === 0.6) continue;
    cells.push({ mode: "fresh-claim", agents: 25, turn, reaction, probability,
      values: Array.from({ length: 200 }, (_, i) => simulate("fresh-claim", 25, 0xC0A4 + 25 + 7919 * i, turn, reaction, probability)) });
  }
  return cells.map(c => {
    const col = (f: (r: Result) => number) => interval(c.values.map(f));
    return `mode=${c.mode} agents=${c.agents} seeds=200 turn_ticks=${c.turn} reaction_ticks=${c.reaction} attempt_probability=${c.probability.toFixed(2)} turn_reaction=${(c.turn / c.reaction).toFixed(1)}x completed=${col(r => r.completed)} online_wait_grants=${col(r => r.onlineGrants)} waiting_grants=${col(r => r.waitingGrants)} calls=${col(r => r.calls)} wasted_unit_ticks=${col(r => r.wasted)} p95_action_ticks=${col(r => r.p95)} revoked_auto_grants=${col(r => r.revocationGrants)}`;
  });
}

testTurnGuardsAndFIFO();
testSimultaneousDeadlines();
testOfflineAgentsCannotClaim();
testOriginalRevocationRiskAndFreshBoundary();
testRetryIdentityAndTerminalRecovery();
testQueuedRequestCannotCreateHoldAndWait();
testMultiUnitNoBargingAndHolderExpiry();
testPublishedHoldsAndDeadlockRule();
console.log("deterministic tests: 8 scenarios passed (FIFO/turn guards, simultaneous deadlines, offline claim rejection, revocation, retry recovery, queued hold-and-wait prevention, multi-unit expiry progression, published holds)");
console.log("seeded comparison: 200 paired workload/fault traces per cell; 95% confidence intervals; common integer-tick event clock; sensitivity sweeps turn length, reaction delay, and attempt probability");
console.log(runExperiments().join("\n"));
