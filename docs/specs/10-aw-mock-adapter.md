# 10 — Translate one launcher task into one Concord change

Budget: 45 minutes. Suggested worker: Codex gpt-6-luna or an already-authorized Muse worker. Dependencies: 01 and 09. Behavior: a demo-only AW-shaped task maps idempotently into Concord's lifecycle.

## Delegation spec

Goal:
  Outcome: Demonstrate a compatibility shim for the existing launcher concept without reading or modifying its private code or invoking real workers.
  Done when:
    - npm run aw-mock -- --fixture demo/aw-task.json --run-state PATH accepts the public fixture schema (schemaVersion, project, taskId, explicitAttempt, intent, unitKeys, workerLabel, worktree, optional observedBaseOid) and maps task intake to change create, lease claim, candidate publish, status polling, and enqueue through the shared CLI client. observedBaseOid is a refreshable hint, never task identity; retry of an active task returns its existing mapping before changing work.
    - The identity key is project/taskId/explicitAttempt, never base/head SHA. Running the same task seven times or changing the observed base returns the same active change and cannot create seven changes. Terminal state requires an explicit incremented attempt.
    - Output identifies operations corresponding to launcher concepts (prepare worktree, open change, review status, request landing) with Concord IDs and URLs. It labels itself mock and uses pre-authored synthetic edits; no paid worker/model or real gh command is invoked.
    - Approval remains external: the adapter stops at awaiting_review until an independent fixture reviewer submits a verdict. A lease refusal or failed checker is returned as structured blocked context, never converted into a successful launch.
    - A small run-state file records task/change mapping atomically in the caller-supplied demo directory. Restart resumes by idempotency key even if that local state is lost. No writes occur in an existing AW installation.
    - Tests cover seven retries, changed base, process restart/lost local state, conflicting intent under one key, lease conflict, waiting review, and terminal explicit reattempt. All remote calls are fake or local Concord.
  Inputs:
    - Owner description in docs/ARCHITECTURE.md and docs/DEMO.md; use only the public interface from 09. The real launcher's internal schema is unknown, so document the assumed minimal fixture shape rather than claiming drop-in compatibility.
    - This demonstrates an adapter boundary, not a production migration. No GitHub API credentials or external repository access are authorized.
  Deliverables:
    - AW mock entrypoint and fixture schema, dedupe tests, and an explicit future integration mapping runbook.
  Stop and escalate when:
    - Implementing the mapping would require private AW contents, changes to the real launcher, or paid worker invocation. Keep the mock boundary and report the missing future integration contract.
Allowed files:
  adapters/aw-mock.ts
  adapters/aw-schema.ts
  tests/node/aw-mock.test.ts
  docs/aw-mock.md
Validation:
  npm run typecheck
  npm run test:target -- tests/node/aw-mock.test.ts
  sh scripts/validate.sh
Commit message: feat: demonstrate intent-keyed AW to Concord adaptation
Sandbox: on
