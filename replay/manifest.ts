export interface ReplayCharge {
  resolvedHead: string;
  rebaseRunMinutes: number;
  reviewMinutes: number;
}

export interface ManifestChange {
  id: string;
  label: string;
  order: number;
  base: string;
  head: string;
  dependsOn: string[];
  charge: ReplayCharge | null;
}

export interface ReplayManifest {
  schemaVersion: 1;
  batch: string;
  startCommit: string;
  validationCommand: string;
  changes: ManifestChange[];
}

export class ManifestError extends Error {
  constructor(message: string) { super(`Invalid replay manifest: ${message}`); this.name = 'ManifestError'; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function sha(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{40}$/.test(value)) throw new ManifestError(`${field} must be a 40-hex SHA`);
}
function minutes(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ManifestError(`${field} must be a non-negative finite number`);
}

export function parseManifest(text: string): ReplayManifest {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new ManifestError('invalid JSON'); }
  if (!object(value) || value.schemaVersion !== 1) throw new ManifestError('schemaVersion must be 1');
  if (!nonempty(value.batch)) throw new ManifestError('batch must be a non-empty string');
  sha(value.startCommit, 'startCommit');
  if (!nonempty(value.validationCommand)) throw new ManifestError('validationCommand must be a non-empty string');
  if (!Array.isArray(value.changes) || value.changes.length === 0) throw new ManifestError('changes must be a non-empty array');

  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const [index, raw] of value.changes.entries()) {
    const field = `changes[${index}]`;
    if (!object(raw)) throw new ManifestError(`${field} must be an object`);
    if (!nonempty(raw.id)) throw new ManifestError(`${field}.id must be a non-empty string`);
    if (ids.has(raw.id)) throw new ManifestError(`duplicate change id: ${raw.id}`);
    ids.add(raw.id);
    if (!nonempty(raw.label)) throw new ManifestError(`${field}.label must be a non-empty string`);
    if (!Number.isSafeInteger(raw.order) || (raw.order as number) < 1) throw new ManifestError(`${field}.order must be a positive integer`);
    if (orders.has(raw.order as number)) throw new ManifestError(`duplicate order: ${raw.order}`);
    orders.add(raw.order as number);
    sha(raw.base, `${field}.base`);
    sha(raw.head, `${field}.head`);
    if (!Array.isArray(raw.dependsOn) || raw.dependsOn.some(dep => !nonempty(dep))) throw new ManifestError(`${field}.dependsOn must be an array of ids`);
    if (new Set(raw.dependsOn).size !== raw.dependsOn.length) throw new ManifestError(`${field}.dependsOn has duplicate ids`);
    if (raw.charge !== null) {
      if (!object(raw.charge)) throw new ManifestError(`${field}.charge must be null or an object`);
      sha(raw.charge.resolvedHead, `${field}.charge.resolvedHead`);
      minutes(raw.charge.rebaseRunMinutes, `${field}.charge.rebaseRunMinutes`);
      minutes(raw.charge.reviewMinutes, `${field}.charge.reviewMinutes`);
    }
  }
  const changes = value.changes as ManifestChange[];
  for (const change of changes) for (const dep of change.dependsOn) {
    if (!ids.has(dep)) throw new ManifestError(`change ${change.id} dependsOn unknown id: ${dep}`);
  }
  const byId = new Map(changes.map(change => [change.id, change]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new ManifestError(`dependsOn cycle involving ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)!.dependsOn) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const change of changes) visit(change.id);
  return value as unknown as ReplayManifest;
}
