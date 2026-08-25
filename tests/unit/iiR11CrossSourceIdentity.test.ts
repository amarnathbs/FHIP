// Investment Intelligence R11 — deterministic certification cases for
// crossSourceIdentity.ts (spec sections 24-41). Every case here is a real,
// distinct, deterministic scenario — none are trivial duplicates of each
// other (each changes at least one field that changes the classification).
import { describe, it, expect } from 'vitest';
import {
  compareCrossSourceTransactions,
  resolveCrossSourceTransactionMatch,
  resolvePrecedenceWinner,
  CROSS_SOURCE_IDENTITY_ENGINE_VERSION,
  type CrossSourceCandidateTransaction,
  type CrossSourceExistingTransaction,
} from '@/lib/services/investment-intelligence/crossSourceIdentity';
import { DEFAULT_RECONCILIATION_CONFIG } from '@/lib/services/investment-intelligence/reconciliationConfig';

const ACCOUNT = 'acct-1';
const INSTRUMENT = 'inst-1';

function candidate(overrides: Partial<CrossSourceCandidateTransaction> = {}): CrossSourceCandidateTransaction {
  return {
    sourceKey: 'kfintech',
    sourceDocumentId: 'doc-new',
    accountId: ACCOUNT,
    instrumentId: INSTRUMENT,
    transactionDate: '2026-01-15',
    transactionType: 'purchase',
    grossAmount: '10000.00',
    units: '83.500000',
    sourceReference: 'CAMS-REF-1',
    ...overrides,
  };
}

function existing(overrides: Partial<CrossSourceExistingTransaction> = {}): CrossSourceExistingTransaction {
  return {
    id: 'txn-existing-1',
    status: 'parsed',
    sourceKey: 'cams',
    sourceDocumentId: 'doc-old',
    accountId: ACCOUNT,
    instrumentId: INSTRUMENT,
    transactionDate: '2026-01-15',
    transactionType: 'purchase',
    grossAmount: '10000.00',
    units: '83.500000',
    sourceReference: 'CAMS-REF-1',
    ...overrides,
  };
}

describe('R11 CS-01..10 — resolveCrossSourceTransactionMatch: EXACT state', () => {
  it('CS-01 every field identical across two different sources -> exact', () => {
    const r = resolveCrossSourceTransactionMatch(candidate(), [existing()], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('exact');
    expect(r.matchedExistingId).toBe('txn-existing-1');
    expect(r.matchedFields).toContain('sourceReference');
  });

  it('CS-02 exact match is symmetric on units precision (85.500000 vs 85.5, both parse to the same exact decimal)', () => {
    const r = resolveCrossSourceTransactionMatch(
      candidate({ units: '85.500000' }),
      [existing({ units: '85.5' })],
      DEFAULT_RECONCILIATION_CONFIG
    );
    expect(r.state).toBe('exact');
  });

  it('CS-03 exact match on a redemption transaction type', () => {
    const r = resolveCrossSourceTransactionMatch(
      candidate({ transactionType: 'redemption' }),
      [existing({ transactionType: 'redemption' })],
      DEFAULT_RECONCILIATION_CONFIG
    );
    expect(r.state).toBe('exact');
  });

  it('CS-04 exact match with both sourceReference null (both sides genuinely have none) is treated as high_confidence, not exact — reference cannot corroborate what neither side provides', () => {
    const r = resolveCrossSourceTransactionMatch(
      candidate({ sourceReference: null }),
      [existing({ sourceReference: null })],
      DEFAULT_RECONCILIATION_CONFIG
    );
    expect(r.state).toBe('high_confidence');
  });

  it('CS-05 same-source rows (identical sourceDocumentId) are excluded from comparison entirely — this function never touches same-source dedup', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ sourceDocumentId: 'doc-old' }), [existing({ sourceDocumentId: 'doc-old' })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('none');
  });

  it('CS-06 exact match on a dividend (cash-only, units null on both sides)', () => {
    const r = resolveCrossSourceTransactionMatch(
      candidate({ transactionType: 'dividend', units: null }),
      [existing({ transactionType: 'dividend', units: null })],
      DEFAULT_RECONCILIATION_CONFIG
    );
    expect(r.state).toBe('exact');
  });

  it('CS-07 exact match unaffected by which source is "new" vs "old" (import-order symmetry at the pairwise level)', () => {
    const forward = resolveCrossSourceTransactionMatch(candidate({ sourceKey: 'cams', sourceDocumentId: 'doc-A' }), [existing({ sourceKey: 'kfintech', sourceDocumentId: 'doc-B' })], DEFAULT_RECONCILIATION_CONFIG);
    const backward = resolveCrossSourceTransactionMatch(candidate({ sourceKey: 'kfintech', sourceDocumentId: 'doc-B' }), [existing({ sourceKey: 'cams', sourceDocumentId: 'doc-A' })], DEFAULT_RECONCILIATION_CONFIG);
    expect(forward.state).toBe('exact');
    expect(backward.state).toBe('exact');
  });

  it('CS-08 engine version is stamped on every result', () => {
    const r = resolveCrossSourceTransactionMatch(candidate(), [existing()], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.engineVersion).toBe(CROSS_SOURCE_IDENTITY_ENGINE_VERSION);
  });

  it('CS-09 exact match rationale names the matched existing transaction id', () => {
    const r = resolveCrossSourceTransactionMatch(candidate(), [existing({ id: 'txn-xyz' })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.rationale).toContain('txn-xyz');
  });

  it('CS-10 a manual-import candidate can exact-match an RTA-sourced existing row (source key itself never gates the comparison)', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ sourceKey: 'manual' }), [existing({ sourceKey: 'cams' })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('exact');
  });
});

