import type { TrustedPolicy } from '../contracts';
import { HttpError } from '../http';

/** A policy is the only source of unit identity. Paths never become claims by parsing input. */
export interface UnitIdentity {
  key: string;
  file: string;
  resources: readonly string[];
  wholeFile: boolean;
}

export type TsvTable = NonNullable<TrustedPolicy['tables']>[number];
const tableMetadata = new WeakMap<Map<string, UnitIdentity>, TsvTable[]>();

export function declaredTables(policy: TrustedPolicy): TsvTable[] {
  if (policy.tables === undefined) return [];
  if (!Array.isArray(policy.tables) || policy.tables.length > 32) throw new Error('TABLE_POLICY_INVALID');
  const names = new Set<string>();
  const files = new Set<string>();
  for (const table of policy.tables) {
    if (!table || typeof table.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(table.name) ||
      typeof table.file !== 'string' || !validPath(table.file) || !table.file.endsWith('.tsv') ||
      !Array.isArray(table.header) || table.header.length < 2 || table.header.length > 64 ||
      !table.header.every(column => typeof column === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(column)) ||
      new Set(table.header).size !== table.header.length || !table.header.includes(table.keyColumn) ||
      typeof table.keyPattern !== 'string' || table.keyPattern.length < 3 || table.keyPattern.length > 128 ||
      !table.keyPattern.startsWith('^') || !table.keyPattern.endsWith('$') ||
      names.has(table.name) || files.has(table.file)) throw new Error('TABLE_POLICY_INVALID');
    try { new RegExp(table.keyPattern); } catch { throw new Error('TABLE_POLICY_INVALID'); }
    names.add(table.name); files.add(table.file);
  }
  return policy.tables;
}

export function patternRow(policy: TrustedPolicy, raw: string): UnitIdentity | null {
  for (const table of declaredTables(policy)) {
    const prefix = `row:${table.name}:`;
    if (!raw.startsWith(prefix)) continue;
    const key = raw.slice(prefix.length);
    if (!validKey(key) || !new RegExp(table.keyPattern).test(key)) return null;
    return { key: raw, file: table.file, resources: [`${table.file}#${key}`], wholeFile: false };
  }
  return null;
}

export function tableForFile(policy: TrustedPolicy, file: string): TsvTable | undefined {
  return declaredTables(policy).find(table => table.file === file);
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
  const tables = declaredTables(policy);
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
  for (const table of tables) {
    for (const [alias, spec] of entries) {
      if (alias.startsWith(`row:${table.name}:`) && alias !== spec.canonicalKey)
        throw new Error('TABLE_POLICY_INVALID');
    }
    for (const identity of canonical.values()) {
      if (identity.file !== table.file || !identity.key.startsWith(`row:${table.name}:`)) continue;
      const generated = patternRow(policy, identity.key);
      if (!generated || identity.wholeFile || JSON.stringify(identity.resources) !== JSON.stringify(generated.resources))
        throw new Error('TABLE_POLICY_INVALID');
    }
    const fileKey = `file:${table.file}`;
    if (!registry.has(fileKey)) registry.set(fileKey, { key: fileKey, file: table.file, resources: [], wholeFile: true });
  }
  tableMetadata.set(registry, tables);
  return registry;
}

export function resolveUnit(registry: Map<string, UnitIdentity>, raw: unknown): UnitIdentity {
  if (typeof raw !== 'string' || !validKey(raw)) throw new HttpError(422, 'UNKNOWN_UNIT', 'Unit key is not registered');
  let identity = registry.get(raw);
  if (!identity) {
    const tables = tableMetadata.get(registry) ?? [];
    for (const table of tables) {
      const prefix = `row:${table.name}:`;
      if (!raw.startsWith(prefix)) continue;
      const key = raw.slice(prefix.length);
      if (validKey(key) && new RegExp(table.keyPattern).test(key))
        identity = { key: raw, file: table.file, resources: [`${table.file}#${key}`], wholeFile: false };
      break;
    }
  }
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
  const table = tableMetadata.get(registry)?.find(item => item.file === file);
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
    if (text.includes('\r')) return null;
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    if (declared) {
      if (lines.shift() !== declared.header.join('\t')) return null;
    }
    for (const line of lines) {
      if (line === '' && text === '') continue;
      const cells = line.split('\t');
      const key = declared ? cells[declared.header.indexOf(declared.keyColumn)] : cells[0];
      if (declared && cells.length !== declared.header.length) return null;
      if (!key || table.has(key)) return null;
      table.set(key, line);
    }
    return table;
  }
  const declared = table;
  const oldRows = parse(before);
  const newRows = parse(after);
  if (!oldRows || !newRows) return [wholeFile];
  const changed = new Map<string, UnitIdentity>();
  for (const rowId of new Set([...oldRows.keys(), ...newRows.keys()])) {
    if (oldRows.get(rowId) === newRows.get(rowId)) continue;
    const identity = rowKeys.get(rowId) ?? (table ? (() => {
      try { return resolveUnit(registry, `row:${table.name}:${rowId}`); } catch { return undefined; }
    })() : undefined);
    if (!identity) return [wholeFile];
    changed.set(identity.key, identity);
  }
  return [...changed.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
