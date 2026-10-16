#!/usr/bin/env python3
"""Replay symbol claims on the SP-F5 overlapping merged-pull-request sample.

Inputs are read-only local clones and GitHub pull metadata. All Git objects
created by merge-tree and all fetched heads live in temporary bare mirrors.
"""

from __future__ import annotations

import collections
import datetime as dt
import hashlib
import importlib.metadata
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from tree_sitter import Query, QueryCursor
from tree_sitter_language_pack import get_language, get_parser


REPOS = (
    ("seb-patron/concord", "concord"),
    ("seb-patron/agent-workflows", "agent-workflows"),
    ("seb-patron/gen-v-research-tools", "gen-v-research-tools"),
    ("seb-patron/mwcc-rs", "mwcc-rs"),
    ("seb-patron/gen-v-decomp", "gen-v-decomp"),
)
CLONES = Path(os.environ.get("CONCORD_REPLAY_CLONES", str(Path.home() / "agent-runs/clones")))
SCRATCH = Path(os.environ.get("DELEGATE_SCRATCH_DIR", os.environ.get("TMPDIR", "/tmp")))
OUTPUT = Path("spikes/v3/round2/c4/output.txt")
PAIRS = Path("spikes/v3/round2/c4/clean-pairs.tsv")
HUNK = re.compile(rb"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
EXT = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "javascript",
    ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".rs": "rust",
    ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp",
    ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp", ".md": "markdown",
    ".markdown": "markdown", ".mdx": "markdown", ".sh": "bash", ".css": "css",
    ".html": "html", ".htm": "html", ".sql": "sql", ".go": "go",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
}
# Each entry is an explicit query for the named language. A bad query is a
# fatal setup error; silently dropping a pattern would inflate file fallbacks.
QUERY = {
    "typescript": "[(function_declaration) (generator_function_declaration) (method_definition) (class_declaration) (abstract_class_declaration) (interface_declaration) (type_alias_declaration) (enum_declaration) (lexical_declaration) (variable_declaration)] @unit",
    "tsx": "[(function_declaration) (generator_function_declaration) (method_definition) (class_declaration) (abstract_class_declaration) (interface_declaration) (type_alias_declaration) (enum_declaration) (lexical_declaration) (variable_declaration)] @unit",
    "javascript": "[(function_declaration) (generator_function_declaration) (method_definition) (class_declaration) (lexical_declaration) (variable_declaration)] @unit",
    "python": "[(function_definition) (class_definition) (expression_statement)] @unit",
    "rust": "[(function_item) (struct_item) (enum_item) (trait_item) (impl_item) (mod_item) (const_item) (static_item) (type_item) (macro_definition)] @unit",
    "c": "[(function_definition) (declaration) (struct_specifier) (enum_specifier) (type_definition)] @unit",
    "cpp": "[(function_definition) (declaration) (class_specifier) (struct_specifier) (enum_specifier) (namespace_definition) (template_declaration) (type_definition)] @unit",
    "markdown": "[(atx_heading) (setext_heading)] @unit",
    "bash": "[(function_definition) (command)] @unit",
    "css": "[(rule_set) (at_rule)] @unit",
    "html": "(element) @unit",
    "sql": "[(statement) (function_declaration)] @unit",
    "go": "[(function_declaration) (method_declaration) (type_declaration) (var_declaration) (const_declaration)] @unit",
    "json": "(pair) @unit",
    "yaml": "(block_mapping_pair) @unit",
    "toml": "[(pair) (table) (table_array_element)] @unit",
}
TOP_LEVEL_ONLY = {"expression_statement", "declaration", "type_definition", "lexical_declaration", "variable_declaration", "command", "statement", "pair", "block_mapping_pair", "table", "table_array_element"}
OLD_FALLBACKS = {
    # Historical SP-F5 raw output. These count code-side attempts, not distinct
    # hunks, and parse/query error can overlap missing file side.
    "missing file side": 6907,
    "parse/query error": 148346,
    "grammar unavailable": 0,
}
BASELINE_PRS = {"concord": 49, "agent-workflows": 340,
                "gen-v-research-tools": 436, "mwcc-rs": 587, "gen-v-decomp": 1310}
