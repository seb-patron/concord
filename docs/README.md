# Concord documentation

This index points to the documents in this folder and its `specs/` subfolder. Choose a group by what you need to do; each link includes a short description of what its page covers.

## Getting started

- [Local platform development](dev.md) — Set up a fresh checkout and run the local validation workflow.
- [Concord glossary](GLOSSARY.md) — Find Concord terms, their closest GitHub equivalents, and links to relevant sections.
- [Concord demo](DEMO.md) — Rehearse and film the local nine-minute demonstration.
- [Concord judging map](JUDGING.md) — See the competition criteria and the evidence plan for them.

## Using Concord

- [Concord agent CLI](cli.md) — Use the command-line interface to manage changes, with a link to the land workflow.
- [Land a finished agent run](land.md) — Start a change, keep its leases active, and land it after review.
- [Import an existing Git repository](import.md) — Adopt a source branch while controlling its starting tree and history.
- [Local runner](runner.md) — Run checker or promoter jobs and understand claims, renewals, and recovery.
- [Concord MCP server](mcp.md) — Configure the stdio MCP server and its Concord identities.
- [Repository tracker](ui.md) — Understand the repository tracker, its lanes, filters, and displayed state.
- [A/B report](replay-ab.md) — Generate a comparison report from serial, swarm, and metrics inputs.
- [Replay timeline export](replay-export.md) — Supply sanitized local JSONL evidence to the replay harness.
- [AW concept mock adapter](aw-mock.md) — See the assumed synthetic task shape and the adapter's mock boundary.

## API reference

- [Authentication API](api-auth.md) — Configure credential profiles, precedence, permissions, and reviewer identity.
- [Repository and change API](api-repos.md) — Provision repositories, manage candidate forks, and publish revisions.
- [Semantic lease API](api-leases.md) — Acquire, renew, and release fenced leases.
- [Queue API and recovery runbook](api-queue.md) — Understand queue decisions, dependencies, and recovery.
- [Findings and repair rounds](api-findings.md) — Learn how findings are identified, retained, and cleared.
- [Review verdicts and carry](api-verdicts.md) — See what a review verdict binds to and when it can carry forward.
- [Issues and milestones API](api-issues.md) — Read and mutate repository-scoped issues and milestones.
- [Delegated principals API](api-principals.md) — Create tenant-scoped runtime principals without storing plaintext tokens.
- [Repository flow metrics](api-metrics.md) — Query measured event-log flow over a bounded time window.

## Operating Concord

- [Concord deployment and one-way demo mirror](deploy.md) — Review deployment boundaries, prerequisites, and mirror constraints.
- [Cost guards before public deployment](cost.md) — Review cost limits and owner monitoring responsibilities.

## Design history

- [Concord architecture](ARCHITECTURE.md) — Read the design contract and its status as a design rather than an implemented service.
- [Owner decisions](decisions.md) — Consult the permanent record of decisions and their stable IDs.
- [Concord implementation slices](specs/README.md) — See how the twelve implementation specs are organized and related.
- [01 — Offline request to persistent repository state](specs/01-platform-skeleton.md) — Specify the authenticated local request and durable typed boundary.
- [02 — Publish an immutable candidate](specs/02-repos-and-changes.md) — Specify repository changes, candidate forks, and immutable revisions.
- [03 — Semantic leases](specs/03-semantic-leases.md) — Specify atomic acquisition and fenced lifetime for semantic resources.
- [04 — Merge queue](specs/04-merge-queue.md) — Specify the bounded process for landing approved candidates.
- [05 — Checker runners](specs/05-checker-runners.md) — Specify durable job delivery to a trusted local executor.
- [06 — Findings ledger](specs/06-findings-ledger.md) — Specify persistent findings and atomic repair rounds.
- [07 — Verdict carry](specs/07-verdict-carry.md) — Specify when content-bound approval can survive a mechanical base change.
- [08 — Web UI](specs/08-web-ui.md) — Specify an accessible operations screen for change state and next actions.
- [09 — Agent CLI](specs/09-agent-cli.md) — Specify a machine-readable CLI for the versioned HTTP and Git workflow.
- [10 — AW mock adapter](specs/10-aw-mock-adapter.md) — Specify mapping one synthetic launcher-shaped task into Concord's lifecycle.
- [11 — Replay harness](specs/11-replay-harness.md) — Specify qualified replay reports from sanitized evidence.
- [12 — Demo and deploy](specs/12-demo-and-deploy.md) — Specify reproducible demo output and gated deployment or mirror publication.
