import { describe, expect, it, vi } from 'vitest';
import { waitChange } from '../../cli/land.ts';

describe('land inspection polling', () => {
  it('reads inspection state from change detail without requesting a snapshot', async () => {
    const request = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith('/snapshot')) throw new Error('snapshot must not be requested');
      if (path === '/repos/demo/changes/change') {
        if (request.mock.calls.length === 1) {
          return { data: { changeId: 'change', revision: 3, status: 'draft', inspection: { jobId: 'job', revision: 3, state: 'pending' } }, version: 1 };
        }
        return { data: { changeId: 'change', revision: 3, status: 'ready', inspection: { jobId: 'job', revision: 3, state: 'completed' } }, version: 1 };
      }
      if (path === '/repos/demo/jobs/job/result') return { data: { result: { outcome: 'PASS' } }, version: 1 };
      throw new Error(`unexpected ${path}`);
    });
    let now = 0;
    const change = await waitChange({ request } as never, '/repos/demo/changes/change', 10_000, () => {}, async () => {}, undefined,
      { now: () => now, sleep: async ms => { now += ms; }, random: () => 0.5 });

    expect(change.status).toBe('ready');
    expect(request.mock.calls.filter(([, path]) => path.endsWith('/snapshot'))).toHaveLength(0);
    expect(request.mock.calls.filter(([, path]) => path.endsWith('/jobs/job/result'))).toHaveLength(1);
  });

  it('still raises INSPECTION_FAILED for a failed result from change detail', async () => {
    const request = vi.fn(async (_method: string, path: string) => {
      if (path.endsWith('/snapshot')) throw new Error('snapshot must not be requested');
      if (path === '/repos/demo/changes/change') return { data: {
        changeId: 'change', revision: 3, status: 'draft',
        inspection: { jobId: 'job', revision: 3, state: 'completed' },
      }, version: 1 };
      if (path === '/repos/demo/jobs/job/result') return { data: { result: { outcome: 'FAIL' } }, version: 1 };
      throw new Error(`unexpected ${path}`);
    });

    await expect(waitChange({ request } as never, '/repos/demo/changes/change', Date.now() + 10_000,
      () => {}, async () => {})).rejects.toMatchObject({ message: 'INSPECTION_FAILED: FAIL' });
    expect(request.mock.calls.filter(([, path]) => path.endsWith('/jobs/job/result'))).toHaveLength(1);
  });
});
