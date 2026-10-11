import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.local.jsonc' } })],
        test: { name: 'workers', include: ['tests/workers/**/*.test.ts'] },
      },
      {
        test: { name: 'node', environment: 'node', include: ['tests/node/**/*.test.ts'] },
      },
    ],
  },
});
