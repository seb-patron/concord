# Source notes: locks and concurrency control for agent swarms

Research run: 2026-10-15. Source copies and extracted text were kept in `$DELEGATE_SCRATCH_DIR` only. HTML word counts use the text extraction command stated per note followed by `wc -w < extracted-file`; Markdown/code counts use `wc -w < fetched-file`; the paper count uses `wc -w < kung-robinson.txt`. Hashes are SHA-256 of fetched bytes (PDF hash is of the PDF, not extracted text). Source status is deliberately conservative: only a source read from beginning through its end is marked read in full.

# Scaling long-running autonomous coding — Cursor
URL: https://cursor.com/blog/scaling-agents
Fetched: 2026-10-15 20:02 UTC; method: `curl -L --fail --silent --show-error https://cursor.com/blog/scaling-agents -o "$DELEGATE_SCRATCH_DIR/cursor.html"`
Raw SHA-256: cdd13f17698952b094dcfbe0112a34c4748c4396e2ca314e207da6bbb69a94d7
Extracted words: 2644 (`wc -w "$DELEGATE_SCRATCH_DIR/cursor-clean.txt"`; HTML text extracted by Python `re`/`html` stdlib)
Read status: read in full
## Sections
1. **The limits of a single agent** — Focused tasks suit individual agents; parallel agents look attractive for larger projects, but the correct work split is uncertain up front. Cursor first tried dynamic self-coordination, so this section motivates coordination as a problem rather than a locking prescription.
2. **Learning to coordinate** — Agents shared a coordination file to inspect work, claim a task, and update status; a locking mechanism prevented duplicate task grabs. Locks were held too long or forgotten, were bypassed or acquired redundantly, and even when used correctly reduced twenty agents to throughput like two or three because of waiting. The lock was on a task/coordination record, not source files; that distinction is essential to the evidence. Optimistic state writes simplified the mechanism, but removing hierarchy left agents risk-averse and caused churn on easy work.
3. **Planners and workers** — Cursor separated ongoing, recursive planners from workers focused on one assigned task, then used a judge to decide whether to continue a cycle. Workers did not coordinate with each other or own the system-wide view; role separation solved most of the earlier coordination trouble. This suggests avoidable task contention should be addressed by decomposition and dispatch, not by making every source edit exclusive.
4. **Running for weeks** — The described browser effort produced over a million lines across a thousand files, with hundreds of workers pushing to one branch with few conflicts; other long-running migrations/products also made substantial changes. This is evidence that many agents can coexist on shared refs when the workflow absorbs merges, not evidence that every file should be locked. Cursor acknowledges careful review and early checks in these examples.
5. **What we've learned** — Removing an integrator role reduced bottlenecks; workers could resolve conflicts. The authors place the right structure between too little (conflicts, duplicate work, drift) and too much (fragility), while emphasizing role-appropriate models and prompts. These are coordination lessons, not controlled comparisons of file-lock algorithms.
6. **What's next** — The system still needs planners to wake on task completion, limits on overlong agents, and periodic fresh starts. Cursor characterizes the result as promising but not optimal, so the throughput results should not be treated as a general guarantee.
## What it means for Concord v3
Correct Section 9's attribution: the reported harmful locks guarded tasks in a shared coordination file and were agent-managed/conventional. It does not establish that server-enforced short-lived claims on files or symbols hurt. Keep task scheduling and source-unit claims separate; use issue readiness/dispatch to avoid duplicate task work and use optimistic landing for mergeable edits. The reported low-conflict common-branch work supports measuring merge-and-repair rather than assuming locks are required for every edit.

# Redesigning source control at Anthropic — Scion
URL: https://www.anthropic.com/engineering/redesigning-source-control
Fetched: 2026-10-15 20:02 UTC; method: `curl -L --fail --silent --show-error https://www.anthropic.com/engineering/redesigning-source-control -o "$DELEGATE_SCRATCH_DIR/anthropic.html"`
Raw SHA-256: 7df9a1b0d3cb2eda4b1037de191f7657c1b13f2622d084513036f85a6ab3d8a1
Extracted words: 4073 (`wc -w "$DELEGATE_SCRATCH_DIR/anthropic-clean.txt"`; HTML text extracted by Python `re`/`html` stdlib)
Read status: read in full
## Sections
1. **Redesigning source control at Anthropic** — Anthropic reports merge volume increasing from about 2,500/day in May 2026 to over 30,000/day in September, leading to its Scion server and related review/search/permissions systems. This is a high-scale first-party operational account, not a controlled lock comparison.
2. **Growing our monorepo** — Git's complete-clone/offline strengths became costly for a very large, always-online agent workload; mirrors and seeds helped temporarily but became harder to operate. The pressure is repository data distribution and checkout scale, not a finding that file locks are harmful.
3. **Principles for agent-scale source control** — Scion assumes online clients, server-side operations, API access, horizontal scaling, cheap incremental commits, and sparse/virtual checkouts. Its commits are described as lock-free, with refs minimized because shared global ref state is expensive to coordinate. This concerns server/repository coordination, not a recommendation to permit conflicting writes to a non-mergeable asset.
4. **How Scion works** — A changeset records changed files and immutable blob pointers; derived data supports history/blame. The architecture permits high-throughput changesets without packfiles, locking, cross-server coordination, or refs moving on every write.
5. **Data structures** — Changesets record changed paths and immutable blobs; derived data supports history/search while avoiding unneeded materialization. This reduces coordination but does not make a mutable binary file mergeable.
6. **Scaling Scion** — Immutable content-addressed objects and tiered caches distribute work; sparse demand and cached reads cut infrastructure and checkout time. The account attributes efficiency to data/API architecture rather than exclusive source-file claims.
7. **What we learned building Scion** — Engineers supplied design judgment and constraints while agents produced code; they used testing, fuzzing, rate limits, and review. Anthropic could not effectively operate a global repository merge-queue lock, so it invested in pre-deploy/post-merge testing; concurrent changes can conflict and agents can often repair them. This is evidence against repo-wide exclusion at that scale, not against narrow protection for an unmergeable asset.
8. **Contributing to the wider ecosystem** — Scion is specialized for very large agent-heavy monorepos and is not presented as a general Git replacement. The authors suggest applying individual ideas to Git platforms.
9. **Acknowledgements** — Credits the source-control team and contributors. It adds no concurrency result.
10. **Footnotes** — Explains changeset parent conventions and identifies Sapling/Mononoke as prior art. It adds no locking experiment.
## What it means for Concord v3
Section 9 should distinguish a repo-wide merge-order lock (which Anthropic could not operate effectively) from server-enforced claims on individual units. At v3's likely initial scale, retain the simple sequential land queue and concurrency-aware conflict repair, while instrumenting its wait cost; do not infer Scion's architecture or merge-queue result as proof that exclusive protection for unmergeable files is harmful.

