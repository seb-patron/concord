# bors-ng README.md and FLOW_EXAMPLE.md
URL: https://github.com/bors-ng/bors-ng
Fetched: 2026-10-15 20:30:41 UTC; method: `git clone --depth 1 https://github.com/bors-ng/bors-ng.git "$DELEGATE_SCRATCH_DIR/sources/bors-ng"`
Raw SHA-256: README.md `8651bc4c9a9a8ef169f56ba8b9aecac79c45cf16ea437691709c1a21c2cba223`; FLOW_EXAMPLE.md `a499a5ace1234a0dae019469feab6876cde2349711b486ee3b95cb108c83c7d4`
Extracted words: 3548 (`wc -w "$DELEGATE_SCRATCH_DIR/sources/bors-ng/README.md" "$DELEGATE_SCRATCH_DIR/sources/bors-ng/FLOW_EXAMPLE.md`)
Read status: read in full
## Sections
1. **A merge bot for GitHub pull requests** — Bors-NG is introduced as a GitHub-integrated continuous-testing merge queue intended to keep the main branch green. It complements CI by testing combinations that ordinary per-branch and per-PR CI does not cover.
2. **But don't GitHub's Protected Branches already do this?** — Separate PR checks can pass against the same base while their combined result fails after sequential merges. Requiring each PR to be updated onto main can prevent that but makes maintainers repeat update, test, and merge steps serially; bors stages queued changes and tests them together, batches likely-successful changes, and bisects failures.
3. **How it works** — Setup connects the GitHub App, a `bors.toml` required status, and a CI workflow; reviewers enqueue approved work with `bors r+`. Bors constructs a merge commit on staging, advances main to that tested commit on success, and splits failing batches until it identifies a failing PR; `bors try` tests without landing, and batching reduces work when failures are uncommon.
4. **How to run it on your local machine** — The documented Docker setup runs a local server with a mocked GitHub integration, while test and REPL commands reuse that environment. The mock has no repositories by default, and the document points to internal models/controllers for setting up a usable local fixture.
5. **Setting it up without Docker, like on Windows home edition** — A non-Docker development setup needs Elixir/OTP, PostgreSQL, native compilation tools, Git, and Node.js, followed by database setup and Phoenix startup. MySQL is also supported through an alternate repository module, and the listed local checks include tests, style, and dialyzer.
6. **How to set up your own real instance** — Production setup is divided between registering/configuring a GitHub App and deploying the Elixir/Phoenix server with PostgreSQL. The app needs callback and webhook endpoints plus credentials and permissions that let it observe PR/CI events, report statuses, comment, and create merge commits.
7. **Step 1: Register a new GitHub App** — The operator creates a GitHub App and uses the deployment's dashboard URL to set callback and webhook endpoints. A generated webhook secret must match server configuration.
8. **App settings** — The app's display metadata is operationally unimportant, but callback and webhook URLs must point to the deployed dashboard. The setup URL is left blank and the webhook secret is retained for server configuration.
9. **Required GitHub App permissions** — The permission inventory covers repository metadata, statuses/checks, issues, pull requests, contents, and organization membership, with least access for unrelated capabilities. Corresponding webhook subscriptions deliver repository, status, issue-comment, PR/review, check, team, member, membership, and organization events.
10. **Permission summary** — Metadata and organization membership are read-only; status/check, issue, pull-request, and contents access is read/write, while administration, deployments, pages, projects, and single-file access are disabled. The table ties these permissions to the event types needed by the service.
11. **Permission explanations** — Metadata events remove deleted repositories, status and check access reports CI outcomes, issue-comment events carry approval commands, and PR/review events keep the queue and dashboard synchronized. Contents write access permits merge-commit creation, and organization membership access synchronizes contributors and reviewers.
12. **After you click the "Create" button** — A webhook ping may fail before the service is running, which is expected during setup. The operator must retrieve the private key, OAuth credentials, and app ID for server configuration.
13. **Internal app?** — An internal GitHub App can only be installed within its owning organization or user, while an external installation can prevent switching back to internal. The setting is available during creation or in the app's advanced settings.
14. **Step 2: Set up the server** — Bors-NG runs on Elixir/Phoenix with PostgreSQL and needs a deployment URL known before app setup. Deployment configuration supplies app credentials and other bors-specific environment values.
15. **Deploying on Heroku (and other 12-factor-style systems)** — The instructions configure runtime environment values, provision PostgreSQL, deploy the app, and run migrations. Because short-term state lives in the web dyno, the described implementation does not work correctly with Heroku replication; higher throughput requires an Erlang-cluster-capable deployment.
16. **Deploying using Docker (and compatible container orchestration systems)** — A multi-stage image separates build tooling from the runtime, and configuration is supplied through environment variables. The document calls out database URL/port and migration behavior, SSL, MySQL, GitHub Enterprise roots, logging, and the need to coordinate migration behavior with externally managed schemas.
17. **Deploying on your own cluster** — For a cluster deployment, the documented configuration entry point is `config/prod.secret.exs`. This is an alternative to the environment-driven Heroku and Docker examples.
18. **Optional step 3: make yourself an admin** — Admin capabilities include diagnostics and opening a repository dashboard without reviewer status, but there is no UI to grant them. An operator updates the user record either through the Elixir REPL or directly in PostgreSQL.
19. **Copyright license** — The repository states that Bors-NG is Apache License 2.0 and expects the license text in `LICENSE-APACHE`. It links to the canonical license text if that file is missing.
20. **Flow example of Bors-NG** — The flow document traces an approval comment through GitHub's webhook and a Batcher process to staging, CI status, and eventual merge. It describes this as a GitHub-API-driven process that can also be understood as clone, merge, and force-push operations.
21. **PR creation** — A developer opens a PR, normal CI and review occur, and an approver comments `bors r+` after agreement. This comment is the trigger that moves the reviewed proposal into bors's processing flow.
22. **Comments web hook** — GitHub delivers comment events to bors, which extracts the command and notifies the Batcher worker. A registry reuses an existing worker thread or creates one if no work is running or its prior thread crashed.
23. **Batcher** — With an empty queue, the Batcher waits for a configurable delay, then asks GitHub to create a merge commit for the queued PR commits and force-pushes it to staging, replacing prior staging contents. It waits for CI on that staging revision before deciding what to do next.
24. **CI** — CI observes staging and reports completion through GitHub's Status API, allowing multiple CI providers to integrate without bors-specific rules. Projects may choose a different test suite for staging than for individual PRs.
25. **Merge to master** — The Batcher learns status from webhooks or polling because webhook delivery can fail without retry. On success it merges the staged commit and closes the PR, then terminates its thread when the backlog is empty.
## What it means for Concord v3
Bors's staged merge commits and fast-forward of the tested tree agree with the v3 context's server-side landing and Git-backed forge direction: the landed revision can be the exact revision that passed validation. Its explicit queue, batching, bisection, CI status, webhook recovery by polling, and worker lifecycle offer concrete operational questions for v3's ready set and run/swarms; Concord's context describes issues and direct server-side landing rather than GitHub PR approvals or bors's staging branch, so these mechanisms should not be assumed to map one-to-one. The source relies on GitHub App permissions, external CI, PostgreSQL, Elixir processes, and stored worker state, while the v3 context names one TypeScript/Bun server with Git and SQLite and a one-way GitHub mirror; the integration boundary and crash-recovery behavior differ. The v3 draft itself was not read, as required by the capacity rule.

