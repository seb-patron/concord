import { strict as assert } from "node:assert";
import { type GrantMode, SeededRandom, WaitLine, percentile, unitsOverlap } from "./waitline.ts";

function line(mode: GrantMode, options: { waitMs?: number; turnMs?: number; leaseMs?: number } = {}): WaitLine {
  const result = new WaitLine({ mode, now: 0, waitMs: options.waitMs ?? 100, turnMs: options.turnMs ?? 20, leaseMs: options.leaseMs ?? 80 });
  for (let i = 0; i < 40; i++) result.registerToken(`t${i}`);
  return result;
}
function requireKind(lineResult: ReturnType<WaitLine["claim"]>, kind: string): void {
  assert.equal(lineResult.kind, kind);
}
function wait(lineResult: ReturnType<WaitLine["claim"]>): string {
  assert.ok(lineResult.waitId);
  return lineResult.waitId!;
}

function testNoBarging(mode: GrantMode): void {
  const q = line(mode);
  const holder = q.claim("holder", "t0", ["file:src/a.ts"], "h");
  const one = wait(q.claim("one", "t1", ["symbol:src/a.ts#f"], "one"));
  const two = wait(q.claim("two", "t2", ["file:src/a.ts"], "two"));
  q.release(holder.leaseId!);
  assert.equal(q.waits.get(one)?.state, mode === "automatic" ? "granted" : "turn");
  assert.equal(q.waits.get(two)?.state, "waiting");
  const late = q.claim("late", "t3", ["file:src/a.ts"], "late");
  requireKind(late, "queued");
  assert.equal(q.waits.get(two)?.sequence! < q.waits.get(late.waitId!)?.sequence!, true);
  q.assertSafe();
}

function testRevokedToken(mode: GrantMode): void {
  const q = line(mode);
  const holder = q.claim("holder", "t0", ["file:src/revoked.ts"], "h");
  const revoked = wait(q.claim("revoked", "t4", ["file:src/revoked.ts"], "revoked"));
  const next = wait(q.claim("next", "t5", ["file:src/revoked.ts"], "next"));
  q.revokeToken("t4");
  q.release(holder.leaseId!);
  assert.equal(q.waits.get(revoked)?.state, mode === "automatic" ? "revoked" : "turn");
  assert.equal(q.waits.get(revoked)?.grantCount, 0);
  if (mode === "fresh-claim") {
    requireKind(q.claim("revoked", "t4", ["file:src/revoked.ts"], "revoked-fresh", revoked), "rejected");
    q.tick(20); // A turn conveys queue priority, never a lease; the next waiter follows expiry.
    assert.equal(q.waits.get(revoked)?.state, "expired");
  }
  assert.equal(q.waits.get(next)?.state, mode === "automatic" ? "granted" : "turn");
  if (mode === "fresh-claim") {
    const result = q.claim("next", "t5", ["file:src/revoked.ts"], "fresh", next);
    requireKind(result, "granted");
    assert.equal(q.claim("next", "t5", ["file:src/revoked.ts"], "retry", next).leaseId, result.leaseId);
  }
  q.assertSafe();
}

function testMultiUnitAtomic(mode: GrantMode): void {
  const q = line(mode);
  const left = q.claim("left", "t0", ["file:a"], "left");
  const right = q.claim("right", "t1", ["file:b"], "right");
  const both = wait(q.claim("both", "t2", ["file:a", "file:b"], "both"));
  q.release(left.leaseId!);
  assert.equal(q.waits.get(both)?.state, "waiting");
  assert.equal([...q.leases.values()].some(lease => lease.agent === "both"), false);
  q.release(right.leaseId!);
  assert.equal(q.waits.get(both)?.state, mode === "automatic" ? "granted" : "turn");
  const owner = [...q.leases.values()].find(lease => lease.agent === "both");
  if (mode === "automatic") assert.deepEqual(owner?.units, ["file:a", "file:b"]);
  else {
    requireKind(q.claim("both", "t2", ["file:a"], "wrong-subset", both), "rejected");
    requireKind(q.claim("both", "t2", ["file:a", "file:b"], "claim", both), "granted");
  }
  q.assertSafe();
}

