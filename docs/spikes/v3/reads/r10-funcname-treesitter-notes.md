# Git userdiff.c
URL: https://github.com/git/git/blob/HEAD/userdiff.c
Fetched: 2026-10-15 20:31:01 UTC; method: `git clone --depth 1 https://github.com/git/git.git "$DELEGATE_SCRATCH_DIR/git-source"`
Raw SHA-256: 7c7b212bfe2c5be9abf2ebc90f595bc05fc034fbf549bfd1f67580b2f48f856b
Extracted words: 2010 (`wc -w < "$DELEGATE_SCRATCH_DIR/git-source/userdiff.c"`)
Read status: read in full
## Sections
1. File setup and pattern-construction macros. `PATTERNS` and `IPATTERN` install extended regexes for function names and token-like word regexes, with case-insensitive matching for the latter macro; the multi-byte fallback differs when libc regex handles UTF-8. Built-ins are alphabetically ordered except `default`, and the code comments explicitly permit permissive patterns on syntactically correct input.
2. Built-in language drivers: Ada through CSS. Ada excludes continuation/import-like lines before procedure/function/package declarations; bash recognizes POSIX and bash function spellings and shell tokens, BibTeX captures entry keys, and C++ intentionally treats broad top-level declarations as chunks while excluding labels. C# uses keyword exclusions and permissive method/property/type/namespace patterns, while CSS matches selector-like lines and has identifier/number tokenization.
3. Built-in language drivers: DTS through Java. DTS targets property-like lines; Elixir recognizes definitions/tests and its atoms/operators; Fortran is case-insensitive and rejects comments and module-procedure lines; Fountain recognizes screenplay scene/action headings. Go recognizes functions and struct/interface type declarations, HTML h1-h6 headings, INI sections, and Java class-like declarations and methods while excluding statement keywords; Java constructors are deliberately not matched as indistinguishable from calls.
4. Built-in language drivers: Kotlin through Perl. Kotlin catches `fun`, class, and interface declarations; Markdown recognizes ATX headings; MATLAB handles class/function and code-section markers; Objective-C recognizes methods, C functions, and class/protocol declarations after excluding common statements. Pascal recognizes routine and record/class forms, while Perl handles package/subroutine/special-block/POD headers and custom token rules for prototypes, attributes, and operators.
5. Built-in language drivers: PHP through TeX and default. PHP recognizes functions with visibility/modifier prefixes and class-like declarations; Python recognizes class, async def, and def; R recognizes function assignments, Ruby recognizes class/module/def, and Rust recognizes visibility/modifier-prefixed item declarations. Scheme targets top-level forms and definition forms, Swift recognizes declaration keywords and attributes, and TeX recognizes sectioning commands; `default` has no special patterns.
6. Special drivers and lookup callback. `diff=true` and `!diff` represent forced text and forced binary behavior. The name callback compares a configured prefix-length name and stops at a match, while UTF-8 capability detection checks whether the regex engine consumes a two-byte character as one match.
7. Configuration parsing and driver lookup. `userdiff_config` parses `diff.<driver>.<type>` keys, creates custom drivers as needed, and stores function-name, binary, external command/trust-exit-code, textconv/cache, word-regex, and algorithm settings. `userdiff_find_by_name` lazily chooses the multi-byte word regex when the runtime check supports it; path lookup resolves the `diff` attribute into forced true/false, unset, or a named driver.
8. Text conversion and iteration. Textconv lookup returns nothing when no converter is configured and initializes a notes cache only when requested and a Git directory exists. Driver iteration visits custom entries first, then all built-ins, stopping immediately when the callback returns nonzero.
## What it means for Concord v3
Git's model gives named diff drivers a regex hook for chunk/function headers, a separate word-tokenization regex, and attribute-based per-path selection; Concord's described server-side forge can use the distinction between syntax-aware chunk boundaries and token presentation when designing diffs. This source does not prescribe a parser, store, lease, issue, or event model, and its broad regexes knowingly trade syntax completeness for permissive display. That supports offering heuristics as display metadata rather than treating inferred symbols as authoritative coordination units; it does not establish any decision about Concord's claims or server architecture.

