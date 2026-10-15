# First-class conflicts
URL: https://jj-vcs.github.io/jj/latest/conflicts/
Fetched: 2026-10-15 20:31:11 UTC; method: `curl -fL --retry 2 -o "$DELEGATE_SCRATCH_DIR/r5/conflicts.html" https://jj-vcs.github.io/jj/latest/conflicts/`
Raw SHA-256: 4b9195fefd12e9d3c47e34ddef950ce23ae334af574a0db903b85e1527f3ef32
Extracted words: 1297 (`wc -w "$DELEGATE_SCRATCH_DIR/r5/conflicts.txt"`; text extracted from the complete fetched HTML after stripping script, style, and nav-tag bodies; remaining UI text is included)
Read status: read in full
## Sections
1. First-class conflicts — The page presents conflicts as data that can persist in commits, rather than as an operation that must be fixed before the operation succeeds. The representation is logical and can be rebased, merged, or backed out; textual markers are only a working-copy or diff rendering.
2. Introduction — Conflicts occur when incompatible edits affect the same file region. Jujutsu permits the resulting commit to be recorded and later checked out for repair, while descendants can continue to be rebased.
3. Advantages — This model removes special “continue” commands in favor of resolving and amending the conflicted commit. It supports automatic descendant rebasing, meaningful merge-commit changes relative to both parents, deferred repair, many-parent merges, and collaboration; the page cautions that sharing this conflict representation is unsuitable when some collaborators use Git.
4. Conflict markers — The default materialization combines one snapshot side with diffs from the other sides, so the conflict itself shows how alternatives differ. The example applies the small lowercase word replacement to the uppercase snapshot; conflicts with more than two sides use one snapshot and multiple diffs.
5. Alternative conflict marker styles — Snapshot style shows each side’s full contents, while Git’s diff3 style includes the base and is limited to two sides. For more sides, jj falls back from Git style to its snapshot representation.
6. Long conflict markers — jj lengthens marker runs when ordinary marker-looking lines occur in file content. This preserves an unambiguous boundary between conflict syntax and literal source text.
7. Conflicts with missing terminating newline — Materialization ensures each marker line starts after a newline even if a conflicted term lacked a final newline. jj adds a newline to each term and compensates by omitting the final newline from the closing marker, preserving the distinction for a later resolution.
## What it means for Concord v3
For the v3 architecture’s server-side change and landing flow, the central agreement is that recording a conflicted candidate can preserve useful work and allow later repair, instead of making every merge attempt an all-or-nothing operation. A Concord change record could carry structured conflict state and make it inspectable by agents or a human; this is an architectural implication, not a claim that jj’s storage model can be adopted directly. The page also warns that jj’s multi-sided representation is not interoperable with Git collaborators, which matters to the one-way GitHub mirror: the mirror boundary needs a defined representation or a constrained conflict-resolution workflow. The supplied v3 context does not include draft section headings, and the draft was out of scope to read, so section-level comparisons cannot be named more precisely.

