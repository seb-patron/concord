# Wait-line prototype: automatic grant or fresh-claim turn?

**Decision status check:** `$ npm run -s decisions` failed because this checkout cannot resolve `tsx` (`ERR_MODULE_NOT_FOUND`). The checker therefore did not produce its `Approved but not live:` list; no status list is inferred here.

## Summary and answer

This throwaway experiment compares two ways to advance an agent waiting for an exclusive lease. In the automatic design, release of the current lease grants the next eligible waiter a lease immediately. In the fresh-claim design, release gives that waiter a short priority turn; the waiter must then make a new authenticated claim. In this seeded in-memory run, automatic grant completed more queued claims with fewer simulated calls. It also created six leases for disconnected agents at the 25-agent setting, wasting an estimated 132 lease-milliseconds. The fresh-claim design created no lease for a disconnected waiter, but made far more calls and left more requests waiting or expired.

**Recommendation:** retain the fresh-authenticated-claim turn unless the real coordinator can make grant-time authentication, revocation ordering, and lease fencing one atomic decision. This is a structural safety recommendation for the split authorization and lease boundary described in the supplied v2 history, not a claim that the short simulation establishes better throughput. If a future single-server design can prove that atomic boundary, automatic grant deserves a new comparison because it used fewer calls in these scenarios. The owner still chooses; the experiment does not change policy. The established decision approves a FIFO line and human controls (D-LEASE-WAIT-LINE); a separate decision approves automatic enqueue of refused claims, not automatic lease grants (D-LEASE-QUEUE-AUTO). The current exclusive-unit rule remains the premise (D-UNIT-1-EXCLUSIVE).

## What was modeled

A **wait line** is an ordered list of claim requests that cannot yet receive all of their requested units. A **lease** is the exclusive, time-limited right to work on one or more units. A **turn** gives one waiter priority for a short time but is not a lease: it creates no fence and no write authority. A **barging claim** is a later request that takes an overlapping unit ahead of an earlier waiter. A **wasted hold** is a lease granted to a waiter that has already disconnected without notifying the coordinator.

The prototype is self-contained TypeScript in `spikes/v3/c4/waitline.ts`; it imports nothing from Concord's source tree. It uses an in-memory coordinator with a monotonic server clock, FIFO sequence numbers, all-or-nothing multi-unit acquisition, wait deadlines, lease deadlines, request-key deduplication, token revocation, and simple path/symbol alias overlap. A whole-file request conflicts with symbols in that file; distinct symbol names do not conflict. Claims use a fresh lease record only after every requested unit is free. This prevents partial ownership of a multi-unit request, so the modeled protocol cannot form a cycle by holding one requested unit while waiting for another.

The two modes share admission, queue order, deadlines, overlap rules, and the lease record. Automatic mode checks that the queued token remains valid at the moment of grant; revoked waiters are removed and the line advances. Fresh-claim mode opens a time-limited turn, then requires an authenticated claim for the same agent and exact normalized unit set. A revoked or expired token cannot use that turn. A repeated request key returns the original queued result; a repeated turn claim returns the same lease instead of creating a duplicate. The server clock decides expiry. Client clock skew only contributes to modeled call delay.

```text
holder owns unit(s)
        |
        | release or lease expiry
        v
  FIFO eligibility scan ---- blocked by earlier overlapping waiter
        |
        +-- automatic mode --> recheck token --> lease + fence
        |
        +-- fresh-claim mode -> short priority turn
                                  |
                                  +--> fresh authenticated claim --> lease + fence
                                  +--> revoke / disconnect / timeout --> next waiter
```

This is a behavioral prototype, not a persistence, concurrency, or cryptographic implementation. The `token` strings and authenticated agent identity are in-memory test fixtures. The simulation has no concurrent transactions, process restart, network transport, real access-token catalog, lease renewal, human override, deadlock graph, or real Concord unit-policy resolver. Its path/symbol overlap helper covers only the examples used here; it does not establish canonical alias or parent/child behavior for production unit kinds. The v2 turn design called out a cross-object revocation boundary, and the later published-lease design changed which lease states block new writers (source dates: 2026-10-14 for the turn proposal and 2026-10-14 for the published-hold proposal). This prototype models an active holder plus release/expiry and does not model that broader lifecycle.