function testExpiryDisconnectAndIdempotency(mode: GrantMode): void {
  const q = line(mode, { waitMs: 12, turnMs: 5, leaseMs: 60 });
  const holder = q.claim("holder", "t0", ["file:x"], "h");
  const first = q.claim("expiring", "t6", ["file:x"], "same-key");
  const retry = q.claim("expiring", "t6", ["file:x"], "same-key");
  assert.equal(retry.waitId, first.waitId);
  assert.equal([...q.waits.values()].filter(item => item.agent === "expiring").length, 1);
  const disconnected = wait(q.claim("disconnect", "t7", ["file:x"], "disconnected"));
  q.disconnect("disconnect");
  assert.equal(q.waits.get(disconnected)?.state, "cancelled");
  q.tick(13);
  assert.equal(q.waits.get(first.waitId!)?.state, "expired");
  assert.equal(q.waits.get(first.waitId!)?.grantCount, 0);
  q.release(holder.leaseId!);
  q.assertSafe();
}

function testFreshTurnExpiryAndFreshAuthentication(): void {
  const q = line("fresh-claim", { waitMs: 60, turnMs: 5 });
  const holder = q.claim("holder", "t0", ["file:turn"], "h");
  const waiting = wait(q.claim("agent", "t8", ["file:turn"], "request"));
  q.release(holder.leaseId!);
  assert.equal(q.waits.get(waiting)?.state, "turn");
  q.registerToken("intruder-token");
  q.claim("intruder", "intruder-token", ["file:other"], "bind-intruder");
  requireKind(q.claim("agent", "intruder-token", ["file:turn"], "intruder-claim", waiting), "rejected");
  q.registerToken("agent-renewed-token");
  q.claim("intruder", "agent-renewed-token", ["file:other-2"], "bind-renewed-wrong");
  requireKind(q.claim("agent", "agent-renewed-token", ["file:turn"], "wrong-principal", waiting), "rejected");
  q.revokeToken("t8");
  requireKind(q.claim("agent", "t8", ["file:turn"], "fresh", waiting), "rejected");
  q.tick(5);
  assert.equal(q.waits.get(waiting)?.state, "expired");
  assert.equal(q.waits.get(waiting)?.grantCount, 0);
  q.assertSafe();
}

function testHolderCrashAndDuplicateGrant(mode: GrantMode): void {
  const q = line(mode, { leaseMs: 10 });
  const crashedHolder = q.claim("crash", "t0", ["file:crash"], "crash");
  const next = wait(q.claim("next", "t1", ["file:crash"], "next"));
  q.tick(10); // crashed process never releases; server expiry frees the unit.
  assert.equal(q.waits.get(next)?.state, mode === "automatic" ? "granted" : "turn");
  const record = q.waits.get(next)!;
  assert.equal(record.grantCount, mode === "automatic" ? 1 : 0);
  if (mode === "fresh-claim") q.claim("next", "t1", ["file:crash"], "claim", next);
  const leaseId = q.waits.get(next)?.leaseId;
  if (leaseId) {
    const first = q.claim("next", "t1", ["file:crash"], "retry-1", next);
    const second = q.claim("next", "t1", ["file:crash"], "retry-2", next);
    assert.equal(second.leaseId, first.leaseId);
    assert.equal(q.waits.get(next)?.grantCount, 1);
  }
  assert.equal(q.leases.has(crashedHolder.leaseId!), false);
  q.assertSafe();
}

interface FaultResult {
  mode: GrantMode;
  agents: number;
  seed: number;
  safety: number;
  grants: number;
  p50: number;
  p95: number;
  wasted: number;
  wastedMs: number;
  calls: number;
  starved: number;
  disconnects: number;
  crashes: number;
}

