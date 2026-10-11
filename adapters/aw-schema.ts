/** Public, deliberately minimal AW-shaped fixture. This is not the private launcher schema. */
export interface AwMockFixture {
  schemaVersion: 1;
  project: string;
  taskId: string;
  explicitAttempt: number;
  intent: string;
  unitKeys: string[];
  workerLabel: string;
  worktree: string;
  observedBaseOid?: string;
}

const id = /^[A-Za-z0-9_-]{1,64}$/;
const unit = /^[A-Za-z0-9._:/-]{1,128}$/;
const oid = /^[a-f0-9]{40}$/;

export function parseAwFixture(value: unknown): AwMockFixture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Fixture must be a JSON object');
  const data = value as Record<string, unknown>;
  const allowed = new Set(['schemaVersion', 'project', 'taskId', 'explicitAttempt', 'intent', 'unitKeys', 'workerLabel', 'worktree', 'observedBaseOid']);
  if (Object.keys(data).some(key => !allowed.has(key))) throw new Error('Unknown AW mock fixture field');
  if (data.schemaVersion !== 1) throw new Error('schemaVersion must be 1');
  if (typeof data.project !== 'string' || !id.test(data.project) || typeof data.taskId !== 'string' || !id.test(data.taskId)) throw new Error('project and taskId must be simple identifiers');
  if (!Number.isSafeInteger(data.explicitAttempt) || (data.explicitAttempt as number) < 1) throw new Error('explicitAttempt must be a positive integer');
  if (typeof data.intent !== 'string' || !data.intent.trim() || data.intent.length > 2000) throw new Error('intent must be nonempty and at most 2000 characters');
  if (!Array.isArray(data.unitKeys) || data.unitKeys.length === 0 || data.unitKeys.length > 128 || data.unitKeys.some(item => typeof item !== 'string' || !unit.test(item)) || new Set(data.unitKeys).size !== data.unitKeys.length) throw new Error('unitKeys must contain unique unit identifiers');
  if (typeof data.workerLabel !== 'string' || !data.workerLabel.trim() || data.workerLabel.length > 128) throw new Error('workerLabel must be nonempty');
  if (typeof data.worktree !== 'string' || !data.worktree.trim()) throw new Error('worktree must be a nonempty display path');
  if (data.observedBaseOid !== undefined && (typeof data.observedBaseOid !== 'string' || !oid.test(data.observedBaseOid))) throw new Error('observedBaseOid must be a Git SHA-1 commit OID');
  return data as unknown as AwMockFixture;
}
