/** Read-only measurement prototype; never use this output as an authorization registry. */
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
}
export function commit(ref: string): string {
  return git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
}
export interface TreeEntry { mode: string; oid: string }
const trees = new Map<string, Map<string, TreeEntry>>();
export function tree(ref: string): Map<string, TreeEntry> {
  let entries = trees.get(ref);
  if (!entries) {
    entries = new Map(git(['ls-tree', '-rz', '--full-tree', ref]).split('\0').filter(Boolean).map(record => {
      const tab = record.indexOf('\t');
      const [mode, , oid] = record.slice(0, tab).split(' ');
      return [record.slice(tab + 1), { mode, oid }];
    }));
    trees.set(ref, entries);
  }
  return entries;
}
export function blob(entry: TreeEntry): string { return git(['cat-file', 'blob', entry.oid]); }
export const isTs = (path: string): boolean => /\.(?:ts|tsx|mts|cts)$/.test(path);
export interface Extraction {
  symbols: Map<string, string>;
  outside: string;
  fallback: string | null;
}

/** Named top-level declarations; shared variable statements share bytes, intentionally. */
export function extract(path: string, text: string): Extraction {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const symbols = new Map<string, string>();
  const seenNames = new Set<string>();
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  let fallback: string | null = diagnostics?.length ? 'parse-error' : null;
  if (text.includes('\uFFFD') || text.includes('\0')) fallback = 'ambiguous-text';
  if (/\.d\.[cm]?ts$/.test(path) || /(?:@generated|auto-generated|DO NOT EDIT)/i.test(text.slice(0, 2048))) fallback = 'generated-or-declaration';
  let outside = '';
  for (const statement of source.statements) {
    let names: string[] = [];
    if (ts.isVariableStatement(statement)) {
      names = statement.declarationList.declarations.flatMap(declaration =>
        ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
      if (names.length !== statement.declarationList.declarations.length) names = [];
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
      if (statement.name) names = [statement.name.text];
    }
    const bytes = text.slice(statement.getFullStart(), statement.end);
    // Mark declaration positions so moving an import across one is not invisible.
    outside += names.length ? `\0${JSON.stringify(names)}\0` : bytes;
    for (const name of names) {
      const key = `${ts.SyntaxKind[statement.kind]}:${name}`;
      if (seenNames.has(name)) fallback = 'duplicate-name-or-overload';
      seenNames.add(name);
      symbols.set(key, bytes);
    }
  }
  outside += text.slice(source.statements.end);
  return { symbols, outside, fallback };
}

export interface Footprint { path: string; units: string[]; reason: string }
/** No rename heuristics: both paths must be covered. Any uncertain structure consumes the file. */
export function mapDiff(base: string, head: string): Footprint[] {
  const before = tree(base), after = tree(head);
  return git(['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base, head, '--'])
    .split('\0').filter(Boolean).map(path => {
      const whole = (reason: string): Footprint => ({ path, units: [`file:${path}`], reason });
      const left = before.get(path), right = after.get(path);
      if (!left || !right) return whole(left ? 'deleted' : 'added');
      if (left.mode !== right.mode || !['100644', '100755'].includes(left.mode)) return whole('mode-or-nonregular');
      if (!isTs(path)) return whole('non-typescript');
      const a = extract(path, blob(left)), b = extract(path, blob(right));
      if (a.fallback || b.fallback) return whole(a.fallback ?? b.fallback!);
      if (JSON.stringify([...a.symbols.keys()]) !== JSON.stringify([...b.symbols.keys()])) return whole('declarations-added-deleted-or-reordered');
      if (a.outside !== b.outside) return whole('imports-or-outside-declarations');
      const units = [...a.symbols].filter(([key, bytes]) => bytes !== b.symbols.get(key))
        .map(([key]) => `ts:${path}#${key}`);
      return units.length ? { path, units, reason: 'named-declaration-bytes' } : whole('unmapped-byte-change');
    });
}

function main(): void {
  const ref = commit(process.argv[2] ?? 'origin/main');
  const start = performance.now();
  const inputs = [...tree(ref)].filter(([path, entry]) => isTs(path) && ['100644', '100755'].includes(entry.mode))
    .map(([path, entry]) => [path, blob(entry)] as const);
  const parseStart = performance.now();
  const extracted = inputs.map(([path, text]) => extract(path, text));
  console.log(`commit=${ref} node=${process.version} typescript=${ts.version}`);
  console.log(`typescript_files=${inputs.length} top_level_named_symbols=${extracted.reduce((sum, item) => sum + item.symbols.size, 0)} fallback_files=${extracted.filter(item => item.fallback).length}`);
  console.log(`extract_ms=${(performance.now() - parseStart).toFixed(2)} total_with_git_ms=${(performance.now() - start).toFixed(2)}`);
  if (process.argv[3]) {
    const head = commit(process.argv[3]), base = commit(`${head}^1`);
    console.log(`diff=${base.slice(0, 7)}..${head.slice(0, 7)} (first-parent landing delta)`);
    for (const item of mapDiff(base, head)) console.log(`${item.path}\t${item.reason}\t${item.units.join(',')}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
