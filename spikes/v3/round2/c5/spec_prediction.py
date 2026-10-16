#!/usr/bin/env python3
"""Read-only audit of launcher file declarations and observable scope growth.

Run from the Concord checkout with PYTHONDONTWRITEBYTECODE=1. A fresh scan
writes a privacy-safe manifest and aggregate output. Replay uses that manifest.
"""

from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess

OUTPUT = Path('spikes/v3/round2/c5/output.txt')
MANIFEST = Path('spikes/v3/round2/c5/manifest.tsv')
SEED = 20261016
SKIP_DIRS = {'clones', 'worktree', '.git', 'node_modules', 'scratch', 'tmp', '.venv'}
DONE_STATES = {'pr-opened', 'no-push', 'pushed'}
SCOPE_LINE = re.compile(r"^scope check: unmatched:\s*['\"](.+?)['\"]\s*$", re.M)
SCOPE_DIRECT = re.compile(r"^scope check: ['\"](.+?)['\"] is not in Allowed files(?:\s|$)", re.M)
BLOCKED_SECTION = re.compile(r'^Blocked:\s*(.*?)(?=^[A-Z][A-Za-z ]+:\s*(?:\n|$)|\Z)', re.M | re.S)
NEED_WORDS = re.compile(r'\b(?:need|needs|needed|require|requires|required|must|cannot|can.t|impossible|blocked|please|request|allow|permit|grant)\b', re.I)
ALLOW_WORDS = re.compile(r'\b(?:not (?:in|on|among) .{0,30}allowed|outside .{0,40}allowed|not allowed|out.of.scope|allowed.files?.only|allowed.files? list.{0,40}(?:extend(?:ed)?|widen(?:ed)?|expand(?:ed)?)|scope .{0,50}(?:grow|expand|widen|extend)|add .{0,100} to .{0,30}allowed|(?:widen|extend|expand) .{0,40}(?:allowed|scope)|(?:allow|permit|authorize|authorise) .{0,50}(?:(?:additional|another|extra|new|more)\s+(?:file|path)|edits?|changes?|(?:an?\s+)?updates?|touch|remove|[\w./-]+\.(?:py|ts|rs|c|md|tsv))|allowed to touch|may not touch)\b', re.I)
FILE_CUE = re.compile(r'\bfiles?\b|[\w.-]+/[\w./-]+\.(?:py|ts|tsx|js|rs|md|json|toml|yaml|yml|sh|txt|tsv|swift|c|h|cpp|hpp|html|css|sql|age|conf)\b', re.I)
PATH_IN_REPORT = re.compile(r'(?<![\w.-])(?:[\w.-]+/)*[\w.-]+\.(?:py|ts|tsx|js|rs|md|json|toml|yaml|yml|sh|txt|tsv|swift|c|h|cpp|hpp|html|css|sql|age|conf)\b', re.I)


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


PATH_PART = re.compile(r'^[A-Za-z0-9._@+\-]+$')
EXTENSIONLESS = {'Makefile', 'Dockerfile', 'LICENSE', 'NOTICE', 'Procfile', 'Gemfile', 'Rakefile', 'BUILD', 'WORKSPACE'}


def valid_path(value: str) -> bool:
    """Accept one normalized repository file path; quarantine ambiguous records."""
    if not value or value.startswith(('/', './')) or '\\' in value or any(c.isspace() for c in value):
        return False
    parts = PurePosixPath(value).parts
    if not parts or any(p in {'.', '..'} or not PATH_PART.fullmatch(p) for p in parts):
        return False
    if str(PurePosixPath(value)) != value:
        return False
    name = parts[-1]
    return '.' in name or name in EXTENSIONLESS


def normalized_allowed(raw: str) -> tuple[set[str], list[str]]:
    valid, malformed = set(), []
    for line in raw.splitlines():
        value = line.strip()
        if not value or value.startswith('#') or value == '(none; review only)':
            continue
        if valid_path(value):
            valid.add(value)
        else:
            malformed.append(value)
    return valid, malformed


def run_dirs(root: Path):
    for directory, children, files in os.walk(root):
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


def share(k: int, n: int) -> str:
    return f'{100*k/n:.1f}%' if n else 'n/a'


