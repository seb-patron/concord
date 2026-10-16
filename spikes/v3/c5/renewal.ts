/** Deterministic lease-lifecycle model; this is a research spike, not product code. */
export const DEFAULT_TTL_SECONDS = 300;
export const LONG_HOLD_SECONDS = 7_200;
export const HEARTBEAT_SECONDS = 100;
export const DISCONNECT_GRACE_SECONDS = 45;
export const PHASES = ["editing", "checks", "review", "queue", "landed"] as const;
export type Phase = typeof PHASES[number];
export type DesignId = "A" | "B" | "C" | "D" | "BD";

export interface Faults {
  disconnectAt: number;
  disconnectSeconds: number;
  sleepAt: number;
  sleepSeconds: number;
  reviewSeconds: number;
  inspectionSeconds: number;
  queueSeconds: number;
  restartAt: number;
  clockRatePpm: number;
  abandonAt: number | null;
  abandonmentSignal: boolean;
}
export interface RunResult {
  design: DesignId; agents: number; safetyViolations: number; outageLapses: number;
  deadHeldAgentMinutes: number; renewCalls: number; serverExtensions: number;
  landed: number; reviewPhaseLosses: number; staleWritesRefused: number;
  reconnectsWithinGrace: number; restartEpochs: number; phaseAbandonments: number;
  shortOutages: number; longOutages: number;
}

export class SeededRandom {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0 || 1; }
  next(): number { let x = this.state; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.state = x >>> 0; return this.state / 0x1_0000_0000; }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
}

/** Authoritative state: renewals preserve a fence; only a new claim increments it. */
export class LeaseFence {
  private currentFence = 0;
  private currentEpoch = 1;
  private holder: string | null = null;
  private expiresAt = 0;
  claim(holder: string, now: number, ttl = DEFAULT_TTL_SECONDS, incrementFence = true): number {
    if (this.holder !== null && now <= this.expiresAt) throw new Error("LEASE_CONFLICT");
    if (incrementFence) this.currentFence++;
    this.holder = holder; this.expiresAt = now + ttl; return this.currentFence;
  }
  get epoch(): number { return this.currentEpoch; }
  get fence(): number { return this.currentFence; }
  get expiry(): number { return this.expiresAt; }
  get owner(): string | null { return this.holder; }
  restart(): number { this.currentEpoch++; return this.currentEpoch; }
  renew(holder: string, fence: number, now: number, ttl = DEFAULT_TTL_SECONDS): boolean {
    if (holder !== this.holder || fence !== this.currentFence || now > this.expiresAt) return false;
    this.expiresAt = now + ttl; return true;
  }
  resumeWithinGrace(holder: string, fence: number, now: number, grace = DISCONNECT_GRACE_SECONDS, ttl = DEFAULT_TTL_SECONDS): boolean {
    if (holder !== this.holder || fence !== this.currentFence || now < this.expiresAt || now > this.expiresAt + grace) return false;
    this.expiresAt = now + ttl; return true;
  }
  release(holder: string, fence: number): boolean {
    if (holder !== this.holder || fence !== this.currentFence) return false;
    this.holder = null; this.expiresAt = 0; return true;
  }
  protectedWrite(holder: string, fence: number, now: number, epoch: number): boolean {
    return holder === this.holder && fence === this.currentFence && epoch === this.currentEpoch && now <= this.expiresAt;
  }
}

