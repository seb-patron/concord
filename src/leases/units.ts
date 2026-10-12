import type { TrustedPolicy } from '../contracts';
import { HttpError } from '../http';
import { compatibleSections, parseMarkdown } from '../../runner/markdown';

/** A policy is the only source of unit identity. Paths never become claims by parsing input. */
export interface UnitIdentity {
  key: string;
  file: string;
  resources: readonly string[];
  wholeFile: boolean;
}

export type TsvTable = NonNullable<TrustedPolicy['tables']>[number];
const tableMetadata = new WeakMap<Map<string, UnitIdentity>, TsvTable[]>();
export type MarkdownDeclaration = NonNullable<TrustedPolicy['markdown']>[number];
const markdownMetadata = new WeakMap<Map<string, UnitIdentity>, MarkdownDeclaration[]>();

export function declaredMarkdown(policy: TrustedPolicy): MarkdownDeclaration[] {
  if (policy.markdown === undefined) return [];
  if (!Array.isArray(policy.markdown) || policy.markdown.length > 128) throw new Error('MARKDOWN_POLICY_INVALID');
  const files = new Set<string>();
  for (const item of policy.markdown) {
    if (!item || Object.keys(item).sort().join(',') !== 'file,headingLevel' ||
      typeof item.file !== 'string' || !validPath(item.file) || !item.file.endsWith('.md') ||
      !Number.isInteger(item.headingLevel) || item.headingLevel < 1 || item.headingLevel > 6 || files.has(item.file))
      throw new Error('MARKDOWN_POLICY_INVALID');
    files.add(item.file);
  }
  if (declaredTables(policy).some(item => files.has(item.file))) throw new Error('MARKDOWN_POLICY_INVALID');
  return policy.markdown;
}

export function markdownForFile(policy: TrustedPolicy, file: string): MarkdownDeclaration | undefined {
  return declaredMarkdown(policy).find(item => item.file === file);
}

export function patternSection(policy: TrustedPolicy, raw: string): UnitIdentity | null {
  for (const item of declaredMarkdown(policy)) {
    const prefix = `section:${item.file}:`;
    if (!raw.startsWith(prefix)) continue;
    const slug = raw.slice(prefix.length);
    if (!slug || slug.length > 256 || !/^[\p{L}\p{N}\p{M}_-]+$/u.test(slug) || slug !== slug.toLowerCase()) return null;
    return { key: raw, file: item.file, resources: [`${item.file}#${slug}`], wholeFile: false };
  }
  return null;
}

export function matchesTableKey(table: TsvTable, key: string): boolean {
  const spec = table.keySpec;
  if (key.length < spec.minLength || key.length > spec.maxLength) return false;
  const chars = Array.isArray(spec.charset) ? new Set(spec.charset) : null;
  for (const char of key) {
    if (chars ? !chars.has(char) :
      spec.charset === 'lower' ? char < 'a' || char > 'z' :
      spec.charset === 'alnum' ? !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9') :
      !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || char === '-' || char === '.')) return false;
  }
  return true;
}

function validKeySpec(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const spec = value as TsvTable['keySpec'];
  if (Object.keys(spec).sort().join(',') !== 'charset,maxLength,minLength' ||
    !Number.isSafeInteger(spec.minLength) || spec.minLength < 1 ||
    !Number.isSafeInteger(spec.maxLength) || spec.maxLength < spec.minLength || spec.maxLength > 256) return false;
  if (Array.isArray(spec.charset)) return spec.charset.length > 0 && spec.charset.length <= 256 &&
    new Set(spec.charset).size === spec.charset.length && spec.charset.every(char =>
      typeof char === 'string' && char.length === 1 && char >= '!' && char <= '~');
  return spec.charset === 'lower' || spec.charset === 'alnum' || spec.charset === 'alnum-dash-dot';
}

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
      names.has(table.name) || files.has(table.file)) throw new Error('TABLE_POLICY_INVALID');
    if (Object.keys(table).sort().join(',') !== 'file,header,keyColumn,keySpec,name' || !validKeySpec(table.keySpec))
      throw new Error('TABLE_KEY_SPEC_INVALID');
    names.add(table.name); files.add(table.file);
  }
  return policy.tables;
}

