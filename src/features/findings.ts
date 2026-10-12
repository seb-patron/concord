import type { ChangeView, Digest, FeatureModule, Finding, Gate, Id, ModuleContext, RepairRound } from '../contracts';
import { requireRole } from '../auth';
import { encodeCursor, HttpError, json, parseCursor } from '../http';
import { eventSequence } from '../state';
import { exactDispositions, isDigest, isId, type Disposition } from '../findings/round';

interface Ledger { findingIds: Id[]; findingSetVersion: number; nextRound: number; pendingRound: number | null }
interface StoredRound extends RepairRound {
  number: number; headOid: string; authorId: Id; dispositions: Disposition[]; reviewEvidenceDigest: Digest | null;
}

const empty = (): Ledger => ({ findingIds: [], findingSetVersion: 0, nextRound: 1, pendingRound: null });
const ledger = (context: ModuleContext, changeId: Id): Ledger => context.state.get<Ledger>(`ledger:${changeId}`) ?? empty();
const finding = (context: ModuleContext, id: Id): Finding | null => context.state.get<Finding>(`finding:${id}`);
const round = (context: ModuleContext, changeId: Id, number: number): StoredRound | null => context.state.get<StoredRound>(`round:${changeId}:${number}`);
const openIds = (context: ModuleContext, current: Ledger): Id[] => current.findingIds.filter(id => {
  const record = finding(context, id);
  if (!record) throw new HttpError(409, 'FINDING_LEDGER_INVALID', 'Finding record is unavailable');
  return record.status === 'open';
});
const view = (context: ModuleContext, changeId: Id): ChangeView => {
  const result = context.readChange?.(changeId);
  if (!result) throw new HttpError(501, 'MODULE_UNAVAILABLE', 'Trusted change view unavailable');
  if (result.status === 'blocked') throw new HttpError(result.code === 'CHANGE_NOT_FOUND' ? 404 : 409, result.code, result.reason);
  return result.value;
};
const mutable = (change: ChangeView): void => {
  if (change.frozen) throw new HttpError(409, 'PROMOTION_IN_PROGRESS', 'Change is frozen');
  if (!change.headOid || change.revision < 1 || change.status !== 'ready') {
    throw new HttpError(409, 'CHANGE_NOT_READY', 'Change needs a current ready head');
  }
};
const revision = (value: unknown, change: ChangeView): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new HttpError(422, 'INVALID_REVISION', 'Revision must be a positive integer');
  if (value !== change.revision) throw new HttpError(409, 'REVISION_STALE', 'Change revision changed');
  return value as number;
};
const setVersion = (value: unknown, current: Ledger): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new HttpError(422, 'INVALID_FINDING_SET_VERSION', 'Finding set version must be a nonnegative integer');
  if (value !== current.findingSetVersion) throw new HttpError(409, 'FINDINGS_STALE', 'Finding set changed');
  return value as number;
};
const active = (pending: StoredRound | null, change: ChangeView, current: Ledger, unresolved: Id[]): boolean =>
  !!pending && pending.status === 'pending' && pending.revision === change.revision &&
  pending.headOid === change.headOid && pending.findingSetVersion === current.findingSetVersion &&
  pending.findingIds.length === unresolved.length && unresolved.every(id => pending.findingIds.includes(id));

function anchor(raw: unknown, unitKey: string): NonNullable<Finding['semanticAnchor']> {
  if (raw === undefined) return { kind: 'unit', key: unitKey };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(422, 'INVALID_ANCHOR', 'Semantic anchor must be an object');
  const value = raw as Record<string, unknown>;
  if (!['unit', 'unknown'].includes(value.kind as string) || typeof value.key !== 'string' || !value.key.trim() || value.key.length > 256 ||
    (value.kind === 'unit' && value.key !== unitKey) ||
    (value.path !== undefined && (typeof value.path !== 'string' || !value.path.trim() || value.path.length > 512)) ||
    (value.line !== undefined && (!Number.isSafeInteger(value.line) || (value.line as number) < 1))) {
    throw new HttpError(422, 'INVALID_ANCHOR', 'Semantic anchor needs a stable kind and key; path and line are display hints');
  }
  return { kind: value.kind as 'unit' | 'unknown', key: value.key,
    ...(value.path === undefined ? {} : { path: value.path as string }),
    ...(value.line === undefined ? {} : { line: value.line as number }) };
}