# gitattributes - Defining attributes per path
URL: https://git-scm.com/docs/gitattributes
Fetched: 2026-10-15 20:31:48 UTC; method: `curl -fL https://git-scm.com/docs/gitattributes -o "$DELEGATE_SCRATCH_DIR/gitattributes.html"`
Raw SHA-256: 575d5a86d81d327987883ace626eb526c2eb5a4c0fe244d91ce9d7cedfdc2de8
Extracted words: 7855 (`wc -w < "$DELEGATE_SCRATCH_DIR/gitattributes.txt"`)
Read status: read in full
## Sections
1. NAME. The manual names the mechanism as defining attributes per path. This establishes path selection as the subject of the page.
2. SYNOPSIS. Attributes may come from `$GIT_DIR/info/attributes` and `.gitattributes`. The configuration sources have different scope and precedence.
3. DESCRIPTION. Rules match pathnames, assign each attribute as set, unset, string-valued, or unspecified, and later matching lines override earlier ones per attribute. Attribute file precedence runs from repository info and nearest in-tree file outward, then global/system; missing worktree files fall back to index data in the documented cases. Patterns follow gitignore rules with stated exceptions, and `!` resets an attribute to unspecified.
4. RESERVED BUILTIN_* ATTRIBUTES. The `builtin_*` namespace is reserved; user definitions are ignored and warn. `builtin_objectmode` allows filtering by indexed file mode and has specified behavior for objects absent from the index.
5. EFFECTS. Attributes influence Git operations across checkout/checkin, diff generation, merging, whitespace, archives, packing, and GUI display. The page then specifies each operation's attribute behavior independently.
6. Checking-out and checking-in. These attributes transform content as files enter and leave the working tree, including index normalization. The section describes text, encoding, identity substitution, filtering, process protocol, and interactions between conversions.
7. text. `text` enables LF normalization on checkin, with checkout conversion controlled by eol/configuration. Unset disables conversion, `auto` asks Git to detect text and avoids converting previously CRLF-stored content, and unspecified defers to `core.autocrlf`.
8. eol. `eol` selects worktree line endings and only matters with `text` or `text=auto`; setting it implicitly sets text when otherwise unspecified. `crlf` and `lf` choose checkout representation, with config/platform defaults applying when unspecified.
9. Backwards compatibility with crlf attribute. Legacy `crlf`, `-crlf`, and `crlf=input` map to `text`, `-text`, and `eol=lf`. This preserves earlier line-ending conventions.
10. End-of-line conversion. Examples show repository-wide auto normalization and per-extension exceptions; `core.safecrlf` detects irreversible conversions with reject or warning behavior. Safety can trigger even for operations whose immediate action does not rewrite the worktree, subject to documented exceptions.
11. working-tree-encoding. Git can re-encode a declared worktree encoding to UTF-8 in the index and back on checkout. Compatibility with clients that lack support, round-trip failures, and conversion cost are explicit risks; examples pair encoding with line-ending declarations.
12. ident. With the attribute enabled, checkout expands `$Id$` to a blob identifier form and checkin collapses matching expanded forms. The substitution is narrowly defined.
13. filter. Named clean/smudge filters transform content at checkin and checkout; long-running `process` filters take precedence. Missing or failing filters default to passthrough unless `required` is true, and idempotence properties matter for clean/smudge correctness.
14. Long Running Filter Process. Git negotiates protocol version 2 and clean/smudge/delay capabilities, sends command/path metadata and pkt-line content, then expects status and output framing. The manual details success, error, abort, restart, and required-filter exit semantics.
15. Delay. A delay-capable filter may defer smudging and must implement `list_available_blobs`; Git waits for available paths and later requests their content. An empty available list ends polling, and still-missing blobs fail.
16. Example. The page points to Git's example implementation and packet tracing aids, and warns that single-blob clean/smudge commands use a different protocol from `process`. This limits direct substitution between filter modes.
17. Interaction between checkin/checkout attributes. Checkin runs filter, ident, then text; checkout runs text, ident, then filter. Ordering is part of the canonicalization behavior.
18. Merging branches with differing checkin/checkout attributes. `merge.renormalize` virtually checks out and checks in all merge stages to avoid spurious conflicts from changed canonical formats. Filters that are not normalization-safe may still create conflicts.
19. Generating diff text. The `diff` attribute controls textual versus binary handling, driver selection, hunk headers, external diff commands, and text conversion. The section distinguishes the four attribute states and driver configuration.
20. diff. Set forces text; unset forces binary output; unspecified lets Git inspect content and size; a string selects a named driver. Per-driver options live in Git configuration, while path assignment is in attributes.
21. Defining an external diff driver. A configured external command receives the path's diff and can report significance with trusted exit codes. Driver definitions belong in gitconfig even though the manual describes them here.
22. Setting the internal diff algorithm. A named driver can select myers, patience, minimal, or histogram for user-facing diff and stat output. It does not configure merge machinery, and external commands make this setting ineffective.
23. Defining a custom hunk-header. `xfuncname` selects the text displayed after hunk coordinates, and a `.gitattributes` mapping activates the configured driver. The page explains config backslash escaping and enumerates the built-in language patterns, including the available language coverage.
24. Customizing word diff. `wordRegex` controls token splitting for word diff, with TeX as an example and built-in patterns for the listed languages. This tokenization is distinct from selecting hunk-header lines.
25. Performing text diffs of binary files. `textconv` converts a binary file to displayable text and may cache conversions. The output is generally one-way and unsuitable as an applicable patch; only diff/log-family commands use it.
26. Choosing textconv versus external diff. External diff offers format-specific freedom, while textconv reuses Git's line-oriented diff and features such as coloring, word diff, merge diffs, and caching. Choice depends on the data and desired output.
27. Marking files as binary. Unsetting `diff` suppresses textual output, while textconv can still support human-readable views via a named driver. The page documents that `-diff` and `diff=<name>` cannot both be assigned and shows the driver `binary` option.
28. Performing a three-way merge. The `merge` attribute chooses built-in behavior or a custom driver for file-level merges. Set, unset, unspecified, and string values have distinct semantics.
29. merge. The built-in text merge marks conflicts, binary keeps the current branch's worktree version while leaving conflict state, and union combines both sides' lines with potentially random ordering. A named value selects a custom merge driver.
30. Built-in merge drivers. `text`, `binary`, and `union` are explicitly named built-ins with the behaviors above. Union output requires verification because ordering may be arbitrary.
31. Defining a custom merge driver. Git configuration supplies the command, name, and recursive driver; placeholders provide ancestor/current/other files, conflict size, path, and labels. The command writes the result to `%A`, and exit codes distinguish clean merge, conflict, and driver failure.
32. conflict-marker-size. This attribute selects a positive integer marker width for conflicted worktree merges. The example raises the default width for a particular documentation path.
33. Checking whitespace errors. The per-path `whitespace` attribute refines the project-wide `core.whitespace` rules. Its four states include inherit, disable, all known errors, or an explicit comma-separated list.
34. whitespace. Set detects all known potential whitespace errors, unset detects none, unspecified inherits configuration, and a string names the checks. Tab width still comes from `core.whitespace`.
35. Creating an archive. Archive-related attributes decide file inclusion and placeholder substitution. Substitution depends on having a commit ID and limits `describe` expansion for denial-of-service protection.
36. export-ignore. Marked files and directories are omitted from archives. This is a packaging control, not a worktree deletion.
37. export-subst. Marked files expand supported pretty-format placeholders wrapped in `$Format:...$` when archived from a commit or tag. Trees without commit identity do not substitute.
38. Packing objects. The `delta` attribute can disable blob delta compression on a path. It affects object packing efficiency rather than textual diff display.
39. Viewing files in GUI tools. The `encoding` attribute supplies a display encoding for GUI clients, with `gui.encoding` fallback when absent or invalid. Gitk requires a manual setting to use per-file encodings for performance reasons.
40. USING MACRO ATTRIBUTES. Macro attributes let one set attribute expand into related settings; built-in `binary` unsets `text` and `diff`. Macros themselves can only be set, though their expansion may unset or unspecified other attributes.
41. DEFINING MACRO ATTRIBUTES. Custom macros may only appear in top-level attribute sources, not subdirectory `.gitattributes`. The built-in `binary` macro expands to `-diff -merge -text`.
42. NOTES. Git does not follow symlinks when reading worktree `.gitattributes`. This keeps resolution consistent with index/tree access.
43. EXAMPLES. The worked example applies matching rules from nearest subdirectory through parent attributes and then repository info overrides, including set/unset/unspecified outcomes. It demonstrates per-attribute precedence rather than replacing the entire attribute set as a unit.
44. SEE ALSO. The page points to `git-check-attr` for inspecting effective attribute assignments. This is the practical query companion for understanding path resolution.
45. GIT. The closing heading identifies this as part of the Git command suite. It contains no additional attribute semantics.
## What it means for Concord v3
The `Generating diff text` section, especially `Defining a custom hunk-header` and `Customizing word diff`, supports a concrete split between per-path driver choice, chunk-header matching, and token splitting. `DESCRIPTION` and `EXAMPLES` show that path rules have precedence and explicit unspecified states, useful when a forge selects diff behavior across repository and user policy. These Git mechanisms do not provide shared file/symbol leases or establish that regex-derived chunks are safe coordination units; the page offers no basis to overturn the supplied Concord v3 architecture, and is limited to content handling, display, and merge behavior.
 
