// M12C — PC4 financial-integrity closure (M12 dispatch §8.2, §8.3, §8.4).
//
// Every fixture in this file is SYNTHETIC. No folio number, PAN, holder name,
// scheme name, amount or unit figure here is, or is derived from, the Product
// Owner's real statement. The unit magnitudes that DO appear (156.618, 111.505)
// are the reconciliation VARIANCES already published in
// `docs/investment-intelligence/II_PC4_STATUS_2026_09_07.md` and M1's verdict —
// they are reproduced here so the fixture asks the same arithmetic question the
// real residual asks, not because any real row was copied.
//
// Structure, deliberately: each section states the RED it was written against.

import { describe, it, expect } from 'vitest';
import { classifyUnparsedTableLine, camsParser } from '@/lib/services/investment-intelligence/parsers/camsParser';
import { parseDocumentWithParser } from '@/lib/services/investment-intelligence/parsers/registry';
import { OPENING_BALANCE_SOURCE_REFERENCE } from '@/lib/services/investment-intelligence/openingBalanceMarker';
import { reconcilePosition, determineHistoryCompleteness, unitDeltaForTransaction } from '@/lib/services/investment-intelligence/reconciliation';
import { DEFAULT_RECONCILIATION_CONFIG } from '@/lib/services/investment-intelligence/reconciliationConfig';
import { parseExactDecimal } from '@/lib/services/investment-intelligence/decimal';

const scaled = (s: string): bigint => {
  const p = parseExactDecimal(s);
  if (!p.ok) throw new Error(`fixture value ${s} is not parseable`);
  return p.scaled;
};

