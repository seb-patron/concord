"""Read local run history and reproduce the C1 waiting-versus-repair model.

Only output.txt and breakeven.csv are written. No network, Git mutation, or
third-party packages are used. Run with PYTHONDONTWRITEBYTECODE=1.
"""

from __future__ import annotations

import csv
import json
import re
import statistics
from collections import Counter
from datetime import datetime, timezone
from math import sqrt
from pathlib import Path


HISTORY = Path("/Users/sebastianpatronsoto/agent-runs/")
OUT = Path("spikes/v3/c1")
CUTOFF = datetime(2026, 10, 16, tzinfo=timezone.utc)
# SP-F5, 2026-10-15: overlapping merged-PR pairs, file-blocked pairs,
# textual-conflict pairs. They are not task-arrival or claim-wait rates.
REPLAY = {
    "concord": (104, 18, 0),
    "agent-workflows": (300, 118, 0),
    "gen-v-research-tools": (300, 61, 40),
    "mwcc-rs": (300, 19, 0),
    "gen-v-decomp": (300, 25, 0),
}
# S5 2026-10-15, status-state counts. Scope refusal is distinct from a
# lease refusal; the denominator includes undiffable and failed runs.
SCOPE = {
    "concord": (1209, 6),
    "agent-workflows": (989, 10),
    "gen-v-research-tools": (597, 17),
    "mwcc-rs": (1900, 742),
    "gen-v-decomp": (3456, 518),
}
REPAIR_WORDS = re.compile(r"\b(repair|rebase|address review|review fix|fix review|retry)\b", re.I)


def parse_time(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int((len(ordered) - 1) * fraction))]


def wilson_upper(successes: int, trials: int) -> float:
    if not trials:
        return 1.0
    z = 1.96
    point = successes / trials
    denominator = 1 + z * z / trials
    center = point + z * z / (2 * trials)
    radius = z * sqrt(point * (1 - point) / trials + z * z / (4 * trials * trials))
    return min(1.0, (center + radius) / denominator)


