import assert from "node:assert/strict";
import {
  DEFAULT_TTL_SECONDS,
  DISCONNECT_GRACE_SECONDS,
  HEARTBEAT_SECONDS,
  LONG_HOLD_SECONDS,
  LeaseFence,
  reconnectWithinGrace,
  runFaultInjection,
  simulateScenario,
  formatResult,
  type DesignId,
  type Faults,
} from "./renewal.ts";

const designs: DesignId[] = ["A", "B", "C", "D"];
const scenario: Faults = {
  disconnectAt: 120,
  disconnectSeconds: 900,
  sleepAt: 1_800,
  sleepSeconds: 600,
  reviewSeconds: 720,
  restartAt: 1_000,
  clockSkewSeconds: -90,
  abandonAt: null,
};

assert.equal(DEFAULT_TTL_SECONDS, 300, "five minutes remains the default");
assert.equal(LONG_HOLD_SECONDS, 7_200, "long hold is an explicit two-hour exception");
assert.equal(HEARTBEAT_SECONDS, 100, "client keepalive is one third of the default TTL");
assert.equal(DISCONNECT_GRACE_SECONDS, 45, "session reconnect grace follows the Chubby example");

// An expired holder cannot write after a replacement receives a higher fence.
const lock = new LeaseFence();
const firstFence = lock.claim("agent-1", 0);
assert.equal(lock.protectedWrite("agent-1", firstFence, 299), true);
assert.equal(lock.renew("agent-1", firstFence, 301), false);
assert.equal(lock.protectedWrite("agent-1", firstFence, 301), false);
const secondFence = lock.claim("agent-2", 301);
assert.ok(secondFence > firstFence);
assert.equal(lock.protectedWrite("agent-1", firstFence, 302), false);
assert.equal(lock.protectedWrite("agent-2", secondFence, 302), true);
const serverEpoch = lock.epoch;
lock.restart();
assert.equal(lock.protectedWrite("agent-2", secondFence, 303, serverEpoch), false,
  "a pre-restart request cannot be replayed into the new server epoch");
assert.equal(lock.protectedWrite("agent-2", secondFence, 303), true,
  "durable current holder resumes with the unchanged fence and refreshed epoch");

// Session recovery is allowed only inside grace and only before replacement.
assert.equal(reconnectWithinGrace(100, 100 + DISCONNECT_GRACE_SECONDS), true);
assert.equal(reconnectWithinGrace(100, 101 + DISCONNECT_GRACE_SECONDS), false);
const resumable = new LeaseFence();
const sessionFence = resumable.claim("session-1", 0);
assert.equal(resumable.resumeWithinGrace("session-1", sessionFence, 330, 300), true);
const replacementWins = new LeaseFence();
const oldSessionFence = replacementWins.claim("session-old", 0);
replacementWins.claim("session-new", 301);
assert.equal(replacementWins.resumeWithinGrace("session-old", oldSessionFence, 330, 300), false,
  "grace never revives a session after another holder has claimed the unit");

// A live long review survives designs with an active client keepalive or
// platform-owned review phase. The same disconnect can lose an agent-only hold.
const longReview: Faults = { ...scenario, disconnectAt: 0, disconnectSeconds: 0,
  sleepAt: 0, sleepSeconds: 0, reviewSeconds: 1_200, abandonAt: null, restartAt: 1_000 };
for (const design of ["A", "B", "D"] as DesignId[]) {
  assert.equal(simulateScenario(design, longReview, 0).longReviewLoss, false, `${design} keeps live review`);
}
const abandoned: Faults = { ...longReview, reviewSeconds: 300, abandonAt: 90 };
const abandonedResult = simulateScenario("A", abandoned, 0);
assert.equal(abandonedResult.lost, true, "abandonment expires the lease");
assert.ok(abandonedResult.deadHeld > 0 && abandonedResult.deadHeld <= 5,
  "dead holder occupancy is bounded by the five-minute TTL");

const results = [];
for (const agents of [5, 20]) {
  for (const design of designs) {
    const result = runFaultInjection(design, agents, 0x00c0ffee);
    assert.equal(result.safetyViolations, 0, `${design}/${agents} safety`);
    assert.deepEqual(result, runFaultInjection(design, agents, 0x00c0ffee), "seed is reproducible");
    results.push(result);
  }
}

console.log("lease renewal fault-injection prototype");
console.log("seed=0x00c0ffee; server-authoritative expiry; simulated faults: disconnect, laptop sleep, long review, restart, clock skew, abandonment");
console.log("design | agents | safety violations | wrongly lost live leases | dead-holder minutes | renew calls | completed | >5m review losses | stale writes refused");
for (const result of results) console.log(formatResult(result));
console.log("checks: stale fenced write refused; reconnect at 45s succeeds and at 46s fails; abandonment expires; long review retained by A/B/D when renewal owner remains live");