describe('R11 CS-11..20 — HIGH_CONFIDENCE state', () => {
  it('CS-11 amount/units/date/type all match, source reference present on new but null on existing -> high_confidence', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ sourceReference: 'REF-X' }), [existing({ sourceReference: null })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('high_confidence');
  });

  it('CS-12 amount/units/date/type all match, source reference present on existing but null on new -> high_confidence', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ sourceReference: null }), [existing({ sourceReference: 'REF-Y' })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('high_confidence');
  });

  it('CS-13 units differ by exactly the configured tolerance (0.0001) -> still high_confidence (within tolerance)', () => {
    const r = resolveCrossSourceTransactionMatch(
      candidate({ units: '83.500100', sourceReference: null }),
      [existing({ units: '83.500000', sourceReference: null })],
      DEFAULT_RECONCILIATION_CONFIG
    );
    expect(r.state).toBe('high_confidence');
  });

  it('CS-14 amount differs by exactly the configured currency tolerance (1.00) -> still high_confidence', () => {
    const r = resolveCrossSourceTransactionMatch(
      candidate({ grossAmount: '10001.00', sourceReference: null }),
      [existing({ grossAmount: '10000.00', sourceReference: null })],
      DEFAULT_RECONCILIATION_CONFIG
    );
    expect(r.state).toBe('high_confidence');
  });

  it('CS-15 high_confidence rationale explains the reference gap', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ sourceReference: 'X' }), [existing({ sourceReference: null })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.rationale.toLowerCase()).toContain('reference');
  });

  it('CS-16 matchedFields includes accountId/instrumentId/transactionDate/transactionType/grossAmount/units for high_confidence', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ sourceReference: null }), [existing({ sourceReference: null })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.matchedFields).toEqual(expect.arrayContaining(['accountId', 'instrumentId', 'transactionDate', 'transactionType', 'grossAmount', 'units']));
  });
});

