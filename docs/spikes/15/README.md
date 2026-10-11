# Lease-unit measurement prototypes

See [the design spike](../15-lease-units.md). These scripts read this repository's
Git objects and print measurements; they do not generate trusted production
policies, modify Git, run candidate code, or write result files.

Use the repository's installed dependencies (TypeScript 5.9.3 and tsx 4.20.6).
Run from the repository root:

```sh
node --import tsx docs/spikes/15/extract-ts-units.ts 313548c8f930164a056905197144723d5e779c6f 1443846
node --import tsx docs/spikes/15/conflict-history.ts 313548c8f930164a056905197144723d5e779c6f 12
```

The extractor's first argument is the inventory commit (default `origin/main`).
Its optional second argument is a landing commit; the diff is from its first
parent, so a root commit is not a valid second argument. It reports tracked TS,
TSX, MTS and CTS files, top-level named declaration count, AST extraction time,
total time including Git blob reads, and each changed file's units/fallback reason.
The inventory count includes named declarations in fallback files. Generated-file
detection is only a filename/header heuristic, not a complete classifier.

The history script's arguments are mainline ref (default `origin/main`) and merge
count (default 12, maximum 50). It selects first-parent merge commits and uses
`merge^1..merge` deltas; squash-only histories need a different sampling policy.
No merges means zero pairs; do not interpret that as measured absence of conflict.
No Git fetch occurs. This worktree's local `main` was the seed commit, so the spike
uses the pinned `origin/main` OID instead of changing local refs.

File conflicts count intersecting changed paths. Symbol conflicts count intersecting
named declaration units, with file fallback conflicting with any unit in that path.
Non-TypeScript paths always remain whole-file. Both all-pairs and adjacent-pairs
counts are counterfactual lease contention, not Git merge simulation or observed
parallel execution. TS-only columns remove non-TS path overlaps, not PRs. No
dependency-based conflicts are inferred. A syntactically disjoint change can still
affect another symbol's meaning.

Names include declaration kind; bodies retain exact text including leading trivia.
Imports, top-level statements, EOF changes, altered declaration order/set, ambiguous
bindings, parse errors, mode changes, additions/deletions and known generated files
fall back to whole-file. Moves are deletion plus addition. Multi-variable statements
share bytes, so changing one may conservatively report all their binding units.
Class methods and exported object properties are not subdivided. The scripts use
bounded Git subprocesses (30 seconds, 32 MiB output each); they are intended for
this small repo, not untrusted large-repository service deployment.

Repository typecheck does not include `docs`; explicitly check both prototypes:

```sh
./node_modules/.bin/tsc --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --types node docs/spikes/15/extract-ts-units.ts docs/spikes/15/conflict-history.ts
npm run typecheck
sh scripts/validate.sh
```

Node 26 may print a `module.register()` DEP0205 warning from tsx. Timings vary with
machine/load/cache; retain the commit, Node and TypeScript versions beside results.
The scripts add no dependency, package command, fixture or generated output.