# On Optimistic Methods for Concurrency Control — Kung and Robinson
URL: https://db.cs.cmu.edu/papers/1981/kung-tods1981.pdf
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --fail --silent --show-error https://db.cs.cmu.edu/papers/1981/kung-tods1981.pdf -o "$DELEGATE_SCRATCH_DIR/kung-robinson.pdf"`; extracted with `pypdf.PdfReader` in a temporary virtualenv
Raw SHA-256: 5bd2f2e7b2356de972e7e6bd19ebc229568dd7968bc01acc3583038003ce364e
Extracted words: 6552 (`wc -w "$DELEGATE_SCRATCH_DIR/kung-robinson.txt"`)
Read status: read in full
## Sections
1. **1. INTRODUCTION** — Locking adds overhead, can lower concurrency around congested objects or slow storage, and holds locks through a transaction to permit abort. Optimism instead permits reads, stages writes privately, validates, then commits or backs up; it works best when conflicts are rare and the data footprint is large relative to active transactions. The authors warn that starvation remains possible and propose a lock-like critical section as a starvation escape.
2. **2. THE READ AND WRITE PHASES** — Transactions track read/write/create/delete sets, copy modified objects during the read phase, and publish those copies only after validation. This relies on structural assumptions about reachability and atomic object-name exchange; it is not simply “let everyone write and hope.”
3. **3. THE VALIDATION PHASE** — Correctness is serial equivalence. Validation checks whether concurrent read/write sets can be ordered safely; failed validation aborts and retries. The paper explicitly identifies finite history, long transactions, repeated failures, and starvation as practical issues requiring policy.
4. **3.1 Validation of Serial Equivalence** — Three sufficient ordering cases use transaction numbers and non-intersection of read/write sets. The granularity and correctness of the tracked objects determine whether the conflict test is meaningful.
5. **3.2 Assigning Transaction Numbers** — Assigning transaction numbers at read completion can avoid unnecessary waiting, but validation may require write sets from older active transactions. The protocol trades coordination placement against how much transaction history must be retained.
6. **3.3 Some Practical Considerations** — If old write sets have been discarded, validation fails and work restarts; repeated validation failures can starve, for which the paper suggests running a starver through a critical section. Optimism therefore shifts costs to validation, backup, and retry; it does not eliminate them.
7. **4. SERIAL VALIDATION** — A simple implementation serializes final validation/write but can move preliminary checks outside the critical section. Queries can avoid write-phase numbering and often validate trivially in query-dominant workloads.
8. **5. PARALLEL VALIDATION** — More parallel validation increases concurrency but introduces active transaction tracking and can cause aborts due to transactions that themselves later fail. Multi-stage validation can reduce the expensive critical region.
9. **6. ANALYSIS OF AN APPLICATION** — B-tree insertions have small read/write sets, and the authors estimate rare conflicts under explicit assumptions about depth, occupancy, and access paths. Their worked bound is an analytical model, not a broad empirical guarantee for coding agents.
10. **7. CONCLUSIONS** — The paper frames locking and backup as complementary: lock-based systems wait; optimistic systems retry; deadlock and starvation are opposing failure modes. It calls for a generalized control that adapts to conflict likelihood and the “right amount” of locking versus backup.
11. **REFERENCES** — Establishes the prior work behind serial equivalence, B-tree locking, and concurrency protocols; no additional result is claimed here.
## What it means for Concord v3
Use optimism where edits are mergeable, mostly disjoint, and cheaply validated/retried. Claims are not a correctness substitute: the land path must still validate the base, detect conflicts, and preserve/retry the work. For high-conflict or expensive-to-reconstruct units, exclusion may reduce expected wasted work. Measure retries, queue time, and repair cost so the system can learn whether optimistic or exclusive treatment wins per unit class.

# Git LFS File Locking API
URL: https://github.com/git-lfs/git-lfs/blob/main/docs/api/locking.md
Fetched: 2026-10-15 20:03 UTC; method: `git clone --depth 1 https://github.com/git-lfs/git-lfs.git "$DELEGATE_SCRATCH_DIR/git-lfs"`
Raw SHA-256: 6582abda1c171aae9f0516f348fe51c4b7b8314635c6c7c959d2de5e7a283cb7
Extracted words: 2046 (`wc -w "$DELEGATE_SCRATCH_DIR/git-lfs/docs/api/locking.md"`)
Read status: read in full
## Sections
1. **Git LFS File Locking API** — Defines create, list, verify, and delete operations, with server URLs, authentication, and single-branch scope. The API is explicitly an initial, simple design rather than a general multi-branch locking model.
2. **Create Lock** — The server grants an exclusive path lock only to a user with push access and rejects an existing lock with conflict details. A lock records path, owner, ID, time, and optional ref context.
3. **Successful Response** — Returns stable lock identity and ownership metadata to support clients.
4. **Bad Response: Lock Exists** — A collision is an explicit 409 containing the existing lock, enabling a client to explain contention instead of silently overwriting.
5. **Unauthorized Response** — Creation requires write permission; enforcement is server-side.
6. **Error Response** — Defines structured server errors, separate from contention.
7. **List Locks** — Authorized readers can query active locks with path/id/ref filters and cursors/limits. Pagination makes the service usable beyond a small lock set.
8. **Successful Response** — Returns an empty list when there are no locks and a cursor when more remain.
9. **Unauthorized Response** — Listing requires pull permission.
10. **Error Response** — Listing failures are explicit and distinct from an empty lock set.
11. **List Locks for Verification** — Push-time verification separates the caller's locks from others' locks and is tied to the attempted ref. A push touching another user's locked path halts; a caller's own matching lock is reported so it can be released after the push.
12. **Successful Response** — Returns `ours`, `theirs`, and pagination metadata, making enforcement decidable before accepting the push.
13. **Not Found Response** — A server without locking support returns 404, which does not halt a push; locking is an optional server capability.
14. **Unauthorized Response** — Verification requires push permission.
15. **Error Response** — Verification errors are explicit.
16. **Delete Lock** — The owner can unlock by ID; force is an explicit capability to remove another user's lock. Servers require write permission and normally disallow deleting someone else's lock.
17. **Successful Response** — Returns the deleted lock record.
18. **Unauthorized Response** — Non-owner unlock requires force, making override an auditable/intentional control rather than accidental behavior.
19. **Error response** — Unlock failures remain explicit.
## What it means for Concord v3
LFS locks protect a whole file path at push time, are enforced by a server, and are not leases with expiry. They help where concurrent update would be unsafe, but stale ownership can persist until explicit unlock or force. Concord should preserve server enforcement and visible owner/intent, while improving recovery with expiry/renewal and force-release audit.

