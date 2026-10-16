#!/usr/bin/env python3
"""Read-only audit of launcher file declarations and observable scope growth.

Run from the Concord checkout with PYTHONDONTWRITEBYTECODE=1. The only write is
the aggregate output file. No source-run path or report excerpt is emitted.
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import os
from pathlib import Path
import random
import re
import subprocess

ROOT = Path('/Users/sebastianpatronsoto/agent-runs')
OUTPUT = Path('spikes/v3/round2/c5/output.txt')
SEED = 20261016
SKIP_DIRS = {'clones', 'worktree', '.git', 'node_modules', 'scratch', 'tmp', '.venv'}
DONE_STATES = {'pr-opened', 'no-push', 'pushed'}
SCOPE_LINE = re.compile(r"^scope check: unmatched:\s*['\"](.+?)['\"]\s*$", re.M)
SCOPE_DIRECT = re.compile(r"^scope check: ['\"](.+?)['\"] is not in Allowed files(?:\s|$)", re.M)
BLOCKED_SECTION = re.compile(r'^Blocked:\s*\n(.*?)(?=^[A-Z][A-Za-z ]+:\s*$|\Z)', re.M | re.S)
NEED_WORDS = re.compile(r'\b(?:need|needs|needed|require|requires|required|must|cannot|can.t|impossible|blocked)\b', re.I)
ALLOW_WORDS = re.compile(r'\b(?:not (?:in|on|among) .{0,30}allowed|outside .{0,40}allowed|not allowed|out.of.scope|scope .{0,50}(?:grow|expand|widen)|add .{0,100} to .{0,30}allowed|authoriz(?:e|ation) .{0,100}(?:file|\.py|\.ts|\.rs|\.sh)|allowed to touch|may not touch)\b', re.I)
FILE_CUE = re.compile(r'\bfiles?\b|[\w.-]+/[\w./-]+\.(?:py|ts|tsx|js|rs|md|json|toml|yaml|yml|sh|txt|tsv|swift|c|h|cpp|hpp|html|css|sql|age)\b', re.I)
PATH_IN_REPORT = re.compile(r'(?<![\w.-])(?:[\w.-]+/)*[\w.-]+\.(?:py|ts|tsx|js|rs|md|json|toml|yaml|yml|sh|txt|tsv|swift|c|h|cpp|hpp|html|css|sql|age)\b', re.I)


def read(path: Path, limit: int = 500_000) -> str:
    try:
        with path.open('r', errors='replace') as f:
            return f.read(limit)
    except (OSError, UnicodeError):
        return ''


def read_tail(path: Path, limit: int = 500_000) -> str:
    try:
        with path.open('rb') as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell()-limit))
            return f.read().decode('utf-8', 'replace')
    except OSError:
        return ''


def status(path: Path) -> dict:
    try:
        value = json.loads(read(path))
        return value if isinstance(value, dict) else {}
    except (ValueError, OSError):
        return {}


def normalized_allowed(raw: str) -> set[str]:
    return {s for line in raw.splitlines() if (s := line.strip()) and not s.startswith('#')
            and s != '(none; review only)'}


def run_dirs():
    for directory, children, files in os.walk(ROOT):
        children[:] = [c for c in children if c not in SKIP_DIRS and not c.startswith('.git')]
        if 'allowed-files.txt' in files and ('work-spec.md' in files or 'prompt.md' in files):
            yield Path(directory)


def git_paths(base: str, head: str, places: list[Path]) -> set[str] | None:
    if not (re.fullmatch('[0-9a-f]{40}', str(base)) and re.fullmatch('[0-9a-f]{40}', str(head))):
        return None
    for place in places:
        if not place.exists():
            continue
        try:
            p = subprocess.run(['git', '-C', str(place), 'diff', '--name-only', '-z', base, head],
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=8, check=True)
            return {x.decode('utf-8', 'replace') for x in p.stdout.split(b'\0') if x}
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def gh_paths(url: str) -> set[str] | None:
    if not re.fullmatch(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/\d+', url):
        return None
    try:
        p = subprocess.run(['gh', 'pr', 'diff', url, '--name-only'], stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=20, check=True)
        return set(p.stdout.decode('utf-8', 'replace').splitlines())
    except (OSError, subprocess.SubprocessError):
        return None


def wilson(k: int, n: int) -> str:
    if n < 10:
        return 'n<10'
    z = 1.9599639845
    p = k / n
    den = 1 + z*z/n
    mid = (p + z*z/(2*n))/den
    radius = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))/den
    return f'{100*(mid-radius):.1f}..{100*(mid+radius):.1f}%'


def share(k: int, n: int) -> str:
    return f'{100*k/n:.1f}%' if n else 'n/a'


def blocked_rule(report: str) -> bool:
    """Flag explicit needed-file/allowed-scope conflict in the Blocked section.

    A narrow two-cue rule reduces false positives from boilerplate about allowed
    files in every prompt. It intentionally misses reports with no Blocked section.
    """
    m = BLOCKED_SECTION.search(report)
    passage = m.group(1) if m else ''
    return bool(NEED_WORDS.search(passage) and ALLOW_WORDS.search(passage) and FILE_CUE.search(passage))


def blocked_paths(report: str, allowed: set[str]) -> set[str]:
    m = BLOCKED_SECTION.search(report)
    return (set(PATH_IN_REPORT.findall(m.group(1))) - allowed) if m else set()


def kind_of(d: dict) -> str:
    if d.get('review_run') is True or str(d.get('launch_class', '')).lower() == 'review' or d.get('kind') == 'review':
        return 'review-only'
    if d.get('target_pr_url') or d.get('publish_target') in {'existing-pr', 'repair'}:
        return 'repair'
    return 'first run'


def table(rows: list[dict], field: str, label: str) -> list[str]:
    grouped = collections.defaultdict(list)
    for r in rows:
        grouped[r[field]].append(r)
    lines = [f'[{label}]', 'group\truns\tfirst\trepair\treview\tcompleted\trefused_file\tblocked_file\tvisible_need\tneed_share\t95%_Wilson\tknown_extra_files\tdeclared_completed_diffable\tunused_declared\tunused_share\t95%_Wilson\tlinked_repairs\tgrowing_repairs\tgrowth_share\t95%_Wilson\tadded_entries']
    for key, group in sorted(grouped.items(), key=lambda kv: str(kv[0])):
        predictions = [r for r in group if r['kind'] != 'review-only']
        need = sum(r['needed'] for r in predictions)
        scored = [r for r in group if r['completed'] and r['changed'] is not None and r['kind'] != 'review-only']
        declared = sum(len(r['allowed']) for r in scored)
        unused = sum(len(r['allowed'] - r['changed']) for r in scored)
        linked = [r for r in group if r['growth_known']]
        growing = sum(r['growth_extra'] > 0 for r in linked)
        lines.append('\t'.join(map(str, [key, len(group), sum(r['kind']=='first run' for r in group),
            sum(r['kind']=='repair' for r in group), sum(r['kind']=='review-only' for r in group),
            sum(r['completed'] for r in group), sum(r['refused'] for r in group),
            sum(r['blocked_file'] for r in group), need, share(need,len(predictions)),
            wilson(need,len(predictions)), sum(r['extra_files'] for r in group),
            declared, unused, share(unused,declared), wilson(unused,declared),
            len(linked), growing, share(growing,len(linked)), wilson(growing,len(linked)),
            sum(r['growth_extra'] for r in linked)])))
    return lines + ['']


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--gh', action='store_true', help='read-only PR diff fallback for missing local commits')
    args = ap.parse_args()
    rows = []
    duplicates = 0
    seen = set()
    for directory in run_dirs():
        d = status(directory/'status.json')
        identity = d.get('run_dir') or str(directory)
        if identity in seen:
            duplicates += 1
            continue
        seen.add(identity)
        allowed = normalized_allowed(read(directory/'allowed-files.txt'))
        repo = str(d.get('repo') or 'unknown')
        repo_name = repo.split('/')[-1]
        agent = str(d.get('agent') or 'unknown')
        model = str(d.get('served_model') or d.get('muse_observed_model') or d.get('requested_model') or 'unknown')
        state = str(d.get('state') or 'missing-status')
        kind = kind_of(d)
        report = read(directory/'agent-report.txt')
        log = read_tail(directory/'run.log')
        unmatched = (set(SCOPE_LINE.findall(log)) | set(SCOPE_DIRECT.findall(log))) - allowed
        # A scope state by itself is insufficient: missing/extra commits also produce it.
        refused = state.replace('_','-') == 'refused-scope' and bool(unmatched)
        blocked_file = state == 'blocked' and blocked_rule(report)
        blocked_extras = blocked_paths(report, allowed) if blocked_file else set()
        changed = None
        if state in DONE_STATES and kind != 'review-only':
            places = [ROOT/'clones'/repo_name, directory/'worktree']
            changed = git_paths(str(d.get('base_sha') or d.get('base') or ''),
                                str(d.get('candidate_sha') or d.get('validated_sha') or d.get('commit_sha') or ''), places)
            if changed is None and args.gh:
                changed = gh_paths(str(d.get('pr_url') or d.get('target_pr_url') or ''))
        rows.append({'repo': repo_name, 'worker': f'{agent}/{model}', 'kind': kind, 'state': state,
                     'allowed': allowed, 'changed': changed, 'completed': state in DONE_STATES,
                     'refused': refused, 'blocked_file': blocked_file,
                     'needed': refused or blocked_file, 'extra_files': len(unmatched) if refused else len(blocked_extras),
                     'growth_known': False, 'growth_extra': 0,
                     'pr': str(d.get('target_pr_url') or d.get('pr_url') or ''),
                     'time': str(d.get('updated_at') or ''), 'report': report if state=='blocked' else ''})

    # Repair growth is measured against the earliest observed first-run declaration
    # on the same PR, not against a later repair's possibly enlarged list.
    families = collections.defaultdict(list)
    for r in rows:
        if r['pr'] and re.fullmatch(r'https://github\.com/[^/]+/[^/]+/pull/\d+', r['pr']):
            families[r['pr']].append(r)
    repair_families = 0; growth_families = 0; repair_runs = 0; growing_repairs = 0
    growth_sum = 0; growth_unique = 0; no_first = 0
    for group in families.values():
        firsts = sorted((r for r in group if r['kind']=='first run'), key=lambda r:r['time'])
        repairs = [r for r in group if r['kind']=='repair']
        if not repairs:
            continue
        if not firsts:
            no_first += 1
            continue
        repair_families += 1
        initial = firsts[0]['allowed']
        additions = set()
        for r in repairs:
            extra = r['allowed'] - initial
            r['growth_known'] = True
            r['growth_extra'] = len(extra)
            repair_runs += 1; growing_repairs += bool(extra)
            growth_sum += len(extra); additions |= extra
        growth_unique += len(additions)
        growth_families += bool(additions)

    blocked = [r for r in rows if r['state']=='blocked' and r['kind']!='review-only']
    sample = random.Random(SEED).sample(blocked, min(30,len(blocked)))
    # The sample records are deliberately not written: the report is checked
    # manually via a separate read-only inspection command, then counts are added.
    need_rows = [r for r in rows if r['needed']]
    extras = collections.Counter(('0 path visible' if r['extra_files']==0 else
                                  '1' if r['extra_files']==1 else
                                  '2' if r['extra_files']==2 else '3+') for r in need_rows)
    lines = ['# Spec prediction raw aggregate output',
             'command: PYTHONDONTWRITEBYTECODE=1 python3 spikes/v3/round2/c5/spec_prediction.py' + (' --gh' if args.gh else ''),
             'local read command: git -C <clone-or-worktree> diff --name-only -z <base> <candidate>',
             'optional read command: gh pr diff <pull-request-URL> --name-only',
             f'input root: agent-runs (read only); random seed: {SEED}',
             f'eligible_unique={len(rows)} duplicate_archives={duplicates}',
             f'implementation_runs={sum(r["kind"]!="review-only" for r in rows)} review_only_runs={sum(r["kind"]=="review-only" for r in rows)}',
             f'completed={sum(r["completed"] for r in rows)} completed_diffable={sum(r["completed"] and r["changed"] is not None for r in rows)}',
             f'refused_scope_state={sum(r["state"]=="refused-scope" for r in rows)} refused_with_unmatched_file={sum(r["refused"] for r in rows)}',
             f'blocked_implementation={len(blocked)} blocked_rule_positive={sum(r["blocked_file"] for r in blocked)}',
             f'sample_size={len(sample)} sample_rule_positive={sum(r["blocked_file"] for r in sample)}',
             f'visible_need_total={len(need_rows)} visible_extra_count_0_path={extras["0 path visible"]} visible_extra_count_1={extras["1"]} visible_extra_count_2={extras["2"]} visible_extra_count_3plus={extras["3+"]}',
             f'repair_families_with_first={repair_families} repair_families_without_first={no_first} growth_families={growth_families}',
             f'repair_runs_with_first={repair_runs} growing_repairs={growing_repairs} added_entries_across_repairs={growth_sum} unique_added_files_within_families={growth_unique}',
             '']
    lines.extend(table(rows, 'kind', 'overall_by_kind'))
    for field,label in [('repo','repository'),('worker','worker_agent_model'),('state','final_state')]:
        lines.extend(table(rows,field,label))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text('\n'.join(lines))
    print('\n'.join(lines[:10]))


if __name__ == '__main__':
    main()
