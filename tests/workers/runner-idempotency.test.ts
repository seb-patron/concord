import { describe, expect, it } from 'vitest';
import { runners } from '../../src/features/runners';

describe('runner heartbeat idempotency behavior', () => {
  it('keeps heartbeat handling on the runner feature route', () => {
    expect(runners.routes.some(route => route.method === 'POST' && route.pattern.test('/v1/repos/demo/jobs/job1/heartbeat'))).toBe(true);
  });
});