# git-lfs-lock(1)
URL: https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-lock.adoc
Fetched: 2026-10-15 20:03 UTC; method: `git clone --depth 1 https://github.com/git-lfs/git-lfs.git "$DELEGATE_SCRATCH_DIR/git-lfs"`
Raw SHA-256: 795e8a6d0d5cf19c1145f51b99ee97d9455871c9ad93e2b03119aaad514ed627
Extracted words: 161 (`wc -w "$DELEGATE_SCRATCH_DIR/git-lfs/docs/man/git-lfs-lock.adoc"`)
Read status: read in full
## Sections
1. **NAME** — The command sets a file lock on the LFS server.
2. **SYNOPSIS** — Accepts a path and optional flags.
3. **DESCRIPTION** — The path must exist in the working copy; the lock intends to block other users from updating it, with enforcement performed by push verification.
4. **OPTIONS** — Supports remote selection and JSON output for tooling.
5. **SEE ALSO** — Links lock/unlock/list commands.
## What it means for Concord v3
This is explicit path-level protection whose useful effect depends on downstream server verification. A local “claim” display without rejecting conflicting writes would be a different, advisory mechanism.

# git-lfs-locks(1)
URL: https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-locks.adoc
Fetched: 2026-10-15 20:03 UTC; method: `git clone --depth 1 https://github.com/git-lfs/git-lfs.git "$DELEGATE_SCRATCH_DIR/git-lfs"`
Raw SHA-256: d0a0e9dd655827501c7b3b96ba6a24c79769d21d672d24df324584820a654bae
Extracted words: 288 (`wc -w "$DELEGATE_SCRATCH_DIR/git-lfs/docs/man/git-lfs-locks.adoc"`)
Read status: read in full
## Sections
1. **NAME** — Lists files currently locked on the LFS server.
2. **SYNOPSIS** — Offers filters and options.
3. **DESCRIPTION** — Lists active locks.
4. **OPTIONS** — Can filter by ID/path, limit results, emit JSON, and distinguish locally cached locks from verified server ownership. Cached data may be stale while offline; verification can reveal missing or broken locks.
5. **SEE ALSO** — Links creation and unlock commands.
## What it means for Concord v3
Presence is useful operational information only when freshness is clear. Concord should label server claim state and expiry, and never let a stale local view count as authoritative ownership.

# git-lfs-unlock(1)
URL: https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-unlock.adoc
Fetched: 2026-10-15 20:03 UTC; method: `git clone --depth 1 https://github.com/git-lfs/git-lfs.git "$DELEGATE_SCRATCH_DIR/git-lfs"`
Raw SHA-256: d99c13687a554265b0c4464046136a078f55361021fc66ac09e34389fde42527
Extracted words: 157 (`wc -w "$DELEGATE_SCRATCH_DIR/git-lfs/docs/man/git-lfs-unlock.adoc"`)
Read status: read in full
## Sections
1. **NAME** — Removes a file's lock from the server.
2. **SYNOPSIS** — Unlocks by path or ID.
3. **DESCRIPTION** — The file must exist and have a clean Git status unless forced; force bypasses those checks.
4. **OPTIONS** — Provides remote, force, ID, and JSON options.
5. **SEE ALSO** — Links lock and list commands.
## What it means for Concord v3
Unlocking is a distinct lifecycle action and can be blocked by local dirt or require force. Concord should instead make claim release safe at task end and let the server revoke stale leases under owner controls.

# Git LFS File-Locking wiki
URL: https://github.com/git-lfs/git-lfs/wiki/File-Locking
Fetched: 2026-10-15 20:03 UTC; method: `curl -L --fail --silent --show-error https://github.com/git-lfs/git-lfs/wiki/File-Locking -o "$DELEGATE_SCRATCH_DIR/lfs-wiki.html"`
Raw SHA-256: df9814f713cec6a3f4f3d9877211479fb4acdd11b6a817eb8caf1d99e724ec81
Extracted words: 927 (`wc -w "$DELEGATE_SCRATCH_DIR/lfs-wiki-clean.txt"`; HTML text extracted by Python `re`/`html` stdlib)
Read status: read in full
## Sections
1. **File Locking** — Git LFS says concurrent edits to large binary files can make merge conflicts very difficult. Lockable patterns make such files read-only locally until a user takes a server lock; push verification blocks updates locked by someone else, but unsupported servers cannot enforce it.
2. **Tracking Lockable files** — `git lfs track --lockable` records patterns in `.gitattributes`; lockability can also be used without LFS. This selects the files that incur lock overhead.
3. **Managing Locked Files** — Users lock before editing, list ownership, and unlock by path/ID; force can remove another user's lock, subject to server permissions.
4. **Pushing Your Changes** — LFS verifies that the pusher is not modifying someone else's locked file. Since API support is optional, an unverifiable push may continue with a warning rather than fail.
## What it means for Concord v3
The distinction is a server-enforced file lock versus an agent-managed coordination-file lock. File locks protect non-mergeable content; server support and operational recovery matter. The mechanism is not evidence that lock every source file is good.

