# Lease renewal under disconnects and review gaps

## Answer in brief

**Recommendation for the next design discussion:** keep the decided five-minute lease as the default and separate “the agent is alive” from “Concord is actively checking or landing this change.” During editing, use one session heartbeat for the agent’s leases, with a short reconnect grace and a stable fence. When Concord owns a known phase such as checks, review wait, or queue processing, let the server preserve the lease under a bounded phase deadline. On landing, cancellation, close, or explicit abandonment, release it. Require a reasoned, bounded owner-approved exception for a lease that must outlast the normal policy. This is a proposed combination of prototypes B and D, not an owner decision or a product specification.

The seeded model found zero stale writes accepted across all eight design-and-size runs (100 simulated agent-runs); each stale write after a lapse was refused by its old fence. The best continuity in this particular workload came from server phase renewal: design B lost five non-abandoned holds among twenty runs, compared with fourteen for each other design. It also made fewer renewal calls: 88 among twenty agents, compared with 281 for the other designs. These are outputs of a small deterministic scenario model, not measurements of Concord, a live agent fleet, or a real network. The run intentionally includes long offline periods that exceed the short session grace; the high loss count for session designs describes this injected workload, not their expected behavior with healthy keepalives.

This spike addresses the open renewal question in the supplied claim-options report. The five-minute default and exceptional-long-hold direction is already recorded (D-LEASE-5MIN-EXTEND), as is exclusive writing at the claimed unit (D-UNIT-1-EXCLUSIVE). This report tests mechanics around those decisions; it does not choose a new lease policy.

## Terms and scope

A **lease** is the server’s time-limited permission for one holder to write a named unit. A **fence** is a monotonically increasing number attached to that permission; the protected write endpoint checks it and refuses an older number. A **session** groups one agent run’s leases and keepalives. **Grace** is a short interval in which the same session may reconnect after a missed lease deadline if another holder has not taken over. **Server-owned phase** means the platform has accepted responsibility for an operation such as checks or queue work, rather than waiting for an agent to edit.

The prototype is self-contained in `spikes/v3/c5/renewal.ts`, with deterministic assertions and seeded fault injection in `spikes/v3/c5/test.ts`. It models the four required phases: editing, waiting for checks/review, queued to land, and landed. The default is 300 seconds. A 7,200-second long hold exists as an explicit exception constant; the model does not authorize who grants it. Client keepalives are scheduled every 100 seconds, one third of the default term. The Chubby-inspired reconnect grace is 45 seconds.

## Four renewal designs

**A — Agent heartbeats only.** The agent’s own process renews at one third of the five-minute term. It continues through review only while that process remains alive and connected. A disconnected or sleeping laptop stops the beat. This is cheap and keeps ownership close to the worker, but it makes review reliability depend on a client process that may no longer be running. A heartbeat proves that a process can send a request, not that useful work is progressing; a detached orphan could keep renewing indefinitely unless there is a maximum or explicit close.

**B — Server renewal in known phases.** The client renews during editing. Once a change enters checks, review wait, or queue processing, Concord advances expiry while that phase is active. The model does not issue a client request for these extensions. This addresses long reviews and queue checks without requiring a laptop to remain awake. It can also retain a lease for an abandoned review if phase ownership has no deadline or operator release, so phase deadlines, close, force-release and abandonment handling are part of the design, not optional cleanup.

**C — Session lease with reconnect grace.** A session heartbeat covers its leases; the fence remains stable on renewal. If the connection drops, the server allows a 45-second reconnect window. A timely reconnect resumes the same session if no other holder has acquired the unit. After the grace period, a lapsed lease can be reassigned; a later request must claim again and receive a higher fence. This separates a transient network break from abandonment, but does not hide a real laptop sleep longer than the grace. The grace creates a bounded wait for contenders and must be measured against expected reconnect time.

**D — Chubby-style session, keepalive and epoch.** One session keepalive covers multiple leases, and the server returns state and events with the keepalive. A server restart advances an epoch; packets from the old epoch are rejected even when the durable lease and fence remain valid. Session recovery is allowed only during grace and only if ownership was not reassigned. This borrows the session, keepalive, grace and failover-epoch pattern described in the supplied Chubby research notes (source: Burrows, “The Chubby lock service for loosely-coupled distributed systems,” 2006; local notes read 2026-10-15). Chubby’s system is a coarse-grained lock service, so this is a mechanism analogy, not direct evidence for coding-agent workload. Design D does not automatically preserve a lease across a disconnected interval longer than the term.

The fence changes when ownership changes, not when the same holder renews. The supplied renewal-history report found that changing fences on renew allowed a sidecar and a land process to invalidate one another. Fencing only helps if the protected publish or land operation checks the current fence. Expiry without downstream checking would be a timeout hint, not write protection.

## Timeline

```text
server time →  0           10m          15m          27m             35m+
run phase     | editing    | checks / review wait | queued to land | landed
A / C / D     | agent or session heartbeat ────────────────┐
              | disconnect: grace, then five-minute expiry  └─ reclaim + new fence
B             | client heartbeat | server phase deadline extends lease ── release
fence         | claim = 41      renew stays 41                 new holder = 42
```

Illustrative timeline only; durations vary by run. For A/C/D, the session must remain alive or reconnect in time. B requires the server to know that the work is still in a live checks, review, or queue phase. The new owner receives a greater fence so a delayed request from the former owner cannot write.

## Fault model and results

The seeded workload was fixed at `0x00c0ffee`, with five and twenty agents per design. It includes disconnect durations from 20 to 900 seconds, laptop sleeps up to 1,200 seconds, review waits from 180 to 1,200 seconds, a server restart in selected runs, client clock skew from −120 to +120 seconds, and explicit abandonment in a subset. Time advances in 15-second steps. Server time controls expiry; client skew changes the heartbeat schedule only. All designs use the same modeled claim and protected-write check. A stale write after lapse is tested against the higher fence of a replacement holder. Design B counts server phase extensions as zero renew RPCs.

