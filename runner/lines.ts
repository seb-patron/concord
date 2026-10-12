import type { TrustedPolicy } from '../src/contracts';

export type KeyedLinePolicy = NonNullable<TrustedPolicy['keyedLines']>[number];
export type ParsedLines = { rows: Map<string, { line: string; segment: number }>; frame: string[]; ending: boolean; segments: string[][] };

export function validLineKey(key: string, rule: KeyedLinePolicy['keyRule']): boolean {
  if (!key || /[\n\r\0]/.test(key)) return false;
  if (rule === 'c-declaration') return /^[A-Za-z_]\w*$/.test(key);
  return lineKey(key, rule) === key;
}

export function lineKey(line: string, rule: KeyedLinePolicy['keyRule']): string | null {
  if (!line.trim() || /^\s*(?:\/\/|\/\*|\*|\*\/|#)/.test(line)) return null;
  if (rule === 'whole-line') return line;
  if (rule === 'first-token') return /^\s*(\S+)/.exec(line)?.[1] ?? null;
  // Accept only simple, single-line declarations. Parenthesized declarators and
  // nested function types need a whole-file lease rather than a guessed name.
  if (/\/\*|\/\/|[{}]/.test(line) || !line.trimEnd().endsWith(';')) return null;
  const body = line.trim().slice(0, -1).trim();
  if (/\(\s*\*/.test(body)) return null;
  const prototype = /([A-Za-z_]\w*)\s*\(([^()]*)\)$/.exec(body);
  const variable = /([A-Za-z_]\w*)(?:\s*\[[^\[\]]*\])?$/.exec(body);
  const match = prototype ?? (body.includes('(') || body.includes(')') ? null : variable);
  if (!match) return null;
  const prefix = body.slice(0, match.index);
  if (!/[\s*]$/.test(prefix)) return null;
  const type = prefix.trimEnd().replace(/\*+\s*$/, '').trim();
  return /^[A-Za-z_]\w*(?:\s+[A-Za-z_]\w*)*$/.test(type) ? match[1] : null;
}

export function parseKeyedLines(text: string, policy: KeyedLinePolicy): ParsedLines | null {
  if (text.includes('\r') || text.includes('\0')) return null;
  const ending = text.endsWith('\n');
  const lines = text === '' ? [] : (ending ? text.slice(0, -1) : text).split('\n');
  const rows = new Map<string, { line: string; segment: number }>();
  const frame: string[] = [];
  const segments: string[][] = [[]];
  let inBlockComment = false;
  for (const line of lines) {
    const wasInBlockComment = inBlockComment;
    const markers = line.match(/\/\*|\*\//g) ?? [];
    for (const marker of markers) {
      if (marker === '/*') {
        if (inBlockComment) continue;
        inBlockComment = true;
      } else {
        if (!inBlockComment) return null;
        inBlockComment = false;
      }
    }
    if (!line.trim() || wasInBlockComment || markers.length || /\/\//.test(line) || /^\s*(?:\*|#)/.test(line)) {
      frame.push(line);
      segments.push([]);
      continue;
    }
    const key = lineKey(line, policy.keyRule);
    if (!key || key.length > 512 - `line:${policy.file}:`.length || !validLineKey(key, policy.keyRule) || rows.has(key)) return null;
    rows.set(key, { line, segment: frame.length });
    segments[frame.length].push(key);
  }
  if (inBlockComment) return null;
  return { rows, frame, ending, segments };
}

export function keyedLineChanges(base: string, next: string, policy: KeyedLinePolicy): { before: ParsedLines; after: ParsedLines; keys: string[] } | null {
  const before = parseKeyedLines(base, policy);
  const after = parseKeyedLines(next, policy);
  if (!before || !after || before.ending !== after.ending || JSON.stringify(before.frame) !== JSON.stringify(after.frame)) return null;
  for (const [key, value] of before.rows) {
    if (after.rows.has(key) && after.rows.get(key)!.segment !== value.segment) return null;
  }
  const keys = [...new Set([...before.rows.keys(), ...after.rows.keys()])].filter(key => before.rows.get(key)?.line !== after.rows.get(key)?.line);
  if (policy.order === 'sorted') {
    const ordered = [...after.rows.keys()];
    if (ordered.some((key, i) => i > 0 && ordered[i - 1] > key)) return null;
  } else {
    const ordered = [...after.rows.keys()];
    const retained = ordered.filter(key => before.rows.has(key));
    if (ordered.slice(0, retained.length).some((key, i) => key !== retained[i])) return null;
  }
  // A candidate that merely reorders existing lines has no keyed write.
  for (let segment = 0; segment < before.segments.length; segment++) {
    const retained = after.segments[segment].filter(key => before.rows.has(key));
    if (JSON.stringify(retained) !== JSON.stringify(before.segments[segment].filter(key => after.rows.has(key)))) return null;
    if (policy.order === 'append' && after.segments[segment].slice(0, retained.length).some((key, i) => key !== retained[i])) return null;
    if (policy.order === 'sorted' && after.segments[segment].some((key, i, all) => i > 0 && all[i - 1] > key)) return null;
  }
  return { before, after, keys };
}

export function mergeKeyedLines(base: string, ours: string, theirs: string, policy: KeyedLinePolicy): string {
  const left = keyedLineChanges(base, ours, policy);
  const right = keyedLineChanges(base, theirs, policy);
  if (!left || !right) throw new Error('KEYED_LINE_CONFLICT');
  if (left.keys.some(key => right.keys.includes(key))) throw new Error('KEYED_LINE_CONFLICT');
  const { before } = left;
  const output: string[] = [];
  let previousKey: string | undefined;
  for (let segment = 0; segment < before.segments.length; segment++) {
    const entries = new Map<string, string>();
    for (const key of before.segments[segment]) {
      const chosen = right.keys.includes(key) ? right.after.rows.get(key) :
        left.keys.includes(key) ? left.after.rows.get(key) : before.rows.get(key);
      if (chosen) entries.set(key, chosen.line);
    }
    const additions = (source: typeof left) => source.after.segments[segment].filter(key => !before.rows.has(key));
    for (const key of [...additions(left), ...additions(right)]) {
      const row = left.after.rows.get(key) ?? right.after.rows.get(key);
      if (row) entries.set(key, row.line);
    }
    const keys = policy.order === 'sorted' ? [...entries.keys()].sort() : [...entries.keys()];
    if (policy.order === 'sorted') {
      for (const key of keys) {
        if (previousKey !== undefined && previousKey > key) throw new Error('KEYED_LINE_CONFLICT');
        previousKey = key;
      }
    }
    output.push(...keys.map(key => entries.get(key)!));
    if (segment < before.frame.length) output.push(before.frame[segment]);
  }
  return output.join('\n') + (before.ending ? '\n' : '');
}
