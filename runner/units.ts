import { createHash } from 'node:crypto';
import type { ChangedUnitEvidence, Digest, Job, ReviewManifest, TrustedPolicy, UnitDependencyScopeEntry } from '../src/contracts';
import { stableJson } from '../src/http';
import { compareKeys, trustedDependencyKeys } from '../src/verdicts/manifest';
import { matchesTableKey, patternRow, prefixFileUnit, tableForFile, type TsvTable } from '../src/leases/units';
import { command, git, MAX_INSPECTED_BLOB_BYTES, treeOid } from './git';

const hash = (value: string | Buffer): Digest => ('sha256:' + createHash('sha256').update(value).digest('hex')) as Digest;
const legacyTable: TsvTable = { name: 'families', file: 'families.tsv', header: ['family', 'retry_limit', 'timeout_ms'], keyColumn: 'family', keySpec: { charset: 'lower', minLength: 1, maxLength: 256 } };
const rowId = (unit: string, table: TsvTable) => unit.startsWith(`row:${table.name}:`) ? unit.slice(`row:${table.name}:`.length) : null;
const supportedMode = (value: string | null): boolean => value === null || value === '100644' || value === '100755';
const decode = (bytes: Buffer): string | null => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
};

export function parseTsv(text: string, table: TsvTable = legacyTable): Map<string, string> {
  if (text.includes('\r')) throw new Error('INVALID_TSV_LINE_ENDING');
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split(/\r?\n/);
  const header = lines.shift();
  if (header !== table.header.join('\t')) throw new Error('INVALID_TSV_HEADER');
  const rows = new Map<string, string>();
  for (const line of lines) {
    const cells = line.split('\t');
    const key = cells[table.header.indexOf(table.keyColumn)];
    if (cells.length !== table.header.length || !key || !matchesTableKey(table, key) || rows.has(key)) throw new Error('INVALID_TSV_ROW');
    rows.set(key, line);
  }
  return rows;
}

export function mergeTsv(base: string, ours: string, theirs: string, table: TsvTable = legacyTable): string {
  const b = parseTsv(base, table);
  const o = parseTsv(ours, table);
  const t = parseTsv(theirs, table);
  const keys = [...new Set([...b.keys(), ...o.keys(), ...t.keys()])];
  const output = [table.header.join('\t')];
  for (const key of keys) {
    const before = b.get(key);
    const left = o.get(key);
    const right = t.get(key);
    if (left !== before && right !== before && left !== right) throw new Error('TSV_COLLISION:' + key);
    const chosen = right !== before ? right : left;
    if (chosen !== undefined) output.push(chosen);
  }
  return output.join('\n') + '\n';
}

async function content(repo: string, oid: string | null, path: string, maxBytes: number): Promise<Buffer | null> {
  if (!oid) return null;
  const result = await command('git', ['show', oid + ':' + path], repo, 30_000, undefined, undefined, maxBytes);
  if (result.truncated) throw new Error('EVIDENCE_TOO_LARGE');
  if (result.code !== 0) return null;
  return result.stdoutBytes;
}

async function mode(repo: string, oid: string | null, path: string): Promise<string | null> {
  if (!oid) return null;
  const output = await git(repo, ['ls-tree', oid, '--', path]);
  return /^([0-7]{6})\s/.exec(output)?.[1] ?? null;
}

async function changedPaths(repo: string, base: string | null, head: string): Promise<string[]> {
  const args = base ? ['diff', '--no-renames', '--name-only', '-z', base, head, '--'] :
    ['diff-tree', '--no-renames', '--root', '--no-commit-id', '--name-only', '-z', '-r', head];
  const result = await command('git', args, repo, 30_000);
  if (result.code !== 0 || result.truncated) throw new Error('DIFF_UNAVAILABLE');
  const raw = result.stdoutBytes;
  if (raw.length && raw[raw.length - 1] !== 0) throw new Error('DIFF_UNAVAILABLE');
  const paths: string[] = [];
  for (let start = 0; start < raw.length;) {
    const end = raw.indexOf(0, start);
    if (end === start) throw new Error('DIFF_UNAVAILABLE');
    try { paths.push(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.subarray(start, end))); }
    catch { throw new Error('DIFF_PATH_ENCODING_INVALID'); }
    start = end + 1;
  }
  return paths.sort(compareKeys);
}

