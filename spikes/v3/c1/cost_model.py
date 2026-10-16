"""Read local run history and reproduce the claim waiting versus repair model.

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
# Merged pull-request conflict replay: pairs, file-blocked pairs,
# textual-conflict pairs. They are not task-arrival or claim-wait rates.
REPLAY = {
    "concord": (104, 18, 0),
    "agent-workflows": (300, 118, 0),
    "gen-v-research-tools": (300, 61, 40),
    "mwcc-rs": (300, 19, 0),
    "gen-v-decomp": (300, 25, 0),
}
# Declared-footprint study, status-state counts. Scope refusal is distinct from a
# lease refusal; the denominator includes undiffable and failed runs.
SCOPE = {
    "concord": (1209, 6),
    "agent-workflows": (989, 10),
    "gen-v-research-tools": (597, 17),
    "mwcc-rs": (1900, 742),
    "gen-v-decomp": (3456, 518),
}
# Approximate changed-file/declared-file encounter ratios from the footprint
# study's interval pairs. Different missingness prevents treating them as rates.
FOOTPRINT_RATIO = {
    "concord": 536 / 3410, "agent-workflows": 14761 / 51766,
    "gen-v-research-tools": 23074 / 72710, "mwcc-rs": 6629 / 139896,
    "gen-v-decomp": 18791 / 609875,
}
REPAIR_WORDS = re.compile(r"\b(repair|rebase|address[ -]review|review[ -]fix(?:es)?|fix[ -]review|retry)\b", re.I)
REBASE_WORD = re.compile(r"\b(rebase|merge[ -]conflict|conflict)\b", re.I)
REVIEW_FIX_WORDS = re.compile(r"\b(address[ -]review|review[ -]fix(?:es)?|fix[ -]review)\b", re.I)


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
        "repair_kind": Counter(), "rebase_dur": [], "no_usage": 0,
        "input": [], "cached": [], "output": [], "dollars": [],
        "held": [], "usage_files": 0, "tariff_null": 0, "bad": 0,
    }
    # Both current repo-hash/run and older repo/run layouts; no recursive scan.
    paths = set(HISTORY.glob(f"{repo}-*/*/status.json"))
    paths.update(HISTORY.glob(f"{repo}/*/status.json"))
    for path in sorted(paths):
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
        # A read-only review of a rebase is not a repair session.
        review_only = re.match(r"\s*review\b", str(status.get("work_label") or ""), re.I)
        repair = not review_only and bool(status.get("target_pr_url") or REPAIR_WORDS.search(label))
        if repair:
            result["repair_runs"] += 1
            kind = ("rebase/conflict" if REBASE_WORD.search(label) else
                    "review fix" if REVIEW_FIX_WORDS.search(label) else
                    "retry" if re.search(r"\bretry\b", label, re.I) else "other/target pull request")
            result["repair_kind"][kind] += 1
        usage = read_json(path.parent / "usage.json")
        if not usage:
            result["no_usage"] += 1
            continue
        if usage.get("tariff") is None:
            result["tariff_null"] += 1
        start, end = parse_time(usage.get("started_at")), parse_time(usage.get("ended_at"))
        if start and end and start < CUTOFF and 0 <= (end - start).total_seconds() <= 86400:
            minutes = (end - start).total_seconds() / 60
            result["dur"].append(minutes)
            if repair:
                result["repair_dur"].append(minutes)
                if kind == "rebase/conflict":
                    result["rebase_dur"].append(minutes)
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
        elif isinstance(cost, dict) and cost.get("unit") == "USD" and isinstance(cost.get("value"), (int, float)) and cost["value"] >= 0:
            result["dollars"].append(cost["value"])
    return result


def model(p_claim: float, p_change: float, wait: float, conflict: float,
          repair: float, failure: float, base: float,
          exclusive_repair: float = 0.0) -> tuple[float, float, float]:
    """Idealized agent minutes per dispatch; exclusive_repair is per task.

    p_claim and p_change are distinct scenario probabilities. Neither the
    footprint pair ratios nor the merged-PR conflict fraction calibrate them.
    """
    exclusive = base + p_claim * wait + exclusive_repair
    optimistic = base + p_change * conflict * (repair + failure * base)
    return exclusive, optimistic, exclusive - optimistic


def main() -> None:
    rows = []
    lines = [
        "Claim cost model — local evidence cutoff 2026-10-15 UTC",
        "Command: PYTHONDONTWRITEBYTECODE=1 python3 spikes/v3/c1/cost_model.py",
        "Inputs: direct-child run records in five repositories, the declared-footprint study, and the merged-pull-request conflict replay.",
        "Idealized minutes/dispatch: exclusive=B+p_claim*W+A_exclusive; parallel=B+p_change*c*(R+f*B). A_exclusive is residual post-publication repair per task.",
        "p_claim and p_change are separate task encounter rates; W is unproductive claim wait; c is replay textual-conflict fraction among file-blocked pairs (proxy); R is mixed repair-label duration (proxy); f is unmeasured repair-failure chance; B is mixed-session median (proxy).",
        "Assumptions: one predecessor, one repair and at most one failed-repair restart; equal queue/check costs; no alternate useful task during wait; no human/compute prices. Zero A_exclusive is an idealization, not current-policy evidence.",
        "Neither study measured task encounter rates, claim wait, actual conflict repair, repair failure, or accepted land quality. A zero conflict count is not zero risk.",
        "The replay's pairwise serial delay is from the later request's creation to the earlier request's merge, not their intersection or agent wait.",
        "The footprint study printed 3,592,610 interval pairs while its prose says 3,800,963; changed-path coverage differs from declared-path coverage. Its ratio is sensitivity only.",
        "A negative break-even wait in the CSV means parallel work wins in that scenario even with zero claim waiting; it is not a negative observed wait.",
        "",
    ]
    header = ["repository", "sample_pairs", "file_blocked_pairs", "textual_conflicts", "conflict_case", "conditional_conflict_proxy", "claim_encounter_scenario", "changed_encounter_scenario", "changed_to_claim_ratio_case", "wait_min_scenario", "repair_min_proxy", "failure_scenario", "base_min_proxy", "exclusive_residual_repair_min_task_scenario", "exclusive_min_task", "parallel_min_task", "gain_min_task", "relative_throughput_gain_pct_proxy", "breakeven_wait_min"]
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
            f"direct-child runs={d['runs']}; missing usage.json={d['no_usage']}; excluded wrong/malformed status={d['bad']}; calendar days first-to-last={day_count} mean runs/day={fmt(d['runs']/day_count if day_count else None)}; run days={days}",
            f"states={dict(d['state'].most_common())}",
            f"mixed-session duration n={len(d['dur'])} median_min={fmt(base)} p90_min={fmt(percentile(d['dur'],.90))}; repair-labeled runs={d['repair_runs']} duration_n={len(d['repair_dur'])} median_min={fmt(repair_measured)} p90_min={fmt(percentile(d['repair_dur'],.90))}; retry links={d['retry_of']}",
            f"repair labels by category={dict(d['repair_kind'])}; rebase/conflict timed n={len(d['rebase_dur'])} median_min={fmt(median(d['rebase_dur']))}; review-starting labels excluded",
            f"complete usage files={d['usage_files']}; median input_tokens={fmt(median(d['input']),0)} cached_input_tokens={fmt(median(d['cached']),0)} output_tokens={fmt(median(d['output']),0)}; provider dollar n={len(d['dollars'])} median={fmt(median(d['dollars']),4)}; null tariff files={d['tariff_null']}",
            f"dispatcher hold n={len(d['held'])} median_min={fmt(median(d['held']))} (not claim wait); declared-footprint study scope-refusal status={SCOPE[repo][1]}/{SCOPE[repo][0]} (not lease refusal)",
            f"merged-pull-request replay pairs={pairs}, file-blocked={blocked}, textual conflicts={conflicts}; conflict proxy={c:.3f}, naive Wilson upper95 sensitivity={upper:.3f}; R proxy={repair:.1f}, B proxy={b:.1f}; footprint changed/declared ratio proxy={FOOTPRINT_RATIO[repo]:.3f}",
            "",
        ]
        conflict_cases = [("point", c), ("upper95_naive", upper)]
        if repo == "gen-v-research-tools":
            # Replay's allowlisted union merge leaves eight textual conflicts;
            # merged-tree validity and actual repair savings were not tested.
            conflict_cases.append(("union_logs_point_proxy", 8 / blocked))
        for label, risk in conflict_cases:
            for ratio_label, ratio in (("equal_rates", 1.0), ("footprint_ratio_proxy", FOOTPRINT_RATIO[repo])):
                for p_claim in (0.05, 0.20, 0.50):
                    p_change = p_claim * ratio
                    for wait in (5, 15, 30, 60):
                        for failure in (0, 0.10, 0.25):
                            for residual in (0.0, 1.0):
                                exclusive, optimistic, gain = model(p_claim, p_change, wait, risk, repair, failure, b, residual)
                                # Relative throughput for one continuously occupied agent.
                                throughput_gain_pct = 100 * (exclusive / optimistic - 1)
                                breakeven = (p_change * risk * (repair + failure * b) - residual) / p_claim
                                rows.append([repo, pairs, blocked, conflicts, label, f"{risk:.6f}", p_claim, f"{p_change:.6f}", ratio_label, wait, f"{repair:.3f}", failure, f"{b:.3f}", residual, f"{exclusive:.3f}", f"{optimistic:.3f}", f"{gain:.1f}", f"{throughput_gain_pct:.1f}", f"{breakeven:.1f}"])
    with (OUT / "breakeven.csv").open("w", newline="") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)
    lines.append(f"CSV rows={len(rows)}; encounter rates, wait, failure and residual repair are sensitivity scenarios, not live estimates. Relative throughput is illustrative agent-active throughput, not accepted landings.")
    (OUT / "output.txt").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
