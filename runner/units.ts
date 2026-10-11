import { createHash } from 'node:crypto';
import type { ChangedUnitEvidence, Digest, Job, ReviewManifest, TrustedPolicy, UnitDependencyScopeEntry } from '../src/contracts';
import { stableJson } from '../src/http';
import { command, git, treeOid } from './git';

const hash = (value: string | Buffer): Digest => ('sha256:' + createHash('sha256').update(value).digest('hex')) as Digest;
const rowId = (unit: string) => /^row:families:([a-z]+)$/.exec(unit)?.[1] ?? null;
const decode = (bytes: Buffer): string | null => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
};

export function parseTsv(text: string): Map<string, string> {
  if (text.includes('\r')) throw new Error('INVALID_TSV_LINE_ENDING');
  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split(/\r?\n/);
  const header = lines.shift();
  if (header !== 'family\tretry_limit\ttimeout_ms') throw new Error('INVALID_TSV_HEADER');
  const rows = new Map<string, string>();
  for (const line of lines) {
    const cells = line.split('\t');
    if (cells.length !== 3 || !/^[a-z]+$/.test(cells[0]) || rows.has(cells[0])) throw new Error('INVALID_TSV_ROW');
    rows.set(cells[0], line);
  }
  return rows;
}

export function mergeTsv(base: string, ours: string, theirs: string): string {
  const b = parseTsv(base);
  const o = parseTsv(ours);
  const t = parseTsv(theirs);
  const keys = [...new Set([...b.keys(), ...o.keys(), ...t.keys()])];
  const output = ['family\tretry_limit\ttimeout_ms'];
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

async function content(repo: string, oid: string | null, path: string): Promise<Buffer | null> {
  if (!oid) return null;
  const result = await command('git', ['show', oid + ':' + path], repo, 30_000);
  if (result.code !== 0) return null;
  if (result.truncated) throw new Error('EVIDENCE_TOO_LARGE');
  return result.stdoutBytes;
}

async function mode(repo: string, oid: string | null, path: string): Promise<string | null> {
  if (!oid) return null;
  const output = await git(repo, ['ls-tree', oid, '--', path]);
  return /^([0-7]{6})\s/.exec(output)?.[1] ?? null;
}

async function changedPaths(repo: string, base: string | null, head: string): Promise<string[]> {
  const args = base ? ['diff', '--no-renames', '--name-only', base, head, '--'] : ['diff-tree', '--no-renames', '--root', '--no-commit-id', '--name-only', '-r', head];
  const result = await command('git', args, repo, 30_000);
  if (result.code !== 0 || result.truncated) throw new Error('DIFF_UNAVAILABLE');
  return result.stdout.trim().split('\n').filter(Boolean).sort();
}

export async function inspectUnits(repo: string, base: string | null, head: string, job: Job): Promise<{ unitKeys: string[]; manifest: ReviewManifest; digest: Digest }> {
  const policy: TrustedPolicy = job.unitPolicy;
  const evidence: ChangedUnitEvidence[] = [];
  let coverage: 'complete' | 'unknown' = 'complete';
  const paths = await changedPaths(repo, base, head);
  for (const path of paths) {
    const before = await content(repo, base, path);
    const after = await content(repo, head, path);
    const beforeMode = await mode(repo, base, path);
    const afterMode = await mode(repo, head, path);
    const units = Object.entries(policy.units).filter(([, value]) => value.file === path);
    const rowUnits = units.filter(([key]) => rowId(key));
    const beforeText = before && decode(before);
    const afterText = after && decode(after);
    if (path === 'families.tsv' && rowUnits.length && beforeText !== null && afterText !== null && beforeMode === afterMode) {
      let oldRows: Map<string, string> | null = null;
      let newRows: Map<string, string> | null = null;
      try { oldRows = parseTsv(beforeText); newRows = parseTsv(afterText); } catch { coverage = 'unknown'; }
      if (oldRows && newRows) {
      const changed = [...new Set([...oldRows.keys(), ...newRows.keys()])].filter(key => oldRows.get(key) !== newRows.get(key));
      if (changed.length > 0 && changed.every(row => rowUnits.some(([key]) => rowId(key) === row))) {
        for (const row of changed) {
          const known = rowUnits.find(([key]) => rowId(key) === row)!;
        evidence.push({ unitKey: known[1].canonicalKey, beforePath: path, afterPath: path,
          beforeMode, afterMode, beforeDigest: oldRows.has(row) ? hash(oldRows.get(row)!) : null,
          afterDigest: newRows.has(row) ? hash(newRows.get(row)!) : null });
        }
        continue;
      }
      }
    }
    const fileUnit = units.find(([key]) => key.startsWith('file:'));
    if (!fileUnit) coverage = 'unknown';
    evidence.push({ unitKey: fileUnit?.[1].canonicalKey ?? 'file:' + path,
      beforePath: before === null ? null : path, afterPath: after === null ? null : path,
      beforeMode, afterMode, beforeDigest: before === null ? null : hash(before), afterDigest: after === null ? null : hash(after) });
  }
  evidence.sort((a, b) => a.unitKey.localeCompare(b.unitKey));
  const dependencyScope: UnitDependencyScopeEntry[] = [];
  if (coverage === 'complete') {
    const dependencies = new Set(evidence.flatMap(item => Object.values(policy.units).find(unit => unit.canonicalKey === item.unitKey)?.dependencyKeys ?? []));
    for (const key of [...dependencies].sort()) {
      const unit = policy.units[key];
      if (!unit) { coverage = 'unknown'; break; }
      const bytes = await content(repo, head, unit.file);
      const fileMode = await mode(repo, head, unit.file);
      if (bytes === null || fileMode === null) { coverage = 'unknown'; break; }
      const row = rowId(key);
      const decoded = row ? decode(bytes) : null;
      let evidenceBytes: string | Buffer | undefined = row ? undefined : bytes;
      if (row && decoded !== null) {
        try { evidenceBytes = parseTsv(decoded).get(row); } catch { /* Unknown scope below. */ }
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
  return { unitKeys: [...new Set(evidence.map(item => item.unitKey))], manifest, digest: hash(stableJson(manifest)) };
}
