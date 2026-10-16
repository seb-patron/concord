#!/usr/bin/env python3
"""Freeze issue-footprint bundles from local launcher history and read-only issue edits.

Run from the repository root with PYTHONDONTWRITEBYTECODE=1. The only writes are
the two JSONL deliverables beside this script. Git and GitHub access are reads.
"""

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

RUNS = Path("/Users/sebastianpatronsoto/agent-runs/")
OUT = Path("spikes/v3/c3")
SOURCE_CUTOFF = datetime(2026, 10, 16, 0, 42, 28, tzinfo=timezone.utc)
SHA = re.compile(r"^[0-9a-f]{40}$")
STAMP = re.compile(r"(20\d{6}T\d{6}Z)")
PATH = re.compile(r"(?<!\w)(?:[\w.-]+/)+[\w.\-]+|(?<!\w)[\w.\-]+\.(?:py|ts|tsx|js|rs|sh|md|json|yml|yaml|html|css|swift|c|h|cpp|toml|txt)(?::\d+)?", re.I)
CODE_HINT = re.compile(r"`[^`]*(?:/|\.[A-Za-z]{1,5}|:\d+)[^`]*`")


def shell(*args):
    return subprocess.run(args, text=True, capture_output=True, check=False)


def assignment_time(run):
    match = STAMP.search(run.name)
    if match:
        return datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    return None


def stamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def inventory():
    """Read only shallow launcher run directories, not nested test fixtures."""
    seen = set()
    for pattern in ("*/status.json", "*/*/status.json", "*/*/*/status.json"):
        for status_file in RUNS.glob(pattern):
            run = status_file.parent
            if "clones" in run.parts or "scratch" in run.parts or "worktree" in run.parts:
                continue
            if not (run / "allowed-files.txt").is_file():
                continue
            try:
                status = json.loads(status_file.read_text())
            except (ValueError, OSError):
                continue
            canonical = status.get("run_dir") or str(run)
            if canonical in seen:
                continue
            seen.add(canonical)
            spec = run / "work-spec.md"
            if not spec.is_file():
                spec = run / "prompt.md"
            if not spec.is_file():
                continue
            if not isinstance(status.get("repo"), str) or not status["repo"].startswith("seb-patron/"):
                continue
            yield run, status, spec


def clone_for(repo):
    name = repo.split("/", 1)[1]
    clone = RUNS / "clones" / name
    return clone if (clone / ".git").exists() else None


def changed_paths(repo, base, candidate, run):
    if not SHA.fullmatch(str(base)) or not SHA.fullmatch(str(candidate)):
        return None
    places = [clone_for(repo), run / "worktree"]
    for place in places:
        if not place or not (place / ".git").exists():
            continue
        result = shell("git", "-C", str(place), "diff", "--name-only", "--no-renames", base, candidate)
        if result.returncode == 0:
            return sorted(set(filter(None, result.stdout.splitlines())))
    return None


def outcome_text(spec):
    text = spec.read_text(errors="replace")
    # The worker prompt embeds the original delegation spec below this marker.
    if "## Delegation spec" in text:
        text = text.split("## Delegation spec", 1)[1]
    match = re.search(r"(?m)^\s*Outcome:\s*(.*)$", text)
    if match:
        tail = text[match.end():].splitlines()
        lines = [match.group(1).strip()]
        for line in tail:
            if re.match(r"^\s*(?:Done when|Allowed files|Inputs|Out of scope|Validation|Steps):", line):
                break
            if line.strip():
                lines.append(line.strip())
        return " ".join(lines).strip()
    match = re.search(r"(?m)^Goal:\s*(.*)$", text)
    if not match:
        return ""
    lines = [match.group(1).strip()]
    for line in text[match.end():].splitlines():
        if not line.strip() or re.match(r"^(?:Allowed files|Steps|Validation|Out of scope):", line):
            break
        lines.append(line.strip())
    return " ".join(lines).strip()


