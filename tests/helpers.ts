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

// All integration deadlines use the same load-adjustable scale.
export function testTimeout(milliseconds: number): number {
  const value = Number(process.env.CONCORD_TEST_TIMEOUT_SCALE ?? '1');
  if (!Number.isFinite(value) || value <= 0) throw new Error('CONCORD_TEST_TIMEOUT_SCALE must be a positive number');
  return Math.ceil(milliseconds * value);
}

export async function waitForCondition(check: () => boolean | Promise<boolean>, milliseconds: number, label: string): Promise<void> {
  const deadline = Date.now() + testTimeout(milliseconds);
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label} after ${testTimeout(milliseconds)}ms`);
}
