# Slice 15: lease units in real repositories

Decision spike, 2026-10-11. Evidence is pinned to Concord commit
`313548c8f930164a056905197144723d5e779c6f` (merged PR #17), not to a moving branch.
No production behavior changes in this spike. Scripts are in [15/](15/README.md).

## Decision for the owner

For Tuesday 2026-10-13 night, use **generated whole-file units plus owner-predeclared
exact creation paths**. Keep the existing TSV scene for the finer-than-file demo.
Add a real TypeScript new-file scene, repair transitive dependency evidence, and
conservatively block remaining queue candidates after canonical main advances.
Estimate **16–22 focused engineering hours including integration**, assuming the
existing local runner and demo work; external deployment/access work is excluded.
Do not promise unrestricted new-file creation or automatic semantic independence.

The best product is a hybrid: whole-file fallback, bounded creation prefixes,
optional language adapters, named sequence locks, and dependency-based revalidation.
Symbol extraction alone is not an authorization boundary, dependency analysis,
merge algorithm, or proof that two edits commute. The measured compiler prototype
narrows some writes but saves **0 of 24 overlapping PR pairs** in this sample.
Fix admission and creation before investing the contest budget in symbol leases.

## 1. What exists today

All file:line references below refer to the pinned commit. The API/architecture
documents describe intent; the implementation trace is authoritative where they differ.

| Question | Evidence and consequence |
| --- | --- |
| Who registers units? | `src/contracts.ts:111–115` defines `TrustedPolicy.units`; `src/state.ts:85–106` loads deployment `TRUSTED_CONFIG` or a local fixture. `src/features/repos.ts:157–171` requires an owner to select installed policy/profile IDs and stores the policy digest. `demo/scenarios.ts:98–117` hashes the policy input, including checker digest, from `demo/units.json`. Agents do not submit registry definitions. |
| What does a key mean? | `src/leases/units.ts:23–77` validates alias/canonical/path/resource metadata, deduplicates identities, rejects ambiguous narrow footprints, and synthesizes `file:<path>` for each represented file. Empty resources mean whole-file. `:80–105` rejects unknown keys and caps normalized claims at 16. `:108–118` checks same-file resource intersection/coverage, with whole-file overlapping every narrow unit in that file. There is no cross-file or path-prefix overlap rule. |
| How is the policy pinned? | `src/features/leases.ts:35–40` compares installed digest with the repository pin; runner jobs carry the policy (`runner/units.ts:65–66`). Current `src/state.ts:95–100` checks digest **shape**, not a recomputed policy preimage or canonical-commit association. Trust therefore includes the installer producing an honest digest. Canonical commit plus generator provenance is a proposed addition, not an existing guarantee. |
| How does `changedUnitsForFile` work? | `src/leases/units.ts:121–156` first resolves the trusted file unit, then compares complete TSV rows by first field. Non-TSV, creation/deletion, changed terminal-newline status, malformed/duplicate rows, or changed unmapped rows return the whole file. Registered row additions/removals can remain row-sized. Row ordering alone disappears in this helper's map comparison. An entirely unregistered file throws `UNKNOWN_UNIT` before any parsing. |
| Is that helper the runner mapper? | **No.** A search of `src` and `runner` finds only the helper definition. `runner/units.ts:58–101` independently diffs Git with `--no-renames`; narrow extraction is specific to `families.tsv` and `row:families:<letters>`, with its own schema parser (`:13–24`). Other paths use explicit file policy entries. A synthesized lease file key is insufficient for publish/inspection unless it also exists in `policy.units` (`src/features/repos.ts:412,595`). Generated policies must emit explicit file entries. |
| What verifies the declared footprint? | `runner/units.ts:96–127` reports actual writes and unknown coverage if a file is unmapped. `src/features/repos.ts:584–612` requires complete coverage, registered keys, matching declared/inspected keys, exact revision/head, hashes, and trusted pins. `src/features/leases.ts:274–335` independently requires checker evidence, matching declared units, current author-held fences, and coverage before reserving. Unknown coverage does not make an unknown file admissible. |

### New files, renames, deletions, and sequences

An **unlisted** new file fails: claiming its key returns `422 UNKNOWN_UNIT`; publishing
it is rejected at `src/features/repos.ts:412`, or an undeclared addition fails inspection.
An **owner-prelisted, not-yet-existing** path can be created today: registry validation
checks path syntax, not existence, and the runner records null before-path/mode/digest
(`runner/units.ts:96–100`). This is the small, usable opening for the demo MVP.

A rename is a deletion plus addition because the runner disables rename detection
(`runner/units.ts:58–62`). Both old and new file keys must be registered and claimed;
there is no stable identity that follows a Git rename. A deleted registered file
consumes its whole-file unit and has null after evidence. A mode change also takes
the runner's file fallback. Whole-file byte hashes catch formatting changes; TSV
special cases are domain-specific and should not be generalized to source code.

There is no sequence unit type. A resource string cannot coordinate two different
files because `overlaps` returns false immediately when paths differ
(`src/leases/units.ts:108–111`). A fake sentinel-file claim also cannot be appended as
an unused lock: reservation rejects extra claims without writes (`src/features/leases.ts:315–317`).
A migration sequence needs an enforced cross-file capability, not a naming convention.

### Definitive answer: what `dependencyKeys` does and does not do

1. `runner/units.ts:103–120` gathers the **direct** dependency keys of changed units,
   reads their content at the inspected candidate head, and hashes whole-file bytes
   or supported TSV row bytes. Missing metadata/content produces unknown coverage.
2. `src/verdicts/manifest.ts:68–92` computes the **transitive** owner-declared closure
   with a visited set, including cycle termination. `:124–130` requires exactly that
   set in a complete manifest. Unsupported resource scopes are rejected (`:77–82`).
   Thus A→B→C with only A changed produces B in the runner but requires B and C at
   validation. It fails closed at approval/gate normalization; it is not silently
   accepted as complete. Repos may record the inspection first: the handoff stores
   a hash-checked record (`src/features/verdicts.ts:298–312`), while `inspection()`
   normalizes it when review is attempted (`:26–45`). The runner/validator mismatch
   prevents a usable approval for such chains.
3. Carry is **explicit**, initiated by a reviewer via POST `/carry`
   (`src/features/verdicts.ts:229–257`). The route checks current canonical base and
   schedules a delta job. `runner/execute.ts:156–170` composes at the new base,
   recomputes inspection and runs the affected checker. `src/features/verdicts.ts:152–164`
   requires complete evidence and identical manifest digests. Changed dependency
   path, mode or bytes requires fresh review (`:94–99`); a passing checker alone
   cannot carry it. Unknown coverage cannot carry.
4. `verdicts.gate` compares the **stored** inspection, active revision/head, pins and
   finding version (`src/features/verdicts.ts:62–82`). It does not reread dependency
   bytes from canonical main. Its alarm is a no-op (`:296`). There is no reverse
   dependency index, landing subscriber, or automatic carry scheduler here.
5. Queue admission and promotion repeat verdict/finding/lease gates
   (`src/features/queue.ts:123–187,598–634`). Queue ordering uses
   **`dependencyChangeIds`**, a different graph (`:146–156`), not `dependencyKeys`.
   On an externally observed main change, the alarm bumps the generation and blocks
   stale-base active entries (`:928–936`). On a successful own promotion,
   `reconcileTicket` sets `observedMain` immediately and bumps generation
   (`:781–803`), without dependency-based reinspection of remaining entries.
   The next alarm does not rediscover that same main change. Generation changes
   invalidate old jobs; new composed-stack checks bind the new canonical base
   (`:684–709`), but they do not mint fresh per-candidate review manifests.

**Answer:** `dependencyKeys` protects explicit review carry using content evidence;
it does **not** automatically re-check dependent verdicts or selectively invalidate
queue entries when a dependency lands. Global main/generation defenses and full
stack checks exist, but are not the missing dependency invalidation mechanism.
Do not market the existing behavior as automatic dependent-review freshness. The
MVP should block remaining old-base entries after own promotions too; the product
can later selectively re-inspect them. This conclusion is from code tracing, not
from a new integration reproduction or a claim that a bad promotion was observed.

`docs/api-verdicts.md` promises complete closure and the carry rules; the runner
only fulfills closure for direct-only graphs such as today's demo policy.
`docs/api-leases.md` still contains placeholder-module prose despite implemented
repos/queue integration. `docs/ARCHITECTURE.md:198–204` correctly scopes semantic
independence to trusted metadata and retains full composed-stack validation.

## 2. Options

Hours are engineering estimates for one engineer familiar with Concord, including
focused tests and integration; not measured timings or additive commitments.
Each adapter still needs lease, publish, runner, manifest and queue agreement.

| Option | Precision | Cost (hours) | Trust model | Failure modes: rename/move; generated; formatting; partial parse | Language reach |
| --- | --- | --- | --- | --- | --- |
| File-only generated inventory | One existing or predeclared file | 4–6 for generator; existing lease engine | Owner runs pinned generator on canonical tree; explicit future paths | Rename/move takes both paths; generated output stays whole-file; formatting conflicts; no parser needed | Any Git file, including Python/SQL |
| Directory/prefix units, creation under held prefix | Subtree lock, deliberately coarse; later per-path reservations | 16–24 end to end | Owner grants anchored prefixes; server validates both actual write paths and prefix fence | Both rename endpoints; moving outside prefix refused; generated directories serialize; formatting costs subtree contention; no parse | All languages; solves unknown future paths |
| TS compiler API symbol units | Named declaration bodies; imports/exports and unassigned bytes consume file | 20–32 for safe TS adapter (prototype much smaller) | Pinned parser and queries on trusted base; candidate syntax is evidence only | Name/path identities break on moves; generated/d.ts fallback; exact bytes preserve churn; diagnostics/overloads/ambiguity fall back | TS/TSX first; JS could be added, no Python/SQL |
| tree-sitter symbol units | Syntax nodes with per-language ownership rules | 32–56 for TS+Python, then 8–16/language | Pin grammar, runtime and capture rules; reject incomplete coverage | Moves need both identities; generated sources coarse; trivia assigned explicitly; ERROR/MISSING nodes force fallback | Broad grammars, but dependency meaning is not portable |
| LSP-derived units | Document/workspace symbols and optional references | 32–60 | Trusted isolated language server, pinned version/config and committed buffers | Workspace URI/name instability; generated-file exclusions vary; ranges shift with formatting; stale/partial server responses fail closed | Broad where a server exists; startup/config costs per language |
| SQL schema from migrations | Table initially, column only with constraints/index/FK dependencies | 32–56 for bounded SQLite DDL subset | Trusted canonical ordered migrations, pinned parser; never run candidate SQL with privileges | Renames/implicit table rebuilds need both tables; generated migrations coarse; SQL formatting can be parsed but reviewed byte identity stays; dynamic SQL/partial parse takes schema unit | SQLite first; dialect adapters required |
| Single-holder sequence unit | Logical stream, e.g. migration number allocation | 8–14 | Owner defines sequence and mandatory path triggers; coordinator fences allocation and landing | Renames cannot escape trigger; generated migration also locks; formatting need not allocate but write still validates; malformed migration holds whole stream | Language independent, protects numbering/order rather than schema meaning |
| Dependency-aware invalidation | Reverse closure of inspected read units plus unknown-scope global invalidation | 4–6 coarse MVP; 20–36 selective product (+2–3 runner closure repair) | Owner-declared/generated conservative graph, evidence pinned to base and registry generation | Moves/deletes invalidate readers; generated inputs/outputs linked; byte churn intentionally invalidates; unknown parses/dependencies invalidate broadly | Any explicit graph; inference is language/build-tool specific |

Compiler API parsing is already available via pinned TypeScript 5.9.3; it does not
require adding a dependency. [Compiler API documentation](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API/7a88664eb88e0151908a8393aad98ef762a31105).
Tree-sitter recovery emits ERROR/MISSING constructs; recovering a tree is not
permission to assign narrow coverage. [Query syntax](https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html).
LSP document symbols provide navigation data rather than an ownership contract;
the lease system must define its own stable identifiers and coverage rules.
[LSP specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_documentSymbol).

## 3. Measurements on Concord

The local branch named `main` is stale (seed only). The local `origin/main` and HEAD
both resolve to the merged mainline commit below; no fetch or ref mutation was
performed. The historical sample uses `git log origin/main --first-parent --merges`.
Use the full recorded SHA for reproduction if remote-tracking refs move.

```text
$ git rev-parse HEAD origin/main main
313548c8f930164a056905197144723d5e779c6f
313548c8f930164a056905197144723d5e779c6f
683013f7b0df481f6982b1b84dd5eb448dfe1854
$ git log main -3 --format='%h %s'
683013f chore: seed repo (MIT license, README, validate gate)
```

### Method and interpretation

`extract-ts-units.ts` reads tracked Git blobs, not working-tree files, recursively
including tests/tools and the declaration file. It uses `ts.createSourceFile` and
counts named top-level functions, classes, interfaces, types, enums, namespaces
and variable declarations. It does not count nested methods, import bindings or
destructured bindings. Shared variable statements share their entire byte range.
Names identify units; exact declaration bytes, including leading trivia, identify
changes. No type checker, module resolution, code execution or dependency inference.

For a diff, a missing path, non-TS path, mode change, generated/declaration file,
parse diagnostic, duplicate binding, declaration addition/removal/reordering,
or changed import/top-level unassigned text consumes the whole file. Both sides
of a rename are retained. EOF bytes and declaration positions in surrounding text
are covered. This is a conservative structural candidate mapper, **not** a
production proof of semantic independence. A class or large exported feature object
remains one declaration; test `describe()` calls usually consume the whole file.

`conflict-history.ts` compares the landing delta `merge^1..merge` for the latest
12 first-parent merges. Each pair is a counterfactual simultaneous lease request;
a whole-file unit conflicts with any symbol in that path, and non-TS files remain
whole-file in both strategies. We report all 66 pairs and the 11 adjacent pairs.
These are **potential lease conflicts**, not observed Git merge conflicts or actual
overlapping agent sessions. Landed history includes repaired conflicts, different
bases and merge-resolution edits; it does not preserve original task intent.
No concurrency timestamps were inferred. The script defaults to 12 and caps at 50.

### Recorded output

The following stdout was captured with Node v26.7.0 and TypeScript 5.9.3. Wall times
are one local run, with Git reads separated from AST extraction; no throughput
claim or controlled benchmark. `tsx` also prints Node's DEP0205 deprecation warning
on stderr; that warning is unrelated to the extraction result.

```text
$ node --import tsx docs/spikes/15/extract-ts-units.ts 313548c8f930164a056905197144723d5e779c6f 1443846
commit=313548c8f930164a056905197144723d5e779c6f node=v26.7.0 typescript=5.9.3
typescript_files=66 top_level_named_symbols=814 fallback_files=1
extract_ms=107.16 total_with_git_ms=1808.29
diff=cf4a5ba..1443846 (first-parent landing delta)
adapters/aw-mock.ts	named-declaration-bytes	ts:adapters/aw-mock.ts#FunctionDeclaration:makeCandidate,ts:adapters/aw-mock.ts#FunctionDeclaration:pollAndMaybeQueue,ts:adapters/aw-mock.ts#FunctionDeclaration:resume,ts:adapters/aw-mock.ts#FunctionDeclaration:runAwMock,ts:adapters/aw-mock.ts#FunctionDeclaration:main
demo/checker.mjs	non-typescript	file:demo/checker.mjs
demo/profile.json	non-typescript	file:demo/profile.json
demo/scenarios.ts	declarations-added-deleted-or-reordered	file:demo/scenarios.ts
runner/profiles.ts	declarations-added-deleted-or-reordered	file:runner/profiles.ts
src/features/queue.ts	named-declaration-bytes	ts:src/features/queue.ts#FunctionDeclaration:dispatchCase
tests/node/demo.test.ts	imports-or-outside-declarations	file:tests/node/demo.test.ts
tests/node/runner.test.ts	imports-or-outside-declarations	file:tests/node/runner.test.ts
```

```text
$ node --import tsx docs/spikes/15/extract-ts-units.ts 313548c8f930164a056905197144723d5e779c6f 313548c
commit=313548c8f930164a056905197144723d5e779c6f node=v26.7.0 typescript=5.9.3
typescript_files=66 top_level_named_symbols=814 fallback_files=1
extract_ms=98.66 total_with_git_ms=1570.38
diff=1443846..313548c (first-parent landing delta)
README.md	non-typescript	file:README.md
demo/main.ts	imports-or-outside-declarations	file:demo/main.ts
demo/scenarios.ts	declarations-added-deleted-or-reordered	file:demo/scenarios.ts
docs/DEMO.md	non-typescript	file:docs/DEMO.md
docs/api-repos.md	non-typescript	file:docs/api-repos.md
docs/deploy.md	non-typescript	file:docs/deploy.md
docs/dev.md	non-typescript	file:docs/dev.md
docs/ui.md	non-typescript	file:docs/ui.md
tests/node/demo.test.ts	declarations-added-deleted-or-reordered	file:tests/node/demo.test.ts
tests/node/deploy.test.ts	imports-or-outside-declarations	file:tests/node/deploy.test.ts
tests/node/docs.test.ts	added	file:tests/node/docs.test.ts
```

```text
$ node --import tsx docs/spikes/15/conflict-history.ts 313548c8f930164a056905197144723d5e779c6f 12
history_ref=313548c8f930164a056905197144723d5e779c6f requested_merges=12 sampled_merges=12
#17 313548c files=11 narrow_ts_files=0
#16 1443846 files=8 narrow_ts_files=2
#15 cf4a5ba files=28 narrow_ts_files=6
#13 0c33d55 files=7 narrow_ts_files=1
#14 7de389e files=6 narrow_ts_files=0
#11 eebf519 files=18 narrow_ts_files=1
#12 22edc8b files=6 narrow_ts_files=1
#9 d752c01 files=5 narrow_ts_files=0
#10 8acae49 files=14 narrow_ts_files=1
#7 001185e files=7 narrow_ts_files=0
#6 f3830ba files=9 narrow_ts_files=0
#8 7fccec8 files=4 narrow_ts_files=0
all_pairs pairs=66 file_conflicts=24 symbol_conflicts=24 ts_file_conflicts=20 ts_symbol_conflicts=20
avoided_pairs=(none)
adjacent pairs=11 file_conflicts=4 symbol_conflicts=4 ts_file_conflicts=4 ts_symbol_conflicts=4
avoided_pairs=(none)
```

PR #16 gives a concrete narrow mapping: changing `dispatchCase` consumes that
function candidate unit, while a declaration/import change in the same landing
still takes its entire file. PR #17's additions and broad edits take file units.
The sample's 24/66 = **36.4%** all-pair overlap and 4/11 = **36.4%** adjacent overlap
are unchanged by conservative symbol mapping. Restricting to TypeScript paths
also leaves 20/66 versus 20/66 and 4/11 versus 4/11. The zero improvement is an
honest result, not evidence that finer units never help: these early slices add
files and modify shared integration surfaces. Collect future same-file independent
body edits before claiming a return on production symbol extraction.

## 4. Registry authority, pinning and refresh

**Authority:** the owner controls allowed namespaces, explicit future paths,
protected configuration paths, generator/checker versions and dependency overrides.
A trusted service enumerates the canonical Git tree. Agents may request units or
propose new namespace policy for review; neither candidate policy files nor agent
supplied ASTs can grant capability. A candidate is always checked against the
registry that authorized its work. Its newly added declarations do not authorize
their own writes.

**Pin:** product registry generation G is an immutable record containing canonical
commit/tree OID, generator/parser version digest, owner rules digest, normalized
unit identities, conservative dependencies and schema version. Canonically hash
that record and bind it into the policy digest used by claim, inspect, review,
reserve and promotion. Keep unit ID distinct from byte digest: a function's body
changes its evidence, not necessarily its identity. Include Git path/mode and
before/after bytes in evidence. Policy changes themselves use a separate owner
workflow and are evaluated using the previous trusted policy.

**After every successful landing:** gate new admissions while a trusted service
reads back the landed canonical OID, generates G+1, validates coverage and reverse
dependency edges, and atomically installs `(canonical OID, registry digest,
generation)` by expected-old comparison. Retry by immutable OID, idempotently;
never install a generation calculated from a superseded tip. An extraction failure
keeps admissions blocked or uses a pre-authorized conservative fallback, never an
empty/partial registry. Record old/new digests and reasons as auditable events.
Outstanding jobs keep their immutable inputs and cannot promote under G+1 without
revalidation. Preserve historical claims/tombstones for deleted and renamed paths
until their leases/reservations terminate; do not resolve an old claim using only
the new inventory. Refresh affects capability and review freshness separately.

**Demo simplification:** generate the current files plus exact planned additions
before starting a demo cohort; include explicit `file:` entries and existing TSV
entries. Keep that installed policy immutable during the cohort. After each
landing, regenerate the inventory from the read-back OID and the same owner
creation plan and compare normalized policy bytes. Record the new source OID in
the owner-side provenance output; it is not yet an enforced product registry field.
If the inventory/dependencies/checker rules are unchanged (planned new files were
already registered), the policy digest stays the same. If they differ, stop
admissions and require a newly provisioned demo cohort with owner-installed pins.
There is no safe hot policy-refresh endpoint today: changing deployed config
alone makes the repository's stored pin disagree (`src/features/leases.ts:40`).
Do not implement direct database edits as an installer workaround.

This compromise supports known new files without pretending the full canonical
registry lifecycle is finished. Concord's delegation allowlist already supplies
the exact future paths for a slice. An owner can approve that list before agents
run; workers cannot add arbitrary modules later without a new authorization.

For product prefixes, use anchored path segments (`src/plugins/`, never string
prefix `src/plugin`), normalized Git-relative paths, explicit protected-path
denials and checks of both old/new paths. For the first version an exclusive
prefix conflicts with every descendant file and overlapping prefix; a held
prefix may authorize a new concrete path without trusting the agent's registry.
The evidence must still list every actual file and byte digest. Existing contracts
assume exact unit equality at publish/reserve (`repos.ts:595–597`, `queue.ts:135–138`),
so this requires a coordinated contract change, not just `overlaps()`.

## 5. Prior art (public primary sources, checked 2026-10-11)

The borrow/avoid statements are design judgments, not claims these systems enforce
Concord's lease model.

| System/source | Borrow or avoid |
| --- | --- |
| [CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) | Borrow owner-reviewed path rules from the base branch and protect the rules themselves; review routing is not write exclusion. |
| [Bazel dependencies](https://bazel.build/concepts/dependencies), [Buck2 owner/rdeps](https://buck2.build/docs/users/query/uquery/) | Borrow build-target ownership and reverse dependency closure for affected checks; targets are useful conservative groups, not proof of complete runtime dependencies. |
| [GitHub merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) | Borrow validation against the combined target-branch state; leases cannot replace that check. |
| [bors](https://bors.tech/), [Mergify batches](https://docs.mergify.com/merge-queue/batches/) | Borrow serialized/batched integration and inspectable batch identity; avoid treating individual green candidates as a green composition. |
| [Google TAP: Taming Google-Scale Continuous Testing](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/45861.pdf) | Borrow dependency-informed test selection and explicit handling of unreliable test signals; do not promise Google's precision from a handwritten unit graph. |
| [Graphite stacks](https://graphite.com/docs/cli-quick-start) | Borrow explicit dependent change chains and restacking UX; keep change ordering distinct from a unit's read dependencies. |
| [Mergiraf](https://mergiraf.org/), [architecture](https://mergiraf.org/architecture.html) | Borrow syntax-aware reconciliation and visible review of merge results; a successful tree merge is not a semantic approval. |
| [Difftastic](https://difftastic.wilfred.me.uk/) | Borrow structural display that reduces formatting noise for reviewers; never omit changed bytes from signed review identity because the display hides them. |
| [SemanticMerge / Plastic SCM](https://docs-plasticscm.azurewebsites.net/semanticmerge/intro-guide/semanticmerge-intro-guide) | Borrow declaration/move awareness for review assistance; supported-language structural matching is not a general behavioral-equivalence checker. |
| [Jujutsu conflicts](https://docs.jj-vcs.dev/latest/conflicts/) | Borrow persistent, explicit unresolved conflict state and provenance; canonical promotion must still require a resolved checked tree. |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) (2025–2026 coordination) | Borrow TTL path reservations and intent communication; its documented reservations are advisory and can be granted with reported conflicts, unlike Concord's enforced reservation gate. |
| [Gas Town](https://github.com/gastownhall/gastown) (2026 multi-agent workspace manager) | Borrow durable work identity and isolated worker worktrees; orchestration and merge workflow do not by themselves establish byte-bound semantic leases. |

These two agent systems are relevant comparators found in public primary sources,
not an exhaustive market survey. Avoid star-count or benchmark claims. The legacy
semanticmerge.com homepage no longer served the tool documentation when checked;
the table deliberately links the vendor's documentation host instead.

## 6. Two implementation tiers

### DEMO MVP — by Tuesday night

Run 15A (4–6h), 15B (2–3h), 15C (4–6h), then 15D (3–4h), allowing 3h integration
within a **16–22h** total. 15A and 15B can be implemented independently, but review
and merge exact candidates serially. 15C is a conservative freshness guard, not a
selective invalidation system. Do not start symbol/prefix/SQL parser work for this
deadline. If time shrinks, keep the existing TSV demo and present this measured
prototype honestly; do not ship a half-enforced authorization extension.

Judges see two workers creating different pre-approved `.ts` modules without
hand-editing a registry per file, one attempt at an unapproved path refused, a
same-file conflict with intent, and a dependent candidate blocked for a fresh
base/review after a landing. The existing row scene still demonstrates actual
finer-than-file leases and explicit unchanged-scope carry. Show local/replay labels
as appropriate; a simulated refusal is not a live integration result.

Must preserve: exclusive lease fencing and TTL; declaration/inspection equality;
independent review; exact checker/policy pins; findings invalidation; queue
reservation ownership; freeze and expected-old canonical promotion; full composed
stack validation; existing TSV carry and contest scenarios. A new file is not
allowed merely because its extension is `.ts`. No agent edits to policy/checker.

### BEST PRODUCT — after the contest

1. **Trusted registry lifecycle and prefix creation (24–40h combined).** Implement
   the generation/CAS/tombstone lifecycle above and bounded creation capabilities;
   benchmark contention from broad prefixes before adding per-path child claims.
2. **Dependency freshness (20–36h).** Index inspected transitive reads in reverse;
   on landing, compare actual changed-unit content with queued/draft manifests,
   mark affected approvals stale, and schedule trusted reinspection. Unaffected
   candidates still need current-base composition. A changed dependency normally
   requires new review, even if its checker passes. Unknown scope invalidates all.
   Within a speculative stack, check each candidate's dependencies against the
   composition containing its predecessors, not just last landed main.
3. **TS adapter (20–32h).** Use path + declaration kind + name initially, explicit
   file fallback for imports/exports/declaration topology and ambiguity. Keep
   compiler-generated numeric symbol IDs out of persistent identities. Authorize
   both endpoints for moves; defer identity continuity heuristics. Collect actual
   same-file contention, fallback rates and extraction latency before rollout.
4. **Python + SQLite (40–70h for sequence plus initial SQL subset; Python adapter
   separately 8–16h after tree-sitter infrastructure).** Start with whole-file
   `shared_interface.py` and `budget_ledger.py`; allow independent modules under
   owner-scoped creation prefixes. Use `sequence:migrations` for order/numbering
   plus a coarse `schema:sqlite` unit, then table units when extraction is proven.
   Foreign keys, indexes, triggers, views, table rebuilds and dynamic SQL require
   wider scope. A sequence lease must be held/reserved until landing or withdrawal,
   with fencing and uniqueness checked at promotion. Abandoned allocations may
   leave gaps; default to uniqueness/monotonicity rather than gapless numbers.

This keeps three independent concepts visible: a write footprint, exclusive
logical resources (sequences), and an inspected read/dependency scope. Neither SQL
column ownership nor Python symbols can replace a budget invariant spanning modules.
Budget-ledger writers serialize initially; tests exercise the shared accounting
invariant over the full composed stack. The Python project is hypothetical here;
no other repository was accessed or measured.

### Ready-to-launch MVP slice specs

These are future delegations, **not authorization to edit their files in this run**.
Each changes one behavior. They use current literal test paths and deliberately
avoid config/lockfile changes. Stop and escalate in each if a listed outcome needs
another file or changes the shared contract beyond the stated scope. Run the
targeted commands and final configured validation; do not deploy automatically.

#### 15A — deterministic owner-side file registry generation (4–6h)

Goal:
  Outcome: Generate an installable file policy for a canonical Git commit and an
  owner-approved exact future-path plan, without candidate-controlled authority.

Done when:
  - `runner/generate-units.ts` reads an explicit commit OID from the owner checkout,
    a trusted policy template and explicit creation-path inputs; stdout is an
    envelope containing source OID, generator version, policy and policy digest.
  - Existing represented TSV units survive; every tracked regular file and every
    approved future path has an explicit `file:` entry. Reject unsafe paths,
    symlinks/submodules, unsupported names, missing dependency keys and ambiguous
    metadata with a precise error rather than silent omission. Enforce current
    512-character/no-whitespace path constraints and show offending paths.
  - Stable canonical JSON hashes the policy excluding its own digest; source OID
    is provenance outside the policy so planned file creation can preserve the
    policy pin. No checker or source execution, no network, no Git mutations.
  - A refresh/compare mode regenerates from a read-back canonical OID, emits
    unchanged/changed status and nonzero on changed policy; documentation requires
    stopping admissions and owner reprovisioning on change. It never hot-installs.
  - Node tests demonstrate deterministic output, correct digest, a path absent
    from Git but explicitly approved, preserved rows/dependencies, unsafe paths
    rejected, and changed versus unchanged refresh behavior.

Allowed files:
  - runner/generate-units.ts
  - tests/node/generate-units.test.ts
  - docs/api-leases.md

Validation:
  - npm run typecheck
  - npm run test:target -- tests/node/generate-units.test.ts
  - sh scripts/validate.sh

#### 15B — complete runner dependency evidence (2–3h)

Goal:
  Outcome: Runner inspection includes the same transitive trusted dependency scope
  that verdict normalization requires.

Done when:
  - `inspectUnits` uses the existing `trustedDependencyKeys` semantics instead of
    direct-only collection, with sorted deduplication and bounded cycle traversal.
  - A→B→C inspection includes B and C; cycle behavior agrees with the existing
    helper, including a changed unit reached by a cycle. Invalid or missing scope
    yields unknown coverage and never a falsely complete manifest.
  - Tests compare actual Git-derived manifest evidence with `normalizeManifest`,
    including chained whole-file dependencies and supported TSV rows; existing
    direct-row behavior passes. No relaxation of validator rules or new parsers.

Allowed files:
  - runner/units.ts
  - tests/node/runner.test.ts

Validation:
  - npm run typecheck
  - npm run test:target -- tests/node/runner.test.ts
  - sh scripts/validate.sh

#### 15C — stale-base queue blocking after own promotion (4–6h)

Goal:
  Outcome: A successful own promotion cannot leave other old-base entries eligible
  using approval evidence inspected before canonical main advanced.

Done when:
  - Successful promotion reconciliation blocks each remaining active old-base
    entry with `STALE_MAIN`, including affected contests, through existing queue
    transition rules. Promoted members still land and release their reservations
    normally. No automatic review carry, policy mutation or dependency inference.
  - Own-promotion and external-main observation paths have equivalent stale-base
    safety; reconciliation retries are idempotent, obsolete results cannot make a
    ticket, and current generation/freeze/CAS checks remain intact.
  - Worker tests cover a queued A depending on B, B landing before A, and no ticket
    for A until withdrawal/rebase/republish/review/re-enqueue through existing
    routes. An unrelated old-base entry is deliberately blocked too. Also cover
    a same-stack landing, open contest and reconciliation replay.
  - Document the conservative queue behavior, manual recovery and the difference
    between `dependencyKeys` and `dependencyChangeIds`.

Allowed files:
  - src/features/queue.ts
  - tests/workers/queue.test.ts
  - docs/api-queue.md

Validation:
  - npm run typecheck
  - npm run test:target -- tests/workers/queue.test.ts
  - sh scripts/validate.sh

#### 15D — real TypeScript creation demo (3–4h; depends on 15A–C)

Goal:
  Outcome: A bounded local scene demonstrates file leases on actual TypeScript
  files, with trusted planned creation and canonical refresh evidence.

Done when:
  - A new standalone `demo/lease-files.ts` uses existing demo clients/helpers and
    15A's generator to construct a temporary fixture with two pre-approved future
    `.ts` files; no change to the existing TSV default scene. Use existing local
    bridge/runner APIs and a pinned fixture checker, never fabricated events.
  - Two different file claims succeed, same-file contention refuses with intent,
    an unapproved third path fails claim/publish, and an approved new file passes
    actual inspection/review/queue. Independent reviewer credentials stay separate.
  - Checker uses the pinned local TypeScript toolchain to typecheck the composed
    fixture and verify its bounded expected exports. Checker registration uses
    the existing generic profile mechanism, with no special admission bypass.
  - After each actual landing, run generator compare against the read-back OID;
    save source OID/policy digest in scene evidence, stop if refresh changes policy.
    Show 15C's stale-base block/recovery for a second queued candidate.
  - Node integration test asserts the real API/result evidence and fails on missing
    stages; docs provide the literal invocation and retain visible local labels.
    Keep existing TSV carry/contest scenario tests passing.

Allowed files:
  - demo/lease-files.ts
  - demo/lease-files-checker.mjs
  - tests/node/lease-files.test.ts
  - docs/DEMO.md

Validation:
  - npm run typecheck
  - npm run test:target -- tests/node/lease-files.test.ts tests/node/demo.test.ts
  - sh scripts/validate.sh

## 7. Risks and owner decisions

| Decision/risk | Recommended default |
| --- | --- |
| Tuesday capacity versus unrestricted new modules | Approve exact paths from the delegated slice allowlist before launch; freeze each demo cohort's registry. Prefix creation is post-contest. |
| Global stale blocking reduces throughput and can affect contest UX | Accept explicit withdrawal/rebase/review for the MVP; never sell it as selective invalidation. Gate 15C on existing contest tests. |
| Current direct/transitive mismatch | Land 15B before using chains; until then use only direct leaf dependencies and do not disable manifest closure validation. |
| Incomplete real-world dependency graph | Treat unknown dependencies as broad invalidation and fresh review. TS imports and Python imports alone miss dynamic loading, SQL access and shared budgets. |
| Refresh requires new contract/state lifecycle | Keep MVP provenance owner-side and stop on policy changes. Product gets atomic generation installation; no silent config reload or direct storage patch. |
| Policy digest loader validates format, not content | Owner tooling must compute and check the digest; schedule server-side digest verification with the product registry lifecycle. Do not accept agent-generated policy bytes. |
| Move/refactor identity | Require old and new paths; retain tombstones and force review. Delay automatic symbol lineage and code-move matching. |
| Generated output or parser recovery | Whole-file/source-generator group fallback; explicit diagnostics. Do not silently omit unparsed bytes. |
| Migration order versus table disjointness | One sequence holder for all migrations initially; coarse schema lock as well. Independent table edits can still share numbering and foreign-key constraints. |
| SQLite state and budget-ledger invariants | Lease source schema/migrations, not live database rows; validate migrations on disposable state and run composed invariant checks. Keep ledger module exclusive initially. |
| Claimed benefit from tiny history sample | Report 12 landed PRs, denominator and zero pair savings; gather concurrent task telemetry before selecting symbol granularity as a product default. |
| Arbitrary repositories exceed 16 normalized units or path syntax limits | Fail visibly and split work under current limits. Do not silently truncate generated policy or claims; product prefixes need a separate contract decision. |
| Extraction time and trust isolation | Parse in a bounded trusted runner; pin dependencies, cap file/byte counts, and keep compiler/source execution separate from registry extraction. |

## Validation and evidence limits

The scripts are read-only prototypes and are not imported by production or wired
into package scripts. Repository `tsconfig.json` excludes `docs`, so a separate
explicit no-emit compile is required for them (see [README](15/README.md)).
No production tests or code were changed, and no throwaway test file was created.
No native child reviewer is exposed in this run; internal review is unavailable.
The launcher still validates and an independent acceptor reviews the exact commit.
The worker's actual validation outcomes are recorded in the final handoff report.
