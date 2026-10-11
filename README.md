# Concord

Git conflicts on lines. Agents collide on meaning.

Concord is a git platform for many agents working at once, built on Cloudflare Workers and
Artifacts. It is an entry to Cloudflare's "Build the Next-Gen Git Platform" competition.

Status: design only. The implementation is split into twelve bounded slices; there is no deployed
service or runnable product yet. Nothing in the existing agent fleet switches hosting for the demo.

- [Architecture](docs/ARCHITECTURE.md): verified Cloudflare capability boundary, semantic leases,
  checker-backed landing, content-bound review, APIs, authentication, and local runners.
- [Implementation slices](docs/specs/README.md): dependencies, file ownership, parallel workers,
  cut list, and schedule targeting Tuesday, October 13, 2026 at 6 pm CT.
- [Nine-minute demo](docs/DEMO.md): an owned synthetic repo, real checker, exact proposed scene
  commands, and provenance requirements for historical replay.
- [Judging map](docs/JUDGING.md): feature evidence against the 50% / 25% / 25% criteria.

Validate the current documentation-phase repository:

```sh
sh scripts/validate.sh
```

Slice 01 replaces that lightweight gate with typecheck and local tests. The demo's npm commands
are implementation contracts until the slices land. Local development will use a labelled storage
fake; deployed Workers + Artifacts evidence remains gated on the owner's Cloudflare account.

The public demo excludes ROM bytes, proprietary compilers/inputs, and decompiled C by default.
Historical improvement claims require sanitized recorded timelines; the supplied aggregate numbers
are motivation, not a fabricated replay benchmark. Licensed under [MIT](LICENSE).