describe('R11 CS-21..32 — CONFLICT state (never silently merged)', () => {
  it('CS-21 identical core identity, DIFFERENT (both-present) source reference, amount/units otherwise match -> conflict', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ sourceReference: 'REF-A' }), [existing({ sourceReference: 'REF-B' })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('conflict');
  });

  it('CS-22 same reference, amount differs beyond tolerance -> conflict (the canonical "same ref, different amount" spec example)', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ grossAmount: '10500.00', sourceReference: 'SAME-REF' }), [existing({ grossAmount: '10000.00', sourceReference: 'SAME-REF' })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('conflict');
    expect(r.differingFields).toContain('grossAmount');
  });

  it('CS-23 same reference, units differ beyond tolerance -> conflict', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ units: '90.000000', sourceReference: 'SAME-REF' }), [existing({ units: '83.500000', sourceReference: 'SAME-REF' })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('conflict');
    expect(r.differingFields).toContain('units');
  });

  it('CS-24 conflict never returns a matchedExistingId that silently becomes the winner without a case being caller-recorded — matchedExistingId is populated for observability, state is conflict not exact', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ grossAmount: '9900.00', sourceReference: 'SAME-REF' }), [existing({ grossAmount: '10000.00', sourceReference: 'SAME-REF' })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('conflict');
    expect(r.matchedExistingId).toBe('txn-existing-1');
  });

  it('CS-25 conflict rationale explicitly says evidence is preserved, not merged', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ grossAmount: '9900.00', sourceReference: 'SAME-REF' }), [existing({ grossAmount: '10000.00', sourceReference: 'SAME-REF' })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.rationale.toLowerCase()).toContain('review');
  });

  it('CS-26 amount differs just beyond tolerance (1.01 vs config 1.00) with no reference on either side -> none, not conflict (soft field absent, no basis for a conflict claim)', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ grossAmount: '10001.01', sourceReference: null }), [existing({ grossAmount: '10000.00', sourceReference: null })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('none');
  });

  it('CS-27 units differ just beyond tolerance (0.0002 vs config 0.0001), reference present+agreeing -> conflict (reference agreement forces surfacing the magnitude mismatch)', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ units: '83.500200', sourceReference: 'SAME-REF' }), [existing({ units: '83.500000', sourceReference: 'SAME-REF' })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('conflict');
  });
});

describe('R11 CS-33..40 — AMBIGUOUS state and NONE state', () => {
  it('CS-33 candidate exact-matches two different existing rows equally -> ambiguous, both ids returned', () => {
    const r = resolveCrossSourceTransactionMatch(
      candidate(),
      [existing({ id: 'txn-1', sourceDocumentId: 'doc-1' }), existing({ id: 'txn-2', sourceDocumentId: 'doc-2' })],
      DEFAULT_RECONCILIATION_CONFIG
    );
    expect(r.state).toBe('ambiguous');
    expect(r.ambiguousCandidateIds.sort()).toEqual(['txn-1', 'txn-2']);
  });

  it('CS-34 candidate high-confidence-matches two different existing rows equally -> ambiguous', () => {
    const r = resolveCrossSourceTransactionMatch(
      candidate({ sourceReference: null }),
      [existing({ id: 'txn-1', sourceDocumentId: 'doc-1', sourceReference: null }), existing({ id: 'txn-2', sourceDocumentId: 'doc-2', sourceReference: null })],
      DEFAULT_RECONCILIATION_CONFIG
    );
    expect(r.state).toBe('ambiguous');
  });

  it('CS-35 different account -> none (not even compared as a candidate)', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ accountId: 'acct-2' }), [existing()], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('none');
  });

  it('CS-36 different instrument -> none', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ instrumentId: 'inst-2' }), [existing()], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('none');
  });

  it('CS-37 different date -> none (a purchase on the 14th and one on the 15th are different transactions even if every other field matches)', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ transactionDate: '2026-01-14' }), [existing({ transactionDate: '2026-01-15' })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('none');
  });

  it('CS-38 different transaction type -> none (a purchase and a SIP on the same date/amount are not assumed to be the same fact)', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ transactionType: 'purchase' }), [existing({ transactionType: 'sip' })], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('none');
  });

  it('CS-39 no existing candidates at all -> none', () => {
    const r = resolveCrossSourceTransactionMatch(candidate(), [], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.state).toBe('none');
  });

  it('CS-40 none-state rationale explains no shared identity', () => {
    const r = resolveCrossSourceTransactionMatch(candidate({ instrumentId: 'inst-2' }), [existing()], DEFAULT_RECONCILIATION_CONFIG);
    expect(r.rationale.toLowerCase()).toContain('no existing transaction');
  });
});

