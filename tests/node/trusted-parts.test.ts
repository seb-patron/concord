import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitTrustedConfig, writeTrustedParts } from '../../deploy/trusted-parts';

describe('trusted configuration parts', () => {
  it('preserves the exact JSON text and UTF-8 characters within 5000-byte parts', () => {
    const text = JSON.stringify({ policy: '😀é'.repeat(1500), whitespace: ' kept ' }) + '\n';
    const bindings = splitTrustedConfig(text);
    const count = Number(bindings.TRUSTED_CONFIG_PARTS);
    expect(count).toBeGreaterThan(1);
    const parts = Array.from({ length: count }, (_, index) => bindings[`TRUSTED_CONFIG_PART_${index}`]);
    expect(parts.join('')).toBe(text);
    expect(parts.every(part => Buffer.byteLength(part, 'utf8') <= 5000)).toBe(true);
    expect(parts.every(part => !part.includes('\uFFFD'))).toBe(true);
  });

  it('rejects invalid JSON and more than 64 parts', () => {
    expect(() => splitTrustedConfig('{')).toThrow('valid JSON');
    expect(() => splitTrustedConfig(JSON.stringify({ policy: 'x'.repeat(64 * 5000) }))).toThrow('exceeds 64 parts');
  });

  it('writes a private bulk file with all numbered bindings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'concord-trusted-parts-'));
    try {
      const input = join(directory, 'input.json');
      const output = join(directory, 'bulk.json');
      const text = JSON.stringify({ policy: '😀'.repeat(1300) });
      await writeFile(input, text);
      const sizes = await writeTrustedParts(input, output);
      const bindings = JSON.parse(await readFile(output, 'utf8')) as Record<string, string>;
      expect(bindings.TRUSTED_CONFIG_PARTS).toBe(String(sizes.length));
      expect(Array.from({ length: sizes.length }, (_, index) => bindings[`TRUSTED_CONFIG_PART_${index}`]).join('')).toBe(text);
      expect(sizes.every(size => size <= 5000)).toBe(true);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      await expect(writeTrustedParts(input, output)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