def redact(text, answers):
    text = CODE_HINT.sub("[path redacted]", text)
    for path in sorted(answers, key=len, reverse=True):
        for token in (path, path.rsplit("/", 1)[-1]):
            if len(token) >= 4:
                text = re.sub(re.escape(token), "[path redacted]", text, flags=re.I)
    text = PATH.sub("[path redacted]", text)
    text = re.sub(r"(?<!\w)(?:[\w.-]+):\d+(?:-\d+)?", "[location redacted]", text)
    return re.sub(r"\s+", " ", text).strip()


def leaks(text, answers):
    low = text.lower()
    if re.search(r"allowed[- ]files|delegation spec|^\s*steps:", text, re.I | re.M):
        return "spec_or_allowed_list"
    if PATH.search(text) or re.search(r"\b[\w.-]+:\d+\b", text):
        return "path_or_location"
    if any(len(p.rsplit("/", 1)[-1]) >= 4 and p.rsplit("/", 1)[-1].lower() in low for p in answers):
        return "answer_basename"
    return None


def low_information(text):
    return len(re.findall(r"\b\w+\b", text)) < 30 or "full definition follows in a moment" in text.lower()


def first_issues(repo, numbers):
    """Fetch creation-time revisions, in batches; never use a later body as a proxy."""
    result = {}
    owner, name = repo.split("/", 1)
    for start in range(0, len(numbers), 12):
        batch = numbers[start:start + 12]
        aliases = " ".join(
            f'i{n}:issue(number:{n}){{createdAt lastEditedAt body userContentEdits(last:1){{nodes{{editedAt diff}}}}}}'
            for n in batch
        )
        query = f'query {{ repository(owner:"{owner}",name:"{name}") {{ {aliases} }} }}'
        call = shell("gh", "api", "graphql", "-f", "query=" + query)
        if call.returncode:
            for n in batch:
                result[n] = (None, "gh_query_failed", None)
            continue
        try:
            data = json.loads(call.stdout)["data"]["repository"]
        except (KeyError, TypeError, ValueError):
            for n in batch:
                result[n] = (None, "gh_response_invalid", None)
            continue
        for n in batch:
            issue = data.get(f"i{n}") if data else None
            if not issue:
                result[n] = (None, "issue_unavailable", None)
                continue
            edits = issue["userContentEdits"]["nodes"]
            created = stamp(issue["createdAt"])
            if edits:
                first = edits[0]
                # A later edit cannot prove what the creation-time body said.
                if stamp(first["editedAt"]) != created or first["diff"] is None:
                    result[n] = (None, "creation_body_unrecoverable", created)
                else:
                    result[n] = (first["diff"], None, created)
            elif issue["lastEditedAt"] is None:
                result[n] = (issue["body"], None, created)
            else:
                result[n] = (None, "creation_body_unrecoverable", created)
    return result


def split(repo):
    # Repository-disjoint, deterministic; all attempts in an issue family follow.
    # Frozen repository holdouts; no issue family can cross the split.
    return "held_out" if repo in {"seb-patron/gen-v-decomp", "seb-patron/swiftui-rewine"} else "train"