export function phaseAt(t: number, f: Pick<Faults, "inspectionSeconds" | "reviewSeconds" | "queueSeconds">): Phase {
  if (t < 600) return "editing";
  if (t < 600 + f.inspectionSeconds) return "checks";
  if (t < 600 + f.inspectionSeconds + f.reviewSeconds) return "review";
  if (t < 600 + f.inspectionSeconds + f.reviewSeconds + f.queueSeconds) return "queue";
  return "landed";
}
export function reconnectWithinGrace(expiry: number, reconnectAt: number, grace = DISCONNECT_GRACE_SECONDS): boolean {
  return reconnectAt >= expiry && reconnectAt <= expiry + grace;
}
function offlineAt(t: number, f: Faults): boolean {
  return (f.disconnectSeconds > 0 && t >= f.disconnectAt && t < f.disconnectAt + f.disconnectSeconds)
    || (f.sleepSeconds > 0 && t >= f.sleepAt && t < f.sleepAt + f.sleepSeconds);
}
function interval(start: number, end: number, t: number): boolean { return t >= start && t < end; }
function pickPhaseTime(r: SeededRandom, f: Faults): number {
  const lengths = [600, f.inspectionSeconds, f.reviewSeconds, f.queueSeconds];
  const total = lengths.reduce((a, b) => a + b, 0);
  let n = r.next() * total;
  for (let i = 0; i < lengths.length; i++) { if (n < lengths[i]) return lengths.slice(0, i).reduce((a, b) => a + b, 0) + n; n -= lengths[i]; }
  return total - 1;
}
export function seededFaults(seed: number, agent: number): Faults {
  const r = new SeededRandom((seed ^ Math.imul(agent + 1, 0x9e3779b1)) >>> 0);
  // Empirical anchors: inspection n=121, 62% >5m, median 6.8m, p90 23.8m,
  // max 39.2m; review n=13, range 3–218m and median 37m. Raw observations
  // are unavailable, so interpolation within the reported quantile bands is assumed.
  const q = r.next();
  const inspectionSeconds = q < 0.38 ? r.int(120, 300)
    : q < 0.5 ? r.int(300, 408)
      : q < 0.9 ? r.int(408, 1_428)
        : r.int(1_428, 2_352);
  const reviewSide = r.next();
  const reviewSeconds = reviewSide < 0.5 ? r.int(180, 2_220) : r.int(2_220, 13_080);
  const queueSeconds = r.int(300, 1_800); // modeled wait bound, not a product measurement
  const chooseFaultTime = (): number => pickPhaseTime(r, { inspectionSeconds, reviewSeconds, queueSeconds } as Faults);
  const disconnected = r.next() < 0.68;
  const sleep = r.next() < 0.38;
  const abandon = r.next() < 0.12;
  const restartAt = r.next() < 0.15 ? r.int(100, 590) : -1;
  return {
    disconnectAt: disconnected ? chooseFaultTime() : -1,
    disconnectSeconds: disconnected ? r.int(20, 900) : 0,
    sleepAt: sleep ? chooseFaultTime() : -1,
    sleepSeconds: sleep ? r.int(120, 1_200) : 0,
    inspectionSeconds, reviewSeconds, queueSeconds,
    restartAt, clockRatePpm: r.int(-100_000, 100_000),
    abandonAt: abandon ? chooseFaultTime() : null,
    abandonmentSignal: r.next() < 0.25,
  };
}

export interface ScenarioResult {
  safety: number; lapsedDuringOutage: boolean; deadHeldMinutes: number; renews: number;
  serverExtensions: number; published: boolean; landed: boolean; reviewLoss: boolean; staleRefused: number;
  reconnects: number; restarts: number; abandonedPhase: Phase | null;
}
export interface SimulationOptions {
  writeCheck?: (lease: LeaseFence, holder: string, fence: number, now: number, epoch: number) => boolean;
  disableGrace?: boolean;
  suppressContenderFenceIncrement?: boolean;
}
// Independent monitor: this describes the grant state, not the write-guard result.
function grantIsCurrent(lease: LeaseFence, holder: string, fence: number, now: number, epoch: number): boolean {
  return lease.owner === holder && lease.fence === fence && now <= lease.expiry && lease.epoch === epoch;
}

