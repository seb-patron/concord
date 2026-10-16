#!/usr/bin/env python3
"""Deterministic scenario replay of file claims; no Concord service calls.

One simulated time unit is one first file touch. This is a mechanics model,
not an estimate of observed lease latency or agent behavior.
"""

from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
import json
import subprocess

from build_dataset import SOURCE_CUTOFF, assignment_time, changed_paths, clone_for, inventory

OUTPUT = Path("spikes/v3/c3/output.txt")
CAP_PER_REPO = 40


def declared_files(run):
    return set(
        line.strip() for line in (run / "allowed-files.txt").read_text(errors="replace").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    )


def touch_order(repo, run, base, candidate, changed):
    """Use separate commits when present; one commit cannot order its files."""
    places = [clone_for(repo), run / "worktree"]
    for place in places:
        if not place or not (place / ".git").exists():
            continue
        call = subprocess.run(
            ["git", "-C", str(place), "log", "--reverse", "--format=COMMIT:%H",
             "--name-only", f"{base}..{candidate}"],
            capture_output=True, text=True, check=False,
        )
        if call.returncode:
            continue
        commits = sum(line.startswith("COMMIT:") for line in call.stdout.splitlines())
        if commits > 1:
            order = list(dict.fromkeys(line for line in call.stdout.splitlines() if line in changed))
            if set(order) == set(changed):
                return order, "commit_sequence"
        break
    return sorted(changed), "alphabetical_assumption"


def tasks_by_repo():
    families = defaultdict(list)
    for run, status, _ in inventory():
        issue = status.get("issue")
        when = assignment_time(run)
        if isinstance(issue, int) and issue > 0 and when and when <= SOURCE_CUTOFF:
            families[(status["repo"], issue)].append((run, status))
    groups = defaultdict(list)
    skipped = Counter()
    for (repo, issue), attempts in sorted(families.items()):
        attempts.sort(key=lambda item: assignment_time(item[0]))
        run, status = attempts[0]
        base = status.get("base_sha") or status.get("base")
        candidate = status.get("candidate_sha") or status.get("validated_sha") or status.get("commit_sha")
        changed = changed_paths(repo, base, candidate, run)
        if changed is None:
            skipped["undiffable_first_attempt"] += 1
            continue
        if not changed:
            skipped["empty_diff"] += 1
            continue
        declared = declared_files(run)
        if not declared:
            skipped["empty_declaration"] += 1
            continue
        if not set(changed).issubset(declared):
            skipped["diff_outside_declared"] += 1
            continue
        order, source = touch_order(repo, run, base, candidate, changed)
        groups[repo].append({
            "issue": issue, "when": assignment_time(run), "declared": declared,
            "order": order, "source": source,
        })
    for repo in groups:
        groups[repo].sort(key=lambda task: (task["when"], task["issue"]))
        groups[repo] = groups[repo][:CAP_PER_REPO]
    provenance = Counter(task["source"] for tasks in groups.values() for task in tasks)
    return groups, skipped, provenance


def cycle_nodes(blocked):
    """Find one wait-for cycle; each waiting task can have several holders."""
    visiting = []
    done = set()

    def visit(node):
        if node in visiting:
            return visiting[visiting.index(node):]
        if node in done:
            return None
        visiting.append(node)
        for holder in sorted(blocked.get(node, ())):
            result = visit(holder)
            if result:
                return result
        visiting.pop()
        done.add(node)
        return None

    for node in sorted(blocked):
        result = visit(node)
        if result:
            return result
    return None