The exact generated table is in `spikes/v3/c5/output.txt`. Its columns are design, agent count, safety violations, non-abandoned runs that lost their original lease, dead-holder minutes after abandonment, client renewal calls, completed runs, long-review losses, and stale writes refused.

```text
lease renewal fault-injection prototype
seed=0x00c0ffee; server-authoritative expiry; simulated faults: disconnect, laptop sleep, long review, restart, clock skew, abandonment
design | agents | safety violations | wrongly lost live leases | dead-holder minutes | renew calls | completed | >5m review losses | stale writes refused
A | 5 | 0 | 5 | 0.0 | 63 | 0 | 4 | 5
B | 5 | 0 | 3 | 0.0 | 16 | 2 | 2 | 3
C | 5 | 0 | 5 | 0.0 | 63 | 0 | 4 | 5
D | 5 | 0 | 5 | 0.0 | 63 | 0 | 4 | 5
A | 20 | 0 | 14 | 4.3 | 281 | 5 | 13 | 15
B | 20 | 0 | 5 | 4.3 | 88 | 14 | 4 | 6
C | 20 | 0 | 14 | 4.3 | 281 | 5 | 13 | 15
D | 20 | 0 | 14 | 4.3 | 281 | 5 | 13 | 15
checks: stale fenced write refused; reconnect at 45s succeeds and at 46s fails; abandonment expires; long review retained by A/B/D when renewal owner remains live
```

All four designs had zero modeled safety violations. That number demonstrates only that the modeled protected-write check refuses a stale fence; it is not a safety proof. A and D show 13 long-review losses in the twenty-agent run because review gaps overlap injected sleep or disconnect. Their renewal works when the session stays active. C has the same overall loss count because most injected outages exceed its 45-second grace; the test’s direct boundary check confirms 45 seconds succeeds and 46 seconds fails. B’s remaining five losses happen before or outside a server-owned phase, especially while editing through a long outage. The design does not imply that a server can know whether an editing agent is still useful.

Dead-holder minutes were 4.3 in each twenty-agent run: the dead agent was abandoned during editing, and ordinary five-minute expiry reclaimed the hold. There were no abandonment cases among the five-agent sample. The value counts lease time after modeled abandonment; it does not include the different risk of a server-held abandoned review. Design B would need an explicit abandonment deadline or an operator action to bound that case.

The scenario’s skew is deliberately a client-side scheduling perturbation. Lease expiry is checked by the server’s clock. A production protocol must avoid comparing client wall-clock timestamps to decide whether a fence is valid. Restart recovery also needs durable lease state, epoch checks on each protected write, and a clear outcome when the server cannot establish whether a prior owner is still current.

## Recommendation and limits

For the next design pass, combine session-level client renewal during editing (D) with server-owned phase renewal after accepted publication (B). Keep renewal idempotent and fence-stable; bump the fence on new ownership and on operator force-release. At the lease deadline, fail closed: reconnect within grace only if the server still recognizes the session and no replacement claim won; otherwise require a fresh claim, refreshed base and new fence before protected writes. Do not silently retake a unit after a lapse. Keep queue and review extensions tied to visible phases, bounded by checker deadlines or an explicit abandonment rule. Preserve an auditable owner-approved long-hold path with a reason and hard maximum; two hours is a prototype example, not a selected limit.

This mix trades client renewal traffic during quiet editing for server responsibility during known platform waits. The result favors fewer renewal calls and fewer losses in the injected sample, but a 20-agent deterministic run cannot estimate production rates or tail behavior. It does not model multiple units per agent, contention and wait queues, renewal request loss/retry, server partition or durable-store failure, actual reviewer behavior, phase transitions racing expiry, force-release authorization, a leaked keepalive process, or a stale publish that bypasses the fence checker. It has no confidence intervals. Current-agent behavior and whether keepalive reliably follows the true agent lifetime are **CAPABILITY-DEPENDENT (source date: 2026-10-15; re-test with current agents)**. Server-time expiry, fencing at protected writes, lease retention while an explicitly active platform phase runs, and the bounded limits of a fixed grace interval are **STRUCTURAL (source dates: Chubby, 2006; supplied renewal log, 2026-10-13; lease-options report, 2026-10-15)**.

The model does not settle whether review should count as a server-owned phase, how long a queued lease should persist, who may approve a long hold, or what constitutes abandonment. These remain owner choices in the supplied research. Before product work, replay production-shaped event traces and fault-inject restart, two concurrent renewers, lost heartbeat replies, lease expiry concurrent with queue admission, a review held past the proposed deadline, and a session that outlives its agent. Measure p95 recovery delay, false loss, dead-holder minutes, server calls and successful landing—not only safety invariants. The owner should then decide whether review is included in server-held time and choose an abandonment threshold. No web sources were fetched for this spike; the only prior-art mechanism used here is the supplied Chubby material read in full.

## Reproduction and validation notes

The required command is `cd spikes/v3/c5 && (bun test.ts || npx --yes tsx test.ts)`. Bun was unavailable. The sandbox blocked the fallback twice: first because the configured npm cache was not writable, and then because `tsx` could not create its IPC socket in the deep scratch path; `/tmp` was not writable. The same test was run successfully with `cd spikes/v3/c5 && node --experimental-strip-types test.ts` on Node 26.7.0. Its full output is stored in `spikes/v3/c5/output.txt`. The expected `npm run -s decisions` command also failed because the repository could not load `tsx`, matching the known environment limitation. The document word count is reported with the required `wc -w docs/spikes/v3/c5-renewal.md` command.
