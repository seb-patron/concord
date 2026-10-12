# Concord agent loop

Concord coordinates candidate changes by semantic unit. Read this before editing any Concord managed repository.

1. Get `repo_get` and `repo_context`; use the observed canonical head as the base for `change_create`. Keep one stable `intentKey` for the task.
2. Call `lease_claim` for every unit you will edit **before editing**. A conflict returns the holder, their intent, expiry and suggested action. Wait or ask the holder to release. Renew expiring leases through the CLI when needed; keep the latest fence for each unit.
3. Fetch the candidate fork using `change_checkout` or the CLI, edit only held units, then commit locally. `change_publish` pushes only to the assigned candidate fork, registers its ref, and starts inspection. Poll `change_status` until ready.
4. An **independent reviewer** checks the inspected revision and findings, then uses `review_verdict_submit` (or `verdict add` in the CLI) with the trusted review manifest digest. The author cannot review their own change.
5. The author uses `queue_enqueue` with that verdict and all current lease fences. Poll `queue_status` and `events_since`. If the queue lands the change, finish. If blocked or failed, read `findings_list`, repair under live leases, publish a new revision, obtain a new verdict, and enqueue again. Release unused leases.

Never edit outside the units covered by your held, unexpired leases. Never push to the canonical repository; Concord's promoter alone advances it. Do not put API or Git tokens in a remote URL, logs, output, or files. The MCP server uses process-local Git credentials. The API's reviewer role and lease rules are enforced by Concord, not by the agent's prose.

## Run with MCP or CLI

Set `CONCORD_URL` and `CONCORD_TOKEN` in the agent process environment. For Claude Code or Cursor, add this `.mcp.json` entry (the token remains in the environment):

```json
{
  "mcpServers": {
    "concord": { "command": "npm", "args": ["run", "--silent", "mcp"], "env": { "CONCORD_URL": "https://concord.example" } }
  }
}
```

For Codex, add to its MCP configuration:

```toml
[mcp_servers.concord]
command = "npm"
args = ["run", "--silent", "mcp"]
env = { CONCORD_URL = "https://concord.example" }
```

Start the agent from the Concord checkout so `npm run mcp` resolves. Give the reviewer a separate process and reviewer token. Tool names and input JSON schemas are in [docs/mcp.md](docs/mcp.md).

The CLI uses the same API client: `npm run concord -- repo list`, `change create`, `lease claim`, `change checkout`, `change publish`, `verdict add`, `queue enqueue`, `queue list`, `finding list`, and `events list`. See [docs/cli.md](docs/cli.md) for exact flags, version and fence requirements.
