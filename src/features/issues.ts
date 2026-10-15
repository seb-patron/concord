import type { Change, FeatureModule, Gate, ModuleContext } from '../contracts';
import { HttpError, json, parseCursor, encodeCursor, unavailableGate } from '../http';
import { eventSequence, sqlState } from '../state';

type Issue = { number: number; title: string; body: string; labels: string[]; milestoneId: string | null;
  allowedFiles: string[] | null; state: 'open' | 'closed'; authorId: string; version: number;
  reason: string | null; closedBy: { changeId: string; canonicalOid: string } | null;
  createdAt: number; updatedAt: number; closedAt: number | null };
type Milestone = { milestoneId: string; title: string; description: string; dueDate: string | null;
  state: 'open' | 'closed'; version: number };
type MilestoneSettings = { create: 'agents' | 'owners'; version: number };
const issues = (c: ModuleContext) => c.state.get<Issue[]>('items') ?? [];
const milestones = (c: ModuleContext) => c.state.get<Milestone[]>('milestones') ?? [];
const milestoneSettings = (c: ModuleContext): MilestoneSettings => c.state.get<MilestoneSettings>('milestoneSettings') ?? { create: 'agents', version: 0 };
const changes = (c: ModuleContext) => sqlState(c.sql).get<Change[]>('module:repos:changes') ?? [];
const queueEntries = (c: ModuleContext) => sqlState(c.sql).get<{ entries?: Array<{ changeId: string; state: string }> }>('module:queue:data')?.entries ?? [];
type IssueViews = { changesByIssue: Map<number, Change[]>; lastQueueState: Map<string, string> };
const issueViews = (c: ModuleContext): IssueViews => {
  const changesByIssue = new Map<number, Change[]>();
  for (const change of changes(c)) {
    if (change.issueNumber === undefined || change.issueNumber === null) continue;
    const linked = changesByIssue.get(change.issueNumber) ?? [];
    linked.push(change);
    changesByIssue.set(change.issueNumber, linked);
  }
  const lastQueueState = new Map<string, string>();
  for (const entry of queueEntries(c)) lastQueueState.set(entry.changeId, entry.state);
  return { changesByIssue, lastQueueState };
};
const response = (c: ModuleContext, data: unknown, status = 200) => json(data, c.version(), eventSequence(c.sql), status);
const error = (status: number, code: string, message: string): never => { throw new HttpError(status, code, message); };
const string = (value: unknown, field: string, max: number, empty = false): string => {
  if (typeof value !== 'string' || new TextEncoder().encode(value).byteLength > max || (!empty && !value.trim())) error(422, 'INVALID_' + field.toUpperCase(), `${field} is invalid`);
  return value as string;
};
const listStrings = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 256) || new Set(value).size !== value.length) error(422, 'INVALID_' + field.toUpperCase(), `${field} must be unique strings`);
  return value as string[];
};
const event = (c: ModuleContext, kind: string, ids: string[], payload: Record<string, unknown>) => {
  const version = c.nextVersion(); c.appendEvent(kind, ids, payload, version); return version;
};
const milestoneAdvanced = (c: ModuleContext, milestoneId: string | null, issueNumber: number) => {
  if (!milestoneId) return;
  const version = event(c, 'milestone.updated', [milestoneId, String(issueNumber)], { issueNumber });
  c.state.put('milestones', milestones(c).map(item => item.milestoneId === milestoneId ? { ...item, version } : item));
};
const canWrite = (c: ModuleContext) => {
  if (!c.principal.roles.some(role => role === 'owner' || role === 'agent')) error(403, 'FORBIDDEN', 'Author or owner role required');
};
const issue = (c: ModuleContext, number: number) => issues(c).find(item => item.number === number) ?? error(404, 'ISSUE_NOT_FOUND', 'Issue not found');
const milestone = (c: ModuleContext, id: string) => milestones(c).find(item => item.milestoneId === id) ?? error(404, 'MILESTONE_NOT_FOUND', 'Milestone not found');
const numberFrom = (raw: string) => /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : error(404, 'ISSUE_NOT_FOUND', 'Issue not found');
const checkVersion = (body: Record<string, unknown>, current: number) => {
  if (!Number.isSafeInteger(body.expectedVersion)) error(400, 'EXPECTED_VERSION_REQUIRED', 'expectedVersion required');
  if (body.expectedVersion !== current) throw new HttpError(409, 'STALE_VERSION', 'Object version is stale', { currentVersion: current });
};
const linked = (item: Issue, views: IssueViews) => (views.changesByIssue.get(item.number) ?? []).map(change => {
  const queueState = views.lastQueueState.get(change.changeId);
  const status = queueState === 'landed' ? 'merged' : queueState === 'checking' ? 'checking'
    : ['admitted', 'reserved'].includes(queueState ?? '') ? 'queued'
      : queueState === 'blocked' || queueState === 'failed' ? 'blocked' : change.status;
  return { changeId: change.changeId, status, revision: change.revision };
});
const issueView = (item: Issue, views: IssueViews) => ({ ...item, changes: linked(item, views) });
const milestoneView = (c: ModuleContext, item: Milestone, views: IssueViews) => {
  const members = issues(c).filter(issue => issue.milestoneId === item.milestoneId);
  const landed = new Set(members.flatMap(issue => linked(issue, views).filter(change => change.status === 'merged').map(change => change.changeId)));
  return { ...item, progress: { openIssues: members.filter(issue => issue.state === 'open').length,
    closedIssues: members.filter(issue => issue.state === 'closed').length, landedChanges: landed.size } };
};
const page = <T>(items: T[], request: Request) => {
  const params = new URL(request.url).searchParams;
  const offset = parseCursor(params.get('cursor'));
  const limit = params.has('limit') ? Number(params.get('limit')) : 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) error(400, 'INVALID_LIMIT', 'Limit must be 1 to 100');
  return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? encodeCursor(offset + limit) : null };
};