BASELINE_UNIVERSE = {"concord": 104, "agent-workflows": 790,
                     "gen-v-research-tools": 1170, "mwcc-rs": 1247, "gen-v-decomp": 4283}


def run(args, *, env=None, binary=False, ok=(0,)):
    p = subprocess.run(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode not in ok:
        # A Git remote may carry credentials. Keep errors free of argument and
        # stderr text, both of which can echo a remote URL.
        raise RuntimeError(f"command failed ({p.returncode}): {args[0]}")
    return p.stdout if binary else p.stdout.decode("utf-8", "replace")


def git(mirror, args, env, *, binary=False, ok=(0,)):
    return run(["git", f"--git-dir={mirror}", *args], env=env, binary=binary, ok=ok)


def gh_prs(repo):
    command = ["gh", "api", "--paginate", f"repos/{repo}/pulls?state=closed&per_page=100",
               "--jq", "[.[] | select(.merged_at != null) | {number,created_at,merged_at,head:{sha:.head.sha}}]"]
    raw = run(command)
    decoder, pos, prs = json.JSONDecoder(), 0, []
    while pos < len(raw):
        while pos < len(raw) and raw[pos].isspace():
            pos += 1
        if pos == len(raw):
            break
        page, pos = decoder.raw_decode(raw, pos)
        prs.extend({"number": p["number"], "created_at": p["created_at"],
                    "merged_at": p["merged_at"], "head": p["head"]["sha"]} for p in page)
    return prs


def instant(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def overlapping(prs):
    active, pairs = [], []
    for pr in sorted(prs, key=lambda p: (p["created_at"], p["number"])):
        active = [old for old in active if instant(old["merged_at"]) > instant(pr["created_at"])]
        pairs.extend((old, pr) for old in active)
        active.append(pr)
    return pairs


def ranked(prs, repo):
    pairs = overlapping(prs)
    return pairs, sorted(pairs, key=lambda pair: hashlib.sha256(
        f"{repo}:{pair[0]['number']}:{pair[1]['number']}".encode()).hexdigest())


def mirror_for(clone, name):
    mirror = SCRATCH / "c4-bare-clones" / (name + ".git")
    if not (mirror / "HEAD").exists():
        mirror.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", "--bare", "--shared", str(clone), str(mirror)])
    env = os.environ.copy()
    remote = run(["git", "-C", str(clone), "remote", "get-url", "origin"]).strip()
    return mirror, env, remote


def ensure_head(mirror, env, remote, pr):
    sha = pr["head"]
    if subprocess.run(["git", f"--git-dir={mirror}", "cat-file", "-e", f"{sha}^{{commit}}"],
                      env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        return 0
    number = pr["number"]
    command = ["git", f"--git-dir={mirror}", "fetch", "--no-tags", remote,
               f"+refs/pull/{number}/head:refs/pull/{number}/head"]
    proc = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode:
        proc = subprocess.run(command[:-1] + [sha], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode:
        raise RuntimeError(f"cannot fetch pull request {number} head into temporary mirror")
    git(mirror, ["cat-file", "-e", f"{sha}^{{commit}}"], env)
    return 1


def changed_paths(mirror, env, base, head):
    raw = git(mirror, ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base, head], env, binary=True)
    return {item.decode("utf-8", "surrogateescape") for item in raw.split(b"\0") if item}


def renamed_paths(mirror, env, base, head):
    raw = git(mirror, ["diff", "--no-ext-diff", "--find-renames", "--name-status", "-z", base, head], env, binary=True)
    fields, index, paths = raw.split(b"\0"), 0, set()
    while index < len(fields) and fields[index]:
        status = fields[index].decode("ascii", "replace")
        index += 1
        if status.startswith(("R", "C")):
            paths.add(fields[index].decode("utf-8", "surrogateescape"))
            paths.add(fields[index + 1].decode("utf-8", "surrogateescape"))
            index += 2
        else:
            index += 1
    return paths


def language(path, source=None):
    known = EXT.get(Path(path).suffix.lower())
    if known:
        return known
    if source and source.startswith(b"#!"):
        shebang = source.split(b"\n", 1)[0].lower()
        if b"bash" in shebang or shebang.endswith(b"/sh") or b"/sh " in shebang:
            return "bash"
        if b"python" in shebang:
            return "python"
    return "unsupported"


def blob(mirror, env, rev, path):
    proc = subprocess.run(["git", f"--git-dir={mirror}", "show", f"{rev}:{path}"],
                          env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return proc.stdout if proc.returncode == 0 else None


def hunks(mirror, env, base, head, path):
    raw = git(mirror, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0",
                       base, head, "--", path], env, binary=True)
    out = []
    for line in raw.splitlines():
        match = HUNK.match(line)
        if match:
            a, ac, b, bc = match.groups()
            out.append((int(a), int(ac) if ac is not None else 1,
                        int(b), int(bc) if bc is not None else 1))
    return out


def text_of(source, node):
    return source[node.start_byte:node.end_byte].decode("utf-8", "replace").strip()


def markdown_heading(node, source):
    if node.type == "setext_heading":
        underline = next((child for child in node.children if child.type.startswith("setext_h")), None)
        content = node.child_by_field_name("heading_content")
        return (1 if underline and underline.type == "setext_h1_underline" else 2,
                text_of(source, content) if content else text_of(source, node).splitlines()[0])
    marker = next((child for child in node.children if child.type.startswith("atx_h")), None)
    level = len(text_of(source, marker)) if marker else 0
    return level, re.sub(r"^\s*#+\s*", "", text_of(source, node)).strip(" #\t")


def top_level(node, lang):
    parent = node.parent
    if lang == "json":
        return parent is not None and parent.type == "object" and parent.parent is not None and parent.parent.type == "document"
    if lang == "yaml":
        return (parent is not None and parent.type == "block_mapping" and parent.parent is not None
                and parent.parent.type == "block_node" and parent.parent.parent is not None
                and parent.parent.parent.type == "document")
    if lang == "toml":
        return parent is not None and (parent.type == "document" or
                parent.type in {"table", "table_array_element"} and parent.parent is not None
                and parent.parent.type == "document")
    while parent is not None:
        if parent.type in {"program", "module", "source_file", "translation_unit", "document", "script", "stylesheet"}:
            return True
        if parent.type in {"function_definition", "function_declaration", "method_definition", "class_definition", "class_declaration", "statement_block", "compound_statement", "block"}:
            return False
        parent = parent.parent
    return False


def unit_name(node, source, lang):
    field = node.child_by_field_name("name") or node.child_by_field_name("declarator") or node.child_by_field_name("key")
    if field is not None:
        name = text_of(source, field)
    elif node.type == "pair" and node.named_children:
        name = text_of(source, node.named_children[0])
    elif node.type in {"lexical_declaration", "variable_declaration"}:
        declarators = [c for c in node.children if c.type == "variable_declarator"]
        names = [text_of(source, c.child_by_field_name("name")) for c in declarators
                 if c.child_by_field_name("name")]
        name = ",".join(names) or text_of(source, node).split("=", 1)[0][:180]
    elif node.type in {"expression_statement", "declaration", "type_definition", "command", "statement", "rule_set", "at_rule", "element", "table", "table_array_element"}:
        name = text_of(source, node).splitlines()[0][:180]
        name = re.sub(r"\s+", " ", name)
    elif node.type == "impl_item":
        name = text_of(source, node).split("{", 1)[0][:180]
    elif lang == "markdown":
        name = re.sub(r"^\s*#+\s*", "", text_of(source, node)).strip(" #\t")
    else:
        name = ""
    return name or None


def compile_queries():
    compiled = {}
    for lang, source in QUERY.items():
        try:
            compiled[lang] = (get_parser(lang), Query(get_language(lang), source))
        except Exception as exc:
            raise RuntimeError(f"query setup failed for {lang}: {exc}") from exc
    return compiled


def units_for(source, lang, compiled):
    if source is None:
        return None, "missing"
    if b"\0" in source:
        return None, "binary"
    if lang not in compiled:
        return None, "unsupported"
    try:
        parser, query = compiled[lang]
        tree = parser.parse(source)
        if tree.root_node.has_error:
            return None, "parse_error"
        nodes = QueryCursor(query).captures(tree.root_node).get("unit", [])
        if lang == "markdown":
            heads = sorted(nodes, key=lambda n: n.start_byte)
            heading_info = [markdown_heading(node, source) for node in heads]
            candidates = []
            stack = []
            for index, node in enumerate(heads):
                level, name = heading_info[index]
                if not level:
                    continue
                while stack and stack[-1][0] >= level:
                    stack.pop()
                stack.append((level, name))
                stop = next((h.start_point.row - 1 for h, (later_level, _) in
                             zip(heads[index + 1:], heading_info[index + 1:])
                             if later_level <= level), len(source.splitlines()) - 1)
                candidates.append((node.start_point.row, stop, "heading:" + "/".join(name for _, name in stack)))
            return candidates, None
        candidates = []
        for node in nodes:
            if node.type in TOP_LEVEL_ONLY and not top_level(node, lang):
                continue
            if lang == "python" and node.type == "expression_statement" and not any(
                    child.type in {"assignment", "augmented_assignment", "annotated_assignment"}
                    for child in node.named_children):
                continue
            name = unit_name(node, source, lang)
            if name is None:
                continue
            ancestors = []
            parent = node.parent
            while parent is not None:
                if parent.type in {"class_definition", "class_declaration", "class_specifier", "struct_specifier", "impl_item", "mod_item", "namespace_definition", "interface_declaration", "table", "table_array_element"}:
                    parent_name = unit_name(parent, source, lang)
                    if parent_name:
                        ancestors.append(parent.type + ":" + parent_name)
                parent = parent.parent
            end_row = node.end_point.row - (node.end_point.column == 0 and node.end_point.row > node.start_point.row)
            candidates.append((node.start_point.row, max(node.start_point.row, end_row),
                               "/".join([*reversed(ancestors), node.type + ":" + name])))
        return candidates, None
    except Exception:
        return None, "parse_error"


def deepest(units, row):
    matches = [item for item in units if item[0] <= row <= item[1]]
    if not matches:
        return None
    narrowest = min(item[1] - item[0] for item in matches)
    matches = [item for item in matches if item[1] - item[0] == narrowest]
    return matches[0] if len({item[2] for item in matches}) == 1 else (row, row, "<ambiguous>")


def map_span(units, start, count):
    if units is None:
        return None, "parse_error"
    if count == 0:
        # An insertion between different owners cannot safely choose either.
        adjacent = [deepest(units, row) for row in (start - 1, start)]
        if adjacent[0] is None or adjacent[1] is None:
            return None, "no_enclosing_unit"
        if "<ambiguous>" in {adjacent[0][2], adjacent[1][2]}:
            return None, "spans_units"
        if adjacent[0][2] != adjacent[1][2]:
            return None, "spans_units"
        return adjacent[0][2], None
    first, last = max(0, start - 1), max(0, start + count - 2)
    points = {first, last}
    for lo, hi, _ in units:
        if first <= lo <= last:
            points.add(lo)
        if first <= hi <= last:
            points.add(hi)
        if first <= hi + 1 <= last:
            points.add(hi + 1)
    owners = {deepest(units, row)[2] if deepest(units, row) else None for row in points}
    if "<ambiguous>" in owners:
        return None, "spans_units"
    if None in owners:
        return None, "no_enclosing_unit"
    if len(owners) != 1:
        return None, "spans_units"
    return owners.pop(), None


def path_claims(mirror, env, base, head, path, compiled, parse_cache, renamed=False):
    rows = hunks(mirror, env, base, head, path)
    old, new = blob(mirror, env, base, path), blob(mirror, env, head, path)
    lang = language(path, new or old)
    claims, reasons = set(), collections.Counter()
    if not rows:
        return {("file", path)}, collections.Counter({"no_text_hunks": 1}), 0, lang
    if renamed:
        return {("file", path)}, collections.Counter({"rename_or_move": len(rows)}), len(rows), lang
    side_count = 0
    for source, rev in ((old, base), (new, head)):
        key = (rev, path)
        if key not in parse_cache:
            parse_cache[key] = units_for(source, lang, compiled)
    old_units, old_error = parse_cache[(base, path)]
    new_units, new_error = parse_cache[(head, path)]
    for old_start, old_count, new_start, new_count in rows:
        side_count += 2
        unit_keys = []
        fallback = None
        for units, error, start, count, source in ((old_units, old_error, old_start, old_count, old),
                                                   (new_units, new_error, new_start, new_count, new)):
            # Zero-count sides are insertion/deletion anchors, not edited
            # source lines. Claim the side that actually contains the change.
            if count == 0 or source is None:
                continue
            if error:
                fallback = "no_enclosing_unit" if error in {"unsupported", "binary"} else error
                if error == "unsupported":
                    fallback = "unsupported_language"
                if error == "binary":
                    fallback = "binary_file"
                break
            owner, why = map_span(units, start, count)
            if why:
                fallback = why
                break
            unit_keys.append(owner)
        if fallback or not unit_keys:
            reasons[fallback or "no_enclosing_unit"] += 1
            claims.add(("file", path))
        else:
            claims.update(("unit", path, key) for key in unit_keys)
    return claims, reasons, len(rows), lang


def conflict(left, right, common):
    for path in common:
        a = left[path][0]
        b = right[path][0]
        if ("file", path) in a or ("file", path) in b:
            return True
        for x in a:
            for y in b:
                if x[0] == y[0] == "unit" and (x[2] == y[2] or
                        x[2].startswith(y[2] + "/") or y[2].startswith(x[2] + "/")):
                    return True
    return False


def measure():
    compiled = compile_queries()
    output = ["C4 symbol claim replay (2026-10-16)",
              "Source: local read-only clones and gh merged-pull metadata; temporary bare mirrors only.",
              f"Python: {sys.version.split()[0]}; tree-sitter: {importlib.metadata.version('tree-sitter')}; tree-sitter-language-pack: {importlib.metadata.version('tree-sitter-language-pack')}",
              "Exact setup: python3 -m venv \"$TMPDIR/c4-symbol-venv\"; \"$TMPDIR/c4-symbol-venv/bin/python\" -m pip install --disable-pip-version-check tree-sitter==0.25.2 tree-sitter-language-pack==0.13.0",
              "Exact run: PYTHONDONTWRITEBYTECODE=1 \"$TMPDIR/c4-symbol-venv/bin/python\" spikes/v3/round2/c4/symbols.py",
              "Exact metadata command per repository: gh api --paginate 'repos/OWNER/REPO/pulls?state=closed&per_page=100' --jq '[.[] | select(.merged_at != null) | {number,created_at,merged_at,head:{sha:.head.sha}}]'",
              "Exact Git command forms: git clone --bare --shared LOCAL_CLONE TEMP_MIRROR; git --git-dir=TEMP_MIRROR fetch --no-tags REMOTE +refs/pull/N/head:refs/pull/N/head (missing heads only); git --git-dir=TEMP_MIRROR merge-base HEAD_A HEAD_B; git --git-dir=TEMP_MIRROR diff --no-ext-diff --no-renames --name-only -z BASE HEAD; git --git-dir=TEMP_MIRROR diff --no-ext-diff --no-textconv --no-renames --unified=0 BASE HEAD -- PATH; git --git-dir=TEMP_MIRROR show REV:PATH; git --git-dir=TEMP_MIRROR merge-tree --write-tree --merge-base=BASE HEAD_A HEAD_B.",
              "The path and revision placeholders above protect private-repository file lists; commands use actual values at run time.",
              "Historical SP-F5 fallback table (code-side cases, from supplied raw output; reasons overlap):",
              "reason\tcases", *[f"{reason}\t{count}" for reason, count in OLD_FALLBACKS.items()],
              "Historical query imported PackConfig and configure; both are absent in pinned language-pack 0.13.0. The old exception handler classified those import failures as parse/query errors. Historical package version was not recorded, so this is a reproduced likely cause, not proof of its exact environment.",
              "Earlier code also required both file sides and identical body-signature text, and treated a file fallback as a unit that could compare disjoint from a symbol in the same path.",
              "Matched hunk cohort below: changed shared paths on file-blocked sampled pairs; each unique base/head/path diff counted once per repository. A hunk falls back if either available side lacks a single named unit. The reproduced old query gives a file fallback for every matched hunk; old/new hunk rates use this same denominator.",
              "JSON/TOML/YAML top-level key queries are enabled; unsupported extensions fall back to file."]
    clean_rows = []
    overall = collections.Counter()
    overall_reasons = collections.Counter()
    all_language = collections.defaultdict(collections.Counter)
    old_matched = collections.Counter()
    for repo, name in REPOS:
        clone = CLONES / name
        if not clone.is_dir():
            raise RuntimeError(f"required local clone is missing: {name}")
        prs = gh_prs(repo)
        if len(prs) < BASELINE_PRS[name]:
            raise RuntimeError(f"{name}: only {len(prs)} merged PRs; historical sample needs {BASELINE_PRS[name]}")
        prs = sorted(prs, key=lambda p: (p["merged_at"], p["number"]))[:BASELINE_PRS[name]]
        universe, ranked_pairs = ranked(prs, repo)
        if len(universe) != BASELINE_UNIVERSE[name]:
            raise RuntimeError(f"{name}: historical overlap universe changed: {len(universe)} vs {BASELINE_UNIVERSE[name]}")
        target = min(len(universe), 300)
        mirror, env, remote = mirror_for(clone, name)
        selected, seen, failed = [], set(), []
        fetched = 0
        for a, b in ranked_pairs:
            try:
                for pr in (a, b):
                    if pr["head"] not in seen:
                        fetched += ensure_head(mirror, env, remote, pr)
                        seen.add(pr["head"])
                base = git(mirror, ["merge-base", a["head"], b["head"]], env).strip()
                if not base:
                    raise RuntimeError("no merge base")
                selected.append((a, b, base))
            except RuntimeError as exc:
                failed.append((a["number"], b["number"], str(exc).split(":")[0]))
            if len(selected) == target:
                break
        if len(selected) != target:
            raise RuntimeError(f"{name}: only {len(selected)} of {target} pairs evaluated")
        selected.sort(key=lambda item: (max(instant(item[0]["created_at"]), instant(item[1]["created_at"])),
                                        item[0]["number"], item[1]["number"]))
        paths_cache, rename_cache, parse_cache, claim_cache = {}, {}, {}, {}
        metrics, reasons = collections.Counter(), collections.Counter()
        language_rows = collections.defaultdict(collections.Counter)
        language_reasons = collections.defaultdict(collections.Counter)
        processed_diffs = set()
        for index, (a, b, base) in enumerate(selected, 1):
            metrics["evaluated"] += 1
            keys = [(base, a["head"]), (base, b["head"])]
            for key in keys:
                if key not in paths_cache:
                    paths_cache[key] = changed_paths(mirror, env, *key)
                    rename_cache[key] = renamed_paths(mirror, env, *key)
            common = paths_cache[keys[0]] & paths_cache[keys[1]]
            if not common:
                continue
            metrics["file_blocked"] += 1
            left, right = {}, {}
            for path in common:
                for key, data in ((keys[0], left), (keys[1], right)):
                    cache_key = (*key, path)
                    if cache_key not in claim_cache:
                        claim_cache[cache_key] = path_claims(mirror, env, *key, path, compiled, parse_cache,
                                                            path in rename_cache[key])
                    data[path] = claim_cache[cache_key]
                    if cache_key not in processed_diffs:
                        processed_diffs.add(cache_key)
                        _, why, nhunks, lang = data[path]
                        metrics["hunks"] += nhunks
                        metrics["fallback_hunks"] += min(nhunks, sum(why.values()))
                        language_rows[lang]["hunks"] += nhunks
                        language_rows[lang]["fallback_hunks"] += min(nhunks, sum(why.values()))
                        reasons.update(why)
                        language_reasons[lang].update(why)
                        if lang in {"typescript", "tsx", "javascript", "python", "rust", "c", "cpp", "bash", "css", "html", "sql", "go"}:
                            old_matched["code_side_attempts"] += nhunks * 2
                            old_matched["old_parse_query_error"] += nhunks * 2
            for lang in {left[path][3] for path in common}:
                language_rows[lang]["file_blocked_pairs"] += 1
                lang_paths = {path for path in common if left[path][3] == lang}
                if not conflict(left, right, lang_paths):
                    language_rows[lang]["symbol_disjoint_pairs"] += 1
                if any(left[p][1] or right[p][1] for p in lang_paths):
                    language_rows[lang]["pairs_with_fallback"] += 1
            for why in {r for p in common for r in (*left[p][1], *right[p][1])}:
                reasons["pairs:" + why] += 1
            for lang in {left[p][3] for p in common}:
                for why in {r for p in common if left[p][3] == lang
                            for r in (*left[p][1], *right[p][1])}:
                    language_reasons[lang]["pairs:" + why] += 1
            disjoint = not conflict(left, right, common)
            if disjoint:
                metrics["symbol_disjoint"] += 1
            if any(left[p][1] or right[p][1] for p in common):
                metrics["pairs_with_fallback"] += 1
            merge = subprocess.run(["git", f"--git-dir={mirror}", "merge-tree", "--write-tree",
                                    f"--merge-base={base}", a["head"], b["head"]],
                                   env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if merge.returncode not in (0, 1):
                raise RuntimeError(f"merge-tree failed for {name} pair {a['number']}+{b['number']}")
            merge_conflict = merge.returncode == 1
            conflict_paths = set()
            if merge_conflict:
                for line in merge.stdout.decode("utf-8", "replace").splitlines():
                    if line.startswith("CONFLICT ") and " in " in line:
                        conflict_paths.add(line.rsplit(" in ", 1)[-1])
            if merge_conflict:
                metrics["text_conflicts"] += 1
            if disjoint and merge_conflict:
                metrics["disjoint_conflicts"] += 1
                for lang in {left[p][3] for p in common & conflict_paths}:
                    if not conflict(left, right, {p for p in common if left[p][3] == lang}):
                        language_rows[lang]["disjoint_conflicts"] += 1
            if disjoint and not merge_conflict:
                clean_rows.append((repo, a["number"], b["number"]))
            if index % 50 == 0:
                print(f"{name}: {index}/{target}", file=sys.stderr, flush=True)
        output += ["", f"Repository: {repo}",
                   f"merged_prs={len(prs)} overlap_universe={len(universe)} evaluated={metrics['evaluated']} candidates_attempted={len(selected)+len(failed)} missing_heads_fetched={fetched} unevaluable={len(failed)}",
                   "file_blocked\tsymbol_disjoint\tdisjoint_conflicts\tclean_disjoint\tpairs_with_fallback\thunks\told_fallback_rate\tnew_fallback_hunks\tnew_fallback_rate",
                   f"{metrics['file_blocked']}\t{metrics['symbol_disjoint']}\t{metrics['disjoint_conflicts']}\t{metrics['symbol_disjoint']-metrics['disjoint_conflicts']}\t{metrics['pairs_with_fallback']}\t{metrics['hunks']}\t{100.0 if metrics['hunks'] else 0:.3f}%\t{metrics['fallback_hunks']}\t{metrics['fallback_hunks']/max(1,metrics['hunks']):.3%}",
                   "language\tfile_blocked_pairs\tsymbol_disjoint_pairs\tdisjoint_conflicts\tpairs_with_fallback\thunks\told_fallback_rate\tnew_fallback_hunks\tnew_fallback_rate"]
        for lang, row in sorted(language_rows.items()):
            output.append(f"{lang}\t{row['file_blocked_pairs']}\t{row['symbol_disjoint_pairs']}\t{row['disjoint_conflicts']}\t{row['pairs_with_fallback']}\t{row['hunks']}\t{100.0 if row['hunks'] else 0:.3f}%\t{row['fallback_hunks']}\t{row['fallback_hunks']/max(1,row['hunks']):.3%}")
            all_language[lang].update(row)
        output += ["fallback_reason\tevents\tpairs"]
        for reason in sorted(k for k in reasons if not k.startswith("pairs:")):
            output.append(f"{reason}\t{reasons[reason]}\t{reasons['pairs:'+reason]}")
        output += ["language\tfallback_reason\tevents\tpairs"]
        for lang, counts in sorted(language_reasons.items()):
            for reason in sorted(k for k in counts if not k.startswith("pairs:")):
                output.append(f"{lang}\t{reason}\t{counts[reason]}\t{counts['pairs:'+reason]}")
        if failed:
            output += ["Unevaluable ranked candidates (replaced):", *[f"{x[0]}+{x[1]}\t{x[2]}" for x in failed]]
        overall.update(metrics)
        overall_reasons.update(reasons)
        print(f"{name}: file-blocked={metrics['file_blocked']} disjoint={metrics['symbol_disjoint']} conflicts={metrics['disjoint_conflicts']}", file=sys.stderr, flush=True)
    output += ["", "Overall (pair totals across the five repository strata)",
               "evaluated\tfile_blocked\tsymbol_disjoint\tdisjoint_conflicts\tclean_disjoint\tpairs_with_fallback\thunks\told_fallback_rate\tnew_fallback_hunks\tnew_fallback_rate",
               f"{overall['evaluated']}\t{overall['file_blocked']}\t{overall['symbol_disjoint']}\t{overall['disjoint_conflicts']}\t{overall['symbol_disjoint']-overall['disjoint_conflicts']}\t{overall['pairs_with_fallback']}\t{overall['hunks']}\t{100.0 if overall['hunks'] else 0:.3f}%\t{overall['fallback_hunks']}\t{overall['fallback_hunks']/max(1,overall['hunks']):.3%}",
               "Matched code-side old query reproduction: code_side_attempts\told_parse_query_error",
               f"{old_matched['code_side_attempts']}\t{old_matched['old_parse_query_error']}",
               "Old code-side attempts are a separate diagnostic count; old/new hunk fallback rates use the matched shared-path hunk denominator. Old 100% rate is conditional on the reproduced API error plus historical fallback-by-design for non-code.",
               "language\tfile_blocked_pairs\tsymbol_disjoint_pairs\tdisjoint_conflicts\tpairs_with_fallback\thunks\told_fallback_rate\tnew_fallback_hunks\tnew_fallback_rate"]
    for lang, row in sorted(all_language.items()):
        output.append(f"{lang}\t{row['file_blocked_pairs']}\t{row['symbol_disjoint_pairs']}\t{row['disjoint_conflicts']}\t{row['pairs_with_fallback']}\t{row['hunks']}\t{100.0 if row['hunks'] else 0:.3f}%\t{row['fallback_hunks']}\t{row['fallback_hunks']/max(1,row['hunks']):.3%}")
    output += ["overall_fallback_reason\tevents\tpairs"]
    for reason in sorted(k for k in overall_reasons if not k.startswith("pairs:")):
        output.append(f"{reason}\t{overall_reasons[reason]}\t{overall_reasons['pairs:'+reason]}")
    PAIRS.parent.mkdir(parents=True, exist_ok=True)
    PAIRS.write_text("repository\tfirst_pr\tsecond_pr\n" + "".join(
        f"{repo}\t{a}\t{b}\n" for repo, a, b in clean_rows))
    OUTPUT.write_text("\n".join(output) + "\n")
    print(f"wrote {OUTPUT} and {PAIRS}; {overall['evaluated']} pairs", flush=True)


if __name__ == "__main__":
    measure()
