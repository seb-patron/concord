import { describe, expect, it } from 'vitest';
import type { Job } from '../../src/contracts';
import { HttpError, stableJson } from '../../src/http';
import { localFixtureConfig } from '../../src/state';
import { jobPolicy, storedJob, withJobPolicy } from '../../src/jobs/policy';

const trusted = localFixtureConfig('local');
const policy = trusted.policies['local-demo'];
const job = { jobId: 'job1', policyId: policy.id, policyDigest: policy.digest, unitPolicy: policy } as Job;

describe('stored job policy helpers', () => {
  it('removes the policy key from stored records', () => {
    const result = storedJob(job);
    expect('unitPolicy' in result).toBe(false);
    expect(stableJson(result)).not.toContain('unitPolicy');
  });

  it('resolves policy only by own id and matching digest', () => {
    expect(jobPolicy(trusted, job)).toEqual(policy);
    expect(jobPolicy(trusted, { ...job, policyId: 'missing' })).toBeNull();
    expect(jobPolicy(trusted, { ...job, policyDigest: ('sha256:' + 'f'.repeat(64)) as `sha256:${string}` })).toBeNull();
    expect(jobPolicy(trusted, { ...job, policyId: 'constructor' })).toBeNull();
  });

  it('fills stored and old jobs from trusted config and rejects unavailable pins', () => {
    expect(withJobPolicy(trusted, storedJob(job)).unitPolicy).toEqual(policy);
    expect(withJobPolicy(trusted, { ...storedJob(job), unitPolicy: { ...policy, version: 99 } } as Job).unitPolicy).toEqual(policy);
    expect(() => withJobPolicy({ ...trusted, policies: {} }, storedJob(job))).toThrowError(
      expect.objectContaining({ status: 409, code: 'JOB_POLICY_UNAVAILABLE', message: expect.stringContaining('job1') }) as HttpError);
    try { withJobPolicy({ ...trusted, policies: {} }, storedJob(job)); } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).message).toContain(policy.id);
      expect((error as HttpError).message).toContain(policy.digest);
    }
  });
});
