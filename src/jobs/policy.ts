import type { Job, TrustedConfiguration, TrustedPolicy } from '../contracts';
import { HttpError } from '../http';

export type StoredJob<J extends Job = Job> = J extends Job
  ? Omit<J, 'unitPolicy'> & { unitPolicy?: TrustedPolicy }
  : never;

export function storedJob<J extends Job>(job: J): StoredJob<J> {
  const { unitPolicy: _unitPolicy, ...stored } = job;
  return stored as StoredJob<J>;
}

export function jobPolicy(trusted: TrustedConfiguration, job: Pick<Job, 'policyId' | 'policyDigest'>): TrustedPolicy | null {
  if (!Object.hasOwn(trusted.policies, job.policyId)) return null;
  const policy = trusted.policies[job.policyId];
  return policy.digest === job.policyDigest ? policy : null;
}

export function withJobPolicy<J extends Job>(trusted: TrustedConfiguration, job: StoredJob<J> | J): J {
  const policy = jobPolicy(trusted, job);
  if (!policy) throw new HttpError(409, 'JOB_POLICY_UNAVAILABLE',
    `Job ${job.jobId} needs policy ${job.policyId} ${job.policyDigest}, which the trusted config does not contain`);
  return { ...storedJob(job as J), unitPolicy: policy } as unknown as J;
}
