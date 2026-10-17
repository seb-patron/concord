# Draft 5 repair ledger

Independent review: `review-astra-126.md`, 17 October 2026. The locations below refer to the repaired HTML and tracker. “Fixed” means the document now records the rule or open test accurately; it does not mean a proposed v3 mechanism is live.

| ID | One-line summary | What changed, with section and line | Status |
| --- | --- | --- | --- |
| R01 | Owner-token force release superseded human-only wording. | §7, HTML line 189; tracker §7 wait control row: any owner token may force-release through API/CLI/MCP, while pause and move-to-front remain human controls. | fixed |
| R02 | Every post-send issue edit invalidates results. | §6, HTML line 179; tracker §6 edit row: unconditional invalidation and current-version checks at publish, review completion and land. | fixed |
| R03 | Wait-cycle recovery needs exact victim and deadline rules. | §7, HTML lines 190–191; tracker wait rows: stable renewal fence, original absolute deadline, youngest issue attempt, all holds/waits revoked, new sequence and X/Y example. | fixed |
| R04 | Canonical Artifacts writes need a separate enforcing gateway. | §11, HTML lines 221–236; diagram and prose place token only at gateway and order revocation, old in-flight drain/rejection, then replacement admission. | fixed |
| R05 | Symbol-engine decision chronology was missing. | §7, HTML line 185; tracker symbol row: tree-sitter instruction, later Git-funcname milestone, measured finder and Python-only prototype slice are distinct; owner selection remains open in §16. | fixed |
| R06 | Language-specific fallback denominators were absent. | §7, HTML line 184; Bash, Markdown, Python and TypeScript counts, non-additivity and unexercised-language caveat added. | fixed |
| R07 | Backend budget contract had no reservation or stop semantics. | §14, HTML line 288; §14, HTML backend table and broker paragraph: four backend limits, missing usage, reservation, overshoot and confirmed termination. | fixed |
| R08 | Replay omitted refused and repeated request accounting. | §11, HTML line 239; §11 request-stream paragraph and §14 metrics paragraph: requests and mutations separated; calls per accepted land and semantic acceptance distinguished from protocol success. | fixed |
| R09 | Audit appendix repeated fix instructions. | §17, HTML line 331; §17, HTML appendix: all 80 rows now identify draft 4 text, a disposition and body anchor, label, numbered audit row and supporting evidence file. Branch choice, 17 October GitHub supersession and claim glossary have specific resolutions. | fixed |
| R10 | Owner decisions were mixed with synthesis and own-forge date was wrong. | §15, HTML line 308; §§1, 4 and 15: own-forge date corrected to 15 October; plans-first owner decision separated from assumed component split. Tracker decisions use the paragraph's exact IDs. | fixed |
| R11 | Tracker answer and metadata were unreliable. | tracker lines 1–126; Tracker regenerated from final §§5–16, with complete hosting answer, one row per paragraph/table mechanism, local decision IDs expanded to plain meanings and specific test names. | fixed |
| R12 | Read budgets omitted authorization and cache costs. | §11, HTML line 241; §11 read-budget paragraph: proposed route caps, current-access cache rule and seeded-history rows/bytes/CPU/latency measurements. | fixed |
| R13 | Hosting observations were misclassified as structural. | §11, HTML line 218; §11 dated baseline now CAPABILITY-DEPENDENT; §12 distinguishes dated topology from structural module reading. | fixed |
| R14 | Cited sources were hard to follow. | §18, HTML line 414; §17 names audit row and underlying file for each resolution; §18 adds claim and decision-state navigation. Local file links require the separately supplied bundle and may not open in remote PR rendering. | fixed |
| R15 | Mechanism terms were not explained. | §5, HTML line 119; §5 compact glossary defines principal, stable intent, footprint, epoch, CAS, DO, R2, SSE and refspec. | fixed |
| R16 | V2 UI reuse answer was unfinished. | §12, HTML line 260; §12, HTML: repaired audit's per-view disposition, operation mapping, live-update change, new views, core server dispositions and explicitly estimated effort replace the pending placeholder; tracker §12 regenerated. | fixed |

Open production choices remain in §16. A recorded open choice is not treated as approval or as deployed behavior.