def fmt(value: float | None, digits: int = 1) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def read_json(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def collect(repo: str) -> dict:
    result: dict = {
        "runs": 0, "state": Counter(), "days": Counter(), "dur": [],
        "repair_dur": [], "repair_runs": 0, "retry_of": 0,
        "input": [], "cached": [], "output": [], "dollars": [],
        "held": [], "usage_files": 0, "bad": 0,
    }
    # Direct children only: avoids nested test fixtures, archived copies and
    # other repositories. This is a bounded, explicit sample of five repos.
    for path in sorted(HISTORY.glob(f"{repo}-*/*/status.json")):
        status = read_json(path)
        if not status or status.get("repo") != f"seb-patron/{repo}":
            result["bad"] += 1
            continue
        name = path.parent.name
        stamp = re.search(r"(20\d{6})T\d{6}Z", name)
        if not stamp or stamp.group(1) >= "20261016":
            continue
        result["runs"] += 1
        result["days"][stamp.group(1)] += 1
        result["state"][status.get("state", "unknown")] += 1
        held = status.get("launch_held_seconds")
        if isinstance(held, (int, float)) and held >= 0:
            result["held"].append(held / 60)
        if status.get("retry_of"):
            result["retry_of"] += 1
        label = " ".join(str(status.get(k) or "") for k in ("work_label", "kind"))
        repair = bool(status.get("target_pr_url") or REPAIR_WORDS.search(label))
        if repair:
            result["repair_runs"] += 1
        usage = read_json(path.parent / "usage.json")
        if not usage:
            continue
        start, end = parse_time(usage.get("started_at")), parse_time(usage.get("ended_at"))
        if start and end and start < CUTOFF and 0 <= (end - start).total_seconds() <= 86400:
            minutes = (end - start).total_seconds() / 60
            result["dur"].append(minutes)
            if repair:
                result["repair_dur"].append(minutes)
        if usage.get("usage_status") != "complete":
            continue
        tokens = usage.get("usage") or {}
        if not isinstance(tokens, dict):
            continue
        if isinstance(tokens.get("input_tokens"), (int, float)) and isinstance(tokens.get("output_tokens"), (int, float)):
            result["usage_files"] += 1
            for key, field in (("input", "input_tokens"), ("cached", "cached_input_tokens"), ("output", "output_tokens")):
                val = tokens.get(field)
                if isinstance(val, (int, float)) and val >= 0:
                    result[key].append(val)
        cost = usage.get("provider_cost")
        if isinstance(cost, (int, float)) and cost >= 0:
            result["dollars"].append(cost)
    return result


def model(p: float, wait: float, conflict: float, repair: float, failure: float, base: float) -> tuple[float, float, float]:
    """Minutes per dispatched task; failure incurs a fresh base run.

    p is the probability that a task meets overlapping work; conflict is
    conditional on that overlap. Repair includes the attempted fix. Assumes
    one overlapping predecessor and at most one failed repair/restart.
    """
    exclusive = base + p * wait
    optimistic = base + p * conflict * (repair + failure * base)
    return exclusive, optimistic, exclusive - optimistic


def main() -> None:
    rows = []
    lines = [
        "C1 cost model — local evidence cutoff 2026-10-15 UTC",
        "Command: PYTHONDONTWRITEBYTECODE=1 python3 spikes/v3/c1/cost_model.py",
        "Inputs: direct-child status.json and usage.json in five local agent-runs repo directories; S5 and SP-F5 constants cited in script.",
        "Formula minutes/task: exclusive=B+p*W; optimistic=B+p*c*(R+f*B); positive exclusive-optimistic favors optimistic.",
        "p=task overlap probability (scenario); W=wait minutes if overlapped; c=textual conflict conditional on file-blocked sampled PR pair (proxy); R=repair minutes (repair-labeled run median proxy); f=repair failure probability (scenario); B=all worker-session median minutes.",
        "Assumptions: one predecessor, one repair, failed repair requires one fresh base run; equal queue/check costs; agent-active capacity, no alternate useful task while waiting; no human or compute price assigned.",
        "Neither the PR replay nor S5 measured p, W, R for actual conflicts, f, or changes in accepted land quality. Zero conflicts is a point estimate, not proof of zero risk.",
        "SP-F5 pairwise serial delay is PR-open-to-merge accounting, not claim wait; excluded from W.",
        "S5 printed 3,592,610 interval pairs, while its prose says 3,800,963; denominators and undiffable endpoints differ. Neither supplies p.",
        "",
    ]
    header = ["repository", "sample_pairs", "file_blocked_pairs", "textual_conflicts", "conflict_case", "conditional_conflict_proxy", "task_overlap_scenario", "wait_min_scenario", "repair_min_proxy", "failure_scenario", "base_min_median", "exclusive_min_task", "optimistic_min_task", "gain_min_task", "gain_tasks_per_agent_hour", "breakeven_wait_min"]
    for repo, (pairs, blocked, conflicts) in REPLAY.items():
        d = collect(repo)
        base = median(d["dur"])
        repair_measured = median(d["repair_dur"])
        # If no labeled repair session has a duration, a stated 15-minute
        # illustrative assumption is used; it is never called measured.
        repair = repair_measured if repair_measured is not None else 15.0
        b = base if base is not None else 30.0
        c = conflicts / blocked if blocked else 0.0
        upper = wilson_upper(conflicts, blocked)
        days = ", ".join(f"{day}:{n}" for day, n in sorted(d["days"].items()))
        day_count = (datetime.strptime(max(d["days"]), "%Y%m%d") - datetime.strptime(min(d["days"]), "%Y%m%d")).days + 1 if d["days"] else 0
        lines += [
            f"[{repo}]",
            f"direct-child runs={d['runs']}; excluded wrong/malformed status={d['bad']}; calendar days first-to-last={day_count} mean runs/day={fmt(d['runs']/day_count if day_count else None)}; run days={days}",
            f"states={dict(d['state'].most_common())}",
            f"session duration (usage timestamps) n={len(d['dur'])} median_min={fmt(base)} p90_min={fmt(percentile(d['dur'],.90))}; repair-labeled runs={d['repair_runs']} duration_n={len(d['repair_dur'])} median_min={fmt(repair_measured)} p90_min={fmt(percentile(d['repair_dur'],.90))}; retry_of={d['retry_of']}",
            f"complete usage files={d['usage_files']}; median input_tokens={fmt(median(d['input']),0)} cached_input_tokens={fmt(median(d['cached']),0)} output_tokens={fmt(median(d['output']),0)}; provider dollar n={len(d['dollars'])} median={fmt(median(d['dollars']),4)}",
            f"launcher held n={len(d['held'])} median_min={fmt(median(d['held']))} (dispatch delay, not lease wait); S5 scope-refusal status={SCOPE[repo][1]}/{SCOPE[repo][0]} (not lease refusal)",
            f"SP-F5 sampled PR pairs={pairs}, file-blocked={blocked}, textual conflicts={conflicts}; c proxy={c:.3f}, naive Wilson upper95={upper:.3f}; repair R for CSV={repair:.1f} ({'measured label proxy' if repair_measured is not None else 'illustrative fallback'}), B={b:.1f}",
            "",
        ]
        for label, risk in (("point", c), ("upper95_naive", upper)):
            for p in (0.05, 0.20, 0.50):
                for wait in (5, 15, 30, 60):
                    for failure in (0, 0.10, 0.25):
                        exclusive, optimistic, gain = model(p, wait, risk, repair, failure, b)
                        # throughput of one continuously occupied agent, not
                        # cluster throughput or accepted-land throughput.
                        throughput_gain = 60 / optimistic - 60 / exclusive
                        rows.append([repo, pairs, blocked, conflicts, label, f"{risk:.6f}", p, wait, f"{repair:.3f}", failure, f"{b:.3f}", f"{exclusive:.3f}", f"{optimistic:.3f}", f"{gain:.3f}", f"{throughput_gain:.5f}", f"{risk * (repair + failure * b):.3f}"])
    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / "breakeven.csv").open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(header)
        writer.writerows(rows)
    lines.append(f"CSV rows={len(rows)}; p/W/f are explicit sensitivity scenarios, not estimated live rates.")
    (OUT / "output.txt").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
