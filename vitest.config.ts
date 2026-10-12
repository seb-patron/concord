import { cpus } from 'node:os';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';
import { testTimeout } from './tests/helpers.ts';

const workerLimit = Math.min(6, Math.max(1, Math.floor(cpus().length / 2)));
const defaults = { testTimeout: testTimeout(5_000), hookTimeout: testTimeout(10_000), maxWorkers: workerLimit };

export default defineConfig({
  test: {
    ...defaults,
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.local.jsonc' } })],
        test: { ...defaults, name: 'workers', include: ['tests/workers/**/*.test.ts'] },
      },
      {
        test: { ...defaults, name: 'node', environment: 'node', pool: 'threads', include: ['tests/node/**/*.test.ts'],
          exclude: ['tests/node/{aw-mock,docs,demo,git-bridge,import,land,mcp}.test.ts'] },
      },
      {
        test: { ...defaults, name: 'integration', environment: 'node', pool: 'forks', maxWorkers: 1, fileParallelism: false,
          include: ['tests/node/{aw-mock,docs,demo,git-bridge,import,land,mcp}.test.ts'] },
      },
    ],
  },
});