function faultRun(mode: GrantMode, agentCount: number, seed: number): FaultResult {
  const random = new SeededRandom(seed);
  const q = new WaitLine({ mode, waitMs: 85, turnMs: 9, leaseMs: 22 });
  const agents = Array.from({ length: agentCount }, (_, i) => ({
    id: `a${i}`, token: `fault-${i}`, online: true, jobs: 0, leaseId: undefined as string | undefined,
    waitId: undefined as string | undefined, skew: random.int(-4, 4),
  }));
  agents.forEach(agent => q.registerToken(agent.token));
  const latencies: number[] = [];
  const seen = new Set<string>();
  let safety = 0, wasted = 0, wastedMs = 0, disconnects = 0, crashes = 0;
  const maxJobs = 5;

  const observe = (): void => {
    for (const agent of agents) {
      if (!agent.waitId) continue;
      const item = q.waits.get(agent.waitId);
      if (!item) continue;
      if (item.state === "granted" && !seen.has(item.id)) {
        seen.add(item.id);
        latencies.push((item.grantedAt ?? q.now) - item.createdAt);
        agent.leaseId = item.leaseId;
        agent.waitId = undefined;
        if (!agent.online) {
          wasted++;
          const lease = item.leaseId ? q.leases.get(item.leaseId) : undefined;
          if (lease) wastedMs += lease.expiresAt - lease.grantedAt;
        }
      } else if (item.state === "expired" || item.state === "cancelled" || item.state === "revoked") {
        agent.waitId = undefined;
      }
    }
    for (const agent of agents) {
      if (agent.waitId && agent.online && mode === "fresh-claim") {
        const item = q.waits.get(agent.waitId);
        if (item?.state === "turn" && random.next() < 0.38) {
          const delay = Math.max(1, random.int(1, 4) + Math.abs(agent.skew));
          q.tick(delay); // network delay plus skewed caller scheduling; server clock remains authoritative.
          const result = q.claim(agent.id, agent.token, item.units, `fresh-${item.id}-${item.grantCount}`, item.id);
          if (result.kind === "granted") {
            agent.leaseId = result.leaseId;
            agent.waitId = undefined;
            latencies.push(q.now - item.createdAt);
            seen.add(item.id);
          }
        }
      }
    }
  };

  for (let step = 0; step < 190; step++) {
    q.tick(random.int(1, 4));
    observe();
    for (const agent of agents) {
      if (agent.leaseId) {
        const lease = q.leases.get(agent.leaseId);
        if (!lease) { agent.leaseId = undefined; continue; }
        if (agent.online && random.next() < 0.025) {
          agent.online = false; crashes++; // ungraceful holder crash; expiry is the recovery path.
        } else if (agent.online && random.next() < 0.14) {
          q.release(agent.leaseId, "normal_release");
          agent.leaseId = undefined;
          agent.jobs++;
        }
      } else if (agent.waitId && agent.online && random.next() < 0.018) {
        agent.online = false; disconnects++; // server is not told: a realistic lost connection.
      } else if (!agent.waitId && agent.online && agent.jobs < maxJobs && random.next() < 0.20) {
        const unit = random.int(0, 4);
        const requested = random.next() < 0.15 ? [`file:u${unit}`, `file:u${(unit + 1) % 5}`] : [`file:u${unit}`];
        const result = q.claim(agent.id, agent.token, requested, `job-${agent.id}-${agent.jobs}`);
        if (result.kind === "granted") {
          agent.leaseId = result.leaseId;
          agent.jobs++;
        } else if (result.kind === "queued" && result.waitId) agent.waitId = result.waitId;
      }
    }
    observe();
    try { q.assertSafe(); } catch { safety++; }
  }

  // A final bounded drain so every lease/wait deadline is observed once.
  for (let i = 0; i < 30; i++) { q.tick(5); observe(); q.assertSafe(); }
  const starved = [...q.waits.values()].filter(item =>
    item.state === "waiting" || item.state === "turn" || item.state === "expired" ||
    (item.state === "granted" && (item.grantedAt! - item.createdAt) > 60),
  ).length;
  return {
    mode, agents: agentCount, seed, safety, grants: latencies.length,
    p50: percentile(latencies, 0.50), p95: percentile(latencies, 0.95),
    wasted, wastedMs, calls: q.calls, starved, disconnects, crashes,
  };
}

function runTests(): void {
  assert.equal(unitsOverlap(["file:src/a.ts"], ["symbol:src/a.ts#f"]), true);
  assert.equal(unitsOverlap(["symbol:src/a.ts#f"], ["symbol:src/a.ts#g"]), false);
  assert.equal(unitsOverlap(["file:src/a.ts"], ["symbol:src\\a.ts#f"]), true);
  for (const mode of ["automatic", "fresh-claim"] as const) {
    testNoBarging(mode);
    testRevokedToken(mode);
    testMultiUnitAtomic(mode);
    testExpiryDisconnectAndIdempotency(mode);
    testHolderCrashAndDuplicateGrant(mode);
  }
  testFreshTurnExpiryAndFreshAuthentication();
}

runTests();
console.log("deterministic tests: 7 scenarios passed for automatic grant and fresh-claim turn");
console.log("fault injection (seeded xorshift; 190 steps plus bounded drain per case)");
for (const agents of [2, 5, 10, 25]) {
  for (const mode of ["automatic", "fresh-claim"] as const) {
    const result = faultRun(mode, agents, 0xC0A4 + agents);
    assert.equal(result.safety, 0, `${mode}/${agents}: safety violation`);
    console.log(`mode=${mode} agents=${agents} seed=${result.seed} safety=${result.safety} grants=${result.grants} p50_ms=${result.p50} p95_ms=${result.p95} wasted_holds=${result.wasted} wasted_ms=${result.wastedMs} calls=${result.calls} starvation=${result.starved} disconnects=${result.disconnects} crashes=${result.crashes}`);
  }
}
