import assert from "node:assert/strict";
import {
  DEFAULT_TTL_SECONDS, DISCONNECT_GRACE_SECONDS, HEARTBEAT_SECONDS, LONG_HOLD_SECONDS,
  LeaseFence, meanInterval, phaseAt, runFaultInjection, seededFaults, simulateScenario,
  formatResult, type DesignId, type Faults,
} from "./renewal.ts";

const designs: DesignId[] = ["A", "B", "C", "D", "BD"];
assert.equal(DEFAULT_TTL_SECONDS, 300);
assert.equal(LONG_HOLD_SECONDS, 7_200);
assert.equal(HEARTBEAT_SECONDS, 100);
assert.equal(DISCONNECT_GRACE_SECONDS, 45);

// Renew extends expiry while preserving the same fence; concurrent claim is refused.
const lease = new LeaseFence();
const fence = lease.claim("same-principal", 0);
assert.equal(lease.renew("same-principal", fence, 100), true);
assert.equal(lease.expiry, 400);
assert.equal(lease.protectedWrite("same-principal", fence, 101, lease.epoch), true,
  "successful renewal preserves the original fence");
assert.throws(() => lease.claim("other", 101), /LEASE_CONFLICT/);
assert.equal(lease.protectedWrite("same-principal", fence, 399, lease.epoch), true);
assert.equal(lease.renew("same-principal", fence, 401), false, "a lapsed lease needs a new claim");
assert.equal(lease.protectedWrite("same-principal", fence, 401, lease.epoch), false);
const reacquired = lease.claim("same-principal", 401);
assert.ok(reacquired > fence, "same-principal reacquisition gets a higher fence");
assert.equal(lease.protectedWrite("same-principal", fence, 402, lease.epoch), false,
  "holder identity alone cannot authorize a stale write");
assert.equal(lease.protectedWrite("same-principal", reacquired, 402, lease.epoch), true);

// Epoch is mandatory and restart invalidates a queued pre-restart operation.
const preRestartEpoch = lease.epoch;
lease.restart();
assert.equal(lease.protectedWrite("same-principal", reacquired, 403, preRestartEpoch), false);
assert.equal(lease.protectedWrite("same-principal", reacquired, 403, lease.epoch), true);

// Recovery uses stored expiry: exactly 45 seconds is allowed, 46 is refused.
const grace = new LeaseFence();
const graceFence = grace.claim("session", 0);
assert.equal(grace.resumeWithinGrace("session", graceFence, 345), true);
const tooLate = new LeaseFence();
const tooLateFence = tooLate.claim("session", 0);
assert.equal(tooLate.resumeWithinGrace("session", tooLateFence, 346), false);
assert.equal(tooLate.resumeWithinGrace("session", tooLateFence, 330), true,
  "a rejected late attempt does not erase the still-open stored deadline");
assert.equal(tooLate.resumeWithinGrace("session", tooLateFence, 631), true,
  "a second lapse starts a new grace window from the renewed expiry");
const replaced = new LeaseFence();
const old = replaced.claim("session-old", 0);
replaced.claim("session-new", 301);
assert.equal(replaced.resumeWithinGrace("session-old", old, 330), false);
assert.equal(replaced.renew("session-old", old, 302), false);

const phaseDurations = { inspectionSeconds: 300, reviewSeconds: 600, queueSeconds: 300 };
assert.equal(phaseAt(599, phaseDurations), "editing");
assert.equal(phaseAt(600, phaseDurations), "checks");
assert.equal(phaseAt(900, phaseDurations), "review");
assert.equal(phaseAt(1_500, phaseDurations), "queue");
assert.equal(phaseAt(1_800, phaseDurations), "landed");

const base: Faults = {
  disconnectAt: -1, disconnectSeconds: 0, sleepAt: -1, sleepSeconds: 0,
  inspectionSeconds: 300, reviewSeconds: 1_200, queueSeconds: 600,
  restartAt: 503, clockRatePpm: 100_000, abandonAt: null, abandonmentSignal: false,
};
const longOfflineReview = { ...base, disconnectAt: 650, disconnectSeconds: 285, restartAt: -1 };
assert.equal(simulateScenario("A", longOfflineReview).landed, false);
assert.equal(simulateScenario("B", longOfflineReview).landed, true,
  "server-held review keeps the nonblocking landing authorization alive");