# Perforce `p4 lock`
URL: https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_lock.html
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --fail --silent --show-error https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_lock.html -o "$DELEGATE_SCRATCH_DIR/p4-lock.html"`
Raw SHA-256: 84b97baab06303fbc59a1a2e2c4025fe691f5ec6c8bdccfe30003af77d7a6563
Extracted words: 295 (`wc -w "$DELEGATE_SCRATCH_DIR/p4-lock-clean.txt"`; HTML text extracted by Python `re`/`html` stdlib)
Read status: read in full
## Sections
1. **p4 lock** — Locks opened files against other users submitting changes; locking a file already locked by another user fails. The lock is released when its owner submits; an edge/commit architecture can request local and global locks.
2. **Syntax and naming conventions** — Supports a specified file or all open files in the default changelist.
3. **Description** — A lock prevents competing submit, not the user's local editing; this is server-side enforcement.
4. **Options** — `-c` scopes to a changelist; `-g` obtains local and global locks in commit-edge architecture.
5. **Usage notes** — Requires write access and has no revision-range argument.
6. **Related commands** — `p4 unlock` releases; `p4 opened` shows the caller's locked files.
## What it means for Concord v3
Perforce confirms value in explicit, server-controlled exclusion but ties the operation to a particular edit/changelist. Concord claims should be task/session scoped with expiry and release on submit, rather than a permanent repo reservation.

# Perforce `p4 typemap`
URL: https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_typemap.html
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --fail --silent --show-error https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_typemap.html -o "$DELEGATE_SCRATCH_DIR/p4-typemap.html"`
Raw SHA-256: 33e36c0447a4dec0102c6262aeecdc6d1748fabdbed9bd13eda7cb6f826ae168
Extracted words: 1097 (`wc -w "$DELEGATE_SCRATCH_DIR/p4-typemap-clean.txt"`; HTML text extracted by Python `re`/`html` stdlib)
Read status: read in full
## Sections
1. **p4 typemap** — Maps depot path patterns to file types; it is administrator policy, not an agent preference.
2. **Syntax and naming conventions** — The form can be read, emitted, or updated from standard input.
3. **Description** — Mappings override automatic type detection for files added after the rule exists; users may still override with explicit type options.
4. **Default behavior to determine file type** — The server detects text/binary from file bytes, which can misclassify edge cases such as PDFs/RTF.
5. **Override the default typemap** — Explicit add/edit/reopen file type can supersede policy.
6. **Form fields** — TypeMap pairs a file type/modifier with a depot path pattern; exclusions and later-rule precedence permit precise scope.
7. **Options** — `-i` reads and `-o` emits the mapping; access is administrative except list output.
8. **Usage Notes** — File type modifiers can implement pessimistic locking; the docs also describe exclusions, patterns, and admin access.
9. **Examples** — The examples show extension and directory rules and explicitly describe `+l` as appropriate where only one person edits at a time.
10. **Related commands** — `p4 add -t` and `p4 reopen -t` set explicit types.
## What it means for Concord v3
Use repository policy to choose which unit classes are exclusive, rather than inferring that all files need the same mode. Keep the owner able to edit patterns and inspect resulting claims.

# Perforce file type modifiers
URL: https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/file.types.synopsis.modifiers.html
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --fail --silent --show-error 'https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/file.types.synopsis.modifiers.html?Highlight=exclusive+lock' -o "$DELEGATE_SCRATCH_DIR/p4-filetypes.html"`
Raw SHA-256: 3fbff2369b5b99c5ae30185573a962a2e0002fe097fafe71b73a054e6b1ebddf
Extracted words: 720 (`wc -w "$DELEGATE_SCRATCH_DIR/p4-filetypes-clean.txt"`; HTML text extracted by Python `re`/`html` stdlib)
Read status: read in full
## Sections
1. **File type modifiers** — The `+l` modifier permits one user at a time to open a file for edit and is useful for binary graphics whose changes cannot meaningfully merge. Other modifiers govern writability, keywords, storage, and timestamps.
2. **Overriding the file type with the -t option** — Users can override or change a mapped type during add/edit/reopen, so administrator policy is not absolute unless permissions/workflow constrain that override.
## What it means for Concord v3
This directly supports selective exclusivity for assets with no useful merge, not a general exclusive-by-default policy. Claims on code should remain optimistically mergeable unless data show repeat conflict/rework.

# Unity Version Control: Check out and lock files
URL: https://docs.unity.com/en-us/unity-version-control/gluon/check-out-and-lock
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --fail --silent --show-error https://docs.unity.com/en-us/unity-version-control/gluon/check-out-and-lock -o "$DELEGATE_SCRATCH_DIR/unity-locking.html"`
Raw SHA-256: 5858dbd9af860e3bdfce327610aa239c14d5df93d8211641bfbedffc8e3c9fcc
Extracted words: 432 (`wc -w "$DELEGATE_SCRATCH_DIR/unity-locking-clean.txt"`; HTML text extracted by Python `re`/`html` stdlib)
Read status: read in full
## Sections
1. **Check out and lock files** — Checkout is exclusive only when server lock rules are configured. Users can force “Lock and checkout”; recursive checkout broadens the protected scope. Locking prevents simultaneous edits, while normal checkout may simply record local intent.
2. **Checkout** — A configured rule makes checkout acquire the lock; command-line users have a corresponding partial-checkout command.
3. **Force a lock and checkout** — Explicitly requests a lock when normal policy does not automatically create one.
4. **Check out files recursively** — Allows folder-level lock expansion, which increases contention scope.
## What it means for Concord v3
Unity distinguishes presence/checkout metadata from actual exclusivity and makes lock rules configurable. Concord should likewise avoid treating a presence claim as a write barrier, support per-path policy, and beware directory/prefix claims that unnecessarily encompass independent files.

# Unity Version Control: Lock rules
URL: https://docs.unity.com/en-us/unity-version-control/unity-vcs-organization-settings
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --fail --silent --show-error https://docs.unity.com/en-us/unity-version-control/unity-vcs-organization-settings -o "$DELEGATE_SCRATCH_DIR/unity-rules.html"`
Raw SHA-256: 246e5ab88cf06c43e960735a39c4975e1953d1617f7c91e9edefca7fa91b1a31
Extracted words: 513 (`wc -w "$DELEGATE_SCRATCH_DIR/unity-rules-clean.txt"`; HTML text extracted by Python `re`/`html` stdlib)
Read status: read in full
## Sections
1. **Lock rules** — Exclusive checkout is useful for non-mergeable files such as 3D assets, images, and audio. Organization-level defaults and repository-specific overrides scope which extensions are locked and on which branches; exclusions and deletion are supported.
2. **Organization lock rule** — One organization default can target branches and extensions.
3. **Repository lock rules** — Per-repository rules override organization defaults and permit repository-specific destinations/extensions.
4. **Exclude branches** — Rule scope can omit branches.
5. **Delete lock rules** — Administrators can remove a rule.
## What it means for Concord v3
Selective defaults, repository overrides, and branch scope are good owner controls. Prefer explicit policy on binary/non-mergeable files; leave code optimistic. Make policy changes auditable and visible with the claim mode they produce.

