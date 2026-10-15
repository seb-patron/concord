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
PAIR_CAP = 300
SCHEMES = ["no lock", "file", "git funcname", "tree-sitter node",
           "interface exclusive / body shared", "hunk line range",
           "file + policy-exclusive", "adaptive",
           "union merge for append-only index files", "mergiraf at land"]
TS_RULE = r"^[[:space:]]*(export[[:space:]]+)?function[[:space:]]+[[:alnum:]_]+"
LANGUAGES = {
    ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".hpp": "cpp",
    ".cs": "c_sharp", ".go": "go", ".java": "java", ".js": "javascript", ".jsx": "javascript",
    ".mjs": "javascript", ".cjs": "javascript", ".ts": "typescript", ".tsx": "tsx",
    ".py": "python", ".rs": "rust", ".rb": "ruby", ".php": "php", ".sh": "bash",
    ".swift": "swift", ".kt": "kotlin", ".kts": "kotlin", ".scala": "scala", ".lua": "lua",
    ".html": "html", ".css": "css", ".sql": "sql", ".xml": "xml",
}
HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$")
TREE_FALLBACKS = Counter()
TREE_LANGUAGES_USED = set()
TREE_QUERY = r'''import json,sys
from tree_sitter_language_pack import PackConfig,configure,get_parser
configure(PackConfig(cache_dir=sys.argv[2])); parser=get_parser(sys.argv[1])
request=json.load(sys.stdin)
def query(source,hunks):
 if source is None: return [None]*len(hunks)
 source=bytes.fromhex(source); tree=parser.parse(source)
 if tree.root_node.has_error: raise ValueError("syntax tree contains errors")
 results=[]
 for start,end in hunks:
  lo=max(0,start-1); hi=max(0,end-1); node=tree.root_node.descendant_for_point_range((lo,0),(lo,0)); found=None
  while node is not None:
   body=node.child_by_field_name("body")
   if node.is_named and body is not None and node.end_point.row>=hi:
    sig=b" ".join(source[node.start_byte:body.start_byte].split()).decode("utf-8","replace")
    found=[node.type,sig,node.start_point.row,body.start_point.row,node.end_byte-node.start_byte]; break
   node=node.parent
  results.append(found)
 return results
print(json.dumps([query(request["before"],request["before_hunks"]),
                  query(request["after"],request["after_hunks"])]))
'''


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


def query_tree_pair(before, after, language, before_hunks, after_hunks, ext):
    if language is not None:
        TREE_LANGUAGES_USED.add(language)
    if language is None:
        TREE_FALLBACKS[(ext, "grammar unavailable")] += len(before_hunks) + len(after_hunks)
        return [None] * len(before_hunks), [None] * len(after_hunks)
    if before is None:
        TREE_FALLBACKS[(ext, "missing file side")] += len(before_hunks)
    if after is None:
        TREE_FALLBACKS[(ext, "missing file side")] += len(after_hunks)
    scratch = Path(os.environ.get("DELEGATE_SCRATCH_DIR", tempfile.gettempdir()))
    cache = scratch / "sp-f5-tree-sitter-cache"
    cache.mkdir(parents=True, exist_ok=True)
    try:
        request = {"before": before.hex() if before is not None else None,
                   "after": after.hex() if after is not None else None,
                   "before_hunks": before_hunks, "after_hunks": after_hunks}
        p = subprocess.run([sys.executable, "-c", TREE_QUERY, language, str(cache)],
                           input=json.dumps(request), text=True, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, env=os.environ.copy())
        if p.returncode:
            reason = "grammar unavailable" if "not found" in p.stderr.lower() else "parse/query error"
            TREE_FALLBACKS[(ext, reason)] += len(before_hunks) + len(after_hunks)
            return [None] * len(before_hunks), [None] * len(after_hunks)
        return json.loads(p.stdout)
    except Exception as exc:
        reason = "grammar unavailable" if "not found" in str(exc).lower() else "parse/query error"
        TREE_FALLBACKS[(ext, reason)] += len(before_hunks) + len(after_hunks)
        return [None] * len(before_hunks), [None] * len(after_hunks)


