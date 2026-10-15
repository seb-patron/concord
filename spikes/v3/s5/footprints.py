#!/usr/bin/env python3
"""Read-only analysis of declared and actual worker run footprints."""

from __future__ import annotations

import json
import math
import os
import subprocess
from collections import Counter, defaultdict
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path("/Users/sebastianpatronsoto/agent-runs")
CLONES = ROOT / "clones"
SKIP = Counter()
SKIP_BY_REPO = defaultdict(Counter)
DIFF_CACHE = {}
SEEN_RUN_IDS = set()


def parse_time(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        result = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        if result.tzinfo is None:
            result = result.replace(tzinfo=timezone.utc)
        return result.timestamp()
    except ValueError:
        return None


def run_times(run_dir, status):
    """Approximate run interval from directory birth/mtime and recorded times."""
    starts, ends = [], []
    for key in ("started_at", "created_at", "started", "created", "start_time"):
        value = parse_time(status.get(key))
        if value is not None:
            starts.append(value)
    for key in ("finished_at", "completed_at", "ended_at", "updated_at", "finished", "end_time"):
        value = parse_time(status.get(key))
        if value is not None:
            ends.append(value)
    try:
        st = run_dir.stat()
        birth = getattr(st, "st_birthtime", st.st_ctime)
        starts.append(birth)
        ends.append(st.st_mtime)
    except OSError:
        pass
    # Prefer recorded start; directory creation is the fallback. updated_at
    # is treated as end because status.json is normally updated on completion.
    return (min(starts) if starts else None, max(ends) if ends else None)


def normalized_declared(path):
    lines = path.read_text(errors="replace").splitlines()
    return {line.strip().removeprefix("./") for line in lines if line.strip() and not line.lstrip().startswith("#")}


def git_changed(repo_path, base, head):
    if not repo_path or not base or not head:
        return None, "missing base or candidate SHA"
    key = (str(repo_path), base, head)
    if key in DIFF_CACHE:
        return DIFF_CACHE[key]
    try:
        result = subprocess.run(
            ["git", "-C", str(repo_path), "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", base, head],
            check=False, capture_output=True, text=False, timeout=8,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        DIFF_CACHE[key] = (None, str(exc))
        return DIFF_CACHE[key]
    if result.returncode:
        DIFF_CACHE[key] = (None, result.stderr.decode(errors="replace").strip() or f"git diff-tree exit {result.returncode}")
    else:
        DIFF_CACHE[key] = ({p.decode(errors="surrogateescape") for p in result.stdout.split(b"\0") if p}, "")
    return DIFF_CACHE[key]


def local_repos(run_dir, status):
    worktree = Path(status.get("worktree", "")) if status.get("worktree") else run_dir / "worktree"
    repo = (status.get("repo") or "").split("/")[-1]
    # Try the shared clone first, then a run worktree if its object database
    # has history absent from the clone.
    return [candidate for candidate in (CLONES / repo, worktree) if candidate.is_dir()]


def candidate_sha(status):
    return status.get("candidate_sha") or status.get("validated_sha") or status.get("commit_sha") or ""


def load_runs():
    runs, seen = [], set()
    # Local clones supply Git objects, not run records. Nested worktrees are
    # likewise contents of a run, not independent run directories.
    for current, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "__pycache__", "clones"}]
        here = Path(current)
        if "worktree" in here.parts:
            dirs[:] = []
        if "allowed-files.txt" not in files:
            continue
        if (here / "worktree").exists():
            dirs[:] = [d for d in dirs if d != "worktree"]
        key = str(here.resolve())
        if key in seen:
            continue
        seen.add(key)
        status_path = here / "status.json"
        if not status_path.is_file():
            SKIP["no status.json"] += 1
            SKIP_BY_REPO[here.parts[-2]]["no status.json"] += 1
            continue
        prompt = next((here / n for n in ("work-spec.md", "prompt.md") if (here / n).is_file()), None)
        if prompt is None:
            SKIP["no work-spec.md or prompt.md"] += 1
            SKIP_BY_REPO[here.parts[-2]]["no work-spec.md or prompt.md"] += 1
            continue
        try:
            status = json.loads(status_path.read_text(errors="replace"))
        except (OSError, json.JSONDecodeError):
            SKIP["invalid status.json"] += 1
            SKIP_BY_REPO[here.parts[-2]]["invalid status.json"] += 1
            continue
        repo_name = (status.get("repo") or "unknown").split("/")[-1]
        recorded_dir = status.get("run_dir") or status.get("worktree")
        if recorded_dir:
            identity = str(recorded_dir).replace("\\", "/").rstrip("/")
            if identity.startswith("~/"):
                identity = str(Path.home() / identity[2:])
        else:
            identity = str(here.resolve())
        if identity in SEEN_RUN_IDS:
            SKIP["duplicate archived run directory"] += 1
            SKIP_BY_REPO[repo_name]["duplicate archived run directory"] += 1
            continue
        SEEN_RUN_IDS.add(identity)
        try:
            declared = normalized_declared(here / "allowed-files.txt")
        except OSError:
            SKIP["unreadable allowed-files.txt"] += 1
            SKIP_BY_REPO[repo_name]["unreadable allowed-files.txt"] += 1
            continue
        sha = candidate_sha(status)
        state = str(status.get("state", "unknown"))
        record = {
            "dir": here, "repo": status.get("repo", "unknown"), "state": state,
            "declared": declared, "status": status,
            "times": run_times(here, status), "sha": sha,
        }
        runs.append(record)
        if not sha:
            SKIP["no candidate/validated commit SHA"] += 1
            SKIP_BY_REPO[repo_name]["no candidate/validated commit SHA"] += 1
            record["changed"] = None
            record["diff_error"] = "no candidate/validated commit SHA"
            continue
        base = status.get("base_sha") or status.get("base") or ""
        changed, error = None, "no matching local clone or run worktree"
        for repository in local_repos(here, status):
            changed, error = git_changed(repository, base, sha)
            if changed is not None:
                break
        record["changed"], record["diff_error"] = changed, error
        if changed is None:
            SKIP["commit not diffable locally"] += 1
            SKIP_BY_REPO[repo_name]["commit not diffable locally"] += 1
    return runs


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    index = max(0, math.ceil(p * len(ordered)) - 1)
    return ordered[index]