# Unreal Engine: One File Per Actor
URL: https://dev.epicgames.com/documentation/en-us/unreal-engine/one-file-per-actor-in-unreal-engine
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --fail --silent --show-error https://dev.epicgames.com/documentation/en-us/unreal-engine/one-file-per-actor-in-unreal-engine -o "$DELEGATE_SCRATCH_DIR/unreal-ofpa.html"`
Raw SHA-256: 7400c5aef6c001f94bdd3d9dec959e70b851065e1c61fa63761771221d8cdd12
Extracted words: 711 (`wc -w "$DELEGATE_SCRATCH_DIR/unreal-ofpa-clean.txt"`; HTML text extracted by Python `re`/`html` stdlib)
Read status: read in full
## Sections
1. **One File Per Actor** — Earlier, changing actors in one level required checking out the shared level file and blocked teammates. OFPA stores actor instances in external files so edits do not require saving the main level file; actors are embedded again when cooked.
2. **Enabling One File Per Actor** — Enabled by default with World Partition; can be enabled for a non-partitioned world.
3. **Converting Sublevels** — Conversion applies only to the current level; sublevels need conversion too, manually or through a commandlet.
4. **Using OFPA With Source Control** — Encoded external actor names are decoded for changelist review; the editor supports validation because partial submissions can leave dangling references. Content/actor files should be submitted from the editor; changelist support is Perforce-only.
## What it means for Concord v3
Before locking a whole high-contention file, ask whether a structure-aware unit or data split can make independent edits independent. Actor-level units show why file-level contention metrics should be paired with semantic conflict outcomes.

# Unreal Engine: Source control in Unreal Engine
URL: https://dev.epicgames.com/documentation/en-us/unreal-engine/source-control-in-unreal-engine
Fetched: 2026-10-15 20:04 UTC; method: `curl -L --fail --silent --show-error https://dev.epicgames.com/documentation/en-us/unreal-engine/source-control-in-unreal-engine -o "$DELEGATE_SCRATCH_DIR/unreal-source-control.html"`
Raw SHA-256: 2650bd9b2c79b31dbeb937907b14a2a749a3563ed55d344f7924e9e6f73c1b88
Extracted words: 893 (`wc -w "$DELEGATE_SCRATCH_DIR/unreal-source-control-clean.txt"`; HTML text extracted by Python `re`/`html` stdlib)
Read status: read in full
## Sections
1. **Source Control** — Unreal provides editor integration for supported providers, including Perforce and SVN; the integration exposes status and source-control actions.
2. **Activating Source Control** — Connect through editor preferences or the Content Browser.
3. **Activating Source Control via Editor Preferences** — Settings can auto-checkout on modification or prompt users to checkout packages.
4. **Activating Source Control via the Content Browser** — Users connect a provider through asset/folder context actions.
5. **Status Icons** — Asset indicators expose checked-out-by-self/other and revision/add state.
6. **Source Control Actions** — Checkout locks an asset for editing; refresh, history, and diff support inspection.
7. **Checking Out and Checking In** — Explicit checkout/check-in ties edits to a changelist description and exclusive asset ownership.
8. **Content Hot Reloading** — Provider-driven changes can reload content, but the described behavior depends on source-control operations through the editor integration.
9. **Deactivating Source Control** — Disabling it can leave local content out of sync and prevent check-in.
## What it means for Concord v3
Binary-asset locking is a concrete exclusive case. A source-control integration's checkout state is distinct from its merge queue/ref lock; Concord should keep the source unit small and the release action visible.

# Jujutsu conflicts
URL: https://jj-vcs.github.io/jj/latest/conflicts/
Fetched: 2026-10-15 20:03 UTC; method: `curl -L --fail --silent --show-error https://jj-vcs.github.io/jj/latest/conflicts/ -o "$DELEGATE_SCRATCH_DIR/jj-conflicts.html"`
Raw SHA-256: 4b9195fefd12e9d3c47e34ddef950ce23ae334af574a0db903b85e1527f3ef32
Extracted words: 1457 (`wc -w "$DELEGATE_SCRATCH_DIR/jj-conflicts-clean.txt"`; HTML text extracted by Python `re`/`html` stdlib)
Read status: read in full
## Sections
1. **Introduction** — Jujutsu can record unresolved conflicts in commits and let later rebases/merges propagate them. Conflict is durable state, not a failed operation that loses work.
2. **Advantages** — First-class conflicts simplify continuation, auto-rebase, merge-commit representation, postponed resolution, and collaborative repair. The benefit depends on conflict state being shareable and understandable.
3. **Conflict markers** — The working copy materializes a logical conflict as marker sections that show a snapshot and diffs from other sides. Multiple sides can be represented, making parallel edits recoverable but still requiring resolution.
4. **Alternative conflict marker styles** — Snapshot and Git diff3 styles trade the richer multi-sided representation for familiar tooling; Git style falls back for more than two sides.
5. **Long conflict markers** — Marker length is extended when ordinary marker-looking text could be confused with real conflict delimiters.
6. **Conflicts with missing terminating newline** — Jujutsu adjusts terms and the end marker so line-based conflicts remain unambiguous; even text representation has edge cases that need explicit handling.
## What it means for Concord v3
Optimistic collaboration needs explicit conflict records and a repair path, not just a binary “claim failed.” The docs support allowing concurrent edits where conflicts are durable and tractable; they do not claim every binary/semantic conflict is safely mergeable.

# Jujutsu technical concurrency
URL: https://github.com/jj-vcs/jj/blob/main/docs/technical/concurrency.md
Fetched: 2026-10-15 20:03 UTC; method: `curl -L --fail --silent --show-error https://raw.githubusercontent.com/jj-vcs/jj/main/docs/technical/concurrency.md -o "$DELEGATE_SCRATCH_DIR/jj-concurrency.md"`
Raw SHA-256: 7dcac7dda7fdcc900db3c59292bb7a5aba8836eab5741d4cf780535359d5f752
Extracted words: 1186 (`wc -w "$DELEGATE_SCRATCH_DIR/jj-concurrency.md"`)
Read status: read in full
## Sections
1. **Introduction** — Coarse lock files taken at the start of every mutating command block operations that would not conflict; finer/later locks reduce waiting but make validation more complex. Jujutsu accepts concurrent operations and exposes conflicts, while warning that lock-free Git-backend areas have known corruption/untested cases.
2. **Syncing with `rsync`, NFS, Dropbox, etc** — Concurrently synchronized copies can preserve commits and surface bookmark/content conflicts, but the docs note known bugs, incomplete testing, and possible lost bookmark pointers in some colocated Git-backend cases.
3. **Operation log** — Each operation records a consistent view and parent operation; commands can commit from their starting snapshot, after which divergent heads are noticed and merged. This avoids a coarse early lock while keeping concurrent actions discoverable.
4. **Merging divergent operations** — Views merge three-way; conflicting bookmark targets are represented explicitly, and the repository can continue to be used where a particular command does not require the unresolved ref.
5. **Storage** — Content-addressed operations/views are safe to write without locking; a small set of head marker files publishes operation state atomically. Jujutsu still has a tiny shared-head publication mechanism rather than claiming no coordination whatsoever.
## What it means for Concord v3
Keep immutable change construction and disjoint server operations concurrent; serialize only genuinely shared mutable resources. Repository/ref state may need compare-and-swap or queueing, while per-file exclusivity should be a separate, policy-selected mechanism.

