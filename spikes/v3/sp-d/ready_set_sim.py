#!/usr/bin/env python3
"""Explain a dependency graph and deterministic, file-aware ready-set schedule."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path


HERE = Path(__file__).resolve().parent
ISSUES_PATH = HERE / "issues.json"
MAX_AGENTS = 10

# The export's prose is not a typed edge store. Keep the recognized phrases
# explicit so output can distinguish parsed evidence from missing metadata.
DEPENDENCY_PATTERNS = (
    ("blocked by", "prerequisite"),
    ("depends on", "prerequisite"),
    ("after", "prerequisite"),
    ("blocks", "blocks"),
    ("parent", "parent"),
    ("child", "child"),
)
FILE_SUFFIXES = {
    ".c", ".cc", ".cpp", ".css", ".go", ".h", ".html", ".java",
    ".js", ".json", ".md", ".py", ".rs", ".sh", ".sql", ".toml",
    ".ts", ".tsx", ".txt", ".yaml", ".yml",
}
PATH_RE = re.compile(
    r"(?<![\w.-])(?:[\w.@+-]+/)*[\w.@+-]+\.[A-Za-z0-9]{1,8}(?![\w.-])"
)
ISSUE_RE = re.compile(r"#(\d+)")


def normalized_status(issue: dict) -> str:
    state = str(issue.get("state", "")).lower()
    return "closed" if state == "closed" else "open"


def issue_text(issue: dict) -> str:
    return f"{issue.get('title', '')}\n{issue.get('body', '')}"


def parse_edges(issues: list[dict]) -> list[tuple[int, int, str]]:
    """Return (dependent, prerequisite/related, source phrase) tuples."""
    edges: set[tuple[int, int, str]] = set()
    for issue in issues:
        number = int(issue["number"])
        text = issue_text(issue)
        for phrase, kind in DEPENDENCY_PATTERNS:
            pattern = re.compile(
                rf"\b{re.escape(phrase)}\b\s*(?::|are|is)?\s*"
                rf"((?:#\d+\s*(?:(?:,|and|&)\s*)?)*)",
                re.IGNORECASE,
            )
            for match in pattern.finditer(text):
                for target in ISSUE_RE.findall(match.group(1)):
                    other = int(target)
                    if kind == "blocks":
                        edges.add((other, number, "blocks"))
                    elif kind in ("parent", "child"):
                        edges.add((number, other, kind))
                    else:
                        edges.add((number, other, phrase.lower()))
    return sorted(edges)


def named_files(issue: dict) -> set[str]:
    """Collect conservative file-path clues, including code-formatted names."""
    text = issue_text(issue)
    candidates = set(PATH_RE.findall(text))
    for token in re.findall(r"`([^`]+)`", text):
        token = token.strip().strip(".,:;()[]{}")
        if "/" in token or Path(token).suffix.lower() in FILE_SUFFIXES:
            candidates.add(token)
    result: set[str] = set()
    for candidate in candidates:
        candidate = candidate.strip("./")
        if Path(candidate).suffix.lower() in FILE_SUFFIXES:
            result.add(candidate)
    return result


def cycles(nodes: set[int], edges: list[tuple[int, int, str]]) -> list[list[int]]:
    graph: dict[int, set[int]] = defaultdict(set)
    for dependent, prerequisite, kind in edges:
        if kind in ("parent", "child"):
            continue
        if dependent in nodes and prerequisite in nodes:
            graph[dependent].add(prerequisite)

    found: list[list[int]] = []
    visited: set[int] = set()
    active: list[int] = []
    active_set: set[int] = set()

    def visit(node: int) -> None:
        if node in visited:
            return
        active.append(node)
        active_set.add(node)
        for nxt in sorted(graph[node]):
            if nxt in active_set:
                start = active.index(nxt)
                cycle = active[start:] + [nxt]
                canonical = tuple(cycle[:-1])
                rotations = [canonical[i:] + canonical[:i] for i in range(len(canonical))]
                found.append(list(min(rotations)) + [min(rotations)[0]])
            else:
                visit(nxt)
        active.pop()
        active_set.remove(node)
        visited.add(node)

    for node in sorted(nodes):
        visit(node)
    unique = {tuple(cycle) for cycle in found}
    return [list(cycle) for cycle in sorted(unique)]


def schedule(issues: list[dict], edges: list[tuple[int, int, str]], limit: int) -> list[str]:
    by_number = {int(issue["number"]): issue for issue in issues}
    open_numbers = sorted(
        number for number, issue in by_number.items() if normalized_status(issue) == "open"
    )
    dependencies: dict[int, set[int]] = defaultdict(set)
    for dependent, prerequisite, kind in edges:
        if kind not in ("parent", "child") and dependent in by_number:
            dependencies[dependent].add(prerequisite)

    files = {number: named_files(by_number[number]) for number in open_numbers}
    unfinished = set(open_numbers)
    completed = {
        number for number, issue in by_number.items() if normalized_status(issue) == "closed"
    }
    lines: list[str] = []
    tick = 1

    while unfinished:
        ready = [
            number for number in sorted(unfinished)
            if dependencies[number].issubset(completed)
        ]
        if not ready:
            blocked = ", ".join(f"#{n}" for n in sorted(unfinished))
            lines.append(f"STALLED: no ready issue; remaining {blocked}")
            break

        running_files: set[str] = set()
        batch: list[int] = []
        for number in ready:
            if len(batch) >= limit:
                break
            if files[number] & running_files:
                continue
            batch.append(number)
            running_files.update(files[number])

        if not batch:
            lines.append(f"STALLED: ready issues conflict on named files at tick {tick}")
            break

        for slot, number in enumerate(batch, start=1):
            paths = ",".join(sorted(files[number])) or "(no explicit file path)"
            lines.append(f"tick {tick}: agent-{slot} START #{number} files={paths}")
        for number in batch:
            lines.append(f"tick {tick}: DONE #{number}")
            unfinished.remove(number)
            completed.add(number)
        tick += 1

    return lines


def main() -> None:
    data = json.loads(ISSUES_PATH.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise SystemExit("issues.json must contain an array")
    issues = [issue for issue in data if isinstance(issue, dict) and "number" in issue]
    numbers = {int(issue["number"]) for issue in issues}
    edges = parse_edges(issues)
    dependency_edges = [edge for edge in edges if edge[2] not in ("parent", "child")]
    missing = sorted({
        target for dependent, target, kind in dependency_edges
        if dependent in numbers and target not in numbers
    })
    detected_cycles = cycles(numbers, edges)
    open_count = sum(normalized_status(issue) == "open" for issue in issues)

    print("Concord v3 ready-set backlog simulation")
    print(f"source={ISSUES_PATH.relative_to(HERE.parent.parent.parent)}")
    print(f"issues={len(issues)} open={open_count} closed={len(issues) - open_count}")
    print(f"dependency_edges={len(dependency_edges)} missing_references={missing or 'none'}")
    print(f"cycles={detected_cycles or 'none'}")
    print(f"dispatch_cap={MAX_AGENTS} scheduling_model=unit-duration deterministic issue-number order")
    print("file_paths=explicit path-like/code-formatted names in title/body; no inferred ownership")
    print("schedule:")
    for line in schedule(issues, edges, MAX_AGENTS):
        print(f"  {line}")


if __name__ == "__main__":
    main()