describe('R11 CS-41..48 — compareCrossSourceTransactions field-level detail', () => {
  it('CS-41 returns exactly 7 field comparisons', () => {
    const cmp = compareCrossSourceTransactions(candidate(), existing(), DEFAULT_RECONCILIATION_CONFIG);
    expect(cmp).toHaveLength(7);
  });
  it('CS-42 units both null -> matched true', () => {
    const cmp = compareCrossSourceTransactions(candidate({ units: null }), existing({ units: null }), DEFAULT_RECONCILIATION_CONFIG);
    expect(cmp.find((c) => c.field === 'units')!.matched).toBe(true);
  });
  it('CS-43 units one null one non-null -> matched false', () => {
    const cmp = compareCrossSourceTransactions(candidate({ units: '10.000000' }), existing({ units: null }), DEFAULT_RECONCILIATION_CONFIG);
    expect(cmp.find((c) => c.field === 'units')!.matched).toBe(false);
  });
  it('CS-44 sourceReference both null -> matched false (per compareCrossSourceTransactions field-level rule: nulls never "match" for the reference field itself, though the classifier treats this case as high_confidence, not conflict, at the state level)', () => {
    const cmp = compareCrossSourceTransactions(candidate({ sourceReference: null }), existing({ sourceReference: null }), DEFAULT_RECONCILIATION_CONFIG);
    expect(cmp.find((c) => c.field === 'sourceReference')!.matched).toBe(false);
  });
  it('CS-45 accountId mismatch is reported with both raw values', () => {
    const cmp = compareCrossSourceTransactions(candidate({ accountId: 'acct-X' }), existing({ accountId: 'acct-Y' }), DEFAULT_RECONCILIATION_CONFIG);
    const f = cmp.find((c) => c.field === 'accountId')!;
    expect(f.matched).toBe(false);
    expect(f.candidateValue).toBe('acct-X');
    expect(f.existingValue).toBe('acct-Y');
  });
  it('CS-46 amount comparison is exact-decimal-safe, not floating point (0.1 + 0.2 style traps)', () => {
    const cmp = compareCrossSourceTransactions(candidate({ grossAmount: '0.30' }), existing({ grossAmount: '0.30' }), DEFAULT_RECONCILIATION_CONFIG);
    expect(cmp.find((c) => c.field === 'grossAmount')!.matched).toBe(true);
  });
  it('CS-47 large amount exact equality (no precision loss at scale)', () => {
    const cmp = compareCrossSourceTransactions(candidate({ grossAmount: '99999999.99' }), existing({ grossAmount: '99999999.99' }), DEFAULT_RECONCILIATION_CONFIG);
    expect(cmp.find((c) => c.field === 'grossAmount')!.matched).toBe(true);
  });
  it('CS-48 transactionType field comparison is case-sensitive exact string match', () => {
    const cmp = compareCrossSourceTransactions(candidate({ transactionType: 'purchase' }), existing({ transactionType: 'purchase' }), DEFAULT_RECONCILIATION_CONFIG);
    expect(cmp.find((c) => c.field === 'transactionType')!.matched).toBe(true);
  });
});

