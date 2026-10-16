/** In-memory comparison of v2 wait-queue grants and fresh-auth turns. */

export type GrantMode = "automatic" | "fresh-claim";
export type WaitState = "waiting" | "turn" | "granted" | "expired" | "cancelled" | "revoked";
export type LeasePhase = "writing" | "published" | "landing";

export interface ClaimResult {
  kind: "granted" | "queued" | "turn" | "rejected";
  waitId?: string;
  leaseId?: string;
  units?: string[];
}
export interface WaitRecord {
  id: string; agent: string; changeId: string; token: string; requestKey: string; units: string[];
  sequence: number; createdAt: number; deadline: number; state: WaitState;
  turnDeadline?: number; grantCount: number; leaseId?: string; grantedAt?: number;
}
export interface LeaseRecord {
  id: string; agent: string; units: string[]; grantedAt: number; expiresAt: number;
  waitId?: string; phase: LeasePhase;
}
export interface LineOptions {
  mode: GrantMode; now?: number; waitMs?: number; turnMs?: number; leaseMs?: number;
}

const canonical = (unit: string): string => unit.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
const sameUnits = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** Whole-file and symbol keys overlap; distinct symbols do not. */
export function unitsOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const x0 of a) for (const y0 of b) {
    const x = canonical(x0), y = canonical(y0);
    if (x === y) return true;
    const xf = x.startsWith("file:") ? x.slice(5) : undefined;
    const yf = y.startsWith("file:") ? y.slice(5) : undefined;
    const xs = x.startsWith("symbol:") ? x.slice(7).split("#", 1)[0] : undefined;
    const ys = y.startsWith("symbol:") ? y.slice(7).split("#", 1)[0] : undefined;
    if ((xf && ys === xf) || (yf && xs === yf)) return true;
  }
  return false;
}

export class WaitLine {
  now: number;
  readonly mode: GrantMode;
  readonly waits = new Map<string, WaitRecord>();
  readonly leases = new Map<string, LeaseRecord>();
  readonly events: Array<{ at: number; type: string; waitId?: string; agent?: string }> = [];
  calls = 0;
  private sequence = 0;
  private nextWait = 1;
  private nextLease = 1;
  private readonly auth = new Map<string, { valid: boolean; principal?: string }>();
  private readonly requestResults = new Map<string, { units: string[]; result: ClaimResult }>();
  private readonly waitMs: number;
  private readonly turnMs: number;
  private readonly leaseMs: number;

  constructor(options: LineOptions) {
    this.now = options.now ?? 0; this.mode = options.mode;
    this.waitMs = options.waitMs ?? 30_000; this.turnMs = options.turnMs ?? 45_000;
    this.leaseMs = options.leaseMs ?? 20_000;
  }
  registerToken(token: string): void { this.auth.set(token, { valid: true }); }
  revokeToken(token: string): void { const entry = this.auth.get(token); if (entry) entry.valid = false; }
  isAuthenticated(token: string, principal?: string): boolean {
    const entry = this.auth.get(token);
    if (!entry?.valid || (principal && entry.principal && entry.principal !== principal)) return false;
    if (principal) entry.principal = principal;
    return true;
  }

  claim(agent: string, token: string, units: string[], requestKey: string, waitId?: string, changeId = agent): ClaimResult {
    this.calls++; this.advanceTime(0);
    if (!this.isAuthenticated(token, agent)) return { kind: "rejected", waitId };
    const normalized = [...new Set(units.map(canonical))].sort();
    if (!normalized.length) return { kind: "rejected" };
    if (waitId) return this.freshClaim(agent, token, waitId, normalized);
    const requestId = `${agent}\u0000${requestKey}`;
    const prior = this.requestResults.get(requestId);
    if (prior) return sameUnits(prior.units, normalized) ? cloneResult(prior.result) : { kind: "rejected" };

    // The prototype forbids hold-and-wait. Published holds do not block and may coexist.
    if ([...this.leases.values()].some(l => l.agent === agent && l.phase === "writing")) {
      return this.remember(requestId, normalized, { kind: "rejected" });
    }
    const earlier = this.liveWaits().some(w => unitsOverlap(w.units, normalized));
    if (!earlier && this.available(normalized)) {
      const lease = this.grant(agent, normalized);
      return this.remember(requestId, normalized, { kind: "granted", leaseId: lease.id, units: [...normalized] });
    }
    // One live waiter per agent and normalized unit set, independent of retry key.
    const existing = this.liveWaits().find(w => w.agent === agent && w.changeId === changeId && sameUnits(w.units, normalized));
    if (existing) return this.remember(requestId, normalized, { kind: existing.state === "turn" ? "turn" : "queued", waitId: existing.id, units: [...normalized] });
    const wait: WaitRecord = {
      id: `w${this.nextWait++}`, agent, changeId, token, requestKey, units: normalized,
      sequence: ++this.sequence, createdAt: this.now, deadline: this.now + this.waitMs,
      state: "waiting", grantCount: 0,
    };
    this.waits.set(wait.id, wait);
    this.events.push({ at: this.now, type: "queued", waitId: wait.id, agent });
    const result = { kind: "queued" as const, waitId: wait.id, units: [...normalized] };
    this.requestResults.set(requestId, { units: normalized, result });
    this.advance();
    return cloneResult(result);
  }

