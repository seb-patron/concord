export function apiRequest(path: string, token = 'local-owner', init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(`https://concord.test${path}`, { ...init, headers });
}

export function mutation(path: string, body: Record<string, unknown>, key: string, token = 'local-owner'): Request {
  return apiRequest(path, token, { method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify(body) });
}

export async function responseBody(response: Response): Promise<{ data: any; error: any; version: number; eventSeq: number }> {
  return await response.json() as { data: any; error: any; version: number; eventSeq: number };
}

export function withoutNodeDeprecationWarnings(output: string): string {
  return output.split(/\r?\n/).filter(line =>
    !/^\(node:\d+\) \[DEP\d+\] DeprecationWarning:/.test(line) &&
    !/^\(Use node --trace-deprecation/.test(line))
    .join('\n');
}