# git-merge-tree
URL: https://git-scm.com/docs/git-merge-tree
Fetched: 2026-10-15 20:31:17 UTC; method: `curl -L --fail --silent --show-error https://git-scm.com/docs/git-merge-tree -o "$DELEGATE_SCRATCH_DIR/sources/git-merge-tree.html"`
Raw SHA-256: `adf08ccb2582d2a43eb591e57f0593b7b407175ebb19f01c706ee4ac0b650e52`
Extracted words: 1842 (`wc -w "$DELEGATE_SCRATCH_DIR/sources/git-merge-tree.txt"`); text extracted from the page's `#main` content with Python `html.parser`, omitting markup and navigation.
Read status: read in full
## Sections
1. **NAME** — `git merge-tree` performs a merge without changing the index or working tree. It reports a tree object for the proposed result.
2. **SYNOPSIS** — The modern form merges two branch arguments, optionally with options; the older form takes a base tree and two branches. The latter is explicitly deprecated.
3. **DESCRIPTION** — The modern mode uses real merge behavior, including content merging, rename detection, directory/file conflict handling, and consolidation of multiple merge ancestors. It writes a top-level tree object but does not create commits or touch the caller's working tree or index.
4. **OPTIONS** — `--stdin` batches text-described merges and implies NUL delimiters; `-z` changes filename and message framing, and `--name-only` simplifies conflict paths. Message controls and `--quiet` tune output, unrelated histories can be allowed, a single merge base can be supplied with a limitation for multiple bases, and strategy options are forwarded.
5. **OUTPUT** — A clean merge returns a tree OID; conflicts add structured conflicted-file information and informational messages. With `--stdin`, each merge is preceded by a status and terminated by NUL, with the output sections repeating per input line.
6. **Merge status** — In stdin mode the status is an integer followed by NUL: zero means conflicts and one means clean. This convention differs from the process exit status for a single merge.
7. **OID of toplevel tree** — The OID identifies the tree that represents the proposed checkout, including conflict-marker content when conflicts exist. This field is always newline or NUL terminated according to framing mode.
8. **Conflicted file info** — Conflict records describe mode, object, stage, and path, or only paths under `--name-only`; `-z` makes filenames unquoted and NUL-delimited. This is structured path/stage evidence, not a complete semantic description of logical conflicts.
9. **Informational messages** — NUL mode emits typed records with affected paths and conflict descriptions, though message strings may evolve; ordinary mode emits human-readable free-form text that should not be parsed. Auto-merge messages can mention paths without conflicts, and the relationship between paths and logical conflicts is not one-to-one.
10. **EXIT STATUS** — A single clean merge exits zero, a conflicted merge exits one, and operational errors use another nonzero status with unspecified output. In stdin mode both clean and conflicted requests exit zero if all requested merges complete; errors still use another status.
11. **USAGE NOTES** — This is plumbing intended to compose with commands such as `commit-tree` and `update-ref`: create a candidate tree, create a commit with parents, then update a ref. The output also exposes the proposed tree, index stages, and messages that a normal merge would produce.
12. **INPUT FORMAT** — Each stdin line names two branches, optionally preceded by a base commit and `--`. The format supports a merge-base per request line.
13. **MISTAKES TO AVOID** — Determine conflict status from exit/status fields and structured output, not by scanning trees or treating an empty path list as clean. Do not infer logical conflict classes or path associations from stage tuples alone; preserve the produced top-level tree's conflict markers rather than re-merging stage OIDs and losing context.
14. **DEPRECATED DESCRIPTION** — The old trivial mode accepts three tree-ish values and emits a semi-diff that omits entries matching the first branch. It cannot perform full content/rename/directory conflict handling and has an awkward output format, making it generally less useful and potentially slower.
15. **GIT** — The page identifies the command as part of the Git suite. No further behavior is specified in this footer.
## What it means for Concord v3
The documented composition of `merge-tree`, `commit-tree`, and `update-ref` directly agrees with the v3 context's Git-backed server-side landing: a candidate tree can be created without mutating a checkout, committed with explicit parents, then made reachable through a ref update. Concord's ready set and landing flow would need to preserve clean/conflicted/error distinctions and retain the tree and diagnostics for conflict resolution; parsing free-form messages or inferring conflict semantics from stage tuples would violate the manual's cautions. The `--stdin` framing and status inversion are protocol details to account for if Concord batches merges. The v3 draft itself was not read, as required by the capacity rule.