# Concurrency
URL: https://github.com/jj-vcs/jj/blob/main/docs/technical/concurrency.md
Fetched: 2026-10-15 20:32:04 UTC; method: `git clone --depth 1 https://github.com/jj-vcs/jj.git "$DELEGATE_SCRATCH_DIR/r5/jj"` then read `docs/technical/concurrency.md`
Raw SHA-256: 7dcac7dda7fdcc900db3c59292bb7a5aba8836eab5741d4cf780535359d5f752
Extracted words: 1186 (`wc -w "$DELEGATE_SCRATCH_DIR/r5/jj/docs/technical/concurrency.md"`)
Read status: read in full
## Sections
1. Concurrency — Jujutsu treats local and remote concurrent repository edits alike and records conflicts rather than preventing all concurrency with locks. The document’s criticism is specifically of repository lock files: coarse locks block unrelated operations, while fine-grained locks make correctness harder to implement; distributed filesystems also expose lock-file problems.
2. Introduction — Each command works from a consistent repository view, then can commit its operation even if another operation ran concurrently. Later commands detect and merge divergent operations; this reduces synchronization obligations inside each command.
3. Syncing with `rsync`, NFS, Dropbox, etc — Independently updated clones can be synchronized through file replication without losing commits, though bookmarks can become conflicted. The document explicitly limits the safety claim: the Git backend is not completely lock-free and can corrupt repositories, and this deployment mode is not thoroughly tested; bookmark pointers might be lost in colocated repositories even though commits remain.
4. Operation log — Repository states are represented as views linked by operations, creating a DAG analogous to commit history. A command loads a stable view and writes a child operation; loading an older operation and mutating it creates a divergent branch of operations.
5. Merging divergent operations — Multiple operation heads are reconciled by a three-way merge of their views, preserving conflicting bookmark targets as conflicts. Users can continue operating on the repository, although commands requiring one unambiguous target can fail.
6. Storage — Content-addressed operation and view objects can be written without locks. Small files whose names encode current operation heads publish updates atomically; a new head file makes an operation visible, and stale old-head files are cleaned up by later readers.
## What it means for Concord v3
This supports separating concurrent work from shared-state reconciliation in the v3 server-side change flow: an operation log and immutable state snapshots can record parallel actions and merge their visible effects later. It does not support the earlier draft’s reported claim that Cursor demonstrated file locks themselves harm agent concurrency: this paper discusses VCS repository lock files and their implementation tradeoffs, not agent-managed locks on a shared TASKS coordination file. Concord’s claims-for-presence and candidate-change workflow have different semantics and need evaluation on their own; the document’s explicit Git-backend corruption caveat also argues against copying a lock-free design without backend-specific guarantees. Draft section headings were not in the supplied context and the draft was not read, so this comparison is limited to the named v3 concepts in the assignment context.
 
# Usage
URL: https://mergiraf.org/usage.html
Fetched: 2026-10-15 20:31:59 UTC; method: `curl -fL --retry 2 -o "$DELEGATE_SCRATCH_DIR/r5/mergiraf.html" https://mergiraf.org/usage.html`
Raw SHA-256: c9477e01c4edfb020f18e5316ef0752ccfbd118f04c766f904e4df97b41e97e7
Extracted words: 1553 (`wc -w "$DELEGATE_SCRATCH_DIR/r5/mergiraf.txt"`; text extracted from the complete fetched HTML after stripping script, style, and nav-tag bodies; remaining UI text is included)
Read status: read in full
## Sections
1. Mergiraf — The page is the tool’s usage guide for adding syntax-aware merge resolution to Git or invoking it interactively. Its examples cover language selection, review, failure fallback, reporting, and Jujutsu use.
2. Usage — Mergiraf operates on text conflict markers and needs diff3 conflict style so it can reconstruct the merge base and both sides. This requirement applies across the documented workflows.
3. Enabling `diff3` conflict style — The guide configures Git’s merge conflict style to `diff3`, either through Git configuration or the equivalent setting. The base revision is essential to Mergiraf’s reconstruction strategy.
4. Workflows — Users can register Mergiraf as a merge driver or invoke it after Git reports a conflict; driver registration is recommended to avoid stopping for conflicts its syntax-aware logic could settle. It also supports Jujutsu, whose merge model and marker handling differ.
5. Registration as a Git merge driver — Git invokes Mergiraf during merge-like operations through a driver configuration, and attributes can select all files or specific languages. The documented best results use Git 2.44 or newer.
6. Trying it out — A public example repository demonstrates merges across Java, JSX, Rust, YAML, and JSON, including independent syntax edits and conflicting signatures. The Jujutsu example uses `jj new` followed by `jj resolve --tool mergiraf`.
7. Reviewing Mergiraf’s work — The tool either accepts a clean line-based merge, resolves line conflicts heuristically and exposes the result for review, or leaves conflicts for manual resolution. If output is unsatisfactory, the user can abort and retry with Mergiraf disabled.
8. Temporarily disabling Mergiraf — Setting the `mergiraf` environment variable to zero bypasses the tool for a single Git operation. This gives users a direct fallback to Git’s ordinary merge heuristics.
9. Manually specifying the file’s language — Unknown extensions can be assigned a language with a command option or Git attributes. Mergiraf checks its own language attribute before Linguist’s, allowing repositories to override detection deliberately.
10. Enabling merging despite syntax errors — By default, parse failures fall back to line-based merging, while an option or attribute can permit syntax-aware attempts despite parse errors. The guide notes known spurious parser failures for C, C++, and HTML and makes the option default-on for those languages.
11. Reporting a bad merge — A report command packages reproduction material; the user is told where to submit it and can choose private contact if publication is unsuitable. The guide shows how to identify a merge by its generated ID or by the affected path.
12. Compact conflict presentation — Compact mode narrows markers to mismatching syntax fragments, which can make semantic differences easier to see. Its cost is that resolving the smaller fragments often requires reformatting afterward.
13. Interactive use after encountering a merge conflict — In Git, the user can run `mergiraf solve` on a conflicted file, inspect the result, then stage it and continue the merge. The sequence keeps inspection and acceptance explicit.
14. Interactive use with Jujutsu — Jujutsu records conflicts and resolves them later, so Mergiraf is invoked explicitly with `jj resolve --tool mergiraf`; automatic Git attributes do not apply. Jujutsu supplies a compatible default tool configuration and prepares Git-style markers for Mergiraf, while `mergiraf solve` is discouraged there because jj marker styles can lack or distort the base information needed for parsing.
## What it means for Concord v3
For the v3 server-side changes and merge-resolution path, Mergiraf supports offering a syntax-aware resolver as an optional, inspectable step with an explicit manual fallback. Its different modes imply that Concord should preserve the original conflict, resolver output, and review decision separately rather than silently trusting a heuristic. The Jujutsu section confirms that resolver integration must account for the actual conflict format and base-side data; this aligns with a structured conflict record but warns against assuming any Git tool can consume every conflict representation. This comparison is against the supplied change and review concepts; the draft’s section headings were not provided and were not read.

