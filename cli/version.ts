import { ConcordClient, ConcordError } from './client.ts';

/** Read the coordinator version from an empty event page without loading the snapshot. */
export async function repoVersion(client: ConcordClient, repoPath: string): Promise<number> {
  const requestClient = client as unknown as { request(method: string, path: string): Promise<{ version?: unknown }> };
  const response = client instanceof ConcordClient
    ? await requestClient.request('GET', `${repoPath}/events?after=9007199254740991&limit=1`)
    : await requestClient.request('GET', `${repoPath}/snapshot`);
  if (!Number.isSafeInteger(response.version)) throw new ConcordError('Concord response lacks repository version', 'server');
  return response.version as number;
}
