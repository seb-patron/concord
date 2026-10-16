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
PATH = re.compile(r"(?<!\w)(?:[\w.-]+/)+[\w.\-]+|(?<!\w)[\w.\-]+\.(?:json|yaml|html|swift|toml|tsx|cpp|css|txt|yml|py|ts|js|rs|sh|md|c|h)\b(?::\d+)?", re.I)
CODE_SPAN = re.compile(r"`([^`\n]*)`")
LABEL = re.compile(r"^[ \t]*(?:Done when|Allowed files|Inputs|Out of scope|Validation|Steps|Role|Rules|Publication|Sandbox|Commit message|Closes|Goal|Outcome):", re.I)


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
    if re.search(r"(?m)^## Delegation spec\s*$", text):
        text = re.split(r"(?m)^## Delegation spec\s*$", text, maxsplit=1)[1]
    # Examples inside a fenced block are not task instructions.
    text = re.sub(r"(?ms)^\s*```[^\n]*\n.*?^\s*```[ \t]*$", "", text)
    match = re.search(r"(?m)^[ \t]*Outcome:[ \t]*(.*)$", text)
    if match:
        tail = text[match.end():].splitlines()
        lines = [match.group(1).strip()]
        for line in tail:
            if LABEL.match(line):
                break
            if line.strip():
                lines.append(line.strip())
        return " ".join(lines).strip()
    match = re.search(r"(?m)^[ \t]*Goal:[ \t]*(.*)$", text)
    if not match:
        return ""
    lines = [match.group(1).strip()]
    for line in text[match.end():].splitlines():
        if LABEL.match(line):
            break
        if line.strip():
            lines.append(line.strip())
    return " ".join(lines).strip()


def redact(text, answers):
    text = CODE_SPAN.sub(lambda m: "[path redacted]" if PATH.search(m.group(1)) or re.search(r"\b\w+:\d+\b", m.group(1)) else m.group(0), text)
    for path in sorted(answers, key=len, reverse=True):
        for token in (path, path.rsplit("/", 1)[-1]):
            if len(token) >= 4:
                text = re.sub(re.escape(token), "[path redacted]", text, flags=re.I)
    text = re.sub(r"\b(?:[\w.-]+/)+<[^>]+>\.[A-Za-z]+", "[path redacted]", text)
    text = PATH.sub("[path redacted]", text)
    text = re.sub(r"\b(?:around|at|near)\s+lines?\s+\d+(?:\s*[-–]\s*\d+)?\b", "[location redacted]", text, flags=re.I)
    text = re.sub(r"\b[0-9a-f]{7,40}\b", "[commit redacted]", text, flags=re.I)
    text = re.sub(r"(?<!\w)(?:[\w.-]+):\d+(?:-\d+)?", "[location redacted]", text)
    return re.sub(r"\s+", " ", text).strip()


def leaks(text, answers):
    low = text.lower()
    if re.search(r"allowed[- ]files|delegation spec|^\s*steps:", text, re.I | re.M):
        return "spec_or_allowed_list"
    if PATH.search(text) or re.search(r"\b[\w.-]+:\d+\b|\b(?:around|at|near)\s+lines?\s+\d+", text, re.I):
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
    state = status.get("state", "")
    refused = "refused-scope" in state or "refused_scope" in state
    if not refused:
        return [], False, "none_reported"
    log = run / "run.log"
    if not log.is_file():
        return [], True, "path_unavailable"
    # Only explicit launcher diagnostics count. Do not guess paths from prose.
    found = set()
    for line in log.read_text(errors="replace").splitlines():
        if "scope check:" in line:
            found.update(re.findall(r"'([^']+)' is not in Allowed files", line))
    malformed = any(len(PATH.findall(line)) > 1 for line in
                    (run / "allowed-files.txt").read_text(errors="replace").splitlines())
    return sorted(found), True, "malformed_allowlist_diagnostic" if malformed else "log_diagnostic" if found else "path_unavailable"


def worker_time(run):
    log = run / "run.log"
    if log.is_file():
        match = re.search(r"worker starting (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)", log.read_text(errors="replace"))
        if match:
            return stamp(match.group(1))
    return assignment_time(run)