# Pattern Matching with Queries
URL: https://tree-sitter.github.io/tree-sitter/using-parsers/queries/
Fetched: 2026-10-15 20:33:22 UTC; method: `curl -fL https://tree-sitter.github.io/tree-sitter/using-parsers/queries/ -o "$DELEGATE_SCRATCH_DIR/ts-queries-index.html"`
Raw SHA-256: be5d751439bacd5d44762453e1d4ac8f77c484ada8bdc091f3a03c6b3ffe6656
Extracted words: 48 (`wc -w < "$DELEGATE_SCRATCH_DIR/ts-queries-index.txt"`)
Read status: read in full
## Sections
1. Pattern Matching with Queries. Tree-sitter queries provide a pattern language for finding code structures without writing custom parsing logic. Their S-expression patterns target syntax-tree structure and are similar to patterns used in Tree-sitter's own tests.
## What it means for Concord v3
The introduction frames queries as reusable structural searches over parsed code, which could support semantic browsing alongside Git's line-based hunk headers. It does not propose locks, claims, or a source of authoritative symbols for Concord v3.

# Query Syntax
URL: https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html
Fetched: 2026-10-15 20:33:31 UTC; method: `curl -fL https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html -o "$DELEGATE_SCRATCH_DIR/ts-query-syntax.html"`
Raw SHA-256: 2db3d4963d21946ca1dce36d4cf444562e7d9724dcffe2d768fccfeedda4d7ec
Extracted words: 651 (`wc -w < "$DELEGATE_SCRATCH_DIR/ts-query-syntax.txt"`)
Read status: read in full
## Sections
1. Query Syntax. A query has one or more S-expression patterns that name a node type and optionally constrain its children. Child patterns can be omitted, so a pattern can match a node based on only a selected child.
2. Fields. Prefixing a child pattern with its field name narrows a structural match, such as requiring an assignment's left member object to be a call. Field constraints make queries more precise than matching a node type alone.
3. Negated Fields. A `!field` constraint matches a parent only when that field is absent. The example captures a class identifier only for declarations without type parameters.
4. Anonymous Nodes. Quoted names select punctuation and other anonymous grammar nodes, such as a literal `!=` operator. This complements named-node matching and can pin a query to exact syntax.
5. Special Nodes. The section covers wildcard, ERROR, and MISSING query forms. Missing nodes represent inserted zero-width recovery tokens and are separate from ERROR nodes.
6. The Wildcard Node. `(_)` matches any named node, while `_` also includes anonymous nodes; both let a query ignore a subtree's exact type. A capture can label the wildcard match.
7. The ERROR Node. Parser error nodes can be matched and captured with `(ERROR)`. This makes malformed source discoverable through ordinary query execution.
8. The MISSING Node. Recovery-inserted missing tokens can be queried even though they are zero-width and internally represented on a terminal node. These queries detect errors that `(ERROR)` alone misses, and can specify an expected node type or literal.
9. Supertype Nodes. Grammar supertypes let a query match any member subtype through a single abstraction, including an explicit `supertype/subtype` form. The examples cover both named and anonymous subtypes and note that a supertype need not be visible in the concrete tree.
## What it means for Concord v3
These queries make matches depend on grammar-defined nodes, fields, and error recovery, so syntax-aware symbol extraction can be structurally richer than userdiff's permissive regex patterns. Their results still depend on grammar and parse state, including missing/error nodes; the supplied v3 context does not establish that query matches should become lease boundaries or canonical ownership units.

