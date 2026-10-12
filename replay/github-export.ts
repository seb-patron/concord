import { execFile as execFileCallback } from 'node:child_process';
import { createHash, createHmac, randomBytes, type Hash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseReplayJsonl, type EventType, type ReplayEvent, type ReplayExport, type ReplayHeader } from './schema.ts';
import { buildGithubBaseline, renderGithubBaselineTable } from './report.ts';

const execFile = promisify(execFileCallback);

export interface GhPage { status: number; headers: Record<string, string>; body: unknown }
export type GhApi = (path: string) => Promise<GhPage>;
export type GhSleep = (ms: number) => Promise<void>;
export interface FetchControl {
  sleep?: GhSleep;
  retries?: number;
  onThrottle?: (message: string) => void;
  hash?: Hash;
  stopAfterPage?: (items: unknown[]) => boolean;
}

const defaultSleep: GhSleep = ms => new Promise(done => setTimeout(done, ms));
const MAX_THROTTLE_MS = 15 * 60 * 1000;

export function parseGhResponse(raw: string): GhPage {
  const parts = raw.trimEnd().split(/\r?\n\r?\n/);
  const bodyText = parts.length > 1 ? parts[parts.length - 1].trim() : '';
  const head = (parts.length > 1 ? parts[parts.length - 2] : parts[0]).split(/\r?\n/);
  const status = Number(/HTTP\/\S+\s+(\d{3})/.exec(head[0] ?? '')?.[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const line of head.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status, headers, body: bodyText ? JSON.parse(bodyText) : null };
}

export function nextPagePath(link: string | undefined): string | null {
  const target = /<([^>]+)>\s*;\s*rel="next"/.exec(link ?? '')?.[1];
  if (!target) return null;
  try {
    const url = new URL(target);
    return `${url.pathname.replace(/^\/+/, '')}${url.search}`;
  } catch { return null; }
}

export function throttleDelayMs(headers: Record<string, string>, attempt: number, now = Date.now()): number {
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, MAX_THROTTLE_MS);
  const reset = Number(headers['x-ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) return Math.min(Math.max(reset * 1000 - now, 1000), MAX_THROTTLE_MS);
  return Math.min(5000 * 2 ** attempt, MAX_THROTTLE_MS);
}

export async function paginate(api: GhApi, path: string, control: FetchControl = {}): Promise<unknown[]> {
  const sleep = control.sleep ?? defaultSleep;
  const maxRetries = control.retries ?? 4;
  const items: unknown[] = [];
  let next: string | null = path;
  let attempts = 0;
  while (next !== null) {
    const page = await api(next);
    if (page.status === 403 || page.status === 429) {
      if (attempts >= maxRetries) throw new Error(`gh api ${next} stayed rate limited (HTTP ${page.status}) after ${attempts} retries`);
      const wait = throttleDelayMs(page.headers, attempts);
      control.onThrottle?.(`gh api ${next} returned HTTP ${page.status}; retrying in ${Math.ceil(wait / 1000)}s`);
      await sleep(wait);
      attempts += 1;
      continue;
    }
    if (page.status < 200 || page.status >= 300) {
      const message = typeof page.body === 'object' && page.body !== null && 'message' in page.body ? `: ${String((page.body as { message?: unknown }).message)}` : '';
      throw new Error(`gh api ${next} failed with HTTP ${page.status || 'transport error'}${message}`);
    }
    attempts = 0;
    control.hash?.update(JSON.stringify(page.body));
    if (!Array.isArray(page.body)) throw new Error(`gh api ${next} did not return a JSON array`);
    items.push(...page.body);
    next = control.stopAfterPage?.(page.body) ? null : nextPagePath(page.headers.link);
  }
  return items;
}

export function createGhApi(options: { bin?: string; timeoutMs?: number } = {}): GhApi {
  const bin = options.bin ?? 'gh';
  return async (path: string) => {
    let stdout: string;
    try {
      ({ stdout } = await execFile(bin, ['api', '-i', path], { timeout: options.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }));
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: unknown };
      if (typeof failure.stdout === 'string' && /HTTP\/\S+\s+\d{3}/.test(failure.stdout)) stdout = failure.stdout;
      else if (failure.code === 'ENOENT') throw new Error('GitHub CLI `gh` is not installed or not on PATH; install it and run `gh auth login` first');
      else throw new Error(`gh api ${path} failed: ${(failure.stderr ?? String(error)).trim().slice(0, 400)}`);
    }
    return parseGhResponse(stdout);
  };
}

export interface GithubPr {
  number: number;
  createdAt: number;
  closedAt: number | null;
  mergedAt: number | null;
  body: string;
  files: string[];
  commits: { sha: string; at: number }[];
  timeline: { event: string; at: number; state?: string; body?: string; commitId?: string }[];
}
export interface CollectedHistory { prs: GithubPr[]; digest: string }

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function timeMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function collectPrHistory(api: GhApi, options: { repo: string; since: number; until: number } & FetchControl): Promise<CollectedHistory> {
  const hash = options.hash ?? createHash('sha256');
  const control: FetchControl = { sleep: options.sleep, retries: options.retries, onThrottle: options.onThrottle, hash };
  const base = `repos/${options.repo}`;
  const listed = await paginate(api, `${base}/pulls?state=all&per_page=100&sort=created&direction=desc&page=1`, {
    ...control,
    stopAfterPage: items => {
      const created = timeMs(record(items[items.length - 1])?.created_at);
      return created !== null && created < options.since;
    },
  });
  const prs: GithubPr[] = [];
  for (const item of listed) {
    const raw = record(item);
    const created = timeMs(raw?.created_at);
    const number = typeof raw?.number === 'number' && Number.isInteger(raw.number) ? raw.number : null;
    if (!raw || created === null || number === null || created < options.since || created > options.until) continue;
    const files = (await paginate(api, `${base}/pulls/${number}/files?per_page=100&page=1`, control))
      .flatMap(entry => { const name = text(record(entry)?.filename); return name ? [name] : []; });
    const commits = (await paginate(api, `${base}/pulls/${number}/commits?per_page=100&page=1`, control))
      .flatMap(entry => {
        const rawCommit = record(entry);
        const at = timeMs(record(record(rawCommit?.commit)?.committer)?.date);
        return at === null ? [] : [{ sha: text(rawCommit?.sha), at }];
      })
      .sort((a, b) => a.at - b.at);
    const timeline = (await paginate(api, `${base}/issues/${number}/timeline?per_page=100&page=1`, control))
      .flatMap(entry => {
        const rawEvent = record(entry);
        const event = text(rawEvent?.event);
        const at = timeMs(rawEvent?.submitted_at) ?? timeMs(rawEvent?.created_at);
        if (!event || at === null) return [];
        return [{
          event, at,
          ...(text(rawEvent?.state) ? { state: text(rawEvent?.state) } : {}),
          ...(typeof rawEvent?.body === 'string' ? { body: rawEvent.body } : {}),
          ...(text(rawEvent?.commit_id) ? { commitId: text(rawEvent?.commit_id) } : {}),
        }];
      })
      .sort((a, b) => a.at - b.at);
    prs.push({
      number, createdAt: created,
      closedAt: timeMs(raw.closed_at), mergedAt: timeMs(raw.merged_at), body: text(raw.body),
      files, commits, timeline,
    });
  }
  prs.sort((a, b) => a.createdAt - b.createdAt || a.number - b.number);
  return { prs, digest: `sha256:${hash.digest('hex')}` };
}

function hmac(salt: string, scope: string, value: string): string {
  return createHmac('sha256', salt).update(`${scope}:${value}`).digest('hex');
}
export function githubTaskId(prNumber: number, salt: string): string {
  return `task-${hmac(salt, 'pr', String(prNumber)).slice(0, 16)}`;
}
export function githubUnitKey(path: string, salt: string): string {
  return `unit:${hmac(salt, 'path', path)}`;
}
function redactedRef(salt: string, locator: string): string {
  return `redacted:gh-${hmac(salt, 'ref', locator).slice(0, 24)}`;
}

const SUPERSEDE_PATTERN = /\b(superseded\s+by|supersedes|superseding)\s+#(\d+)/gi;

interface DraftEvent {
  type: EventType;
  at: number;
  locator: string;
  outcome?: 'landed' | 'refused' | 'unknown';
  overlapTaskIds?: string[];
  dependencyTaskIds?: string[];
}
interface TaskBuild {
  pr: GithubPr;
  taskId: string;
  unitKeys: string[];
  intervalEnd: number;
  files: Set<string>;
  opened: DraftEvent;
  drafts: DraftEvent[];
}

function pairDurations(events: ReplayEvent[]): void {
  const pair = (end: ReplayEvent, start: ReplayEvent, metric: 'wait' | 'checker' | 'work') => {
    const durationMs = Date.parse(end.occurredAt) - Date.parse(start.occurredAt);
    if (durationMs < 0) return;
    end.durationMs = durationMs;
    end.durationMetric = metric;
    end.durationSource = { kind: 'paired_events', startEventId: start.eventId, endEventId: end.eventId };
  };
  const checkStarts: ReplayEvent[] = [];
  let claim: ReplayEvent | null = null;
  let started: ReplayEvent | null = null;
  for (const event of events) {
    if (event.type === 'task_started') started = event;
    else if (event.type === 'claim_attempted') claim = event;
    else if (event.type === 'claim_granted') { if (claim) pair(event, claim, 'wait'); claim = null; }
    else if (event.type === 'check_started') checkStarts.push(event);
    else if (event.type === 'check_finished') { const start = checkStarts.shift(); if (start) pair(event, start, 'checker'); }
    else if (event.type === 'task_finished' && started) pair(event, started, 'work');
  }
}

export function buildGithubExport(collected: CollectedHistory, options: {
  repo: string; since: number; until: number; salt: string; exportedAt: string; approvalRef: string;
}): { data: ReplayExport; jsonl: string } {
  const { salt } = options;
  const supersedes = new Map<number, Set<number>>();
  const noteLinks = (content: string | undefined, speaker: number): void => {
    if (!content) return;
    for (const match of content.matchAll(SUPERSEDE_PATTERN)) {
      const target = Number(match[2]);
      const [superseder, superseded] = /^superseded\s+by$/i.test(match[1]) ? [target, speaker] : [speaker, target];
      if (superseder === superseded) continue;
      const edges = supersedes.get(superseder) ?? new Set<number>();
      edges.add(superseded);
      supersedes.set(superseder, edges);
    }
  };

  const tasks: TaskBuild[] = collected.prs.map(pr => {
    const opened: DraftEvent = { type: 'task_started', at: pr.createdAt, locator: `pr/${pr.number}/opened` };
    const fileKeys = [...new Set(pr.files)].map(file => githubUnitKey(file, salt)).sort();
    return {
      pr, taskId: githubTaskId(pr.number, salt),
      unitKeys: fileKeys.length ? fileKeys : [`unit:${hmac(salt, 'unit', `no-files:${pr.number}`)}`],
      intervalEnd: pr.closedAt ?? options.until, files: new Set(pr.files), opened, drafts: [opened],
    };
  });

  for (const task of tasks) {
    const { pr, drafts } = task;
    let requests = 0;
    let claimGranted = false;
    const reviewTimes: number[] = [];
    noteLinks(pr.body, pr.number);
    for (const item of pr.timeline) {
      if (item.at < pr.createdAt || item.at > options.until) continue;
      if (item.event === 'review_requested') {
        requests += 1;
        drafts.push({ type: requests === 1 ? 'claim_attempted' : 'recheck_requested', at: item.at, locator: `pr/${pr.number}/review_request/${requests}` });
        drafts.push({ type: 'check_started', at: item.at, locator: `pr/${pr.number}/review_request/${requests}:start` });
      } else if (item.event === 'reviewed') {
        reviewTimes.push(item.at);
        drafts.push({ type: 'check_finished', at: item.at, locator: `pr/${pr.number}/review/${item.at}` });
        if (requests > 0 && !claimGranted) {
          claimGranted = true;
          drafts.push({ type: 'claim_granted', at: item.at, locator: `pr/${pr.number}/review/${item.at}:granted` });
        }
        if (item.state === 'approved') drafts.push({ type: 'review_approved', at: item.at, locator: `pr/${pr.number}/review/${item.at}:approved` });
      } else if (item.event === 'commented') {
        noteLinks(item.body, pr.number);
      }
    }
    const headChanges: { at: number; key: string }[] = pr.commits
      .filter(commit => commit.at > pr.createdAt && commit.at <= options.until)
      .map(commit => ({ at: commit.at, key: commit.sha }));
    for (const item of pr.timeline) {
      if (item.event !== 'head_ref_force_pushed' || item.at > options.until) continue;
      const key = item.commitId ?? '';
      if (!headChanges.some(change => change.key === key || Math.abs(change.at - item.at) <= 10_000)) headChanges.push({ at: item.at, key });
    }
    headChanges.sort((a, b) => a.at - b.at);
    headChanges.forEach((change, index) => {
      const locator = `pr/${pr.number}/head/${change.key || index}`;
      drafts.push({ type: 'repair_submitted', at: change.at, locator });
      if (reviewTimes.some(at => at <= change.at)) drafts.push({ type: 'check_started', at: change.at, locator: `${locator}:start` });
    });
    const merged = pr.mergedAt !== null && pr.mergedAt <= options.until;
    if (merged) drafts.push({ type: 'merged', at: pr.mergedAt!, locator: `pr/${pr.number}/merged`, outcome: 'landed' });
    const finished = pr.closedAt !== null && pr.closedAt <= options.until ? pr.closedAt : merged ? pr.mergedAt : null;
    if (finished !== null) drafts.push({ type: 'task_finished', at: finished, locator: `pr/${pr.number}/closed`, outcome: merged ? 'landed' : 'refused' });
  }

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i], b = tasks[j];
      if (b.pr.createdAt > a.intervalEnd || a.pr.createdAt > b.intervalEnd) continue;
      if (![...a.files].some(file => b.files.has(file))) continue;
      const [first, later] = a.pr.createdAt <= b.pr.createdAt ? [a, b] : [b, a];
      first.opened.overlapTaskIds = [...(first.opened.overlapTaskIds ?? []), later.taskId];
      later.opened.overlapTaskIds = [...(later.opened.overlapTaskIds ?? []), first.taskId];
      later.drafts.push({ type: 'conflict_observed', at: later.pr.createdAt, locator: `pr/${later.pr.number}/conflict` });
    }
  }

  const taskByNumber = new Map(tasks.map(task => [task.pr.number, task]));
  for (const [superseder, targets] of supersedes) {
    const task = taskByNumber.get(superseder);
    if (!task) continue;
    const deps = [...targets].flatMap(number => {
      const target = taskByNumber.get(number);
      return target && target.taskId !== task.taskId ? [target.taskId] : [];
    });
    if (deps.length) task.opened.dependencyTaskIds = [...new Set(deps)].sort();
  }

  const events: ReplayEvent[] = [];
  for (const task of tasks) {
    const drafts = task.drafts.filter(draft => draft.at >= options.since && draft.at <= options.until).sort((a, b) => a.at - b.at);
    const taskEvents = drafts.map((draft, index) => {
      const event: ReplayEvent = {
        eventId: `${task.taskId}-e${index + 1}`, taskId: task.taskId, unitKeys: task.unitKeys,
        occurredAt: new Date(draft.at).toISOString(), type: draft.type, sourceEventRef: redactedRef(salt, draft.locator),
      };
      if (draft.outcome) event.outcome = draft.outcome;
      if (draft.overlapTaskIds?.length) event.overlapTaskIds = [...draft.overlapTaskIds].sort();
      if (draft.dependencyTaskIds?.length) event.dependencyTaskIds = draft.dependencyTaskIds;
      return event;
    });
    pairDurations(taskEvents);
    events.push(...taskEvents);
  }

  const taskIds = tasks.map(task => task.taskId);
  const header: ReplayHeader = {
    schemaVersion: 1,
    exportId: `gh-pr-${collected.digest.slice(-12)}`,
    sourceType: 'pr_history',
    sourceRef: `redacted:github-${hmac(salt, 'repo', options.repo).slice(0, 16)}`,
    sourceDigest: collected.digest,
    exportedAt: options.exportedAt,
    anonymizationVersion: 'github-pr-history-v1',
    ownerReleaseApprovalRef: options.approvalRef,
    selected: {
      cohortId: `github-${hmac(salt, 'repo', options.repo).slice(0, 12)}`, taskIds,
      window: { startAt: new Date(options.since).toISOString(), endAt: new Date(options.until).toISOString() },
    },
  };
  const data: ReplayExport = { header, events };
  const baseline = buildGithubBaseline(data);
  const ref = 'redacted:github-export';
  const aggregate = (value: number | null, denominator: number) => ({ value, denominator, sourceRef: ref });
  header.ownerReportedAggregates = {
    prs_total: aggregate(baseline.taskCount, baseline.taskCount),
    prs_merged: aggregate(baseline.mergedCount, baseline.taskCount),
    prs_closed_unmerged: aggregate(baseline.refusedCount, baseline.taskCount),
    prs_open_at_window_end: aggregate(baseline.censoredCount, baseline.taskCount),
    median_open_to_merge_ms: aggregate(baseline.openToMerge.medianMs, baseline.openToMerge.count),
    p90_open_to_merge_ms: aggregate(baseline.openToMerge.p90Ms, baseline.openToMerge.count),
    median_review_rounds: aggregate(baseline.medianReviewRounds, baseline.taskCount),
    head_change_after_review_prs: aggregate(baseline.staleApprovalCount, baseline.taskCount),
    superseded_prs: aggregate(baseline.supersededCount, baseline.taskCount),
    overlap_pairs: aggregate(baseline.overlapPairCount, baseline.taskCount),
  };
  const jsonl = `${[header, ...events].map(line => JSON.stringify(line)).join('\n')}\n`;
  parseReplayJsonl(jsonl);
  return { data, jsonl };
}

