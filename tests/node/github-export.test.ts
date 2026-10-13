import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseReplayJsonl } from '../../replay/schema.ts';
import {
  buildGithubExport, collectPrHistory, githubTaskId, githubUnitKey, type GhApi,
} from '../../replay/github-export.ts';
import { buildGithubBaseline, renderGithubBaselineTable } from '../../replay/report.ts';

const fixturePath = resolve(process.cwd(), 'tests/fixtures/github-prs.json');
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
  pages: { path: string; status: number; headers?: Record<string, string>; body: unknown }[];
};

const REPO = 'acme/widgets';
const SINCE = Date.parse('2026-01-01T00:00:00Z');
const UNTIL = Date.parse('2026-02-01T00:00:00Z');
const SALT = 'test-salt';
const LIST_PAGE = 'repos/acme/widgets/pulls?state=all&per_page=100&sort=created&direction=desc&page=';

function fixtureApi(): { api: GhApi; calls: string[]; throttle: string[] } {
  const pages = [...fixture.pages];
  const calls: string[] = [];
  const throttle: string[] = [];
  const api: GhApi = async path => {
    calls.push(path);
    const index = pages.findIndex(page => page.path === path);
    if (index < 0) return { status: 404, headers: {}, body: { message: 'Not Found' } };
    const [page] = pages.splice(index, 1);
    return { status: page.status, headers: page.headers ?? {}, body: page.body };
  };
  return { api, calls, throttle };
}

async function build() {
  const fake = fixtureApi();
  const collected = await collectPrHistory(fake.api, {
    repo: REPO, since: SINCE, until: UNTIL,
    sleep: () => Promise.resolve(), onThrottle: message => fake.throttle.push(message),
  });
  const { data, jsonl } = buildGithubExport(collected, {
    repo: REPO, since: SINCE, until: UNTIL, salt: SALT,
    exportedAt: '2026-02-02T00:00:00Z', approvalRef: 'test-approval',
  });
  return { fake, collected, data, jsonl };
}

