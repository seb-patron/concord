import { describe, expect, it } from 'vitest';
import { failure, HttpError } from '../../src/http';

describe('failure Retry-After headers', () => {
  it('asks clients to retry 503 responses after five seconds', () => {
    const response = failure(new HttpError(503, 'PLATFORM_UNAVAILABLE', 'x'));
    expect(response.headers.get('Retry-After')).toBe('5');
  });

  it('does not add Retry-After to 409 or 429 responses', () => {
    expect(failure(new HttpError(409, 'CONFLICT', 'x')).headers.get('Retry-After')).toBeNull();
    expect(failure(new HttpError(429, 'RATE_LIMITED', 'x')).headers.get('Retry-After')).toBeNull();
  });
});
