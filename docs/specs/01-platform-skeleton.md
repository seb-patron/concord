# 01 — An offline request reaches persistent repository state

Budget: 90 minutes. Suggested worker: Codex gpt-6-sol. Dependency: none. The single behavior is an authenticated local request reaching a durable, typed module boundary. Feature placeholders must fail closed.

## Delegation spec

Goal:
  Outcome: Establish the Workers/DO runtime and frozen contracts so all later slices can implement isolated modules and run a real local validation gate.
  Done when:
    - Node 22+, pinned compatible Wrangler (at least 4.145.0), TypeScript, tsx, Vitest, the Cloudflare Vitest integration, and jsdom are installed with one npm lockfile. No remote account is required for tests or dev.
    - Worker routes health, authenticated repo dispatch, snapshot, and cursor-based events to TenantCatalog and RepoCoordinator SQLite DOs. Cross-tenant requests, expired credentials, conflicting idempotency bodies, and stale versions are rejected.
    - src/contracts.ts defines all records, API envelopes/mutation bodies, RepoStorage, Module lifecycle, job/result discriminated unions (including empty-repo bootstrap), and internal hooks listed in ARCHITECTURE.md. Namespaced migrations and synchronous transaction/event helpers are implemented. A module can contribute snapshot state without editing the central registry. Owner-installed policies/profiles load from trusted configuration, with a local fixture loader that rejects production mode.
    - Prewire the six feature modules and both provider adapters as explicit unavailable placeholders. Prewire local fake selection, role-specific local fixture identities, static assets, alarm dispatch to all modules, and injected clock support for tests. No placeholder may approve a change, resolve a finding, or advance main.
    - The fake persists repo/object fixtures through its injected state store, provides deterministic faults and conditional ref-update test support, and conforms to RepoStorage. It does not claim smart HTTP or real Artifacts compatibility. Document the local bridge replacement seam.
    - scripts/validate.sh is replaced with a fail-fast real gate: npm run typecheck then npm test (non-watch, all implemented local tests). Neither command may succeed with zero tests. A failing type fixture and failing test in an isolated temporary copy demonstrate a nonzero gate result, without changing committed files.
    - npm run test:target -- <path> dispatches Workers versus Node test projects by tests/workers/ versus tests/node/. All later directories are included in typecheck and test discovery. package scripts reserve concord, runner, git-bridge, aw-mock, replay, demo, mirror, and deploy:check commands described in DEMO.md, even before their entrypoints exist.
  Inputs:
    - Read docs/ARCHITECTURE.md, docs/DEMO.md, and docs/specs/README.md. This slice implements infrastructure only, not the later features.
    - Use live official Workers docs to choose a compatible pinned toolchain; the current docs recommend @cloudflare/vitest-plugin rather than its older pool integration. No account login, deploy, or paid service is authorized.
    - Local config uses only local DOs and fake/bridge storage. Production config declares Artifacts and static assets but is not deployed. Keep local fixture credentials out of production configuration.
    - Reserve npm scripts: concord=tsx cli/main.ts; runner=tsx runner/main.ts; git-bridge=tsx local/git-bridge.ts; aw-mock=tsx adapters/aw-mock.ts; replay=tsx replay/main.ts; demo=tsx demo/main.ts; mirror=tsx deploy/mirror.ts; deploy:check=tsx deploy/preflight.ts; dev=wrangler dev --config wrangler.local.jsonc.
  Deliverables:
    - Runnable local shell, contract types, test fixtures, fake storage, fail-closed placeholders, and docs/dev.md describing startup and adding one module. Preserve the MIT license.
  Stop and escalate when:
    - The pinned tooling cannot run local SQLite DO tests, a frozen contract cannot express a required architecture transition, or an account/credential would be needed. Report the exact gap rather than loosening gates or editing another slice's eventual implementation.
Allowed files:
  package.json
  package-lock.json
  tsconfig.json
  vitest.config.ts
  wrangler.jsonc
  wrangler.local.jsonc
  worker-configuration.d.ts
  .gitignore
  scripts/validate.sh
  src/worker.ts
  src/contracts.ts
  src/auth.ts
  src/http.ts
  src/state.ts
  src/catalog.ts
  src/coordinator.ts
  src/storage/interface.ts
  src/storage/fake.ts
  src/storage/artifacts.ts
  src/storage/bridge.ts
  src/features/repos.ts
  src/features/leases.ts
  src/features/queue.ts
  src/features/runners.ts
  src/features/findings.ts
  src/features/verdicts.ts
  web/index.html
  web/app.js
  web/styles.css
  tests/helpers.ts
  tests/workers/platform.test.ts
  tests/workers/storage-contract.test.ts
  docs/dev.md
Validation:
  npm run typecheck
  npm run test:target -- tests/workers/platform.test.ts tests/workers/storage-contract.test.ts
  sh scripts/validate.sh
Commit message: feat: establish Concord local platform and validation gate
Sandbox: network