function gate(context: ModuleContext, changeId: Id, requestedRevision: number): Gate<{ findingSetVersion: number; unresolvedIds: Id[]; pendingRound: number | null }> {
  const result = context.readChange?.(changeId);
  if (!result) return { status: 'blocked', version: context.version?.() ?? 0, code: 'MODULE_UNAVAILABLE', reason: 'Trusted change view unavailable', evidenceIds: [] };
  if (result.status === 'blocked') return result;
  if (result.value.revision !== requestedRevision || !result.value.headOid) {
    return { status: 'blocked', version: context.version(), code: 'REVISION_STALE', reason: 'Active change revision or head unavailable', evidenceIds: [changeId] };
  }
  const current = ledger(context, changeId);
  const unresolvedIds = openIds(context, current);
  const pending = current.pendingRound === null ? null : round(context, changeId, current.pendingRound);
  const pendingRound = active(pending, result.value, current, unresolvedIds) ? pending!.number : null;
  return { status: 'eligible', version: context.version(), evidenceIds: unresolvedIds,
    value: { findingSetVersion: current.findingSetVersion, unresolvedIds, pendingRound } };
}

const findingsPath = /^\/v1\/repos\/([^/]+)\/changes\/([^/]+)\/findings$/;
const repairsPath = /^\/v1\/repos\/([^/]+)\/changes\/([^/]+)\/repairs$/;
const reviewPath = /^\/v1\/repos\/([^/]+)\/changes\/([^/]+)\/repairs\/(\d+)\/review$/;