// ---------------------------------------------------------------------------
// §8.2 — the 251 benign findings, and the severity classification at SOURCE
// ---------------------------------------------------------------------------
//
// RED before this change: `camsParser.ts` emitted `unparseable_transaction_row`
// at severity `error` for EVERY line that failed the row grammar. On the real
// production run that was 251 findings, `parsed.errors.length` was therefore
// 251, `documentProcessing.ts:885` set `parserHasFatalError`, and
// `certification.ts:65` blocked ALL 17 positions with `parser_fatal_error`.
//
// This suite asserts the classification at its source. It deliberately does NOT
// assert anything about `certification.ts` — that gate is correct, is pinned by
// PC4-INV-19, and must stay exactly as strict as it is.
describe('M12C §8.2 — severity of a table line no row grammar could read', () => {
  it('KEEPS severity `error` for a date-led, money-shaped line — a real unreadable transaction row', () => {
    // The one case the `parser_fatal_error` blocker exists for. Untouched.
    for (const line of [
      '05-Jan-2025   SIP Purchase   3000.00 ~~ 25.000 ~~ 120.0000',
      '(20-Feb-2025) Purchase 1,23,456.78 garbled',
      '05-Mar-2025 Redemption (3000.00) <unreadable>',
    ]) {
      expect(classifyUnparsedTableLine(line), line).toEqual({ code: 'unparseable_transaction_row', severity: 'error' });
    }
  });

  it('downgrades a money-bearing line that is NOT date-led to `warning`, never to silence and never to `info`', () => {
    // An amount is printed, so it must stay visible in the run's warnings even
    // though this layout's grammar proves it is not a transaction row.
    const c = classifyUnparsedTableLine('Total valuation as at period end 1,234.56');
    expect(c.severity).toBe('warning');
    expect(c.code).toBe('unparseable_non_transaction_row_with_amount');
  });

  it('classifies boilerplate as `info`', () => {
    for (const line of [
      'Page 4 of 19',
      '01-Jan-1990 To 06-Sep-2026',
      '05-Sep-2026',
      'Visit www.camsonline.com for details',
      'Queries to investor.services@example.invalid',
    ]) {
      const c = classifyUnparsedTableLine(line);
      expect(c.severity, line).toBe('info');
      expect(c.code, line).toBe('non_transaction_boilerplate');
    }
  });

  it('classifies a lifecycle marker carrying no digit at all as `info`', () => {
    for (const line of ['*** Stamp Duty ***', '*** Systematic Investment Rejection ***', '*** Transaction Rejected ***']) {
      expect(classifyUnparsedTableLine(line), line).toEqual({ code: 'non_economic_lifecycle_marker', severity: 'info' });
    }
  });

  it('classifies a regulatory footnote as `info`', () => {
    for (const line of [
      'Stamp duty at 0.005% is applicable with effect from 01-Jul-2020 on all purchases.',
      'TDS deducted at 10% where applicable under section 194K.',
    ]) {
      const c = classifyUnparsedTableLine(line);
      expect(c.severity, line).toBe('info');
      expect(c.code, line).toBe('regulatory_footnote');
    }
  });

  it('does not mistake a dotted version stamp or a percentage for an amount', () => {
    // Both appear on the real document's per-page stamp lines. Neither is money.
    expect(classifyUnparsedTableLine('CAMSCASWS-1.2.3, Version:V3.5 Live-2.0.1').severity).toBe('info');
    expect(classifyUnparsedTableLine('Exit load 1.00% if redeemed within 12 months').severity).toBe('info');
  });

  it('END TO END: a statement whose table carries only benign non-transaction lines produces ZERO error-severity findings', () => {
    const doc = [
      'CAMS Consolidated Account Statement',
      'Statement Period : 01-Jan-2025 To 30-Jun-2025',
      '',
      'Folio No: 9900000000001',
      'PAN: ZZZZZ0000Z',
      'Name: SYNTHETIC FIXTURE HOLDER',
      'Holding Mode: SI',
      '',
      'AMC Name: Synthetic Mutual Fund',
      'Scheme Name: Synthetic Equity Fund - Growth (Direct Plan)',
      'ISIN: INF000000001',
      'AMFI Code: 999901',
      'Registrar: CAMS',
      '',
      'Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance',
      '05-Jan-2025   SIP Purchase                          3000.00  25.000  120.0000  25.000 [Ref: SY0001]',
      '*** Stamp Duty ***',
      'Page 2 of 3',
      '01-Jan-1990 To 30-Jun-2025',
      'Stamp duty at 0.005% is applicable with effect from 01-Jul-2020.',
      'Visit www.example.invalid for details',
      '20-Jan-2025   Purchase                              3000.00  24.793  121.0000  49.793 [Ref: SY0002]',
      '',
      'Closing Unit Balance as on 30-Jun-2025 : 49.793 Units   Valuation : Rs. 6025.00   NAV as on 30-Jun-2025 : Rs. 121.0000',
      '',
    ].join('\n');

    const parsed = parseDocumentWithParser(camsParser, doc);

    // Anti-vacuity: the benign lines really were seen and really did fail the
    // row grammar — this test would pass for the wrong reason if the parser had
    // simply skipped them before reaching the classifier.
    const benign = parsed.warnings.filter((w) =>
      ['non_transaction_boilerplate', 'non_economic_lifecycle_marker', 'regulatory_footnote'].includes(w.code),
    );
    expect(benign.length).toBeGreaterThanOrEqual(4);

    // The claim itself. THIS is the assertion that was RED before §8.2.
    expect(parsed.errors).toEqual([]);

    // And the real rows are still read, so the downgrade did not come at the
    // cost of extraction.
    expect(parsed.transactions).toHaveLength(2);
  });

  it('END TO END: a genuinely unreadable date-led money row STILL produces an error-severity finding', () => {
    // The negative control for the test above. If this ever goes green-by-zero
    // the downgrade has been taken too far.
    const doc = [
      'CAMS Consolidated Account Statement',
      'Statement Period : 01-Jan-2025 To 30-Jun-2025',
      '',
      'Folio No: 9900000000001',
      'PAN: ZZZZZ0000Z',
      'Name: SYNTHETIC FIXTURE HOLDER',
      'Holding Mode: SI',
      '',
      'AMC Name: Synthetic Mutual Fund',
      'Scheme Name: Synthetic Equity Fund - Growth (Direct Plan)',
      'ISIN: INF000000001',
      'AMFI Code: 999901',
      'Registrar: CAMS',
      '',
      'Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance',
      '05-Jan-2025   SIP Purchase                          3000.00  25.000  120.0000  25.000 [Ref: SY0001]',
      '20-Jan-2025   Purchase  3000.00 ~~CORRUPTED~~ 121.0000',
      '',
      'Closing Unit Balance as on 30-Jun-2025 : 49.793 Units   Valuation : Rs. 6025.00   NAV as on 30-Jun-2025 : Rs. 121.0000',
      '',
    ].join('\n');

    const parsed = parseDocumentWithParser(camsParser, doc);
    expect(parsed.errors.length).toBeGreaterThanOrEqual(1);
    expect(parsed.errors.some((e) => e.code === 'unparseable_transaction_row')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §8.3 — the discarded opening balance (`M3-F1`)
// ---------------------------------------------------------------------------

const CAS_WITH_OPENING_BALANCE = (opening: string, period = 'Statement Period : 01-Apr-2024 To 31-Mar-2025'): string =>
  [
    'CAMS Consolidated Account Statement',
    period,
    '',
    'Folio No: 9900000000002',
    'PAN: ZZZZZ0000Z',
    'Name: SYNTHETIC FIXTURE HOLDER',
    'Holding Mode: SI',
    '',
    'AMC Name: Synthetic Mutual Fund',
    'Scheme Name: Synthetic Large Cap Fund - Growth (Direct Plan)',
    'ISIN: INF000000002',
    'AMFI Code: 999902',
    'Registrar: CAMS',
    '',
    `Opening Unit Balance : ${opening}`,
    '05-Jun-2024   SIP Purchase                          3000.00  25.000  120.0000  181.618 [Ref: SY1001]',
    '05-Jul-2024   SIP Purchase                          3000.00  24.793  121.0000  206.411 [Ref: SY1002]',
    '',
    'Closing Unit Balance as on 31-Mar-2025 : 206.411 Units   Valuation : Rs. 24975.73   NAV as on 31-Mar-2025 : Rs. 121.0000',
    '',
  ].join('\n');

describe('M12C §8.3 — a printed opening unit balance is preserved as an adjustment, and nothing more', () => {
  it('RED-proof: WITHOUT the opening balance in the stream, the position reconciles short by exactly the opening balance', () => {
    // This is the arithmetic the production residuals are made of, isolated.
    // `reconciled_opening_units` is 0 and `history_completeness` is
    // `complete_from_inception` on all 17 real positions.
    const result = reconcilePosition({
      openingUnitsScaled: null,
      transactions: [
        { canonicalType: 'sip', unitsScaled: scaled('25.000') },
        { canonicalType: 'sip', unitsScaled: scaled('24.793') },
      ],
      statementClosingUnitsScaled: scaled('206.411'),
      historyCompleteness: 'complete_from_inception',
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(result.reconciledOpeningUnitsScaled).toBe(BigInt(0));
    expect(result.unitVarianceScaled).toBe(scaled('-156.618'));
    expect(result.withinTolerance).toBe(false);
  });

  it('GREEN: the parser now emits the opening balance, and the SAME position reconciles to variance zero', () => {
    const parsed = parseDocumentWithParser(camsParser, CAS_WITH_OPENING_BALANCE('156.618'));

    const openingRows = parsed.transactions.filter((t) => t.sourceReference === OPENING_BALANCE_SOURCE_REFERENCE);
    expect(openingRows).toHaveLength(1);
    const opening = openingRows[0];

    // The exact fix shape the dispatch mandates, asserted field by field.
    expect(opening.canonicalType).toBe('adjustment');
    expect(opening.unitsScaled).toBe(scaled('156.618'));
    expect(opening.amountScaled).toBe(BigInt(0)); // never an amount-as-transaction
    expect(opening.navScaled).toBeNull(); // no NAV invented
    expect(opening.transactionDateIso).toBe('2024-04-01'); // the document's OWN printed period start — never invented

    // Now drive the real reconciliation engine with what the parser produced.
    const historyCompleteness = determineHistoryCompleteness({
      hasExplicitOpeningBalanceTransaction: parsed.transactions.some((t) => t.sourceReference === OPENING_BALANCE_SOURCE_REFERENCE),
      hasAnyTransactionHistory: parsed.transactions.length > 0,
      hasClosingHoldingSnapshot: true,
      statementCoversFromInception: false,
    });
    expect(historyCompleteness).toBe('complete_from_known_opening_balance');

    const result = reconcilePosition({
      openingUnitsScaled: null,
      transactions: parsed.transactions.map((t) => ({ canonicalType: t.canonicalType, unitsScaled: t.unitsScaled })),
      statementClosingUnitsScaled: scaled('206.411'),
      historyCompleteness,
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(result.unitVarianceScaled).toBe(BigInt(0));
    expect(result.withinTolerance).toBe(true);
  });

  it('a ZERO opening balance emits NO row at all — pre-M12C behaviour is byte-identical', () => {
    // The blast-radius bound. A since-inception CAS prints `0.000` for every
    // scheme; emitting no-op rows for those would flip all 17 real positions
    // out of `complete_from_inception` and change certified behaviour for the
    // 12 that reconcile today.
    const parsed = parseDocumentWithParser(camsParser, CAS_WITH_OPENING_BALANCE('0.000'));
    expect(parsed.transactions.filter((t) => t.sourceReference === OPENING_BALANCE_SOURCE_REFERENCE)).toHaveLength(0);
    expect(parsed.transactions).toHaveLength(2);
    expect(parsed.errors).toEqual([]);
  });

  it('a NON-ZERO opening balance with no labelled statement-period start FAILS CLOSED — no date is invented', () => {
    // A real "since inception" request prints its range unlabelled and its
    // leading date is a sentinel placeholder, so there is no honest as-of date
    // available. The position must block, not reconcile from a fabricated zero.
    const parsed = parseDocumentWithParser(camsParser, CAS_WITH_OPENING_BALANCE('156.618', '01-Jan-1990 To 31-Mar-2025'));
    expect(parsed.transactions.filter((t) => t.sourceReference === OPENING_BALANCE_SOURCE_REFERENCE)).toHaveLength(0);
    expect(parsed.errors.some((e) => e.code === 'opening_balance_not_datable')).toBe(true);
  });

  it('the preserved opening balance can NEVER become a tax lot — `adjustment` is absent from R6 ACQUISITION_TYPE_MAP', async () => {
    // Read the tax engine's own acquisition vocabulary from its source rather
    // than restating it, so a future widening of that map breaks this test.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'lib/services/investment-intelligence/taxRepository.ts'), 'utf8');
    const block = /const ACQUISITION_TYPE_MAP[^=]*=\s*\{([\s\S]*?)\};/.exec(src);
    expect(block, 'ACQUISITION_TYPE_MAP not found — the citation this test rests on has moved').not.toBeNull();
    expect(block![1]).not.toMatch(/\badjustment\b/);
    // Anti-vacuity: the regex really did capture the map.
    expect(block![1]).toMatch(/\bpurchase\b/);
  });

  it('the preserved opening balance contributes its units to reconciliation with its printed sign', () => {
    // `adjustment` is `passthrough` in DIRECTION_TABLE — the parser's sign is
    // authoritative and is never re-magnitudised.
    expect(unitDeltaForTransaction({ canonicalType: 'adjustment', unitsScaled: scaled('156.618') })).toBe(scaled('156.618'));
    expect(unitDeltaForTransaction({ canonicalType: 'adjustment', unitsScaled: scaled('-156.618') })).toBe(scaled('-156.618'));
  });
});

// ---------------------------------------------------------------------------
// §8.4 — the arithmetic of the one fully-attributed production residual
// ---------------------------------------------------------------------------
//
// The Kotak +111.505 residual is explained exactly by TWO interacting facts,
// both reproduced from the real production rows on 2026-09-16:
//
//   (a) the same three rejection events are persisted TWICE, once as a
//       `purchase` row carrying NEGATIVE printed units (written by parse run
//       `9de0bb86`) and once as a `reversal` row (written by a different run);
//   (b) `DIRECTION_TABLE` types `purchase` as an inflow, so
//       `unitDeltaForTransaction` takes `abs(units)` and flips the negative
//       copy to a POSITIVE contribution.
//
// Net error = +2 x 111.505 (the sign flip) - 111.505 (the correct copy)
//           = +111.505, exactly the observed variance.
//
// This test pins the ARITHMETIC so the explanation in the M12C report is a
// property of the code rather than a paragraph. It is deliberately NOT a fix:
// the stale rows are the Product Owner's real production data and removing
// them is an operator action (§8.4 / OA-11), not an autonomous one.
describe('M12C §8.4 — the Kotak +111.505 residual, reproduced arithmetically', () => {
  const REJECTIONS = ['37.956', '36.713', '36.836'];

  it('a negative-units row typed `purchase` is counted as a POSITIVE inflow', () => {
    for (const u of REJECTIONS) {
      expect(unitDeltaForTransaction({ canonicalType: 'purchase', unitsScaled: scaled(`-${u}`) })).toBe(scaled(u));
    }
  });

  it('the same row typed `reversal` is counted with its printed sign', () => {
    for (const u of REJECTIONS) {
      expect(unitDeltaForTransaction({ canonicalType: 'reversal', unitsScaled: scaled(`-${u}`) })).toBe(scaled(`-${u}`));
    }
  });

  it('double-persisting the three events under both classifications yields EXACTLY the observed +111.505', () => {
    const positiveInflows = scaled('578.746'); // the correctly-signed purchases
    const truth = scaled('467.241'); // the statement's printed closing balance

    const stream = [
      { canonicalType: 'purchase' as const, unitsScaled: positiveInflows },
      ...REJECTIONS.map((u) => ({ canonicalType: 'purchase' as const, unitsScaled: scaled(`-${u}`) })),
      ...REJECTIONS.map((u) => ({ canonicalType: 'reversal' as const, unitsScaled: scaled(`-${u}`) })),
    ];

    const result = reconcilePosition({
      openingUnitsScaled: null,
      transactions: stream,
      statementClosingUnitsScaled: truth,
      historyCompleteness: 'complete_from_inception',
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(result.reconciledClosingUnitsScaled).toBe(scaled('578.746'));
    expect(result.unitVarianceScaled).toBe(scaled('111.505'));
  });

  it('CONTROL: with the duplicate `purchase` copies removed, the SAME stream reconciles to zero', () => {
    // Proves the attribution rather than merely asserting it: the duplication
    // is both necessary and sufficient to produce the residual.
    const result = reconcilePosition({
      openingUnitsScaled: null,
      transactions: [
        { canonicalType: 'purchase', unitsScaled: scaled('578.746') },
        ...REJECTIONS.map((u) => ({ canonicalType: 'reversal' as const, unitsScaled: scaled(`-${u}`) })),
      ],
      statementClosingUnitsScaled: scaled('467.241'),
      historyCompleteness: 'complete_from_inception',
      config: DEFAULT_RECONCILIATION_CONFIG,
    });
    expect(result.unitVarianceScaled).toBe(BigInt(0));
  });
});
