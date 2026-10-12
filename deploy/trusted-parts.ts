import { open, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const MAX_TRUSTED_PART_BYTES = 5000;
export const MAX_TRUSTED_PARTS = 64;

export function splitTrustedConfig(text: string): Record<string, string> {
  try { JSON.parse(text); } catch { throw new Error('trusted configuration must be valid JSON'); }
  const parts: string[] = [];
  let part = '';
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > MAX_TRUSTED_PART_BYTES) {
      parts.push(part);
      if (parts.length >= MAX_TRUSTED_PARTS) throw new Error('trusted configuration exceeds 64 parts');
      part = '';
      bytes = 0;
    }
    part += character;
    bytes += size;
  }
  parts.push(part);
  if (parts.length > MAX_TRUSTED_PARTS) throw new Error('trusted configuration exceeds 64 parts');
  return Object.fromEntries([
    ['TRUSTED_CONFIG_PARTS', String(parts.length)],
    ...parts.map((value, index) => [`TRUSTED_CONFIG_PART_${index}`, value]),
  ]);
}

export async function writeTrustedParts(inputPath: string, outputPath: string): Promise<number[]> {
  const input = await readFile(inputPath);
  const text = input.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(input)) throw new Error('trusted configuration must be valid UTF-8');
  const bindings = splitTrustedConfig(text);
  const sizes = Array.from({ length: Number(bindings.TRUSTED_CONFIG_PARTS) }, (_, index) =>
    Buffer.byteLength(bindings[`TRUSTED_CONFIG_PART_${index}`], 'utf8'));
  // Exclusive creation prevents an existing, more permissive file from exposing secrets.
  const output = await open(outputPath, 'wx', 0o600);
  try {
    await output.chmod(0o600);
    await output.writeFile(JSON.stringify(bindings));
  } finally {
    await output.close();
  }
  return sizes;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, options: { in: { type: 'string' }, out: { type: 'string' } }, strict: true });
    if (!values.in || !values.out) throw new Error('usage: npm run deploy:trusted-parts -- --in <trusted-config.json> --out <bulk.json>');
    const sizes = await writeTrustedParts(values.in, values.out);
    console.log(JSON.stringify({ parts: sizes.length, byteSizes: sizes }));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'trusted parts creation failed');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