assert.ok(simulateScenario("D", longOfflineReview).reconnects > 0,
  "session design recovers inside the stored lapse grace");
assert.equal(simulateScenario("BD", base).restarts, 1,
  "off-grid restart event is delivered by crossing its event time");
assert.ok(simulateScenario("BD", base).staleRefused > 0,
  "pre-restart packet is checked against the incremented epoch");
assert.equal(simulateScenario("D", base).landed, true, "session design resumes after restart with the refreshed epoch");
assert.equal(simulateScenario("A", base).landed, false, "agent-only design fails closed on a stale restart packet");
assert.ok(simulateScenario("A", { ...base, reviewSeconds: 0, inspectionSeconds: 0, queueSeconds: 0 }).renews < 10,
  "client timer is not a heartbeat on every simulation step");
assert.notEqual(simulateScenario("A", { ...base, clockRatePpm: -100_000 }).renews,
  simulateScenario("A", { ...base, clockRatePpm: 100_000 }).renews,
  "clock drift changes heartbeat scheduling");

// A second disconnect gets a new recovery opportunity after the first recovery,
// including one lapse before publication and another during landing permission.
const repeatedDisconnects = { ...base, disconnectAt: 250, disconnectSeconds: 280, sleepAt: 650, sleepSeconds: 280 };
assert.ok(simulateScenario("D", repeatedDisconnects).reconnects >= 2,
  "each lapse has its own grace recovery, before and after publication");
const noGrace = simulateScenario("D", repeatedDisconnects, { disableGrace: true });
assert.throws(() => assert.ok(noGrace.reconnects >= 2), "disabling grace must break repeated recovery");
console.log(`mutation probe: grace disabled => reconnects=${noGrace.reconnects} (caught)`);
const lostDuringEdit = { ...base, disconnectAt: 250, disconnectSeconds: 500 };
assert.equal(simulateScenario("D", lostDuringEdit).published, false,
  "lost editing authorization cannot be converted into fresh landing permission");

// A server has no abandonment oracle. Only an explicit signal ends server renewal.
const reviewAbandon = { ...base, abandonAt: 1_000, restartAt: -1 };
const unannounced = simulateScenario("B", reviewAbandon);
const announced = simulateScenario("B", { ...reviewAbandon, abandonmentSignal: true });
assert.ok(unannounced.serverExtensions > announced.serverExtensions);
assert.equal(unannounced.abandonedPhase, "review");
const laterAbandonment = simulateScenario("A", {
  ...base, restartAt: -1, disconnectAt: 650, disconnectSeconds: 400, abandonAt: 1_200,
});
assert.equal(laterAbandonment.reviewLoss, false,
  "a later abandonment removes the scenario from review-loss results");

// Abandonment is drawn across every phase; fault scheduling is not tied to agent index.
const phasesSeen = new Set(Array.from({ length: 500 }, (_, s) => {
  const f = seededFaults(s + 1, s % 17);
  return f.abandonAt === null ? "none" : phaseAt(f.abandonAt, f);
}));
for (const phase of ["editing", "checks", "review", "queue"]) assert.ok(phasesSeen.has(phase), `abandonment covers ${phase}`);
assert.notDeepEqual(seededFaults(17, 0), seededFaults(18, 0));

// The reported safety counter is driven by actual writes. Deliberately disable
// the fence check as a mutation: the fault run must observe accepted stale writes.
const safetyFault = { ...base, disconnectAt: 0, disconnectSeconds: 900 };
const broken = simulateScenario("A", safetyFault, { writeCheck: () => true });
assert.ok(broken.safety > 0, "write-check mutation produces measurable safety violations");
const safe = simulateScenario("A", safetyFault);
assert.equal(safe.safety, 0);
console.log(`mutation probe: always-accept write guard => safetyViolations=${broken.safety} (caught)`);
const expiryBlind = simulateScenario("A", safetyFault, {
  writeCheck: (l, h, f, _now, e) => h === l.owner && f === l.fence && e === l.epoch,
});
assert.ok(expiryBlind.safety > 0, "an expiry-blind guard must count every accepted expired write");
console.log(`mutation probe: write guard ignores expiry => safetyViolations=${expiryBlind.safety} (caught)`);