export const issuesFeature: FeatureModule = {
  name: 'issues', migrations: [],
  routes: [
    { method: 'GET', pattern: /^\/v1\/repos\/[^/]+\/milestone-settings$/, handle: c => response(c, milestoneSettings(c)) },
    { method: 'PATCH', pattern: /^\/v1\/repos\/[^/]+\/milestone-settings$/, handle: (c, _r, _m, raw) => {
      if (!c.principal.roles.includes('owner')) error(403, 'FORBIDDEN', 'Owner required');
      const body = raw as Record<string, unknown>;
      if (body.create !== 'agents' && body.create !== 'owners') error(422, 'INVALID_CREATE', 'create must be agents or owners');
      const create = body.create as 'agents' | 'owners';
      const old = milestoneSettings(c); checkVersion(body, old.version);
      const setting: MilestoneSettings = { create, version: event(c, 'milestone.settings_updated', [], { create }) };
      c.state.put('milestoneSettings', setting); return response(c, setting);
    } },
    { method: 'POST', pattern: /^\/v1\/repos\/[^/]+\/issues$/, handle: (c, _r, _m, raw) => {
      canWrite(c); const body = raw as Record<string, unknown>;
      const title = string(body.title, 'title', 256); const text = string(body.body ?? '', 'body', 65536, true);
      const labels = listStrings(body.labels ?? [], 'labels');
      const milestoneId = body.milestoneId == null ? null : string(body.milestoneId, 'milestoneId', 64);
      if (milestoneId) milestone(c, milestoneId);
      const allowedFiles = body.allowedFiles == null ? null : listStrings(body.allowedFiles, 'allowedFiles');
      const number = (c.state.get<number>('nextNumber') ?? 0) + 1;
      const now = c.now();
      const item: Issue = { number, title, body: text, labels, milestoneId, allowedFiles, state: 'open', authorId: c.principal.principalId,
        version: event(c, 'issue.created', [String(number)], { number, title }), reason: null, closedBy: null,
        createdAt: now, updatedAt: now, closedAt: null };
      c.state.put('nextNumber', number); c.state.put('items', [...issues(c), item]); milestoneAdvanced(c, milestoneId, number); return response(c, issueView(item, issueViews(c)), 201);
    } },
    { method: 'GET', pattern: /^\/v1\/repos\/[^/]+\/issues$/, handle: (c, request) => {
      const params = new URL(request.url).searchParams;
      const state = params.get('state'); if (state && !['open', 'closed'].includes(state)) error(400, 'INVALID_STATE', 'Invalid issue state');
      const selected = issues(c).filter(item => (!state || item.state === state) && (!params.has('label') || item.labels.includes(params.get('label')!)) && (!params.has('milestoneId') || item.milestoneId === params.get('milestoneId')));
      const views = issueViews(c);
      return response(c, page(selected.map(item => issueView(item, views)), request));
    } },
    { method: 'GET', pattern: /^\/v1\/repos\/[^/]+\/issues\/(\d+)$/, handle: (c, _r, match) => response(c, issueView(issue(c, numberFrom(match[1])), issueViews(c))) },
    { method: 'PATCH', pattern: /^\/v1\/repos\/[^/]+\/issues\/(\d+)$/, handle: (c, _r, match, raw) => {
      const body = raw as Record<string, unknown>; const old = issue(c, numberFrom(match[1]));
      canWrite(c); if (old.authorId !== c.principal.principalId && !c.principal.roles.includes('owner')) error(403, 'FORBIDDEN', 'Only author or owner may edit');
      checkVersion(body, old.version);
      const title = body.title === undefined ? old.title : string(body.title, 'title', 256);
      const text = body.body === undefined ? old.body : string(body.body, 'body', 65536, true);
      const labels = body.labels === undefined ? old.labels : listStrings(body.labels, 'labels');
      const milestoneId = body.milestoneId === undefined ? old.milestoneId : body.milestoneId === null ? null : string(body.milestoneId, 'milestoneId', 64);
      if (milestoneId) milestone(c, milestoneId);
      const allowedFiles = body.allowedFiles === undefined ? old.allowedFiles : body.allowedFiles === null ? null : listStrings(body.allowedFiles, 'allowedFiles');
      const item = { ...old, title, body: text, labels, milestoneId, allowedFiles, updatedAt: c.now(),
        version: event(c, 'issue.updated', [String(old.number)], { number: old.number }) };
      c.state.put('items', issues(c).map(candidate => candidate.number === old.number ? item : candidate));
      if (old.milestoneId !== milestoneId) { milestoneAdvanced(c, old.milestoneId, old.number); milestoneAdvanced(c, milestoneId, old.number); }
      return response(c, issueView(item, issueViews(c)));
    } },
    { method: 'POST', pattern: /^\/v1\/repos\/[^/]+\/issues\/(\d+)\/(close|reopen)$/, handle: (c, _r, match, raw) => {
      const body = raw as Record<string, unknown>; const old = issue(c, numberFrom(match[1]));
      canWrite(c); if (old.authorId !== c.principal.principalId && !c.principal.roles.includes('owner')) error(403, 'FORBIDDEN', 'Only author or owner may change state');
      checkVersion(body, old.version); const reason = string(body.reason, 'reason', 2000);
      const state = match[2] === 'close' ? 'closed' : 'open';
      if (old.state === state) error(409, 'ISSUE_STATE_CONFLICT', 'Issue already in requested state');
      const now = c.now();
      const item: Issue = { ...old, state, reason, closedBy: null, closedAt: state === 'closed' ? now : null, updatedAt: now,
        version: event(c, `issue.${state === 'closed' ? 'closed' : 'reopened'}`, [String(old.number)], { number: old.number, reason }) };
      c.state.put('items', issues(c).map(candidate => candidate.number === old.number ? item : candidate));
      milestoneAdvanced(c, old.milestoneId, old.number); return response(c, issueView(item, issueViews(c)));
    } },
    { method: 'POST', pattern: /^\/v1\/repos\/[^/]+\/milestones$/, handle: (c, _r, _m, raw) => {
      canWrite(c); if (!c.principal.roles.includes('owner') && milestoneSettings(c).create === 'owners') error(403, 'FORBIDDEN', 'Owner required'); const body = raw as Record<string, unknown>;
      const title = string(body.title, 'title', 256); const description = string(body.description ?? '', 'description', 65536, true);
      const dueDate = body.dueDate == null ? null : string(body.dueDate, 'dueDate', 32);
      if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0, 10) !== dueDate)) error(422, 'INVALID_DUE_DATE', 'dueDate must be a calendar date in YYYY-MM-DD');
      const milestoneId = crypto.randomUUID(); const item: Milestone = { milestoneId, title, description, dueDate, state: 'open', version: event(c, 'milestone.created', [milestoneId], { title }) };
      c.state.put('milestones', [...milestones(c), item]); return response(c, milestoneView(c, item, issueViews(c)), 201);
    } },
    { method: 'GET', pattern: /^\/v1\/repos\/[^/]+\/milestones$/, handle: (c, request) => { const views = issueViews(c); return response(c, page(milestones(c).map(item => milestoneView(c, item, views)), request)); } },
    { method: 'GET', pattern: /^\/v1\/repos\/[^/]+\/milestones\/([A-Za-z0-9_-]+)$/, handle: (c, _r, match) => response(c, milestoneView(c, milestone(c, match[1]), issueViews(c))) },
    { method: 'POST', pattern: /^\/v1\/repos\/[^/]+\/milestones\/([A-Za-z0-9_-]+)\/close$/, handle: (c, _r, match, raw) => {
      if (!c.principal.roles.includes('owner')) error(403, 'FORBIDDEN', 'Owner required'); const old = milestone(c, match[1]); checkVersion(raw as Record<string, unknown>, old.version);
      if (old.state === 'closed') error(409, 'MILESTONE_STATE_CONFLICT', 'Milestone already closed');
      const item: Milestone = { ...old, state: 'closed', version: event(c, 'milestone.closed', [old.milestoneId], {}) };
      c.state.put('milestones', milestones(c).map(candidate => candidate.milestoneId === old.milestoneId ? item : candidate)); return response(c, milestoneView(c, item, issueViews(c)));
    } },
  ],
  snapshot: c => { const views = issueViews(c); return { status: 'ready', items: issues(c).map(item => issueView(item, views)), milestones: milestones(c).map(item => milestoneView(c, item, views)), milestoneSettings: milestoneSettings(c) }; },
  nextDeadline: () => null, onAlarm: () => {},
  hooks: {
    'issues.validate': (c, number): Gate<{ number: number; title: string }> => {
      if (!c?.sql) return unavailableGate();
      const item = issues(c).find(item => item.number === number && item.state === 'open');
      return item ? { status: 'eligible', version: c.version(), evidenceIds: [String(number)], value: { number, title: item.title } }
        : { status: 'blocked', version: c.version(), code: 'ISSUE_NOT_OPEN', reason: 'Linked issue must be open', evidenceIds: [] };
    },
    'issues.land': (c, changeId, canonicalOid): Gate => {
      if (!c?.sql) return unavailableGate();
      const change = changes(c).find(item => item.changeId === changeId);
      const old = issues(c).find(item => item.number === change?.issueNumber);
      if (!old || old.state === 'closed') return { status: 'eligible', version: c.version(), evidenceIds: [], value: undefined };
      const closedBy = { changeId, canonicalOid };
      const now = c.now();
      const item: Issue = { ...old, state: 'closed', reason: 'Landed change', closedBy, closedAt: now, updatedAt: now,
        version: event(c, 'issue.closed', [String(old.number), changeId], { number: old.number, closedBy }) };
      c.state.put('items', issues(c).map(candidate => candidate.number === old.number ? item : candidate));
      milestoneAdvanced(c, old.milestoneId, old.number);
      return { status: 'eligible', version: c.version(), evidenceIds: [String(old.number)], value: undefined };
    },
  },
};