def median(values):
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2


def pct(n, d):
    return "n/a" if not d else f"{100*n/d:.1f}% ({n}/{d})"


def overlap_pairs(records, kind):
    pairs = []
    for i, a in enumerate(records):
        astart, aend = a["times"]
        aset = a[kind]
        if astart is None or aend is None or not aset:
            continue
        for b in records[i + 1:]:
            if a["repo"] != b["repo"]:
                continue
            bstart, bend = b["times"]
            if bstart is None or bend is None or not b[kind]:
                continue
            if astart <= bend and bstart <= aend:
                common = aset & b[kind]
                if common:
                    pairs.append((a, b, common))
    return pairs


def show_examples(label, examples, limit=5):
    print(f"{label} (up to {limit}):")
    for a, b, common in examples[:limit]:
        files = ", ".join(sorted(common)[:4])
        print(f"  {a['dir'].relative_to(ROOT)} <> {b['dir'].relative_to(ROOT)}: {files}")
    if not examples:
        print("  none")


def summarize(label, records, skip_reasons):
    commit_runs = [r for r in records if r["changed"] is not None]
    declared_sizes = [len(r["declared"]) for r in records]
    contained = sum(len(r["declared"] & r["changed"]) for r in commit_runs)
    declared_total = sum(len(r["declared"]) for r in commit_runs)
    refused = [r for r in records if "refused-scope" in r["state"].lower() or "refused_scope" in r["state"].lower()]
    print(f"\n[{label}]")
    print(f"runs analysed: {len(records)}")
    print("skip reasons: " + ("; ".join(f"{k}={v}" for k, v in sorted(skip_reasons.items())) or "none"))
    print(f"declared files/run: median={median(declared_sizes)} p90={percentile(declared_sizes, .9)}")
    print(f"runs with diffable commit: {len(commit_runs)}")
    print(f"declared file share changed: {pct(contained, declared_total)}; over-declared share: {pct(declared_total-contained, declared_total)}")
    print(f"launcher refused-scope runs: {len(refused)} / {len(records)} ({pct(len(refused), len(records))})")
    declared_pairs = overlap_pairs(records, "declared")
    actual_pairs = overlap_pairs(commit_runs, "changed")
    interval_pairs = sum(1 for i, a in enumerate(records) for b in records[i+1:] if a["repo"] == b["repo"] and a["times"][0] is not None and b["times"][0] is not None and a["times"][1] is not None and b["times"][1] is not None and a["times"][0] <= b["times"][1] and b["times"][0] <= a["times"][1])
    print(f"working interval pairs: {interval_pairs}")
    print(f"overlapping declared-file pairs: {len(declared_pairs)} ({pct(len(declared_pairs), interval_pairs)} of interval pairs)")
    print(f"overlapping actual-change pairs: {len(actual_pairs)} ({pct(len(actual_pairs), interval_pairs)} of interval pairs)")
    show_examples("declared overlap examples", declared_pairs)
    show_examples("actual overlap examples", actual_pairs)
    print("refused-scope examples (up to 5):")
    for record in refused[:5]:
        print(f"  {record['dir'].relative_to(ROOT)}: {record['state']}")
    if not refused:
        print("  none")


def main():
    runs = load_runs()
    print("Declared vs actual worker footprints")
    print(f"data root: {ROOT}")
    print(f"runs with declared files, prompt and status: {len(runs)}")
    print("Diff source: matching agent-runs/clones/<repo> when present, otherwise the run worktree; git diff-tree compares endpoint trees.")
    print("Time interval: recorded start/create through finish/update timestamps, with run-directory birth/ctime and mtime as available fallbacks.")
    print("Scope rule: allowed-files.txt is parsed as nonblank, noncomment lines; exact path matching.")
    summarize("overall", runs, SKIP)
    repos = sorted({r["repo"].split("/")[-1] for r in runs})
    for repo in repos:
        summarize(repo, [r for r in runs if r["repo"].split("/")[-1] == repo], SKIP_BY_REPO[repo])
    print("\nLimitations")
    print("- Launcher enforcement rejects out-of-list changes, so actual changed files cannot exceed a declared list in accepted/committed runs; refused-scope states count attempts caught before a commit.")
    print("- Orchestrators wrote the specs and knew the code, so declarations may be informed and are not an independent forecast.")
    print("- This is file-level only: it does not measure symbols, semantic overlap, or whether a declared file needed editing.")
    print("- Missing, malformed, nonlocal or otherwise undiffable history is excluded from diff-based denominators and counted in skip reasons.")
    print("- Time bounds are approximate where only directory metadata is available; overlap means intervals intersect and file paths intersect.")
    print("- Scope refusals are inferred from status state names containing refused-scope/refused_scope; alternate spellings may be missed.")


if __name__ == "__main__":
    destination = Path(__file__).with_name("output.txt")
    with destination.open("w") as report, redirect_stdout(report):
        main()