describe('github pr history export', () => {
  it('paginates the pull list, retries a rate-limited page, and stops before older pages', async () => {
    const { fake, collected } = await build();
    expect(fake.calls).toContain(`${LIST_PAGE}1`);
    expect(fake.calls).toContain(`${LIST_PAGE}2`);
    expect(fake.calls).not.toContain(`${LIST_PAGE}3`);
    const timeline101 = 'repos/acme/widgets/issues/101/timeline?per_page=100&page=1';
    expect(fake.calls.filter(path => path === timeline101)).toHaveLength(2);
    expect(fake.throttle).toHaveLength(1);
    expect(collected.prs.map(pr => pr.number)).toEqual([101, 102, 103, 104, 105]);
    expect(collected.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('emits a schema-valid JSONL export through the existing validator', async () => {
    const { data, jsonl } = await build();
    const parsed = parseReplayJsonl(jsonl);
    expect(parsed.header.sourceType).toBe('pr_history');
    expect(parsed.header.sourceRef).toMatch(/^redacted:/);
    expect(parsed.header.selected.taskIds).toEqual([101, 102, 103, 104, 105].map(number => githubTaskId(number, SALT)));
    expect(parsed.header.ownerReportedAggregates).toBeDefined();
    expect(parsed.events).toHaveLength(data.events.length);
    for (const event of parsed.events) {
      expect(event.taskId).toMatch(/^task-[a-f0-9]{16}$/);
      expect(event.sourceEventRef).toMatch(/^redacted:/);
    }
  });

  it('maps reviews, paired durations, and landed or refused outcomes', async () => {
    const { data } = await build();
    const merged101 = data.events.filter(e => e.taskId === githubTaskId(101, SALT));
    const finished101 = merged101.find(e => e.type === 'task_finished')!;
    expect(finished101.outcome).toBe('landed');
    expect(finished101.durationMetric).toBe('work');
    expect(finished101.durationMs).toBe(288_000_000);
    const granted = merged101.find(e => e.type === 'claim_granted')!;
    expect(granted.durationMetric).toBe('wait');
    expect(granted.durationMs).toBe(100_800_000);
    const round = merged101.find(e => e.type === 'check_finished')!;
    expect(round.durationMetric).toBe('checker');
    expect(round.durationMs).toBe(100_800_000);
    expect(merged101.some(e => e.type === 'review_approved')).toBe(true);
    expect(merged101.some(e => e.type === 'merged' && e.outcome === 'landed')).toBe(true);
    const refused102 = data.events.find(e => e.taskId === githubTaskId(102, SALT) && e.type === 'task_finished')!;
    expect(refused102.outcome).toBe('refused');
    const open105 = data.events.filter(e => e.taskId === githubTaskId(105, SALT));
    expect(open105.some(e => ['merged', 'task_finished', 'task_refused'].includes(e.type))).toBe(false);
  });

  it('deduplicates head changes across commits and force-push events', async () => {
    const { data } = await build();
    const merged101 = data.events.filter(e => e.taskId === githubTaskId(101, SALT));
    const repairs = merged101.filter(e => e.type === 'repair_submitted');
    expect(repairs.map(e => e.occurredAt)).toEqual(['2026-01-07T09:00:00.000Z', '2026-01-07T15:00:00.000Z']);
    const firstReview = Date.parse(merged101.find(e => e.type === 'check_finished')!.occurredAt);
    expect(repairs.every(e => Date.parse(e.occurredAt) > firstReview)).toBe(true);
    expect(merged101.some(e => e.type === 'recheck_requested')).toBe(true);
    expect(buildGithubBaseline(data).staleApprovalCount).toBe(1);
  });

  it('links superseded pull requests as in-cohort dependencies', async () => {
    const { data } = await build();
    const superseder = githubTaskId(104, SALT);
    const superseded = githubTaskId(102, SALT);
    const opened = data.events.find(e => e.taskId === superseder && e.type === 'task_started')!;
    expect(opened.dependencyTaskIds).toEqual([superseded]);
    const supersededOpened = data.events.find(e => e.taskId === superseded && e.type === 'task_started')!;
    expect(supersededOpened.dependencyTaskIds).toBeUndefined();
    expect(buildGithubBaseline(data).supersededCount).toBe(1);
  });

  it('records overlapping file edits while both pull requests were open', async () => {
    const { data } = await build();
    const first = githubTaskId(101, SALT);
    const second = githubTaskId(102, SALT);
    expect(data.events.find(e => e.taskId === first && e.type === 'task_started')!.overlapTaskIds).toEqual([second]);
    expect(data.events.find(e => e.taskId === second && e.type === 'task_started')!.overlapTaskIds).toEqual([first]);
    expect(data.events.some(e => e.taskId === second && e.type === 'conflict_observed')).toBe(true);
    expect(data.events.filter(e => e.type === 'conflict_observed')).toHaveLength(1);
    expect(buildGithubBaseline(data).overlapPairCount).toBe(1);
  });

  it('keeps unit keys keyed to real paths while redacting paths, titles, and usernames', async () => {
    const { data, jsonl } = await build();
    const keys = new Set(data.events.flatMap(e => e.unitKeys));
    expect(keys).toContain(githubUnitKey('src/billing/invoices.ts', SALT));
    for (const key of keys) expect(key).toMatch(/^unit:[a-f0-9]{64}$/);
    for (const leaked of [
      'seb-patron', 'kara-ops', 'dependabot', 'acme', 'src/billing', 'invoices.ts', 'ledger.ts',
      'checkout.tsx', 'setup.md', 'Acme', 'proprietary', 'Supersedes #102', 'superseded by #104',
      'PTAL', 'ledger-reconcile', 'checkout-rewrite', 'invoice-pipeline', 'billing-v3', 'c101f', 'c102a',
      'api.github.com', 'github.com/acme', 'reconciliation', 'experimental',
    ]) expect(jsonl).not.toContain(leaked);
  });

  it('computes the baseline table metrics with denominators', async () => {
    const { data } = await build();
    const baseline = buildGithubBaseline(data);
    expect(baseline).toMatchObject({
      taskCount: 5, mergedCount: 3, refusedCount: 1, censoredCount: 1,
      staleApprovalCount: 1, supersededCount: 1, overlapPairCount: 1,
    });
    expect(baseline.openToMerge).toEqual({ medianMs: 90_000_000, p90Ms: 288_000_000, count: 3 });
    expect(baseline.medianReviewRounds).toBe(1);
    const table = renderGithubBaselineTable(baseline, { cohortId: data.header.selected.cohortId, window: data.header.selected.window });
    for (const line of ['pull requests', 'median open->merge', 'p90 open->merge', 'head change after first review',
      'superseded share', 'median review rounds', 'overlapping PR pairs']) expect(table).toContain(line);
    expect(table).toContain('25.0h');
    expect(table).toContain('3.3d');
    expect(table).toContain('1/5 (20.0%)');
  });

  it('reports owner aggregates only from computed values with denominators', async () => {
    const { data } = await build();
    const aggregates = data.header.ownerReportedAggregates!;
    expect(aggregates.prs_total).toEqual({ value: 5, denominator: 5, sourceRef: 'redacted:github-export' });
    expect(aggregates.prs_merged).toEqual({ value: 3, denominator: 5, sourceRef: 'redacted:github-export' });
    expect(aggregates.prs_closed_unmerged).toEqual({ value: 1, denominator: 5, sourceRef: 'redacted:github-export' });
    expect(aggregates.prs_open_at_window_end).toEqual({ value: 1, denominator: 5, sourceRef: 'redacted:github-export' });
    expect(aggregates.median_open_to_merge_ms).toEqual({ value: 90_000_000, denominator: 3, sourceRef: 'redacted:github-export' });
    expect(aggregates.median_review_rounds).toEqual({ value: 1, denominator: 5, sourceRef: 'redacted:github-export' });
    expect(aggregates.overlap_pairs).toEqual({ value: 1, denominator: 5, sourceRef: 'redacted:github-export' });
    expect(aggregates.head_change_after_review_prs).toEqual({ value: 1, denominator: 5, sourceRef: 'redacted:github-export' });
    expect(aggregates.superseded_prs).toEqual({ value: 1, denominator: 5, sourceRef: 'redacted:github-export' });
  });
});
