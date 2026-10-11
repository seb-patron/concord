# 08 — Explain fleet state and the next useful action

Budget: 90 minutes. Suggested worker: Codex gpt-6-luna (Muse is an alternative only if already authorized by the launcher). Dependency: 01; real API integration follows 02–07. Behavior: one accessible operations screen explains why changes can or cannot land.

## Delegation spec

Goal:
  Outcome: Give the owner and judges a usable repo-to-landing view backed by real API projections, with clear reasons for every blocked state.
  Done when:
    - A static, framework-free browser app uses the frozen snapshot/events contract to render repo switcher, lease board, change details, findings round, approval provenance, queue/bisection tree, runner health, and canonical tip. Poll incrementally every second and preserve selected change, focus, and scroll.
    - Each card shows intent/agent, semantic unit, state, and a next action. Conflicts link to the holder; isolated queue failures highlight only the supported culprit/set; carried verdicts link to original review and delta evidence. Unknown or inconclusive states are labelled explicitly.
    - Minimal actions (claim a registered unit, enqueue/withdraw a change, submit a review verdict with evidence) use real authenticated routes, idempotency keys, and expected versions. Stale 409 responses refresh context rather than pretending success. UI role affordances match server enforcement.
    - The session token is entered once and kept in memory, never URL or localStorage. A viewer can browse without mutation controls. Tokens and raw errors are redacted; all untrusted text uses safe text rendering.
    - Keyboard navigation, visible focus, labels, text accompanying color, readable empty/loading/error/disconnected states, and a 1280x720 presentation layout work. A persistent badge distinguishes local fake, live Artifacts, and historical simulation. Missing replay data says unavailable.
    - Tests with fixture fetch responses cover rejected claim, stale mutation, bisection display, unresolved repair, carried/invalidation verdicts, network recovery, script-like intent text, and focus preservation. A manual browser walkthrough uses the same scenario contract as DEMO.md and is reported honestly.
  Inputs:
    - docs/DEMO.md and docs/JUDGING.md; frozen API types and local placeholders from 01. Tests may use clearly labelled fixtures; product screens must fetch the backend and cannot hard-code green outcomes.
    - Keep the entire UI to one page with a detail panel. No framework migration, chart library, account settings area, OAuth, or pixel-perfect design system is required.
  Deliverables:
    - Accessible static UI, API/view helpers, state/render tests, and a short owner UI walkthrough.
  Stop and escalate when:
    - The API lacks a required projection or action, or live states cannot be represented truthfully. Report the contract gap rather than editing backend/shared files or fabricating display state.
Allowed files:
  - web/index.html
  - web/app.js
  - web/styles.css
  - web/api.js
  - web/views.js
  - tests/node/ui.test.ts
  - docs/ui.md
Validation:
  - npm run typecheck
  - npm run test:target -- tests/node/ui.test.ts
  - sh scripts/validate.sh
Commit message: feat: explain fleet coordination in the Concord web UI
Sandbox: on
