import { ConcordClient, ConcordError, idempotencyKey } from './client.ts';

type Envelope<T> = { data: T; version?: number };

export interface GitTokenOptions {
  repoPath: string;
  storageName: string;
  scope: 'read' | 'write';
  expectedVersion?: number;
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function currentVersion(value: unknown): number {
  if (value && typeof value === 'object') {
    const envelope = value as { version?: unknown; data?: { version?: unknown } };
    const version = envelope.version ?? envelope.data?.version;
    if (Number.isSafeInteger(version)) return version as number;
  }
  throw new ConcordError('Concord response lacks repository version', 'server');
}

export async function mintGitToken<T = unknown>(client: ConcordClient, options: GitTokenOptions): Promise<T> {
  const pinned = options.expectedVersion !== undefined;
  const repoId = options.repoPath.replace(/^\/repos\//, '').split('/')[0];
  for (let attempt = 0; attempt < 5; attempt++) {
    let version = options.expectedVersion;
    if (!pinned) version = currentVersion(await client.request('GET', `/repos/${repoId}`));
    try {
      return await client.request<T>('POST', `${options.repoPath}/git-token`, {
        body: { storageName: options.storageName, scope: options.scope, ttlSeconds: 300 },
        expectedVersion: version,
        idempotencyKey: idempotencyKey(),
      });
    } catch (error) {
      const stale = error instanceof ConcordError && (error.payload as { error?: { code?: unknown } } | undefined)?.error?.code === 'STALE_VERSION';
      if (!stale || pinned) throw error;
      if (attempt === 4) throw new ConcordError('STALE_VERSION: git token mint lost the version race 5 times', 'conflict', error.status, error.payload);
      await pause(20 * (attempt + 1));
    }
  }
  throw new ConcordError('STALE_VERSION: git token mint lost the version race 5 times', 'conflict');
}
