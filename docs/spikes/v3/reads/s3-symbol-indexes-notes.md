# Language Server Protocol 3.17 specification — document and workspace symbols
URL: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
Fetched: 2026-10-15 22:37:09 UTC; method: `curl -fL --retry 2 'https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/' -o "$TMPDIR/lsp-3.17-specification.html"`
Raw SHA-256: 93afdf15adbaa7355cd00d0134de05331b8dcc9361ffdd11d3da0924cab20579
Extracted words: 1864 (`wc -w "$TMPDIR/lsp-document-symbols.txt" "$TMPDIR/lsp-workspace-symbols.txt"`)
Read status: read in full
## Sections
1. Document Symbols Request
   The request returns either a flat `SymbolInformation[]` list or a hierarchical `DocumentSymbol[]`; the spec prefers the richer hierarchy when possible and explicitly says a flat result’s location and container name cannot be used to reconstruct hierarchy. Capabilities negotiate hierarchical symbols, supported kinds, tags, dynamic registration, and a display label; the server advertises a document symbol provider and may support progress and partial results. `SymbolKind` classifies broad kinds, while `DocumentSymbol` has a name, kind, optional detail and tags, an enclosing range, a selection range contained within it, and optional children; `SymbolInformation` instead has a location and optional UI-oriented container name, and is deprecated in favor of the newer structures. These are descriptive records with ranges and names, not persistent identity: the protocol specifies no stable ID across edits.
2. Workspace Symbols Request
   This request searches project-wide symbols by query, with an empty query allowed to ask for all symbols; its capability and provider can be dynamically registered and report progress or partial results. The legacy response uses `SymbolInformation`; the recommended `WorkspaceSymbol` may carry only a URI initially when the client advertises resolve support, then resolve a range lazily, preserving optional opaque `data` between request and resolve. Names, kinds, tags, container labels, and locations describe and navigate symbols, but neither container names nor positions create a stable cross-edit identity. This is a lookup interface and says nothing about ownership, claims, leases, or exclusivity.
## What it means for Concord v3
LSP defines symbol discovery and navigation, not claims: using these records for claims could express symbol-level presence and intent, but it does not define exclusive locking or a claim declared up front with a task. That fits the described v3 presence-claim direction and leaves exclusivity to a separate policy; the hierarchical response can identify nested constructs, while the flat form cannot safely imply nesting from ranges or container names. Identity is positional/descriptive (URI/ranges plus names and kinds), with no stable ID across edits, so a Concord claim keyed to this data needs refresh/reconciliation when text moves or names change. The protocol defines request/response shapes and optional lazy range resolution but no per-edit cost: document-symbol computation occurs when a client requests the current document’s symbols, and workspace lookup/indexing cost is implementation-defined; neither makes a guarantee of incremental work per edit.

# SCIP Code Intelligence Protocol (README, reference, and schema)
URL: https://github.com/sourcegraph/scip
Fetched: 2026-10-15 22:37:52 UTC; method: `git clone --depth 1 https://github.com/sourcegraph/scip.git "$DELEGATE_SCRATCH_DIR/scip"` (HEAD e26a0b0fc83424dbfe6c703c0437d4703aec4aa0)
Raw SHA-256: `Readme.md` 8293a785d17246c747f4eff4b585fc369ddc98058d8b15fdc252b311319c844a; `docs/scip.md` 404d3474f4f50d58406eb053a6d2f7d4906da68e98c15b32755ab6c4cdb63e5c; `scip.proto` fd5c58c4d140cdef9fff936dfc33d3459ab5b6cfbb9a24a8bde163cf45194ef3
Extracted words: 6884 (`wc -w "$DELEGATE_SCRATCH_DIR/scip/Readme.md" "$DELEGATE_SCRATCH_DIR/scip/docs/scip.md" "$DELEGATE_SCRATCH_DIR/scip/scip.proto"`)
Read status: read in full
## Sections
1. SCIP Code Intelligence Protocol
   SCIP is a language-agnostic index format for navigation features, with a protobuf schema, language bindings, and a CLI. The README directs indexer authors to separate indexer guidance and consumers to the schema or bindings; it describes production and consumption, not coordination among authors or agents.
2. Contributing
   Contributions follow the project’s development guide and code of conduct. This section gives project contribution guidance, not a model for repository claims or access control.
3. Installing CLI
   The CLI can be downloaded as a release binary or built from a shallow clone with Go. This describes tooling setup only.
