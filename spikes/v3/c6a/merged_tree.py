#!/usr/bin/env python3
"""Replay the 40 SP-F5 textual conflicts in an isolated temporary clone."""

from __future__ import annotations

import argparse
import json
import os
import signal
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


SOURCE = Path("/Users/sebastianpatronsoto/agent-runs/clones/gen-v-research-tools")
SUPPLEMENTAL = Path(
    "/Users/sebastianpatronsoto/agent-runs/concord-c1b87e70add5a86a89981a0a/"
    "work-codex-20261015T213154Z-16a5e3da61c85739b222df0cd7eaeede/"
    "scratch/sp-f5-raw-bvyn00x9/gen-v-research-tools.git"
)
LOG_PATHS = {"LAB_READING_TRAIL.md", "trail/INDEX.md"}
CHECK = [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"]
CHECK_ENV = {**os.environ, "PYTHONPATH": "src", "PYTHONDONTWRITEBYTECODE": "1"}


def git(repo: Path, *args: str, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=check,
    )


def safe_run(argv: list[str], cwd: Path, timeout: int | None = None,
             env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        env=env,
    )


def unresolved(repo: Path) -> list[str]:
    result = git(repo, "diff", "--name-only", "--diff-filter=U")
    return [line for line in result.stdout.splitlines() if line]


def reset_pair(repo: Path, base: str) -> None:
    git(repo, "merge", "--abort")
    git(repo, "reset", "--hard", base, check=True)
    git(repo, "clean", "-fd", check=True)


def try_merge(repo: Path, base: str, left: str, right: str,
              union_logs: bool) -> tuple[bool, list[str], str]:
    git(repo, "merge", "--abort")
    git(repo, "checkout", "--detach", base, check=True)
    result = git(repo, "merge", "--no-commit", "--no-ff", left, right)
    if result.returncode == 0:
        return True, [], result.stdout

    paths = unresolved(repo)
    if union_logs:
        for path in paths:
            if path not in LOG_PATHS:
                continue
            stages = []
            for stage in (":2:", ":1:", ":3:"):
                blob = git(repo, "show", f"{stage}{path}")
                if blob.returncode:
                    stages = []
                    break
                stages.append(blob.stdout)
            if len(stages) != 3:
                continue
            with tempfile.TemporaryDirectory(prefix="c6a-union-") as tmp:
                ours, ancestor, theirs = (Path(tmp) / name for name in ("ours", "base", "theirs"))
                ours.write_text(stages[0], encoding="utf-8")
                ancestor.write_text(stages[1], encoding="utf-8")
                theirs.write_text(stages[2], encoding="utf-8")
                merged = safe_run(
                    ["git", "merge-file", "--union", "-p", str(ours), str(ancestor), str(theirs)],
                    repo,
                )
                if merged.returncode not in (0, 1):
                    continue
                (repo / path).write_text(merged.stdout, encoding="utf-8")
                git(repo, "add", "--", path, check=True)
        paths = unresolved(repo)

    if not paths:
        return True, [], result.stdout
    return False, paths, result.stdout


def try_mergiraf(repo: Path, base: str, left: str, right: str,
                 executable: str) -> tuple[bool, list[str], str]:
    git(repo, "merge", "--abort")
    git(repo, "checkout", "--detach", base, check=True)
    result = git(repo, "merge", "--no-commit", "--no-ff", left, right)
    paths = unresolved(repo)
    for path in paths:
        with tempfile.TemporaryDirectory(prefix="c6a-mergiraf-") as tmp:
            blobs = []
            for stage in (":1:", ":2:", ":3:"):
                blob = git(repo, "show", f"{stage}{path}")
                if blob.returncode:
                    blobs = []
                    break
                item = Path(tmp) / f"stage-{len(blobs)}"
                item.write_text(blob.stdout, encoding="utf-8")
                blobs.append(item)
            if len(blobs) != 3:
                continue
            output = Path(tmp) / "merged"
            merged = safe_run(
                [executable, "merge", "--path-name", path, "--output", str(output),
                 str(blobs[0]), str(blobs[1]), str(blobs[2])], repo,
            )
            if merged.returncode or not output.is_file():
                continue
            content = output.read_text(encoding="utf-8")
            if any(marker in content for marker in ("<<<<<<<", "=======", ">>>>>>>")):
                continue
            (repo / path).write_text(content, encoding="utf-8")
            git(repo, "add", "--", path, check=True)
    remaining = unresolved(repo)
    return not remaining, remaining, result.stdout


def run_check(repo: Path) -> tuple[str, str, float]:
    started = time.monotonic()
    process = subprocess.Popen(
        CHECK,
        cwd=repo,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=CHECK_ENV,
        start_new_session=True,
    )
    try:
        output, _ = process.communicate(timeout=300)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            output, _ = process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            output, _ = process.communicate()
        return "over-5m", output[-4000:], time.monotonic() - started
    except BaseException:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
        raise
    return ("pass" if process.returncode == 0 else "fail", output[-4000:],
            time.monotonic() - started)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pairs_json", type=Path, help="SP-F5 pair-results.json")
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--supplemental-mirror", type=Path, default=SUPPLEMENTAL)
    args = parser.parse_args()

    all_pairs = json.loads(args.pairs_json.read_text(encoding="utf-8"))
    pairs = [item for item in all_pairs if item.get("merge_tree_exit_conflict")]
    if len(pairs) != 40:
        raise SystemExit(f"expected exactly 40 textual-conflict pairs; got {len(pairs)}")
    if not args.source.is_dir():
        raise SystemExit(f"local source clone is missing: {args.source}")

    mergiraf = shutil.which("mergiraf")
    with tempfile.TemporaryDirectory(prefix="concord-c6a-", dir=os.environ.get("TMPDIR")) as tmp:
        repo = Path(tmp) / "gen-v-research-tools"
        clone_args = ["git", "clone", "--no-hardlinks"]
        if args.supplemental_mirror.is_dir():
            clone_args.extend(["--reference-if-able", str(args.supplemental_mirror)])
        clone_args.extend(["--no-checkout", str(args.source), str(repo)])
        clone = safe_run(clone_args, Path(tmp))
        print("temporary clone command: " + " ".join(clone_args))
        print(f"temporary clone exit: {clone.returncode}")
        if clone.returncode:
            print(clone.stdout)
            return 2

        missing: set[str] = set()
        for pair in pairs:
            for commit in [pair["base"], *pair["heads"]]:
                if git(repo, "cat-file", "-e", f"{commit}^{{commit}}").returncode:
                    missing.add(commit)
        fetched: set[str] = set()
        supplemental_refs: dict[str, str] = {}
        if args.supplemental_mirror.is_dir():
            listed = safe_run(["git", "-C", str(args.supplemental_mirror), "show-ref"], repo)
            if listed.returncode == 0:
                for line in listed.stdout.splitlines():
                    sha, ref = line.split(" ", 1)
                    supplemental_refs[sha] = ref
        for commit in sorted(missing):
            ref = supplemental_refs.get(commit)
            if ref:
                result = safe_run(["git", "-C", str(repo), "fetch", "--no-tags",
                                   str(args.supplemental_mirror), ref], repo)
                if result.returncode == 0:
                    fetched.add(commit)
                else:
                    print(f"supplemental fetch failed for {commit}: {result.stdout.strip()}")
        unresolved_objects = missing - fetched
        if unresolved_objects:
            raise SystemExit("required pair objects unavailable in clone and supplemental mirror: "
                             + ",".join(sorted(unresolved_objects)))

        print(f"input pairs: {len(pairs)}")
        print(f"missing objects imported from local prior replay mirror: {len(fetched)}")
        print(f"Mergiraf: {mergiraf if mergiraf else 'unavailable (not installed)'}")
        checks_enabled = True
        summaries = []
        for index, pair in enumerate(pairs, 1):
            label = pair["pair"]
            base, left, right = pair["base"], *pair["heads"]
            reset_pair(repo, base)
            ordinary, ordinary_paths, ordinary_raw = try_merge(repo, base, left, right, False)
            print(f"\n[{index:02d}/40] {label}")
            print(f"ordinary git merge: {'SUCCESS' if ordinary else 'CONFLICT'}")
            print(f"ordinary raw output: {ordinary_raw.strip() or '(empty)'}")
            if ordinary_paths:
                print("ordinary unresolved paths: " + ", ".join(ordinary_paths))
            if ordinary:
                status, output, seconds = run_check(repo)
                print(f"ordinary check ({' '.join(CHECK)}): {status}; {seconds:.1f}s")
                print(f"ordinary check output tail: {output.strip() or '(empty)'}")
            reset_pair(repo, base)
            union, union_paths, union_raw = try_merge(repo, base, left, right, True)
            print(f"union-for-log merge: {'SUCCESS' if union else 'CONFLICT'}")
            print(f"union raw output: {union_raw.strip() or '(empty)'}")
            if union_paths:
                print("union unresolved paths: " + ", ".join(union_paths))
            if union and checks_enabled:
                status, output, seconds = run_check(repo)
                print(f"union check ({' '.join(CHECK)}): {status}; {seconds:.1f}s")
                print(f"union check output tail: {output.strip() or '(empty)'}")
                if status == "over-5m":
                    checks_enabled = False
            reset_pair(repo, base)
            if mergiraf:
                structural, structural_paths, structural_raw = try_mergiraf(
                    repo, base, left, right, mergiraf)
                print(f"Mergiraf merge: {'SUCCESS' if structural else 'CONFLICT'}")
                print(f"Mergiraf raw output: {structural_raw.strip() or '(empty)'}")
                if structural_paths:
                    print("Mergiraf unresolved paths: " + ", ".join(structural_paths))
                if structural and checks_enabled:
                    status, output, seconds = run_check(repo)
                    print(f"Mergiraf check ({' '.join(CHECK)}): {status}; {seconds:.1f}s")
                    print(f"Mergiraf check output tail: {output.strip() or '(empty)'}")
                    if status == "over-5m":
                        checks_enabled = False
            else:
                structural = False
                print("Mergiraf merge: unavailable (not installed)")
            classification = ("trivially resolvable" if ordinary else
                              "resolvable with a rule" if union or structural else
                              "needs a human/agent decision")
            reason = ("ordinary Git merge completed" if ordinary else
                      "allowlisted append-only log union cleared every conflict" if union else
                      "Mergiraf resolved every conflict" if structural else
                      "conflicts remain after ordinary merge and append-only log union")
            summaries.append((label, ordinary, union, classification, reason))
            print(f"classification: {classification} — {reason}")
            reset_pair(repo, base)

        print("\nTotals:")
        for classification in ("trivially resolvable", "resolvable with a rule",
                               "needs a human/agent decision"):
            print(f"{classification}: {sum(row[3] == classification for row in summaries)}")
        print(f"ordinary merge successes: {sum(row[1] for row in summaries)}/40")
        print(f"union merge successes: {sum(row[2] for row in summaries)}/40")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