/** Each edit attempt and late stale attempt uses the same authoritative fence check. */
export function simulateScenario(design: DesignId, fault: Faults, options: SimulationOptions = {}): ScenarioResult {
  const holder = "agent-session";
  const leases = [new LeaseFence(), new LeaseFence()]; // one session beat covers multiple units
  const fences = leases.map(x => x.claim(holder, 0));
  const landingLease = new LeaseFence();
  let landingFence = 0, landingEpoch = landingLease.epoch;
  let epoch = leases[0].epoch;
  let now = 0, lastBeatLocal = 0, localClock = 0;
  let abandonedAt: number | null = null, abandonedPhase: Phase | null = null;
  let outageLapse = false, reviewLoss = false, reconnects = 0, restarts = 0;
  let renews = 0, serverExtensions = 0, deadSeconds = 0, staleRefused = 0, safety = 0;
  let lost = false, firstLossAt = -1, firstLossPhase: Phase | null = null;
  let published = false, landed = false, landingExpiry = 0, oldFences = [...fences], replacementClaimed = false;
  let nextServerExtension = HEARTBEAT_SECONDS;
  const sessionDesign = design === "C" || design === "D" || design === "BD";
  const serverDesign = design === "B" || design === "BD";
  const epochDesign = design === "D" || design === "BD";
  const end = 600 + fault.inspectionSeconds + fault.reviewSeconds + fault.queueSeconds;
  const guard = options.writeCheck ?? ((l, h, f, t, e) => l.protectedWrite(h, f, t, e));
  const dt = 5;
  while (now < end) {
    const step = Math.min(dt, end - now), next = now + step, phase = phaseAt(now, fault);
    const disconnected = offlineAt(now, fault);
    if (fault.abandonAt !== null && abandonedAt === null && now <= fault.abandonAt && fault.abandonAt < next) {
      abandonedAt = fault.abandonAt; abandonedPhase = phaseAt(abandonedAt, fault);
    }
    if (fault.restartAt >= 0 && now < fault.restartAt && next >= fault.restartAt) {
      const delayedEpoch = epoch;
      const currentEpoch = leases[0].restart(); leases[1].restart(); restarts++;
      // Every design receives the restart event. Only session-aware designs refresh
      // their cached epoch; all pre-restart packets are checked and rejected.
      const accepted = guard(leases[0], holder, fences[0], fault.restartAt, delayedEpoch);
      if (accepted && !grantIsCurrent(leases[0], holder, fences[0], fault.restartAt, delayedEpoch)) safety++;
      if (!accepted) staleRefused++;
      if (epochDesign) epoch = currentEpoch;
      if (published) {
        const delayedLandingEpoch = landingEpoch;
        const currentLandingEpoch = landingLease.restart();
        const accepted = guard(landingLease, holder, landingFence, fault.restartAt, delayedLandingEpoch);
        if (accepted && !grantIsCurrent(landingLease, holder, landingFence, fault.restartAt, delayedLandingEpoch)) safety++;
        if (!accepted) staleRefused++;
        if (epochDesign) landingEpoch = currentLandingEpoch;
      }
    }
    const active = abandonedAt === null || now < abandonedAt;
    if (!published && phase === "editing" && active) {
      for (let i = 0; i < leases.length; i++) {
        const accepted = guard(leases[i], holder, fences[i], now, epoch);
        if (accepted && !grantIsCurrent(leases[i], holder, fences[i], now, epoch)) safety++;
        if (!accepted && !lost) {
          lost = true; firstLossAt = now; firstLossPhase = phase; outageLapse = disconnected;
        }
        // An accepted protected edit is expected only for the current lease owner.
        if (accepted && leases[i].owner !== holder) safety++;
      }
    }
    if (lost && !replacementClaimed && now > Math.max(...leases.map(x => x.expiry)) + (sessionDesign ? DISCONNECT_GRACE_SECONDS : 0)) {
      for (let i = 0; i < leases.length; i++) {
        try { leases[i].claim("contender", now, DEFAULT_TTL_SECONDS, !options.suppressContenderFenceIncrement); replacementClaimed = true; } catch { /* still live */ }
      }
      if (replacementClaimed) {
        oldFences = [...fences];
        for (let i = 0; i < leases.length; i++) {
          const accepted = guard(leases[i], holder, oldFences[i], now, epoch);
          if (accepted && !grantIsCurrent(leases[i], holder, oldFences[i], now, epoch)) safety++;
          if (!accepted) staleRefused++;
        }
      }
    }
    if (!published && lost && sessionDesign && !options.disableGrace && !disconnected && now >= firstLossAt && now <= firstLossAt + DISCONNECT_GRACE_SECONDS) {
      let ok = true;
      for (let i = 0; i < leases.length; i++) ok = leases[i].resumeWithinGrace(holder, fences[i], now) && ok;
      if (ok) { lost = false; reconnects++; firstLossAt = -1; firstLossPhase = null; }
    }
    const clientAvailable = !disconnected && active;
    const beatDue = localClock - lastBeatLocal >= HEARTBEAT_SECONDS;
    if (published && now > landingExpiry && !lost) {
      lost = true; firstLossAt = now; firstLossPhase = phase; outageLapse = disconnected;
      if (phase === "review" && abandonedAt === null) reviewLoss = true;
    }
    if (published && lost && sessionDesign && !options.disableGrace && clientAvailable && firstLossAt >= 0 && now <= firstLossAt + DISCONNECT_GRACE_SECONDS) {
      if (!options.disableGrace && landingLease.resumeWithinGrace(holder, landingFence, now)) {
        landingExpiry = landingLease.expiry; lost = false; reconnects++; firstLossAt = -1; firstLossPhase = null;
      }
    }
    if (active && !published && !lost && phase === "editing" && clientAvailable && beatDue) {
      const ok = leases.every((l, i) => l.renew(holder, fences[i], now));
      if (ok) { renews++; lastBeatLocal = localClock; }
      else if (!lost) { lost = true; firstLossAt = now; firstLossPhase = phase; outageLapse = disconnected; }
    } else if (published && active && !lost && now <= landingExpiry && beatDue && clientAvailable) {
      if (landingLease.renew(holder, landingFence, now)) landingExpiry = landingLease.expiry;
      else lost = true;
      renews++; lastBeatLocal = localClock;
    }
    const inPlatformPhase = phase === "checks" || phase === "review" || phase === "queue";
    const platformKnowsAbandonment = fault.abandonmentSignal && abandonedAt !== null && now >= abandonedAt;
    if (published && platformKnowsAbandonment) {
      landingLease.release(holder, landingFence);
      landingExpiry = Math.min(landingExpiry, now);
    }
    if (published && serverDesign && inPlatformPhase && !platformKnowsAbandonment && now >= nextServerExtension) {
      // Known phase work extends a nonblocking landing authorization, not an edit lock.
      if (landingLease.renew(holder, landingFence, now)) landingExpiry = landingLease.expiry;
      else lost = true;
      serverExtensions++;
      nextServerExtension = now + HEARTBEAT_SECONDS;
    }
    // Published landing authorization is revision-bound and nonblocking. It does not
    // retain an exclusive edit claim; a fresh writer can claim the released unit.
    if (!published && now < 600 && now + step >= 600 && active && !lost
      && leases.every((l, i) => l.protectedWrite(holder, fences[i], 600, epoch))) {
      published = true;
      landingFence = landingLease.claim(holder, now);
      landingEpoch = landingLease.epoch;
      landingExpiry = landingLease.expiry;
      for (let i = 0; i < leases.length; i++) leases[i].release(holder, fences[i]);
    }
    if (abandonedAt !== null && now >= abandonedAt && now <= (published ? landingExpiry : Math.max(...leases.map(x => x.expiry)))) deadSeconds += step;
    if (firstLossAt >= 0 && firstLossPhase === "review" && abandonedAt === null) reviewLoss = true;
    const rate = 1 + fault.clockRatePpm / 1_000_000;
    localClock += step * rate; // clock drift changes real heartbeat spacing
    now = next;
  }
  // A terminal land is an event at the exact end; no earlier state counts as complete.
  const landingAccepted = published && guard(landingLease, holder, landingFence, end, landingEpoch);
  if (landingAccepted && !grantIsCurrent(landingLease, holder, landingFence, end, landingEpoch)) safety++;
  landed = landingAccepted && abandonedAt === null && landingExpiry >= end;
  if (landed) landingLease.release(holder, landingFence);
  // Direct stale-write probe after replacement, through the exact guard used above.
  if (replacementClaimed) for (let i = 0; i < leases.length; i++) {
    const accepted = guard(leases[i], holder, oldFences[i], end + 1, epoch);
    if (accepted && !grantIsCurrent(leases[i], holder, oldFences[i], end + 1, epoch)) safety++;
    if (!accepted) staleRefused++;
  }
  return { safety, lapsedDuringOutage: outageLapse, deadHeldMinutes: deadSeconds / 60, renews, serverExtensions,
    published, landed, reviewLoss: reviewLoss && abandonedAt === null, staleRefused, reconnects, restarts, abandonedPhase };
}