// Suppressing a contender's increment must fail the fencing invariant.
const normalClaim = new LeaseFence();
const oldClaimFence = normalClaim.claim("holder", 0);
const newerFence = normalClaim.claim("contender", 301);
assert.ok(newerFence > oldClaimFence);
const suppressedClaim = new LeaseFence();
const suppressedOldFence = suppressedClaim.claim("holder", 0);
const suppressedNewFence = suppressedClaim.claim("contender", 301, DEFAULT_TTL_SECONDS, false);
assert.throws(() => assert.ok(suppressedNewFence > suppressedOldFence), "suppressed fence increment must fail");
console.log(`mutation probe: contender fence increment suppressed => ${suppressedOldFence} -> ${suppressedNewFence} (caught)`);

// 200 independent paired seeds per size; separate seed namespaces keep the 5- and
// 20-agent draws independent. Confidence intervals describe variation across seeds.
const allRows: Array<{ design: DesignId; agents: number; metric: string; mean: number; low: number; high: number }> = [];
const aggregateRows: string[] = [];
for (const agents of [5, 20]) {
  const seedBase = agents === 5 ? 0x005c5eed : 0x020c5eed;
  const runs = new Map<DesignId, ReturnType<typeof runFaultInjection>[]>();
  for (const design of designs) runs.set(design, []);
  for (let i = 0; i < 200; i++) {
    const seed = (seedBase + Math.imul(i + 1, 0x9e3779b1)) >>> 0;
    for (const design of designs) runs.get(design)!.push(runFaultInjection(design, agents, seed));
  }
  for (const design of designs) {
    const samples = runs.get(design)!;
    const perAgent = (pick: (x: ReturnType<typeof runFaultInjection>) => number): number[] => samples.map(x => pick(x) / agents);
    const metrics = [
      ["outage lapses/agent", perAgent(x => x.outageLapses)],
      ["dead-held min/agent", perAgent(x => x.deadHeldAgentMinutes)],
      ["client renewals/agent", perAgent(x => x.renewCalls)],
      ["landed fraction", perAgent(x => x.landed)],
      ["review losses/agent", perAgent(x => x.reviewPhaseLosses)],
    ] as const;
    for (const [metric, values] of metrics) {
      const ci = meanInterval(values);
      allRows.push({ design, agents, metric, ...ci });
    }
    const sums = samples.reduce((a, x) => ({
      safety: a.safety + x.safetyViolations, stale: a.stale + x.staleWritesRefused,
      reconnect: a.reconnect + x.reconnectsWithinGrace, restarts: a.restarts + x.restartEpochs,
      server: a.server + x.serverExtensions,
    }), { safety: 0, stale: 0, reconnect: 0, restarts: 0, server: 0 });
    aggregateRows.push(`${design} | ${agents} | ${sums.safety} | ${sums.stale} | ${sums.reconnect} | ${sums.restarts} | ${sums.server} | ${samples.reduce((n, x) => n + x.shortOutages, 0)} | ${samples.reduce((n, x) => n + x.longOutages, 0)}`);
  }
}

console.log("lease renewal simulation: 200 independent seeds per size; each seed is paired across designs");
console.log("design | agents | metric (mean [95% CI])");
for (const row of allRows) console.log(`${row.design} | ${row.agents} | ${row.metric}: ${row.mean.toFixed(3)} [${row.low.toFixed(3)}, ${row.high.toFixed(3)}]`);
console.log("safety aggregate over 200 seeds | agents | accepted unauthorized writes | refused stale writes | grace recoveries | restart events | server phase extensions | outages <=45s | outages >45s");
for (const row of aggregateRows) console.log(row);
console.log("sample detail format:", formatResult(runFaultInjection("A", 5, 0x00c0ffee)));