# Introduction
URL: https://difftastic.wilfred.me.uk/introduction.html
Fetched: 2026-10-15 20:32:30 UTC; method: `curl -fL --retry 2 -o "$DELEGATE_SCRATCH_DIR/r5/difftastic.html" https://difftastic.wilfred.me.uk/introduction.html`
Raw SHA-256: 3283a0881d67c66da8d43c34b7957d2ddf2254a18f83a76733900cd04b493612
Extracted words: 286 (`wc -w "$DELEGATE_SCRATCH_DIR/r5/difftastic.txt"`; text extracted from the complete fetched HTML after stripping script, style, and nav-tag bodies; remaining UI text is included)
Read status: read in full
## Sections
1. Introduction — Difftastic is a structural diff tool supporting more than 30 programming languages. The fetched manual identifies itself as version 0.72.0 and links readers to the changelog for version-specific updates.
2. Syntactic Diffing — It detects a language, parses both inputs, and compares syntax trees, allowing it to match code moved across lines or reformatted. Its example shows a method call preserved while a new expression wraps it, a relationship that a line diff obscures; delimiter matching can also reveal structure.
3. Fallback Line-Oriented Diffing — Unknown input formats use ordinary line-based diffing with word highlighting, and extremely large inputs also fall back to that mode. Structural comparison is therefore conditional on language support and input size.
## What it means for Concord v3
In the v3 change review and diff display, structural diffs could make moved or reformatted code easier for agents and humans to inspect, complementing the architecture’s server-side changes. The documented fallback and size limit mean Concord should expose which diff mode produced a view and retain a reliable ordinary diff path; it should not treat syntactic output as universal. The supplied architecture context does not name draft section headings, and the draft was not read, so this maps to the named change-review concepts only.

