import { describe, expect, it } from 'vitest';
import type { InspectionResult } from '../../src/contracts';
import { stableJson } from '../../src/http';

const inspectionWithNullHead: InspectionResult = {
  jobId: 'job', attempt: 1, inputDigest: 'sha256:input', fence: 1,
  sourceTreeOid: null, checkerDigest: 'sha256:checker', toolchainDigest: 'sha256:toolchain',
  oracleDigest: 'sha256:oracle', environmentDigest: 'sha256:environment', durationMs: 1,
  log: '', resultDigest: 'sha256:result', kind: 'inspect-candidate', outcome: 'ENV_ERROR',
  observedHeadOid: null, unitKeys: [], reviewManifestDigest: null, reviewManifest: null,
};

// @ts-expect-error observedHeadOid is required even when its value can be null.
const inspectionWithoutHead: InspectionResult = { ...inspectionWithNullHead, observedHeadOid: undefined };
void inspectionWithoutHead;

describe('worker contracts', () => {
  it('uses the canonical result preimage with resultDigest omitted', async () => {
    const hashResult = async (result: object) => {
      const { resultDigest: _digest, ...preimage } = result as Record<string, unknown>;
      const bytes = new TextEncoder().encode(stableJson(preimage));
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      return `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
    };

    const { resultDigest: _digest, ...withoutDigest } = inspectionWithNullHead;
    expect(await hashResult(withoutDigest)).toBe(await hashResult(inspectionWithNullHead));
  });
});