def ranges_for_pr(clone, base, head, path, env, ts_attributes):
    plain = git(clone, ["diff", "--no-ext-diff", "--no-renames", "--unified=0", base, head, "--", path], env)
    if plain.returncode:
        return None
    hunks = hunk_ranges(plain.stdout)
    before, after = blob(clone, base, path, env), blob(clone, head, path, env)
    classes = policy_class(path, before, after)
    if before is not None and b"\0" in before or after is not None and b"\0" in after:
        return {"binary": True, "class": classify_file(path, before, after), "hunks": [], "func": [], "tree": [], "interface": [], "policy": classes}
    if not hunks:
        return {"binary": False, "class": classify_file(path, before, after), "hunks": [], "func": [], "tree": [], "interface": [], "policy": classes}
    file_class = classify_file(path, before, after)
    driver_args = []
    if path.endswith((".ts", ".tsx")) and clone.name == "concord":
        driver_args = ["-c", f"core.attributesFile={ts_attributes}",
                       "-c", f"diff.typescript.xfuncname={TS_RULE}"]
    if file_class == "code":
        funcs = git(clone, [*driver_args, "diff", f"--attr-source={base}", "--no-ext-diff", "--no-renames",
                            "--function-context", "--unified=0", base, head, "--", path], env)
        headers = [m.group(5).strip() if m.group(5) else "" for ln in funcs.stdout.splitlines() if (m := HUNK.match(ln))]
    else:
        headers = []
    ext = Path(path).suffix.lower()
    language = LANGUAGES.get(ext)
    if file_class == "code":
        ext = Path(path).suffix.lower() or "<none>"
        before_tree, after_tree = query_tree_pair(before, after, language,
            [(x[0], x[1]) for x in hunks], [(x[2], x[3]) for x in hunks], ext)
    else:
        before_tree = [None] * len(hunks)
        after_tree = [None] * len(hunks)
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
    return {"binary": False, "class": file_class, "hunks": [(x[0], x[1]) for x in hunks],
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


def classify_file(path, before=None, after=None):
    name = path.lower().rsplit("/", 1)[-1]
    if (before is not None and b"\0" in before) or (after is not None and b"\0" in after):
        return "lockfiles/generated/binary"
    if (name in {"package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock",
                 "poetry.lock", "pipfile.lock", "gemfile.lock", "composer.lock", "go.sum", "bun.lockb", "bun.lock"}
            or name.endswith(".lock") or name.endswith((".generated.cs", ".g.cs", ".pb.go", "_generated.py"))
            or any(part in {"generated", "gen", "vendor", "dist"} for part in path.lower().split("/"))):
        return "lockfiles/generated/binary"
    if (name.endswith(("_index.md", "_trail.md", "index.md", "trail.md", "changelog", "changes.md"))
            or name.startswith("changelog")):
        return "append-only index/log"
    if Path(path).suffix.lower() in {".md", ".markdown", ".mdx"}:
        return "docs/markdown"
    if Path(path).suffix.lower() in LANGUAGES:
        return "code"
    if Path(path).suffix.lower() in {".json", ".yaml", ".yml", ".toml", ".txt", ".text"}:
        return "non-code data"
    return "other"


def diff_data(clone, base, head, env, ts_attributes):
    paths = changed_paths(clone, base, head, env)
    data = {"files": set(), "func": set(), "tree": set(), "interface": set(),
            "policy": set(), "hunks": defaultdict(list), "classes": defaultdict(set)}
    for path in paths:
        data["files"].add(path)
        details = ranges_for_pr(clone, base, head, path, env, ts_attributes)
        data["classes"][(details or {}).get("class", classify_file(path))].add(path)
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
    base = git(clone, ["merge-base", a["head"], b["head"]], mirror_env)
    if base.returncode:
        reason = base.stderr.strip() or f"git merge-base exited {base.returncode}"
        return {"conflict": True, "base": "", "raw": base.stderr,
                "command": "git merge-base", "reason": reason}
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


def pair_rank(pair, repo):
    return hashlib.sha256(
        f"{repo}:{pair[0]['number']}:{pair[1]['number']}".encode()).hexdigest()


def fmt_pr(pr):
    return f"{pr['number']} {pr['url']}"


FILE_CLASSES = ["code", "docs/markdown", "append-only index/log",
                "lockfiles/generated/binary", "non-code data", "other"]


def wilson(successes, trials):
    if not trials:
        return "n/a"
    z = 1.959963984540054
    p = successes / trials
    denominator = 1 + z * z / trials
    center = (p + z * z / (2 * trials)) / denominator
    margin = z * ((p * (1 - p) / trials + z * z / (4 * trials * trials)) ** 0.5) / denominator
    return f"{100 * p:.2f}% [{100 * max(0, center - margin):.2f}%, {100 * min(1, center + margin):.2f}%]"


def empty_metrics():
    return {scheme: Counter() for scheme in SCHEMES}


def append_union(clone, base, left, right, path, env, tempdir):
    old, ours, theirs = (blob(clone, rev, path, env) for rev in (base, left, right))
    if old is None or ours is None or theirs is None or any(b"\0" in x for x in (old, ours, theirs)):
        return False
    folder = Path(tempdir) / hashlib.sha256(f"union:{path}{left}{right}".encode()).hexdigest()
    folder.mkdir(parents=True, exist_ok=True)
    paths = [folder / name for name in ("base", "ours", "theirs")]
    for destination, content in zip(paths, (old, ours, theirs)):
        destination.write_bytes(content)
    p = run(["git", "merge-file", "--union", str(paths[1]), str(paths[0]), str(paths[2])])
    return p.returncode == 0


def conflict_file(pathline):
    if " in " in pathline:
        return pathline.rsplit(" in ", 1)[-1]
    return None


def filtered_data(data, file_class):
    selected = data["classes"].get(file_class, set())
    out = {key: set() for key in ("files", "func", "tree", "interface", "policy")}
    out["files"] = selected.copy()
    for key in ("func", "tree", "interface"):
        out[key] = {unit for unit in data[key] if len(unit) > 1 and unit[1] in selected}
    out["policy"] = {unit for unit in data["policy"] if unit[0] == "policy" and unit[1] == file_class}
    out["hunks"] = defaultdict(list, {path: spans for path, spans in data["hunks"].items() if path in selected})
    out["classes"] = defaultdict(set, {file_class: selected})
    return out


def file_class_from_data(path, *data):
    for item in data:
        for file_class, paths in item["classes"].items():
            if path in paths:
                return file_class
    return classify_file(path)


def render_metrics(lines, title, metrics):
    lines += ["", title, "scheme | sampled pairs | blocked | needless | missed conflicts | pairwise serial delay (hours) | residual conflict rate (95% Wilson)"]
    for scheme in SCHEMES:
        row = metrics[scheme]
        allowed = row["pairs"] - row["blocked"]
        rate = wilson(row["missed"], allowed)
        lines.append(f"{scheme} | {row['pairs']} | {row['blocked']} | {row['needless']} | {row['missed']} | {row['delay']:.2f} | {rate}")


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
    overall_metrics = empty_metrics()
    repo_metrics = defaultdict(empty_metrics)
    class_metrics = defaultdict(empty_metrics)
    examples = {name: {"needless": [], "missed": []} for name in SCHEMES}
    repo_stats, pair_records, all_unevaluable = [], [], []
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
        target = min(len(all_pairs), PAIR_CAP)
        ranked_pairs = sorted(all_pairs, key=lambda pair: pair_rank(pair, repo))
        total_pairs += len(all_pairs)
        mirror = raw_dir / (dirname + ".git")
        env = os.environ.copy()
        mirror_env = env
        seen_heads, sample, unevaluable = set(), [], []
        attempted = repo_fetched = 0
        print(f"{repo}: target {target} evaluated pairs; ranking candidates", file=sys.stderr, flush=True)
        for a, b in ranked_pairs:
            attempted += 1
            new_prs = [pr for pr in (a, b) if pr["head"] not in seen_heads]
            seen_heads.update(pr["head"] for pr in new_prs)
            if new_prs:
                try:
                    fetched, mirror_env = ensure_objects(clone, repo, new_prs, mirror, env)
                except RuntimeError as exc:
                    reason = str(exc)
                    if reason.startswith(("could not fetch PR #", "fetched PR #")):
                        unevaluable.append((repo, a["number"], b["number"], reason))
                        continue
                    raise
                repo_fetched += fetched
                missing_heads += fetched
            result = merge_result(clone, mirror, a, b, mirror_env, mirror_env)
            if not result["base"]:
                unevaluable.append((repo, a["number"], b["number"], result["reason"]))
                continue
            sample.append((a, b, result))
            if len(sample) == target:
                break
        if len(sample) != target:
            raise RuntimeError(f"{repo}: evaluated only {len(sample)} of {target} required pairs after {attempted} candidate attempts")
        sample.sort(key=lambda item: (max(iso(item[0]["created_at"]), iso(item[1]["created_at"])),
                                     item[0]["number"], item[1]["number"]))
        total_sampled += attempted
        print(f"{repo}: {len(sample)} evaluable pairs selected from {attempted} ranked candidates", file=sys.stderr, flush=True)
        evaluated = 0
        for a, b, result in sample:
            merge_conflicts += int(result["conflict"])
            key = (result["base"], a["head"], b["head"])
            left = pair_cache.get((dirname, result["base"], a["head"]))
            if left is None:
                left = diff_data(clone, result["base"], a["head"], mirror_env, ts_attributes)
                pair_cache[(dirname, result["base"], a["head"])] = left
            right = pair_cache.get((dirname, result["base"], b["head"]))
            if right is None:
                right = diff_data(clone, result["base"], b["head"], mirror_env, ts_attributes)
                pair_cache[(dirname, result["base"], b["head"])] = right
            pair_id = f"{repo}#{a['number']}+#{b['number']}"
            delay_pr = a if iso(a["created_at"]) <= iso(b["created_at"]) else b
            later = b if delay_pr is a else a
            delay = max(0.0, (iso(delay_pr["merged_at"]) - iso(later["created_at"])).total_seconds() / 3600)
            # Merge-at-land schemes change the observed conflict set, not lock decisions.
            union_resolved, mergiraf_resolved_paths = set(), set()
            conflict_paths = [path for line in result["conflict_paths"] if (path := conflict_file(line))]
            conflict_lines = {conflict_file(line): line for line in result["conflict_paths"] if conflict_file(line)}
            for path in conflict_paths:
                cls = file_class_from_data(path, left, right)
                if (conflict_lines[path].startswith("CONFLICT (content):")
                        and cls == "append-only index/log"
                        and append_union(clone, result["base"], a["head"], b["head"], path, mirror_env, raw_dir / "union")):
                    union_resolved.add(path)
                if conflict_lines[path].startswith("CONFLICT (content):"):
                    mr = mergiraf_result(clone, result["base"], a, b, [path], mirror_env, raw_dir / "mergiraf")
                    if mr:
                        mergiraf_available = True
                        merge_tested_files += mr["tested_files"]
                        merge_resolved += mr["resolved_files"]
                        if mr["resolved_files"]:
                            mergiraf_resolved_paths.add(path)
            union_conflicts = [line for line in result["conflict_paths"]
                               if conflict_file(line) not in union_resolved]
            mergiraf_conflicts = [line for line in result["conflict_paths"]
                                  if conflict_file(line) not in mergiraf_resolved_paths]
            blocked = {}
            for scheme in SCHEMES:
                if scheme == "adaptive":
                    active = adaptive_active[dirname]
                    is_blocked = bool((left["files"] & right["files"]) & active)
                else:
                    is_blocked = overlaps_units(scheme, left, right)
                effective_conflict = (bool(union_conflicts) if scheme == "union merge for append-only index files"
                                      else bool(mergiraf_conflicts) if scheme == "mergiraf at land"
                                      else result["conflict"])
                if scheme in {"union merge for append-only index files", "mergiraf at land"}:
                    is_blocked = False
                blocked[scheme] = is_blocked
                needless = is_blocked and not effective_conflict
                missed = not is_blocked and effective_conflict
                for metrics in (overall_metrics, repo_metrics[repo]):
                    metrics[scheme]["pairs"] += 1
                    metrics[scheme]["blocked"] += int(is_blocked)
                    metrics[scheme]["needless"] += int(needless)
                    metrics[scheme]["missed"] += int(missed)
                    metrics[scheme]["delay"] += delay if is_blocked else 0
                category = "needless" if needless else "missed" if missed else None
                if category and len(examples[scheme][category]) < 5:
                    examples[scheme][category].append({"id": pair_id, "left": a, "right": b,
                        "paths": sorted(left["files"] & right["files"]),
                        "conflicts": result["conflict_paths"], "delay": delay})
            classes_in_pair = set(left["classes"]) | set(right["classes"])
            conflict_classes = {file_class_from_data(path, left, right)
                                for path in (conflict_file(line) for line in result["conflict_paths"]) if path}
            for cls in classes_in_pair | conflict_classes:
                lclass, rclass = filtered_data(left, cls), filtered_data(right, cls)
                relevant = bool(lclass["files"] & rclass["files"]) or cls in conflict_classes
                if not relevant:
                    continue
                class_metrics[cls]
                for scheme in SCHEMES:
                    class_blocked = overlaps_units(scheme, lclass, rclass) if scheme not in {"adaptive", "union merge for append-only index files", "mergiraf at land"} else False
                    if scheme == "adaptive":
                        class_blocked = bool((lclass["files"] & rclass["files"]) & adaptive_active[dirname])
                    cls_conflict = any(classify_file(conflict_file(line) or "") == cls for line in
                                       (union_conflicts if scheme == "union merge for append-only index files" else
                                        mergiraf_conflicts if scheme == "mergiraf at land" else result["conflict_paths"]))
                    class_metrics[cls][scheme]["pairs"] += 1
                    class_metrics[cls][scheme]["blocked"] += int(class_blocked)
                    class_metrics[cls][scheme]["needless"] += int(class_blocked and not cls_conflict)
                    class_metrics[cls][scheme]["missed"] += int(not class_blocked and cls_conflict)
                    class_metrics[cls][scheme]["delay"] += delay if class_blocked else 0
            if result["conflict"]:
                for pathline in result["conflict_paths"]:
                    if pathline.startswith("CONFLICT ") and " in " in pathline:
                        adaptive_active[dirname].add(pathline.rsplit(" in ", 1)[-1])
            record = {"pair": pair_id, "heads": [a["head"], b["head"]], "base": result["base"],
                      "merge_tree_exit_conflict": result["conflict"], "merge_tree_tree": result["tree"],
                      "merge_tree_conflict_paths": result["conflict_paths"],
                      "union_resolved_paths": sorted(union_resolved),
                      "mergiraf_resolved_paths": sorted(mergiraf_resolved_paths),
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
        repo_stats.append((repo, len(prs), len(all_pairs), attempted, evaluated, repo_fetched))
        if evaluated != target:
            raise RuntimeError(f"{repo}: evaluated {evaluated} of {target} required pairs")
        all_unevaluable.extend(unevaluable)
    (raw_dir / "pair-results.json").write_text(json.dumps(pair_records, indent=2) + "\n")
    lines = [
        "SP-F5 lock-scheme replay",
        "Read-only inputs: GitHub merged-PR metadata via gh; local clone objects; missing PR head objects fetched only to a temporary bare mirror.",
        f"Sample: deterministic SHA-256 rank of (repository, PR numbers); replace unevaluable candidates with the next rank until min(all overlapping pairs, {PAIR_CAP}) are evaluated per repository.",
        f"Pair universe: {total_pairs}; candidate attempts: {total_sampled}; evaluated: {len(pair_records)}; merge-tree conflicts: {merge_conflicts}.",
        f"Missing PR heads fetched to temporary bare mirrors: {missing_heads}.",
        f"Tree-sitter fallback cases (file widening), excluding non-code files: {sum(TREE_FALLBACKS.values())}.",
        f"Tree-sitter grammars invoked for code: {', '.join(sorted(TREE_LANGUAGES_USED)) or 'none'}.",
        "Exact metadata commands (one per repository):",
        *[f"gh api --paginate repos/{repo}/pulls?state=closed&per_page=100 --jq '[.[] | select(.merged_at != null) | {{number,created_at,merged_at,head:{{sha:.head.sha}},base:{{sha:.base.sha}},title,html_url}}]'" for repo, _ in REPOS],
        "Exact merge command: git --git-dir=TEMP_BARE_MIRROR merge-tree --write-tree --merge-base=BASE HEAD_A HEAD_B",
        "Append-only conflict command: git merge-file --union OURS BASE THEIRS (temporary content copies; remaining paths retain merge-tree conflicts).",
        "Mergiraf conflict command: mergiraf merge --path-name PATH --output TEMP_OUTPUT BASE LEFT RIGHT.",
        "The required --write-tree operation writes result objects only to the temporary mirror, which reads clone objects through an alternate; clone refs and objects remain unchanged.",
        "Full per-pair merge-tree transcripts stay in task scratch; this output includes result hashes and up to five representative raw stdout snippets.",
        "",
        "repo | merged PRs | all overlapping pairs | candidates attempted | evaluated | missing heads fetched",
    ]
    lines.extend(" | ".join(map(str, row)) for row in repo_stats)
    lines += ["", "Unevaluable pairs (each replaced by the next deterministic rank):", "repo | PR pair | reason"]
    if all_unevaluable:
        lines.extend(f"{repo} | #{left} + #{right} | {reason}" for repo, left, right, reason in all_unevaluable)
    else:
        lines.append("none")
    lines += ["", "Tree-sitter fallback cases by extension, grammar language, and reason:", "extension | language | reason | count"]
    lines.extend(f"{ext} | {LANGUAGES.get(ext, 'unmapped')} | {reason} | {count}"
                 for (ext, reason), count in sorted(TREE_FALLBACKS.items()))
    lines += ["", f"Mergiraf installed: {'yes' if mergiraf_available else 'no'}; conflicted content files tested: {merge_tested_files}; files resolved: {merge_resolved}.",
              "Pair examples: PR URLs and paths are real sampled pull requests; conflict paths come from merge-tree."]
    render_metrics(lines, "Overall results", overall_metrics)
    for repo, *_ in repo_stats:
        render_metrics(lines, f"Repository: {repo}", repo_metrics[repo])
    for cls in FILE_CLASSES:
        render_metrics(lines, f"File class: {cls}", class_metrics[cls])
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
