# Concord MCP server

Run Node 22+ with `CONCORD_URL` and `CONCORD_TOKEN` set, then `npm run mcp`. Alternatively set `CONCORD_PROFILE=NAME` to load the URL and token from `CONCORD_CONFIG` or `~/.config/concord/profiles.json`. The profile format, `tokenFile`/`tokenKey`, credential precedence, and private file permission requirement are documented in the [CLI guide](cli.md#authentication-profiles). Profile and token files must be owned by the current user and have mode bits excluding group/world access; profile errors identify the profile and never print its token. The process speaks MCP over stdio. The server writes only MCP messages to stdout; MCP client configurations should use `npm run --silent mcp` to suppress npm's own banner. Configure one server per Concord identity: authors need agent credentials; an independent reviewer needs a reviewer credential. The server delegates every HTTP request to `cli/client.ts` and adds no Worker API routes.

The server uses the official `@modelcontextprotocol/sdk` TypeScript package, pinned to exactly `1.32.1` in `package.json`. The dependency provides the MCP initialization, stdio framing, tool discovery, and call protocol; implementing those independently would make the transport harder to interoperate with and maintain.

## Tool schemas

Every tool input is a JSON object with `additionalProperties: false`. IDs and text are strings. `unitKeys` and `dependencyChangeIds` are arrays of strings. `leaseFences` is an object mapping unit keys to positive integer fences. Other numeric fields are nonnegative integers unless noted. Optional `idempotencyKey` can be reused with the same request body after a lost response. Omitted keys are generated for mutations.

| Tool | Required properties | Optional properties | Result |
| --- | --- | --- | --- |
| `repo_list` | none | `cursor` | Repository page |
| `repo_get` | `repoId` | none | Repository detail and canonical head |
| `repo_context` | `repoId` | none | Repository snapshot with projections |
| `change_create` | `repoId`, `intentKey`, `intentText`, `baseOid`, `branch`, `unitKeys` | `dependencyChangeIds`, `attempt`, `idempotencyKey` | New or existing candidate change |
| `change_status` | `repoId`, `changeId` | none | Change detail, provisioning and revision |
| `change_list` | `repoId` | `mine` (boolean), `status` (comma-separated statuses), `cursor` | One change page, optionally filtered to the caller and statuses |
| `change_close` | `repoId`, `changeId` | `reason` (optional), `idempotencyKey` | Closes the change with the current repository version; releases its leases |
| `lease_claim` | `repoId`, `changeId`, `unitKeys`, `intentText` | `ttlSeconds` (1–trusted `maxLeaseHoldSeconds`, default 120; default cap 14400), `idempotencyKey` | Grant with lease IDs and fences, or normal `conflict: true` result with holder, intent, expiry, keys and next action |
| `lease_release` | `repoId`, `leaseId`, `fence` | `idempotencyKey` | Released lease |
| `lease_renew` | `repoId`, `changeId` | `ttlSeconds` (integer 1–86400, default 300), `idempotencyKey` | Extends all live leases held by the caller for the change; preserves fences and never shortens a hold |
| `lease_list` | `repoId` | `cursor` | Lease page and refusals |
| `change_checkout` | `repoId`, `changeId`, `worktree` | none | Creates or reuses a dedicated Git worktree at `<worktree>/.concord/changes/<changeId>`, starting from the base or existing fork branch. Returns its path, branch and credential-free remote |
| `change_publish` | `repoId`, `changeId`, `worktree`, `leaseFences` | `idempotencyKey` | Verifies the change-specific worktree and its HEAD, pushes the candidate fork, registers its ref, and publishes a revision |
| `findings_list` | `repoId`, `changeId` | `cursor` | Findings and finding set version |
| `review_verdict_submit` | `repoId`, `changeId`, `revision`, `reviewManifestDigest`, `findingSetVersion`, `decision`, `evidenceDigest` | `idempotencyKey` | Reviewer verdict; `decision` is `approve` or `reject` |
| `queue_enqueue` | `repoId`, `changeId`, `verdictId`, `leaseFences` | `idempotencyKey` | Admitted queue entry |
| `queue_status` | `repoId` | none | Queue entries and results |
| `events_since` | `repoId` | `after`, `cursor` | Events after a sequence; `after` takes priority |

Read the returned `version` and `eventSeq` envelopes to understand current state. The server reads the latest repository version before mutations that require `expectedVersion`. If state changes in the meantime, retry after rereading. A lease conflict is a normal tool result; other failures use MCP `isError` with a redacted diagnostic. The configured token and minted Git tokens are registered with the CLI redactor and never returned by a tool. Git tokens are supplied to Git only via child process environment configuration (`http.extraHeader`), never placed in remotes, tool results, or persistent Git config. The local test bridge may issue a `file://` remote only when `CONCORD_URL` is loopback; deployed service remotes must be credential-free HTTP(S).

`change_list` uses the changes cursor and filters the returned page. With `mine: true`, it resolves the caller through `GET /v1/me` and compares `authorId`; `status` is a comma-separated set. `change_close` reads the current repository version and sends it with the close request. Its optional `reason` is forwarded to the API; server-side reason storage and display are delivered separately. `lease_renew` renews every live lease held by the caller for a change in one call, without requiring a hand-fetched version.

For both MCP tools, pass the root of the same local Git repository as `worktree`. `change_checkout` creates a dedicated Git worktree at `<worktree>/.concord/changes/<changeId>` on its first call and returns that path. Edit and commit in the returned path. When the candidate branch does not yet exist on the assigned fork, checkout fetches the base commit from the fork, falling back to the canonical repository if needed, and creates `concord/<changeId>/<branch>` there; the first `change_publish` creates the branch on the fork. When the candidate branch already exists, checkout starts the new worktree from that branch. Later checkouts preserve local commits. `change_publish` reads HEAD only from the dedicated worktree and verifies its assigned local branch. Changes can share a candidate branch name without sharing a working tree. For a new repository root, clone the canonical repository with the CLI `repo clone` command or initialize an empty Git repository. Publication starts inspection; wait for a ready change before an independent reviewer submits a verdict. Reviewers get the `reviewManifestDigest` from the trusted inspection result, not from an invented value. The author can enqueue only with that verdict and current lease fences, then poll `queue_status`, `findings_list`, and `events_since` to react to landing, blocking, or requested repair. See [CLI guide](cli.md) and [API guides](api-repos.md) for detail.

Status: validated against current main `e868839`.

# Repository metrics

`repo_metrics` reads event-derived flow metrics for `repoId`, `since`, and `until` (UTC ISO strings, at most 31 days). See the [metrics API](api-metrics.md).
# Issues and milestones

Agents can use `issue_create` for repository inbox tasks, `issue_get` and `issue_list` for specs, `issue_close` for manual closure, and `milestone_list` and `milestone_create` for milestones. Agents can create milestones by default; owners can restrict creation to owners in the Milestones screen or through the [settings API](api-issues.md#milestones). `change_create` accepts `issueNumber`. The change and lease tools then return the link, and a lease conflict identifies the holder issue number and title. See the [issues API](api-issues.md).
