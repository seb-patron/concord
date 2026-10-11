# Concord MCP server

Run Node 22+ with `CONCORD_URL` and `CONCORD_TOKEN` set, then `npm run mcp`. The process speaks MCP over stdio. The server writes only MCP messages to stdout; MCP client configurations should use `npm run --silent mcp` to suppress npm's own banner. Configure one server per Concord identity: authors need agent credentials; an independent reviewer needs a reviewer credential. The server delegates every HTTP request to `cli/client.ts` and adds no Worker API routes.

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
| `lease_claim` | `repoId`, `changeId`, `unitKeys`, `intentText` | `ttlSeconds` (1–300, default 120), `idempotencyKey` | Grant with lease IDs and fences, or normal `conflict: true` result with holder, intent, expiry, keys and next action |
| `lease_release` | `repoId`, `leaseId`, `fence` | `idempotencyKey` | Released lease |
| `lease_list` | `repoId` | `cursor` | Lease page and refusals |
| `change_checkout` | `repoId`, `changeId`, `worktree` | none | Fetches the candidate branch into `refs/remotes/concord/...`; returns branch and credential-free remote |
| `change_publish` | `repoId`, `changeId`, `worktree`, `leaseFences` | `idempotencyKey` | Verifies local base and HEAD, pushes the candidate fork, registers its ref, and publishes a revision |
| `findings_list` | `repoId`, `changeId` | `cursor` | Findings and finding set version |
| `review_verdict_submit` | `repoId`, `changeId`, `revision`, `reviewManifestDigest`, `findingSetVersion`, `decision`, `evidenceDigest` | `idempotencyKey` | Reviewer verdict; `decision` is `approve` or `reject` |
| `queue_enqueue` | `repoId`, `changeId`, `verdictId`, `leaseFences` | `idempotencyKey` | Admitted queue entry |
| `queue_status` | `repoId` | none | Queue entries and results |
| `events_since` | `repoId` | `after`, `cursor` | Events after a sequence; `after` takes priority |

Read the returned `version` and `eventSeq` envelopes to understand current state. The server reads the latest repository version before mutations that require `expectedVersion`. If state changes in the meantime, retry after rereading. A lease conflict is a normal tool result; other failures use MCP `isError` with a redacted diagnostic. The configured token and minted Git tokens are registered with the CLI redactor and never returned by a tool. Git tokens are supplied to Git only via child process environment configuration (`http.extraHeader`), never placed in remotes, tool results, or persistent Git config. The local test bridge may issue a `file://` remote only when `CONCORD_URL` is loopback; deployed service remotes must be credential-free HTTP(S).

`change_checkout` requires an existing local Git worktree and fetches the candidate ref there. For a new worktree, clone the canonical repository first with the CLI `repo clone` command. Commit edits locally, then call `change_publish` with live fence values for every declared unit. Publication starts inspection; wait for a ready change before an independent reviewer submits a verdict. Reviewers get the `reviewManifestDigest` from the trusted inspection result, not from an invented value. The author can enqueue only with that verdict and current lease fences, then poll `queue_status`, `findings_list`, and `events_since` to react to landing, blocking, or requested repair. See [CLI guide](cli.md) and [API guides](api-repos.md) for detail.

Status: validated against main `5b558e0`.
