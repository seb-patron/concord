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

Owners and agents scoped to the repository may create issues. The creating author or an owner may edit, close, and reopen. Reviewers and viewers can read. A `change create` request may include `issueNumber`; the issue must be open. Change, lease, and queue views expose that number. Lease conflicts also include the holder issue title. An issue's `changes` field lists linked changes and their current status.

The repository snapshot includes `leases.heldItems`, the complete set of live active and reserved leases, with issue links. The paged `leases.items` field and lease list route retain their existing cursor behavior.

When promotion lands a linked change, Concord closes its issue with `closedBy: { changeId, canonicalOid }`. Closing or superseding a change does not close the issue. Issue changes emit `issue.created`, `issue.updated`, `issue.closed`, or `issue.reopened` events through the repository event log.

## Milestones

| Method | Path | Body or query | Result |
| --- | --- | --- | --- |
| `POST` | `/milestones` | `title`, optional `description`, `dueDate` (`YYYY-MM-DD`) | Creates a milestone. |
| `GET` | `/milestones` | Optional `cursor`, `limit` | Page of milestones. |
| `GET` | `/milestones/:id` | — | Milestone with progress. |
| `POST` | `/milestones/:id/close` | `expectedVersion` | Closes a milestone. |

Milestone creation and closure require an owner. Progress contains `openIssues`, `closedIssues`, and `landedChanges`; it is derived from current issues and the queue. Creation, closure, and issue progress emit `milestone.created`, `milestone.closed`, and `milestone.updated` events. A milestone can be closed while issues remain open.
