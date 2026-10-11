# 09 — Drive the change lifecycle from an agent terminal

Budget: 75 minutes. Suggested worker: Codex gpt-6-luna. Dependency: 01; integration uses 02–07. Behavior: a machine-readable CLI faithfully drives the versioned HTTP/Git workflow.

## Delegation spec

Goal:
  Outcome: Let an agent claim work, publish a candidate, inspect preserved context, and request landing without knowing Cloudflare credentials or GitHub PR conventions.
  Done when:
    - npm run concord -- exposes repo create/list/clone; change create/get/checkout/publish/close; lease claim/list/renew/release; queue list/enqueue/withdraw; finding list/add; repair submit/review; verdict add/carry; and events list. Generic api METHOD PATH --body-file PATH covers advanced operations.
    - Commands use CONCORD_URL and CONCORD_TOKEN from environment or token stdin, --repo, --json, --idempotency-key, and --expected-version as applicable. Help names required fields. JSON-only stdout and structured stderr preserve exit codes 0 success, 2 usage, 3 conflict, 4 auth, 5 transport/server.
    - change checkout fetches its owned fork; repo clone requests read-only canonical access. change publish --worktree PATH resolves exact local base/head, pushes only to the server-assigned candidate fork, then submits revision plus unit/lease fences. It never pushes main or persists tokens in remote URLs/config.
    - Retry uses the same key and body only for safe transient requests, honors Retry-After, and stops after three attempts. A changed base does not change task identity. Conflict output includes holder intent and an actionable retry/renew instruction without automatically stealing leases.
    - CLI client is importable by the AW mock and demo harness. It does not import Worker runtime modules, launch an agent model, or change the real AW launcher.
    - Tests cover a full fake-transport lifecycle, 409 lease refusal, version conflict, expired identity, redacted token, retry after lost response, stdout/stderr separation, path-with-spaces Git argv, and rejection of a canonical push target.
  Inputs:
    - docs/ARCHITECTURE.md HTTP/agent contract and docs/DEMO.md command syntax; 01 types. Use standard Node argument parsing; avoid new dependencies and package/config edits.
    - Git operations use process-local credential injection and fixed argv. Tests use tiny temporary repos and injected fetch. Local fake mode is explicit.
  Deliverables:
    - CLI entrypoint, reusable client and Git helper, command/error tests, and CLI reference matching every demo command.
  Stop and escalate when:
    - An essential command requires a missing server contract, canonical write access, or a new dependency outside the frozen package. Do not widen the allowlist or bypass API authorization.
Allowed files:
  - cli/main.ts
  - cli/client.ts
  - cli/git.ts
  - tests/node/cli.test.ts
  - docs/cli.md
Validation:
  - npm run typecheck
  - npm run test:target -- tests/node/cli.test.ts
  - sh scripts/validate.sh
Commit message: feat: drive Concord changes from an agent CLI
Sandbox: on
