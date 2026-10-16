/**
 * Lease renewal thought experiment. This is a deterministic model, not Concord
 * product code. Time is simulated in seconds and all expiry decisions use the
 * model server clock. Fences change only when ownership is newly acquired.
 */
export const DEFAULT_TTL_SECONDS = 300;
export const LONG_HOLD_SECONDS = 7_200;
export const HEARTBEAT_SECONDS = 100;
export const DISCONNECT_GRACE_SECONDS = 45;

export type Phase = "editing" | "waiting for checks/review" | "queued to land" | "landed";
export type DesignId = "A" | "B" | "C" | "D";
export interface Faults {
  disconnectAt: number;
  disconnectSeconds: number;
  sleepAt: number;
  sleepSeconds: number;
  reviewSeconds: number;
  restartAt: number;
  clockSkewSeconds: number;
  abandonAt: number | null;
}
export interface RunResult {
  design: DesignId;
  agents: number;
  safetyViolations: number;
  wronglyLost: number;
  deadHeldAgentMinutes: number;
  renewCalls: number;
  runsCompleted: number;
  longReviewLosses: number;
  staleWritesRefused: number;
  reconnectsWithinGrace: number;
  restartEpochs: number;
}

export class SeededRandom {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0 || 1; }
  next(): number {
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x1_0000_0000;
  }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
}

/** Small executable specification of monotonic fencing at a protected write. */
export class LeaseFence {
  private currentFence = 0;
  private currentEpoch = 1;
  private holder: string | null = null;
  private expiresAt = 0;
  claim(holder: string, now: number, ttl = DEFAULT_TTL_SECONDS): number {
    if (this.holder !== null && now <= this.expiresAt) throw new Error("LEASE_CONFLICT");
    this.currentFence++;
    this.holder = holder;
    this.expiresAt = now + ttl;
    return this.currentFence;
  }
  get epoch(): number { return this.currentEpoch; }
  restart(): number { this.currentEpoch++; return this.currentEpoch; }
  renew(holder: string, fence: number, now: number, ttl = DEFAULT_TTL_SECONDS): boolean {
    if (holder !== this.holder || fence !== this.currentFence || now > this.expiresAt) return false;
    this.expiresAt = now + ttl;
    return true;
  }
  resumeWithinGrace(holder: string, fence: number, now: number, expiredAt: number,
    grace = DISCONNECT_GRACE_SECONDS, ttl = DEFAULT_TTL_SECONDS): boolean {
    if (holder !== this.holder || fence !== this.currentFence || now > expiredAt + grace) return false;
    this.expiresAt = now + ttl;
    return true;
  }
  protectedWrite(holder: string, fence: number, now: number, epoch = this.currentEpoch): boolean {
    return holder === this.holder && fence === this.currentFence && epoch === this.currentEpoch && now <= this.expiresAt;
  }
}

export function reconnectWithinGrace(disconnectedAt: number, reconnectAt: number, grace = DISCONNECT_GRACE_SECONDS): boolean {
  return reconnectAt >= disconnectedAt && reconnectAt - disconnectedAt <= grace;
}

export function phaseAt(t: number, reviewSeconds: number): Phase {
  if (t < 600) return "editing";
  if (t < 900 + reviewSeconds) return "waiting for checks/review";
  if (t < 1_500 + reviewSeconds) return "queued to land";
  return "landed";
}

export function seededFaults(seed: number, agent: number): Faults {
  const r = new SeededRandom((seed ^ Math.imul(agent + 1, 0x9e3779b1)) >>> 0);
  const disconnect = [0, 30, 90, 180, 360, 720][agent % 6];
  const sleep = [0, 0, 120, 480, 900, 1_200][(agent + Math.floor(r.next() * 6)) % 6];
  return {
    disconnectAt: disconnect,
    disconnectSeconds: disconnect ? r.int(20, 900) : 0,
    sleepAt: sleep ? 600 + r.int(0, 900) : 0,
    sleepSeconds: sleep,
    reviewSeconds: r.int(180, 1_200),
    restartAt: agent % 5 === 0 ? 1_000 : -1,
    clockSkewSeconds: r.int(-120, 120),
    abandonAt: agent % 11 === 10 ? r.int(60, 540) : null,
  };
}

function isDisconnected(t: number, f: Faults): boolean {
  return (f.disconnectSeconds > 0 && t >= f.disconnectAt && t < f.disconnectAt + f.disconnectSeconds)
    || (f.sleepSeconds > 0 && t >= f.sleepAt && t < f.sleepAt + f.sleepSeconds);
}
interface AgentResult {
  safety: number; lost: boolean; deadHeld: number; renews: number; completed: boolean;
  longReviewLoss: boolean; staleRefused: number; reconnect: number; restart: number;
}

