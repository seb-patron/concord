#!/usr/bin/env python3
"""Measure Git funcname headings against tree-sitter on recent local history."""

from __future__ import annotations

import argparse
import collections
import dataclasses
import importlib.metadata
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from tree_sitter import Language, Parser
import tree_sitter_cpp
import tree_sitter_python
import tree_sitter_rust
import tree_sitter_typescript


ROOT = Path(__file__).resolve().parents[3]
EXTERNAL = [
    ("mwcc-rs", Path("/Users/sebastianpatronsoto/agent-runs/clones/mwcc-rs")),
    ("gen-v-decomp", Path("/Users/sebastianpatronsoto/agent-runs/clones/gen-v-decomp")),
    ("gen-v-research-tools", Path("/Users/sebastianpatronsoto/agent-runs/clones/gen-v-research-tools")),
]
TYPESCRIPT_RULE = r"^[[:space:]]*(export[[:space:]]+)?function[[:space:]]+[[:alnum:]_]+"
EXTENSIONS = {
    ".rs": "rust", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".h": "cpp", ".hpp": "cpp",
    ".hh": "cpp", ".hxx": "cpp", ".py": "python", ".pyi": "python",
    ".ts": "typescript", ".tsx": "typescript",
}
LANGUAGE = {
    "rust": Language(tree_sitter_rust.language()),
    "cpp": Language(tree_sitter_cpp.language()),
    "python": Language(tree_sitter_python.language()),
    "typescript": Language(tree_sitter_typescript.language_typescript()),
}
FUNCTION_TYPES = {
    "rust": {"function_item", "function_signature_item"},
    "cpp": {"function_definition"},
    "python": {"function_definition"},
    "typescript": {"function_declaration", "generator_function_declaration", "method_definition", "arrow_function"},
}
HUNK = re.compile(rb"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$")
IDENT = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")


def git(repo: Path, *args: str, check: bool = True) -> bytes:
    proc = subprocess.run(["git", "-C", str(repo), *args], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=False)
    if check and proc.returncode:
        raise RuntimeError(f"git {' '.join(args[:4])}: {proc.stderr.decode(errors='replace').strip()}")
    return proc.stdout