export function runFaultInjection(design: DesignId, agents: number, seed: number, options: SimulationOptions = {}): RunResult {
  const total: RunResult = { design, agents, safetyViolations: 0, outageLapses: 0, deadHeldAgentMinutes: 0,
    renewCalls: 0, serverExtensions: 0, landed: 0, reviewPhaseLosses: 0, staleWritesRefused: 0,
    reconnectsWithinGrace: 0, restartEpochs: 0, phaseAbandonments: 0, shortOutages: 0, longOutages: 0 };
  for (let i = 0; i < agents; i++) {
    const f = seededFaults(seed, i), r = simulateScenario(design, f, options);
    total.safetyViolations += r.safety;
    total.outageLapses += Number(r.lapsedDuringOutage);
    total.deadHeldAgentMinutes += r.deadHeldMinutes;
    total.renewCalls += r.renews; total.serverExtensions += r.serverExtensions;
    total.landed += Number(r.landed); total.reviewPhaseLosses += Number(r.reviewLoss);
    total.staleWritesRefused += r.staleRefused; total.reconnectsWithinGrace += r.reconnects;
    total.restartEpochs += r.restarts; total.phaseAbandonments += Number(r.abandonedPhase !== null);
    for (const seconds of [f.disconnectSeconds, f.sleepSeconds]) if (seconds > 0) {
      if (seconds <= DISCONNECT_GRACE_SECONDS) total.shortOutages++;
      else total.longOutages++;
    }
  }
  total.deadHeldAgentMinutes = Math.round(total.deadHeldAgentMinutes * 100) / 100;
  return total;
}

export function meanInterval(values: number[]): { mean: number; low: number; high: number } {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return { mean, low: mean - margin, high: mean + margin };
}
export function formatResult(r: RunResult): string {
  return `${r.design} | ${r.agents} | ${r.safetyViolations} | ${r.outageLapses} | ${r.deadHeldAgentMinutes.toFixed(2)} | ${r.renewCalls} | ${r.serverExtensions} | ${r.landed} | ${r.reviewPhaseLosses} | ${r.staleWritesRefused} | ${r.reconnectsWithinGrace} | ${r.restartEpochs} | ${r.shortOutages} | ${r.longOutages}`;
}