# Operators
URL: https://tree-sitter.github.io/tree-sitter/using-parsers/queries/2-operators.html
Fetched: 2026-10-15 20:33:35 UTC; method: `curl -fL https://tree-sitter.github.io/tree-sitter/using-parsers/queries/2-operators.html -o "$DELEGATE_SCRATCH_DIR/ts-query-operators.html"`
Raw SHA-256: a74a0c393df385a8d9c63564f78b537b385a7ed74ce1a4807752fdf3993749c7
Extracted words: 1174 (`wc -w < "$DELEGATE_SCRATCH_DIR/ts-query-operators.txt"`)
Read status: read in full
## Sections
1. Operators. Query operators capture nodes, quantify and group sibling patterns, express alternatives, and constrain adjacency/order. Their behavior is described with query examples and match outputs.
2. Capturing Nodes. Captures attach names beginning with `@` to selected syntax nodes so callers can retrieve those nodes from a match. The examples distinguish the function identifier from its containing class or assignment.
3. Quantification Operators. `+` and `*` match one or more or zero or more sibling nodes, while `?` marks a node optional. Captures attached to quantified patterns may collect multiple nodes or none.
4. Grouping Sibling Nodes. Parentheses group a sequence of sibling patterns, and quantifiers can apply to the whole sequence. The example recognizes repeated comma-and-number pairs.
5. Alternations. Square brackets express alternatives and captures may label a choice or the full alternation. Quantifiers can be applied inside alternatives and to the alternative itself, producing different match and capture groupings as demonstrated.
6. Anchors. The `.` anchor restricts a child to first, last, or immediate-sibling positions among named nodes, depending on placement. Anonymous nodes do not count toward those constraints.
7. Anchors with Quantifiers and Groups. Anchors next to optional or repeating patterns have position-sensitive behavior when those patterns match zero nodes. Edge anchors constrain the nearest node that did match, but anchors cannot sit at the edge of a group or alternation because those are not nodes.
## What it means for Concord v3
Captures offer explicit role labels over matched nodes, while quantifiers and anchors control which neighboring syntax elements belong to each result. This makes query definitions inspectable and expressive for code navigation, but does not resolve multi-agent ownership, cross-file dependencies, or safe lease granularity described in the v3 context.
 
