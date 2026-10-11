# Local platform development

Use Node 22 or newer. In a fresh checkout, `sh scripts/validate.sh` installs the pinned lockfile with `npm ci --no-audit --no-fund` and then runs TypeScript and every implemented local test. For interactive development:

```sh
npm ci --no-audit --no-fund
npm run dev
```

Wrangler serves the local Worker, SQLite Durable Objects, and static shell without an account. The local configuration selects the in-process fake provider. Visit `/health` to see the mode. Local fixture bearer identities are `local-owner`, `local-agent-a`, `local-agent-b`, `local-agent-c`, `local-contest-low`, `local-contest-high`, `local-mock-aw`, `local-reviewer`, `local-checker`, `local-promoter`, and `local-viewer`; they are accepted only in local mode. Example:

```sh
curl -H 'Authorization: Bearer local-owner' http://127.0.0.1:8787/v1/repos/demo/snapshot
curl -H 'Authorization: Bearer local-viewer' 'http://127.0.0.1:8787/v1/repos/demo/events?after=0'
```

The other repository routes deliberately return `501 MODULE_UNAVAILABLE`. Nothing can approve, resolve, schedule a promotion, or advance `main` in this slice. Production configuration declares an Artifacts binding and static assets but is not deployed; `src/storage/artifacts.ts` is an unavailable adapter until slice 02. The fake remote is `fake://`, an identifier only. It has no smart HTTP transport and does not emulate Artifacts. Slice 02 replaces `src/storage/bridge.ts` with an HTTP adapter to a loopback Node Git bridge over local bare repositories. The Worker must never use `fs` or `child_process` to implement that seam.

Trusted policy and profile records come from a server-controlled `TRUSTED_CONFIG` JSON secret. Local mode uses `local-demo` fixture records when that secret is absent. The fixture loader rejects production mode. Do not put fixture bearer tokens or trusted configuration in `wrangler.jsonc`.

The TenantCatalog dispatches `POST /v1/repos` to the repos module. Its `GET /v1/repos` reads the repos module state key `catalog:index` as `Repo[]`, filtered to the authenticated tenant and repo allowlist, in pages of 100. Slice 02 must update this index when it records provisioning and status. The repo coordinator stores its tenant/repo identity on first access so alarms retain the correct scope after restart.

## Add one module

Each `src/features/*.ts` module is already imported by `src/coordinator.ts`. Replace its placeholder route handlers, `migrations`, `onAlarm`, `nextDeadline`, `snapshot`, and typed `hooks` in that module file. A migration has a module-local version and SQL `CREATE TABLE`/`CREATE INDEX` statements with the module name as prefix, such as `leases_claims`. `applyMigrations` tracks versions in SQLite and rejects unprefixed schema changes. Use `context.transaction(() => { ... })` for synchronous read/check/write work; fully consume SQL cursors before awaiting an external call. Use `context.state` for module-prefixed JSON state, `context.nextVersion()` and `context.appendEvent()` for durable transitions. `nextDeadline()` returns the module's earliest pending timer; the coordinator schedules the one DO alarm and calls every `onAlarm()` handler. A module's `snapshot()` is picked up automatically, so no central projection switch needs editing. Internal cross-module calls go through `context.call()` and return an eligible or blocked gate with version and evidence IDs. Unknown and unavailable outcomes stay blocked.

Run a specific Workers test with `npm run test:target -- tests/workers/name.test.ts`; a `tests/node/` path selects the Node project. Both projects are discovered by the full `npm test` gate. The `cli/`, `runner/`, `local/`, `adapters/`, `replay/`, `demo/`, and `deploy/` TypeScript trees are already included in typechecking when later slices create them. Reserved commands in `package.json` point to their future entrypoints.