# git-update-ref
URL: https://git-scm.com/docs/git-update-ref
Fetched: 2026-10-15 20:32:09 UTC; method: `curl -L --fail --silent --show-error https://git-scm.com/docs/git-update-ref -o "$DELEGATE_SCRATCH_DIR/sources/git-update-ref.html"`
Raw SHA-256: `9a5c3a1f02f41174b6f3cd6a976cf3af1b21dda9d00186a9ca42e34270113241`
Extracted words: 1147 (`wc -w "$DELEGATE_SCRATCH_DIR/sources/git-update-ref.txt"`); text extracted from the page's `#main` content with Python `html.parser`, omitting markup and navigation.
Read status: read in full
## Sections
1. **NAME** — `git update-ref` safely changes the object name stored in a ref. Its safety comes from optional expected-old-value checks and reference locking.
2. **SYNOPSIS** — The command supports create/update and delete forms, optional reflog messages, no-dereference mode, and a stdin command language with NUL and batch-update variants. The stdin interface can include symbolic-ref operations.
3. **DESCRIPTION** — Direct updates may follow symbolic refs; supplying an old OID makes the update conditional, while zero or empty values assert nonexistence. Delete can also be conditional, and `--no-deref` acts on the named ref itself; stdin transactions can mix normal and symbolic refs, validate, and commit a coordinated set of changes.
4. **LOGGING UPDATES** — When configured or an existing log calls for it, updates append old/new OIDs, committer identity, and optionally a message to a reflog. An update fails without changing the ref if logging cannot be written or committer identity is unavailable.
5. **NOTES** — Filesystem symbolic-link refs are deprecated; symbolic refs are the supported abstraction. The command follows real filesystem symlinks only for paths starting with `refs/`, while other symlinks may be replaced with regular files.
6. **SEE ALSO** — The page points to `git-symbolic-ref` for related symbolic-ref operations. This is a cross-reference rather than an additional behavior specification.
7. **GIT** — The footer identifies `update-ref` as part of the Git suite. No additional command semantics are provided there.
## What it means for Concord v3
Conditional updates and stdin transactions agree with the v3 context's server-side Git landing: Concord can guard a ref move against its observed prior head and commit several ref operations as one prepared operation. The manual says all refs must be lockable with matching old OIDs before modifications proceed, but concurrent readers may still observe only a subset of multiple updates, so the service must not claim reader-visible multi-ref atomicity. Reflogs provide useful audit history but can make updates fail if identity or storage is missing; this is a concrete operational concern for the v3 Git + SQLite server design. The v3 draft itself was not read, as required by the capacity rule.