# AGit Workflow Usage
URL: https://forgejo.org/docs/latest/user/git-cli/agit-support/
Fetched: 2026-10-15 20:32:41 UTC; method: `curl -fL --retry 2 -o "$DELEGATE_SCRATCH_DIR/r5/agit.html" https://forgejo.org/docs/latest/user/git-cli/agit-support/`
Raw SHA-256: dcfd10e5f4908f01905c0d02dfdabf95fbeb2f563b26d75fbd0958ef847fca48
Extracted words: 1201 (`wc -w "$DELEGATE_SCRATCH_DIR/r5/agit.txt"`; text extracted from the complete fetched HTML after stripping script, style, and nav-tag bodies; remaining UI text is included)
Read status: read in full
## Sections
1. AGit Workflow Usage — Forgejo’s AGit flow creates pull requests through Git push refs, avoiding forks and feature branches that require write access to the base repository. A topic identifies each request and its follow-up updates.
2. Changing git default push method — The guide recommends `push.default upstream` for AGit because the local branch and target branch typically differ. It can be set per repository or globally.
3. Working with existing pull requests — A pull request can be fetched by number into a local branch without adding another remote, then configured to pull from its request ref. Authors and repository writers can push updates to AGit refs, including force pushes, subject to access rules.
4. Creating pull requests — A push to `refs/for/<target>/<topic>` creates a request, using the checked-out reference or another local ref. The topic is visible with the username prefix and ties later commits to the request.
5. Setting a title and a description in AGit — Push options can set title and description; otherwise Forgejo uses the first commit’s title and description. The description option cannot directly carry newlines, but base64 encoding provides a documented workaround.
6. Updating an existing AGit pull request — Configuring the branch’s merge ref and remote lets ordinary pull and push commands update the request. The guide explicitly says `--force-with-lease` is unsupported.
7. Programmatically creating (or updating) a pull request — Automation can push a commit and open a request using credentials authorized to open pull requests, without base-repository write access. A force-push option updates an open request with the same user/topic; otherwise the operation can fail or create another request.
8. Parameters reference — The documented refspec selects normal, draft, or for-review request types and a target branch and topic. Only `for` currently opens a normal request; `draft` and `for-review` are silently ignored, Gerrit Change-Ids are unsupported, and a closed or merged topic creates a new request.
9. Review Workflow — Reviewers can use Forgejo’s web interface or obtain command-line instructions from the request form. The page identifies Apache-2.0 for its content and CC BY-SA 4.0 for the broader documentation site.
## What it means for Concord v3
AGit demonstrates a Git-native CLI pathway for creating and updating server-side review objects without a fork, which could help a one-way GitHub mirror remain compatible with existing Git clients. Its core object is still a pull request, including review and branch targeting, so it disagrees with v3’s stated “server-side changes that land (no pull requests)” direction if treated as Concord’s native workflow. The useful transferable idea is direct push as an interface; v3 would need its own ref/operation protocol to map that interaction to a landing change rather than importing AGit’s PR semantics. This comparison uses the supplied v3 decision context; draft headings were not available and the draft was not read.

# Why Google Stores Billions of Lines of Code in a Single Repository
URL: https://cacm.acm.org/research/why-google-stores-billions-of-lines-of-code-in-a-single-repository/ (PDF also attempted: https://dl.acm.org/doi/pdf/10.1145/2854146)
Fetched: 2026-10-15 20:33:05 UTC; method: `curl -fL --retry 2 -o "$DELEGATE_SCRATCH_DIR/r5/piper-acm.html" https://cacm.acm.org/research/why-google-stores-billions-of-lines-of-code-in-a-single-repository/` and `curl -fL --retry 2 -o "$DELEGATE_SCRATCH_DIR/r5/piper-acm.pdf" https://dl.acm.org/doi/pdf/10.1145/2854146`
Raw SHA-256: unavailable (both fetches failed before writing a file)
Extracted words: 0 (none; both curl commands returned HTTP 403 before receiving article text; no extraction/count command was applicable)
Read status: NOT READ (`curl -fL --retry 2 -o "$DELEGATE_SCRATCH_DIR/r5/piper-acm.html" https://cacm.acm.org/research/why-google-stores-billions-of-lines-of-code-in-a-single-repository/` returned HTTP 403; PDF command also returned HTTP 403)
## Sections
Not available: neither the article page nor the PDF could be fetched, so no article headings or section notes are claimed.
## What it means for Concord v3
No source-based agreement or disagreement can be assessed because the article was not available to read. No claims about Google’s monorepo practices are inferred from the title or background knowledge.

## Source status table
| URL | Extracted words | Read status |
| --- | ---: | --- |
| https://jj-vcs.github.io/jj/latest/conflicts/ | 1297 | read in full |
| https://github.com/jj-vcs/jj/blob/main/docs/technical/concurrency.md | 1186 | read in full |
| https://mergiraf.org/usage.html | 1553 | read in full |
| https://difftastic.wilfred.me.uk/introduction.html | 286 | read in full |
| https://forgejo.org/docs/latest/user/git-cli/agit-support/ | 1201 | read in full |
| https://cacm.acm.org/research/why-google-stores-billions-of-lines-of-code-in-a-single-repository/ (PDF: https://dl.acm.org/doi/pdf/10.1145/2854146) | 0 | NOT READ (HTTP 403 on both URLs) |