def run_window(tasks, policy):
    n = len(tasks)
    if policy == "none":
        conflicts = sum(
            bool(set(tasks[i]["order"]) & set(tasks[j]["order"]))
            for i in range(n) for j in range(i + 1, n)
        )
        return Counter({"makespan": max(len(t["order"]) for t in tasks) + 2 * conflicts,
                        "repair_events": conflicts, "repair_units": 2 * conflicts,
                        "file_work": sum(len(t["order"]) for t in tasks)})
    step = [0] * n
    held = [set() for _ in tasks]
    finished = set()
    cooldown = [0] * n
    metrics = Counter()
    denied_before = set()
    for tick in range(10000):
        owners = {path: i for i in range(n) for path in held[i]}
        blocked = defaultdict(set)
        for i, task in enumerate(tasks):
            if i in finished or cooldown[i]:
                cooldown[i] = max(0, cooldown[i] - 1)
                continue
            needed = task["declared"] if policy == "all" else {task["order"][step[i]]}
            missing = needed - held[i]
            blockers = {owners[path] for path in missing if path in owners and owners[path] != i}
            if blockers:
                blocked[i].update(blockers)
                metrics["wait_agent_ticks"] += 1
                if i not in denied_before:
                    metrics["denials"] += 1
                    denied_before.add(i)
                continue
            held[i].update(missing)
            owners.update({path: i for path in missing})
            denied_before.discard(i)
            step[i] += 1
            metrics["file_work"] += 1
            if step[i] == len(task["order"]):
                finished.add(i)
                for path in held[i]:
                    owners.pop(path, None)
                held[i].clear()
        if len(finished) == n:
            metrics["makespan"] = tick + 1
            return metrics
        if policy == "grow":
            cycle = cycle_nodes(blocked)
            if cycle:
                victim = max(cycle)  # deterministic youngest arrival in this window
                metrics["deadlocks"] += 1
                metrics["restart_lost_file_work"] += step[victim]
                step[victim] = 0
                held[victim].clear()
                cooldown[victim] = 1
                denied_before.discard(victim)
    raise RuntimeError("simulation did not converge within 10,000 ticks")


def main():
    groups, skipped, provenance = tasks_by_repo()
    lines = [
        "Blind footprint growth scenario; local source snapshot 2026-10-15",
        "All numbers below are simulated counts in arbitrary file-touch units, not observed seconds.",
        "Input: first issue-linked launcher attempt per repository/issue family, with diffable base and candidate, nonempty diff and declared set; up to 40 chronological tasks per repository.",
        "Order source: separate commits in base..candidate if more than one; otherwise alphabetical changed-file order (assumption). Sensitivity reverses assumed order for every second task in a window.",
        "Arrival: tasks start together in chronological, nonoverlapping windows of N from one repository; agent IDs define deterministic claim tie order.",
        "One file first touch costs one unit. File leases remain held until task completion. All-up-front atomically requests its complete Allowed-file set.",
        "Grow requests the next changed file just before its first touch and retains prior claims. This trace gives perfect discovery of required files; real discovery is uncertain.",
        "A denied request counts once per uninterrupted wait; each waiting agent-tick adds one wait unit. On a grow wait cycle, the youngest task releases all claims, loses completed file work, and restarts after one tick.",
        "No declaration has zero lease wait/denial/deadlock by definition. Every overlapping actual-file pair in a concurrent window incurs an assumed two-unit repair cost, added to makespan; this is an estimate, not observed repair.",
        "Every policy uses the same task windows; no publish/review, renewal, expiry, merge, symbol claims, staggered arrivals, or agent adaptation is modeled.",
        f"Frozen source cutoff: {SOURCE_CUTOFF.isoformat()}. Input tasks: {sum(len(v) for v in groups.values())} in {len(groups)} repositories; selected order provenance: {json.dumps(provenance, sort_keys=True)}; skips: {json.dumps(skipped, sort_keys=True)}.",
        "",
    ]
    for n in (2, 5, 10):
        windows = [(repo, tasks[start:start + n]) for repo, tasks in sorted(groups.items())
                   for start in range(0, len(tasks) - n + 1, n)]
        lines.append(f"Concurrency: {n} agents; {len(windows)} windows; {sum(len(w) for _, w in windows)} task placements")
        for order_mode in ("alphabetical", "alternating_reverse"):
            lines.append(f"  Order scenario: {order_mode}")
            scenario = []
            for _, window in windows:
                copy = []
                for index, task in enumerate(window):
                    item = dict(task)
                    if order_mode == "alternating_reverse" and index % 2 and task["source"] != "commit_sequence":
                        item["order"] = list(reversed(item["order"]))
                    copy.append(item)
                scenario.append(copy)
            for policy in ("all", "grow", "none"):
                total = Counter()
                for window in scenario:
                    total.update(run_window(window, policy))
                lines.append(f"    {policy}: " + ", ".join(f"{key}={total[key]}" for key in
                             ("makespan", "file_work", "wait_agent_ticks", "denials", "deadlocks",
                              "restart_lost_file_work", "repair_events", "repair_units")))
        lines.append("")
    OUTPUT.write_text("\n".join(lines) + "\n")
    print(OUTPUT.read_text(), end="")


if __name__ == "__main__":
    main()