# Predicates
URL: https://tree-sitter.github.io/tree-sitter/using-parsers/queries/3-predicates-and-directives.html
Fetched: 2026-10-15 20:33:39 UTC; method: `curl -fL https://tree-sitter.github.io/tree-sitter/using-parsers/queries/3-predicates-and-directives.html -o "$DELEGATE_SCRATCH_DIR/ts-query-predicates.html"`
Raw SHA-256: a601c2c2351ca947b79c3734cbc0731b09f6faa38279ebb20af84aff4821b957
Extracted words: 973 (`wc -w < "$DELEGATE_SCRATCH_DIR/ts-query-predicates.txt"`)
Read status: read in full
## Sections
1. Predicates. Predicate S-expressions attach text conditions or metadata to a query pattern using names beginning with `#` and ending in `?`. The CLI's standard predicates are introduced as a layer around structural matches.
2. The `eq?` predicate. The equality family compares a capture's text to another capture or a literal string, with negated and `any-` variants. Quantified captures match only when all nodes satisfy the predicate unless the `any-` form is used.
3. The `match?` predicate. This family compares capture text to a regular expression and supports `not-` and `any-` forms. Examples identify uppercase constants, documentation comments, and C code embedded in Go comments.
4. The `any-of?` predicate. A capture matches when its text equals any one of a supplied list of strings. The example identifies a set of JavaScript built-in names.
5. The `is?` predicate. This predicate asserts a property on a capture, with `is-not?` negating that property. The CLI example combines it with a regex to identify built-ins that are not local variables.
6. Directives. Directives attach metadata or transform capture text and end in `!` rather than `?`. The CLI implements a standard set, but the note later clarifies they are not executed by the C library itself.
7. The `set!` directive. `set!` associates arbitrary key-value metadata with a pattern, such as an injection language on a captured Doxygen comment. Higher-level code can read that property and choose subsequent parsing behavior.
8. The `#select-adjacent!` directive. It narrows one capture's associated text to nodes adjacent to a second capture. The manual points to the code-navigation page for its application alongside `#strip!`.
9. The `#strip!` directive. `#strip!` removes text matching a supplied regular expression from a capture. Its purpose is demonstrated in code-navigation documentation for removing comment markers.
10. Recap. The recap lists equality, regex, membership, and property predicates plus negation and quantified-capture behavior. It separately lists metadata, adjacency selection, and stripping directives.
11. Note. Predicates and directives are structured information, not operations performed directly by the Tree-sitter C library. Higher-level bindings implement some common cases, and the documented standard set may grow.
## What it means for Concord v3
Structural queries can carry text filters and capture metadata, but execution semantics vary by CLI or binding because the C library exposes rather than interprets these features. Concord should therefore treat query/tag output as dependent on a chosen implementation and query bundle; this documentation does not define authorization or ownership semantics.