def refused_paths(run, status):
    refused = "refused-scope" in status.get("state", "") or "refused_scope" in status.get("state", "")
    if not refused:
        return [], False, "none_reported"
    log = run / "run.log"
    if not log.is_file():
        return [], True, "path_unavailable"
    # Only explicit launcher diagnostics count. Do not guess paths from prose.
    found = set()
    for line in log.read_text(errors="replace").splitlines():
        if not re.search(r"scope check:|out.of.scope|outside allowed", line, re.I):
            continue
        found.update(PATH.findall(line))
    return sorted(found), True, "log_diagnostic" if found else "path_unavailable"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-gh", action="store_true", help="rebuild Tier B without GitHub; Tier A unavailable")
    args = parser.parse_args()
    counts = Counter()
    families = defaultdict(list)
    for run, status, spec in inventory():
        when = assignment_time(run)
        if when is None or when > SOURCE_CUTOFF:
            continue
        counts["runs_with_marker_status_spec"] += 1
        issue = status.get("issue")
        if not isinstance(issue, int) or issue <= 0:
            counts["run_no_issue"] += 1
            continue
        families[(status["repo"], issue)].append((run, status, spec))
    counts["issue_families"] = len(families)
    selected = []
    for (repo, issue), attempts in sorted(families.items()):
        attempts.sort(key=lambda x: assignment_time(x[0]) or datetime.max.replace(tzinfo=timezone.utc))
        run, status, spec = attempts[0]  # first attempt, never a later successful retry
        base = status.get("base_sha") or status.get("base")
        candidate = status.get("candidate_sha") or status.get("validated_sha") or status.get("commit_sha")
        paths = changed_paths(repo, base, candidate, run)
        if paths is None:
            counts["family_no_diffable_first_attempt"] += 1
            continue
        if not paths:
            counts["family_empty_diff"] += 1
            continue
        raw = outcome_text(spec)
        if not raw:
            counts["family_no_goal_outcome"] += 1
            continue
        selected.append((repo, issue, run, status, spec, paths, raw, base))
    counts["selected_first_attempts"] = len(selected)
    by_repo = defaultdict(list)
    for row in selected:
        by_repo[row[0]].append(row[1])
    issues = {}
    if not args.no_gh:
        for repo, numbers in sorted(by_repo.items()):
            issues.update({(repo, n): v for n, v in first_issues(repo, sorted(set(numbers))).items()})
    bundles, answers = [], []
    repo_counts = defaultdict(Counter)
    for repo, issue, run, status, spec, paths, raw, base in selected:
        issue_text, issue_error, created = issues.get((repo, issue), (None, "gh_not_requested", None))
        assignment = assignment_time(run)
        family = f"{repo}#{issue}"
        common = {
            "task_id": hashlib.sha256((family + "|" + str(run.relative_to(RUNS))).encode()).hexdigest()[:16],
            "repository": repo, "issue_family": family, "split": split(repo),
            "base_sha": base, "assignment_utc": assignment.isoformat(),
        }
        refused, refused_flag, refused_source = refused_paths(run, status)
        answer = {**common, "run": str(run.relative_to(RUNS)), "candidate_sha": status.get("candidate_sha"),
                  "changed_files": paths, "refused_scope_paths": refused,
                  "refused_scope_reported": refused_flag, "refused_scope_path_source": refused_source,
                  "label_limit": "accepted diff constrained by Allowed files; unknown unmet paths possible"}
        tier_b = redact(raw, paths)
        if tier_b and not leaks(tier_b, paths):
            bundles.append({**common, "tier": "B", "leak_status": "LEAKY: spec author knew code",
                            "issue_text": tier_b, "source": "delegation Goal/Outcome only"})
            answers.append({**answer, "tier": "B"})
            repo_counts[repo]["B"] += 1
        else:
            repo_counts[repo]["B_excluded_redaction"] += 1
        if issue_text is None:
            repo_counts[repo]["A_excluded_" + issue_error] += 1
            continue
        reason = leaks(issue_text, paths)
        if not issue_text.strip():
            reason = "empty_creation_body"
        elif low_information(issue_text):
            reason = "thin_creation_body"
        if created is None or created >= assignment:
            reason = "not_before_assignment"
        # The run-name timestamp is the earliest available assignment bound.
        if reason:
            repo_counts[repo]["A_excluded_" + reason] += 1
            continue
        bundles.append({**common, "tier": "A", "leak_status": "blind creation-time issue text",
                        "issue_text": issue_text, "source": "GitHub creation revision"})
        answers.append({**answer, "tier": "A"})
        repo_counts[repo]["A"] += 1
    bundles.sort(key=lambda x: (x["repository"], x["issue_family"], x["tier"]))
    answers.sort(key=lambda x: (x["repository"], x["issue_family"], x["tier"]))
    OUT.mkdir(parents=True, exist_ok=True)
    for name, rows in (("bundles.jsonl", bundles), ("answers.jsonl", answers)):
        (OUT / name).write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows))
    print(json.dumps({"counts": counts, "per_repository": repo_counts,
                      "bundles": len(bundles), "answers": len(answers)}, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