function normalizeUtc(value: string, flag: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be an ISO-8601 timestamp`);
  return parsed;
}

function parseArgs(argv: string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) usage();
    const value = argv[++i];
    if (!value || value.startsWith('--')) usage();
    values.set(arg, value);
  }
  return values;
}
function required(values: Map<string, string | true>, key: string): string {
  const value = values.get(key);
  if (typeof value !== 'string') usage();
  return value;
}
function usage(): never {
  throw new Error('Usage: replay:export-github --repo OWNER/REPO --since ISO --until ISO --out PATH [--approval-ref REF]');
}

async function main(): Promise<void> {
  const values = parseArgs(process.argv.slice(2));
  const repo = required(values, '--repo');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('--repo must be OWNER/REPO');
  const since = normalizeUtc(required(values, '--since'), '--since');
  const until = normalizeUtc(required(values, '--until'), '--until');
  if (until <= since) throw new Error('--until must be after --since');
  const out = required(values, '--out');
  const approval = values.get('--approval-ref');
  const collected = await collectPrHistory(createGhApi(), {
    repo, since, until, onThrottle: message => console.error(`replay:export-github: ${message}`),
  });
  if (collected.prs.length === 0) throw new Error(`No pull requests were created in ${repo} between ${new Date(since).toISOString()} and ${new Date(until).toISOString()}`);
  const { data, jsonl } = buildGithubExport(collected, {
    repo, since, until, salt: randomBytes(16).toString('hex'), exportedAt: new Date().toISOString(),
    approvalRef: typeof approval === 'string' ? approval : 'owner-local-export',
  });
  await writeFile(out, jsonl, 'utf8');
  console.log(`Wrote ${data.header.selected.taskIds.length} pull requests (${data.events.length} events) to ${out}`);
  console.log(renderGithubBaselineTable(buildGithubBaseline(data), { cohortId: data.header.selected.cohortId, window: data.header.selected.window }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`replay:export-github: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