# git-commit-tree
URL: https://git-scm.com/docs/git-commit-tree
Fetched: 2026-10-15 20:32:23 UTC; method: `curl -L --fail --silent --show-error https://git-scm.com/docs/git-commit-tree -o "$DELEGATE_SCRATCH_DIR/sources/git-commit-tree.html"`
Raw SHA-256: `45c48a849467b8ebd89061b8d33e8ba1adaab3b744a732ec2a890c45e9812408`
Extracted words: 1021 (`wc -w "$DELEGATE_SCRATCH_DIR/sources/git-commit-tree.txt"`); text extracted from the page's `#main` content with Python `html.parser`, omitting markup and navigation.
Read status: read in full
## Sections
1. **NAME** — `git commit-tree` creates a commit object. It is a low-level command rather than the usual end-user commit interface.
2. **SYNOPSIS** — The command takes a tree and any number of parent options, with message text supplied via `-m`, `-F`, or standard input, and optionally signs the commit. The parent list encodes whether the commit is a root, ordinary commit, or merge.
3. **DESCRIPTION** — It writes a commit object based on an existing tree and prints its OID; repeated message options are assembled in argument order. A commit binds a tree state in time and carries zero or more parents, while updating HEAD/ref state is a separate operation.
4. **OPTIONS** — The tree must already exist; each `-p` adds a parent, and each `-m` or `-F` contributes a separate paragraph. `-F -` reads stdin, and GPG signing can be selected, disabled, or assigned a key.
5. **Commit Information** — A commit records parent OIDs, author name/email/date, committer name/email/time, and a message. Without message input or options, the command waits for input terminated by EOF.
6. **DATE FORMATS** — Author and committer dates can be provided in Git's epoch-plus-offset form, RFC 2822, or ISO 8601, with several additional date-only formats accepted. Prefixing small raw timestamps with `@` avoids ambiguity.
7. **Note** — Git treats blob contents as uninterpreted bytes and has specific path and message encoding conventions; UTF-8 is encouraged but not forced. Non-UTF-8 commit messages may trigger warnings unless configured, and encoding headers guide later display conversion; conversion is not done at commit creation because it may be irreversible.
8. **Discussion** — Git's core largely avoids encoding translation, while paths are expected in UTF-8 normalization form C and many tools assume UTF-8. Legacy-encoded paths or messages can work at core level but may fail across platforms or in tools, so encoding is a compatibility consideration.
9. **FILES** — `/etc/mailname` is listed as a relevant file. The page does not explain further how it affects commit creation.
10. **SEE ALSO** — `git-write-tree` and porcelain `git-commit` are cited as related commands. The first supplies tree-level context and the second is the higher-level alternative.
11. **GIT** — The footer identifies `commit-tree` as part of the Git suite. It adds no further semantics.
## What it means for Concord v3
The low-level contract agrees with v3's Git-backed server-side landing: Concord can form a tree, create a commit with explicit parentage and message, and then separately move a ref, matching the source workflow documented by `merge-tree`. This separation helps make candidate object construction distinct from publication, while the metadata fields mean server identity, timestamps, encoding, and signing policy affect the resulting commit and need deliberate v3 handling. The page's encoding discussion also cautions against assuming arbitrary agent-provided messages are UTF-8 even though that is the recommended convention. The v3 draft itself was not read, as required by the capacity rule.