export function patternRow(policy: TrustedPolicy, raw: string): UnitIdentity | null {
  for (const table of declaredTables(policy)) {
    const prefix = `row:${table.name}:`;
    if (!raw.startsWith(prefix)) continue;
    const key = raw.slice(prefix.length);
    if (!validKey(key) || !matchesTableKey(table, key)) return null;
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
  const markdown = declaredMarkdown(policy);
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
    if (identity.key.startsWith('section:')) {
      const generated = patternSection(policy, identity.key);
      if (!generated || generated.file !== identity.file || identity.wholeFile ||
        JSON.stringify(identity.resources) !== JSON.stringify(generated.resources)) throw new Error('MARKDOWN_POLICY_INVALID');
    }
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
      const table = tables.find(item => identity.key.startsWith(`row:${item.name}:`) && item.file === identity.file);
      const rowId = table ? identity.key.slice(`row:${table.name}:`.length) : identity.key.slice(identity.key.lastIndexOf(':') + 1);
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
  for (const item of markdown) {
    const prefix = `section:${item.file}:`;
    for (const [alias, spec] of entries) if (alias.startsWith(prefix) && alias !== spec.canonicalKey)
      throw new Error('MARKDOWN_POLICY_INVALID');
    for (const identity of canonical.values()) {
      if (identity.file !== item.file || !identity.key.startsWith('section:')) continue;
      const generated = patternSection(policy, identity.key);
      if (!generated || identity.wholeFile || JSON.stringify(identity.resources) !== JSON.stringify(generated.resources))
        throw new Error('MARKDOWN_POLICY_INVALID');
    }
    const fileKey = `file:${item.file}`;
    if (!registry.has(fileKey)) registry.set(fileKey, { key: fileKey, file: item.file, resources: [], wholeFile: true });
  }
  tableMetadata.set(registry, tables);
  markdownMetadata.set(registry, markdown);
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
      if (validKey(key) && matchesTableKey(table, key))
        identity = { key: raw, file: table.file, resources: [`${table.file}#${key}`], wholeFile: false };
      break;
    }
  }
  if (!identity) {
    for (const item of markdownMetadata.get(registry) ?? []) {
      if (!raw.startsWith(`section:${item.file}:`)) continue;
      const slug = raw.slice(`section:${item.file}:`.length);
      if (slug && slug.length <= 256 && /^[\p{L}\p{N}\p{M}_-]+$/u.test(slug) && slug === slug.toLowerCase())
        identity = { key: raw, file: item.file, resources: [`${item.file}#${slug}`], wholeFile: false };
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
  const markdown = markdownMetadata.get(registry)?.find(item => item.file === file);
  if (markdown) {
    if (before === null || after === null) return [wholeFile];
    const oldSections = parseMarkdown(before, markdown.headingLevel);
    const newSections = parseMarkdown(after, markdown.headingLevel);
    if (!oldSections || !newSections || !compatibleSections(oldSections, newSections)) return [wholeFile];
    const old = new Map(oldSections.map(item => [item.slug, item.content]));
    const changed: UnitIdentity[] = [];
    for (const section of newSections) {
      if (old.get(section.slug) === section.content) continue;
      try { changed.push(resolveUnit(registry, `section:${file}:${section.slug}`)); }
      catch { return [wholeFile]; }
    }
    return changed.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }
  if (!file.endsWith('.tsv') || before === null || after === null ||
      (before.endsWith('\n') !== after.endsWith('\n'))) return [wholeFile];
  const rowKeys = new Map<string, UnitIdentity>();
  for (const identity of new Map([...registry.values()].map(unit => [unit.key, unit])).values()) {
    if (identity.file !== file || !identity.key.startsWith('row:') || identity.wholeFile) continue;
    const prefix = table && `row:${table.name}:`;
    const rowId = prefix && identity.key.startsWith(prefix) ? identity.key.slice(prefix.length) : identity.key.slice(identity.key.lastIndexOf(':') + 1);
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
      if (!key || declared && !matchesTableKey(declared, key) || table.has(key)) return null;
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
