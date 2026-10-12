import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Job, TrustedPolicy } from '../../src/contracts';
import { changedUnitsForFile, normalizeUnits, overlaps, resolveUnit, unitRegistry } from '../../src/leases/units';
import { keyedLineChanges, lineKey, mergeKeyedLines } from '../../runner/lines';
import { inspectUnits } from '../../runner/units';
import { normalizeManifest } from '../../src/verdicts/manifest';

const pin = `sha256:${'0'.repeat(64)}` as const;
const policy = (keyRule: 'c-declaration' | 'first-token' | 'whole-line', order: 'sorted' | 'append' = 'append'): TrustedPolicy => ({
  id: 'keyed', digest: pin, version: 1, checkerId: 'checker', checkerDigest: pin,
  units: { 'file:include/callees.h': { canonicalKey: 'file:include/callees.h', file: 'include/callees.h', resources: [], dependencyKeys: [] } },
  keyedLines: [{ file: 'include/callees.h', keyRule, order }],
  acceptance: { kind: 'hard-gates', gates: [{ id: 'required', requiredOutcome: 'PASS' }] },
});

describe('keyed-line units', () => {
  it('extracts only unambiguous declaration names', () => {
    for (const [line, key] of [
      ['void sub_2029668(int a);', 'sub_2029668'],
      ['unsigned long *read_value(const char *name);', 'read_value'],
      ['char*compact_pointer(void);', 'compact_pointer'],
      ['extern const unsigned long *global_value;', 'global_value'],
      ['typedef unsigned long size_word;', 'size_word'],
      ['typedef int (*handler)(void);', null],
      ['int (*callback)(int);', null],
    ] as const) expect(lineKey(line, 'c-declaration')).toBe(key);
    expect(lineKey('alpha value', 'first-token')).toBe('alpha');
    expect(lineKey('alpha value', 'whole-line')).toBe('alpha value');
    expect(resolveUnit(unitRegistry(policy('whole-line')), 'line:include/callees.h:alpha value').key)
      .toBe('line:include/callees.h:alpha value');
  });

  it('leases distinct symbols separately and a file against all symbols', () => {
    const registry = unitRegistry(policy('c-declaration'));
    const a = resolveUnit(registry, 'line:include/callees.h:alpha');
    const b = resolveUnit(registry, 'line:include/callees.h:beta');
    const file = resolveUnit(registry, 'file:include/callees.h');
    expect(overlaps(a, b)).toBe(false);
    expect(overlaps(a, file)).toBe(true);
    expect(normalizeUnits(registry, [a.key, b.key])).toHaveLength(2);
    expect(() => normalizeUnits(registry, [a.key, file.key])).toThrow('overlapping units');
    const forged = policy('c-declaration');
    forged.units['line:include/callees.h:alpha'] = { canonicalKey: 'line:include/callees.h:alpha',
      file: 'include/callees.h', resources: ['other'], dependencyKeys: [] };
    expect(() => unitRegistry(forged)).toThrow('KEYED_LINE_POLICY_INVALID');
  });

  it('merges sorted and append edits byte for byte', () => {
    const sorted = policy('whole-line', 'sorted').keyedLines![0];
    expect(mergeKeyedLines('alpha\ndelta\n', 'alpha\nbeta\ndelta\n', 'alpha\ndelta\ngamma\n', sorted))
      .toBe('alpha\nbeta\ndelta\ngamma\n');
    const append = policy('first-token').keyedLines![0];
    expect(mergeKeyedLines('# header\nalpha  1\n', '# header\nalpha  1\nbeta\t2\n', '# header\nalpha  1\ngamma  3\n', append))
      .toBe('# header\nalpha  1\nbeta\t2\ngamma  3\n');
    expect(() => mergeKeyedLines('alpha 1\n', 'alpha 2\n', 'alpha 3\n', append)).toThrow('KEYED_LINE_CONFLICT');
  });

  it('rejects a sorted composition whose additions cross a frame boundary', () => {
    const sorted = policy('whole-line', 'sorted').keyedLines![0];
    expect(() => mergeKeyedLines('a\n# group\nd\n', 'a\nc\n# group\nd\n',
      'a\n# group\nb\nd\n', sorted)).toThrow('KEYED_LINE_CONFLICT');
  });

  it('requires the file unit for changes inside a multiline comment', () => {
    const linePolicy = policy('c-declaration').keyedLines![0];
    const base = '/*\nvoid old(void);\n*/\nvoid live(void);\n';
    const commentEdit = '/*\nvoid old(int x);\n*/\nvoid live(void);\n';
    expect(keyedLineChanges(base, commentEdit, linePolicy)).toBeNull();
    expect(changedUnitsForFile(unitRegistry(policy('c-declaration')), 'include/callees.h', base, commentEdit)
      .map(unit => unit.key)).toEqual(['file:include/callees.h']);
    expect(changedUnitsForFile(unitRegistry(policy('c-declaration')), 'include/callees.h', base,
      '/*\nvoid old(void);\n*/\nvoid live(int x);\n').map(unit => unit.key))
      .toEqual(['line:include/callees.h:live']);
  });

  it('requires the file unit for changes inside a continued preprocessor directive', () => {
    const linePolicy = policy('c-declaration').keyedLines![0];
    const registry = unitRegistry(policy('c-declaration'));
    const base = '#define DECLARE \\\nvoid old(void);\nvoid live(void);\n';
    const directiveEdit = '#define DECLARE \\\nvoid old(int x);\nvoid live(void);\n';
    expect(keyedLineChanges(base, directiveEdit, linePolicy)).toBeNull();
    expect(changedUnitsForFile(registry, 'include/callees.h', base, directiveEdit).map(unit => unit.key))
      .toEqual(['file:include/callees.h']);
    expect(changedUnitsForFile(registry, 'include/callees.h', base,
      '#define DECLARE \\\nvoid old(void);\nvoid live(int x);\n').map(unit => unit.key))
      .toEqual(['line:include/callees.h:live']);
  });

  it('falls back for frame edits, unkeyed declarations, and duplicate keys', () => {
    const registry = unitRegistry(policy('c-declaration'));
    const base = '#ifndef H\nvoid alpha(void);\n#endif\n';
    expect(changedUnitsForFile(registry, 'include/callees.h', base, '#ifndef H\nvoid alpha(void);\nvoid beta(void);\n#endif\n')
      .map(unit => unit.key)).toEqual(['line:include/callees.h:beta']);
    for (const next of ['#define H\nvoid alpha(void);\n#endif\n',
      '#ifndef H\nvoid alpha(void);\nint (*handler)(void);\n#endif\n',
      '#ifndef H\nvoid alpha(void);\nvoid alpha(int x);\n#endif\n']) {
      expect(changedUnitsForFile(registry, 'include/callees.h', base, next).map(unit => unit.key))
        .toEqual(['file:include/callees.h']);
    }
    expect(changedUnitsForFile(registry, 'include/callees.h', 'void alpha(void);\nvoid alpha(int x);\n',
      'void alpha(void);\nvoid beta(void);\n').map(unit => unit.key)).toEqual(['file:include/callees.h']);
  });

  it('maps inspected candidate edits to declared line units and validates the manifest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'concord-keyed-'));
    try {
      const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
      git('init', '-q');
      writeFileSync(join(dir, 'callees.h'), 'void alpha(void);\n');
      git('add', 'callees.h');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      writeFileSync(join(dir, 'callees.h'), 'void alpha(void);\nvoid beta(void);\n');
      git('add', 'callees.h');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'candidate');
      const head = git('rev-parse', 'HEAD');
      const unitPolicy: TrustedPolicy = { ...policy('c-declaration'), units: {}, keyedLines: [{ file: 'callees.h', keyRule: 'c-declaration', order: 'append' }] };
      const job = { unitPolicy, policyDigest: pin, checkerDigest: pin, oracleDigest: pin, toolchainDigest: pin } as Job;
      const inspected = await inspectUnits(dir, base, head, job);
      expect(inspected.unitKeys).toEqual(['line:callees.h:beta']);
      expect(inspected.manifest.coverage).toBe('complete');
      expect(normalizeManifest(inspected.manifest, unitPolicy, inspected.unitKeys).changedUnits[0].unitKey).toBe('line:callees.h:beta');
      writeFileSync(join(dir, 'callees.h'), '/*\nvoid old(void);\n*/\nvoid alpha(void);\n');
      git('add', 'callees.h');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'comment base');
      const commentBase = git('rev-parse', 'HEAD');
      writeFileSync(join(dir, 'callees.h'), '/*\nvoid old(int x);\n*/\nvoid alpha(void);\n');
      git('add', 'callees.h');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'comment edit');
      const commentHead = git('rev-parse', 'HEAD');
      expect((await inspectUnits(dir, commentBase, commentHead, job)).unitKeys).toEqual(['file:callees.h']);
      writeFileSync(join(dir, 'callees.h'), '#define DECLARE \\\nvoid old(void);\nvoid alpha(void);\n');
      git('add', 'callees.h');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'directive base');
      const directiveBase = git('rev-parse', 'HEAD');
      writeFileSync(join(dir, 'callees.h'), '#define DECLARE \\\nvoid old(int x);\nvoid alpha(void);\n');
      git('add', 'callees.h');
      git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'directive edit');
      const directiveHead = git('rev-parse', 'HEAD');
      const directiveInspection = await inspectUnits(dir, directiveBase, directiveHead, job);
      expect(directiveInspection.unitKeys).toEqual(['file:callees.h']);
      expect(directiveInspection.manifest.changedUnits.map(unit => unit.unitKey)).toEqual(['file:callees.h']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
