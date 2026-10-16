/**
 * Throwaway, in-memory wait-line prototype. It has no dependency on Concord.
 * All deadlines use the coordinator's clock. Agent clock skew can delay a
 * caller, but cannot extend server-side authorization.
 */

export type GrantMode = "automatic" | "fresh-claim";
export type WaitState = "waiting" | "turn" | "granted" | "expired" | "cancelled" | "revoked";

export interface ClaimResult {
  kind: "granted" | "queued" | "turn" | "rejected";
  waitId?: string;
  leaseId?: string;
  units?: string[];
}

export interface WaitRecord {
  id: string;
  agent: string;
  token: string;
  requestKey: string;
  units: string[];
  sequence: number;
  createdAt: number;
  deadline: number;
  state: WaitState;
  turnDeadline?: number;
  grantCount: number;
  leaseId?: string;
  grantedAt?: number;
}

export interface LeaseRecord {
  id: string;
  agent: string;
  units: string[];
  grantedAt: number;
  expiresAt: number;
  waitId?: string;
}

export interface LineOptions {
  mode: GrantMode;
  now?: number;
  waitMs?: number;
  turnMs?: number;
  leaseMs?: number;
}

const canonical = (unit: string): string => unit.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");

/** Alias-aware overlap: a file conflicts with its symbols; distinct symbols do not. */
export function unitsOverlap(a: readonly string[], b: readonly string[]): boolean {
  for (const leftRaw of a) {
    const left = canonical(leftRaw);
    for (const rightRaw of b) {
      const right = canonical(rightRaw);
      if (left === right) return true;
      const leftFile = left.startsWith("file:") ? left.slice(5) : undefined;
      const rightFile = right.startsWith("file:") ? right.slice(5) : undefined;
      const leftSymbolFile = left.startsWith("symbol:") ? left.slice(7).split("#", 1)[0] : undefined;
      const rightSymbolFile = right.startsWith("symbol:") ? right.slice(7).split("#", 1)[0] : undefined;
      if (leftFile && rightSymbolFile === leftFile) return true;
      if (rightFile && leftSymbolFile === rightFile) return true;
    }
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
  private readonly requestResults = new Map<string, ClaimResult>();
  private readonly waitMs: number;
  private readonly turnMs: number;
  private readonly leaseMs: number;

  constructor(options: LineOptions) {
    this.now = options.now ?? 0;
    this.mode = options.mode;
    this.waitMs = options.waitMs ?? 30_000;
    this.turnMs = options.turnMs ?? 5_000;
    this.leaseMs = options.leaseMs ?? 20_000;
  }

  registerToken(token: string): void { this.auth.set(token, { valid: true }); }
  revokeToken(token: string): void {
    const record = this.auth.get(token);
    if (record) record.valid = false;
  }
  isAuthenticated(token: string, principal?: string): boolean {
    const record = this.auth.get(token);
    if (!record?.valid) return false;
    if (principal && record.principal && record.principal !== principal) return false;
    if (principal) record.principal = principal;
    return true;
  }

  claim(agent: string, token: string, units: string[], requestKey: string, waitId?: string): ClaimResult {
    this.calls++;
    this.advanceTime(0);
    if (!this.isAuthenticated(token, agent)) return { kind: "rejected" };

    if (waitId) return this.freshClaim(agent, token, waitId, [...new Set(units.map(canonical))].sort());
    const scopedRequestKey = `${agent}\u0000${requestKey}`;
    const prior = this.requestResults.get(scopedRequestKey);
    if (prior) return { ...prior, units: prior.units ? [...prior.units] : undefined };
    const normalized = [...new Set(units.map(canonical))].sort();
    if (!normalized.length) return { kind: "rejected" };

    const earlier = this.liveWaits().some(wait => unitsOverlap(wait.units, normalized));
    if (!earlier && this.available(normalized)) {
      const lease = this.grant(agent, normalized);
      const result: ClaimResult = { kind: "granted", leaseId: lease.id, units: [...normalized] };
      this.requestResults.set(scopedRequestKey, result);
      return result;
    }

    const wait: WaitRecord = {
      id: `w${this.nextWait++}`, agent, token, requestKey, units: normalized,
      sequence: ++this.sequence, createdAt: this.now, deadline: this.now + this.waitMs,
      state: "waiting", grantCount: 0,
    };
    this.waits.set(wait.id, wait);
    this.events.push({ at: this.now, type: "queued", waitId: wait.id, agent });
    const result: ClaimResult = { kind: "queued", waitId: wait.id, units: [...normalized] };
    this.requestResults.set(scopedRequestKey, result);
    this.advance();
    return result;
  }

  /** Called after an ordinary release, expiry, or crash cleanup. */
  release(leaseId: string, reason = "release"): boolean {
    this.calls++;
    if (!this.removeLease(leaseId, reason)) return false;
    this.advance();
    return true;
  }

  disconnect(agent: string): void {
    this.calls++;
    for (const wait of this.liveWaits()) {
      if (wait.agent === agent) this.finishWait(wait, "cancelled");
    }
    this.events.push({ at: this.now, type: "disconnect", agent });
    this.advance();
  }

  /** Status read; repeated reads do not move FIFO position or extend deadlines. */
  status(waitId: string): WaitRecord | undefined {
    this.calls++;
    this.advanceTime(0);
    const wait = this.waits.get(waitId);
    return wait ? { ...wait, units: [...wait.units] } : undefined;
  }

  /** Server-time advancement expires waits, turns and leases, then advances FIFO. */
  tick(deltaMs: number): void {
    if (deltaMs < 0) throw new Error("server time cannot move backwards");
    this.advanceTime(deltaMs);
  }

  liveWaits(): WaitRecord[] {
    return [...this.waits.values()]
      .filter(wait => wait.state === "waiting" || wait.state === "turn")
      .sort((a, b) => a.sequence - b.sequence);
  }

  assertSafe(): void {
    const live = [...this.leases.values()];
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        if (unitsOverlap(live[i].units, live[j].units)) {
          throw new Error(`overlapping leases ${live[i].id} and ${live[j].id}`);
        }
      }
    }
    for (const wait of this.waits.values()) {
      if (wait.grantCount > 1) throw new Error(`duplicate grant for ${wait.id}`);
      if (wait.state === "granted" && wait.grantCount !== 1) throw new Error(`missing grant record for ${wait.id}`);
    }
  }

  private freshClaim(agent: string, token: string, waitId: string, units: string[]): ClaimResult {
    const wait = this.waits.get(waitId);
    if (!wait || wait.agent !== agent || !sameUnits(wait.units, units)) {
      return { kind: "rejected", waitId };
    }
    if (wait.state === "granted" && wait.leaseId) {
      return { kind: "granted", waitId, leaseId: wait.leaseId, units: [...wait.units] };
    }
    if (wait.state !== "turn" || (wait.turnDeadline ?? 0) <= this.now) return { kind: "rejected", waitId };
    // This is the second authentication boundary; never trust enqueue-time auth.
    if (!this.isAuthenticated(token, agent)) return { kind: "rejected", waitId };
    if (!this.available(wait.units)) return { kind: "rejected", waitId };
    const lease = this.grant(agent, wait.units, wait.id);
    this.events.push({ at: this.now, type: "fresh_claim_granted", waitId, agent });
    return { kind: "granted", waitId, leaseId: lease.id, units: [...wait.units] };
  }

  private grant(agent: string, units: string[], waitId?: string): LeaseRecord {
    if (waitId) {
      const wait = this.waits.get(waitId)!;
      wait.grantCount++;
      wait.state = "granted";
      wait.grantedAt = this.now;
    }
    const lease: LeaseRecord = {
      id: `l${this.nextLease++}`, agent, units: [...units], grantedAt: this.now,
      expiresAt: this.now + this.leaseMs, waitId,
    };
    this.leases.set(lease.id, lease);
    if (waitId) this.waits.get(waitId)!.leaseId = lease.id;
    this.events.push({ at: this.now, type: waitId ? "automatic_grant" : "direct_grant", waitId, agent });
    return lease;
  }

  private available(units: string[]): boolean {
    return ![...this.leases.values()].some(lease => unitsOverlap(lease.units, units));
  }

  private removeLease(leaseId: string, reason: string): boolean {
    const lease = this.leases.get(leaseId);
    if (!lease) return false;
    this.leases.delete(leaseId);
    this.events.push({ at: this.now, type: reason, agent: lease.agent, waitId: lease.waitId });
    return true;
  }

  private advanceTime(delta: number): void {
    this.now += delta;
    for (const lease of [...this.leases.values()]) {
      if (lease.expiresAt <= this.now) {
        this.removeLease(lease.id, "lease_expired");
        this.advance();
      }
    }
    for (const wait of this.liveWaits()) {
      if (wait.deadline <= this.now) this.finishWait(wait, "expired");
      else if (wait.state === "turn" && (wait.turnDeadline ?? Infinity) <= this.now) this.finishWait(wait, "expired");
    }
    this.advance();
  }

  private advance(): void {
    const ordered = this.liveWaits();
    for (let i = 0; i < ordered.length; i++) {
      const wait = ordered[i];
      const earlierOverlap = ordered.slice(0, i).some(prior =>
        (prior.state === "waiting" || prior.state === "turn") && unitsOverlap(prior.units, wait.units),
      );
      if (earlierOverlap || !this.available(wait.units)) continue;
      if (wait.state === "turn") continue;
      if (this.mode === "automatic") {
        // Authorization is checked at grant time. Revoked waiters are skipped.
        if (!this.isAuthenticated(wait.token, wait.agent)) {
          this.finishWait(wait, "revoked");
          continue;
        }
        this.grant(wait.agent, wait.units, wait.id);
      } else {
        wait.state = "turn";
        wait.turnDeadline = Math.min(wait.deadline, this.now + this.turnMs);
        this.events.push({ at: this.now, type: "turn_opened", waitId: wait.id, agent: wait.agent });
      }
    }
  }

  private finishWait(wait: WaitRecord, state: "expired" | "cancelled" | "revoked"): void {
    if (wait.state !== "waiting" && wait.state !== "turn") return;
    wait.state = state;
    this.events.push({ at: this.now, type: state, waitId: wait.id, agent: wait.agent });
  }

}

const sameUnits = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, i) => value === b[i]);

/** Deterministic xorshift PRNG shared by tests and the seeded fault run. */
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

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
