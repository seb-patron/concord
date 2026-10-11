import type { TrustedPolicy } from '../contracts';
import { HttpError } from '../http';

/** A policy is the only source of unit identity. Paths never become claims by parsing input. */
export interface UnitIdentity {
  key: string;
  file: string;
  resources: readonly string[];
  wholeFile: boolean;
}

function validPath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !path.startsWith('/') &&
    !path.includes('\\') && !/[\s\0]/.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function validKey(key: string): boolean {
  return key.length > 0 && key.length <= 512 && key.trim() === key && !/[\s\0]/.test(key);
}

/** Reject ambiguous trusted metadata rather than silently giving an alias a second identity. */
export function unitRegistry(policy: TrustedPolicy): Map<string, UnitIdentity> {
  const registry = new Map<string, UnitIdentity>();
  const canonical = new Map<string, UnitIdentity>();
  const signatures = new Map<string, string>();
  const rows = new Map<string, string>();
  const entries = Object.entries(policy.units);
  for (const [alias, spec] of entries) {
    if (!validKey(alias) || !spec || !validKey(spec.canonicalKey) ||
      !validPath(spec.file) || !Array.isArray(spec.resources) ||
      !spec.resources.every(resource => typeof resource === 'string' && validKey(resource)) ||
      !Array.isArray(spec.dependencyKeys)) throw new Error('UNIT_REGISTRY_INVALID');
    if ((alias.startsWith('file:') && (alias !== `file:${spec.file}` || spec.canonicalKey !== alias)) ||
        (spec.canonicalKey.startsWith('file:') && spec.canonicalKey !== `file:${spec.file}`)) {
      throw new Error('UNIT_REGISTRY_INVALID');
    }
    const resources = [...new Set(spec.resources)].sort();
    // Empty resources are a conservative whole-file footprint.
    const identity: UnitIdentity = {
      key: spec.canonicalKey, file: spec.file, resources,
      wholeFile: spec.canonicalKey === `file:${spec.file}` || resources.length === 0,
    };
    const signature = JSON.stringify([identity.file, identity.resources, identity.wholeFile]);
    const previous = canonical.get(identity.key);
    if (previous && JSON.stringify([previous.file, previous.resources, previous.wholeFile]) !== signature) {
      throw new Error('UNIT_REGISTRY_INVALID');
    }
    // Two canonical names for the exact same narrow footprint are ambiguous.
    if (!identity.wholeFile && signatures.has(signature) && signatures.get(signature) !== identity.key) {
      throw new Error('UNIT_REGISTRY_INVALID');
    }
    if (identity.key.startsWith('row:')) {
      const rowId = identity.key.slice(identity.key.lastIndexOf(':') + 1);
      const physicalRow = `${identity.file}\0${rowId}`;
      if (!rowId || rows.has(physicalRow) && rows.get(physicalRow) !== identity.key) {
        throw new Error('UNIT_REGISTRY_INVALID');
      }
      rows.set(physicalRow, identity.key);
    }
    signatures.set(signature, identity.key);
    canonical.set(identity.key, identity);
    registry.set(alias, identity);
  }
  for (const identity of canonical.values()) {
    const existing = registry.get(identity.key);
    if (existing && existing.key !== identity.key) throw new Error('UNIT_REGISTRY_INVALID');
    registry.set(identity.key, identity);
    const fileKey = `file:${identity.file}`;
    const fileIdentity: UnitIdentity = { key: fileKey, file: identity.file, resources: [], wholeFile: true };
    const registeredFile = registry.get(fileKey);
    if (registeredFile && (!registeredFile.wholeFile || registeredFile.file !== identity.file)) {
      throw new Error('UNIT_REGISTRY_INVALID');
    }
    registry.set(fileKey, fileIdentity);
  }
  return registry;
}

export function resolveUnit(registry: Map<string, UnitIdentity>, raw: unknown): UnitIdentity {
  if (typeof raw !== 'string' || !validKey(raw)) throw new HttpError(422, 'UNKNOWN_UNIT', 'Unit key is not registered');
  const identity = registry.get(raw);
  if (!identity) throw new HttpError(422, 'UNKNOWN_UNIT', 'Unit key is not registered', { key: raw });
  return identity;
}

export function normalizeUnits(registry: Map<string, UnitIdentity>, raw: unknown): UnitIdentity[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) {
    throw new HttpError(422, 'INVALID_UNITS', 'Supply 1 to 16 registered units');
  }
  const keys = new Map<string, UnitIdentity>();
  for (const key of raw) {
    const identity = resolveUnit(registry, key);
    keys.set(identity.key, identity);
  }
  const units = [...keys.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  if (units.length > 16) throw new HttpError(422, 'INVALID_UNITS', 'At most 16 normalized units are permitted');
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      if (overlaps(units[i], units[j])) {
        throw new HttpError(422, 'OVERLAPPING_UNITS', 'A request cannot claim overlapping units twice');
      }
    }
  }
  return units;
}

export function overlaps(a: UnitIdentity, b: UnitIdentity): boolean {
  if (a.file !== b.file) return false;
  if (a.wholeFile || b.wholeFile) return true;
  return a.resources.some(resource => b.resources.includes(resource));
}

/** Every verified write must be covered by one currently fenced claim. */
export function covers(claim: UnitIdentity, write: UnitIdentity): boolean {
  return claim.file === write.file && (claim.wholeFile ||
    (!write.wholeFile && write.resources.every(resource => claim.resources.includes(resource))));
}

/** Compare complete TSV rows by their first field; ambiguous input consumes the whole file. */
export function changedUnitsForFile(
  registry: Map<string, UnitIdentity>, file: string, before: string | null, after: string | null,
): UnitIdentity[] {
  const wholeFile = resolveUnit(registry, `file:${file}`);
  if (!file.endsWith('.tsv') || before === null || after === null ||
      (before.endsWith('\n') !== after.endsWith('\n'))) return [wholeFile];
  const rowKeys = new Map<string, UnitIdentity>();
  for (const identity of new Map([...registry.values()].map(unit => [unit.key, unit])).values()) {
    if (identity.file !== file || !identity.key.startsWith('row:') || identity.wholeFile) continue;
    const rowId = identity.key.slice(identity.key.lastIndexOf(':') + 1);
    if (!rowId || rowKeys.has(rowId) && rowKeys.get(rowId)?.key !== identity.key) return [wholeFile];
    rowKeys.set(rowId, identity);
  }
  function parse(text: string): Map<string, string> | null {
    const table = new Map<string, string>();
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    for (const line of lines) {
      if (line === '' && text === '') continue;
      const tab = line.indexOf('\t');
      const key = tab < 0 ? '' : line.slice(0, tab);
      if (!key || table.has(key)) return null;
      table.set(key, line);
    }
    return table;
  }
  const oldRows = parse(before);
  const newRows = parse(after);
  if (!oldRows || !newRows) return [wholeFile];
  const changed = new Map<string, UnitIdentity>();
  for (const rowId of new Set([...oldRows.keys(), ...newRows.keys()])) {
    if (oldRows.get(rowId) === newRows.get(rowId)) continue;
    const identity = rowKeys.get(rowId);
    if (!identity) return [wholeFile];
    changed.set(identity.key, identity);
  }
  return [...changed.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
