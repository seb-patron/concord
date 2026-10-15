# Mononoke: Sapling README and Mononoke design documentation
URL: https://github.com/facebook/sapling/tree/79071c2a3ea20c36ed71332608535e5801101bba/eden/mononoke
Fetched: 2026-10-15 20:30:49 UTC; method: `git clone --filter=blob:none --sparse https://github.com/facebook/sapling "$DELEGATE_SCRATCH_DIR/sapling"`; `git -C "$DELEGATE_SCRATCH_DIR/sapling" sparse-checkout set eden/mononoke`; read `eden/mononoke/README.md` and every `*.md` recursively under `eden/mononoke/docs/` with `cat`.
Raw SHA-256: 8e5a9e9981bfb2b88dd4893d02351ace4372dec3781fc47d0019d69093ab0768 (`{ cat "$DELEGATE_SCRATCH_DIR/sapling/eden/mononoke/README.md"; while IFS= read -r f; do cat "$f"; done < "$DELEGATE_SCRATCH_DIR/mononoke-docs-list.txt"; } | shasum -a 256`)
Extracted words: 51606 (`{ cat "$DELEGATE_SCRATCH_DIR/sapling/eden/mononoke/README.md"; while IFS= read -r f; do cat "$f"; done < "$DELEGATE_SCRATCH_DIR/mononoke-docs-list.txt"; } | wc -w`)
Read status: read in full
## Sections
1. **Caveat Emptor** — The open source export omits some internal functionality, notably Thrift APIs, MySQL failover, CacheLib integration, and configuration documentation. It directs readers to tests for configuration clues and notes Linux as the main platform.
2. **Subsystem Docs** — Only a few subsystem Markdown guides are included in this overview, pointing readers to integration tests, packblob storage, and the graph walker. Documentation coverage is explicitly incomplete.
3. **Introduction** — Mononoke is a Rust server intended for very large repositories and high commit throughput. It is part of the Sapling ecosystem and is positioned as backend infrastructure.
4. **The Sapling Ecosystem** — The client CLI, on-demand EdenFS, and Mononoke server divide user commands, file materialization, and history/branch serving. Their integration keeps large repositories from needing full local checkout.
5. **Why Mononoke Exists** — Scale, availability, multiple VCS clients, and separated read/write work motivate the design. The overview claims horizontally scaled services, redundancy, caching, and asynchronous indexing as mechanisms.
6. **What Mononoke Does** — The service accepts commits, serves history and file data, manages bookmarks and policies, and stores mappings and derived indexes. Pushrebase, cross-repo sync, Commit Cloud, and hooks extend the core repository operations.
7. **Deployment Scenarios** — Stateless HTTP servers, specialized services and jobs, mutable SQL state, immutable blobstores, caches, and several client protocols make up a distributed deployment. Capacity is increased by scaling service instances.
8. **A Brief History** — Mononoke began with Mercurial and Bonsai, adopted EdenAPI/SLAPI as Sapling evolved, and added Git through VCS-neutral storage. Rust is named as the implementation language.
9. **Design Principles** — Immutability and content addressing support integrity and caching; separating stored core data from computed indexes keeps writes lean. Facets and horizontal scaling are the stated composition and growth principles.
10. **What's Next?** — The document routes readers to concepts, architecture, and code navigation guides. It frames itself as introductory material rather than implementation reference.
11. **Bonsai** — Bonsai is the canonical commit representation for inputs from Git, Mercurial, and Sapling, with flat file changes and separately stored file blobs. Blake2b identifiers link changesets into a tamper-evident DAG.
12. **Content Addressing** — Mononoke uses hashes as identifiers, while distinguishing fully addressed, logically addressed, and non-content-addressed records. Immutability, integrity checks, deduplication, and Merkle ancestry are the advantages described.
13. **Repository Facets** — Trait-based facets give repository features explicit, composable capabilities instead of one monolithic object. Functions declare needed facets through bounds, supporting modularity and test repositories.
14. **Derived Data** — Indexes and VCS-specific structures are regenerated from Bonsai and content, then computed asynchronously. This reduces synchronous commit work while requiring derivation and backfill infrastructure for reads.
15. **Blobstore** — An immutable key-value interface stores commits, files, and derived artifacts across interchangeable backends. Decorators add caching, multiplexing, compression, and redaction; composition gives flexibility and added layering.
16. **Metadata Database** — SQL holds mutable bookmarks, graph indexes, mappings, and operational state, while blobstore content stays immutable. The separation permits transactions for references and scalable storage of content.
17. **VCS Mappings** — Database mappings translate Bonsai IDs to Git, Mercurial, and other external identities in both directions. They let multiple client formats share one internal history.
18. **Related Documentation** — Links lead to architecture, Bonsai, facets, derived data, and storage explanations. The section establishes a path from definitions to deeper design material.
19. **Introduction** — Mononoke is described as a distributed server assembled from Rust libraries, with state externalized to blobstore and databases. The architecture emphasizes independent scaling, multiple VCS representations, distinct read/write paths, and composable facets.
20. **System Architecture: Service Composition** — Frontends, internal microservices, and shared storage divide request protocols, expensive coordination, and persistence. A service deployment and the internal library layering are separate architectural views.
21. **Service Tiers** — Three tiers classify protocol handlers, dedicated internal operations, and common backend storage. Their separation allows distinct scaling and avoids tying every request to specialized work.
22. **1. Frontend Services (Stateless)** — SLAPI, Git, LFS, and SCS frontends authenticate and translate client requests into repository operations. Their lack of durable local state permits load-balanced horizontal replicas.
23. **2. Internal Microservices** — Land, derived-data, diff, and bookmark services isolate serial or computationally expensive work. Frontends can remain responsive while those workloads scale independently.
24. **3. Backend Storage** — Blobstore contains immutable payloads and derived artifacts; SQL contains mutable bookmarks, mappings, indexes, and repository state. Shared persistence enables stateless service instances.
25. **System Diagram** — The diagram connects CLI, EdenFS, Git, and service clients through protocol frontends to microservices and common storage. It visualizes the same division of responsibilities described in prose.
26. **Service Architecture Characteristics** — Independent scaling, workload isolation, coordinated landing, separate deployments, and resource-specific provisioning are highlighted. Mutual exclusion is localized to the operation requiring it rather than imposed across all work.
27. **Relationship to Code Architecture** — Deployment tiers and reusable library layers are explicitly orthogonal. Each binary can share storage, types, and repository code while serving a distinct protocol or task.
28. **Code Architecture: Internal Application Structure** — A common layered Rust implementation underlies servers, tools, and jobs. The code view explains how applications compose foundation libraries into user-facing functionality.
29. **Application Layering** — Applications use common components, repository facets, features, an optional API abstraction, and a binary framework. Dependencies flow from application code downward toward foundational storage and types.
30. **1. Common Components (Foundation Layer)** — Context, blobstore, utilities, core types, configuration, and permission primitives are the reusable base. They avoid repository-level policy and aim for limited mutual dependencies.
31. **2. Repository Attributes (Composition Layer)** — Facets package identity, storage, graph, derivation, mapping, bookmark, permission, and hook capabilities. A facet container assembles the capabilities needed by each repository.
32. **3. Features (High-Level Operations)** — Pushrebase, sync, rewriting, redaction, history, and cache operations compose facets without owning repository state. Trait bounds expose each operation's dependencies.
33. **4. API Layer (Optional)** — `mononoke_api` offers repository, changeset, file, and tree abstractions over implementation details. It gives protocol code a more stable interface, though not every application uses it.
34. **5. Application Framework (cmdlib)** — `mononoke_app` standardizes arguments, configuration, monitoring, shutdown, and repository setup. Shared startup behavior reduces per-binary operational variation.
35. **How Applications Use These Layers** — Servers, tools, and microservices choose different subsets of API and feature layers while reusing the same facets and foundations. This permits one feature implementation to serve multiple entry points.
36. **Data Model and Flow** — Bonsai and file blobs are the inherent source of truth; read-oriented formats and indexes are computed from them. The model explains why writes and reads follow different work paths.
37. **The Bonsai Data Model** — Bonsai is a VCS-independent, content-addressed graph suited to minimal high-throughput writes. Git and Mercurial formats can be converted around this shared representation.
38. **Write Path vs. Read Path** — Commit ingestion stores core objects and updates essential metadata, while readers consume computed manifests and protocol forms. The separation trades immediate derived-data availability for shorter write latency.
39. **Write Path: Core Data Only** — Validation, Bonsai conversion, blob writes, mappings, graph updates, hooks, and bookmark movement form the synchronous push work. Derived indexes stay outside that critical sequence.
40. **Read Path: Derived Data** — Reads obtain manifests, blame, and VCS-native objects through asynchronous or on-demand derivation. Dependencies and backfills make these representations recomputable and versionable.
41. **Request Flow Example: Fetching a File** — A client request passes through protocol handling and API abstractions to derived-data, mapping, and blobstore facets. Cache layers reduce repeated backend access.
42. **Storage Architecture** — The architecture pairs immutable blob storage with mutable SQL metadata and places caches above storage. Each layer is optimized for its data's mutability and access pattern.
43. **Immutable Blobstore** — The blobstore holds file contents, Bonsai changesets, derived structures, and VCS forms across multiple backend choices. Decorators provide prefixing, caching, multiplexing, compression, redaction, and fault-repair support.
44. **Mutable Metadata Database** — SQL indexes bookmarks, VCS mappings, graph relationships, phases, update history, and counters. Its transactional role complements immutable blob storage.
45. **Caching Strategy** — Process-local and shared caches plus warm bookmark state reduce storage reads and startup work. Cache modes can be configured for operation and debugging.
46. **Architectural Characteristics** — VCS neutrality, asynchronous derivation, facet composition, statelessness, decorators, and microservice delegation are the principal tradeoffs. In particular, eventual consistency follows from keeping derivation off the synchronous write path.
47. **Putting It All Together** — Service composition, library dependencies, and data movement are considered together to explain end-to-end behavior. Reads, writes, and derivation workers have distinct paths through the system.
48. **Service Composition** — Frontends handle client requests and backend storage supplies data, while write operations may delegate landing and later derivation. Stateless replicas and specialized services support the scale model.
49. **Code Layer Dependencies** — Binaries depend on optional API abstractions, features, facets, then foundation libraries. Downward-only knowledge is presented as a way to keep dependencies testable.
50. **Data Flow Patterns** — Pushes synchronously store core changes, pulls read derived forms, and background workers compute and persist indexes. The patterns make eventual read preparation explicit.
51. **Directory Organization** — Repository libraries, server binaries, jobs, and tools are listed in separate architectural groups. Their locations express the distinction between reusable implementation and deployed applications.
52. **Next Steps** — The document points to code navigation and focused data-model, facet, derivation, and storage guides. Component READMEs provide more local implementation detail.
## What it means for Concord v3
Mononoke supports the v3 draft's named **server-side change landing** direction: serialized bookmark updates and atomic movement are appropriate for repository state that must be coordinated. Its repo-level locking and single-service serialization describe specific data-integrity mechanisms, not evidence that locks on files or shared task lists are harmful; the Cursor correction in the supplied context remains essential. The stateless service, immutable content, mutable SQLite/SQL metadata split, and async derivation are useful comparisons for the draft's **one TypeScript/Bun server with git and SQLite on a VPS**, while Mononoke's many protocol services and heavyweight derivation stack are not requirements for Concord. Mononoke's hook validation, update logs, and jobs are analogous to the draft's **one operation table for HTTP/CLI/MCP**, **events over WebSocket**, and **runs/swarms on issues or milestones** only at a design-principle level: Concord's operations and issue lifecycle are different domain units. Multi-VCS mapping and Git protocol support agree with the draft's Git-first forge and **one-way GitHub mirror**, but Sapling's separate client and Mononoke's Bonsai model do not directly imply adopting either representation.
53. **Overview** — The codebase is organized by deployment role and internal layer, with navigation guided by the architecture document. The guide emphasizes where to look rather than cataloguing every directory.
54. **Directory Organization Principles** — Components usually sit in category/component directories with Rust source and BUCK definitions. Flat crate naming and a shared ownership annotation are presented as repository conventions.
55. **Two-Level Hierarchy** — Category directories group component crates, which commonly contain source, build definitions, and optional Cargo metadata. This repeated shape is intended to make broad code exploration predictable.
56. **Flat Namespace for Crates** — Descriptive crate names avoid collisions in Rust's flat namespace. The examples show names reflecting functionality or backend rather than generic labels.
57. **Oncall Specification** — BUCK files identify an owning oncall through a conventional declaration. This locates operational ownership alongside build metadata.
58. **Finding Components by Layer** — Foundation utilities, repository facets, features, derivations, APIs, and applications occupy recognizable areas. The layer is the first clue for where implementation belongs.
59. **Base Components (Foundation)** — `common`, `blobstore`, `mononoke_types`, and `cmdlib` provide generic utilities, storage abstractions, core types, and executable scaffolding. They are described as repository-agnostic foundations.
60. **Repository Attributes (Facets)** — `repo_attributes/` is the home for composable repository capabilities such as mappings, bookmarks, storage, permissions, and events. Feature dependencies can be inferred from their build files.
61. **Features Layer** — `features/` contains stateless operations assembled from repository facets, although some related functionality remains elsewhere during refactoring. The document treats directory placement as a useful but imperfect guide.
62. **Derived Data** — The `derived_data/` tree houses its manager, remote coordinator, bulk tools, and individual computed formats. The list is explicitly partial and notes roughly 22 types.
63. **API Layer** — `mononoke_api/` abstracts repository, changeset, tree, and file access, with Mercurial extensions nearby. Historical direct access to lower layers still exists.
64. **Servers, Jobs, and Tools** — Executable applications share the library layers but differ in network, continuous-work, and operator-invoked roles. This is the application side of the system architecture.
65. **Servers** — Frontend protocol servers and internal microservices are grouped by responsibility, with SCS called out as not yet migrated into `servers/`. Protocol handlers can also be reusable libraries.
66. **Jobs (Background Workers)** — Walker, healer, sync, and statistics processes perform maintenance and asynchronous work. Their continuous lifecycle distinguishes them from servers and one-shot tools.
67. **Tools (Command-Line Utilities)** — Administrative and specialized executables handle operations such as import, verification, and maintenance. The admin CLI is identified as the main operator interface.
68. **Clients** — Client libraries and command-line tools live in a separate area from server applications. They provide access to Mononoke protocols and services.
69. **VCS Integration** — Git, Mercurial, and LFS implementations have dedicated code areas, while mappings and shared repository logic connect them to Bonsai. Directory names help locate protocol-specific behavior.
70. **Configuration and Metadata** — Configuration, macros, and repository metadata occupy their own top-level components. The guide notes legacy naming in `metaconfig/`.
71. **Testing** — Integration tests use `.t` fixtures and BUCK targets, while unit tests generally live alongside Rust code. The component README links expand on the integration harness.
72. **Other Key Directories** — Operational, legacy, authorization, storage, benchmarking, and third-party areas fill out the broad tree. Facebook-specific code and generated OSS metadata mirror or support the public layout.
73. **Finding Specific Functionality** — Facets, derived types, tests, servers, and storage implementations each have suggested search paths. The examples turn the directory guide into task-oriented navigation.
74. **How to Find a Facet Implementation** — Start in `repo_attributes/`, identify the capability crate, then inspect nearby SQL implementation and dependencies. This reflects the interface/storage split.
75. **How to Find a Derived Data Type** — Look in its named `derived_data/` directory and in manager registration for integration. The implementation and framework responsibilities are separate.
76. **How to Find Tests** — Co-located unit tests and `.t` integration tests serve different levels of coverage. Pushrebase examples identify how source and integration tests can be found together.
77. **How to Find a Server's Implementation** — Protocol-specific directories contain server and handler code, while BUCK files identify binaries. SCS remains the stated exception to the server-directory grouping.
78. **How to Find Storage Implementation** — Blobstore backend names locate immutable storage, while SQL implementations are usually nested under the relevant facet. This directs search by data responsibility.
79. **BUCK File Patterns** — A conventional Rust library declaration records source globbing, ownership, OSS metadata, and dependencies. Build dependencies provide a practical map of architectural coupling.
80. **Rules of Thumb** — A short concern-to-directory index covers capabilities, operations, storage, derivation, servers, jobs, tools, VCS, utilities, tests, and configuration. It recommends README or search exploration when the location is unclear.
81. **Common Navigation Scenarios** — Bookmark, endpoint, derived type, storage, and protocol tasks are decomposed into likely interfaces, implementation, and tests. The examples stress tracing across layers.
82. **"I need to modify bookmark behavior"** — Bookmark interfaces, movement, caches, and SQL storage are separate areas to inspect. The scenario exposes that one capability crosses facet and operation boundaries.
83. **"I need to add a new server endpoint"** — Choose the protocol server, find its handler layer, compare neighboring endpoints, and add integration coverage. Similar patterns shorten implementation discovery.
84. **"I need to add a new derived data type"** — The procedure spans a new type directory, derivation implementation, manager registration, and tests. It illustrates framework registration as a required integration step.
85. **"I'm debugging a storage issue"** — First distinguish blobstore from SQL metadata, then inspect decorators or facet storage and use walker/healer tools. Diagnosis follows the physical storage boundary.
86. **"I need to understand a protocol"** — Git, Mercurial, SLAPI, LFS, and SCS have named protocol implementation locations. The guide maps concepts to both wire handlers and service interfaces.
87. **Documentation Locations** — High-level, component, type, and integration-test documentation are stored near their subject areas. Documentation is distributed rather than centralized.
88. **Summary** — Layering, two-level organization, descriptive names, and consistent build/test patterns are the navigation model. The recommended workflow starts from the concern and follows existing examples.
89. **Introduction** — Bonsai is the single VCS-neutral representation; inherent inputs are separated from recomputable indexes and protocol views. The source-of-truth boundary is central to Mononoke's write-throughput design.
90. **Inherent Data vs. Derived Data** — Changesets, file blobs, and preserved original VCS bytes form core history, whereas indexes and alternate formats may be regenerated. Only core facts need to participate in the primary commit path.
91. **Bonsai Changesets** — A changeset contains parents, metadata, and a flat mapping of changed paths, with some VCS-specific fields retained. The structure is defined in Mononoke types and supports snapshot/subtree cases.
92. **Metadata Fields** — Commit identity, dates, messages, and VCS extras preserve semantics across formats. Optional Git committer fields allow Mercurial-like commits to fit the same representation.
93. **Parents** — A changeset records parent identifiers to link history. Those references also contribute to the content-addressed DAG.
94. **Author Information** — Author name, email, and authored time are core metadata. They remain distinct from committer identity where the source VCS provides both.
95. **Committer Information** — Optional committer identity and time preserve Git's author/committer distinction. Their absence accommodates inputs without that concept.
96. **Commit Message** — The textual description is included in the changeset representation. It is part of the immutable commit content and its identifier.
97. **VCS-Specific Extra Fields** — Mercurial extras, Git headers, and annotated-tag information carry format-specific semantics; a legacy tree-hash field is marked unused. Such fields support compatibility but complicate the common model.
98. **File Changes** — Bonsai stores full paths with additions, modifications, deletions, and untracked snapshot changes rather than nested tree objects. Copy metadata and Git LFS treatment can accompany tracked changes.
99. **File Type Information** — Regular, executable, symbolic-link, and submodule kinds preserve checkout semantics. The type is represented alongside content and path changes.
100. **Snapshot and Subtree Support** — Snapshot commits can describe untracked working-directory state, and subtree metadata captures directory-level copies or merges. These extend ordinary commit semantics for specialized workflows.
101. **Content Addressing** — Blake2b hashes identify changesets and file data, linking parents into a Merkle DAG. Hash changes expose mutation and identical content can be deduplicated.
102. **Hash Computation** — Compact Thrift serialization of all changeset fields is hashed into a `ChangesetId`, while file bytes produce separate content identifiers. Parent references and every metadata or file change affect the commit ID.
103. **File Content Storage** — File bytes live independently in immutable blobstore objects, allowing reuse across commits. Filestore chunking provides a representation for large data.
104. **VCS-Agnostic Design** — Bonsai models shared semantics rather than copying Git trees or Mercurial manifests. Explicit file changes and mapping tables permit conversions to both ecosystems.
105. **Representation Capabilities** — Distinct author/committer fields, Git extras, Mercurial metadata, and copy-from information cover important format semantics. Its flat representation differs from each client-side tree model.
106. **Conversion and Mapping** — Import paths normalize external commits into Bonsai and serve paths reconstruct the requested format using stored mappings or derived structures. Original Mercurial bytes are retained for exact reproduction.
107. **Immutability and Storage** — Changesets are write-once blobstore values, while graph indexes, mappings, and movable bookmarks live in SQL. Mutable references can evolve without modifying historical objects.
108. **Comparison with Git and Mercurial** — The comparison focuses on tree shape, rename semantics, hash algorithms, and metadata. Bonsai chooses a common format and leaves protocol-specific reconstruction to adapters.
109. **Structure Differences** — Git uses trees, Mercurial manifests and filelogs, and Bonsai a flat list of commit changes. This avoids persisting an intermediate tree at commit ingestion, with read indexes supplied later.
110. **Hash Algorithm** — Git and Mercurial identifiers are described as SHA-1-based, while Bonsai uses 256-bit Blake2b. The hashes belong to different namespaces and are related through explicit mappings.
111. **Metadata Handling** — Git's author and committer fields map directly, while Mercurial's simpler metadata maps naturally to optional committer fields. Bonsai retains the richer shape without forcing every client to populate it.
112. **Type Definitions and Implementation** — Changesets, file changes, hashes, contents, and paths are implemented in `mononoke_types`. Strongly typed identifiers and mutable builders structure creation and retrieval.
113. **Relationship to Derived Data** — Manifests, file history, blame, and VCS objects are computed from Bonsai. The minimal core format is optimized for writes; read efficiency depends on additional materializations.
114. **Working with Bonsai in Code** — Blobstore facets load changesets, builders create immutable values, graph facets traverse ancestry, and VCS mapping facets resolve external IDs. Higher-level operations combine these capabilities.
115. **Summary** — VCS neutrality, content addressing, flat file changes, minimal inherent data, and immutability summarize Bonsai's design. Its explicit semantics trade a compact write model for derived representations at read time.
116. **Related Documentation** — Links connect the data model to concepts, architecture, derivation, facets, and storage. They place Bonsai as a shared foundation for the remaining topics.
117. **What Are Facets?** — Facets are trait-based units of repository capability, each responsible for a bounded area such as identity or graph traversal. Functions state capability needs in their type bounds.
118. **Defining Facets** — A macro generates reference accessors, Arc aliases, and container integration around a facet struct. Facets may contain state or wrap lower-level services.
119. **Using Facets in Code** — Function bounds restrict visible repository capabilities and allow compiler checking and lightweight test substitutions. Trait aliases can shorten repeated large capability sets.
120. **Available Facets** — Around 35 facets span identity, persistence, mappings, bookmarks, Git semantics, file history, permissions, and events. Each is independently located and composed into a repository.
121. **Identity and Configuration** — Identity supplies repository name and ID, while bookmark attributes express branch policy. These are configuration and naming capabilities.
122. **Storage Access** — Blobstore, filestore, and mutable blobstore facets expose immutable content, chunked files, and mutable temporary data. Each wraps storage details in repository-level interfaces.
123. **Commit Graph and History** — CommitGraph supplies ancestry and traversal backed by a storage implementation, and phases track public/draft status. Together they support efficient graph queries and VCS lifecycle rules.
124. **Derived Data** — RepoDerivedData coordinates derivation and access; derivation queues distribute work remotely. The facet separates callers from the execution topology.
125. **VCS Mappings** — Mapping facets translate Bonsai to Mercurial, Git, global revision, SVN, blob, or tag identifiers. Different external identity systems remain explicit capabilities.
126. **Bookmarks and References** — Bookmark interfaces read and update branch pointers, logs record movement, and caches speed common reads. The surrounding pieces separate current state from history and performance.
127. **Git-Specific Facets** — Symbolic references, reference content, and source-of-truth tracking cover Git-specific naming and migration state. They augment rather than replace common bookmarks.
128. **File and Data Management** — Filenodes, counters, renames, and related data facets support compatibility and operational workflows. Some representations are explicitly legacy.
129. **Operational Facets** — Permissions, hooks, cross-repo sync, locks, sparse profiles, and restricted paths encode policy or coordination. Their presence shows repository capabilities include operational controls as well as data access.
130. **Metadata and Events** — Mutation mappings, deletion logs, checkpoints, event publishing, and SQL configuration track changes and operational state. Bookmark update events are one source of downstream coordination.
131. **Facet Construction and Composition** — Repository factories instantiate facets from config and dependencies, then combine them in a container. Test factories swap in in-memory or SQLite implementations.
132. **Repository Factory** — Factory setup reads configuration, builds storage, constructs facets, and assembles the repository interface. This centralizes implementation choice behind capability accessors.
133. **Test Repositories** — `TestRepoFactory` creates controlled repositories with development backends and selectively replaceable facets. This supports isolated behavioral tests.
134. **Relationship to Features** — Stateless features orchestrate multiple facets to perform operations such as pushrebase. Shared feature functions can be invoked from servers, services, or tools.
135. **Facet Design Principles** — Single responsibility, encapsulated state, backend abstraction, async I/O, and Arc sharing guide implementations. These principles make capabilities substitutable and reusable.
136. **Finding Facet Implementations** — Each facet's source and build files live under `repo_attributes/`, sometimes with nested SQL implementations. The navigation guide supplies the broader layout.
137. **Patterns for Working with Facets** — Declare minimal requirements, reuse trait aliases, store Arc wrappers when needed, and access generated methods. New facets must be placed and constructed through the factory.
138. **Next Steps** — Architecture, navigation, Bonsai, derivation, and storage guides explain the adjacent concepts. The facet pattern is presented as foundational coding knowledge.
139. **What is Derived Data?** — Derived data consists of recomputable indexes, directory structures, metadata, and client-specific formats built from Bonsai and files. It makes reads practical without inflating the synchronous commit path.
140. **Separation from Core Data** — Changesets, content, mappings, and graph entries are written as core commit state; manifests and alternate representations follow asynchronously. Reads can derive absent data on demand.
141. **Write Path and Read Path** — The write pipeline stores canonical content and updates essential references before returning, while reads check for materialized forms and derive when missing. This design favors write rate and accepts read-side preparation.
142. **The Derived Data Framework** — `BonsaiDerivable` implementations define computation, storage, retrieval, and dependencies. The manager handles orchestration, batching, and caching.
143. **BonsaiDerivable Trait** — Implementations derive individual or batches of changesets and fetch persisted results, with parent/predecessor dependency contracts. Default batch behavior can be optimized by each type.
144. **Dependency Graph** — Derived types form a DAG, so prerequisites such as unodes precede blame. The framework orders derivation based on declared dependencies.
145. **Storage** — Derived values use type-specific blob keys, and some mappings also have SQL lookup records. Key design determines versioning and retrieval behavior.
146. **Derivation Processes** — On-demand, batched, backfill, and incremental modes cover request latency and historical population needs. The same framework supports all of them.
147. **On-Demand Derivation** — A missing requested type is computed, along with prerequisites, then persisted and returned. This keeps data availability lazy but may add first-read latency.
148. **Batch Derivation** — Batch implementations amortize queries and parallelize work across changesets. Remote services and bulk tools use this for throughput.
149. **Backfilling** — Historical types can be populated topologically or sliced for parallel work, with predecessor derivation as an optimization. Admin and bulk tools execute backfills.
150. **Incremental Derivation** — Newly arriving commits are derived on requests or by background workers after an initial backfill. Warm bookmark mechanisms keep common tips prepared.
151. **Remote Derivation Service** — A Thrift API, dependency-aware queue, and worker pool deduplicate requests and scale derivation separately. Polling tokens expose asynchronous completion.
152. **Derived Data Types** — The inventory covers manifests, file history, Git and Mercurial forms, and test utilities. Each type is a specialized projection of canonical data.
153. **Manifest Types** — Fsnodes, unodes, skeleton, content, and deleted manifests differ in history, sharding, and query shape. Sharded maps address large directories and partial loading.
154. **File Metadata Types** — Filenodes, fastlog, blame, and inferred-copy data serve history and attribution queries. Their dependencies and fidelity differ by use case.
155. **Git-Specific Types** — Git commits, trees, and delta manifests support Git protocol reconstruction and pack generation. Versioned delta formats optimize large histories.
156. **Mercurial-Specific Types** — Mercurial changesets and augmented manifests reconstruct client formats and add content metadata. They support compatibility and integrations.
157. **Utility Types** — Cached changeset information and test manifests support lookup speed and framework testing. Test-only formats exercise general derivation behavior.
158. **Sharded Maps** — A trie-like structure compresses paths and keeps node sizes bounded while allowing partial lookup. Several newer manifests use this to scale high-cardinality directories.
159. **Versioning and Migration** — New derived-data types coexist with old versions until backfill and configuration migration complete. Prefix namespaces permit isolated rederivation.
160. **Adding New Derived Data Types** — A new type needs computation, dependencies, persistence, registration, config, tests, and a historical backfill. The checklist spans implementation and rollout.
161. **Performance Considerations** — Batching, dependency ordering, remote workers, caching, incremental computation, and selective activation reduce wasted work. Derivation capacity is independently tunable from frontend traffic.
162. **Related Documentation** — Links connect derivation to system architecture, Bonsai, facets, and storage. Component directories hold per-type details.
163. **Storage Model Overview** — Immutable blobs, mutable SQL, mutable blobs, ephemeral bubbles, and derivation queues hold different data lifecycles. The top-level split follows whether values are immutable, indexed, or temporary.
164. **Blobstore Architecture** — A common immutable interface fronts multiple backends and composable decorators. Repository operations access it through facets.
165. **What Lives in the Blobstore** — Core commits, files, derived structures, and protocol objects are persisted as blobstore values. Keys may be content-derived or refer to another object's identity.
166. **Storage Backends** — Manifold, SQL, S3, filesystem, and memory implementations share an interface but target different environments. Backend choice is kept below application logic.
167. **The Decorator Pattern** — Prefixing, caching, multiplexing, compression, redaction, sampling, throttling, and test behavior wrap base stores. Their order configures operational properties.
168. **Example Blobstore Stack** — The illustrated production stack namespaces, caches, replicates, compresses, then persists values. Decorator placement affects what is cached or observed.
169. **Multiplexing for Availability** — Writes go to independent stores with quorum/WAL handling, reads can succeed from any available copy, and a healer repairs gaps. The design reduces dependency on one storage provider.
170. **Packblob: Compressed Storage** — Packblob groups related objects and uses Zstd plus deltas inside an envelope that identifies packed values. It reduces object overhead and storage size with added read/decompression behavior.
171. **Metadata Database** — SQL contains current references, mappings, indexes, phases, and repository operations that need transactional updates. It is the mutable counterpart to blob storage.
172. **What Lives in the Metadata Database** — Bookmark positions/logs, VCS maps, graph indexes, phase flags, counters, deletion state, locks, and references are indexed records. Schemas reside with their owning components.
173. **Blobstore vs. Metadata Database Decision** — Immutable, large, cacheable values belong in blob storage, while mutable, small, indexed relationships belong in SQL. VCS mappings illustrate that lookup needs may justify database storage despite immutability.
174. **Caching Strategy** — Local and shared caches layer over persistent storage, while warmed bookmark state prepares common history. Cache configuration controls the tradeoff between speed and observability.
175. **Cache Levels** — Cachelib is process-local, memcache is regional/shared, and misses fall through to blobstore. Successful reads fill upstream levels to make repeated requests cheaper.
176. **Cache Configuration** — Runtime options can select local-only or disabled caching and tune capacity. These modes support testing and operational diagnosis.
177. **Warm Bookmark Cache** — Bookmark visibility can wait until required derived data is ready, reducing first-read latency at the cost of a short delay. A dedicated bookmark service can centralize this warm state.
178. **Cache Warming: Microwave** — Microwave preloads frequently needed history and blob entries to reduce cold starts. The text says its importance has declined for some protocols.
179. **Cacheblob Implementation** — Cacheblob checks process cache, shared cache, then storage, backfilling caches on hits. A virtually sharded variant also deduplicates concurrent loads.
180. **Storage Characteristics** — Immutability eases caching, multiplexing exchanges write latency for redundancy, and external stores make frontends replaceable. Decorator stacks enable configuration at the cost of layers.
181. **Related Components** — Healer, walker, filestore, and factory coordinate repair, validation, chunking, and stack creation. These operational tools make persistence more than a simple key-value API.
182. **Related Documentation** — Architecture, Bonsai, derivation, and walker guides add context to storage concerns. Implementation detail is colocated with components.
183. **Overview** — Frontends serve clients and internal microservices isolate expensive work; all depend on external persistence. Statelessness and independent scaling are recurring goals.
184. **Frontend Services** — Protocol servers each target distinct client types and can run as load-balanced replicas. Their operations converge on shared repository interfaces.
185. **Mononoke Server (SLAPI/EdenAPI)** — The main Sapling/EdenFS frontend handles clone, push, pull, and file requests over HTTP. Repository sharding and startup cache warmup shape its operation.
186. **SCS Server (Source Control Service)** — A Thrift API exposes broad read and write operations across several commit ID systems, with authentication and repository authorization. It serves tooling and automation rather than a VCS wire protocol.
187. **Git Server** — Smart HTTP supports clone, fetch, and push by converting between Git objects and Bonsai. Mappings, derived trees, and references bridge the formats.
188. **LFS Server** — HTTP batch and streaming endpoints handle large object transfer via filestore and content IDs. Federation with an upstream is also supported.
189. **Internal Microservices** — Dedicated services coordinate landing and derivation, with other internal services for bookmarks, diffs, and limiting. Offloading provides workload isolation and serialized execution where needed.
190. **Land Service** — A per-bookmark queue serializes pushrebase and atomically lands changes after hooks. Responses include rewritten IDs or failures.
191. **Derived Data Service** — A token-based API and dependency-aware queue distribute derivation to workers and coalesce duplicate requests. This reduces work on frontend processes.
192. **Additional Services** — Bookmark, diff, and load-limiter services handle warm state, expensive comparisons, and coordinated QPS controls. The examples include Facebook-internal deployments.
193. **Using the Repository Layer** — Services share the app framework, facets, features, and optional API layer. This allows different protocols to reuse domain operations.
194. **Repository Access via Facets** — Trait bounds expose only selected capabilities to handlers, enabling smaller test repositories and explicit dependencies. Repositories are not accessed as unrestricted monoliths.
195. **Feature Integration** — Pushrebase and cross-repo features combine facets and can be reused from different services. Shared implementation avoids duplicating core state transitions.
196. **API Layer Usage** — High-level Repo, Changeset, and File abstractions hide specific manifests and graph backends. This stabilizes frontend code as lower implementations change.
197. **Communication Protocols** — HTTP serves user-facing VCS APIs and Thrift connects internal services. Streaming, serialization, and polling vary by workload.
198. **HTTP-Based Protocols** — SLAPI streams structured operations; Git uses pkt-line and packfiles; LFS exposes JSON batch plus binary transfers. Each protocol retains its client-specific wire behavior.
199. **Thrift-Based Services** — SCS exposes broad RPCs, Land uses a landing method, and derivation has submit/poll semantics. Internal APIs mirror distinct sync and async needs.
200. **Stateless Design** — Durable repository data and shared cache state live outside service processes. Any healthy instance can receive requests, simplifying scale-out and replacement.
201. **Configuration and Sharding** — Repository assignment and service settings control which data a process loads and how it behaves. Shallow and deep modes suit different repository counts.
202. **Repository Sharding** — Shallow mode loads all repositories at startup, while deep mode dynamically follows external assignments. Per-service sharding allows different workloads to distribute differently.
203. **Server Configuration** — Common config covers repository, TLS, logging, cache, and monitoring, with service-specific networking and queue options. Some settings can update through cached handles.
204. **Monitoring and Observability** — Metrics, structured logs, tracing, and health probes expose endpoint and cross-service behavior. The app framework initializes common instrumentation.
205. **Summary** — Protocol frontends, dedicated internal operations, shared facets, and external state form the service pattern. Statelessness and reusable libraries are the main consistency mechanisms.
206. **Related Documentation** — Architecture, facets, derivation, and VCS guides provide deeper background for service-specific behavior. Component directories remain the implementation reference.
207. **Overview** — Background jobs perform integrity checks, derivation, sync, and statistics outside client request latency. They process batches and report progress operationally.
208. **Walker** — The graph traversal job checks references and storage, extracts samples, and estimates compression. Its schema models repository objects and relationships.
209. **Capabilities** — Scrub, validate, corpus, and compression analysis address redundancy, consistency, extraction, and storage efficiency. Sampling and optional repair support large repositories.
210. **Implementation** — Traversal expands a dynamically discovered graph with cycle-aware visit tracking and bounded memory. Hash/path sampling divides large work into repeatable subsets.
211. **Blobstore Healer** — A continuous worker consumes the multiplex write-ahead log and restores missing copies. Batch, age, concurrency, and shard settings control its work.
212. **Operation** — The healer copies a value from a healthy backend to a missing one and handles temporary failures or configuration changes. Dry-run and drain-only modes provide operational controls.
213. **Configuration** — Queue size, age, concurrency, shard ranges, and storage identity bound the repair workload. Multiple workers can cover disjoint shards.
214. **Derived Data Workers** — Remote workers derive canonical projections after commits, coordinated through a service and queue. Capacity can increase without changing frontend count.
215. **Remote Derivation Service** — The service deduplicates work and exposes progress while workers consume requests. Derivation dependencies order the computation.
216. **Derivation Process** — Workers load Bonsai and prerequisites, compute derived values, store them, and update status. Requests may be triggered by demand or background catch-up.
217. **Cross-Repository Sync (Backsyncer)** — Backsync follows bookmark changes and transforms commits across configured repositories. Mappings preserve ancestry even with rewritten paths.
218. **Sync Process** — The worker consumes update logs, transforms commits, lands them in the target, and advances progress. Transformations include paths, file filters, metadata, and timestamps.
219. **Modes of Operation** — Continuous, one-time, and sharded modes support steady flow, catch-up, and parallel repository coverage. Configuration determines boundaries.
220. **CAS Sync** — A background task sends commit and file data to an external content-addressed store for redundancy or integration. Progress counters make it resumable.
221. **Operation** — The job follows bookmark updates, uploads objects, records progress, and logs status. Retries and bookmark selection shape recovery and scope.
222. **Modern Sync** — EdenAPI is used to replicate commits and derived data to compatible endpoints. Batch and sharded operation make it suitable for large-scale mirroring.
223. **Operation** — Update-log entries are grouped and sent using configured TLS/proxy endpoints, with counters and optional metrics. It resembles CAS sync operationally but has a protocol-aware target.
224. **Statistics Collector** — Repository size and file metrics are recomputed at bookmarks and logged over time. Incremental diffing reduces work for successive commits.
225. **Operation** — It scans manifests for regular files under a size threshold and calculates counts, sizes, and lines. Continuous and one-shot modes support monitoring and analysis.
226. **Job Scheduling and Orchestration** — Shard managers distribute multi-repo jobs, continuous workers poll safely, and scheduled jobs run periodically. Lifecycle is delegated to deployment infrastructure.
227. **Monitoring and Alerting** — ODS metrics, Scuba records, health checks, and contextual errors expose throughput and failures. Flags such as dry run and iteration limits help control operations.
228. **Relationship to Servers and Tools** — Jobs use shared facets and libraries but optimize for batch throughput, unlike latency-sensitive servers or one-shot operator tools. The execution model determines placement.
229. **Overview** — Command-line utilities perform on-demand administration, import, verification, and maintenance. Admin is the central interface with specialized executables around it.
230. **Tool vs Job vs Server** — Tools execute and exit, jobs continuously process maintenance, and servers handle network requests. Choosing a category follows lifecycle and user interaction.
231. **Administrative Tools** — The admin CLI is the preferred interface for repository operations; testtool is restricted to non-production environments. These tools centralize safe operational access.
232. **Admin CLI** — A large command set covers bookmarks, commits, derived data, storage, graph, sync, Git, and operational state. It is recommended over direct database or storage changes.
233. **Testtool** — A development/testing utility offers diagnostics unavailable in admin and actively refuses production configuration. That guard bounds its use.
234. **Import and Export Tools** — Gitimport and repo_import handle straightforward and transformed imports, while streaming clone handles Mercurial data. Specialized workflows use purpose-built entry points.
235. **Gitimport** — Existing Git objects become Bonsai, with references, mappings, and optional LFS handled during import. Incremental operation supports later updates.
236. **Repo Import** — This tool adds transformations, sync, backsync, and specialized handling to basic Git import. It targets complex migrations.
237. **Streaming Clone** — Pre-generated changelog chunks let Mercurial clients obtain histories quickly. The tool creates and updates chunks in mutable storage.
238. **Verification Tools** — Alias, Bonsai/Mercurial, working-copy, and graph checks validate different integrity boundaries. Their specialization reflects multiple representations.
239. **Aliasverify** — It checks that content aliases exist, resolve to canonical bytes, and hash correctly. Ranged and sharded modes cover larger data sets.
240. **Bonsai Verify** — This tool recomputes Mercurial manifests from Bonsai and compares stored forms. Differences indicate mapping, derivation, or data integrity errors.
241. **Check Git Working Copy** — It compares a Bonsai materialization with a Git checkout, optionally accounting for LFS pointers. This tests cross-format observable equivalence.
242. **Maintenance Tools** — Packer, SQL blob garbage collection, and mapping backfill address compression, cleanup, and incomplete identifiers. Each is specific to its storage or mapping domain.
243. **Packer** — It gathers keys, compresses and packs blob values, and uploads the result, with parallel and dry-run modes. Its purpose is reducing backend overhead and storage cost.
244. **SQLblob Garbage Collection** — The utility finds and removes unreferenced SQL-backed blobs and can work across shards. It does not apply to other backends.
245. **Backfill Mapping** — It computes missing VCS identities and fills mapping tables from Mercurial commit IDs. This repairs or prepares format support.
246. **Data Operations** — Executor coordinates tasks across repositories, while import libraries share implementation without being standalone commands. Framework pieces are distinct from operator-facing tools.
247. **Executor** — It provides sharding, scheduling, and parallel execution for multi-repository operations. Other tools can build on it.
248. **Import Tools** — Shared import utilities support Git and repository import commands. This directory is a library area rather than an executable.
249. **When to Use Which Tool** — The guide maps routine admin, import, validation, storage, and debugging needs to the appropriate utility. It emphasizes choosing the narrowest operational interface.
250. **Tool Implementation Patterns** — Tools use the common app framework, facet access, one-shot execution, and safety controls. Dry runs, checks, and logs reduce mutation risk.
251. **Integration with Jobs** — Some capabilities have both on-demand tools and continuous job forms, such as healing and validation. Their distinction is invocation model rather than data model.
252. **Documentation and Help** — CLI help, component READMEs, integration tests, and source are the available usage references. Admin subcommands each document their options.
253. **Summary** — Admin provides broad operations; specialized tools cover import, verification, and storage. Servers, jobs, and tools differ by lifecycle and intended caller.
254. **Introduction** — A shared library foundation handles startup, config, async work, storage, logging, and tests for all Mononoke applications. It promotes common operational behavior.
255. **Application Framework: mononoke_app** — The framework creates a consistent application lifecycle for servers, tools, and jobs. It hides repetitive initialization from domain logic.
256. **Purpose and Responsibilities** — Argument parsing, config, environment, repository setup, monitoring, and shutdown are centralized. The common responsibilities span cross-cutting concerns.
257. **Application Structure** — Applications build a configured app object and run a monitored async entry point. Builder and runtime types define the main lifecycle.
258. **Writing a New Mononoke Binary** — New binaries use the app builder, monitoring runner, and provided repository arguments. The examples show the standard initialization and access pattern.
259. **Extension System** — Extensions add app-specific arguments or startup work, with built-in monitoring and scrub examples. They provide controlled customization around the common framework.
260. **Subcommands** — A macro registers command modules and their argument/run functions. The framework dispatches based on parsed CLI input.
261. **Standard Arguments** — Shared config, repo, cache, storage, logging, and monitoring flags reduce per-tool duplication. Applications can add task-specific options.
262. **Command-line Utilities: cmdlib** — Supporting libraries cover config parsing, identifiers, sharding, environments, logging, caching, and extensions. Most are reached through the app framework.
263. **Configuration and Arguments** — Config paths, commit identities, and shard selectors have reusable parsers. These standardize how commands identify inputs and scope.
264. **Environment and Setup** — Base app, environment, logging, and log crates initialize databases, caches, and process behavior. They give applications a common runtime foundation.
265. **Capabilities** — Caching, scrubbing, cross-repo, and display helpers are reusable operational behaviors. Apps select them as needed.
266. **Other Utilities** — Extension and leader-election libraries support customized startup and distributed job coordination. They are optional framework components.
267. **Common Utilities: common/** — Specialized crates offer async, SQL, logging, data structure, time, path, and Thrift helpers. Their narrow scope enables reuse across applications.
268. **Asynchronous Programming Utilities** — Watchdogs, limiters, pipelines, task lifetime helpers, and yielding streams manage concurrency and responsiveness. They complement Rust async primitives with operational controls.
269. **SQL Database Utilities** — SQL managers and connection extensions abstract MySQL/SQLite construction and query mechanics. Internal deployments add pooling and failover capabilities.
270. **Logging and Observability** — Scuba, logger, metrics, session, and Scribe integrations standardize event recording. Request correlation is a shared concern.
271. **Data Structures and Algorithms** — Deduplicating maps, unique heaps, type maps, and topological sort solve recurring implementation needs. They are general building blocks.
272. **Time and Measurement** — Timing and periodic reload utilities support performance measurement and refreshing state. They centralize common patterns.
273. **Path and Content Utilities** — Path hashing and copy helpers provide reusable low-level operations. Their abstractions avoid repeating mechanical transformations.
274. **Synchronization and Coordination** — Rendezvous batches duplicate SQL requests and replication helpers wait for database convergence. These tools coordinate concurrent work.
275. **Metadata and System Information** — Metadata, memory reporting, and connection-security checks expose process and environment state. These utilities support operations and safety.
276. **Iteration Helpers** — Iterator extensions reduce repeated collection-processing code. This is a generic convenience layer.
277. **Thrift Integration** — Conversion utilities bridge internal Rust types and Thrift structures. They support internal RPC boundaries.
278. **Shared Utilities: common/rust/shed** — Shared Meta Rust crates provide traversal, facets, initialization, config, stats, and logging support beyond Mononoke. Their placement reflects reuse across projects.
279. **Core Types: mononoke_types** — Canonical commits, hashes, file changes, paths, VCS identifiers, and derived formats are defined centrally. Serialization and strong types protect data boundaries.
280. **Testing Utilities: tests/utils** — Drawdag, random generation, and repository helpers reduce setup code in tests. Shared fixtures make tests more readable.
281. **Usage Patterns** — Developers mainly extend existing binaries, create new framework-based commands, or use common helpers. Cross-cutting setup is delegated to shared libraries.
282. **Using the Framework** — Existing app setup provides initialized repositories and operational scaffolding. Domain code can focus on the requested operation.
283. **Accessing Utilities** — BUCK dependency declarations show how utilities are linked into binaries. The example emphasizes explicit dependency tracking.
284. **Working with Repositories** — Applications request repository facets from an initialized repository object. The framework handles config and construction.
285. **Summary** — Shared app lifecycle, utilities, core types, and test helpers provide consistency across binaries. New tools should reuse those pieces rather than recreate setup.
286. **What is Pushrebase?** — Pushrebase server-side rebases a client's stack over a moved bookmark when path-level changes do not conflict. It lets concurrent contributors avoid a pull/rebase/retry round trip for clean changes.
287. **Why Pushrebase Exists** — High bookmark contention creates repeated client failures and retries without server coordination. A server operation can rebase and move the target atomically, simplifying successful pushes.
288. **The Pushrebase Process** — The operation identifies a commit subset, checks overlapping paths, rewrites commits, runs hooks, and updates the bookmark. The client receives replacement IDs or a failure.
289. **Client Side** — Clients issue ordinary Sapling push or a Git-specific push and may be based behind the target. Server-side rewriting is intended to be transparent.
290. **Server-Side Operation** — Commit selection, conservative conflict checks, new changeset creation, hook invocation, and transactional movement make up the sequence. Only conflicts that can be resolved without content merging are accepted automatically.
291. **Retry on Concurrent Updates** — A moving target bookmark causes recomputation against the latest tip, with a configured retry limit. Exhaustion returns responsibility to the client.
292. **Conflict-Free Rebases** — The check is path-based, so edits to separate lines in one file still conflict. Clients must resolve conflicts locally and retry.
293. **Pushrebase Configuration** — Repository and per-bookmark options govern merge handling, case conflicts, date rewriting, stack depth, and eligibility. Policy varies by target branch.
294. **Pushrebase Hooks** — Specialized hooks attach metadata or sequence values during rewriting, distinct from policy hooks. Both may participate in a push.
295. **Implementation Architecture** — Core algorithms, bookmark movement, clients, and hook registries live in separate components. The feature composes graph, storage, bookmark, policy, and derivation facets.
296. **Use in Sapling Workflows** — Sapling receives obsmarkers linking original to rewritten commits and updates local state. Commit Cloud synchronization of those mutations is identified as a limitation.
297. **Use in Git Workflows** — Git can trigger configured pushrebase and receives new hashes through its protocol. Git lacks Sapling's built-in mutation tracking for relating old and new commits.
298. **Pushrebase vs. Fast-Forward Push** — Fast-forward requires ancestry and does no rewrite; pushrebase accepts stale bases when changes do not conflict. Configuration selects the expected branch semantics.
299. **Pushrebase Mutation Mapping** — A metadata mapping records original-to-rewritten commit IDs for clients and tools. A transaction hook writes it and SCS exposes queries.
300. **Observability** — Duration, retry failures, rewritten count, logs, and bookmark history capture operation behavior. Admin commands support diagnosis.
301. **Limitations and Edge Cases** — Merges, deep stacks, frequent target movement, case collisions, and hook rejection can prevent landing. Configuration and retries bound these conditions.
302. **Related Documentation** — Architecture, facets, hooks, bookmarks, and land service point to adjacent mechanisms. A TBD bookmark link signals incomplete documentation.
303. **What is Cross-Repo Sync?** — The system copies commits between configured repositories with path and metadata transforms. It supports large/small repository workflows in both directions.
304. **Sync Directions** — Forward sync takes smaller repositories into a larger one; backsync sends relevant larger-repo changes back. Explicit mappings define relationships instead of repository inference.
305. **Commit Transformation** — Sync rewrites paths and parents while retaining metadata and handling special cases. Transformations must preserve meaningful history in the target.
306. **Path Transformation** — Prefix maps place project paths at different locations across repositories. Multiple mappings and defaults express more complex routing.
307. **Commit Rewriting** — The library rewrites file changes and parent IDs, preserving author, message, and time. Empty transformed commits receive an equivalent or non-candidate outcome.
308. **Special Cases** — Merges require synchronized parents, copy metadata survives only when paths map, and submodules can be expanded. Unsupported graph cases fail rather than silently diverge.
309. **Sync Process** — Workers tail bookmark logs, find unsynced ancestry, transform commits in order, land changes, record mappings, and checkpoint progress. Forward and backward processing have distinct workers.
310. **Forward Sync Process** — The x-repo job imports commits topologically and pushrebases common targets. Mapping and counters make progress durable.
311. **Backward Sync Process** — Backsync filters large-repo commits by path, rewrites them, and lands them in small repositories. It supports continuous and historical catch-up modes.
312. **Synced Commit Mapping** — A bidirectional database record stores source, destination, configuration version, and outcome. It prevents duplicate work and resolves parent relationships.
313. **Commit Sync Outcomes** — Rewritten, equivalent-working-copy ancestor, and not-candidate outcomes record why source changes map to target history. Multiple source changes can converge on one target commit.
314. **Configuration** — `CommitSyncConfig` defines large/small repositories, path rules, bookmark policy, submodules, and versions. Historical versions let live rules evolve without losing mapping context.
315. **Commit Sync Config Structure** — Each relationship specifies repository identities, default path behavior, path maps, submodule settings, common landing bookmarks, and a version label. These settings make topology explicit.
316. **Configuration Versioning** — Version IDs select transform rules per commit and are stored in mappings. Live and historical configs support migrations.
317. **Bookmark Mapping** — Prefixes translate branch names between repository spaces. This decouples branch layout from path transformations.
318. **Repository Integration** — A cross-repo facet exposes mappings, live config, sync leases, and submodule dependencies. Both jobs and repository operations use it.
319. **Use Cases** — Monorepo/project, shared code, migration, megarepo, and directory isolation workflows motivate synchronization. The pattern allows both broad and focused repository work.
320. **Jobs and Tools** — A continuous forward job, backsync modes, and admin operations expose automated and manual workflows. All use the same recorded mappings and config.
321. **X-Repo Sync Job** — The job processes update logs topologically, pushrebases selected bookmarks, and resumes from counters. Sharding distributes multiple repositories.
322. **Backsyncer** — The reverse job can continuously follow updates, catch up history, or validate a sync. It handles the large-to-small direction.
323. **Admin Tools** — Operators can trigger sync, query mappings, compare working copies, and inspect configuration. This offers targeted recovery and diagnosis.
324. **Limitations and Constraints** — Some merges, root histories, path collisions, unconfigured branches, and parallel ordering are unsupported or constrained. The implementation fails for unsafe cases.
325. **Performance Considerations** — Incremental processing, batches, leases, async derivation, cached config, and sharding control cost and contention. Topological ordering still limits parallelism.
326. **Monitoring and Validation** — Working-copy checks, bookmark diffs, commit validators, and Scuba logs expose incorrect transformation or lag. Validation compares outcomes across repositories.
327. **Related Documentation** — Architecture, facets, pushrebase, jobs, and component folders provide deeper detail. Core sync logic is distributed across transformation, mapping, and worker code.
328. **What Are Hooks?** — Repository hooks enforce policy when commits reach public bookmarks and can reject the whole move. Server-side execution prevents client-side bypass.
329. **Hooks vs. Pushrebase Hooks** — Policy hooks validate commits and bookmarks, whereas pushrebase hooks add metadata during rewritten commit creation. They are distinct systems that may run in one push.
330. **Hook Types** — Bookmark, changeset, and file hooks inspect progressively different scopes. Their granularity determines what information and policy each can use.
331. **Bookmark Hooks** — These run once for a target bookmark move and can enforce branch-specific rules. They see the destination and changeset context.
332. **Changeset Hooks** — These run per incoming commit and inspect authorship, message, and file changes. Common policies include format, merge, and size constraints.
333. **File Hooks** — These run for each changed path and optionally content, enforcing path, content, size, permission, or type policy. Their invocation count follows the changed files.
334. **Hook Manager Facet** — The facet owns registrations, bookmark assignments, bypass permissions, and logging. Bookmark movement calls it before changing persistent state.
335. **Hook Configuration** — Repository config selects hook types, implementations, bookmark patterns, parameters, log-only mode, and bypass rules. Per-branch configuration permits stronger protection for sensitive targets.
336. **Hook Execution** — Applicable hooks are selected, new changesets and files enumerated, then checks run concurrently with repository context. Rejections are collected and abort the bookmark update unless log-only.
337. **Built-in Hook Implementations** — Built-ins cover filenames, content, sizes, commit text and structure, repository changes, binaries, tags, and LFS. Internal policies extend the public set.
338. **Hook Bypass** — Authorized admins, service identity, or configured sync flows can skip applicable checks, with audit logging. Bypass is permission- and context-sensitive.
339. **Hook Development** — Implement a hook trait, register it, configure it, and use `HookRepo` for bounded repository access. Hooks should be stateless with behavior supplied by config.
340. **Integration with Repository Operations** — Pushrebase, direct bookmark movement, and landing invoke hooks before state changes. Rejection leaves repository state unchanged.
341. **Observability** — Scuba records hook identity, target, commit, duration, result, and rejection details. Separate audit records capture bypasses and performance data identifies expensive policies.
342. **Relationship to Other Features** — Hooks run before rebase validation, may be skipped for synced commits, do not wait for derived data, and require specific bypass permissions. Pushrebase metadata hooks remain a separate later phase.
343. **Summary** — Server-side bookmark, changeset, and file policy is configurable, observable, and rejectable with user feedback. The hook manager integrates checks into state transitions.
344. **Related Documentation** — Facets, pushrebase, and architecture explain the hook system's dependencies. Source locations identify the manager and movement integration.
345. **What is Redaction?** — Redaction blocks access to sensitive content while preserving commits and metadata. It does not rewrite history or physically remove bytes.
346. **How Redaction Works** — A blobstore decorator checks content IDs on every read, so all protocols share enforcement. Enforcement can reject or log-only, with access audited.
347. **Blobstore-Level Enforcement** — The decorator checks each requested key, applies policy, logs caller/session context, and passes allowed reads through. Its position makes enforcement protocol-independent.
348. **Redaction Configuration** — Configured sets point to key-list blobs and include a reason and enforcement mode. Periodic reloads propagate policy without process restart.
349. **Content Addressing** — Policies target content hashes, so identical bytes are blocked wherever reused and a changed file version is distinct. Paths and commit identities are not the redaction key.
350. **The Redaction Process** — Admin tooling identifies content, stores a key list, and activates it through configuration. Creation and enforcement are separate deliberate steps.
351. **Identifying Content to Redact** — The tool resolves paths through manifests, finds content IDs, checks reachability, and prepares a list. Listing can discover affected paths for a commit.
352. **Creating a Redaction Key List** — Admin resolves selected paths to IDs, validates reachability unless forced, stores the list, and returns its content-addressed identifier. It can also export the list.
353. **Activating Redaction** — Operators reference the key-list ID and reason from repository policy config, deploy it, then wait for reload. The change is not active merely because a list exists.
354. **Log-Only Mode** — Non-enforcing policy records attempted access for trial and measurement. It supports observing impact before denial.
355. **Access Control and Permissions** — Normal repository read permission does not override redaction, and accesses remain audited. A narrowly permission-gated mirror upload view allows canonical sync content through in log-only mode while ordinary reads remain enforced.
356. **Limitations and Considerations** — Metadata remains visible, caches may retain bytes temporarily, derived structures can still reference IDs, and configuration propagation is delayed. Redaction blocks access but leaves physical storage intact; mirror sync has a special documented bypass path.
357. **Implementation Details** — The decorator enforces reads, a feature library manages lists, admin commands create/fetch/sync/list them, and typed config defines policy. AWS sync includes bootstrap and production-operation caveats.
358. **Related Documentation** — Storage, architecture, and navigation explain the layer where redaction sits. Component directories hold implementation details.
359. **What is Microwave?** — Microwave snapshots and preloads selected repository state to reduce cold-start latency. A builder produces snapshots and a preloader primes server caches.
360. **How Cache Warming Works** — Offline snapshot creation and startup loading form two phases. Microwave participates in a wider cache-warmup system.
361. **Snapshot Creation** — The builder selects a bookmark, ensures derived state, gathers filenodes, serializes them, and stores a snapshot. The format also reserves unused changeset data.
362. **Snapshot Storage** — Snapshots live in mutable blobstore under a versioned key or in a local path for development. Builder options choose the destination.
363. **Cache Preloading** — Startup reads and deserializes the snapshot, restores filenodes, then continues other warmup. This work precedes serving requests.
364. **What Gets Warmed** — Filenodes are microwave's direct target, while broader warmup adds manifests, graph segments, derivation, and blob entries. This distinction clarifies the feature boundary.
365. **Filenodes** — Cached file histories and parent/linknode metadata serve legacy Mercurial operations and history queries. Priming avoids repetitive SQL reads.
366. **Derived Data** — The wider sequence prepares Mercurial conversion, file history, and target manifests. Required derivation must exist before the snapshot can be useful.
367. **Blobstore Entries** — Manifest nodes, directory metadata, and graph segments populate local and shared caches. This lowers early storage traffic.
368. **When Warming Happens** — Startup, scheduled snapshot generation, and explicit calls are the main triggers. Configuration determines scope and ordering.
369. **Server Startup** — Bookmark, ancestor limit, and preload settings govern cache preparation before readiness. Repositories are loaded according to shard assignments.
370. **Builder Execution** — Periodic jobs refresh snapshots based on current configured bookmarks. Fresh derived data is ensured before capture.
371. **On-Demand Warming** — The cache-warmup API allows admin tools, tests, or startup to request warming. This provides a shared interface beyond boot.
372. **Integration with Cache Warmup** — Microwave is one phase among blobstore, filenode, and commit-graph preparation. The orchestration can run independent phases concurrently.
373. **Warmup Sequence** — Snapshot preload is followed by additional file/manifest and graph warming. Work is arranged to make caches ready before traffic begins.
374. **Warmup Kinds** — Builder mode favors completeness, while server mode prioritizes startup speed and can skip work. The same infrastructure supports both objectives.
375. **Configuration** — Repository `CacheWarmupParams` selects target, history depth, and microwave use. Omitting the section leaves cold caches.
376. **Operational Characteristics** — Snapshot freshness, builder reliability, storage size, startup delay, and format version affect usefulness. Version changes require new snapshots before servers can consume them.
377. **Related Components** — Filenodes, cache warmup, warm bookmarks, derived data, and mutable blobstore supply adjacent capabilities. Microwave depends on those systems rather than replacing them.
378. **Implementation Details** — Core code, builder, Thrift format, and warmup library are named, along with build/run examples. The builder exposes local and blobstore commands.
379. **Related Documentation** — Architecture, derivation, storage, and service guides explain surrounding cache behavior. Component sources contain further details.
380. **Overview** — Git clients use HTTP smart protocol while Bonsai remains the canonical storage representation. Mapping, derived trees, refs, LFS, and migration tracking make the integration bidirectional.
381. **Git Protocol Server** — A dedicated HTTP server handles Git object transfer using shared protocol, packet-line, and packfile libraries. It maps protocol actions into repository operations.
382. **Protocol Implementation** — Pack negotiation and packet framing are separated into protocol, packfile, and packet-line components. These lower layers encapsulate Git wire details.
383. **Supported Operations** — Clone, fetch, push, and reference listing translate client requests to object generation, import, or bookmark updates. Packfiles are the main transfer unit.
384. **Request Routing** — HTTP upload-pack and receive-pack routes dispatch read and write flows to separate handlers. A Gotham service handles endpoint routing.
385. **Bonsai-Git Conversion** — Mapping facets and derived Git objects bridge flat Bonsai changes with Git's object model. Conversion is required for protocol reads and writes.
386. **Git Commits as Derived Data** — Git commits and trees are derived from Bonsai metadata and file changes, then stored and mapped. Deterministic hashes allow repeatable identifiers.
387. **Metadata Conversion** — Author/committer, messages, extras, and parents map between Bonsai and Git fields. Unsupported external metadata may be omitted.
388. **File Changes to Tree Objects** — Flat paths become nested tree objects with corresponding modes and shared content. Rename metadata stays in Bonsai because Git does not encode it in commits.
389. **Mapping Storage** — A SQL-backed facet maps Bonsai IDs and Git SHAs, populated by import, push, or derivation. Tag and blob mappings cover additional object types.
390. **Import and Export** — Gitimport normalizes external repositories; gitexport supports migration and backup. Shared import tools validate and handle metadata.
391. **Git-Specific Derived Data** — Trees, delta manifests, and bundle files optimize object serving beyond basic commit conversion. They are generated asynchronously.
392. **Git Trees** — Trees materialize nested directories from Bonsai's file changes. They are required for native Git object responses.
393. **Delta Manifests** — Versioned manifests precompute object delta choices, reducing pack generation cost. Compacted forms reduce fetch overhead in histories with many small commits.
394. **Bundle URI Support** — Pre-generated bundles let clients clone without the server assembling a full pack on demand. This shifts work into preparation and storage.
395. **Git Reference Management** — Git symbolic refs and content-bearing tags coexist with bookmark-based branch state. Facets preserve protocol-specific ref semantics.
396. **Symbolic References** — A dedicated facet represents refs such as HEAD pointing to a branch name. It records target name and type.
397. **Reference Content Mapping** — Content mappings support annotated tags and other refs that contain an object, not just a commit pointer. This supplements bookmark values.
398. **Bookmarks Integration** — Git branches map to Mononoke bookmarks, and advertised refs are rendered using Git naming rules. Branch movement therefore uses the common repository state.
399. **Git LFS Integration** — A separate HTTP service handles LFS batch and object transfers using content-addressed filestore data. LFS pointers can be interpreted within commit processing.
400. **LFS Protocol** — Batch requests return transfer endpoints and upload/download routes move object bytes. This separates metadata negotiation from large payload streaming.
401. **LFS Pointer Interpretation** — Enabled imports store full content in Bonsai while marking files to be served as pointer files to Git. Other APIs can still access the underlying content.
402. **LFS Storage** — Filestore chunks data and object IDs use SHA-256 while the repository has its own content IDs. Upstream federation can proxy or cache objects.
403. **Source of Truth Tracking** — A facet records whether Mononoke or external Git is authoritative during migration. It tracks repository, migration state, and mutation identifiers.
404. **Request Flow Examples** — Clone, push, and fetch sequences show protocol negotiation, mapping, derived objects, bookmark movement, and asynchronous work. These examples expose where read and write costs occur.
405. **Git Clone** — Refs and client negotiation determine which commits and objects to derive, then a packfile is streamed. Delta manifests optimize object transfer.
406. **Git Push** — Incoming objects become Bonsai, hooks validate them, mappings and graph data are updated, and refs advance. Derived data is queued after the synchronous push.
407. **Git Fetch** — Graph differences select missing history and pack generation returns incrementally updated objects. The client applies the new objects and refs.
408. **Component Organization** — Protocol, object types, mapping facets, LFS, import/export, and bundle support occupy distinct subtrees. This layout separates interoperability concerns.
409. **Related Documentation** — Service, facet, derivation, Bonsai, and Sapling guides place Git support in the wider system. The links compare alternate VCS paths.
410. **Historical Context** — Mononoke began as a Mercurial server, added Sapling's HTTP API, and is now primarily serving Sapling as legacy wire support is removed. Its internal model may also evolve over time.
411. **Mercurial Data Model** — Mercurial changesets, manifests, and file nodes are content-addressed with separate history structures. Mononoke handles these as compatibility formats around Bonsai.
412. **Core Mercurial Types** — Typed SHA-1 identifiers distinguish commit, manifest, and filenode identities. Manifest support is described as tree-based.
413. **Node Computation** — Parent hashes and serialized node content form identity, so ancestry affects hashes. Changesets, manifests, and files each use the Merkle principle.
414. **Mercurial Structures** — Changesets reference manifests, manifests list entries, and filenodes preserve per-file history. Together they make the client-side repository model.
415. **Wire Formats** — Revlogs, bundle2, and wirepack serve disk import and network interchange needs. Mononoke implements these where compatibility requires them.
416. **Bonsai ↔ Mercurial Conversion** — The mapping facet connects IDs while derived manifests and changesets reconstruct Mercurial forms. Conversion supports clients without making those structures canonical.
417. **BonsaiHgMapping Facet** — Bidirectional lookups and batched mapping operations are stored in SQL and cached. Writes occur at ingestion or derivation.
418. **Conversion Process** — Pushes normalize incoming client data to Bonsai and may preserve original bytes; reads resolve to Bonsai and derive the requested response format. Both paths maintain mappings.
419. **Conversion Characteristics** — Conversion can be non-bijective in principle, is deterministic for derived IDs, and may happen asynchronously. Compatibility constraints make practical mappings close to one-to-one.
420. **Mercurial-Specific Derived Data** — Changesets, augmented manifests, and filenodes support older protocols and Sapling-facing operations. Dependency ordering ensures prerequisites exist.
421. **Mapped Mercurial Changeset** — Bonsai file changes become Mercurial manifests and metadata, producing a Mercurial ID and mapping. The type is available on demand or from workers.
422. **Mercurial Augmented Manifests** — Tree manifests carry sizes, hashes, and type data beyond traditional structures. Sharding supports large directories and efficient client serving.
423. **Filenodes** — Per-file IDs, paths, parent links, and linkrevs support Mercurial history protocol. Derivation writes history metadata for lookups.
424. **Derivation Dependencies** — Mercurial changesets and augmented manifests depend on fsnodes; filenodes also require mapped changesets. The declared order prevents inconsistent projections.
425. **Protocol Support** — Modern SLAPI, legacy wire protocol, and remotefilelog support successive generations of clients. Compatibility is concentrated in adapters.
426. **EdenAPI (SLAPI)** — HTTP/2 endpoints serve files, trees, commits, history, bookmarks, blame, landing, and Commit Cloud. Authentication, API access, and derived data form the request path.
427. **Legacy Wire Protocol** — Bundle2 commands preserve support for older SSH-based clients and allow push/pull operations. The text describes this path as retained but no longer the main development focus.
428. **Remotefilelog** — On-demand file, commit, and tree endpoints avoid downloading complete histories. Filenodes resolve requested client IDs to blobstore data.
429. **Bundle Formats** — Bundle2, changegroup, and wirepack structure data transfer for Mercurial compatibility. Parsers and packers handle content and metadata.
430. **Bundle2** — Headers, capabilities, typed parts, and replies encode negotiated operations. The parser decompresses and deserializes streams.
431. **Changegroup Format** — Changeset, manifest, and file deltas carry node IDs, parents, content, and linkrev. Pack/unpack code reconstructs or emits transfer sequences.
432. **Wirepack Format** — A streaming file format avoids delta chains and suits large file transfers. Remotefilelog and SLAPI use it.
433. **Migration and Compatibility** — Negotiation, client detection, and stable mappings allow mixed protocol generations on shared infrastructure. Native hash behavior remains a compatibility constraint.
434. **Protocol Version Support** — Legacy SSH wire clients, remotefilelog, and modern Sapling clients select different pathways. Capabilities allow fallback.
435. **Client Type Detection** — User agents, capability strings, and endpoint selection identify client behavior. The server adapts responses without separate repositories.
436. **Data Format Compatibility** — Matching hashes, wire formats, and mapping persistence allow native clients to verify and reuse data. This is an explicit interop requirement.
437. **Evolution from Mercurial to Sapling** — Protocol migration, rebranding, SLAPI additions, and legacy deprecation happened incrementally. New capabilities target the HTTP API.
438. **Implementation Locations** — Types, bundles, mappings, derivations, handlers, and servers each have identified code areas. The guide groups them by compatibility layer.
439. **Related Documentation** — Architecture, Bonsai, facets, derivation, and Git guides explain adjacent representations. Detailed implementation remains in component directories.
440. **Introduction** — The document distinguishes rate limits aimed at clients from shedding aimed at system pressure. Together they control overload at multiple layers.
441. **Rate Limiting vs. Load Shedding** — Rate limits impose client-specific quotas over windows; load shedding rejects lower-priority traffic when system resources are stressed. Both can return 429 and trigger backoff.
442. **Rate Limiting** — Client request and data metrics are compared against configurable quotas and excess requests are rejected early. Identity is the targeting unit.
443. **Load Shedding** — CPU, memory, and queue pressure activate priority-based rejection. It protects system-wide availability instead of penalizing a single client for its own rate.
444. **Rate Limiting Framework** — A middleware-integrated framework tracks request, transfer, and commit metrics with per-scope rules. Dynamic configuration changes behavior without restart.
445. **Tracked Metrics** — QPS, egress, manifests, files, and commit counts capture different resource costs. Windows determine how quickly clients approach limits.
446. **Scope Configuration** — Global limits coordinate across regions, while regional limits allow independent local capacity control. Wider coordination has stronger consistency requirements.
447. **Target Specification** — Rules can apply to client IDs, identity sets, hostname slices, or all traffic. Slices support gradual rollout.
448. **Configuration Structure** — Each rule includes target, metric, time window, scope, threshold, and active status. Multiple rules can coexist.
449. **Request Flow** — Middleware extracts identity, finds relevant rules, reads counters, compares thresholds, rejects or continues, then updates load. Early decisions avoid expensive work.
450. **Load Shedding Framework** — Similar runtime machinery evaluates local and external system metrics. Priority targeting lets operators shed progressively.
451. **Load Shedding Metrics** — Process counters cover local saturation and external telemetry covers dependencies such as storage and DB pools. Metric location should match the overloaded resource.
452. **Load Shedding Configuration** — Threshold rules identify traffic classes and resource signals, enabling low-priority requests to shed first. Critical classes are preserved until higher thresholds.
453. **Load Shedding Decision Process** — Current metrics are compared to limits and matched against request identity before continuing. Rejected work uses the same client-facing 429 response.
454. **Load Limiter Service** — A separate service gates CI scheduling on Mononoke health rather than letting jobs fail while the repository backend is overloaded. Its use case is load-aware admission.
455. **Integration with Job Scheduling** — Acquire, canAcquire, and release operations plug into an external-dependency scheduler. Blocked jobs remain queued instead of consuming workers.
456. **Load-Aware Scheduling** — CPU and service response examples illustrate how queued work can resume as pressure falls. This moves overload impact from job failures to delay.
457. **Configuration and Monitoring** — Separate settings define watched metrics and thresholds, and Scuba records decisions. Operators can analyze how often load blocks jobs.
458. **Blobstore-Level Rate Limiting** — ThrottledBlob limits storage calls and byte throughput independently from HTTP request admission. This protects shared backend capacity.
459. **ThrottledBlob Implementation** — Token buckets control read/write QPS and bytes with burst allowance and jitter. It sits in the blobstore decorator chain.
460. **Use Cases** — Throttling limits pressure on backend services, shared networks, and resilience tests. It can be scoped to a storage stack.
461. **Client Behavior** — Sapling/EdenFS apply bounded retry and backoff, preserve partial results, and surface filesystem errors if exhausted. Retries prevent indefinite waits.
462. **Configuration and Deployment** — Thrift config validates metrics and targets, updates dynamically, and publishes rejection telemetry. Standard config deployment controls rollout.
463. **Implementation Details** — The rate-limit trait, environment, config parser, request middleware, and internal counters divide responsibilities. The OSS implementation allows all traffic because internal metric services are absent.
464. **Related Components** — Request handlers, permission facets, monitoring, and cached config work alongside limits. Authorization and load control remain separate checks.
465. **Summary** — Client quotas, system shedding, blobstore throttling, and CI admission guard distinct pressure points. Dynamic policy and bounded client retry maintain service stability.
466. **Related Documentation** — Service, architecture, storage, and observability guides describe integration points. Component folders hold implementation detail.
467. **Overview** — Walker models repository artifacts as a graph and validates consistency, redundancy, and compression. It supports full walks and sampled work under memory constraints.
468. **Graph Representation** — Commits, content, manifests, mappings, and bookmarks form nodes with dynamically discovered edges. Blobstore and SQL data are validated in a shared traversal model.
469. **Graph Characteristics** — Backlinks create cycles, mutable records can be incomplete, and deep walks cover ancestor history. Visit tracking and bounded traversal address these properties.
470. **Subcommands** — Scrub, validate, corpus, and compression-benefit operations serve repair, consistency, extraction, and analysis. Each uses graph traversal for a different goal.
471. **Scrub** — The command checks component stores for missing copies and may copy available values to repair redundancy. It complements continuous WAL healing by finding older issues.
472. **Validate** — It loads nodes and verifies references, linknodes, phases, and structure from selected roots. Errors include source context for diagnosis.
473. **Corpus** — It exports selected blob data into a path/type directory tree for offline analysis. Hash or path sampling bounds output size.
474. **Compression Benefit** — It compares raw and Zstd sizes by blob type. Results inform storage packing decisions.
475. **Graph Traversal Implementation** — Bounded concurrent expansion unfolds reachable nodes while separating identity from loaded content. This supports large graphs without eagerly materializing everything.
476. **Visit Tracking** — Concurrent identity maps prevent loops but can themselves consume substantial memory. Small node identifiers limit this overhead.
477. **WalkVisitor Trait** — Start and visit callbacks allow operations to configure sampling, validate edges, and process data. Each subcommand supplies its own visitor behavior.
478. **Sampling Support** — Stable hash and path selectors split large walks into manageable parts, though shared-content path samples may vary. Sampling applies both to graph nodes and blob reads.
479. **Memory Management** — Visited identities and pending queues dominate memory use. Minimal nodes, streaming, bounded queues, and sampling mitigate pressure.
480. **Logging and Monitoring** — Metrics track node/edge counts, errors, repairs, and exports, while Scuba records routes and details. Local progress output supports interactive operation.
481. **Operational Usage** — Continuous checks, storage audits, offline corpus work, incident response, and capacity analysis are all described. Narrow roots and samples scope expensive walks.
482. **Integration with Storage Systems** — Walker uses ordinary blobstore layers, component-level scrub access, SQL metadata, and healer coordination. Its validation detects cases outside the healer WAL.
483. **Configuration and Execution** — Repository roots, filters, sampling, derivation, output, repair, and dry-run controls determine traversal. Continuous and one-shot modes fit different operations.
484. **Related Components** — Healer, admin, bounded traversal, and derived data connect validation to storage and framework behavior. These components supply tools the walker does not reimplement.
485. **Documentation** — The walker README, source, and integration fixtures provide deeper usage detail. This overview intentionally delegates to code-local documentation.
486. **Summary** — Four subcommands apply bounded graph walking to repair, validation, export, and compression study. Sampling extends these operations to very large repositories.
487. **Overview** — Metrics, logs, traces, health probes, and request counters provide operational visibility. The framework handles production-scale telemetry.
488. **Metrics (ODS Integration)** — Generated stats export rates, failures, latency distributions, and subsystem measurements to ODS. Dashboards and alerts consume these signals.
489. **Metric Types** — Counters, time series, dynamic dimensions, and histograms describe volume and latency distributions. Percentiles reveal tail behavior.
490. **Metric Locations** — Servers, jobs, storage, and features define their own measures for request, repair, cache, sync, and derivation work. Metrics mirror architectural layers.
491. **Using Metrics** — Generated `STATS` APIs update typed counters and histograms. The framework aggregates and exports them.
492. **Logging (Scuba)** — Structured samples record request, operation, performance, and outcome fields. Scuba is the primary event-analysis path.
493. **CoreContext and Scuba** — A context carries session and logging state through operations and accumulates fields. It gives nested code a shared observability channel.
494. **Scuba Fields** — Client, repository, request, duration, storage, transfer, and result attributes make samples filterable. Field selection supports diagnosis and aggregate analysis.
495. **Verbosity Levels** — Normal logging is complemented by selective verbose output keyed by user, host, or session. This enables detail without logging everything at high volume.
496. **Scuba Tables** — Protocols and jobs write to separate named datasets with domain-specific fields. Data ownership follows the component producing events.
497. **Tracing** — The tracing crate adds hierarchical spans and events, correlating work across layers and services. Request context can carry IDs across boundaries.
498. **Usage** — Instrumentation uses log events and spans around async functions. This makes nested work and slow derivation observable.
499. **Log Levels** — Error, warning, info, and debug distinguish severity and routine details. Deployment controls destinations and verbosity.
500. **Request Context and Tracking** — CoreContext tracks identity, permissions, logging, counters, and source metadata through handlers and storage. Context propagation enables cross-layer diagnostics.
501. **Context Contents** — Session, logging, and client attributes are bundled to accompany each request. These enrich policy checks and telemetry.
502. **Context Flow** — Protocol entry creates context, then API, features, facets, and storage enrich it. Completion emits accumulated logs and counters.
503. **Context Operations** — Clone/reset, counter forks, and sample mutation support isolated suboperations and parallel branches. Callers can preserve correlation while changing local instrumentation.
504. **Performance Counters** — Blob operations, cache hits, protocol objects, and transferred bytes are aggregated for each request. Nested stacks account for suboperations.
505. **Counter Types** — Storage, cache, endpoint-specific, and transfer measures are explicitly enumerated. This provides detailed cost attribution.
506. **Counter Access** — Code obtains counters from CoreContext, with storage and protocol layers updating their respective measures. Completion exports the results.
507. **Health Checks** — HTTP probes and FB303 status report whether instances can serve traffic. Monitoring is integrated into the common application framework.
508. **HTTP Health Checks** — Root and health endpoints return alive or exiting markers for load balancers. Shutdown state is surfaced to routing infrastructure.
509. **FB303 Service** — Status values, Thrift inspection, and optional Prometheus export expose process readiness and counters. MononokeApp starts this framework.
510. **Monitoring Framework** — Standard app initialization installs status, metrics, shutdown, and health-check support. Individual binaries inherit common behavior.
511. **Common Patterns** — Middleware, dashboards, and query practices organize operational signals. Component-specific metrics can be correlated with request samples.
512. **Request Logging** — HTTP, Scuba, and ODS middleware record request lines, structured context, duration, status, and size. Different mechanisms serve debugging and aggregation.
513. **Operational Dashboards** — Health, resource, feature, and job panels summarize latency, errors, cache, derivation, and progress. The metrics feed capacity and incident views.
514. **Query Patterns** — Scuba filters trace sessions, repositories, and endpoints; ODS aggregates timeseries and alerts. Combining them links event details with trends.
515. **Integration with Deployment** — Flags and cached configuration determine ports, datasets, verbosity, and sampling. Changes can propagate without restarting the service.
516. **Relationship to Architecture** — Each service, API, feature, repository, and storage layer contributes its own observations. This parallels the layered system design.
517. **Related Documentation** — Architecture, jobs, and services explain where instrumentation is emitted. These cross-links aid operational orientation.
518. **Background** — SCS and SLAPI are characterized as criticality-2 developer services, not production request dependencies. Their outage degrades engineering work but is not itself a production SEV1.
519. **Why Source Control Is Not Needed for Production Recovery** — Conveyor rollback and independent deployment/config systems can restore production without a live source-control service. Landing a fix is only one recovery route.
520. **What SCS Outages Actually Affect** — Code browsing, reviews, automation, and batch indexing workflows are listed as affected. These are described as productivity losses rather than live production impact.
521. **For Service Owners: Removing Incorrect Criticality Dependencies** — Owners should ensure rollback paths, avoid gating active incident recovery on code review, and separate deployment from live SCM availability. This is prescriptive incident-response guidance.
522. **Related Documentation** — Service architecture and observability links support outage context, with an oncall reference. The section identifies where operational questions route.
523. **Bonsai Data Model and Core Types** — This heading groups proposals about core commit and path representations. The source cautions that its automated-analysis suggestions need validation.
524. **Remove `BonsaiChangeset::git_tree_hash`** — The proposed cleanup moves a legacy tree reference out of Bonsai's general changeset fields. The note argues for a separate mapping or type to simplify validation.
525. **Consolidate Duplicated VCS Mapping Trait Pattern** — Similar ID mapping traits are proposed for a generic abstraction or macro. The claimed benefit is reduced maintenance duplication, but the specific variation would need review.
526. **Restructure FileChange Enum** — A proposed struct with change type, tracking, and optional data would consolidate variants and allow copy metadata for untracked changes. It would alter a core type and needs compatibility analysis.
527. **Eliminate Clone Overhead in Unode ID Computation** — The note suggests caching IDs or hashing borrowed structures to avoid cloning. It frames this as a performance opportunity requiring measurement.
528. **Consolidate Path Type Proliferation** — Several overlapping path types are proposed for reduction to a smaller, clearer family. Type-safety and conversion ergonomics would need balancing.
529. **Repository Facets and Composition** — This group identifies proposed simplifications to facet bounds and derived-data responsibilities. The proposals target API clarity rather than adding new product behavior.
530. **Reduce Trait Bound Verbosity** — Semantic facet groups could replace long lists of trait bounds. This may improve readability but risks hiding precise dependencies.
531. **Standardize Arc vs Ref Trait Suffixes** — A consistent accessor naming rule is proposed to reduce variation. The author suggests preferring references, but the impact on ownership ergonomics needs judgment.
532. **Split RepoDerivedData Facet** — Configuration, registry, manager, and selection responsibilities could be separate facets. The proposal addresses testability and a large interface.
533. **Derived Data Framework** — The section collects proposed deduplication, tuning, migration, and test improvements. It is a backlog of candidate work, not a committed architecture.
534. **Eliminate Duplicate get_file_changes Implementations** — Repeated logic across derivation types could move into a shared helper. This is a low-level deduplication proposal.
535. **Abstract Mapping Storage Boilerplate** — A macro or trait could generate repeated mapping key and persistence code. The note claims less copy/paste and easier format evolution.
536. **Centralize Hardcoded Buffer/Concurrency Constants** — A tuning configuration could gather repeated worker limits and batch sizes. This would add runtime adjustability but needs safe defaults and operational control.
537. **Deprecate and Remove Skeleton Manifest V1** — The older implementation is proposed for retirement after a migration plan. Compatibility and remaining consumers would determine readiness.
538. **Standardize Batch Derivation Strategies** — Documented patterns and templates could clarify when derivation should be sequential, parallel, or stacked. Consistent guidance may improve performance and correctness.
539. **Expand derive_from_predecessor Pattern** — More derived types might support predecessor-based backfill, with docs and helpers to encourage it. The large claimed speedup is an estimate to validate per type.
540. **Implement Outstanding Performance TODOs** — The note recommends benchmarking named TODOs before prioritizing implementation. Measurement distinguishes real bottlenecks from speculative cleanups.
541. **Create Shared Thrift Serialization Framework** — Common conversion and error handling could be generated rather than repeated. Type-specific serialization needs could limit generalization.
542. **Unify Testing Infrastructure** — Shared repository fixtures and helpers could reduce duplicated type-specific test setup. The proposal emphasizes consistent coverage.
543. **Storage Architecture** — Proposed changes focus on making decorator composition, options, scrubbing, and put guarantees easier to understand. These touch a cross-cutting persistence foundation.
544. **Simplify Decorator Stack Configuration** — A builder could make order and combinations explicit and testable. This responds to recursive factory logic and wrapper flags.
545. **Reduce BlobstoreOptions Proliferation** — Grouped or builder-based options could avoid cloning unrelated configuration. The proposal aims to loosen coupling between decorators.
546. **Clarify Scrub Configuration** — Separate policy, write-only behavior, and timing types could make the many modes safer to configure. The source proposes stronger invalid-state prevention.
547. **Clarify PutBehaviour vs OverwriteStatus** — Renaming and documenting outcome guarantees could make decorator semantics explicit. Assertions could catch wrappers that lose status information.
548. **Improve Blobstore Enumeration** — Structured key transforms, filtering, pagination, and tokens could make large key listings safer and easier to debug. It targets memory and data-transfer limits.
549. **Server and API Layer** — This group catalogues duplicated middleware, health, sharding, TLS, lifecycle, and resolution logic. The ideas aim to standardize server construction.
550. **Unify RequestContextMiddleware Implementations** — A configurable shared middleware could reduce differences in authentication and method tracking. The proposal spans LFS and generic HTTP servers.
551. **Standardize Error Formatting Across Servers** — A protocol-aware shared formatter could align request IDs and error detail while preserving wire formats. Consistency and information exposure both need review.
552. **Create Shared Health Check Handler** — A reusable handler could standardize readiness, shutdown, and delay behavior. The proposal addresses differences currently visible to load balancers.
553. **Eliminate Repo Sharding Logic Duplication** — A generic sharded-process helper could replace nearly repeated server code. Shared logic would give a single maintenance point.
554. **Unify TLS Acceptor Setup** — A common TLS builder could remove repeated initialization and centralize updates. Protocol-specific ALPN configuration remains a design constraint.
555. **Clarify Server Initialization Patterns** — Similar but differently shaped shutdown methods could be unified or renamed. The proposal aims to clarify termination ownership.
556. **Standardize Middleware Stack Ordering** — A documented builder could establish consistent middleware phases across servers. Ordering changes must preserve authentication and observability semantics.
557. **Create Shared Repo Resolution Logic** — A resolver abstraction could validate path variants and standardize not-found behavior. It could also support aliases.
558. **Add ConnectionSecurityChecker Helper** — Common app setup could provide the repeated connection-security check. Centralization reduces omissions when new servers are added.
559. **Create Bound Address File Writing Utility** — A helper could unify optional bound-address output and error handling. Atomic writing is noted as a possible extension.
560. **Testing Infrastructure** — Proposals address oversized shell helpers, polling, fixtures, diagnostics, timings, language boundaries, and missing unit tests. The section's estimates are suggestions rather than verified results.
561. **Split Monolithic Test Library File** — Dividing the large integration shell library by purpose could improve navigation and reduce merge conflicts. The proposal groups setup, wait, and admin helpers separately.
562. **Consolidate wait_for_* Functions** — A parameterized condition waiter could replace many similar poll loops and hardcoded timing. Better diagnostics and consistent timeout policy are intended benefits.
563. **Replace Hardcoded Sleep Calls** — Condition-based waiting could remove slow or flaky fixed sleeps. The suggested exponential backoff and filesystem notifications require careful test semantics.
564. **Standardize Test Repository Setup** — More shared fixtures could replace repeated manual repository initialization. Adoption and fixture flexibility would determine the actual reduction.
565. **Improve Test Failure Diagnostics** — Wait failures could capture logs and structured context automatically. This targets time spent diagnosing parallel integration failures.
566. **Add Test Performance Tracking** — Operation timings and regression thresholds could reveal gradual slowdown in tests marked slow. Baselines and variance need calibration.
567. **Complete Shell/Python Migration** — The note asks for a deliberate choice between shell and Python rather than a fragile wrapper mixture. Completion could remove confusing environment-passing behavior.
568. **Abstract Test-Specific Library Patterns** — Shared configuration builders could reduce duplication in specialized push and LFS fixtures. Declarative setup may improve validation.
569. **Add Missing Test Helpers** — Reusable assertions and commit/push helpers could make repetitive integration scenarios clearer. They should encode stable test intent.
570. **Add Unit Tests for Test Infrastructure** — Tests for the harness itself could prevent shared helper regressions from affecting all suites. The suggested shell-library coverage is additional maintenance.
571. **About Mononoke** — This index reiterates Bonsai as the VCS-neutral source of truth and asynchronous indexing as a scalability mechanism. It introduces the ecosystem and intended scale before directing readers deeper.
572. **About This Documentation** — The collection targets developers, operators, and agents with high-level architecture and operations material. Build workflows, API detail, and runbooks are explicitly located elsewhere.
573. **Getting Started** — New readers should begin with the introduction; developers are sent to CLAUDE.md for build guidance. The advice separates conceptual onboarding from code workflow.
574. **Documentation Contents** — The table of contents maps introduction, architecture, components, features, VCS integration, operations, and future improvements. Short descriptions help route readers to relevant topics.
575. **1. Introduction** — The section covers orientation, concepts, system architecture, and code navigation. It establishes the core model before detailed component material.
576. **2. Architecture** — Bonsai, facets, derived data, and storage are grouped as foundational design. Their relationships underpin later operational choices.
577. **3. Components** — Servers, jobs, tools, and shared libraries form the execution and developer-facing component guide. Lifecycle distinguishes these groups.
578. **4. Features** — Pushrebase, cross-repo sync, hooks, redaction, and Microwave describe operational source-control behaviors. These are built on the core architecture.
579. **5. VCS Integration** — Git, Mercurial, and Sapling compatibility are treated as explicit protocol and data-model layers. Bonsai connects the formats.
580. **6. Operations** — Rate control, validation, observability, and availability address running the service. The appendix points to longer-term engineering work.
581. **Appendix A. Future Improvements** — The appendix collects technical-debt opportunities rather than immediate implementation tasks. Readers are asked to assess items critically.
582. **Additional Resources** — Development docs, source locations, related projects, and external links extend the high-level guide. The listing distinguishes code from documentation.
583. **Contributing** — Architecture and component changes should update these docs, while implementation details belong with code. The requested tone is factual and cross-referenced.
584. **Overview** — The guide introduces an internal Skycastle pipeline that imports Git bundles from Manifold into Mononoke and verifies resulting refs. It covers preparation through completion and recovery.
585. **Prerequisites** — Users need fbsource, Manifold and Skycastle CLIs, and corporate VPN access. The instructions assume a Fedora development host.
586. **Step 1: Prepare the Git Bundle** — A repository can be exported to a bundle containing all refs, then verified before upload. Existing bundles skip this creation step.
587. **Step 2: Upload the Git Bundle to Manifold** — The bundle is placed in a bucket/key with the Manifold CLI, then listing confirms the object. The CLI argument order and credentials are explicitly explained.
588. **Step 3: Trigger the Skycastle Pipeline** — A schedule command names the workflow and passes repo and bundle key flags. The workflow performs repo creation, import, cache refresh, and ref checking.
589. **Required Inputs** — Repository names use a namespace/repo form, while the bundle key identifies its location in the bucket. These are the minimum workflow parameters.
590. **Optional Inputs** — Bucket, API key, oncall, selected refs, ACL group, and import concurrency can be overridden. The default concurrency is 20.
591. **Minimal Example** — The abbreviated schedule invocation supplies only repository and key values. Defaults fill in other pipeline settings.
592. **Full Example (with all flags explicit)** — The expanded invocation shows the commonly relevant bucket and oncall options explicitly. It demonstrates customization without changing workflow structure.
593. **Successful Output** — The CLI returns invocation, workflow, and job identifiers and URLs. Operators should retain the workflow URL for status checks.
594. **Step 4: Check Pipeline Status** — CLI, browser workflow, and execution job pages expose progress and logs. Each offers a different level of status detail.
595. **Option A: Via CLI** — The workflow-run status subcommand checks a run by ID. An example shows the expected argument.
596. **Option B: Via Browser** — A workflow URL displays the status of all seven sequential stages and links to their logs. This is a UI alternative to CLI polling.
597. **Option C: Via Execution Job URL** — The job link exposes detailed action logs for the run. It is useful for debugging failed stages.
598. **Pipeline Steps Explained** — Seven steps validate the object, create or locate a repo, clone, fetch, import, bust cache, and compare refs. Retry behavior and preconditions are documented for two long-running stages.
599. **Troubleshooting** — The guide covers repo creation, import retries, ref mismatches, networking, CLI setup, and infrastructure failures. Recovery advice is specific to each failure point.
600. **Repo creation uses wrong oncall** — Override the configured oncall flag when the default team is not appropriate. This changes repo-creation ownership.
601. **Repo creation: the config mutation died** — Known canary and concurrent-config failures release the reservation and trigger bounded resubmission. After three attempts, the final error is reported.
602. **Repo creation timed out** — If polling reaches 45 minutes without a terminal result, inspect SCS and the last response. Re-running is safe because existing repos are detected.
603. **Repo creation aborted after unrecognised responses** — Five unknown replies stop automatic recreation because the original mutation may still be live. Operators must inspect the mutation before retrying.
604. **Gitimport fails after all retries** — Config propagation and excessive concurrency are common causes, with logs needed for diagnosis. Very large repositories may need concurrency reduced to five.
605. **Verification failed: refs do not match** — Extra preexisting refs may be benign, while missing refs or stale cache require checking import logs and querying the server again. Cache propagation can take time.
606. **Manifold upload/download failures** — Check the key, object integrity, bucket existence, and permissions. The bundle can be independently verified.
607. **Clone fails during Step 2** — Empty new repositories are expected and handled by creating a bare repo; failures for existing repos suggest connectivity or service issues. The guide distinguishes these cases.
608. **"arc skycastle" command not found** — Install the Arcanist package on Fedora if the CLI is unavailable. The step addresses tool setup.
609. **VPN connectivity issues** — All pipeline operations depend on corporate VPN reachability. A request to the Git host is suggested as a connectivity check.
610. **Pipeline infra failures and retries** — Three automatic whole-workflow retries cover infrastructure faults, not bad inputs or permission errors. Failure class determines whether retry is expected.
611. **Prerequisites** — Local testing assumes a devserver, Buck2, and optionally tmux. OnDemand may not provide the expected environment.
612. **Quick Start** — The sequence bootstraps data, builds binaries, edits config, starts services, and exercises a client and admin tool. It forms an end-to-end local workflow.
613. **1. Bootstrap** — A bootstrap script creates the local Mononoke home and data layout. The example uses a per-user directory.
614. **2. Build Binaries** — Optimized bootstrap binaries are built with limited threads to avoid linker memory exhaustion. Jumbo devservers may omit the limit.
615. **3. Configure** — A local TOML file controls repository features such as derivation, hooks, and pushrebase. Testing behavior requires changing this config.
616. **4. Start the Servers** — Mononoke and SCS run in separate terminals, and a client command checks the local Thrift endpoint. The guide points to tmux as a convenience.
617. **5. Clone and Create Test Commits** — A local client clone supports making and pushing a first changeset, then subsequent work. Initial bookmark creation requires a force/create push.
618. **6. Creating Merge Commits** — The client must explicitly enable merge support, create divergent commits, merge, and push. The sequence shows how to exercise server merge behavior locally.
619. **7. Admin CLI** — Local admin scripts can derive, inspect, and list repository data. Full Mercurial hashes are accepted as an alternative to bookmark selection.
620. **8. Starting Fresh** — Stopping services and deleting the local home followed by bootstrap resets the environment. Config edits and clones must then be recreated.
621. **Tmux Setup** — Separate windows or a four-pane layout can keep server, client, and admin sessions visible together. This is optional convenience, not a runtime requirement.
622. **Option A: Separate Windows** — One tmux window per service or task provides full-screen views and simple switching. Working directories are assigned per command.
623. **Option B: Panes in a Single Window** — A 2×2 split displays Mononoke, SCS, admin, and client simultaneously. Pane navigation is by arrow keys.
624. **Start the Servers** — Set the Mononoke home and launch each server in its own pane/window. Foreground processes expose their logs.
625. **Use the Other Panes/Windows** — The client pane creates commits and checks smartlog; the admin pane inspects state and derivation. Each has a clear task role.
626. **Troubleshooting** — Build, hash formatting, first bookmark creation, identity, and cache freshness have targeted remedies. These address common local setup failures.
627. **`env.txt: No such file or directory`** — Build the bootstrap binary target before starting scripts that depend on its generated environment. The error is treated as an incomplete build.
628. **`Invalid commit id` from admin CLI** — The admin `-i` form requires a full 40-character Mercurial hash, obtainable from the client log template. Abbreviated IDs are insufficient here.
629. **`abort: could not find remote bookmark 'main'`** — Use `--create` on the first push to establish the bookmark. Later pushes can omit it.
630. **Permission errors with `scsc`** — Local identity and allowlist settings must agree in common configuration. A linked internal wiki provides more setup detail.
631. **Stale data after code changes** — Local blobstore cache state may survive binaries changing, so wiping and re-bootstrapping resets it. This is a development-only cleanup approach.

# Sapling SCM: Introduction
URL: https://sapling-scm.com/docs/introduction/
Fetched: 2026-10-15 20:32:01 UTC; method: `curl -fL https://sapling-scm.com/docs/introduction/ -o "$DELEGATE_SCRATCH_DIR/sapling-introduction.html"`; extracted visible HTML text with Python 3 `html.parser.HTMLParser` (excluding script/style/noscript/svg), then read the full `sapling-introduction.txt`.
Raw SHA-256: eb6e5d66c5f9de04e50256aaa3db4f314616a6eacb33f1f800fc8aeba37a59b9 (`shasum -a 256 "$DELEGATE_SCRATCH_DIR/sapling-introduction.html"`)
Extracted words: 1227 (`wc -w "$DELEGATE_SCRATCH_DIR/sapling-introduction.txt"`)
Read status: read in full
## Sections
1. **Overview** — Sapling is described as Meta-developed source control with usability and scalability as priorities, while retaining familiar Git/Mercurial concepts. The server and virtual filesystem are not publicly available, but the CLI can work with GitHub repositories.
2. **Why make a new version control?** — Sapling began to address monorepo scale and then invested in developer-facing workflow improvements. The page argues that client UX and repository format can be separated, allowing a scalable internal system to interoperate with Git.
3. **Basic concepts** — The walkthrough demonstrates clone, smartlog, checkout, status, add, commit, amend/restack, bookmarks, hide/unhide, unamend, revert, and push. It presents easy history repair and stacked commits as central user-facing strengths, and contrasts server-side Sapling rebasing with Git's client-side rebase requirement.
4. **Caveats** — The most polished environment is described as corporate, online, single-master, rebase-oriented, and monorepo-focused. Git support may still have rough edges, so the page does not claim equal maturity for every workflow.
## What it means for Concord v3
The source agrees with the draft's named **server-side change landing** section that moving coordination to a server can remove client retry work; it gives a concrete UX example in transparent rebasing and restacking. Sapling's smartlog and history-repair operations are relevant comparison points for Concord's **runs/swarms on issues or milestones**, but the page does not establish that Concord should reproduce a DVCS commit graph UX. Git interop supports the draft's **one-way GitHub mirror** as a practical boundary between a primary forge and external Git ecosystems; the page offers no reason to make mirroring bidirectional. Its corporate, online, single-master assumptions differ from Concord's agent-first multi-repository environment, so those constraints should be treated as Sapling's context, not adopted requirements.

| URL | Extracted words | Read status |
| --- | ---: | --- |
| https://github.com/facebook/sapling/tree/79071c2a3ea20c36ed71332608535e5801101bba/eden/mononoke | 51606 | read in full |
| https://sapling-scm.com/docs/introduction/ | 1227 | read in full |