export async function inspectUnits(repo: string, base: string | null, head: string, job: Job,
  maxInspectedBlobBytes = MAX_INSPECTED_BLOB_BYTES): Promise<{ unitKeys: string[]; manifest: ReviewManifest; digest: Digest }> {
  if (!Number.isSafeInteger(maxInspectedBlobBytes) || maxInspectedBlobBytes < 1 || maxInspectedBlobBytes > MAX_INSPECTED_BLOB_BYTES)
    throw new Error('INVALID_INSPECTION_LIMIT');
  const policy: TrustedPolicy = job.unitPolicy;
  const evidence: ChangedUnitEvidence[] = [];
  let coverage: 'complete' | 'unknown' = 'complete';
  const paths = await changedPaths(repo, base, head);
  for (const path of paths) {
    const before = await content(repo, base, path, maxInspectedBlobBytes);
    const after = await content(repo, head, path, maxInspectedBlobBytes);
    const beforeMode = await mode(repo, base, path);
    const afterMode = await mode(repo, head, path);
    if (!supportedMode(beforeMode) || !supportedMode(afterMode)) {
      throw new Error('UNSUPPORTED_TREE_ENTRY');
    }
    const units = Object.entries(policy.units).filter(([, value]) => value.file === path);
    const table = tableForFile(policy, path) ?? (path === 'families.tsv' && units.some(([key]) => rowId(key, legacyTable)) ? legacyTable : undefined);
    const rowUnits = table ? units.filter(([key]) => rowId(key, table)) : [];
    const beforeText = before && decode(before);
    const afterText = after && decode(after);
    if (table && beforeText !== null && afterText !== null && beforeMode !== null && beforeMode === afterMode &&
      beforeText.endsWith('\n') === afterText.endsWith('\n')) {
      let oldRows: Map<string, string> | null = null;
      let newRows: Map<string, string> | null = null;
      try { oldRows = parseTsv(beforeText, table); newRows = parseTsv(afterText, table); } catch { coverage = 'unknown'; }
      if (oldRows && newRows) {
      const changed = [...new Set([...oldRows.keys(), ...newRows.keys()])].filter(key => oldRows.get(key) !== newRows.get(key));
      if (changed.length > 0 && changed.every(row => rowUnits.some(([key]) => rowId(key, table) === row) || !!patternRow(policy, `row:${table.name}:${row}`))) {
        for (const row of changed) {
          const known = rowUnits.find(([key]) => rowId(key, table) === row);
        evidence.push({ unitKey: known?.[1].canonicalKey ?? `row:${table.name}:${row}`,
          beforePath: oldRows.has(row) ? path : null, afterPath: newRows.has(row) ? path : null,
          beforeMode: oldRows.has(row) ? beforeMode : null, afterMode: newRows.has(row) ? afterMode : null,
          beforeDigest: oldRows.has(row) ? hash(oldRows.get(row)!) : null,
          afterDigest: newRows.has(row) ? hash(newRows.get(row)!) : null });
        }
        continue;
      }
      }
    }
    const fileUnit = units.find(([key]) => key === 'file:' + path);
    if (!fileUnit && !table && !prefixFileUnit(policy, `file:${path}`)) coverage = 'unknown';
    evidence.push({ unitKey: fileUnit?.[1].canonicalKey ?? 'file:' + path,
      beforePath: before === null ? null : path, afterPath: after === null ? null : path,
      beforeMode, afterMode, beforeDigest: before === null ? null : hash(before), afterDigest: after === null ? null : hash(after) });
  }
  evidence.sort((a, b) => compareKeys(a.unitKey, b.unitKey));
  const dependencyScope: UnitDependencyScopeEntry[] = [];
  if (coverage === 'complete') {
    let dependencies: string[] = [];
    try { dependencies = trustedDependencyKeys(policy, evidence.map(item => item.unitKey)); }
    catch { coverage = 'unknown'; }
    for (const key of dependencies) {
      const unit = policy.units[key] ?? patternRow(policy, key);
      if (!unit) { coverage = 'unknown'; break; }
      const bytes = await content(repo, head, unit.file, maxInspectedBlobBytes);
      const fileMode = await mode(repo, head, unit.file);
      if (!supportedMode(fileMode)) throw new Error('UNSUPPORTED_TREE_ENTRY');
      if (bytes === null || fileMode === null) { coverage = 'unknown'; break; }
      const dependencyTable = tableForFile(policy, unit.file) ?? (unit.file === 'families.tsv' ? legacyTable : undefined);
      const row = dependencyTable && rowId(key, dependencyTable);
      const decoded = row ? decode(bytes) : null;
      let evidenceBytes: string | Buffer | undefined = row ? undefined : bytes;
      if (row && decoded !== null) {
        try { evidenceBytes = parseTsv(decoded, dependencyTable!).get(row); } catch { /* Unknown scope below. */ }
      }
      if (evidenceBytes === undefined) { coverage = 'unknown'; break; }
      dependencyScope.push({ kind: 'unit', unitKey: unit.canonicalKey, path: unit.file, mode: fileMode, contentDigest: hash(evidenceBytes) });
    }
  }
  const common = { changedUnits: evidence, policyVersion: policy.version, policyDigest: job.policyDigest,
    checkerDigest: job.checkerDigest, oracleDigest: job.oracleDigest, toolchainDigest: job.toolchainDigest };
  const manifest: ReviewManifest = coverage === 'complete'
    ? { ...common, coverage, dependencyScope }
    : { ...common, coverage: 'unknown', dependencyScope: [{ kind: 'tree', treeOid: await treeOid(repo, head) }] };
  return { unitKeys: [...new Set(evidence.map(item => item.unitKey))].sort(compareKeys), manifest, digest: hash(stableJson(manifest)) };
}
