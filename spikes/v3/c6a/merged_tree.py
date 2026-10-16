#!/usr/bin/env python3
"""Recheck the forty recorded SP-F5 conflict pairs in an isolated clone."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import signal
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
UNION_CANDIDATE = "LAB_READING_TRAIL.md"
GENERATED = "trail/INDEX.md"
CHECK = [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"]


def run(argv: list[str], cwd: Path | None = None, *, env=None,
        timeout: int | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv, cwd=cwd, env=env, timeout=timeout, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )


def git(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return run(["git", "-C", str(repo), *args])


def require_git(repo: Path, *args: str) -> str:
    result = git(repo, *args)
    if result.returncode:
        raise RuntimeError(f"git {' '.join(args)} failed ({result.returncode}): {result.stdout.strip()}")
    return result.stdout.strip()


def stable_output(value: str, repo: Path) -> str:
    return value.replace(str(repo), "<temporary repository>").replace(
        str(repo.parent), "<temporary directory>"
    )


def merge_tree(repo: Path, base: str, left: str, right: str):
    result = run([
        "git", "--git-dir", str(repo / ".git"), "merge-tree", "--write-tree",
        f"--merge-base={base}", left, right,
    ])
    if result.returncode not in (0, 1):
        raise RuntimeError(f"merge-tree failed ({result.returncode}): {result.stdout.strip()}")
    first = result.stdout.splitlines()[0] if result.stdout.splitlines() else ""
    if len(first) != 40 or any(char not in "0123456789abcdef" for char in first):
        raise RuntimeError(f"merge-tree returned no tree identity: {result.stdout.strip()}")
    conflicts = [line.rsplit(" in ", 1)[-1] for line in result.stdout.splitlines()
                 if line.startswith("CONFLICT (") and " in " in line]
    return first, result.returncode == 0, conflicts, result.stdout


def unresolved(repo: Path) -> list[str]:
    result = git(repo, "diff", "--name-only", "--diff-filter=U")
    if result.returncode:
        raise RuntimeError(f"could not inspect merge index: {result.stdout.strip()}")
    return [line for line in result.stdout.splitlines() if line]


def abort_reset(repo: Path, revision: str) -> None:
    require_git(repo, "reset", "--hard", revision)


def stage_blob(repo: Path, stage: int, path: str) -> bytes | None:
    result = git(repo, "show", f":{stage}:{path}")
    return result.stdout.encode() if result.returncode == 0 else None


def union_merge(repo: Path, base: str, left: str, right: str,
                conflict_paths: list[str]) -> tuple[str, list[str], str]:
    # Use a normal two-parent merge and require Git's computed base to match the
    # recorded replay base. Generated files and rewritten documents are ineligible.
    if require_git(repo, "merge-base", left, right) != base:
        raise RuntimeError("recorded base differs from Git's merge base")
    abort_reset(repo, left)
    merge = git(repo, "merge", "--no-commit", "--no-ff", "--strategy=ort", right)
    if merge.returncode not in (0, 1):
        raise RuntimeError(f"two-parent merge failed ({merge.returncode}): {merge.stdout.strip()}")
    paths = unresolved(repo)
    if (merge.returncode == 0) != (not paths):
        raise RuntimeError("two-parent merge exit status disagrees with index conflict state")
    if not paths:
        tree = require_git(repo, "write-tree")
        return "clean", [], tree

    applied = []
    for path in paths:
        if path != UNION_CANDIDATE or path == GENERATED:
            continue
        ancestor, ours, theirs = (stage_blob(repo, stage, path) for stage in (1, 2, 3))
        if ancestor is None or ours is None or theirs is None:
            continue
        # Prefix preservation proves this particular version only adds bytes to
        # the existing document. A filename alone never grants union eligibility.
        if not (ours.startswith(ancestor) and theirs.startswith(ancestor)):
            continue
        with tempfile.TemporaryDirectory(prefix="c6a-union-") as directory:
            root = Path(directory)
            files = [root / name for name in ("ours", "base", "theirs")]
            for file, content in zip(files, (ours, ancestor, theirs)):
                file.write_bytes(content)
            merged = run(["git", "merge-file", "--union", "-p",
                          *(str(file) for file in files)])
        if merged.returncode != 0:
            continue
        content = merged.stdout.encode()
        if not content.startswith(ancestor) or b"<<<<<<<" in content:
            continue
        (repo / path).write_bytes(content)
        require_git(repo, "add", "--", path)
        applied.append(path)

    remaining = unresolved(repo)
    regenerated = False
    generator = repo / "scripts" / "build_trail_index.py"
    if GENERATED in remaining and generator.is_file() and "scripts/build_trail_index.py" not in remaining:
        generated = run([sys.executable, "scripts/build_trail_index.py"],
                        cwd=repo, timeout=60)
        if generated.returncode == 0:
            require_git(repo, "add", "--", GENERATED)
            regenerated = True
            remaining = unresolved(repo)
    regen_note = f"; regenerated_index={'yes' if regenerated else 'no'}"
    if remaining:
        return "conflict", remaining, f"union={','.join(applied) or 'none'}{regen_note}"
    tree = require_git(repo, "write-tree")
    return "clean", [], f"{tree}; union={','.join(applied) or 'none'}{regen_note}"


def validate_index(repo: Path, scratch: Path) -> str:
    validator_path = repo / "scripts" / "build_trail_index.py"
    if not validator_path.is_file():
        return "trail index validator: not present in this historical revision"
    env = {**os.environ, "PYTHONPATH": "tests/ci_support:src",
           "PYTHONDONTWRITEBYTECODE": "1", "TMPDIR": str(scratch)}
    validator = run([sys.executable, "scripts/build_trail_index.py", "--check"],
                    cwd=repo, env=env, timeout=120)
    return (f"trail index validator: {'pass' if validator.returncode == 0 else 'fail'}; "
            f"exit={validator.returncode}; {stable_output(validator.stdout.strip(), repo) or '(no output)'}")


def checks(repo: Path, scratch: Path, *, run_unit_suite: bool) -> list[str]:
    env = {**os.environ, "PYTHONPATH": "tests/ci_support:src",
           "PYTHONDONTWRITEBYTECODE": "1", "TMPDIR": str(scratch)}
    if run_unit_suite:
        started = time.monotonic()
        try:
            process = subprocess.Popen(
                CHECK, cwd=repo, env=env, text=True, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, start_new_session=True,
            )
            try:
                output, _ = process.communicate(timeout=120)
            except subprocess.TimeoutExpired as timeout:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=5)
                output = timeout.stdout or ""
                if isinstance(output, bytes):
                    output = output.decode(errors="replace")
                if process.stdout:
                    process.stdout.close()
                results = ["unit tests: timeout after 120s; process group terminated",
                           "unit test output tail: " + stable_output(
                               "\n".join(output.splitlines()[-12:]), repo)]
            else:
                elapsed = time.monotonic() - started
                tail = stable_output("\n".join(output.splitlines()[-12:]), repo)
                results = [f"unit tests: {'pass' if process.returncode == 0 else 'fail'}; exit={process.returncode}; {elapsed:.1f}s",
                           "unit test summary: " + (tail or "(no output)")]
        except OSError as error:
            results = [f"unit tests could not start: {error}"]
    else:
        results = ["unit tests: not repeated after the single bounded suite attempt; freshness validator run"]
    results.append(validate_index(repo, scratch))
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pairs_json", type=Path, help="the SP-F5 pair-results.json input")
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--supplemental-mirror", type=Path, default=SUPPLEMENTAL)
    args = parser.parse_args()
    raw = args.pairs_json.read_bytes()
    pairs = [item for item in json.loads(raw) if item.get("merge_tree_exit_conflict")]
    if len(pairs) != 40:
        raise SystemExit(f"expected exactly 40 conflict pairs; got {len(pairs)}")
    if not args.source.is_dir():
        raise SystemExit(f"source clone is missing: {args.source}")

    with tempfile.TemporaryDirectory(prefix="concord-c6a-", dir=os.environ.get("TMPDIR")) as temporary:
        scratch = Path(temporary)
        repo = scratch / "repository"
        clone_args = ["git", "clone", "--no-hardlinks"]
        if args.supplemental_mirror.is_dir():
            clone_args += ["--reference-if-able", str(args.supplemental_mirror)]
        clone_args += ["--no-checkout", str(args.source), str(repo)]
        clone = run(clone_args, cwd=scratch)
        if clone.returncode:
            raise SystemExit(f"clone failed ({clone.returncode}): {clone.stdout.strip()}")
        refs = {}
        listing = run(["git", "-C", str(args.supplemental_mirror), "show-ref"])
        if args.supplemental_mirror.is_dir() and listing.returncode == 0:
            refs = {line.split(" ", 1)[0]: line.split(" ", 1)[1]
                    for line in listing.stdout.splitlines()}
        missing = sorted({revision for pair in pairs for revision in [pair["base"], *pair["heads"]]
                          if git(repo, "cat-file", "-e", f"{revision}^{{commit}}").returncode})
        for revision in missing:
            ref = refs.get(revision)
            if not ref:
                raise SystemExit(f"required revision unavailable: {revision}")
            fetched = run(["git", "-C", str(repo), "fetch", "--no-tags",
                           str(args.supplemental_mirror), ref])
            if fetched.returncode:
                raise SystemExit(f"could not import {revision}: {fetched.stdout.strip()}")

        print("SP-F5 evidence: gen-v-research-tools; 40 conflict pairs")
        print(f"pair input SHA-256: {hashlib.sha256(raw).hexdigest()}")
        print("baseline: git merge-tree --write-tree --merge-base=BASE LEFT RIGHT")
        print("ordinary comparison: git merge --no-commit --no-ff --strategy=ort RIGHT from LEFT")
        print("append-only eligibility: LAB_READING_TRAIL.md only, base bytes prefix both sides")
        print("generated file excluded from union: trail/INDEX.md; when its generator is clean, rebuild with scripts/build_trail_index.py and verify with --check")
        print("pair | base | left | right | merge-tree tree | ordinary | rule result | remaining conflict paths | checks")
        records = []
        unit_suite_attempted = False
        for pair in pairs:
            label = pair["pair"]
            base, (left, right) = pair["base"], pair["heads"]
            try:
                tree, clean, conflict_paths, _ = merge_tree(repo, base, left, right)
                status, paths, union_result = union_merge(repo, base, left, right, conflict_paths)
                check_output = []
                if status == "clean":
                    check_output = checks(repo, scratch,
                                          run_unit_suite=not unit_suite_attempted)
                    unit_suite_attempted = True
                elif GENERATED in conflict_paths:
                    check_output = [validate_index(repo, scratch)]
                print(f"{label} | {base} | {left} | {right} | {tree} | "
                      f"{'clean' if clean else 'conflict'} | {status} {union_result} | "
                      f"{', '.join(paths) if paths else 'none'} | "
                      + ("; ".join(check_output) if check_output else "not run: unresolved"))
                records.append((clean, status, union_result))
            except (RuntimeError, subprocess.TimeoutExpired) as error:
                print(f"{label} | {base} | {left} | {right} | OPERATIONAL FAILURE | {error}")
                records.append((False, "operational failure", ""))
            abort_reset(repo, base)
        print("totals:")
        print(f"ordinary clean: {sum(record[0] for record in records)}/40")
        print(f"append-only union clean: {sum(record[1] == 'clean' and 'union=' in record[2] and record[2].split('union=', 1)[1].split(';', 1)[0] != 'none' for record in records)}/40")
        print(f"generated-index regeneration clean: {sum(record[1] == 'clean' and 'regenerated_index=yes' in record[2] for record in records)}/40")
        print(f"any rule clean: {sum(record[1] == 'clean' for record in records)}/40")
        print(f"unresolved: {sum(record[1] == 'conflict' for record in records)}/40")
        print(f"operational failures: {sum(record[1] == 'operational failure' for record in records)}/40")
        clean_count = sum(record[1] == "clean" for record in records)
        print(f"unit suite attempts: {int(unit_suite_attempted)}; clean trees without a suite attempt: {max(0, clean_count - int(unit_suite_attempted))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