  release(leaseId: string, reason = "release"): boolean {
    this.calls++;
    if (!this.removeLease(leaseId, reason)) return false;
    this.advanceTime(0); return true;
  }
  /** A first publish converts a writing hold into a nonblocking landing hold. */
  publish(leaseId: string): boolean {
    this.calls++;
    const lease = this.leases.get(leaseId);
    if (!lease || lease.phase !== "writing") return false;
    lease.phase = "published";
    this.events.push({ at: this.now, type: "published_hold", agent: lease.agent, waitId: lease.waitId });
    this.advanceTime(0); return true;
  }
  setLanding(leaseId: string): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.phase === "writing") return false;
    lease.phase = "landing"; return true;
  }
  disconnect(agent: string): void {
    this.calls++;
    for (const wait of this.liveWaits()) if (wait.agent === agent) this.finishWait(wait, "cancelled");
    this.events.push({ at: this.now, type: "disconnect", agent }); this.advanceTime(0);
  }
  status(waitId: string): WaitRecord | undefined {
    this.calls++; this.advanceTime(0);
    const wait = this.waits.get(waitId);
    return wait ? { ...wait, units: [...wait.units] } : undefined;
  }
  tick(deltaMs: number): void {
    if (deltaMs < 0) throw new Error("server time cannot move backwards");
    this.advanceTime(deltaMs);
  }
  liveWaits(): WaitRecord[] {
    return [...this.waits.values()].filter(w => w.state === "waiting" || w.state === "turn").sort((a, b) => a.sequence - b.sequence);
  }
  assertSafe(): void {
    const writing = [...this.leases.values()].filter(l => l.phase === "writing");
    for (let i = 0; i < writing.length; i++) for (let j = i + 1; j < writing.length; j++) {
      if (unitsOverlap(writing[i].units, writing[j].units)) throw new Error(`overlapping writing leases ${writing[i].id} ${writing[j].id}`);
    }
    for (const wait of this.waits.values()) {
      if (wait.grantCount > 1 || (wait.state === "granted" && wait.grantCount !== 1)) throw new Error(`invalid grant count ${wait.id}`);
      if (wait.state === "turn" && (!(wait.turnDeadline! <= wait.deadline) || wait.turnDeadline! <= this.now)) throw new Error(`invalid turn ${wait.id}`);
    }
  }

  private remember(key: string, units: string[], result: ClaimResult): ClaimResult {
    this.requestResults.set(key, { units: [...units], result: cloneResult(result) }); return cloneResult(result);
  }
  private freshClaim(agent: string, token: string, waitId: string, units: string[]): ClaimResult {
    const wait = this.waits.get(waitId);
    if (!wait || wait.agent !== agent || !sameUnits(wait.units, units) || wait.state !== "turn" || (wait.turnDeadline ?? 0) <= this.now) return { kind: "rejected", waitId };
    if (!this.isAuthenticated(token, agent) || !this.available(wait.units)) return { kind: "rejected", waitId };
    const lease = this.grant(agent, wait.units, wait.id);
    return { kind: "granted", waitId, leaseId: lease.id, units: [...wait.units] };
  }
  private grant(agent: string, units: string[], waitId?: string): LeaseRecord {
    if (waitId) {
      const wait = this.waits.get(waitId)!; wait.grantCount++; wait.state = "granted"; wait.grantedAt = this.now;
    }
    const lease: LeaseRecord = { id: `l${this.nextLease++}`, agent, units: [...units], grantedAt: this.now, expiresAt: this.now + this.leaseMs, waitId, phase: "writing" };
    this.leases.set(lease.id, lease);
    if (waitId) this.waits.get(waitId)!.leaseId = lease.id;
    this.events.push({ at: this.now, type: waitId ? (this.mode === "automatic" ? "automatic_grant" : "fresh_claim_granted") : "direct_grant", waitId, agent });
    return lease;
  }
  private available(units: string[]): boolean {
    return ![...this.leases.values()].some(l => l.phase === "writing" && unitsOverlap(l.units, units));
  }
  private removeLease(id: string, reason: string): boolean {
    const lease = this.leases.get(id); if (!lease) return false;
    this.leases.delete(id); this.events.push({ at: this.now, type: reason, agent: lease.agent, waitId: lease.waitId }); return true;
  }
  private advanceTime(delta: number): void {
    this.now += delta;
    // Expire every due object before any queue scan or grant on this tick.
    for (const lease of [...this.leases.values()]) if (lease.expiresAt <= this.now) this.removeLease(lease.id, "lease_expired");
    for (const wait of this.liveWaits()) {
      if (wait.deadline <= this.now || (wait.state === "turn" && (wait.turnDeadline ?? Infinity) <= this.now)) this.finishWait(wait, "expired");
    }
    this.advance();
  }
  private advance(): void {
    for (const wait of this.liveWaits()) {
      const earlierOverlap = this.liveWaits().some(prior => prior.sequence < wait.sequence && unitsOverlap(prior.units, wait.units));
      if (earlierOverlap || !this.available(wait.units) || wait.state === "turn") continue;
      if (this.mode === "automatic") {
        // Faithful to the original wait-queue design: enqueue authorization is reused.
        // Revocation after enqueue can therefore still produce a lease in this arm.
        this.grant(wait.agent, wait.units, wait.id);
      } else {
        wait.state = "turn"; wait.turnDeadline = Math.min(wait.deadline, this.now + this.turnMs);
        this.events.push({ at: this.now, type: "turn_opened", waitId: wait.id, agent: wait.agent });
      }
    }
  }
  private finishWait(wait: WaitRecord, state: "expired" | "cancelled" | "revoked"): void {
    if (wait.state !== "waiting" && wait.state !== "turn") return;
    wait.state = state; this.events.push({ at: this.now, type: state, waitId: wait.id, agent: wait.agent });
  }
}

function cloneResult(result: ClaimResult): ClaimResult { return { ...result, units: result.units ? [...result.units] : undefined }; }

/** Small deterministic generator; independent instances provide purpose-specific streams. */
export class SeededRandom {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0 || 1; }
  next(): number { let x = this.state; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.state = x >>> 0; return this.state / 0x1_0000_0000; }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
}
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