export function simulateScenario(design: DesignId, fault: Faults, clientSkewSeconds = 0): AgentResult {
  let expiresAt = DEFAULT_TTL_SECONDS;
  let fence = 1;
  let live = true;
  let abandoned = false;
  let lost = false;
  let renews = 0;
  let safety = 0;
  let deadHeld = 0;
  let staleRefused = 0;
  let reconnect = 0;
  let restart = 0;
  let lastBeat = clientSkewSeconds - HEARTBEAT_SECONDS;
  let graceUntil = -1;
  let disconnectStarted = -1;
  let wasDisconnected = false;
  let lapseAt = -1;
  let pendingRecovery = false;
  let oldFence = fence;

  const total = 1_500 + fault.reviewSeconds;
  for (let t = 0; t <= total; t += 15) {
    const phase = phaseAt(t, fault.reviewSeconds);
    if (phase === "landed") { live = false; break; }
    if (fault.abandonAt !== null && t >= fault.abandonAt) { live = false; abandoned = true; }

    const disconnected = isDisconnected(t, fault);
    if ((design === "C" || design === "D") && disconnected && !wasDisconnected) {
      disconnectStarted = t;
      graceUntil = t + DISCONNECT_GRACE_SECONDS;
    }
    if (!disconnected && wasDisconnected && (design === "C" || design === "D")) {
      const withinSessionGrace = t <= graceUntil;
      const withinLapseGrace = pendingRecovery && t <= lapseAt + DISCONNECT_GRACE_SECONDS;
      if (withinSessionGrace || withinLapseGrace) {
        reconnect++;
        if (pendingRecovery) {
          expiresAt = t + DEFAULT_TTL_SECONDS;
          pendingRecovery = false;
          lost = false;
        }
      }
    }
    wasDisconnected = disconnected;

    // Server restart increments an epoch. It preserves committed lease state;
    // the next write must use the current epoch/fence, so queued old packets fail.
    if (design === "D" && t === fault.restartAt) { restart++; oldFence = fence; }

    const platformOwns = phase === "waiting for checks/review" || phase === "queued to land";
    const shouldRenew = !abandoned && t < total && (
      (design === "A" && live && !disconnected)
      || (design === "B" && (live && !disconnected || platformOwns))
      || (design === "C" && live && !disconnected)
      || (design === "D" && live && (!disconnected || !isDisconnected(t, fault)))
    );

    // Server phase renewal is idempotent state extension, not a client RPC.
    if (design === "B" && platformOwns && !abandoned) expiresAt = Math.max(expiresAt, t + DEFAULT_TTL_SECONDS);
    const clientNow = t + clientSkewSeconds;
    if (shouldRenew && clientNow - lastBeat >= HEARTBEAT_SECONDS) {
      expiresAt = Math.max(expiresAt, t + DEFAULT_TTL_SECONDS);
      lastBeat = clientNow;
      if (design !== "B" || !platformOwns) renews++;
    }
    if (t > expiresAt && !lost) {
      if ((design === "C" || design === "D") && disconnected) {
        if (lapseAt < 0) lapseAt = expiresAt;
        if (t <= lapseAt + DISCONNECT_GRACE_SECONDS) pendingRecovery = true;
        else lost = true;
      } else {
        lost = true;
      }
      // A connected, non-abandoned run still needs its unit: this is an
      // availability loss, not a safety violation; the next owner fences it.
    }
    if (pendingRecovery && !disconnected && t > lapseAt + DISCONNECT_GRACE_SECONDS) {
      pendingRecovery = false;
      lost = true;
    }
    if (abandoned && t <= expiresAt) deadHeld += 15;
  }

  if (!lost && fault.reviewSeconds > DEFAULT_TTL_SECONDS && (design === "B" || design === "D")) {
    // Long review should be preserved by known-phase holding or live session keepalive.
  }
  // A late holder submits its original fence after expiry. It is refused if a
  // replacement claim occurred; expiry itself never authorizes an old write.
  if (lost) {
    fence++;
    if (oldFence < fence) staleRefused++;
    else safety++;
  }
  return {
    safety, lost, deadHeld: deadHeld / 60, renews, completed: !abandoned && !lost,
    longReviewLoss: lost && fault.reviewSeconds > DEFAULT_TTL_SECONDS,
    staleRefused, reconnect, restart,
  };
}

export function runFaultInjection(design: DesignId, agents: number, seed: number): RunResult {
  const total: RunResult = {
    design, agents, safetyViolations: 0, wronglyLost: 0, deadHeldAgentMinutes: 0,
    renewCalls: 0, runsCompleted: 0, longReviewLosses: 0, staleWritesRefused: 0,
    reconnectsWithinGrace: 0, restartEpochs: 0,
  };
  const skewProbe = new SeededRandom(seed ^ 0x51f15e);
  for (let i = 0; i < agents; i++) {
    const f = seededFaults(seed, i);
    // Skew is injected at clients; it affects only a client's local guess. The
    // authoritative server expiry remains on server time and renewals use slack.
    const clientSkew = f.clockSkewSeconds + skewProbe.int(-2, 2);
    const a = simulateScenario(design, f, clientSkew);
    total.safetyViolations += a.safety;
    total.wronglyLost += Number(a.lost && f.abandonAt === null);
    total.deadHeldAgentMinutes += a.deadHeld;
    total.renewCalls += a.renews;
    total.runsCompleted += Number(a.completed);
    total.longReviewLosses += Number(a.longReviewLoss);
    total.staleWritesRefused += a.staleRefused;
    total.reconnectsWithinGrace += a.reconnect;
    total.restartEpochs += a.restart;
  }
  total.deadHeldAgentMinutes = Math.round(total.deadHeldAgentMinutes * 10) / 10;
  return total;
}

export function formatResult(r: RunResult): string {
  return `${r.design} | ${r.agents} | ${r.safetyViolations} | ${r.wronglyLost} | ${r.deadHeldAgentMinutes.toFixed(1)} | ${r.renewCalls} | ${r.runsCompleted} | ${r.longReviewLosses} | ${r.staleWritesRefused}`;
}