def readable_repo(repo: Path) -> bool:
    return repo.is_dir() and subprocess.run(["git", "-C", str(repo), "rev-parse", "--git-dir"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def language_for(path: str) -> str | None:
    return EXTENSIONS.get(Path(path).suffix.lower())


def node_name(node, source: bytes, language: str) -> str | None:
    field = node.child_by_field_name("name")
    if field is None and language == "typescript" and node.type == "arrow_function":
        parent = node.parent
        if parent and parent.type == "variable_declarator":
            field = parent.child_by_field_name("name")
    if field is not None:
        name = source[field.start_byte:field.end_byte].decode("utf-8", errors="replace").strip()
        ids = IDENT.findall(name)
        return ids[-1] if ids else name or None
    if language == "cpp":
        declarator = node.child_by_field_name("declarator")
        while declarator is not None:
            nested = declarator.child_by_field_name("declarator")
            if nested is not None:
                declarator = nested
                continue
            name = declarator.child_by_field_name("name") or declarator
            names = IDENT.findall(source[name.start_byte:name.end_byte].decode("utf-8", errors="replace"))
            return names[-1] if names else None
    return None


def symbol_index(source: bytes, language: str):
    parser = Parser(LANGUAGE[language])
    tree = parser.parse(source)
    candidates = []

    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        if node.type in FUNCTION_TYPES[language]:
            name = node_name(node, source, language)
            if name:
                candidates.append((node.end_point.row, node.start_point.row,
                                   node.end_byte - node.start_byte, name))
        stack.extend(node.children)
    return candidates


def enclosing(index, line: int) -> str | None:
    row = max(0, line - 1)
    matches = [item for item in index if item[1] <= row <= item[0]]
    return min(matches, key=lambda item: item[2])[3] if matches else None


def git_heading_name(heading: bytes, language: str) -> str | None:
    text = heading.decode("utf-8", errors="replace").strip()
    if language == "typescript":
        match = re.match(r"^(?:export\s+)?function\s+([A-Za-z0-9_]+)", text)
        return match.group(1) if match else None
    if language == "python":
        match = re.search(r"\b(?:async\s+)?def\s+([A-Za-z_]\w*)", text)
        return match.group(1) if match else None
    if language == "rust":
        match = re.search(r"\bfn\s+([A-Za-z_]\w*)", text)
        return match.group(1) if match else None
    # Built-in C++ funcname patterns emit a signature; take its final
    # identifier before the parameter list (operators remain a known limit).
    prefix = text.split("(", 1)[0]
    names = IDENT.findall(prefix)
    return names[-1] if names else None


def changed_paths(patch: bytes) -> list[tuple[str, str, bytes]]:
    found = []
    current = None
    old_path = None
    chunks = []
    for line in patch.splitlines(keepends=True):
        if line.startswith(b"diff --git "):
            if current is not None:
                found.append((current, old_path or current, b"".join(chunks)))
            current, old_path, chunks = None, None, [line]
            continue
        if line.startswith(b"+++ b/"):
            current = line[6:].rstrip(b"\r\n").decode("utf-8", errors="replace")
        elif line.startswith(b"--- a/"):
            old_path = line[6:].rstrip(b"\r\n").decode("utf-8", errors="replace")
            if current is None:
                current = old_path
        chunks.append(line)
    if current is not None:
        found.append((current, old_path or current, b"".join(chunks)))
    return found


def hunk_rows(file_patch: bytes):
    for line in file_patch.splitlines():
        match = HUNK.match(line)
        if match:
            old_start, old_count, new_start, new_count = match.groups()[:4]
            heading = match.group(5) or b""
            yield int(old_start), int(old_count or b"1"), int(new_start), int(new_count or b"1"), heading


@dataclasses.dataclass
class Result:
    hunks: int = 0
    agree: int = 0
    both: int = 0
    wrong: int = 0
    no_symbol: int = 0
    git_wide: int = 0
    ts_wide: int = 0
    git_ms: float = 0.0
    ts_ms: float = 0.0


def blob(repo: Path, revision: str, path: str) -> bytes:
    return git(repo, "show", f"{revision}:{path}", check=False)


def measure_repo(label: str, repo: Path, limit: int):
    totals: dict[str, Result] = collections.defaultdict(Result)
    examples = []
    commits = git(repo, "log", "--no-merges", "--format=%H", f"-n{limit}").decode().splitlines()
    attr_dir = Path(os.environ.get("DELEGATE_SCRATCH_DIR") or os.environ.get("TMPDIR") or "/tmp")
    attr_dir.mkdir(parents=True, exist_ok=True)
    attrs = attr_dir / f"sp-e-{label}.attributes"
    attrs.write_text("*.rs diff=rust\n*.cpp diff=cpp\n*.cc diff=cpp\n*.cxx diff=cpp\n"
                     "*.h diff=cpp\n*.hpp diff=cpp\n*.hh diff=cpp\n*.hxx diff=cpp\n"
                     "*.py diff=python\n*.pyi diff=python\n"
                     "*.ts diff=typescript\n*.tsx diff=typescript\n")
    for commit in commits:
        parents = git(repo, "rev-list", "--parents", "-n", "1", commit).decode().split()
        if len(parents) < 2:
            continue
        parent = parents[1]
        diff_started = time.perf_counter()
        patch = git(repo, "-c", f"core.attributesFile={attrs}", "-c",
                    f"diff.typescript.xfuncname={TYPESCRIPT_RULE}", "diff", "--no-ext-diff",
                    "--no-color", "--unified=0", parent, commit)
        diff_elapsed_ms = (time.perf_counter() - diff_started) * 1000
        files = changed_paths(patch)
        target_hunks = sum(len(list(hunk_rows(fp))) for path, old_path, fp in files if language_for(path))
        for path, old_path, file_patch in files:
            lang = language_for(path)
            if lang is None:
                continue
            rows = list(hunk_rows(file_patch))
            if not rows:
                continue
            parse_started = time.perf_counter()
            old = blob(repo, parent, old_path)
            new = blob(repo, commit, path)
            old_index = symbol_index(old, lang) if old else []
            new_index = symbol_index(new, lang) if new else []
            parse_elapsed_ms = (time.perf_counter() - parse_started) * 1000
            for old_line, old_count, new_line, new_count, heading in rows:
                row = totals[lang]
                row.hunks += 1
                t0 = time.perf_counter()
                git_name = git_heading_name(heading, lang)
                row.git_ms += (time.perf_counter() - t0) * 1000 + diff_elapsed_ms / max(1, target_hunks)
                t0 = time.perf_counter()
                old_name = enclosing(old_index, max(1, old_line)) if old else None
                new_name = enclosing(new_index, max(1, new_line)) if new else None
                old_last = enclosing(old_index, max(1, old_line + old_count - 1)) if old and old_count else old_name
                new_last = enclosing(new_index, max(1, new_line + new_count - 1)) if new and new_count else new_name
                row.ts_ms += (time.perf_counter() - t0) * 1000 + parse_elapsed_ms / len(rows)
                stable = (old_name is not None and new_name is not None and old_name == new_name and
                          old_last == old_name and new_last == new_name)
                if not stable:
                    row.ts_wide += 1
                if git_name is None or not stable:
                    row.git_wide += 1
                if git_name is None or old_name is None or new_name is None:
                    row.no_symbol += 1
                else:
                    row.both += 1
                    if git_name == new_name and stable:
                        row.agree += 1
                    elif git_name != new_name:
                        row.wrong += 1
                        if len(examples) < 40 and not any(item[1] == lang and item[3] == path for item in examples):
                            examples.append((label, lang, commit[:12], path, git_name, new_name))
    return totals, examples, len(commits)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--commits", type=int, default=300)
    parser.add_argument("--repo", action="append", default=[], help="extra local repository as NAME=PATH")
    args = parser.parse_args()
    repos = [("concord", ROOT)] + [(name, path) for name, path in EXTERNAL if readable_repo(path)]
    for spec in args.repo:
        name, value = spec.split("=", 1)
        path = Path(value)
        if readable_repo(path):
            repos.append((name, path))
    all_examples = []
    print(f"Method: git diff --unified=0 funcname heading vs tree-sitter enclosing function name")
    versions = [f"{name}={importlib.metadata.version(name)}" for name in
                ("tree-sitter", "tree-sitter-rust", "tree-sitter-cpp", "tree-sitter-python", "tree-sitter-typescript")]
    print(f"Parser packages: {', '.join(versions)}")
    print(f"TypeScript xfuncname: {TYPESCRIPT_RULE}")
    print(f"History: up to {args.commits} newest non-merge commits; first parent diff; read-only local clones")
    print("Rates use all hunks as denominator; agreement is also reported over hunks with both names.")
    print("Widened means no Git key, or before/after syntax-tree names absent or changed; file fallback.")
    print("Timing amortizes Git diff plus heading extraction per hunk; tree-sitter includes blob reads, parsing, and lookup.")
    print("repo\tlanguage\thunks\tagreement/all\tagreement/both\twidened git\twidened tree-sitter\twrong symbol\tno symbol\tms/diff git\tms/diff tree-sitter")
    for name, repo in repos:
        totals, examples, commit_count = measure_repo(name, repo, args.commits)
        all_examples.extend(examples)
        print(f"\n[{name}] commits_walked={commit_count}")
        for lang in ("rust", "cpp", "python", "typescript"):
            r = totals.get(lang, Result())
            n = r.hunks or 1
            b = r.both or 1
            print(f"{name}\t{lang}\t{r.hunks}\t{r.agree/n:.3%}\t{r.agree/b:.3%}\t"
                  f"{r.git_wide/n:.3%}\t{r.ts_wide/n:.3%}\t{r.wrong/n:.3%}\t{r.no_symbol/n:.3%}\t"
                  f"{r.git_ms/n:.4f}\t{r.ts_ms/n:.4f}")
    print("\nDISAGREEMENT_EXAMPLES")
    selected = []
    for lang in ("rust", "cpp", "python", "typescript"):
        item = next((x for x in all_examples if x[1] == lang), None)
        if item:
            selected.append(item)
    for item in all_examples:
        if len(selected) >= 5:
            break
        if item not in selected and all((item[0], item[3]) != (chosen[0], chosen[3]) for chosen in selected):
            selected.append(item)
    for item in selected[:5]:
        print("\t".join(item))
    print(f"\nRepositories measured: {len(repos)}; all hunk and timing data above are local observations.")


if __name__ == "__main__":
    main()
