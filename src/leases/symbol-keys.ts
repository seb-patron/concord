/**
 * Shared, runtime-neutral keys for Git-selected funcname lines.
 *
 * Signature edits and Markdown heading-level changes deliberately widen to
 * file scope because the complete selected line is part of the key.
 */

const SAFE_NAME_BYTE = /^[A-Za-z0-9._~-]$/;
const CONTROL = /\p{Cc}/u;
const MAX_KEY_BYTES = 512;

export interface SymbolInterval {
  /** Canonical result of symbolKey(path, selectedHeader). */
  key: string;
  /** 1-based inclusive first line. */
  startLine: number;
  /** 1-based exclusive final line; EOF is represented by EOF + 1. */
  endLine: number;
}

export interface SymbolEdit {
  /** 1-based half-open line range removed from the before file. */
  beforeStart: number;
  beforeEnd: number;
  /** 1-based half-open line range added to the after file. */
  afterStart: number;
  afterEnd: number;
}

function utf8Bytes(value: string): number[] | null {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const first = value.charCodeAt(i);
    let point = first;
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(++i);
      if (!(second >= 0xdc00 && second <= 0xdfff)) return null;
      point = 0x10000 + ((first - 0xd800) << 10) + second - 0xdc00;
    } else if (first >= 0xdc00 && first <= 0xdfff) return null;

    if (point <= 0x7f) bytes.push(point);
    else if (point <= 0x7ff) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
    else if (point <= 0xffff) bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
    else bytes.push(0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
  }
  return bytes;
}

function utf8String(bytes: readonly number[]): string | null {
  let result = '';
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++];
    let point: number;
    let remaining: number;
    let minimum: number;
    if (first <= 0x7f) { point = first; remaining = 0; minimum = 0; }
    else if (first >= 0xc2 && first <= 0xdf) { point = first & 0x1f; remaining = 1; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { point = first & 0x0f; remaining = 2; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { point = first & 0x07; remaining = 3; minimum = 0x10000; }
    else return null;
    if (i + remaining > bytes.length) return null;
    for (let j = 0; j < remaining; j++) {
      const next = bytes[i++];
      if ((next & 0xc0) !== 0x80) return null;
      point = (point << 6) | (next & 0x3f);
    }
    if (point < minimum || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) return null;
    result += point <= 0xffff ? String.fromCharCode(point) : String.fromCodePoint(point);
  }
  return result;
}

function validPath(path: string): boolean {
  return path.length > 0 && path.normalize('NFC') === path && !path.startsWith('/') &&
    !path.includes('\\') && !/[\s\0]/u.test(path) && !CONTROL.test(path) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part !== '.git');
}

function validName(name: string): boolean {
  return name.length > 0 && !CONTROL.test(name) && name.trim() === name;
}

function encodeName(name: string): string | null {
  const bytes = utf8Bytes(name);
  if (!bytes) return null;
  return bytes.map(byte => {
    const char = String.fromCharCode(byte);
    return SAFE_NAME_BYTE.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

/** Build a symbol key from a path and Git-selected funcname line. */
export function symbolKey(path: string, header: string): string | null {
  if (typeof path !== 'string' || !validPath(path) || typeof header !== 'string') return null;
  const name = header.normalize('NFC').trim();
  if (!validName(name)) return null;
  const encoded = encodeName(name);
  if (encoded === null) return null;
  const key = `symbol:${path}#${encoded}`;
  const bytes = utf8Bytes(key);
  return bytes && bytes.length <= MAX_KEY_BYTES ? key : null;
}

/** Parse only canonical symbol keys; malformed or aliased encodings return null. */
export function parseSymbolKey(key: string): { path: string; name: string } | null {
  if (typeof key !== 'string' || key.length > MAX_KEY_BYTES) return null;
  const separator = key.lastIndexOf('#');
  if (!key.startsWith('symbol:') || separator <= 'symbol:'.length || separator === key.length - 1) return null;
  const path = key.slice('symbol:'.length, separator);
  const encoded = key.slice(separator + 1);
  if (!validPath(path)) return null;
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length;) {
    const char = encoded[i];
    if (char === '%') {
      const escape = encoded.slice(i + 1, i + 3);
      if (!/^[0-9A-F]{2}$/.test(escape)) return null;
      bytes.push(Number.parseInt(escape, 16));
      i += 3;
    } else {
      if (!SAFE_NAME_BYTE.test(char) || char.charCodeAt(0) > 0x7f) return null;
      bytes.push(char.charCodeAt(0));
      i++;
    }
  }
  const name = utf8String(bytes);
  if (name === null || !validName(name) || symbolKey(path, name) !== key) return null;
  const keyBytes = utf8Bytes(key);
  return keyBytes && keyBytes.length <= MAX_KEY_BYTES ? { path, name } : null;
}

function uniqueValidIntervals(intervals: readonly SymbolInterval[]): boolean {
  const keys = new Set<string>();
  let previousEnd = 0;
  for (const interval of intervals) {
    if (!interval || !Number.isSafeInteger(interval.startLine) || !Number.isSafeInteger(interval.endLine) ||
      interval.startLine < 1 || interval.endLine <= interval.startLine || interval.startLine < previousEnd ||
      !parseSymbolKey(interval.key) || keys.has(interval.key)) return false;
    keys.add(interval.key);
    previousEnd = interval.endLine;
  }
  return true;
}

function intervalForEdit(intervals: readonly SymbolInterval[], start: number, end: number): SymbolInterval | null {
  if (start === end) {
    // Insertions on either boundary can belong to either neighboring symbol.
    return intervals.find(interval => start > interval.startLine && start < interval.endLine) ?? null;
  }
  return intervals.find(interval => start >= interval.startLine && end <= interval.endLine) ?? null;
}

/**
 * Return the shared symbol key when both sides prove one stable interval.
 * Ambiguous edits return file:<path>; an invalid path returns null.
 */
export function symbolForEdit(
  beforeIntervals: readonly SymbolInterval[],
  afterIntervals: readonly SymbolInterval[],
  edit: SymbolEdit,
): string | null {
  const beforeKey = beforeIntervals.map(interval => parseSymbolKey(interval.key)).find(Boolean);
  const afterKey = afterIntervals.map(interval => parseSymbolKey(interval.key)).find(Boolean);
  const path = beforeKey?.path ?? afterKey?.path;
  if (!path || !validPath(path)) return null;
  const fileKey = `file:${path}`;
  const fallback = (): string => fileKey;
  if (!uniqueValidIntervals(beforeIntervals) || !uniqueValidIntervals(afterIntervals) ||
    beforeIntervals.some(interval => parseSymbolKey(interval.key)?.path !== path) ||
    afterIntervals.some(interval => parseSymbolKey(interval.key)?.path !== path) ||
    !edit || ![edit.beforeStart, edit.beforeEnd, edit.afterStart, edit.afterEnd].every(Number.isSafeInteger) ||
    edit.beforeStart < 1 || edit.beforeEnd < edit.beforeStart || edit.afterStart < 1 || edit.afterEnd < edit.afterStart) return fallback();

  const before = intervalForEdit(beforeIntervals, edit.beforeStart, edit.beforeEnd);
  const after = intervalForEdit(afterIntervals, edit.afterStart, edit.afterEnd);
  if (!before || !after || before.key !== after.key) return fallback();
  // Removing the entire selected interval removes its identity with it.
  if (edit.beforeStart <= before.startLine && edit.beforeEnd >= before.endLine) return fallback();
  return before.key;
}