# Gas Town README
URL: https://github.com/gastownhall/gastown/blob/main/README.md
Fetched: 2026-10-15 20:03 UTC; method: `curl -L --fail --silent --show-error https://raw.githubusercontent.com/gastownhall/gastown/main/README.md -o "$DELEGATE_SCRATCH_DIR/gastown-readme.md"`
Raw SHA-256: 4ed9c05be3573a5202b85ff232fe698cc2aba857ea6b8f1b943c33c2e685e3b9
Extracted words: 4169 (`wc -w "$DELEGATE_SCRATCH_DIR/gastown-readme.md"`)
Read status: read in full
## Sections
1. **Gas Town** — Presents a multi-agent orchestration system with persistent work tracking in Git-backed hooks. Its stated 20–30-agent scale is a product claim, not a controlled locking benchmark.
2. **Overview** — Describes coordinating agents on different tasks and retaining state across restarts. The focus is orchestration/persistence, not protecting source files.
3. **What Problem Does This Solve?** — Maps context loss and manual coordination to hooks, mailboxes, identities, handoffs, and a Beads ledger. It asserts improved coordination at 20–30 agents but provides no lock/no-lock comparison.
4. **Architecture** — Shows a Mayor, town, rigs, crew, hooks, and polecats over Git worktrees. Task/workspace structure is the primary contention-management mechanism.
5. **Core Concepts** — Defines persistent roles, work items, watchdogs, queues, and scheduling as the vocabulary for orchestration.
6. **The Mayor 🎩** — The primary coordinator has workspace/project/agent context and is the recommended entry point.
7. **Town 🏘️** — The workspace contains projects, agents, and configuration.
8. **Rigs 🏗️** — Project containers wrap repositories and associated agents.
9. **Crew Members 👤** — A person's hands-on workspace within a rig.
10. **Polecats 🦨** — Workers have persistent identity/history but ephemeral sessions and are spawned for tasks.
11. **Hooks 🪝** — Git-worktree-backed storage survives crashes and restarts, reducing lost in-progress work.
12. **Convoys 🚚** — Bundle Beads for assignment; mountain convoys add stall detection and skip behavior for large execution.
13. **Beads Integration 📿** — Git-backed structured issue state gives task ownership a persistent identity. This is a task-level coordination mechanism, distinct from file locking.
14. **Molecules 🧬** — Formula workflows model multistep work with checkpointable execution.
15. **Monitoring: Witness, Deacon, Dogs 🐕** — A watchdog hierarchy detects stuck agents, recovers sessions, and dispatches maintenance.
16. **Refinery 🏭** — A per-rig merge queue batches completed work, verifies it, and bisects failures; workers do not directly push to main.
17. **Escalation 🚨** — Blockers become tracked beads routed by severity instead of silently waiting.
18. **Scheduler ⏱️** — Configurable dispatch capacity controls API/resource pressure; direct dispatch is the default.
19. **Seance 👻** — Session discovery lets an agent query predecessor context and decisions.
20. **Wasteland 🏜️** — Federated work coordination shares wanted tasks and completion evidence across towns.
21. **Installation** — Covers local or Docker deployment; operational setup is not evidence about lock performance.
22. **Prerequisites** — Lists host/runtime dependencies, including Git, database, and optional tmux/runtime tools.
23. **Local setup** — Introduces platform-specific installation and workspace creation.
24. **Install gt on macOS** — Homebrew supplies the product dependencies; source-build caveats are documented.
25. **Install gt on Linux** — Installs the CLI and Beads with Go after setting up Dolt.
26. **Install gt on Windows** — Documents native CLI setup and recommends WSL/Linux for tmux-backed workflows.
27. **Create your workspace** — `gt install` initializes the headquarters and optional Git state; `gt up` starts services.
28. **Add a project** — A rig clones/registers a repository in the workspace.
29. **Create your crew workspace** — A personal Git clone is used for direct work.
30. **Start the Mayor** — Attaches the coordinator to manage work across rigs.
31. **Docker Compose setup** — Runs an HQ in a container with explicit data/security cautions.
32. **Quick Start Guide** — Walks through setup and basic task assignment.
33. **Getting Started** — The basic startup sequence creates the HQ and attaches the Mayor.
34. **Basic Workflow** — The Mayor creates a convoy, assigns a bead, and monitors completion; ownership is task-level.
35. **Example: Feature Development** — Shows a feature split into beads and assigned to an agent.
36. **Common Workflows** — Offers orchestrated and manual usage modes.
37. **Mayor Workflow (Recommended)** — The Mayor creates a convoy and agents, while a user tracks progress.
38. **Minimal Mode (No Tmux)** — Gas Town can track state while runtime sessions are run manually.
39. **Beads Formula Workflow** — Repeatable multistep processes are expressed as formulas and tracked instances.
40. **Manual Convoy Workflow** — Users can distribute issue work directly without full orchestration.
41. **Runtime Configuration** — Per-rig settings select an agent runtime and startup behavior.
42. **Key Commands** — Groups commands for workspaces, agents, convoys, monitoring, and task federation.
43. **Workspace Management** — Creates and lists rigs and crew workspaces.
44. **Agent Operations** — Lists, spawns, resumes, and monitors agents; `sling` assigns work.
45. **Convoy (Work Tracking)** — Creates and inspects grouped task work.
46. **Configuration** — Selects runtime commands and defaults.
47. **Monitoring & Health** — Surfaces escalations, scheduler state, and predecessor context.
48. **Beads Integration** — Invokes reusable formulas and molecule tracking.
49. **Wasteland Federation** — Browses and claims remote wanted tasks and submits evidence.
50. **Cooking Formulas** — Built-in recipes provide repeatable workflow templates.
51. **Activity Feed** — TUI combines task, agent, and merge-queue events for live observation.
52. **Problems View** — Health grouping helps people find stalled/zombie agents as scale makes the stream hard to scan.
53. **Dashboard** — Web UI summarizes agents, convoys, hooks, queues, issues, and escalations.
54. **Monitoring & Health** — Watchdogs patrol across daemon, Deacon, Witness, and Refinery layers.
55. **Witness (Per-Rig)** — Detects stuck workers and triggers recovery/cleanup rather than doing their tasks.
56. **Deacon (Cross-Rig)** — Patrols all projects, dispatches maintenance, and escalates unresolved issues.
57. **Escalation** — Agents route blockers to human/coordinator attention.
58. **Merge Queue (Refinery)** — Batches merge requests, verifies stacks, and bisects failures; this is land coordination, not an edit-time file lock.
59. **Scheduler** — Caps dispatch to prevent API exhaustion and can pause/resume task allocation.
60. **Seance** — Recovers predecessor context from session logs.
61. **Wasteland Federation** — Shares wanted work and portable completion reputation across towns.
62. **Telemetry (OpenTelemetry)** — Emits structured agent/workflow events and metrics for operations.
63. **Advanced Concepts** — Explains Git worktree-based persistence and orchestration patterns.
64. **The Propulsion Principle** — Hooks use Git worktrees for persistent state, versioning, rollback, and collaboration.
65. **Hook Lifecycle** — Work transitions through created, active, suspended, completed, and archived states.
66. **MEOW (Mayor-Enhanced Orchestration Workflow)** — Mayor decomposes work, creates a convoy, dispatches agents, and monitors completion.
67. **Shell Completions** — Adds command completion for supported shells.
68. **Project Roles** — Summarizes coordinator, human, worker, watchdog, queue, and persistent-storage responsibilities.
69. **Tips** — Recommends Mayor/convoys/hooks/formulas/feed/dashboard for reliable coordination.
70. **Design Documentation** — Links deeper architecture, workflow, lifecycle, scheduler, and telemetry documents.
71. **Troubleshooting** — Gives recovery steps for common runtime/task issues.
72. **Agents lose connection** — Repair hooks and restore worker connection state.
73. **Convoy stuck** — Refresh task-group status.
74. **Mayor not responding** — Restart the coordinator session.
75. **License** — Identifies MIT licensing; no locking result.
## What it means for Concord v3
This is evidence for task ownership/persistent orchestration as a way to reduce duplicate work. It does not demonstrate that locks on files are always harmful or that task claims need to be server-enforced source-unit leases.

