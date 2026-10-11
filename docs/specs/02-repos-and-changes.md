# 02 — Publish an immutable candidate into a change

Budget: 90 minutes. Suggested worker: Codex gpt-6-sol. Dependency: 01. Behavior: a repo-backed change owns a fork and can publish a verified immutable revision. Runner hooks can be mocked while 05 is in flight.

## Delegation spec

Goal:
  Outcome: Implement the repo/change lifecycle over the Artifacts boundary, with a real local Git bridge for account-free integration.
  Done when:
    - GET/POST repos, repo details, registered branch listing/registration, fork-scoped git-token issuance, GET/POST changes, change details, publish, and close follow the architecture envelopes and role rules.
    - Repo/fork creation records provisioning intent before external work; retry after a lost response reconciles by deterministic storage name. Pending provider forks return 202. Failed provisioning remains visible and retryable, with no phantom ready repo.
    - Empty repos can allocate an owner seed draft/fork and accept POST bootstrap, which schedules root-tree validation followed by absent-ref promotion through the queue. Existing main rejects bootstrap; no raw canonical token is returned. Tests cover two concurrent initializers and a failed seed checker.
    - A change starts draft with one candidate fork. Its intent key is stable across base changes; identical active task submissions return the same change. Reusing a key with different intent content conflicts; terminal tasks require an explicit attempt number.
    - Publish resolves the registered candidate branch, verifies head and base existence and expected revision, and schedules inspect-candidate. Only trusted inspection evidence transitions to ready; unknown units and missing objects block it. Head changes invalidate prior queue generation and review evidence. Closing cannot bypass promotion freeze.
    - Artifacts adapter uses only documented methods, disposable repo handles, exact returned remotes, bounded polling of provisioning status, short token TTLs, and immediate revocation of unused initial tokens. An agent never obtains a canonical write token or another change's fork token.
    - The loopback Git bridge implements RepoStorage using temporary local bare repos and fixed argv native Git. It authenticates bridge calls, rejects traversal/unknown storage names, binds only 127.0.0.1, and returns file:// remotes only in local mode. It supports branch/ref reads, immutable object reads, fork copies, and restart persistence under its supplied data directory. The Worker bridge adapter handles this HTTP boundary without Node APIs.
    - Contract tests run create/fork/read/resolve cases against the in-memory fake and local bridge; provider-shaped stubs verify actual binding method/result shapes. Tests cover repeat publication, changed-base dedupe, nonexistent SHA, delayed fork, lost response, and wrong-principal token issuance. Real remote smoke is explicitly deferred to 12.
  Inputs:
    - docs/ARCHITECTURE.md RepoStorage, data model, HTTP, auth, and Open risks; frozen contracts from 01. Read the official Artifacts URLs cited there before implementing the adapter.
    - Branch creation is native Git push to an owned candidate fork followed by API registration. Do not invent a binding branch-write or merge method. Main is advanced only by a promoter job.
    - The local bridge is a labelled fake backend for development, not an alternative deployed platform. Maximum fixture repo size is 10 MB. No private repository is imported.
  Deliverables:
    - Repo/change module, binding and bridge adapters, bridge process, lifecycle/contract tests, and a repo API runbook.
  Stop and escalate when:
    - Artifacts lacks a required operation or conditional Git push is disproved; record evidence and proposed alternative in the report. Do not silently replace Artifacts hosting. Escalate contract changes to the integrator.
Allowed files:
  src/features/repos.ts
  src/repos/model.ts
  src/storage/artifacts.ts
  src/storage/bridge.ts
  local/git-bridge.ts
  tests/workers/repos.test.ts
  tests/workers/artifacts-adapter.test.ts
  tests/node/git-bridge.test.ts
  docs/api-repos.md
Validation:
  npm run typecheck
  npm run test:target -- tests/workers/repos.test.ts tests/workers/artifacts-adapter.test.ts tests/node/git-bridge.test.ts
  sh scripts/validate.sh
Commit message: feat: publish Artifacts-backed Concord changes
Sandbox: network
