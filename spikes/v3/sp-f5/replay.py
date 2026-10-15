#!/usr/bin/env python3
"""Read-only replay of overlapping merged PRs against lock-unit schemes."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
CLONES = Path("/Users/sebastianpatronsoto/agent-runs/clones")
REPOS = [
    ("seb-patron/concord", "concord"),
    ("seb-patron/agent-workflows", "agent-workflows"),
    ("seb-patron/gen-v-research-tools", "gen-v-research-tools"),
    ("seb-patron/mwcc-rs", "mwcc-rs"),
    ("seb-patron/gen-v-decomp", "gen-v-decomp"),
]
PAIR_CAP = 30
SCHEMES = ["no lock", "file", "git funcname", "tree-sitter node",
           "interface exclusive / body shared", "hunk line range",
           "file + policy-exclusive", "adaptive"]
TS_RULE = r"^[[:space:]]*(export[[:space:]]+)?function[[:space:]]+[[:alnum:]_]+"
LANGUAGES = {
    ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp",
    ".cs": "c_sharp", ".go": "go", ".java": "java", ".js": "javascript", ".jsx": "javascript",
    ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript", ".tsx": "tsx",
    ".py": "python", ".rs": "rust", ".rb": "ruby", ".php": "php", ".sh": "bash",
    ".swift": "swift", ".kt": "kotlin", ".kts": "kotlin", ".scala": "scala", ".lua": "lua",
    ".html": "html", ".css": "css", ".json": "json", ".toml": "toml", ".yaml": "yaml",
    ".yml": "yaml", ".md": "markdown", ".sql": "sql", ".xml": "xml",
}
HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$")
TREE_QUERY = r'''import json,sys
from tree_sitter_language_pack import PackConfig,configure,get_parser
configure(PackConfig(cache_dir=sys.argv[2]))
parser=get_parser(sys.argv[1]); source=sys.stdin.buffer.read(); tree=parser.parse(source)
result=[]
for start,end in json.loads(sys.argv[3]):
 lo=max(0,start-1); hi=max(0,end-1); node=tree.root_node.descendant_for_point_range((lo,0),(lo,0)); found=None
 while node is not None:
  body=node.child_by_field_name("body")
  if node.is_named and body is not None and node.end_point.row>=hi:
   sig=b" ".join(source[node.start_byte:body.start_byte].split()).decode("utf-8","replace")
   found=[node.type,sig,node.start_point.row,body.start_point.row,node.end_byte-node.start_byte]; break
  node=node.parent
 result.append(found)
print(json.dumps(result))
'''
TREE_QUERY_FAILURES = 0


def run(args, *, cwd=None, env=None, check=False, input_text=None):
    p = subprocess.run(args, cwd=cwd, env=env, input=input_text, text=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and p.returncode:
        raise RuntimeError(f"command failed ({p.returncode}): {' '.join(map(str, args))}\n{p.stderr[-2000:]}")
    return p


def iso(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def duration_hours(pr):
    return max(0.0, (iso(pr["merged_at"]) - iso(pr["created_at"])).total_seconds() / 3600)


def overlaps(prs):
    ordered = sorted(prs, key=lambda p: (p["created_at"], p["number"]))
    active, pairs = [], []
    for pr in ordered:
        active = [q for q in active if iso(q["merged_at"]) > iso(pr["created_at"])]
        pairs.extend((q, pr) for q in active)
        active.append(pr)
    return pairs


def gh_prs(repo):
    endpoint = f"repos/{repo}/pulls?state=closed&per_page=100"
    p = run(["gh", "api", "--paginate", endpoint,
             "--jq", "[.[] | select(.merged_at != null) | {number,created_at,merged_at,head:{sha:.head.sha},base:{sha:.base.sha},title,html_url}]"], check=True)
    decoder, pages, cursor = json.JSONDecoder(), [], 0
    while cursor < len(p.stdout):
        while cursor < len(p.stdout) and p.stdout[cursor].isspace():
            cursor += 1
        if cursor == len(p.stdout):
            break
        page, cursor = decoder.raw_decode(p.stdout, cursor)
        pages.append(page)
    prs = []
    for page in pages:
        for item in page:
            if not item.get("merged_at"):
                continue
            prs.append({"number": item["number"], "created_at": item["created_at"],
                        "merged_at": item["merged_at"], "head": item["head"]["sha"],
                        "base": item["base"]["sha"], "title": item["title"],
                        "url": item["html_url"]})
    return prs


def local_commit(clone, sha):
    return run(["git", "-C", str(clone), "cat-file", "-e", f"{sha}^{{commit}}"]).returncode == 0


def ensure_objects(clone, repo, prs, mirror, alternate_env):
    missing = [p for p in prs if not local_commit(clone, p["head"])]
    if not (mirror / "HEAD").exists():
        run(["git", "init", "--bare", str(mirror)], check=True)
    local_objects = run(["git", "-C", str(clone), "rev-parse", "--path-format=absolute", "--git-path", "objects"], check=True).stdout.strip()
    mirror_env = alternate_env.copy()
    mirror_env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = os.pathsep.join(
        value for value in (local_objects, alternate_env.get("GIT_ALTERNATE_OBJECT_DIRECTORIES")) if value)
    remote = run(["git", "-C", str(clone), "remote", "get-url", "origin"], check=True).stdout.strip()
    if missing:
        refspecs = [f"+refs/pull/{pr['number']}/head:refs/pull/{pr['number']}/head" for pr in missing]
        fetched = run(["git", "--git-dir", str(mirror), "fetch", "--no-tags", remote, *refspecs], env=mirror_env)
        if fetched.returncode:
            for pr in missing:
                fetched = run(["git", "--git-dir", str(mirror), "fetch", "--no-tags", remote,
                               f"+refs/pull/{pr['number']}/head:refs/pull/{pr['number']}/head"], env=mirror_env)
                if fetched.returncode:
                    fetched = run(["git", "--git-dir", str(mirror), "fetch", "--no-tags", remote, pr["head"]], env=mirror_env)
                if fetched.returncode:
                    raise RuntimeError(f"could not fetch PR #{pr['number']} head into the temporary mirror: {fetched.stderr[-1000:]}")
    for pr in missing:
        have = run(["git", "--git-dir", str(mirror), "cat-file", "-e", f"{pr['head']}^{{commit}}"], env=mirror_env)
        if have.returncode:
            raise RuntimeError(f"fetched PR #{pr['number']} but its advertised head SHA differs")
    alternate_env["GIT_ALTERNATE_OBJECT_DIRECTORIES"] = str(mirror / "objects")
    return len(missing), mirror_env


def git(clone, args, env=None):
    return run(["git", "-C", str(clone), *map(str, args)], env=env)


def changed_paths(clone, base, head, env):
    p = git(clone, ["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base, head], env)
    if p.returncode:
        raise RuntimeError(p.stderr)
    return [x for x in p.stdout.split("\0") if x]


def blob(clone, rev, path, env):
    p = subprocess.run(["git", "-C", str(clone), "show", f"{rev}:{path}"], env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return None if p.returncode else p.stdout


def hunk_ranges(text):
    out = []
    for line in text.splitlines():
        m = HUNK.match(line)
        if m:
            old_start, old_count, new_start, new_count = m.groups()[:4]
            start = int(old_start)
            count = int(old_count) if old_count is not None else 1
            new_count = int(new_count) if new_count is not None else 1
            out.append((start, start + count, int(new_start), int(new_start) + new_count))
    return out


def is_overlap(a, b):
    a0, a1 = a
    b0, b1 = b
    if a0 == a1 and b0 == b1:
        return a0 == b0
    if a0 == a1:
        return b0 <= a0 <= b1
    if b0 == b1:
        return a0 <= b0 <= a1
    return max(a0, b0) < min(a1, b1)


def query_tree_units(source, language, hunks):
    global TREE_QUERY_FAILURES
    if source is None or language is None:
        TREE_QUERY_FAILURES += 1
        return [None] * len(hunks)
    scratch = Path(os.environ.get("DELEGATE_SCRATCH_DIR", tempfile.gettempdir()))
    cache = scratch / "sp-f5-tree-sitter-cache"
    cache.mkdir(parents=True, exist_ok=True)
    lines = [[start, end] for start, end in hunks]
    p = subprocess.run([sys.executable, "-c", TREE_QUERY, language, str(cache), json.dumps(lines)],
                       input=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       env=os.environ.copy())
    if p.returncode:
        TREE_QUERY_FAILURES += 1
        return [None] * len(hunks)
    try:
        return json.loads(p.stdout)
    except (ValueError, TypeError):
        TREE_QUERY_FAILURES += 1
        return [None] * len(hunks)


def ranges_for_pr(clone, base, head, path, env, ts_attributes):
    plain = git(clone, ["diff", "--no-ext-diff", "--no-renames", "--unified=0", base, head, "--", path], env)
    if plain.returncode:
        return None
    hunks = hunk_ranges(plain.stdout)
    before, after = blob(clone, base, path, env), blob(clone, head, path, env)
    classes = policy_class(path, before, after)
    if before is not None and b"\0" in before or after is not None and b"\0" in after:
        return {"binary": True, "hunks": [], "func": [], "tree": [], "interface": [], "policy": classes}
    if not hunks:
        return {"binary": False, "hunks": [], "func": [], "tree": [], "interface": [], "policy": classes}
    driver_args = []
    if path.endswith((".ts", ".tsx")) and clone.name == "concord":
        driver_args = ["-c", f"core.attributesFile={ts_attributes}",
                       "-c", f"diff.typescript.xfuncname={TS_RULE}"]
    funcs = git(clone, [*driver_args, "diff", f"--attr-source={base}", "--no-ext-diff", "--no-renames",
                        "--function-context", "--unified=0", base, head, "--", path], env)
    headers = [m.group(5).strip() if m.group(5) else "" for ln in funcs.stdout.splitlines() if (m := HUNK.match(ln))]
    ext = Path(path).suffix.lower()
    language = LANGUAGES.get(ext)
    before_tree = query_tree_units(before, language, [(x[0], x[1]) for x in hunks])
    after_tree = query_tree_units(after, language, [(x[2], x[3]) for x in hunks])
    func_units, tree_units, interface_units = [], [], []
    policy_units = list(classes)
    for index, (old_start, old_end, new_start, new_end) in enumerate(hunks):
        header = headers[index] if index < len(headers) else ""
        func_units.append(("symbol", path, header) if header else ("file", path))
        old_decl, new_decl = before_tree[index], after_tree[index]
        if old_decl is None or new_decl is None or old_decl[:2] != new_decl[:2]:
            tree_units.append(("file", path)); interface_units.append(("file", path))
        else:
            identity = (path, old_decl[0], old_decl[1])
            tree_units.append(("node", *identity))
            # Body rows are shared; edits touching the signature are exclusive.
            interface_start = old_decl[2] + 1
            interface_end = old_decl[3] + 1
            if old_start <= interface_end and old_end >= interface_start:
                interface_units.append(("interface", *identity))
            else:
                interface_units.append(("body", *identity))
    return {"binary": False, "hunks": [(x[0], x[1]) for x in hunks],
            "func": func_units, "tree": tree_units, "interface": interface_units,
            "policy": list(set(policy_units))}


def policy_class(path, before, after):
    lower = path.lower()
    classes = []
    name = lower.rsplit("/", 1)[-1]
    if (name in {"package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock",
                 "poetry.lock", "pipfile.lock", "gemfile.lock", "composer.lock", "go.sum", "bun.lockb", "bun.lock"}
            or name.endswith(".lock")):
        classes.append(("policy", "lockfile"))
    if any(part in {"migration", "migrations", "db/migrate", "schema_migrations"} for part in lower.split("/")) or "migration" in name:
        classes.append(("policy", "migration"))
    if any(part in {"generated", "gen", "vendor", "dist"} for part in lower.split("/")) or name.endswith((".generated.cs", ".g.cs", ".pb.go", "_generated.py")):
        classes.append(("policy", "generated"))
    if before is not None and b"\0" in before or after is not None and b"\0" in after:
        classes.append(("policy", "binary"))
    return classes


def diff_data(clone, base, head, env, ts_attributes):
    paths = changed_paths(clone, base, head, env)
    data = {"files": set(), "func": set(), "tree": set(), "interface": set(),
            "policy": set(), "hunks": defaultdict(list)}
    for path in paths:
        data["files"].add(path)
        details = ranges_for_pr(clone, base, head, path, env, ts_attributes)
        if details is None:
            continue
        data["func"].update(details["func"])
        data["tree"].update(details["tree"])
        data["interface"].update(details["interface"])
        data["policy"].update(details["policy"])
        data["hunks"][path].extend(details["hunks"])
        if details["binary"]:
            data["policy"].add(("policy", "binary"))
    return data


def overlaps_units(scheme, left, right):
    if scheme == "no lock":
        return False
    if scheme == "file":
        return bool(left["files"] & right["files"])
    if scheme == "git funcname":
        return bool(left["func"] & right["func"])
    if scheme == "tree-sitter node":
        return bool(left["tree"] & right["tree"])
    if scheme == "interface exclusive / body shared":
        if any(unit[0] == "file" for unit in left["interface"]) and left["files"] & right["files"]:
            return True
        if any(unit[0] == "file" for unit in right["interface"]) and left["files"] & right["files"]:
            return True
        by_node = defaultdict(set)
        for kind, *node in left["interface"]:
            by_node[tuple(node)].add(kind)
        for kind, *node in right["interface"]:
            other = by_node.get(tuple(node), set())
            if other and (kind == "interface" or "interface" in other):
                return True
        return False
    if scheme == "hunk line range":
        for path in left["hunks"].keys() & right["hunks"].keys():
            if any(is_overlap(a, b) for a in left["hunks"][path] for b in right["hunks"][path]):
                return True
        return False
    if scheme == "file + policy-exclusive":
        return bool(left["files"] & right["files"] or left["policy"] & right["policy"])
    if scheme == "adaptive":
        return False
    return False


def merge_result(clone, mirror, a, b, env, mirror_env):
    base = git(clone, ["merge-base", a["head"], b["head"]], env)
    if base.returncode:
        return {"conflict": True, "base": "", "raw": base.stderr, "command": "git merge-base"}
    base_sha = base.stdout.strip()
    args = ["git", "--git-dir", str(mirror), "merge-tree", "--write-tree", f"--merge-base={base_sha}", a["head"], b["head"]]
    p = run(args, env=mirror_env)
    if p.returncode > 1:
        raise RuntimeError(f"merge-tree failed ({p.returncode}): {p.stderr[-2000:]}")
    first = p.stdout.splitlines()[0].strip() if p.stdout else ""
    conflict_paths = []
    for line in p.stdout.splitlines():
        if line.startswith("CONFLICT "):
            conflict_paths.append(line)
    return {"conflict": p.returncode != 0, "base": base_sha, "tree": first,
            "raw": p.stdout + p.stderr, "conflict_paths": conflict_paths,
            "command": " ".join(args)}


def mergiraf_result(clone, base, a, b, paths, binary_env, tempdir):
    executable = shutil.which("mergiraf") or str(Path(os.environ.get("DELEGATE_SCRATCH_DIR", tempfile.gettempdir())) / "mergiraf-root/bin/mergiraf")
    if not Path(executable).exists():
        return None
    tested = resolved = 0
    for path in paths:
        old, left, right = (blob(clone, rev, path, binary_env) for rev in (base, a["head"], b["head"]))
        if old is None or left is None or right is None or any(b"\0" in x for x in (old, left, right)):
            continue
        d = Path(tempdir) / hashlib.sha256(f"{path}{a['head']}{b['head']}".encode()).hexdigest()
        d.mkdir(parents=True, exist_ok=True)
        files = [d / name for name in ("base", "left", "right", "merged")]
        for f, content in zip(files[:3], (old, left, right)):
            f.write_bytes(content)
        # Mergiraf's output contains conflict markers when its structural merge fails.
        p = run([executable, "merge", "--path-name", path, "--output", str(files[3]),
                 str(files[0]), str(files[1]), str(files[2])])
        tested += 1
        merged = files[3].read_bytes() if files[3].exists() else p.stdout.encode()
        if p.returncode == 0 and b"<<<<<<<" not in merged and b"=======" not in merged:
            resolved += 1
    return {"tested_files": tested, "resolved_files": resolved}


def stable_sample(pairs, repo):
    if len(pairs) <= PAIR_CAP:
        return pairs
    return sorted(pairs, key=lambda pair: hashlib.sha256(
        f"{repo}:{pair[0]['number']}:{pair[1]['number']}".encode()).hexdigest())[:PAIR_CAP]


def fmt_pr(pr):
    return f"{pr['number']} {pr['url']}"


def main():
    output = ROOT / "spikes/v3/sp-f5/output.txt"
    scratch = Path(os.environ.get("DELEGATE_SCRATCH_DIR", tempfile.gettempdir()))
    os.environ.setdefault("PYTHONDONTWRITEBYTECODE", "1")
    os.environ["TMPDIR"] = str(scratch)
    try:
        import tree_sitter_language_pack  # noqa: F401
    except ImportError:
        venv = scratch / "sp-f5-tree-sitter-venv"
        if not (venv / "bin/python").exists():
            run([sys.executable, "-m", "venv", str(venv)], check=True)
            run([str(venv / "bin/pip"), "install", "tree-sitter-language-pack"], check=True)
        os.execve(str(venv / "bin/python"), [str(venv / "bin/python"), str(Path(__file__).resolve()), *sys.argv[1:]], os.environ)
    raw_dir = Path(tempfile.mkdtemp(prefix="sp-f5-raw-", dir=scratch))
    ts_attributes = scratch / "sp-f5-concord.gitattributes"
    ts_attributes.write_text("*.ts diff=typescript\n*.tsx diff=typescript\n")
    pair_cache = {}
    totals = {name: {"blocked": 0, "needless": 0, "missed": 0, "delay": 0.0} for name in SCHEMES}
    examples = {name: {"needless": [], "missed": []} for name in SCHEMES}
    repo_stats, pair_records = [], []
    total_pairs = total_sampled = merge_conflicts = merge_resolved = merge_tested_files = missing_heads = 0
    mergiraf_available = bool(shutil.which("mergiraf") or
        (scratch / "mergiraf-root/bin/mergiraf").exists())
    adaptive_active = defaultdict(set)
    raw_conflict_examples = []
    for repo, dirname in REPOS:
        clone = CLONES / dirname
        if not clone.is_dir():
            raise RuntimeError(f"required local clone is missing: {clone}")
        prs = gh_prs(repo)
        all_pairs = overlaps(prs)
        sample = stable_sample(all_pairs, repo)
        sample.sort(key=lambda pair: (max(iso(pair[0]["created_at"]), iso(pair[1]["created_at"])),
                                      pair[0]["number"], pair[1]["number"]))
        total_pairs += len(all_pairs)
        total_sampled += len(sample)
        mirror = raw_dir / (dirname + ".git")
        env = os.environ.copy()
        sampled_prs = {p["number"]: p for pair in sample for p in pair}
        fetched, mirror_env = ensure_objects(clone, repo, list(sampled_prs.values()), mirror, env)
        missing_heads += fetched
        print(f"{repo}: {len(sample)} pairs selected; evaluating", file=sys.stderr, flush=True)
        evaluated = 0
        for a, b in sample:
            result = merge_result(clone, mirror, a, b, env, mirror_env)
            if not result["base"]:
                continue
            merge_conflicts += int(result["conflict"])
            key = (result["base"], a["head"], b["head"])
            left = pair_cache.get((dirname, result["base"], a["head"]))
            if left is None:
                left = diff_data(clone, result["base"], a["head"], env, ts_attributes)
                pair_cache[(dirname, result["base"], a["head"])] = left
            right = pair_cache.get((dirname, result["base"], b["head"]))
            if right is None:
                right = diff_data(clone, result["base"], b["head"], env, ts_attributes)
                pair_cache[(dirname, result["base"], b["head"])] = right
            pair_id = f"{repo}#{a['number']}+#{b['number']}"
            delay_pr = a if iso(a["created_at"]) <= iso(b["created_at"]) else b
            later = b if delay_pr is a else a
            delay = max(0.0, (iso(delay_pr["merged_at"]) - iso(later["created_at"])).total_seconds() / 3600)
            blocked = {}
            for scheme in SCHEMES:
                if scheme == "adaptive":
                    active = adaptive_active[dirname]
                    is_blocked = bool((left["files"] & right["files"]) & active)
                else:
                    is_blocked = overlaps_units(scheme, left, right)
                blocked[scheme] = is_blocked
                totals[scheme]["blocked"] += int(is_blocked)
                totals[scheme]["delay"] += delay if is_blocked else 0
                needless = is_blocked and not result["conflict"]
                missed = not is_blocked and result["conflict"]
                totals[scheme]["needless"] += int(needless)
                totals[scheme]["missed"] += int(missed)
                category = "needless" if needless else "missed" if missed else None
                if category and len(examples[scheme][category]) < 5:
                    examples[scheme][category].append({"id": pair_id, "left": a, "right": b,
                        "paths": sorted(left["files"] & right["files"]),
                        "conflicts": result["conflict_paths"], "delay": delay})
            if result["conflict"]:
                for pathline in result["conflict_paths"]:
                    if pathline.startswith("CONFLICT ") and " in " in pathline:
                        adaptive_active[dirname].add(pathline.rsplit(" in ", 1)[-1])
                for pathline in result["conflict_paths"]:
                    if pathline.startswith("CONFLICT (content):"):
                        conflict_path = pathline.rsplit(" in ", 1)[-1]
                        mr = mergiraf_result(clone, result["base"], a, b, [conflict_path], env, raw_dir / "mergiraf")
                        if mr:
                            mergiraf_available = True
                            merge_tested_files += mr["tested_files"]
                            merge_resolved += int(mr["resolved_files"] > 0)
            record = {"pair": pair_id, "heads": [a["head"], b["head"]], "base": result["base"],
                      "merge_tree_exit_conflict": result["conflict"], "merge_tree_tree": result["tree"],
                      "merge_tree_conflict_paths": result["conflict_paths"],
                      "blocked": blocked, "raw_sha256": hashlib.sha256(result["raw"].encode()).hexdigest(),
                      "merge_tree_command": result["command"]}
            raw_path = raw_dir / "merge-tree"
            raw_path.mkdir(exist_ok=True)
            (raw_path / (hashlib.sha256(pair_id.encode()).hexdigest() + ".txt")).write_text(result["raw"])
            pair_records.append(record)
            if result["conflict"] and len(raw_conflict_examples) < 5:
                raw_conflict_examples.append((result["command"], result["raw"]))
            evaluated += 1
            if evaluated % 25 == 0:
                print(f"{repo}: evaluated {evaluated}/{len(sample)}", file=sys.stderr, flush=True)
        repo_stats.append((repo, len(prs), len(all_pairs), len(sample), evaluated, fetched))
    if len(pair_records) < 30:
        print(f"Only {len(pair_records)} overlapping PR pairs could be evaluated; required minimum is 30.", file=sys.stderr)
        raise SystemExit(2)
    (raw_dir / "pair-results.json").write_text(json.dumps(pair_records, indent=2) + "\n")
    lines = [
        "SP-F5 lock-scheme replay",
        "Read-only inputs: GitHub merged-PR metadata via gh; local clone objects; missing PR head objects fetched only to a temporary bare mirror.",
        f"Sample: deterministic SHA-256 rank of (repository, PR numbers), capped at {PAIR_CAP} overlapping pairs per repository; repository is the stratum.",
        f"Pair universe: {total_pairs}; sampled: {total_sampled}; evaluated: {len(pair_records)}; merge-tree conflicts: {merge_conflicts}.",
        f"Missing PR heads fetched to temporary bare mirrors: {missing_heads}.",
        f"Tree-sitter parser fallback cases (file widening): {TREE_QUERY_FAILURES}.",
        "Exact metadata command: gh api --paginate repos/OWNER/REPO/pulls?state=closed&per_page=100 --jq '[.[] | select(.merged_at != null) | {number,created_at,merged_at,head:{sha:.head.sha},base:{sha:.base.sha},title,html_url}]'",
        "Exact merge command: git --git-dir=TEMP_BARE_MIRROR merge-tree --write-tree --merge-base=BASE HEAD_A HEAD_B",
        "The required --write-tree operation writes result objects only to the temporary mirror, which reads clone objects through an alternate; clone refs and objects remain unchanged.",
        "Full per-pair merge-tree transcripts stay in task scratch; this output includes result hashes and up to five representative raw stdout snippets.",
        "",
        "repo | merged PRs | all overlapping pairs | sampled | evaluated | missing heads fetched",
    ]
    lines.extend(" | ".join(map(str, row)) for row in repo_stats)
    lines += ["", "scheme | blocked pairs | needless blocks | missed conflicts | pairwise serial delay (hours)"]
    lines.extend(f"{s} | {totals[s]['blocked']} | {totals[s]['needless']} | {totals[s]['missed']} | {totals[s]['delay']:.2f}" for s in SCHEMES)
    lines += ["", f"Mergiraf installed: {'yes' if mergiraf_available else 'no'}; conflicted content files tested: {merge_tested_files}; reported resolved: {merge_resolved}.",
              "Pair examples: PR URLs and paths are real sampled pull requests; conflict paths come from merge-tree."]
    for scheme in SCHEMES:
        for category in ("needless", "missed"):
            items = examples[scheme][category]
            lines.append(f"{scheme} / {category}: {len(items)} example(s)")
            for ex in items:
                paths = ", ".join(ex["paths"][:4]) or "(no shared changed path)"
                lines.append(f"  {ex['id']} | {fmt_pr(ex['left'])} | {fmt_pr(ex['right'])} | paths: {paths} | pair delay: {ex['delay']:.2f}h")
    lines += ["", "Representative raw merge-tree output (up to five sampled conflicts):"]
    for command, raw in raw_conflict_examples:
        lines.append(f"$ {command}")
        lines.extend("  " + line for line in raw.rstrip().splitlines())
    lines += ["", f"Raw record file (scratch only): {raw_dir / 'pair-results.json'}",
              f"Raw merge-tree transcripts (scratch only): {raw_dir}"]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines) + "\n")
    print(f"Wrote {output.relative_to(ROOT)}; {len(pair_records)} pairs evaluated; {merge_conflicts} textual conflicts.")


if __name__ == "__main__":
    main()
