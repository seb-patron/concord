import type { AcceptancePolicy, StackResult } from '../contracts';

export interface ContestResult {
  changeId: string; creationSequence: number; resultSequence: number;
  policyDigest: string; profileDigest: string; oracleDigest: string; toolchainDigest: string; checkerDigest: string;
  canonicalBaseOid: string; result: StackResult;
}
export type Arbitration =
  | { status: 'selected'; winnerId: string; loserId: string; reason: string }
  | { status: 'blocked'; reason: string };

export function accepted(result: StackResult, policy: AcceptancePolicy): boolean {
  if (!['PASS', 'MATCH'].includes(result.outcome) || !result.composedOid || !result.composedTreeOid) return false;
  if (new Set(result.gateResults.map(gate => gate.gateId)).size !== result.gateResults.length) return false;
  if (!policy.gates.every(gate => result.gateResults.some(found => found.gateId === gate.id && found.outcome === gate.requiredOutcome))) return false;
  if (policy.kind === 'score') return result.score !== null
    && result.score.total === policy.fixedDenominator
    && Number.isSafeInteger(result.score.matched)
    && result.score.matched >= 0 && result.score.matched <= policy.fixedDenominator;
  return true;
}

/** No cross-profile score comparison, even if both results look green. */
export function arbitrate(first: ContestResult, second: ContestResult, policy: AcceptancePolicy): Arbitration {
  if (first.canonicalBaseOid !== second.canonicalBaseOid
    || first.policyDigest !== second.policyDigest || first.profileDigest !== second.profileDigest || first.oracleDigest !== second.oracleDigest
    || first.toolchainDigest !== second.toolchainDigest || first.checkerDigest !== second.checkerDigest
    || [first, second].some(item => item.result.canonicalBaseOid !== item.canonicalBaseOid
      || item.result.oracleDigest !== item.oracleDigest || item.result.toolchainDigest !== item.toolchainDigest
      || item.result.checkerDigest !== item.checkerDigest)) {
    return { status: 'blocked', reason: 'NON_COMPARABLE_PROFILE' };
  }
  const valid = [first, second].filter(item => accepted(item.result, policy));
  if (valid.length === 0) return { status: 'blocked', reason: 'NO_VALID_GREEN' };
  let reason = 'FIRST_VALID_GREEN';
  if (policy.kind === 'score' && valid.length === 2) {
    valid.sort((a, b) => b.result.score!.matched - a.result.score!.matched || a.creationSequence - b.creationSequence);
    reason = valid[0].result.score!.matched === valid[1].result.score!.matched ? 'SCORE_TIE_CREATION_ORDER' : 'HIGHER_FIXED_DENOMINATOR_SCORE';
  } else valid.sort((a, b) => a.resultSequence - b.resultSequence || a.creationSequence - b.creationSequence);
  return { status: 'selected', winnerId: valid[0].changeId, loserId: valid[0] === first ? second.changeId : first.changeId, reason };
}