4. SCIP CLI reference
   The CLI exposes conversion from SCIP to LSIF, snapshot rendering, and index statistics. Its global interface does not specify indexing freshness or work on each source edit.
5. `scip convert`
   Conversion accepts an input SCIP index and output LSIF path, with defaults. It is a whole-index format conversion operation.
6. `scip snapshot`
   Snapshot generation creates visual files for golden-test inspection, marking occurrences and symbol information. It is a diagnostic view of index contents.
7. `scip stats`
   Statistics reads a SCIP index, defaulting to `index.scip`. No incremental-update behavior is promised.
8. Semantic Code Intelligence Protocol (SCIP) reference
   The generated reference defines schema records and enums, including document paths, occurrence positions, symbol descriptors, relationships, and metadata. It stresses complete workspace indexes and compact, streamable protobuf payloads; it does not define live agent claims.
9. Descriptor
   A descriptor records a name, optional disambiguator, and suffix that identifies its role in a symbol path. Its components help distinguish same-named constructs but do not include source positions.
10. Suffix
   Suffix distinguishes namespace, type, term, method, type parameter, parameter, macro, meta, and local descriptors; the older package suffix aliases namespace. Namespace meaning varies with language conventions, such as packages or modules.
11. Diagnostic
   A diagnostic carries severity, message, optional code and source, and tags for a document. It is analysis feedback attached to indexed code.
12. Document
   A document contains a language string, canonical relative path, occurrences, definitions, and folds. The path must be unique relative to the project root, use slash separators, and avoid noncanonical components and symlinks.
13. FoldingRange
   A fold has a kind, replacement text, and a range encoded like occurrence positions. It represents editor presentation data rather than identity.
14. Index
   An index is a complete workspace rooted at one directory and includes metadata, documents, and optional external symbols. Because payloads can be large, producers and consumers should stream fields; metadata occurs first and once.
15. Metadata
   Metadata identifies protocol version, indexer tool information, absolute project root, and on-disk text encoding. These fields establish the index’s provenance and coordinate context.
16. Occurrence
   An occurrence ties a source range to an optional symbol, semantic roles, syntax kind, diagnostics, and contextual documentation. Ranges are zero-based three- or four-integer line/character positions; the schema chose compact integers after benchmarks found substantially smaller indexes than a nested range representation.
17. Package
   A package records manager, name, and version, and corresponds to language-specific packaging conventions. Those values participate in a symbol’s qualified identity.
18. Relationship
   Relationships connect symbols for reference search, implementation navigation, and type-definition navigation, which can have different target sets. The examples distinguish a shared conceptual method from its implementation and show why these relationships are explicit.
19. Symbol
   A symbol string is URI-like and consists of a scheme, package coordinates, and descriptors, or a local form. Descriptors along the AST ancestry form a fully qualified name intended to be unique within the package; this is a semantic identifier rather than a line/column coordinate.
20. SymbolInformation
   Symbol information binds that canonical symbol string to optional repeated Markdown documentation and relationships. Occurrences refer to the symbol string, allowing references in different documents to point to the same definition.
21. ToolInfo
   Tool metadata records indexer name, version, and invocation arguments. It supports provenance and debugging of produced indexes.
22. DiagnosticTag
   Diagnostic tags classify unnecessary and deprecated diagnostics, with an unspecified value for schema compatibility. They annotate diagnostics rather than symbols.
23. FoldingRangeKind
   The enum distinguishes general regions, comments, and imports. It has no bearing on symbol identity.
24. Language
   The language enum standardizes common language identifiers, while the document field remains a string so new or uncommon languages are possible. Adding enum values follows an explicit ordered-numbering process.
25. ProtocolVersion
   The current schema shown defines only an unspecified protocol version value. Versioning remains an index metadata concern.
26. Severity
   Severity ranges from unspecified through error, warning, information, and hint. It classifies diagnostics only.
27. SymbolRole
   Roles are a bitset describing definitions, imports, reads, writes, generated code, and tests. They enrich each occurrence without changing its referenced symbol identity.
28. SyntaxKind
   Syntax kinds classify comments, punctuation, keywords, identifiers, literals, regex pieces, and markup. The enum aims to share highlighting categories across languages, not to create symbols.
29. TextEncoding
   Text encoding currently supports UTF-8 and UTF-16, allowing consumers to interpret source coordinates. This matters when mapping stored positions back to editor text.
