# Issues and milestones API

Issues are repository scoped task specs. All routes below begin with `/v1/repos/:repoId` and use the usual Bearer token and `Idempotency-Key` header for mutations. Mutation bodies are JSON. Responses use the standard `{ data, version, eventSeq }` envelope. Issue and milestone objects also have their own `version`; send that value as `expectedVersion` when editing or closing one.

## Issues

| Method | Path | Body or query | Result |
| --- | --- | --- | --- |
| `POST` | `/issues` | `title`, `body` (Markdown, at most 64 KiB), optional `labels`, `milestoneId`, `allowedFiles` | Creates the next issue number in this repo. |
| `GET` | `/issues` | Optional `state=open\|closed`, `label`, `milestoneId`, `cursor`, `limit` (1–100) | Page of issues with `nextCursor`. |
| `GET` | `/issues/:number` | — | Issue and linked changes with status. |
| `PATCH` | `/issues/:number` | `expectedVersion` and any of `title`, `body`, `labels`, `milestoneId`, `allowedFiles` | Updates the issue. Use `null` to clear a milestone or allowed files. |
| `POST` | `/issues/:number/close` | `expectedVersion`, nonempty `reason` | Closes an issue. |
| `POST` | `/issues/:number/reopen` | `expectedVersion`, nonempty `reason` | Reopens an issue. |

Issue responses and `projections.issues.items` include `createdAt` and `updatedAt` as UTC epoch milliseconds, and `closedAt` as UTC epoch milliseconds or `null`. Creation sets `createdAt` and `updatedAt`; edits update `updatedAt`. Closing sets `closedAt` and `updatedAt`, while reopening clears `closedAt` and updates `updatedAt`. Older stored issues may omit these fields.

Owners and agents scoped to the repository may create issues. The creating author or an owner may edit, close, and reopen. Reviewers and viewers can read. A `change create` request may include `issueNumber`; the issue must be open. Change, lease, and queue views expose that number. Lease conflicts also include the holder issue title. An issue's `changes` field lists linked changes and their current status.

The repository snapshot includes `leases.heldItems`, the complete set of live active and reserved leases, with issue links. The paged `leases.items` field and lease list route retain their existing cursor behavior.

When promotion lands a linked change, Concord closes its issue with `closedBy: { changeId, canonicalOid }`. Closing or superseding a change does not close the issue. Issue changes emit `issue.created`, `issue.updated`, `issue.closed`, or `issue.reopened` events through the repository event log.

## Milestones

| Method | Path | Body or query | Result |
| --- | --- | --- | --- |
| `POST` | `/milestones` | `title`, optional `description`, `dueDate` (`YYYY-MM-DD`) | Creates a milestone. |
| `GET` | `/milestone-settings` | — | Returns `{ create: "agents" | "owners", version }`; available to repository readers. |
| `PATCH` | `/milestone-settings` | `create`, `expectedVersion` | Owner-only compare-and-set for milestone creation permissions. |
| `GET` | `/milestones` | Optional `cursor`, `limit` | Page of milestones. |
| `GET` | `/milestones/:id` | — | Milestone with progress. |
| `POST` | `/milestones/:id/close` | `expectedVersion` | Closes a milestone. |

Milestone creation is available to owners and agents by default. Owners can set `create` to `owners` to restrict creation; changing it requires the current settings `version`. Reviewers and viewers cannot create milestones. Closing a milestone remains owner-only. Invalid setting values return `422 INVALID_CREATE`, stale settings versions return `409 STALE_VERSION`, and non-owner updates return `403 FORBIDDEN`. Settings updates emit `milestone.settings_updated`. Progress contains `openIssues`, `closedIssues`, and `landedChanges`; it is derived from current issues and the queue. Creation, closure, and issue progress emit `milestone.created`, `milestone.closed`, and `milestone.updated` events. A milestone can be closed while issues remain open.
