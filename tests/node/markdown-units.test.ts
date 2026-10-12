import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CandidateInput, Digest, Job, TrustedPolicy } from '../../src/contracts';
import { changedUnitsForFile, normalizeUnits, overlaps, resolveUnit, unitRegistry } from '../../src/leases/units';
import { normalizeManifest } from '../../src/verdicts/manifest';
import { childEnvironment, git, temporaryWork } from '../../runner/git';
import { headingSlug, mergeMarkdown, parseMarkdown } from '../../runner/markdown';
import { inspectUnits } from '../../runner/units';
import { compose } from '../../runner/execute';

const pin = `sha256:${'0'.repeat(64)}` as Digest;
const file = 'architecture.md';
const base = 'Preface\n\n## 4 Storage and time\nOld storage.\n\n## 5 Interface contracts\nOld API.\n';
const policy: TrustedPolicy = { id: 'markdown', digest: pin, version: 1, checkerId: 'markdown', checkerDigest: pin,
  units: { [`file:${file}`]: { canonicalKey: `file:${file}`, file, resources: [], dependencyKeys: [] },
    [`section:${file}:_preamble`]: { canonicalKey: `section:${file}:_preamble`, file,
      resources: [`${file}#_preamble`], dependencyKeys: [] },
    [`section:${file}:4-storage-and-time`]: { canonicalKey: `section:${file}:4-storage-and-time`, file,
      resources: [`${file}#4-storage-and-time`], dependencyKeys: [] },
    [`section:${file}:5-interface-contracts`]: { canonicalKey: `section:${file}:5-interface-contracts`, file,
      resources: [`${file}#5-interface-contracts`], dependencyKeys: [] } },
  markdown: [{ file, headingLevel: 2 }], acceptance: { kind: 'hard-gates', gates: [{ id: 'check', requiredOutcome: 'PASS' }] } };
const registry = unitRegistry(policy);
const keys = (before: string, after: string) => changedUnitsForFile(registry, file, before, after).map(item => item.key);

