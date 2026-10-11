import type { Digest, Id, SubmitRepairBody } from '../contracts';
import { HttpError } from '../http';

export type Disposition = SubmitRepairBody['dispositions'][number];

export const isDigest = (value: unknown): value is Digest =>
  typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);

export const isId = (value: unknown): value is Id =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** Compare the complete open set before any state or event is written. */
export function exactDispositions(raw: unknown, openIds: readonly Id[]): Disposition[] {
  if (!Array.isArray(raw)) throw new HttpError(422, 'INVALID_REPAIR', 'Dispositions must be an array');
  const expected = new Set(openIds);
  const seen = new Set<Id>();
  const dispositions: Disposition[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || !isId(item.findingId)) {
      throw new HttpError(422, 'INVALID_REPAIR', 'Each disposition needs a finding ID');
    }
    if (seen.has(item.findingId) || !expected.has(item.findingId)) {
      throw new HttpError(409, 'FINDINGS_MISMATCH', 'Duplicate or extra finding ID in repair');
    }
    seen.add(item.findingId);
    if (typeof item.explanation !== 'string' || !item.explanation.trim() || !isDigest(item.evidenceDigest)) {
      throw new HttpError(422, 'INVALID_REPAIR', 'Each disposition needs explanation and evidence digest');
    }
    dispositions.push({ findingId: item.findingId, explanation: item.explanation.trim(), evidenceDigest: item.evidenceDigest });
  }
  if (seen.size !== expected.size) throw new HttpError(409, 'FINDINGS_MISMATCH', 'Repair must account for every open finding');
  return dispositions.sort((a, b) => a.findingId.localeCompare(b.findingId));
}