# Welcome to Gas Town — Steve Yegge
URL: https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04
Fetched: 2026-10-15 20:05 UTC; method: `curl -L --fail --silent --show-error 'https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04' -o "$DELEGATE_SCRATCH_DIR/gastown-medium.html"`
Raw SHA-256: unavailable (fetch failed before writing a source file)
Extracted words: 0 (`wc -w` not applicable; no fetched bytes)
Read status: NOT READ (`curl` failed: `curl: (56) The requested URL returned error: 403`)
## Sections
1. **NOT AVAILABLE** — The site rejected both attempts with HTTP 403. No substitute article or summary was used.
## What it means for Concord v3
No conclusions attributed to this article. The GitHub README remains a separate source and cannot stand in for this reading.

# Concord v2 lease code: `src/leases/symbol-keys.ts`
URL: local checkout file `src/leases/symbol-keys.ts`
Fetched: 2026-10-15 20:04 UTC; method: `cat src/leases/symbol-keys.ts`
Raw SHA-256: e7ef50d12e569669f755c77340777c1f2c7a6fceabc55817b74435c2898647d5
Extracted words: 1049 (`wc -w src/leases/symbol-keys.ts`)
Read status: read in full
## Sections
1. **Module documentation and types** — Keys derive from Git-selected funcname lines; signature/header changes deliberately widen to file scope. Intervals are one-based and half-open, with edits represented on before/after sides.
2. **UTF-8 and key validation** — Canonical NFC paths/names, percent encoding, bounded byte length, and strict decoding reject aliases and malformed keys.
3. **symbolForEdit** — The implementation grants a symbol key only when both before and after prove the same valid interval; ambiguous insertions, boundary edits, deleted identity, mismatched keys, or invalid metadata widen to `file:path`.
## What it means for Concord v3
Current v2 symbol identity intentionally uses a conservative fallback when the boundary is uncertain. This is a correctness safeguard, but if exclusive leases are too coarse, v3 should measure widening rates and improve proof/granularity rather than silently granting overlapping narrow claims.

# Concord v2 lease code: `src/leases/units.ts`
URL: local checkout file `src/leases/units.ts`
Fetched: 2026-10-15 20:04 UTC; method: `cat src/leases/units.ts`
Raw SHA-256: 3365a623ce1a2c31f6b2d5289a1d00b68c7d1d65b0654dbc7adbeac526f52de7
Extracted words: 1865 (`wc -w src/leases/units.ts`)
Read status: read in full
## Sections
1. **Policy types and limits** — Unit identity comes only from trusted policy; normalized-unit caps encourage coarser declarations rather than unbounded claims.
2. **Symbol and table validation** — Symbol rules, row keys, paths, and prefixes are validated for canonicality and ambiguity.
3. **Unit registry and resolution** — File, symbol, prefix, and TSV-row units map to underlying resources so overlapping declarations can be detected.
4. **Diff-to-unit mapping** — Changes resolve to rows/symbols when evidence is unambiguous and fall back to whole-file protection when parsing, identity, or shape is unclear.
## What it means for Concord v3
Existing policy already supports heterogeneous granularity and conservative widening, aligning with a claim system that defaults to small semantic units where provable and whole-file fallback otherwise. This local implementation shows the engineering cost of reliable fine-grained identities and should be treated as a baseline to measure, not assumed perfect.

