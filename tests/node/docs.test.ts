import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const readmeUrl = new URL('../../README.md', import.meta.url);
const packageUrl = new URL('../../package.json', import.meta.url);
const cliUrl = new URL('../../cli/main.ts', import.meta.url);

describe('README commands', () => {
  it('uses npm scripts and Concord CLI forms defined by the project', async () => {
    const [readme, packageText, cli] = await Promise.all([
      readFile(readmeUrl, 'utf8'),
      readFile(packageUrl, 'utf8'),
      readFile(cliUrl, 'utf8'),
    ]);
    const scripts = (JSON.parse(packageText) as { scripts: Record<string, string> }).scripts;

    for (const match of readme.matchAll(/\bnpm run ([\w:-]+)/g)) {
      expect(scripts[match[1]], `README references missing npm script: ${match[1]}`).toBeDefined();
    }
    for (const match of readme.matchAll(/\bnpm (ci|test)\b/g)) {
      if (match[1] === 'test') expect(scripts.test, 'README references npm test without a test script').toBeDefined();
    }

    const usage = cli.slice(cli.indexOf('const HELP = `'), cli.indexOf('`;\n\ntype Flags'));
    for (const noun of ['start', 'land']) {
      expect(usage, `CLI usage must document ${noun}`).toMatch(new RegExp(`\\n  ${noun} --repo`));
      expect(readme, `README must show the ${noun} CLI command`).toMatch(new RegExp(`npm run concord -- ${noun} --repo`));
    }
  });
});
