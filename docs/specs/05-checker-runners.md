# 05 — Execute a fenced local job and return verifiable evidence

Budget: 90 minutes. Suggested worker: Codex gpt-6-sol. Dependency: 01; local bridge from 02 needed only for integrated acceptance. Behavior: durable job delivery with a trusted local executor.

## Delegation spec

Goal:
  Outcome: Let an owner's Mac/PC pull immutable work, execute pinned inspection/check/promotion operations, and safely return evidence after retries or crashes.
  Done when:
    - Runner poll, heartbeat, result, and credential endpoints implement 60-second claims, 20-second heartbeats, monotonic attempt fences, role/profile filtering, one active job per runner, and at most three attempts. Empty poll returns 204; expired/stale results return 409 and cannot change queue state.
    - schedule creates durable idempotent jobs; result dispatch uses stored kind to call repos.inspectRevision, verdicts.evaluateCarry, or queue.onResult. Identical retransmission returns the original outcome; conflicting resultDigest is rejected. Interrupted work is recoverable after coordinator restart.
    - runner/main.ts implements --role checker or promoter, --once, and bounded --max-jobs N / --idle-timeout-seconds N modes. It polls outbound, uses exact OIDs, isolated temporary work directories, fixed argv subprocesses, output cap 16 KB, and timeout/cleanup. It never evaluates server-supplied shell text.
    - inspect-candidate computes actual unit writes, base/head ancestry, and review-manifest evidence from trusted policy. validate-stack fetches exact candidate inputs, composes in order, invokes the pinned checker, and pushes only the composed commit to its assigned scratch fork. The TSV helper combines disjoint row changes but refuses a divergent same-row edit; ordinary conflicts remain explicit.
    - delta-check recomputes content/dependency evidence and runs affected-unit checks using the same trusted profile. It reports facts to 07, which decides carry. No runner-generated approval is accepted as reviewer identity.
    - Promoter mode never executes source or checkers. It verifies the ticket and commit ancestry, applies an explicit expected-old Git push, and reports readback. Checker processes receive no canonical credentials; promoter credentials are unavailable to checker mode. Disable hooks, ambient Git config, and candidate-controlled executable selection.
    - The explicit bootstrap input (null canonical base) validates the seed tree without composition; its promotion requires absent main instead of a parent ancestry check. Only the owner-authorized stored bootstrap job can use this case. Subsequent ordinary jobs cannot claim an empty base to bypass ancestry.
    - The local allowlist profile schema records checker/oracle/toolchain/environment digests and argv; default demo timeout is 120 seconds, with a configurable 35-minute ceiling for owner profiles. Fake timers test long runs without waiting. Credentials are renewed only while the job fence is valid and are redacted from logs.
    - Tests exercise expired claims, wrong profiles, replayed results, subprocess timeout, missing compiler => ENV_ERROR, no credential in child environment, TSV collision, stale expected-old push, and timeout-after-success reconciliation. Use small real temporary Git repos plus fake API transport, not CPU load.
  Inputs:
    - docs/ARCHITECTURE.md local protocol, review manifests, and queue; 01 types and test helpers. Native git and Node 22+ are available. No proprietary compiler or API/model spend is authorized.
    - Keep generic worker execution limited to owner-controlled synthetic code. An OS sandbox for hostile code is explicitly deferred; do not advertise containment from process environment filtering alone.
  Deliverables:
    - Durable job module, local runner/Git/profile helpers, protocol tests, and owner runner runbook.
  Stop and escalate when:
    - Required result identity cannot be verified, standard Git cannot enforce expected-old writes, or isolation would require ungranted system/account permissions. Do not replace a real check with a scripted green result.
Allowed files:
  src/features/runners.ts
  runner/main.ts
  runner/execute.ts
  runner/git.ts
  runner/profiles.ts
  runner/units.ts
  tests/workers/runners.test.ts
  tests/node/runner.test.ts
  docs/runner.md
Validation:
  npm run typecheck
  npm run test:target -- tests/workers/runners.test.ts tests/node/runner.test.ts
  sh scripts/validate.sh
Commit message: feat: execute fenced checker jobs on local runners
Sandbox: on