describe('Markdown section units', () => {
  it('slugs headings, retains duplicate order, and ignores fenced headings', () => {
    expect(headingSlug('4 Storage and time!')).toBe('4-storage-and-time');
    const sections = parseMarkdown('Intro\n## A!\none\n```md\n## Hidden\n```\n## A!\ntwo\n', 2);
    expect(sections?.map(item => item.slug)).toEqual(['_preamble', 'a', 'a-2']);
    expect(sections?.[1].content).toContain('## Hidden');
  });

  it('resolves aliases and leases only overlapping sections or the whole file', () => {
    const aliased = structuredClone(policy);
    aliased.units['chapter:storage'] = { ...aliased.units[`section:${file}:4-storage-and-time`] };
    const mapped = unitRegistry(aliased);
    const storage = resolveUnit(mapped, 'chapter:storage');
    const api = resolveUnit(mapped, `section:${file}:5-interface-contracts`);
    expect(storage.key).toBe(`section:${file}:4-storage-and-time`);
    expect(overlaps(storage, api)).toBe(false);
    expect(overlaps(storage, resolveUnit(mapped, `file:${file}`))).toBe(true);
    expect(normalizeUnits(mapped, ['chapter:storage', `section:${file}:4-storage-and-time`])).toHaveLength(1);
    expect(resolveUnit(mapped, `section:${file}:new-section`).resources).toEqual([`${file}#new-section`]);
    expect(() => resolveUnit(mapped, 'section:other.md:new-section')).toThrow('Unit key is not registered');
  });

  it('maps body and new-section edits, falling back for heading changes', () => {
    expect(keys(base, base.replace('Old storage.', 'New storage.'))).toEqual([`section:${file}:4-storage-and-time`]);
    expect(keys(base, base + '## 6 New section\nAdded.\n')).toEqual([`section:${file}:6-new-section`]);
    expect(keys(base, base.replace('4 Storage and time', '4 Storage and dates'))).toEqual([`file:${file}`]);
    expect(keys(base, base.replace('Old storage.', '### Timing\nOld storage.'))).toEqual([`file:${file}`]);
    const withSetext = base.replace('Preface\n', 'Overview\n========\n');
    expect(keys(withSetext, withSetext.replace('Overview', 'Summary'))).toEqual([`file:${file}`]);
    expect(keys(base, base.replace('## 5 Interface contracts\nOld API.\n', '') + '## 5 Interface contracts\nOld API.\n'))
      .toEqual([]);
    expect(keys(base, '## 5 Interface contracts\nOld API.\n## 4 Storage and time\nOld storage.\n'))
      .toEqual([`file:${file}`]);
  });

  it('merges disjoint edits byte-exactly and rejects a shared section', () => {
    const ours = base.replace('Old storage.', 'New storage.');
    const theirs = base.replace('Old API.', 'New API.');
    expect(mergeMarkdown(base, ours, theirs, 2)).toBe(base.replace('Old storage.', 'New storage.').replace('Old API.', 'New API.'));
    const added = base.replace('## 5 Interface contracts', '## 4.5 New section\nAdded.\n\n## 5 Interface contracts');
    expect(mergeMarkdown(base, ours, added, 2)).toBe(added.replace('Old storage.', 'New storage.'));
    expect(() => mergeMarkdown(base, ours, base.replace('Old storage.', 'Other storage.'), 2))
      .toThrow('MARKDOWN_SECTION_CONFLICT:4-storage-and-time');
    expect(() => mergeMarkdown(base, ours, base.replace('4 Storage and time', '4 Storage and dates'), 2))
      .toThrow('MARKDOWN_STRUCTURE_CONFLICT');
  });

  it('inspects changed sections and normalizes their review manifest', async () => {
    await temporaryWork(async repo => {
      const env = childEnvironment({ GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
      await git(repo, ['init', '--quiet']);
      await writeFile(join(repo, file), base);
      await git(repo, ['add', file]);
      await git(repo, ['commit', '--quiet', '-m', 'base'], 30_000, env);
      const baseOid = await git(repo, ['rev-parse', 'HEAD']);
      await writeFile(join(repo, file), base.replace('Old storage.', 'New storage.'));
      await git(repo, ['add', file]);
      await git(repo, ['commit', '--quiet', '-m', 'section'], 30_000, env);
      const head = await git(repo, ['rev-parse', 'HEAD']);
      const job = { unitPolicy: policy, policyDigest: pin, checkerDigest: pin, oracleDigest: pin, toolchainDigest: pin } as Job;
      const result = await inspectUnits(repo, baseOid, head, job);
      expect(result.unitKeys).toEqual([`section:${file}:4-storage-and-time`]);
      expect(result.manifest.coverage).toBe('complete');
      expect(normalizeManifest(result.manifest, policy, result.unitKeys).changedUnits[0].unitKey).toBe(result.unitKeys[0]);
    });
  });

  it('enforces same-section conflicts even when Git could merge separate lines', async () => {
    await temporaryWork(async repo => {
      const env = childEnvironment({ GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
      const original = base.replace('Old storage.', 'First line.\nSecond line.\nThird line.');
      await git(repo, ['init', '--quiet']);
      await writeFile(join(repo, file), original);
      await git(repo, ['add', file]);
      await git(repo, ['commit', '--quiet', '-m', 'base'], 30_000, env);
      const baseOid = await git(repo, ['rev-parse', 'HEAD']);
      await writeFile(join(repo, file), original.replace('First line.', 'Changed first.'));
      await git(repo, ['add', file]);
      await git(repo, ['commit', '--quiet', '-m', 'first'], 30_000, env);
      const first = await git(repo, ['rev-parse', 'HEAD']);
      await git(repo, ['switch', '--detach', baseOid]);
      await writeFile(join(repo, file), original.replace('Third line.', 'Changed third.'));
      await git(repo, ['add', file]);
      await git(repo, ['commit', '--quiet', '-m', 'third'], 30_000, env);
      const third = await git(repo, ['rev-parse', 'HEAD']);
      const inputs = [{ baseOid, headOid: first }, { baseOid, headOid: third }] as CandidateInput[];
      const job = { unitPolicy: policy } as Job;
      await expect(compose(repo, baseOid, inputs, job)).rejects.toThrow('MARKDOWN_SECTION_CONFLICT');
    });
  });
});