## Deterministic checks

`spikes/v3/c4/test.ts` checks no barging, grant-time revoked-token handling, atomic multi-unit claims, waiter expiry, explicit disconnect cancellation, idempotent request retries, holder crash followed by lease expiry, and duplicate-grant prevention in both modes. It also checks that a fresh turn expires, that a revoked credential fails its fresh claim, and that a different subset cannot claim a multi-unit turn. Every deterministic case calls the safety assertion, which rejects overlapping live leases and any waiter granted more than once.

The deadlock check is intentionally narrow. Because a request acquires all units at once, no waiter can hold a subset while blocking another waiter. That construction avoids the classic partial-acquisition cycle in this model; the prototype does not implement or test a waits-for graph, dependencies between changes, or the youngest-change-yields policy from the supplied deadlock design (source date: 2026-10-12). This result is **STRUCTURAL (source date: 2026-10-15 prototype)** for atomic acquisition in this model only.

## Seeded fault-injection results

The test runs both modes at 2, 5, 10, and 25 agents. Each case uses seed `0xC0A4 + agent_count`, 190 bounded simulation steps, and a 30-step drain. The xorshift generator makes the run repeatable. The workload injects random request delays, ungraceful holder crashes, silent waiter disconnects, and client clock skew from −4 to +4 time units. Five hot units create overlap; a minority of requests ask for two units. The waiter deadline is 85 modeled milliseconds, turn deadline 9 milliseconds, and lease deadline 22 milliseconds. Those are scenario settings, not recommended production timeouts.

The test defines **starvation** as a wait still queued at the end, an expired wait, or a completed grant whose wait exceeded 60 modeled milliseconds. **p50** and **p95** are nearest-rank percentiles of observed waiting grants, measured from enqueue to lease grant; a turn that never becomes a lease is excluded. **Calls** count simulated client claim, release, fresh-claim, and disconnect operations. Internal clock advancement and automatic expiry do not count. **Wasted holds** count leases automatically granted to agents already known offline to the simulated client; wasted time is the lease lifetime remaining at grant. The agent may still be alive when a real server grants a lease; this simulation's offline state is intentionally a conservative fault signal, not a production detector.

Raw output from the run:

```text
deterministic tests: 7 scenarios passed for automatic grant and fresh-claim turn
fault injection (seeded xorshift; 190 steps plus bounded drain per case)
mode=automatic agents=2 seed=49318 safety=0 grants=1 p50_ms=4 p95_ms=4 wasted_holds=0 wasted_ms=0 calls=6 starvation=0 disconnects=0 crashes=2
mode=fresh-claim agents=2 seed=49318 safety=0 grants=0 p50_ms=0 p95_ms=0 wasted_holds=0 wasted_ms=0 calls=43 starvation=1 disconnects=0 crashes=0
mode=automatic agents=5 seed=49321 safety=0 grants=4 p50_ms=9 p95_ms=13 wasted_holds=1 wasted_ms=22 calls=23 starvation=0 disconnects=3 crashes=1
mode=fresh-claim agents=5 seed=49321 safety=0 grants=1 p50_ms=17 p95_ms=17 wasted_holds=0 wasted_ms=0 calls=56 starvation=2 disconnects=1 crashes=2
mode=automatic agents=10 seed=49326 safety=0 grants=14 p50_ms=22 p95_ms=55 wasted_holds=3 wasted_ms=66 calls=45 starvation=0 disconnects=4 crashes=1
mode=fresh-claim agents=10 seed=49326 safety=0 grants=4 p50_ms=19 p95_ms=42 wasted_holds=0 wasted_ms=0 calls=211 starvation=5 disconnects=1 crashes=2
mode=automatic agents=25 seed=49341 safety=0 grants=33 p50_ms=36 p95_ms=77 wasted_holds=6 wasted_ms=132 calls=190 starvation=13 disconnects=15 crashes=5
mode=fresh-claim agents=25 seed=49341 safety=0 grants=12 p50_ms=36 p95_ms=67 wasted_holds=0 wasted_ms=0 calls=542 starvation=18 disconnects=9 crashes=2
```

