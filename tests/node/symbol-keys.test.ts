import { describe, expect, it } from 'vitest';
import { parseSymbolKey, symbolForEdit, symbolKey, type SymbolInterval } from '../../src/leases/symbol-keys';

describe('shared Git funcname symbol keys', () => {
  it('round trips complete Git-selected lines across language and heading forms', () => {
    const cases = [
      ['pkg/a.py', 'def alpha():', 'symbol:pkg/a.py#def%20alpha%28%29%3A'],
      ['src/lib.rs', 'pub fn alpha() {', 'symbol:src/lib.rs#pub%20fn%20alpha%28%29%20%7B'],
      ['src/main.go', 'func Alpha() {', 'symbol:src/main.go#func%20Alpha%28%29%20%7B'],
      ['src/main.cpp', 'int Alpha(int value) {', 'symbol:src/main.cpp#int%20Alpha%28int%20value%29%20%7B'],
      ['src/main.ts', 'export function alpha(): void {', 'symbol:src/main.ts#export%20function%20alpha%28%29%3A%20void%20%7B'],
      ['README.md', '# Heading', 'symbol:README.md#%23%20Heading'],
      ['README.md', '## Heading', 'symbol:README.md#%23%23%20Heading'],
      ['src/café.ts', '  function café() {  ', 'symbol:src/café.ts#function%20caf%C3%A9%28%29%20%7B'],
      ['README.md', '## C# & C++', 'symbol:README.md#%23%23%20C%23%20%26%20C%2B%2B'],
      ['dir#name/file.md', '# H1', 'symbol:dir#name/file.md#%23%20H1'],
    ] as const;
    for (const [path, header, key] of cases) {
      expect(symbolKey(path, header)).toBe(key);
      expect(parseSymbolKey(key)).toEqual({ path, name: header.normalize('NFC').trim() });
    }
    expect(symbolKey('src/é.ts', 'function é() {}')).toBe('symbol:src/é.ts#function%20%C3%A9%28%29%20%7B%7D');
  });

  it('rejects malformed, noncanonical, unsafe, duplicate, and overlong identities', () => {
    for (const key of [
      'symbol:src/a.ts#fn%2f',
      'symbol:src/a.ts#fn%GG',
      'symbol:src/a.ts#fn%C0%AF',
      'symbol:src/a.ts#fn%E2%28%A1',
      'symbol:src/a.ts#fn%41',
      'symbol:src/a.ts#fn%20',
      'symbol:../a.ts#fn',
      'symbol:/a.ts#fn',
      'symbol:src//a.ts#fn',
      'symbol:src/.git/config#fn',
    ]) expect(parseSymbolKey(key)).toBeNull();
    expect(symbolKey('../a.ts', 'fn')).toBeNull();
    expect(symbolKey('src/a.ts', 'fn\nother')).toBeNull();
    expect(symbolKey('src/a.ts', 'x '.repeat(180))).toBeNull();
    expect(parseSymbolKey(`symbol:a.ts#${'x'.repeat(505)}`)).toBeNull();

    const duplicate = symbolKey('src/a.ts', 'function same() {')!;
    expect(symbolForEdit(
      [{ key: duplicate, startLine: 1, endLine: 3 }, { key: duplicate, startLine: 3, endLine: 5 }],
      [{ key: duplicate, startLine: 1, endLine: 5 }],
      { beforeStart: 2, beforeEnd: 3, afterStart: 2, afterEnd: 3 },
    )).toBe('file:src/a.ts');
  });

  it('assigns edits only when both sides prove one stable symbol interval', () => {
    const alpha = symbolKey('src/a.ts', 'function alpha() {')!;
    const beta = symbolKey('src/a.ts', 'function beta() {')!;
    const alphaBefore: SymbolInterval[] = [{ key: alpha, startLine: 1, endLine: 6 }];
    const alphaAfter: SymbolInterval[] = [{ key: alpha, startLine: 1, endLine: 6 }];
    expect(symbolForEdit(alphaBefore, alphaAfter,
      { beforeStart: 2, beforeEnd: 4, afterStart: 2, afterEnd: 4 })).toBe(alpha);

    const before = [
      { key: alpha, startLine: 1, endLine: 4 },
      { key: beta, startLine: 4, endLine: 8 },
    ];
    expect(symbolForEdit(before, before,
      { beforeStart: 4, beforeEnd: 4, afterStart: 4, afterEnd: 5 })).toBe('file:src/a.ts');
    expect(symbolForEdit([], [{ key: beta, startLine: 1, endLine: 4 }],
      { beforeStart: 1, beforeEnd: 1, afterStart: 2, afterEnd: 3 })).toBe('file:src/a.ts');
    expect(symbolForEdit([{ key: beta, startLine: 1, endLine: 4 }], [],
      { beforeStart: 2, beforeEnd: 3, afterStart: 2, afterEnd: 2 })).toBe('file:src/a.ts');

    const renamed = symbolKey('src/a.ts', 'function alpha(value: string) {')!;
    expect(symbolForEdit(alphaBefore, [{ key: renamed, startLine: 1, endLine: 6 }],
      { beforeStart: 2, beforeEnd: 3, afterStart: 2, afterEnd: 3 })).toBe('file:src/a.ts');
    expect(symbolForEdit(before, before,
      { beforeStart: 3, beforeEnd: 5, afterStart: 3, afterEnd: 5 })).toBe('file:src/a.ts');
  });

  it('uses nested declarations and Markdown subheadings as interval boundaries', () => {
    const outer = symbolKey('src/nested.ts', 'function outer() {')!;
    const inner = symbolKey('src/nested.ts', '  function inner() {')!;
    const nested = [
      { key: outer, startLine: 1, endLine: 3 },
      { key: inner, startLine: 3, endLine: 6 },
    ];
    expect(symbolForEdit(nested, nested,
      { beforeStart: 4, beforeEnd: 5, afterStart: 4, afterEnd: 5 })).toBe(inner);

    const h1 = symbolKey('README.md', '# Overview')!;
    const h2 = symbolKey('README.md', '## Details')!;
    const markdown = [
      { key: h1, startLine: 1, endLine: 4 },
      { key: h2, startLine: 4, endLine: 7 },
    ];
    expect(symbolForEdit(markdown, markdown,
      { beforeStart: 5, beforeEnd: 6, afterStart: 5, afterEnd: 6 })).toBe(h2);
  });
});