def blocked_rule(report: str) -> bool:
    """Flag explicit needed-file/allowed-scope conflict in the Blocked section.

    A narrow two-cue rule reduces false positives from boilerplate about allowed
    files in every prompt. It intentionally misses reports with no Blocked section.
    """
    passage = blocked_body(report)
    if re.search(r'outside .{0,25}allowed commands', passage, re.I) and not re.search(r'allowed.files?|outside .{0,25}allowed (?:files?|tests?)', passage, re.I):
        return False
    return bool(NEED_WORDS.search(passage) and ALLOW_WORDS.search(passage) and FILE_CUE.search(passage))


def blocked_paths(report: str, allowed: set[str]) -> set[str]:
    return {p for p in PATH_IN_REPORT.findall(blocked_body(report)) if valid_path(p) and p not in allowed}


LEGACY_REVIEW = re.compile(r'(?:final|independent|read.only|review.only).{0,35}review|review.{0,35}(?:final|independent|read.only)', re.I | re.S)
NO_EDIT = re.compile(r'(?:do not|don.t|never|no)\s+(?:create[, ]+|make[, ]+|write[, ]+|run[, ]+|stage[, ]+|edit[, ]+|modify[, ]+|commit[, ]+|change[, ]+){0,4}(?:commits?|edits?|changes?|modify|touch|write|commit)', re.I)
FINAL_OUTCOME = re.compile(r'VERDICT|REQUEST CHANGES|APPROVE|final review', re.I)


def kind_of(d: dict, prompt: str) -> tuple[str, str]:
    if d.get('review_run') is True or str(d.get('launch_class', '')).lower() == 'review' or d.get('kind') == 'review':
        return 'review-only', 'metadata'
    intro = prompt[:1500]
    if LEGACY_REVIEW.search(intro) and NO_EDIT.search(intro) and FINAL_OUTCOME.search(intro):
        return 'review-only', 'legacy-text'
    if d.get('target_pr_url') or d.get('publish_target') in {'existing-pr', 'repair'}:
        return 'repair', 'target-pr'
    return 'first run', 'default'