# Concord v3 architecture draft
URL: `/Users/sebastianpatronsoto/Documents/Claude/for-seb/concord-v3-architecture.html`
Fetched: 2026-10-15 20:04 UTC; method: HTML text extraction by `python3 -c 'import re,html,sys; s=open(sys.argv[1],errors="replace").read(); s=re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>"," ",s); s=re.sub(r"(?s)<[^>]+>"," ",s); s=html.unescape(s); s=re.sub(r"\s+"," ",s); open(sys.argv[2],"w").write(s)' /Users/sebastianpatronsoto/Documents/Claude/for-seb/concord-v3-architecture.html "$DELEGATE_SCRATCH_DIR/v3-draft-clean.txt"`
Raw SHA-256: 02fe429cebfe4be735aa7b1ecf4034bf25b078bf2a8765ee7134151ec36fc0a0
Extracted words: 6577 (`wc -w "$DELEGATE_SCRATCH_DIR/v3-draft-clean.txt"`)
Read status: read in full
## Sections
1. **1 Summary** — The draft proposes an agent-first forge with server-side changes, claims, issues, runs, events, and GitHub mirroring. Claims are one part of a wider server-side workflow.
2. **2 Requirements** — The system must support concurrent agents, reliable landing, owner controls, and low idle cost. Requirement R1 makes concurrency a core product need.
3. **3 What v3 fixes** — It positions v3 against v2 friction and establishes the rebuild goals. It cites long-lived reservations/refusals as motivation for claims changes.
4. **4 System context** — Concord is a server-side coordinating forge for agents and owners. GitHub is described as a one-way mirror.
5. **5 Components** — A TypeScript/Bun service, Git/SQLite, APIs, clients, runners, and event delivery divide responsibilities. The repo actor is described as the single repository writer.
6. **6 Data model** — Repositories, changes, claims, issues, runs, and event state form the main entities. Claim records include unit, session, mode, state, and grace time.
7. **7 Changes** — Changes are server-side candidate work that will be checked and landed. Submit currently ends claims and begins review/validation.
8. **8 Land process** — The draft uses a land queue with fast checks and subsequent full validation, plus owner controls. The queue lock is distinct from claims on work units.
9. **9 Claims** — Claims are described as advisory by default, optionally exclusive for selected paths, with shared/exclusive modes, 10-minute disconnect grace, symbol units, and owner controls. It says this changes D-UNIT-1-EXCLUSIVE and makes a contested claim that Cursor showed locks hurt; the source only studied task coordination locks. It also cites a 40% widening/30% agreement measurement attributed to SP-E, which this spike has not independently re-read.
10. **10 Issues and dependencies** — Issues and blocker relationships determine readiness; this is task scheduling, separate from source-unit claims. The issue is ready only when no task is already working on it.
11. **11 Runs and swarms** — Runs coordinate agents across issues/milestones and are orchestration units, not file locks. Workers claim units and handle their own conflicts in the proposed flow.
12. **12 Checks and runners** — Checks validate candidate changes and post-land outcomes. A runner job itself has a lease deadline and returns to its queue on expiry.
13. **13 Review** — Review provides an independent quality gate and human judgment. Rules vary by change kind and protected paths.
14. **14 API, CLI and MCP** — Interfaces share an operation model so agents can manage work consistently. The claim operation is exposed through all client interfaces.
15. **15 Events and zero idle cost** — Event delivery avoids polling and keeps idle clients inexpensive. The draft currently lists claim grace as a real timer deadline.
16. **16 Security** — Authentication and authorization bound repository operations and owner powers. Protected paths and human review are policy controls.
17. **17 GitHub import and mirror** — GitHub is an import/mirror boundary rather than the source of truth. The section does not specify claim semantics.
18. **18 Deployment** — The server runs as a single service on a VPS, with operational migration considerations. The proposed architecture uses a repo actor and persistent database.
19. **19 Cost and budgets** — Agent spend and operational cost need explicit controls. Route budgets and model spend are separate from claim contention.
20. **20 What we keep from v2** — Reuses selected v2 concepts, including claims, while rebuilding the system around v3 architecture. The list says unit identity and claims are being rebuilt.
21. **21 Delivery plan** — Delivery is phased, with a multi-agent swarm test as a core milestone. P1 expects disjoint changes to land and overlaps to queue with ETA.
22. **22 Decisions** — Decision 4 explicitly says “Claims: shared by default, exclusive for paths in policy,” reverses D-UNIT-1-EXCLUSIVE, and is open. This assignment is evidence for that owner decision; the recommendation must not be presented as approved implementation.
23. **23 Glossary** — Defines the draft's terms, including claim, unit, and wait line. These definitions should distinguish advisory records from exclusive leases.
24. **24 Sources** — Lists the evidence base; source attribution must identify the protected unit and enforcement mechanism. Cursor's current summary leaves that lock target implicit.
## What it means for Concord v3
The full draft provides context for corrections in Section 9 and its cross-references in Sections 2, 8, 10, 11, 20, 22, and 24. The claims design can preserve D-UNIT-1-EXCLUSIVE as a unit-level option while recommending a different default only through an explicit owner decision; this spike recommends a measured, policy-based hybrid, not an unrecorded policy change.

# Source inventory and extracted words

| Source | URL | Extracted words | Read status |
|---|---|---:|---|
| Cursor scaling agents | https://cursor.com/blog/scaling-agents | 2644 | read in full |
| Anthropic Scion | https://www.anthropic.com/engineering/redesigning-source-control | 4073 | read in full |
| Kung & Robinson, TODS 1981 | https://db.cs.cmu.edu/papers/1981/kung-tods1981.pdf | 6552 | read in full |
| Git LFS locking API | https://github.com/git-lfs/git-lfs/blob/main/docs/api/locking.md | 2046 | read in full |
| Git LFS lock command | https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-lock.adoc | 161 | read in full |
| Git LFS locks command | https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-locks.adoc | 288 | read in full |
| Git LFS unlock command | https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-unlock.adoc | 157 | read in full |
| Git LFS wiki | https://github.com/git-lfs/git-lfs/wiki/File-Locking | 927 | read in full |
| Perforce `p4 lock` | https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_lock.html | 295 | read in full |
| Perforce `p4 typemap` | https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/p4_typemap.html | 1097 | read in full |
| Perforce `+l` file type | https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/file.types.synopsis.modifiers.html | 720 | read in full |
| Unity check out and lock | https://docs.unity.com/en-us/unity-version-control/gluon/check-out-and-lock | 432 | read in full |
| Unity lock rules | https://docs.unity.com/en-us/unity-version-control/unity-vcs-organization-settings | 513 | read in full |
| Unreal One File Per Actor | https://dev.epicgames.com/documentation/en-us/unreal-engine/one-file-per-actor-in-unreal-engine | 711 | read in full |
| Unreal source control | https://dev.epicgames.com/documentation/en-us/unreal-engine/source-control-in-unreal-engine | 893 | read in full |
| Jujutsu conflicts | https://jj-vcs.github.io/jj/latest/conflicts/ | 1457 | read in full |
| Jujutsu concurrency | https://github.com/jj-vcs/jj/blob/main/docs/technical/concurrency.md | 1186 | read in full |
| Gas Town README | https://github.com/gastownhall/gastown/blob/main/README.md | 4169 | read in full |
| Steve Yegge, Welcome to Gas Town | https://steve-yegge.medium.com/welcome-to-gas-town-4f25ee16dd04 | 0 | NOT READ (403; command above) |
| v2 `symbol-keys.ts` | `src/leases/symbol-keys.ts` | 1049 | read in full |
| v2 `units.ts` | `src/leases/units.ts` | 1865 | read in full |
| v3 draft | `/Users/sebastianpatronsoto/Documents/Claude/for-seb/concord-v3-architecture.html` | not counted | read in full |
