import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

type Decision = { id: string; title: string };
type Row = { id: string; check: string; argument: string; expected: string; nextAction: string };
const headers = ['id', 'check', 'argument', 'expected', 'next_action'];

function malformed(message: string): never {
  console.error(`Invalid decision records: ${message}`);
  process.exitCode = 2;
  throw new Error(message);
}

function parseDecisions(text: string): Map<string, Decision> {
  const sections = [...text.matchAll(/^## (D-[A-Z0-9-]+) — (.+)$/gm)];
  if (!sections.length) malformed('no decision sections found');
  const decisions = new Map<string, Decision>();
  for (let i = 0; i < sections.length; i++) {
    const [, id, title] = sections[i];
    if (decisions.has(id)) malformed(`duplicate decision ID ${id}`);
    const start = sections[i].index! + sections[i][0].length;
    const end = sections[i + 1]?.index ?? text.length;
    const body = text.slice(start, end);
    const fields = [
      /^- \*\*Date(?: \(CT\))?:\*\*\s*\S/m,
      /^- \*\*Owner(?:'|’)?s? words:\*\*\s*\S/m,
      /^- \*\*Decision:\*\*\s*\S/m,
      /^- \*\*Status:\*\*\s*\S/m,
      /^- \*\*Source:\*\*\s*\S/m,
    ];
    if (fields.some(field => !field.test(body))) malformed(`${id} is missing or has an invalid required field`);
    decisions.set(id, { id, title: title.trim() });
  }
  return decisions;
}

function parseRows(text: string): Map<string, Row> {
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== headers.join('\t')) malformed('status TSV header must be id, check, argument, expected, next_action');
  const rows = new Map<string, Row>();
  for (const [index, line] of lines.entries()) {
    if (!line) malformed(`blank status row at line ${index + 2}`);
    const columns = line.split('\t');
    if (columns.length !== headers.length || columns.some(column => !column.trim())) malformed(`malformed status row at line ${index + 2}`);
    const [id, check, argument, expected, nextAction] = columns;
    if (!/^D-[A-Z0-9-]+$/.test(id)) malformed(`invalid decision ID at line ${index + 2}`);
    if (rows.has(id)) malformed(`duplicate status ID ${id}`);
    if (!['test', 'file', 'route', 'manual'].includes(check)) malformed(`unknown check kind ${check}`);
    if (check === 'manual' && !expected.trim()) malformed(`invalid manual status for ${id}`);
    if (check === 'file' && !['present', 'absent'].includes(expected)) malformed(`invalid file expectation for ${id}`);
    if (check === 'route' && !['registered', 'absent'].includes(expected)) malformed(`invalid route expectation for ${id}`);
    if (check === 'test' && expected !== 'pass') malformed(`invalid test expectation for ${id}`);
    if (check === 'file' && !argument.includes(':')) malformed(`file check needs path:regex for ${id}`);
    if (check === 'route' && !/^[A-Z]+ \/\S+$/.test(argument)) malformed(`route check needs METHOD /path for ${id}`);
    rows.set(id, { id, check, argument, expected, nextAction });
  }
  if (!rows.size) malformed('no status rows found');
  return rows;
}

async function existsTest(root: string, argument: string): Promise<boolean> {
  const testRoot = join(root, 'tests');
  const file = resolve(root, argument);
  if (file.startsWith(`${testRoot}/`)) {
    try { await readFile(file); return true; } catch { /* the recorded test file may no longer exist */ }
  }
  const search = async (directory: string): Promise<boolean> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (await search(path)) return true; }
      else if (entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
        if ((await readFile(path, 'utf8')).includes(argument)) return true;
      }
    }
    return false;
  };
  return search(testRoot);
}

async function routeExists(root: string, argument: string): Promise<boolean> {
  const split = argument.indexOf(' ');
  const method = argument.slice(0, split);
  const path = argument.slice(split + 1).replace(/:[^/]+/g, 'example');
  const source = async (directory: string): Promise<string[]> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
    const files = await Promise.all(entries.map(async entry => {
      const item = join(directory, entry.name);
      return entry.isDirectory() ? source(item) : entry.isFile() && /\.tsx?$/.test(entry.name) ? [await readFile(item, 'utf8')] : [];
    }));
    return files.flat();
  };
  const sources = await source(join(root, 'src'));
  return sources.some(file => {
    const routeEntry = /\{\s*method:\s*(['"])([A-Z]+)\1\s*,\s*pattern:\s*\//g;
    for (const match of file.matchAll(routeEntry)) {
      if (match[2] !== method) continue;
      const start = match.index! + match[0].length;
      let end = start;
      let inCharacterClass = false;
      let escaped = false;
      for (; end < file.length; end++) {
        const character = file[end];
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '[') inCharacterClass = true;
        else if (character === ']') inCharacterClass = false;
        else if (character === '/' && !inCharacterClass) break;
      }
      if (end === file.length) continue;
      const flags = /^[a-z]*/.exec(file.slice(end + 1))![0];
      try {
        const pattern = new RegExp(file.slice(start, end), flags);
        if (pattern.test(path)) return true;
      } catch { /* malformed or non-route source fragment */ }
    }
    return false;
  });
}

async function checkRow(root: string, row: Row): Promise<boolean> {
  if (row.check === 'manual') return /^None(?:\.|\s|$)/.test(row.nextAction.trim());
  if (row.check === 'test') return existsTest(root, row.argument);
  if (row.check === 'file') {
    const separator = row.argument.indexOf(':');
    const path = join(root, row.argument.slice(0, separator));
    const rawPattern = row.argument.slice(separator + 1).replace(/^(['"])(.*)\1$/, '$2');
    let pattern: RegExp;
    try { pattern = new RegExp(rawPattern, 'm'); } catch { malformed(`invalid file regex for ${row.id}`); }
    let contents: string | undefined;
    try {
      contents = await readFile(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw new Error(`cannot read file for ${row.id}: ${code ?? 'unknown error'}`);
    }
    const found = contents !== undefined && pattern.test(contents);
    return row.expected === 'present' ? found : !found;
  }
  const found = await routeExists(root, row.argument);
  return row.expected === 'registered' ? found : !found;
}

export async function main(root = process.env.DECISIONS_ROOT ?? process.cwd()): Promise<void> {
  try {
    const [decisionText, statusText] = await Promise.all([
      readFile(join(root, 'docs/decisions.md'), 'utf8'),
      readFile(join(root, 'docs/decision-status.tsv'), 'utf8'),
    ]);
    const decisions = parseDecisions(decisionText);
    const rows = parseRows(statusText);
    for (const id of decisions.keys()) if (!rows.has(id)) malformed(`missing status row for ${id}`);
    for (const id of rows.keys()) if (!decisions.has(id)) malformed(`status row has no decision ${id}`);
    const pending: Array<{ decision: Decision; action: string }> = [];
    const states: Array<{ id: string; state: string }> = [];
    for (const row of rows.values()) {
      const live = await checkRow(root, row);
      states.push({ id: row.id, state: row.check === 'manual' ? row.expected : live ? 'live' : 'not live' });
      if (!live && (row.check !== 'manual' || !/^None(?:\.|\s|$)/.test(row.nextAction.trim()))) {
        pending.push({ decision: decisions.get(row.id)!, action: row.nextAction });
      }
    }
    console.log('Decision status:');
    for (const { id, state } of states) console.log(`${id} — ${state}`);
    console.log('Approved but not live:');
    for (const { decision, action } of pending) console.log(`${decision.id} — ${decision.title} — ${action}`);
  } catch (error) {
    if (process.exitCode !== 2) {
      console.error(`Invalid decision records: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) await main();