# The Query API
URL: https://tree-sitter.github.io/tree-sitter/using-parsers/queries/4-api.html
Fetched: 2026-10-15 20:33:42 UTC; method: `curl -fL https://tree-sitter.github.io/tree-sitter/using-parsers/queries/4-api.html -o "$DELEGATE_SCRATCH_DIR/ts-query-api.html"`
Raw SHA-256: 6accf6c0a654081ebcf99f5839764e3229b861c3cf0e9d3f1dd3b0e6848bc7f4
Extracted words: 350 (`wc -w < "$DELEGATE_SCRATCH_DIR/ts-query-api.txt"`)
Read status: read in full
## Sections
1. The Query API. A query compiles to an immutable, thread-shareable `TSQuery`; execution uses a stateful cursor that should not be shared between threads but can be reused. Cursor iteration returns matches with pattern indices and captured nodes, and compile errors report offsets and categories.
2. Restricting the Query Range. Cursor ranges can be expressed as byte offsets or row/column points, with variants that require captured nodes to lie fully inside the range. Ordinary range methods return matches that intersect it, including partial overlap.
3. Note. An end value of zero means unbounded, so `(0, 0)` represents the whole tree rather than an empty range. Callers must account for this special case when using range-limited queries.
## What it means for Concord v3
The API separates reusable query definitions from per-execution cursor state and offers bounded ranges for partial-file analysis. This could inform implementation and resource handling for code navigation, but it is an API behavior description rather than an architecture for Concord's one-operation table or agent runs.

# Code Navigation Systems
URL: https://tree-sitter.github.io/tree-sitter/4-code-navigation.html
Fetched: 2026-10-15 20:33:47 UTC; method: `curl -fL https://tree-sitter.github.io/tree-sitter/4-code-navigation.html -o "$DELEGATE_SCRATCH_DIR/ts-code-navigation.html"`
Raw SHA-256: 61ddd17d3970dbe4351806f8960985d870f917f497273fd231591dd382a0e887
Extracted words: 725 (`wc -w < "$DELEGATE_SCRATCH_DIR/ts-code-navigation.txt"`)
Read status: read in full
## Sections
1. Code Navigation Systems. Tree-sitter queries can power navigation systems, and the `tags` command demonstrates emitting textual records for interesting syntax nodes. The page connects this approach to GitHub's search-based navigation and explains that language grammars can extend it.
2. Tagging and captures. Tags identify named program entities through syntax queries and captures; the convention encodes role and kind in `@role.kind` and captures the identifier as `@name`. Optional `@doc` captures and adjacency/strip directives support associated documentation text.
3. Examples. The examples progress from capturing a Python function definition to a JavaScript assignment/arrow function and Ruby class/singleton-class tags with cleaned adjacent comments. The page proposes common role/kind names while allowing applications to extend or recognize only a subset.
4. Command-line invocation. `tree-sitter tags` runs a tags query file over input files and emits entity name, kind/role, source range, first line, and optional docstring. The expected query location is `queries/tags.scm` in each language grammar repository.
5. Unit Testing. `tree-sitter test` checks tags queries under `test/tags/` using the same comment-based expectation style as highlight tests. The Ruby example marks expected module, class, and method definitions.
## What it means for Concord v3
Tree-sitter tags provide grammar-based roles and names, with a shared vocabulary that supports definitions, references, calls, and documentation. The tag output is produced by per-language query files and tests, so language coverage and quality depend on those artifacts; unlike Git's built-in regex drivers, this is structured navigation data, but neither source establishes that tags are stable enough to gate claims or issue coordination.

## Source index

| URL | Extracted words | Read status |
| --- | ---: | --- |
| https://github.com/git/git/blob/HEAD/userdiff.c | 2010 | read in full |
| https://git-scm.com/docs/gitattributes | 7855 | read in full |
| https://tree-sitter.github.io/tree-sitter/using-parsers/queries/ | 48 | read in full |
| https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html | 651 | read in full |
| https://tree-sitter.github.io/tree-sitter/using-parsers/queries/2-operators.html | 1174 | read in full |
| https://tree-sitter.github.io/tree-sitter/using-parsers/queries/3-predicates-and-directives.html | 973 | read in full |
| https://tree-sitter.github.io/tree-sitter/using-parsers/queries/4-api.html | 350 | read in full |
| https://tree-sitter.github.io/tree-sitter/4-code-navigation.html | 725 | read in full |