All eight fault cases reported zero safety violations. At 25 agents, automatic mode recorded 33 waiting grants, p50 36 ms, p95 77 ms, 190 calls, and 13 starvation events. Fresh-claim mode recorded 12 waiting grants, p50 36 ms, p95 67 ms, 542 calls, and 18 starvation events. Across the tested cases, automatic mode had six wasted holds and 132 modeled wasted milliseconds; the turn mode had none because a turn does not occupy a lease. At two agents, turn mode produced zero completed waits, so its zero percentiles mean “no sample,” not zero latency.

These values are **CAPABILITY-DEPENDENT (source date: 2026-10-15 prototype run)** where they describe agent retry, delay, disconnection, or task completion behavior. They are not estimates of real agents, real wall-clock latency, server call volume, or production starvation. The modes followed the same seed, but their different state transitions changed subsequent events; this is not a paired benchmark with a fixed common event trace. The short runs also have few grants, no repeated seeds, no confidence intervals, and arbitrary contention probabilities. The safety count is a check of this implementation's asserted invariant, not evidence of protocol safety in a concurrent server.

## Recommendation and limits

Choose the **fresh authenticated claim** design for a coordinator where authorization lives outside the lease transaction. The turn may be abandoned, but it cannot itself transfer authority to a principal whose token was revoked after enqueue. This recommendation is **STRUCTURAL (source dates: 2026-10-14 design history; 2026-10-15 review)**: it follows from requiring a new authentication check at the point of authority, while the v2 notes say a separate authorization catalog cannot be synchronously read inside the lease transaction. It does not prove that every in-flight request is ordered after revocation, nor does it solve a compromised or incorrectly bound identity.

Automatic grant is attractive where the coordinator can atomically validate current authorization and install a fenced lease. It avoids an extra agent round trip, and this prototype shows the expected reduction in call count under its particular workload. Its grant-time token check is a model assumption, not evidence the deployed system can perform that check atomically. If authorization and granting cannot share a transaction or equivalent linearization point, a release hook that grants from the enqueue record risks transferring a lease after revocation. A future experiment should include a real authorization boundary and test revocation racing with grant.

Before choosing based on performance, rerun a larger, predeclared simulation over many seeds and fixed common arrival/failure traces. Vary holding-time distributions, notice-versus-silent disconnect rates, lease renewal, turn duration, delayed alarms, multi-unit hot spots, and arrivals after published changes. Report grants per task, p50/p95/p99 latency, calls by operation, unused lease time, starvation definition and rate, and uncertainty ranges. Keep authorization safety tests separate from throughput measurements. Then run a bounded live pilot with consent and instrumented agents; no result here authorizes that pilot. The owner questions about holder identity, waiter ordering across aliases, and selection of stage-two experiments remain open in the supplied research report (source date: 2026-10-15).

## Reproduction and validation

The prescribed command was attempted. Bun is not installed; the network-fetched `tsx` runner then failed to create its IPC socket under the supplied scratch path (`listen EINVAL`). Node 26's built-in TypeScript stripping ran the same test file successfully as a local fallback. The report's measurements are simulation output, not an external benchmark.

```text
$ cd spikes/v3/c4 && (bun test.ts || npx --yes tsx test.ts)
zsh:1: command not found: bun
npm error code EPERM
npm error syscall open
npm error path /Users/sebastianpatronsoto/.npm/_cacache/tmp/***
npm error errno EPERM
npm error
npm error Your cache folder contains root-owned files, due to a bug in previous versions of npm which has since been addressed.

$ npm_config_cache="$DELEGATE_SCRATCH_DIR/npm-cache" sh -c 'cd spikes/v3/c4 && (bun test.ts || npx --yes tsx test.ts)'
sh: bun: command not found
Error: listen EINVAL: invalid argument <scratch>/tmp/tsx-501/<socket>.pipe

$ node --experimental-strip-types spikes/v3/c4/test.ts
deterministic tests: 7 scenarios passed for automatic grant and fresh-claim turn
fault injection (seeded xorshift; 190 steps plus bounded drain per case)
...the eight raw result lines are recorded above...
```

The word-count check is intended to keep this report between 1,500 and 3,000 words. The command and final count are in the handoff validation record.