def base_time(repo, base, run):
    if not SHA.fullmatch(str(base)):
        return None
    for place in (clone_for(repo), run / "worktree"):
        if place and (place / ".git").exists():
            call = shell("git", "-C", str(place), "show", "-s", "--format=%cI", base)
            if call.returncode == 0:
                return stamp(call.stdout.strip()).astimezone(timezone.utc)
    return None


def hint_flags(text, answers):
    low = text.lower()
    stems = {Path(p).stem.lower() for p in answers if len(Path(p).stem) >= 5}
    folders = {part.lower() for p in answers for part in Path(p).parts[:-1]
               if len(part) >= 5 and part.lower() not in {"source", "sources", "tests", "docs", "scripts", "fixtures"}}
    named = lambda token: bool(re.search(r"(?<![\w.-])" + re.escape(token) + r"(?![\w.-])", low))
    return {"answer_stem": any(named(s) for s in stems),
            "answer_folder": any(named(s) for s in folders),
            "edit_permission": bool(re.search(r"\b(?:may|can|allowed to)\s+(?:also\s+)?(?:change|edit|modify)\b", low))}


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
    issues = {}
    if not args.no_gh:
        by_repo = defaultdict(list)
        for repo, issue in families:
            by_repo[repo].append(issue)
        for repo, numbers in sorted(by_repo.items()):
            issues.update({(repo, n): v for n, v in first_issues(repo, sorted(set(numbers))).items()})
    selected = []
    audit = []
    for (repo, issue), attempts in sorted(families.items()):
        attempts.sort(key=lambda x: assignment_time(x[0]) or datetime.max.replace(tzinfo=timezone.utc))
        run, status, spec = attempts[0]  # first attempt, never a later successful retry
        base = status.get("base_sha") or status.get("base")
        candidate = status.get("candidate_sha") or status.get("validated_sha") or status.get("commit_sha")
        assignment = worker_time(run)
        committed = base_time(repo, base, run)
        issue_text, issue_error, created = issues.get((repo, issue), (None, "gh_not_requested", None))
        audit_common = {"record_type": "family_audit", "repository": repo, "issue_family": f"{repo}#{issue}",
                        "run": str(run.relative_to(RUNS)), "base_sha": base,
                        "creation_utc": created.isoformat() if created else None,
                        "creation_text_status": issue_error or "recovered"}
        if issue_text is None:
            preliminary = issue_error
        else:
            preliminary = leaks(issue_text, [])
            if not issue_text.strip():
                preliminary = "empty_creation_body"
            elif low_information(issue_text):
                preliminary = "thin_creation_body"
            if created is None or assignment is None or created >= assignment:
                preliminary = "not_before_worker_start"
        audit_common["preliminary_tier_a_status"] = preliminary or "candidate_needs_answer_audit"
        if assignment and assignment > SOURCE_CUTOFF:
            counts["family_worker_start_after_cutoff"] += 1
            audit.append({**audit_common, "snapshot_status": "worker_start_after_cutoff", "label_status": "unknown",
                          "worker_start_utc": assignment.isoformat()})
            continue
        if committed is None or assignment is None:
            counts["family_base_time_unavailable"] += 1
            audit.append({**audit_common, "snapshot_status": "base_time_unavailable", "label_status": "unknown"})
            continue
        if committed > assignment:
            counts["family_base_after_worker_start"] += 1
            audit.append({**audit_common, "snapshot_status": "base_after_worker_start", "label_status": "unknown",
                          "worker_start_utc": assignment.isoformat(), "base_committed_utc": committed.isoformat()})
            continue
        paths = changed_paths(repo, base, candidate, run)
        if paths is None:
            counts["family_no_diffable_first_attempt"] += 1
        elif not paths:
            counts["family_empty_diff"] += 1
        raw = outcome_text(spec)
        if not raw:
            counts["family_no_goal_outcome"] += 1
        audit.append({**audit_common, "snapshot_status": "verified", "label_status": "diffable" if paths else "unknown",
                      "worker_start_utc": assignment.isoformat(), "base_committed_utc": committed.isoformat(),
                      "outcome_status": "extracted" if raw else "missing", "changed_files": paths})
        selected.append((repo, issue, run, status, spec, paths, raw, base, assignment, committed))
    counts["families_with_verified_snapshot"] = len(selected)
    bundles, answers = [], []
    audit_by_family = {row["issue_family"]: row for row in audit}
    repo_counts = defaultdict(Counter)
    for repo, issue, run, status, spec, paths, raw, base, assignment, committed in selected:
        issue_text, issue_error, created = issues.get((repo, issue), (None, "gh_not_requested", None))
        family = f"{repo}#{issue}"
        audit_row = audit_by_family[family]
        common = {
            "task_id": hashlib.sha256((family + "|" + str(run.relative_to(RUNS))).encode()).hexdigest()[:16],
            "repository": repo, "issue_family": family, "split": split(repo),
            "base_sha": base, "assignment_utc": assignment.isoformat(),
            "base_committed_utc": committed.isoformat(),
        }
        refused, refused_flag, refused_source = refused_paths(run, status)
        state = status.get("state", "")
        if refused_flag and paths:
            declared = {line.strip() for line in (run / "allowed-files.txt").read_text(errors="replace").splitlines()
                        if line.strip() and not line.lstrip().startswith("#")}
            refused = sorted(set(refused) | (set(paths) - declared))
            refused_source += "+candidate_diff"
        dirty_refusal = "refused-dirty" in state or "refused_dirty" in state
        answer = {**common, "run": str(run.relative_to(RUNS)), "candidate_sha": status.get("candidate_sha"),
                  "changed_files": paths, "refused_scope_paths": refused,
                  "refused_scope_reported": refused_flag, "refused_scope_path_source": refused_source,
                  "label_status": "diffable" if paths else "unknown",
                  "label_limit": ("candidate refused for scope; changed diff can exceed Allowed files; unknown further needs"
                                  if refused_flag else "candidate refused as dirty; changed diff may exceed Allowed files"
                                  if dirty_refusal else "candidate diff under Allowed-file gate; acceptance not established; unknown unmet paths possible"
                                  if paths else "no diffable changed-file label")}
        tier_b = redact(raw, paths or []) if raw and paths else ""
        if tier_b and not leaks(tier_b, paths):
            audit_row["tier_b_status"] = "included"
            bundles.append({**common, "tier": "B", "leak_status": "LEAKY: spec author knew code",
                            "issue_text": tier_b, "source": "delegation Goal/Outcome only",
                            "hint_flags": hint_flags(tier_b, paths)})
            answers.append({**answer, "tier": "B"})
            repo_counts[repo]["B"] += 1
        elif raw and paths:
            audit_row["tier_b_status"] = "redaction_failed"
            repo_counts[repo]["B_excluded_redaction"] += 1
        else:
            audit_row["tier_b_status"] = "no_diff_or_outcome"
        if issue_text is None:
            audit_row["tier_a_status"] = issue_error
            repo_counts[repo]["A_excluded_" + issue_error] += 1
            continue
        reason = leaks(issue_text, paths or [])
        if not issue_text.strip():
            reason = "empty_creation_body"
        elif low_information(issue_text):
            reason = "thin_creation_body"
        if created is None or created >= assignment:
            reason = "not_before_assignment"
        # The worker-start marker follows any reservation/base refresh.
        if reason:
            audit_row["tier_a_status"] = reason
            repo_counts[repo]["A_excluded_" + reason] += 1
            continue
        bundles.append({**common, "tier": "A", "leak_status": "pre-spec issue text; author knew code",
                        "issue_text": issue_text, "source": "GitHub creation revision",
                        "hint_flags": hint_flags(issue_text, paths or [])})
        answers.append({**answer, "tier": "A"})
        audit_row["tier_a_status"] = "included"
        repo_counts[repo]["A"] += 1
    bundles.sort(key=lambda x: (x["repository"], x["issue_family"], x["tier"]))
    answers.sort(key=lambda x: (x["repository"], x["issue_family"], x["tier"]))
    OUT.mkdir(parents=True, exist_ok=True)
    for name, rows in (("bundles.jsonl", bundles), ("answers.jsonl", answers + audit)):
        (OUT / name).write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows))
    print(json.dumps({"counts": counts, "per_repository": repo_counts,
                      "bundles": len(bundles), "scored_answers": len(answers),
                      "family_audits": len(audit), "answer_rows": len(answers) + len(audit)},
                     sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