export const findings: FeatureModule = {
  name: 'findings', migrations: [],
  routes: [
    { method: 'GET', pattern: findingsPath, handle: (context, request, match) => {
      view(context, match[2]);
      const current = ledger(context, match[2]);
      const offset = parseCursor(new URL(request.url).searchParams.get('cursor'));
      const items = current.findingIds.slice(offset, offset + 100).map(id => finding(context, id)).filter((item): item is Finding => item !== null);
      return json({ items, findingSetVersion: current.findingSetVersion,
        nextCursor: offset + 100 < current.findingIds.length ? encodeCursor(offset + 100) : null }, context.version(), eventSequence(context.sql));
    } },
    { method: 'POST', pattern: findingsPath, handle: (context, _request, match, raw) => {
      requireRole(context.principal, 'reviewer');
      const body = raw as Record<string, unknown>;
      const changeId = match[2];
      const change = view(context, changeId);
      if (change.authorId === context.principal.principalId) throw new HttpError(403, 'SELF_REVIEW', 'Change author cannot create or reopen findings');
      mutable(change);
      const currentRevision = revision(body?.revision, change);
      if (typeof body?.unitKey !== 'string' || !body.unitKey.trim() || body.unitKey.length > 256 ||
        typeof body?.text !== 'string' || !body.text.trim() || body.text.length > 8192 || !isDigest(body?.evidenceDigest)) {
        throw new HttpError(422, 'INVALID_FINDING', 'Finding needs unit key, text, and evidence digest');
      }
      const unitKey = body.unitKey;
      const nextAnchor = anchor(body.semanticAnchor, unitKey);
      if (nextAnchor.kind === 'unit' && !change.unitKeys.includes(unitKey)) {
        throw new HttpError(422, 'UNKNOWN_UNIT', 'Unit anchor is outside the current change review scope; use an unknown anchor');
      }
      const reopenId = body.reopenFindingId;
      if (reopenId !== undefined && !isId(reopenId)) throw new HttpError(422, 'INVALID_FINDING', 'Invalid reopen finding ID');
      return context.transaction(() => {
        const current = ledger(context, changeId);
        if (reopenId !== undefined) {
          const previous = finding(context, reopenId as Id);
          if (!previous || previous.changeId !== changeId) throw new HttpError(404, 'FINDING_NOT_FOUND', 'Finding not found');
          if (previous.status !== 'resolved') throw new HttpError(409, 'FINDING_ALREADY_OPEN', 'Finding is already open');
          if (previous.unitKey !== unitKey || nextAnchor!.kind !== previous.semanticAnchor?.kind || nextAnchor!.key !== previous.semanticAnchor.key) {
            throw new HttpError(409, 'ANCHOR_MISMATCH', 'Reopening must preserve the semantic identity');
          }
          const version = context.nextVersion();
          const updated: Finding = { ...previous, version, status: 'open', text: body.text as string,
            evidenceDigest: body.evidenceDigest as Digest, semanticAnchor: nextAnchor,
            repairRound: null, resolvedAtRevision: null, resolvingReviewerId: null };
          context.state.put(`finding:${previous.findingId}`, updated);
          current.findingSetVersion++;
          context.state.put(`ledger:${changeId}`, current);
          const event = context.appendEvent('finding.reopened', [previous.findingId, changeId],
            { revision: currentRevision, unitKey, semanticAnchor: nextAnchor, text: updated.text, evidenceDigest: updated.evidenceDigest,
              previousEvidenceDigest: previous.evidenceDigest,
              previousResolution: { repairRound: previous.repairRound, resolvedAtRevision: previous.resolvedAtRevision,
                resolvingReviewerId: previous.resolvingReviewerId }, findingSetVersion: current.findingSetVersion }, version);
          return json(updated, version, event.sequence, 200);
        }
        const version = context.nextVersion();
        const created: Finding = { findingId: crypto.randomUUID(), changeId, originRevision: currentRevision,
          unitKey, text: body.text as string, evidenceDigest: body.evidenceDigest as Digest,
          semanticAnchor: nextAnchor, status: 'open', repairRound: null, resolvedAtRevision: null,
          resolvingReviewerId: null, version };
        current.findingIds.push(created.findingId);
        current.findingSetVersion++;
        context.state.put(`finding:${created.findingId}`, created);
        context.state.put(`ledger:${changeId}`, current);
        if (current.findingIds.length === 1) context.state.put('changes', [...(context.state.get<Id[]>('changes') ?? []), changeId]);
        const event = context.appendEvent('finding.created', [created.findingId, changeId],
          { originRevision: currentRevision, originHeadOid: change.headOid, unitKey, semanticAnchor: nextAnchor, text: created.text,
            evidenceDigest: created.evidenceDigest, findingSetVersion: current.findingSetVersion }, version);
        return json(created, version, event.sequence, 201);
      });
    } },
    { method: 'POST', pattern: repairsPath, handle: (context, _request, match, raw) => {
      requireRole(context.principal, 'agent', 'owner');
      const body = raw as Record<string, unknown>;
      const changeId = match[2];
      const change = view(context, changeId);
      if (change.authorId !== context.principal.principalId) throw new HttpError(403, 'NOT_AUTHOR', 'Only the change author can submit a repair');
      mutable(change);
      const currentRevision = revision(body?.revision, change);
      const current = ledger(context, changeId);
      const findingSetVersion = setVersion(body?.findingSetVersion, current);
      const unresolved = openIds(context, current);
      if (!unresolved.length) throw new HttpError(409, 'NO_OPEN_FINDINGS', 'No open findings to repair');
      const dispositions = exactDispositions(body?.dispositions, unresolved);
      const pending = current.pendingRound === null ? null : round(context, changeId, current.pendingRound);
      if (active(pending, change, current, unresolved)) throw new HttpError(409, 'REPAIR_PENDING', 'A repair round is already pending');
      return context.transaction(() => {
        const version = context.nextVersion();
        if (pending?.status === 'pending') context.appendEvent('repair.invalidated', [pending.roundId, changeId],
          { round: pending.number, reason: pending.revision !== currentRevision || pending.headOid !== change.headOid ? 'head_changed' : 'finding_set_changed' }, version);
        const number = current.nextRound++;
        const created: StoredRound = { roundId: crypto.randomUUID(), changeId, number, revision: currentRevision,
          headOid: change.headOid!, findingSetVersion, findingIds: [...unresolved], dispositions,
          authorId: context.principal.principalId, status: 'pending', reviewerId: null, reviewEvidenceDigest: null, version };
        current.pendingRound = number;
        context.state.put(`round:${changeId}:${number}`, created);
        context.state.put(`ledger:${changeId}`, current);
        const event = context.appendEvent('repair.submitted', [created.roundId, changeId, ...unresolved],
          { round: number, revision: currentRevision, headOid: change.headOid, findingSetVersion, dispositions }, version);
        return json(created, version, event.sequence, 201);
      });
    } },
    { method: 'POST', pattern: reviewPath, handle: (context, _request, match, raw) => {
      requireRole(context.principal, 'reviewer');
      const body = raw as Record<string, unknown>;
      const changeId = match[2];
      const change = view(context, changeId);
      if (change.authorId === context.principal.principalId) throw new HttpError(403, 'SELF_REVIEW', 'Change author cannot review a repair');
      mutable(change);
      const currentRevision = revision(body?.revision, change);
      const current = ledger(context, changeId);
      const findingSetVersion = setVersion(body?.findingSetVersion, current);
      if (!['accept', 'reject'].includes(body?.decision as string) || !isDigest(body?.evidenceDigest)) {
        throw new HttpError(422, 'INVALID_REVIEW', 'Review needs whole-round decision and evidence digest');
      }
      const number = Number(match[3]);
      if (!Number.isSafeInteger(number) || number < 1) throw new HttpError(404, 'ROUND_NOT_FOUND', 'Repair round not found');
      const pending = round(context, changeId, number);
      if (!pending) throw new HttpError(404, 'ROUND_NOT_FOUND', 'Repair round not found');
      if (pending.status !== 'pending' || current.pendingRound !== number) throw new HttpError(409, 'ROUND_CLOSED', 'Repair round is no longer pending');
      const unresolved = openIds(context, current);
      if (pending.revision !== currentRevision || pending.headOid !== change.headOid || pending.findingSetVersion !== findingSetVersion ||
        unresolved.length !== pending.findingIds.length || !unresolved.every(id => pending.findingIds.includes(id))) {
        throw new HttpError(409, 'ROUND_STALE', 'Head or finding set changed since repair submission');
      }
      return context.transaction(() => {
        const version = context.nextVersion();
        const decision = body.decision as 'accept' | 'reject';
        const reviewed: StoredRound = { ...pending, status: decision === 'accept' ? 'accepted' : 'rejected',
          reviewerId: context.principal.principalId, reviewEvidenceDigest: body.evidenceDigest as Digest, version };
        if (decision === 'accept') {
          for (const id of pending.findingIds) {
            const prior = finding(context, id)!;
            context.state.put(`finding:${id}`, { ...prior, version, status: 'resolved', repairRound: number,
              resolvedAtRevision: currentRevision, resolvingReviewerId: context.principal.principalId } satisfies Finding);
          }
          current.findingSetVersion++;
        }
        current.pendingRound = null;
        context.state.put(`round:${changeId}:${number}`, reviewed);
        context.state.put(`ledger:${changeId}`, current);
        const event = context.appendEvent(`repair.${reviewed.status}`, [pending.roundId, changeId, ...pending.findingIds],
          { round: number, revision: currentRevision, headOid: change.headOid, findingSetVersion,
            resultingFindingSetVersion: current.findingSetVersion, decision, evidenceDigest: body.evidenceDigest,
            reviewerId: context.principal.principalId, findingIds: pending.findingIds }, version);
        return json(reviewed, version, event.sequence);
      });
    } },
  ],
  snapshot: context => {
    const changeIds = context.state.get<Id[]>('changes') ?? [];
    const items: Finding[] = [];
    const rounds: Array<Omit<StoredRound, 'status'> & { status: StoredRound['status'] | 'invalidated' }> = [];
    const findingSetVersions: Record<Id, number> = {};
    for (const changeId of changeIds) {
      const current = ledger(context, changeId);
      findingSetVersions[changeId] = current.findingSetVersion;
      items.push(...current.findingIds.map(id => finding(context, id)).filter((item): item is Finding => item !== null));
      const change = context.readChange?.(changeId);
      const unresolved = openIds(context, current);
      for (let number = 1; number < current.nextRound; number++) {
        const record = round(context, changeId, number);
        if (!record) continue;
        const currentPending = current.pendingRound === number && change?.status === 'eligible' &&
          active(record, change.value, current, unresolved);
        rounds.push(record.status === 'pending' && !currentPending ? { ...record, status: 'invalidated' } : record);
      }
    }
    return { status: context.version() === 0 ? 'unavailable' : 'ready', items, rounds, findingSetVersions };
  },
  nextDeadline: () => null, onAlarm: () => undefined,
  hooks: {
    'findings.gate': gate,
    'findings.recordGeneratorFailure': (context, changeId, requestedRevision, jobId, outcome, log, evidenceDigest) => {
      if (!context.readChange) return { status: 'blocked', version: context.version?.() ?? 0,
        code: 'MODULE_UNAVAILABLE', reason: 'Trusted change view unavailable', evidenceIds: [] };
      const change = view(context, changeId);
      if (change.revision !== requestedRevision || !change.headOid) {
        return { status: 'blocked', version: context.version(), code: 'REVISION_STALE',
          reason: 'Generator failure belongs to a different revision', evidenceIds: [changeId] };
      }
      return context.transaction(() => {
        const current = ledger(context, changeId);
        const version = context.nextVersion();
        const created: Finding = { findingId: crypto.randomUUID(), changeId, originRevision: requestedRevision,
          unitKey: 'generator', text: `${outcome}: ${log}`.slice(0, 8192), evidenceDigest,
          semanticAnchor: { kind: 'unknown', key: outcome }, status: 'open', repairRound: null,
          resolvedAtRevision: null, resolvingReviewerId: null, version };
        current.findingIds.push(created.findingId);
        current.findingSetVersion++;
        context.state.put(`finding:${created.findingId}`, created);
        context.state.put(`ledger:${changeId}`, current);
        if (current.findingIds.length === 1) context.state.put('changes', [...(context.state.get<Id[]>('changes') ?? []), changeId]);
        context.appendEvent('finding.created', [created.findingId, changeId], {
          originRevision: requestedRevision, originHeadOid: change.headOid, unitKey: created.unitKey,
          semanticAnchor: created.semanticAnchor, text: created.text, evidenceDigest,
          generatorJobId: jobId, findingSetVersion: current.findingSetVersion }, version);
        return { status: 'eligible', version, evidenceIds: [created.findingId], value: { findingId: created.findingId } };
      });
    },
  },
};