30. Index (protobuf message)
   The wire message holds one metadata record followed by repeated documents and optional external symbol information. The schema supports streaming and separately indexed dependencies.
31. Metadata (protobuf message)
   The message records version, tool, project root, and text encoding. It establishes how paths and positions in the index should be interpreted.
32. ProtocolVersion (protobuf enum)
   The enum currently has only an unspecified value. Producers still encode the version field in metadata.
33. TextEncoding (protobuf enum)
   The enum distinguishes unspecified, UTF-8, and UTF-16. It is document-coordinate context, not a change-tracking mechanism.
34. ToolInfo (protobuf message)
   This message identifies the producing indexer, its version, and command-line arguments. It allows consumers to understand index provenance.
35. Document (protobuf message)
   A document stores a language, canonical project-relative path, occurrences, defined symbols, and folds. A workspace index groups these records under one project root.
36. Symbol (protobuf message)
   The message’s scheme, package, and descriptor path encode a symbol’s standardized qualified name, with a separate local-symbol grammar. The identity is intended to survive mere source movement as long as semantic naming and package coordinates remain stable; renames or changed disambiguation can change it.
37. Package (protobuf message)
   Manager, name, and version identify the package coordinate in the symbol grammar. They scope cross-file symbol names.
38. Descriptor (protobuf message)
   Names, disambiguators, and typed suffixes encode each path component, with a `Local` suffix available for local identities. Stable identity depends on indexer choices for names and disambiguators, not on a source position supplied by the protocol.
39. SymbolInformation (protobuf message)
   This message supplies the canonical symbol identifier, documentation, and graph relationships. The occurrence’s symbol field points back to it, separating entity identity from each source occurrence.
40. Relationship (protobuf message)
   Boolean relationship flags define how one symbol participates in reference, implementation, and type-definition navigation. They preserve distinctions that cannot be inferred from spelling alone.
41. SymbolRole (protobuf enum)
   The enum uses bit values for definition, import, read/write access, generated code, and test code. Roles classify a particular occurrence of a symbol.
42. SyntaxKind (protobuf enum)
   This enum gives shared highlighting categories, including language-specific identifier roles and literals. Aliases retain older names where needed for schema compatibility.
43. Occurrence (protobuf message)
   An occurrence stores compact zero-based line and character bounds plus symbol, roles, highlighting, contextual docs, and diagnostics. The schema is position-based for each occurrence even when the associated semantic symbol has a stable qualified name.
44. Diagnostic (protobuf message)
   Diagnostics include severity, message, optional source and code, and tags. They attach analysis results to a document range through occurrences.
45. Severity (protobuf enum)
   The enum defines error, warning, information, and hint levels in addition to an unspecified value. It has no claim semantics.
46. DiagnosticTag (protobuf enum)
   Tags mark diagnostics as unnecessary or deprecated. This is a small classification enum.
47. Language (protobuf enum)
   The schema enumerates common language names while preserving string extensibility in documents. The numbered values follow a maintained list and reserve the next value for additions.
48. FoldingRangeKind (protobuf enum)
   The values classify region, comment, or import folds. They support editor structure without contributing symbol identities.
49. FoldingRange (protobuf message)
   A folding record stores kind, display text, and compact source range. It is presentation metadata.
## What it means for Concord v3
SCIP is a symbol identity and navigation format, not a claim protocol: it specifies no presence/intent claims, exclusive locks, or claims declared up front with a task. Its cross-file, fully qualified symbol strings and occurrence references could underpin symbol-level claims, and are materially more stable across edits than LSP line/column locations when package, name, and disambiguation remain unchanged; local IDs and indexer rename/disambiguation policies need care. It agrees with the described v3 interest in symbol-aware coordination while leaving lease policy entirely to Concord. The required artifact is a complete workspace index, and the CLI works on an index file; SCIP does not promise per-edit incremental indexing or give a per-edit cost, so indexer/compiler work and refresh strategy determine cost and freshness. Streaming reduces peak memory for large indexes, not the amount of analysis required. The Cursor example in the brief concerns agent-managed locks on a shared TASKS coordination file, not file locks; these symbol-index sources provide no evidence that changes that finding.

