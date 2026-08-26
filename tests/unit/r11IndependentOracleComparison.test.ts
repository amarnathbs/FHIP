// Investment Intelligence R11 — the actual independent-oracle-vs-
// production diff (spec sections 100-101). This is the ONLY file in the
// R11 test/oracle set that both (a) imports the independently-written
// oracle corpus from scripts/r11_independent_multisource_oracle.mjs and
// (b) imports the real production resolveCrossSourceTransactionMatch — by
// design, the oracle file itself (run standalone via
// `node scripts/r11_independent_multisource_oracle.mjs`) never touches
// production code, so its self-check output is genuine independent
// evidence; this file is where that independent expectation gets
// compared against reality.
import { describe, it, expect } from 'vitest';
import { CASES } from '../../scripts/r11_independent_multisource_oracle.mjs';
import { resolveCrossSourceTransactionMatch } from '@/lib/services/investment-intelligence/crossSourceIdentity';
import { DEFAULT_RECONCILIATION_CONFIG } from '@/lib/services/investment-intelligence/reconciliationConfig';

interface OracleCase {
  id: string;
  name: string;
  candidate: Parameters<typeof resolveCrossSourceTransactionMatch>[0];
  existingRows: Parameters<typeof resolveCrossSourceTransactionMatch>[1];
  expectedState: string;
}

describe('R11 independent multi-source oracle vs production code', () => {
  const cases = CASES as OracleCase[];

  it('the oracle corpus is non-trivial (at least 30 distinct cases)', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it('every oracle case id is unique', () => {
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  for (const c of cases) {
    it(`${c.id}: ${c.name}`, () => {
      const actual = resolveCrossSourceTransactionMatch(c.candidate, c.existingRows, DEFAULT_RECONCILIATION_CONFIG);
      expect(actual.state, `oracle expected '${c.expectedState}' but production returned '${actual.state}' for ${c.id}`).toBe(c.expectedState);
    });
  }

  it('summary: 0 discrepancies between independent oracle and production across the full corpus', () => {
    const mismatches = cases.filter((c) => resolveCrossSourceTransactionMatch(c.candidate, c.existingRows, DEFAULT_RECONCILIATION_CONFIG).state !== c.expectedState);
    expect(mismatches.map((m) => m.id)).toEqual([]);
  });
});