def digest(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8', 'replace')).hexdigest()


def blocked_body(report: str) -> str:
    match = BLOCKED_SECTION.search(report)
    return match.group(1).strip() if match else ''


def table(rows: list[dict], field: str, label: str) -> list[str]:
    grouped = collections.defaultdict(list)
    for r in rows:
        grouped[r[field]].append(r)
    lines = [f'[{label}]', 'group\truns\tfirst\trepair\treview\tcompleted\tcompleted_diffable\tcompleted_undiffable\trefused_omitted\trefused_malformed_grant\tblocked_flag\tparser_flags\tflag_share\tdeclared_diffable\tunused_declared\tunused_share\tlinked_repairs\tgrowing_repairs\tgrowth_share\tadded_entries\tquarantined_declarations']
    for key, group in sorted(grouped.items(), key=lambda kv: str(kv[0])):
        predictions = [r for r in group if r['kind'] != 'review-only']
        need = sum(r['needed'] for r in predictions)
        scored = [r for r in group if r['completed'] and r['diffable'] and r['kind'] != 'review-only']
        declared = sum(r['declared_n'] for r in scored)
        unused = sum(r['unused_n'] for r in scored)
        linked = [r for r in group if r['growth_known']]
        growing = sum(r['growth_extra'] > 0 for r in linked)
        completed = sum(r['completed'] for r in group)
        diffable = sum(r['completed'] and r['diffable'] for r in group)
        lines.append('\t'.join(map(str, [key, len(group), sum(r['kind']=='first run' for r in group),
            sum(r['kind']=='repair' for r in group), sum(r['kind']=='review-only' for r in group),
            completed, diffable, completed-diffable,
            sum(r['refused'] for r in group), sum(r['malformed_refusal'] for r in group),
            sum(r['blocked_file'] for r in group), need, share(need,len(predictions)),
            declared, unused, share(unused,declared), len(linked), growing,
            share(growing,len(linked)), sum(r['growth_extra'] for r in linked),
            sum(r['malformed_n'] for r in group)])))
    return lines + ['']


def scan(root: Path) -> tuple[list[dict], int]:
    selected, seen, duplicates = [], set(), 0
    for directory in sorted(run_dirs(root)):
        raw_status = read(directory / 'status.json')
        d = status(directory / 'status.json')
        identity = str(d.get('run_dir') or directory.relative_to(root))
        if identity in seen:
            duplicates += 1
            continue
        seen.add(identity)
        raw_allowed = read(directory / 'allowed-files.txt')
        prompt = read(directory / 'work-spec.md') or read(directory / 'prompt.md')
        report = read(directory / 'agent-report.txt')
        log = read_tail(directory / 'run.log')
        allowed, malformed = normalized_allowed(raw_allowed)
        repo = str(d.get('repo') or 'unknown').split('/')[-1]
        agent = str(d.get('agent') or 'unknown')
        model = str(d.get('served_model') or d.get('muse_observed_model') or d.get('requested_model') or 'unknown')
        state = str(d.get('state') or 'missing-status').replace('_', '-')
        kind, provenance = kind_of(d, prompt)
        population = 'fixture-or-unknown' if repo in {'3', '4', 'repo', 'probe', 'unknown'} or agent == 'fake' or state == 'missing-status' else 'worker'
        run_id = digest(identity)[:24]
        fingerprints = [digest(x) for x in (raw_status, raw_allowed, prompt, report, log)]
        unmatched = set(SCOPE_LINE.findall(log)) | set(SCOPE_DIRECT.findall(log))
        malformed_tokens = {token.strip('`\'" ,') for entry in malformed for token in entry.split()}
        malformed_diagnostic = state == 'refused-scope' and any(p in malformed_tokens or not valid_path(p) for p in unmatched)
        omitted = {p for p in unmatched if valid_path(p) and p not in allowed and p not in malformed_tokens}
        mixed_refusal = malformed_diagnostic and bool(omitted)
        malformed_refusal = malformed_diagnostic and not mixed_refusal and kind != 'review-only'
        refused = state == 'refused-scope' and bool(omitted) and not mixed_refusal and kind != 'review-only'
        blocked_file = state == 'blocked' and kind != 'review-only' and blocked_rule(report)
        blocked_extras = blocked_paths(report, allowed) if blocked_file else set()
        changed = None
        if state in DONE_STATES and kind != 'review-only' and population == 'worker':
            changed = git_paths(str(d.get('base_sha') or d.get('base') or ''),
                                str(d.get('candidate_sha') or d.get('validated_sha') or d.get('commit_sha') or ''),
                                [root / 'clones' / repo, directory / 'worktree'])
        selected.append({'id': run_id, 'fingerprints': fingerprints, 'repo': repo,
                         'worker': f'{agent}/{model}', 'kind': kind, 'provenance': provenance,
                         'population': population, 'state': state, 'allowed': allowed,
                         'malformed': malformed, 'changed': changed,
                         'declared_n': len(allowed), 'malformed_n': len(malformed),
                         'unused_n': len(allowed - changed) if changed is not None else 0,
                         'diffable': changed is not None,
                         'completed': state in DONE_STATES and kind != 'review-only',
                         'refused': refused, 'malformed_refusal': malformed_refusal,
                         'mixed_refusal': mixed_refusal and kind != 'review-only',
                         'blocked_file': blocked_file, 'needed': refused or blocked_file,
                         'extra_files': len(omitted) if refused else len(blocked_extras),
                         'growth_known': False, 'growth_extra': 0,
                         'pr': str(d.get('target_pr_url') or d.get('pr_url') or ''),
                         'time': str(d.get('updated_at') or ''), 'report': report if state == 'blocked' else ''})
    return selected, duplicates


MANIFEST_HEADER = ['id', 'status_sha256', 'allowed_sha256', 'prompt_sha256', 'report_sha256',
                   'log_tail_sha256', 'population', 'kind', 'provenance', 'state', 'repo',
                   'worker', 'completed', 'diffable', 'valid_entries', 'unused_entries',
                   'quarantined_entries', 'refused_omitted', 'refused_malformed', 'refused_mixed',
                   'blocked_flag', 'parser_flag', 'extra_path_mentions', 'growth_known',
                   'growth_extra', 'manual_label']


def manifest_record(r: dict, label: str = '') -> str:
    values = [r['id'], *r['fingerprints'], r['population'], r['kind'], r['provenance'],
              r['state'], r['repo'], r['worker'], int(r['completed']), int(r['diffable']),
              r['declared_n'], r['unused_n'], r['malformed_n'], int(r['refused']),
              int(r['malformed_refusal']), int(r['mixed_refusal']), int(r['blocked_file']),
              int(r['needed']), r['extra_files'], int(r['growth_known']), r['growth_extra'], label]
    return '\t'.join(map(str, values))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--input-root', type=Path, required=True, help='read-only worker-run root')
    ap.add_argument('--refresh-manifest', action='store_true', help='freeze a fresh local scan')
    args = ap.parse_args()
    if args.refresh_manifest:
        if not args.input_root.is_dir():
            ap.error('input root must be a directory')
        old_labels = {}
        if MANIFEST.is_file():
            old_lines = MANIFEST.read_text().splitlines()
            old_labels = {p[0]: p[-1] for line in old_lines[2:] if (p := line.split('\t'))}
        scanned, duplicates = scan(args.input_root)
        rows = [r for r in scanned if r['population'] == 'worker']
        families = collections.defaultdict(list)
        for r in rows:
            if re.fullmatch(r'https://github\.com/[^/]+/[^/]+/pull/\d+', r['pr']):
                families[r['pr']].append(r)
        repair_families = growth_families = repair_runs = growing_repairs = 0
        growth_sum = growth_unique = no_first = 0
        for group in families.values():
            firsts = sorted((r for r in group if r['kind'] == 'first run'), key=lambda r: (r['time'], r['id']))
            repairs = [r for r in group if r['kind'] == 'repair']
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
                repair_runs += 1
                growing_repairs += bool(extra)
                growth_sum += len(extra)
                additions |= extra
            growth_unique += len(additions)
            growth_families += bool(additions)
        stats = [repair_families, no_first, growth_families, repair_runs,
                 growing_repairs, growth_sum, growth_unique]
        MANIFEST.write_text(f'# duplicate_archives={duplicates}\n# growth_stats=' +
                            ','.join(map(str, stats)) + '\n' + '\t'.join(MANIFEST_HEADER) + '\n' +
                            '\n'.join(manifest_record(r, old_labels.get(r['id'], '')) for r in scanned) + '\n')
    if not MANIFEST.is_file():
        ap.error('manifest missing; use --refresh-manifest for a fresh scan')
    manifest_text = MANIFEST.read_text()
    manifest_lines = manifest_text.splitlines()
    frozen_duplicates = int(manifest_lines[0].split('=', 1)[1])
    if manifest_lines[2].split('\t') != MANIFEST_HEADER:
        ap.error('manifest schema mismatch')
    repair_families, no_first, growth_families, repair_runs, growing_repairs, growth_sum, growth_unique = map(
        int, manifest_lines[1].split('=', 1)[1].split(','))
    frozen = {parts[0]: parts for line in manifest_lines[3:] if (parts := line.split('\t'))}
    rows = []
    for parts in frozen.values():
        r = dict(zip(MANIFEST_HEADER, parts))
        if r['population'] != 'worker':
            continue
        rows.append({'id': r['id'], 'repo': r['repo'], 'worker': r['worker'], 'kind': r['kind'],
                     'provenance': r['provenance'], 'state': r['state'],
                     'completed': bool(int(r['completed'])), 'diffable': bool(int(r['diffable'])),
                     'declared_n': int(r['valid_entries']), 'unused_n': int(r['unused_entries']),
                     'malformed_n': int(r['quarantined_entries']),
                     'refused': bool(int(r['refused_omitted'])),
                     'malformed_refusal': bool(int(r['refused_malformed'])),
                     'mixed_refusal': bool(int(r['refused_mixed'])),
                     'blocked_file': bool(int(r['blocked_flag'])),
                     'needed': bool(int(r['parser_flag'])), 'extra_files': int(r['extra_path_mentions']),
                     'growth_known': bool(int(r['growth_known'])), 'growth_extra': int(r['growth_extra'])})
    blocked = [r for r in rows if r['state'] == 'blocked' and r['kind'] != 'review-only']
    # Ranks 0..29 were used to refine the parser. Keep the next thirty held out.
    sample = sorted(blocked, key=lambda r: (digest(f'{SEED}:{r["id"]}'), r['id']))[30:60]
    labels = {run_id: parts[-1] for run_id, parts in frozen.items()}
    labeled = [r for r in sample if labels[r['id']] in {'0', '1'}]
    tp = sum(r['blocked_file'] and labels[r['id']] == '1' for r in labeled)
    tn = sum(not r['blocked_file'] and labels[r['id']] == '0' for r in labeled)
    fp = sum(r['blocked_file'] and labels[r['id']] == '0' for r in labeled)
    fn = sum(not r['blocked_file'] and labels[r['id']] == '1' for r in labeled)
    need_rows = [r for r in rows if r['needed'] and r['kind'] != 'review-only']
    extras = collections.Counter('0' if r['extra_files'] == 0 else '1' if r['extra_files'] == 1 else
                                 '2' if r['extra_files'] == 2 else '3+' for r in need_rows)
    lines = ['# Frozen spec prediction aggregate, counts and shares only',
             'command: PYTHONDONTWRITEBYTECODE=1 python3 spikes/v3/round2/c5/spec_prediction.py --input-root <local-run-root>',
             'fresh scan: same command with --refresh-manifest (changes the frozen population)',
             f'manifest_sha256={digest(manifest_text)} seed={SEED}',
             f'eligible_unique={len(frozen)} duplicate_archives={frozen_duplicates} excluded_fixture_unknown={len(frozen)-len(rows)}',
             f'worker_runs={len(rows)} implementation_runs={sum(r["kind"]!="review-only" for r in rows)} review_only_runs={sum(r["kind"]=="review-only" for r in rows)} legacy_reviews={sum(r["provenance"]=="legacy-text" for r in rows)}',
             f'completed={sum(r["completed"] for r in rows)} completed_diffable={sum(r["completed"] and r["diffable"] for r in rows)}',
             f'quarantined_declaration_entries={sum(r["malformed_n"] for r in rows)} runs_with_quarantine={sum(r["malformed_n"]>0 for r in rows)}',
             f'refused_scope_state={sum(r["state"]=="refused-scope" for r in rows)} refused_omitted_path={sum(r["refused"] for r in rows)} refused_malformed_grant={sum(r["malformed_refusal"] for r in rows)} refused_mixed={sum(r["mixed_refusal"] for r in rows)}',
             f'blocked_implementation={len(blocked)} blocked_rule_positive={sum(r["blocked_file"] for r in blocked)}',
             f'holdout_rank=30..59 sample_size={len(sample)} hand_labeled={len(labeled)} agreement={tp+tn} false_positive={fp} false_negative={fn} true_positive={tp} true_negative={tn}',
             f'parser_flags={len(need_rows)} flagged_extra_count_0={extras["0"]} flagged_extra_count_1={extras["1"]} flagged_extra_count_2={extras["2"]} flagged_extra_count_3plus={extras["3+"]}',
             f'repair_families_with_first={repair_families} repair_families_without_first={no_first} growth_families={growth_families}',
             f'repair_runs_with_first={repair_runs} growing_repairs={growing_repairs} added_entries_across_repairs={growth_sum} unique_added_files_within_families={growth_unique}',
             '']
    lines.extend(table(rows, 'kind', 'overall_by_kind'))
    for field, label in [('repo', 'repository'), ('worker', 'worker_agent_model'),
                         ('state', 'final_state'), ('provenance', 'classification_provenance')]:
        lines.extend(table(rows, field, label))
    lines.extend(['[hand_labeled_sample]', 'id\tparser_flag\tmanual_need'])
    lines.extend(f'{r["id"]}\t{int(r["blocked_file"])}\t{labels[r["id"]] or "unlabeled"}' for r in sample)
    OUTPUT.write_text('\n'.join(lines) + '\n')
    print('\n'.join(lines[:14]))


if __name__ == '__main__':
    main()