# GitHub stack-graphs — stack graph model
URL: https://github.com/github/stack-graphs
Fetched: 2026-10-15 22:38:43 UTC; method: `git clone --depth 1 https://github.com/github/stack-graphs.git "$DELEGATE_SCRATCH_DIR/stack-graphs"` (HEAD fcb7705d5b38ae13b3665a9b2c882e5a97243d44)
Raw SHA-256: `README.md` 0f9fb88d9934160ce005879f5e17051ca062fe2451e9bb67f2e3c528547fb2c3; `stack-graphs/README.md` bda89af23a3932bf2eb24c027ef76d86265262a986d211fe3ca6cea290abe9af; `tree-sitter-stack-graphs/README.md` 159de507af6c6fd494680455843169bb4feb38d1ae1af5e750f8b04ded76ba6d; `tree-sitter-stack-graphs/examples/README.md` 76fda4b99f1e1ef9c799b845cf8e77c6c316f3b728c1d8983ba74443e37b4bae
Extracted words: 981 (`wc -w "$DELEGATE_SCRATCH_DIR/stack-graphs/README.md" "$DELEGATE_SCRATCH_DIR/stack-graphs/stack-graphs/README.md" "$DELEGATE_SCRATCH_DIR/stack-graphs/tree-sitter-stack-graphs/README.md" "$DELEGATE_SCRATCH_DIR/stack-graphs/tree-sitter-stack-graphs/examples/README.md"`)
Read status: read in full
## Sections
1. Stack graphs
   The repository describes stack graphs as a Rust implementation of language name-resolution rules that avoids requiring existing build or program-analysis tools. It calls the approach efficient and incremental; the README does not specify persistent symbol IDs or coordination claims.
2. How to contribute
   This section points contributors to project guidelines and conduct rules and describes the licensing terms for submissions. It adds no details about graph identity or indexing behavior.
3. Credits
   The project credits scope graphs from Eelco Visser’s group as its foundation. This establishes conceptual lineage, not the details of the stack-graph algorithm.
4. License
   The root project is offered under Apache 2.0 or MIT. No runtime or identity guarantees are made here.
5. stack-graphs
   The Rust crate exposes the stack-graph implementation and points to generated API documentation for use. Its summary repeats that language name-resolution rules can be incremental and independent of full build/program-analysis tools.
6. Credits
   The crate also attributes its foundations to scope graphs. This is context rather than an operational specification.
7. License
   The crate uses the same dual-license choice as the repository. This does not affect how a graph lookup is keyed.
8. tree-sitter-stack-graphs
   This crate constructs stack graphs from Tree-sitter grammars and language-specific rules. Its README points to the API and examples rather than specifying persistent identities.
9. Using the API
   Consumers add the crate as a Rust dependency and use the generated API documentation. The section offers no per-edit cost contract.
10. Using the Command-line Program
   The CLI indexes a source directory into a database, skips files already indexed by default, and can force re-indexing; queries take a source path, line, and column to find definitions. It exposes status and clean operations, demonstrating stored incremental analysis while revealing a position-based query interface.
11. Getting Started on a new Language
   A language project is generated from a Tree-sitter grammar and language metadata, then customized with stack-graph rules. Examples demonstrate binding patterns, including nested scope, sequential definitions, and modules/imports.
12. Development
   The project is Rust-based and documents build, test, formatting, and CLI commands. This is contributor workflow, not additional graph semantics.
13. License
   The Tree-sitter integration is dual licensed under Apache 2.0 or MIT. It inherits the repository’s licensing choices.
14. Examples
   Each example isolates a name-binding pattern and pairs a `.tsg` rule file with tests; examples use Python syntax without claiming complete Python semantics. The examples can run tests and render graph visualizations, making them concrete illustrations of rules and behavior rather than a generalized language specification.
## What it means for Concord v3
Stack graphs model name resolution, not agent coordination: they do not define presence/intent claims, exclusive locking, or claims declared with tasks. Their language-specific rules and edges could inform symbol-level relationships and resolve references across scope, but the listed docs do not expose a stable symbol ID across edits; the documented CLI lookup uses source path, line, and column, so the visible handle is positional and internals’ cross-edit persistence are unspecified. The incremental indexing description and skip-existing-file default suggest reuse of unchanged file work, while forced re-indexing is available; no per-edit latency or cost guarantee is stated. This complements SCIP’s explicit symbol identity and LSP’s navigation records, but the docs do not establish that a stack-graph node alone is a safe durable lease key.

## Source summary

| URL | Extracted words | Read status |
| --- | ---: | --- |
| https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/ | 1864 | read in full |
| https://github.com/sourcegraph/scip | 6884 | read in full |
| https://github.com/github/stack-graphs | 981 | read in full |

