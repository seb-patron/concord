import { describe, expect, it } from 'vitest';
import { selectStack, unitsOverlap, type PlannedEntry } from '../../src/queue/plan';

const empty = new Set<string>();
const entry = (changeId: string, sequence: number, unitKeys?: string[], dependencyChangeIds: string[] = []): PlannedEntry => ({
  changeId, sequence, dependencyChangeIds, ...(unitKeys ? { unitKeys } : {}),
});

describe('stack unit overlap', () => {
  it('skips overlapping independent changes but keeps later disjoint work', () => {
    expect(selectStack([
      entry('A', 1, ['file:x']), entry('B', 2, ['file:x']), entry('C', 3, ['file:y']),
    ], empty)).toEqual(['A', 'C']);
  });

  it('keeps an overlapping prerequisite in its dependent stack', () => {
    expect(selectStack([
      entry('A', 1, ['file:x']), entry('B', 2, ['file:x'], ['A']), entry('C', 3, ['file:y']),
    ], empty)).toEqual(['A', 'B', 'C']);
  });

  it('distinguishes rows and symbols while treating a file as overlapping its symbols', () => {
    expect(unitsOverlap(['symbol:x#f'], ['symbol:x#g'])).toBe(false);
    expect(unitsOverlap(['file:x'], ['symbol:x#f'])).toBe(true);
    expect(unitsOverlap(['row:t:a'], ['row:t:b'])).toBe(false);
    expect(selectStack([
      entry('A', 1, ['symbol:x#f']), entry('B', 2, ['symbol:x#g']),
      entry('C', 3, ['row:t:a']), entry('D', 4, ['row:t:b']),
    ], empty)).toEqual(['A', 'B', 'C', 'D']);
    expect(selectStack([entry('A', 1, ['file:x']), entry('B', 2, ['symbol:x#f'])], empty)).toEqual(['A']);
  });

  it('skips dependents of an entry skipped for overlap', () => {
    expect(selectStack([
      entry('A', 1, ['file:x']), entry('B', 2, ['file:x']), entry('C', 3, ['file:y'], ['B']),
    ], empty)).toEqual(['A']);
  });

  it('preserves selection for entries without footprint metadata', () => {
    expect(selectStack([entry('A', 1), entry('B', 2), entry('C', 3)], empty)).toEqual(['A', 'B', 'C']);
  });
});