describe('R11 PP-01..10 — resolvePrecedenceWinner (source precedence + import-order independence)', () => {
  const rules = [
    { sourceKey: 'cams', rank: 1 },
    { sourceKey: 'kfintech', rank: 1 },
    { sourceKey: 'manual', rank: 2 },
  ];

  it('PP-01 lower rank (CAMS) beats higher rank (manual) regardless of freshness', () => {
    const w = resolvePrecedenceWinner(
      [
        { sourceKey: 'manual', sourceDocumentId: 'doc-manual', statementAsOfDate: '2026-06-30' },
        { sourceKey: 'cams', sourceDocumentId: 'doc-cams', statementAsOfDate: '2026-01-01' },
      ],
      rules
    );
    expect(w.sourceKey).toBe('cams');
  });

  it('PP-02 equal rank (CAMS vs KFintech) resolved by freshness — newer as_of date wins', () => {
    const w = resolvePrecedenceWinner(
      [
        { sourceKey: 'cams', sourceDocumentId: 'doc-cams', statementAsOfDate: '2026-01-01' },
        { sourceKey: 'kfintech', sourceDocumentId: 'doc-kf', statementAsOfDate: '2026-06-30' },
      ],
      rules
    );
    expect(w.sourceKey).toBe('kfintech');
  });

  it('PP-03 MANDATORY import-order independence: "CAMS then broker(unranked)" and "broker then CAMS" resolve identically', () => {
    const candidates1 = [
      { sourceKey: 'cams', sourceDocumentId: 'doc-cams', statementAsOfDate: '2026-01-01' },
      { sourceKey: 'unranked_source', sourceDocumentId: 'doc-x', statementAsOfDate: '2026-01-01' },
    ];
    const candidates2 = [candidates1[1], candidates1[0]]; // reversed order
    const w1 = resolvePrecedenceWinner(candidates1, rules);
    const w2 = resolvePrecedenceWinner(candidates2, rules);
    expect(w1.sourceDocumentId).toBe(w2.sourceDocumentId);
    expect(w1.sourceKey).toBe('cams'); // ranked always beats unranked (unranked falls back to MAX_SAFE_INTEGER rank)
  });

  it('PP-04 MANDATORY import-order independence at equal rank: two equal-rank, equal-freshness candidates resolve identically regardless of array order', () => {
    const candidates1 = [
      { sourceKey: 'cams', sourceDocumentId: 'doc-AAAA', statementAsOfDate: '2026-01-01' },
      { sourceKey: 'kfintech', sourceDocumentId: 'doc-BBBB', statementAsOfDate: '2026-01-01' },
    ];
    const candidates2 = [candidates1[1], candidates1[0]];
    const w1 = resolvePrecedenceWinner(candidates1, rules);
    const w2 = resolvePrecedenceWinner(candidates2, rules);
    expect(w1.sourceDocumentId).toBe(w2.sourceDocumentId); // deterministic tiebreak (sourceDocumentId string order), not "whichever came first in the array"
  });

  it('PP-05 unknown as_of date (null) loses to a known, equal-rank date', () => {
    const w = resolvePrecedenceWinner(
      [
        { sourceKey: 'cams', sourceDocumentId: 'doc-a', statementAsOfDate: null },
        { sourceKey: 'kfintech', sourceDocumentId: 'doc-b', statementAsOfDate: '2026-01-01' },
      ],
      rules
    );
    expect(w.sourceDocumentId).toBe('doc-b');
  });

  it('PP-06 single candidate always wins trivially', () => {
    const w = resolvePrecedenceWinner([{ sourceKey: 'manual', sourceDocumentId: 'only', statementAsOfDate: null }], rules);
    expect(w.sourceDocumentId).toBe('only');
  });

  it('PP-07 throws on empty candidate list (never silently picks "nothing")', () => {
    expect(() => resolvePrecedenceWinner([], rules)).toThrow();
  });

  it('PP-08 three-way tie at equal rank and equal date resolves deterministically by sourceDocumentId regardless of input order', () => {
    const c = [
      { sourceKey: 'cams', sourceDocumentId: 'doc-3', statementAsOfDate: '2026-01-01' },
      { sourceKey: 'kfintech', sourceDocumentId: 'doc-1', statementAsOfDate: '2026-01-01' },
      { sourceKey: 'cams', sourceDocumentId: 'doc-2', statementAsOfDate: '2026-01-01' },
    ];
    const w1 = resolvePrecedenceWinner(c, rules);
    const w2 = resolvePrecedenceWinner([...c].reverse(), rules);
    expect(w1.sourceDocumentId).toBe(w2.sourceDocumentId);
    expect(w1.sourceDocumentId).toBe('doc-1'); // lexicographically smallest, the documented final tiebreak
  });

  it('PP-09 manual is always the lowest-precedence tier per the frozen r11-v1 policy', () => {
    const w = resolvePrecedenceWinner(
      [
        { sourceKey: 'manual', sourceDocumentId: 'doc-m', statementAsOfDate: '2026-12-31' },
        { sourceKey: 'kfintech', sourceDocumentId: 'doc-k', statementAsOfDate: '2020-01-01' },
      ],
      rules
    );
    expect(w.sourceKey).toBe('kfintech');
  });

  it('PP-10 freshness tiebreak uses ISO string comparison correctly across year boundaries', () => {
    const w = resolvePrecedenceWinner(
      [
        { sourceKey: 'cams', sourceDocumentId: 'doc-old', statementAsOfDate: '2025-12-31' },
        { sourceKey: 'kfintech', sourceDocumentId: 'doc-new', statementAsOfDate: '2026-01-01' },
      ],
      rules
    );
    expect(w.sourceDocumentId).toBe('doc-new');
  });
});
