import { ConcordClient, ConcordError, idempotencyKey } from './client.ts';
import { repoVersion } from './version.ts';

type Envelope<T> = { data: T; version?: number };

export interface GitTokenOptions {
  repoPath: string;
  storageName: string;
  scope: 'read' | 'write';
  expectedVersion?: number;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function mintGitToken<T = unknown>(client: ConcordClient, options: GitTokenOptions): Promise<T> {
  const pinned = options.expectedVersion !== undefined;
  const promotionStartedAt = Date.now();
  let promotionDelay = 1_000;
  let promotionError: ConcordError | undefined;
  let staleAttempts = 0;
  while (true) {
    if (promotionError && Date.now() - promotionStartedAt >= 120_000) throw promotionError;
    let version = options.expectedVersion;
    if (!pinned) version = await repoVersion(client, options.repoPath.replace(/\/+$/, ''));
    try {
      return await client.request<T>('POST', `${options.repoPath}/git-token`, {
        body: { storageName: options.storageName, scope: options.scope, ttlSeconds: 300 },
        expectedVersion: version,
        idempotencyKey: idempotencyKey(),
      });
    } catch (error) {
      const code = error instanceof ConcordError
        ? (error.payload as { error?: { code?: unknown } } | undefined)?.error?.code
        : undefined;
      if (code === 'PROMOTION_IN_PROGRESS') {
        promotionError = error as ConcordError;
        const remaining = Math.max(0, 120_000 - (Date.now() - promotionStartedAt));
        if (remaining === 0) throw promotionError;
        const wait = Math.min(promotionDelay, remaining);
        process.stderr.write(`waiting for landing in progress (${Math.ceil(wait / 1_000)}s)\n`);
        await pause(wait);
        promotionDelay = Math.min(promotionDelay * 2, 120_000);
        continue;
      }
      const stale = code === 'STALE_VERSION';
      if (!stale || pinned) throw error;
      const staleError = error as ConcordError;
      if (staleAttempts === 4) throw new ConcordError('STALE_VERSION: git token mint lost the version race 5 times', 'conflict', staleError.status, staleError.payload);
      staleAttempts++;
      await pause(20 * staleAttempts);
    }
  }
}