# git-http-backend
URL: https://git-scm.com/docs/git-http-backend
Fetched: 2026-10-15 20:32:42 UTC; method: `curl -L --fail --silent --show-error https://git-scm.com/docs/git-http-backend -o "$DELEGATE_SCRATCH_DIR/sources/git-http-backend.html"`
Raw SHA-256: `3799dc02a8a87dab8c52f9b8d5c3a5d5b91b63a74c4e885c9ecd10e1cebabbf9`
Extracted words: 1307 (`wc -w "$DELEGATE_SCRATCH_DIR/sources/git-http-backend.txt"`); text extracted from the page's `#main` content with Python `html.parser`, omitting markup and navigation.
Read status: read in full
## Sections
1. **NAME** — `git-http-backend` is the server-side implementation of Git over HTTP. It is invoked as a CGI program.
2. **SYNOPSIS** — The documented invocation is simply `git http-backend`. The web server supplies its CGI environment and routes requests to it.
3. **DESCRIPTION** — The backend serves fetch and clone through smart or dumb HTTP and pushes through smart HTTP, including protocol v2 when configured. It normally requires an export marker unless explicitly overridden, enables upload-pack by default, and only enables receive-pack by default for authenticated clients.
4. **SERVICES** — Repository config independently controls legacy arbitrary-file reads, upload-pack, receive-pack, and protocol-v2 archive service. Arbitrary-file access can expose unreachable objects, while receive-pack can be disabled or deliberately opened to anonymous users.
5. **URL TRANSLATION** — The repository path is resolved by combining web-server `PATH_INFO` with configured `GIT_PROJECT_ROOT`, or by using `PATH_TRANSLATED` when no project root is set. Correct web-server path configuration therefore determines which repository is served.
6. **EXAMPLES** — The examples map URL paths to on-disk repositories, configure Apache/Lighttpd CGI routing, and show distinct rules for anonymous reads with authenticated writes versus fully private repositories. They also demonstrate Gitweb routing, namespaces, and a static-file acceleration pattern.
7. **Apache 2.x** — Apache setup enables CGI, alias, and environment modules, selects the repository root, and routes Git paths to the backend; Git-Protocol may need explicit forwarding. The access-control example protects both receive-pack advertisement and execution for immediate authorization, while a narrower receive-pack-only rule delays auth until push negotiation and requires receive-pack to be enabled for those repos.
8. **Accelerated static Apache 2.x** — Apache can directly serve object and pack files from disk while routing protocol endpoints to the CGI, reducing overhead for static repository data. The example can be combined with Gitweb routing.
9. **Lighttpd** — The example configures CGI and repository roots, then applies authentication to receive-pack query and path requests for read-anonymous/write-authenticated access. A path rule can instead require authentication for both reads and writes.
10. **ENVIRONMENT** — CGI variables such as path, user, address, content type, query, and method are supplied by the invoking server; export and request-buffer variables alter repository access and negotiation limits. Git-Protocol must reach `GIT_PROTOCOL` for capability negotiation, and the backend sets committer identity from remote user/address so receive-pack reflogs can identify the pusher; hooks also receive CGI environment variables.
11. **GIT** — The footer identifies the command as part of the Git suite. No additional backend behavior is defined there.
## What it means for Concord v3
This source describes a conventional CGI Git transport whose fetch/push services are gated by export markers, per-repository configuration, authentication, and web-server URL mapping. The v3 context instead specifies one-way GitHub mirroring and direct server-side landing; the HTTP backend is therefore a possible compatibility boundary, not evidence that v3 should expose generic client pushes. If Git HTTP access is offered, its distinction between authenticated reads and writes, export scope, unreachable-object exposure, protocol header forwarding, and pusher identity in reflogs are concrete security and audit requirements. The v3 draft itself was not read, as required by the capacity rule.

## Source status

| URL | Extracted words | Read status |
| --- | ---: | --- |
| https://github.com/bors-ng/bors-ng (README.md and FLOW_EXAMPLE.md) | 3548 | read in full |
| https://git-scm.com/docs/git-merge-tree | 1842 | read in full |
| https://git-scm.com/docs/git-update-ref | 1147 | read in full |
| https://git-scm.com/docs/git-commit-tree | 1021 | read in full |
| https://git-scm.com/docs/git-http-backend | 1307 | read in full |
