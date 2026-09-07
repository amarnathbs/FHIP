import { describe, it, expect } from 'vitest';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import { scaledToDecimalString } from '@/lib/services/investment-intelligence/decimal';

// Real production incident, 2026-09-07: a real user's 19-page since-inception
// CAMS statement had 9 of 17 schemes come back with ZERO transactions, and
// every other scheme was missing 30-90% of its real transaction history,
// despite the run reporting "succeeded" and parseHoldings() correctly
// identifying all 17 schemes with exact matching closing balances (proving
// the scheme-block boundaries themselves were never the problem). Root-caused
// live by extracting the actual document's text and running it through the
// real parser locally. THREE independent, real structural defects were found
// and fixed together (each is exercised by its own describe block below).
// Every value in every fixture is invented (folios, PANs, ISINs, ARNs,
// fund/scheme names, amounts) -- these reproduce the STRUCTURAL shape of the
// real defects, matching this codebase's own "zero real values" fixture
// convention, not any of the real document's actual content.

describe('CAMS alt-layout: page-level column header not reprinted per scheme (real production incident, 2026-09-07)', () => {
  // The real document prints "Date Amount Price Units Transaction... Unit
  // Balance" ONCE at the top of a page, not once per scheme. Every scheme's
  // own AMC-Name/Scheme-Name/Folio-No lines reset `inTable = false`
  // (correctly, in the ordinary per-scheme-header case), and nothing turned
  // it back on for a LATER scheme's own rows on that same page -- silently
  // dropping its entire transaction table with no warning at all. Fixed by
  // also treating "Opening Unit Balance: <units>" (a genuinely per-scheme
  // structural marker present in every real scheme block) as turning
  // `inTable` on.
  function buildText(): string {
    return [
      'ZQWX-STMT-TRK-2026-CAMS-PAGEHDR',
      'Consolidated Account Statement',
      'Statement Period : 01-Jan-2020 To 31-Dec-2025',
      '',
      // The column header appears ONCE, before the FIRST scheme on the
      // page -- exactly like the real document's per-page (not per-scheme)
      // header.
      'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
      '',
      'Folio No: 8800220011001',
      'PAN: PGHDR001F',
      'Nominee 1:  Nominee 2:  Nominee 3:',
      'Aurora Value Fund - Growth Plan - ISIN: INF700K01AA1(Advisor: ARN00700) Registrar : CAMS',
      ' Opening Unit Balance: 0.000',
      '01-Feb-2020   10,000.00        50.0000      200.000     Purchase                             200.000  [Ref: PAGEHDR-A-001]',
      'Closing Unit Balance: 200.000 Total Cost Value: Rs. 10,000.00',
      '',
      // SECOND scheme on the SAME page -- no column header is reprinted
      // before it (the real defect's exact shape). Only "Opening Unit
      // Balance:" precedes its own rows.
      'Folio No: 8800220011002',
      'PAN: PGHDR002F',
      'Nominee 1:  Nominee 2:  Nominee 3:',
      'Solstice Growth Fund - Growth Plan - ISIN: INF700K01BB2(Advisor: ARN00701) Registrar : CAMS',
      ' Opening Unit Balance: 0.000',
      '15-Mar-2020   5,000.00         25.0000      200.000     Purchase                             200.000   [Ref: PAGEHDR-B-001]',
      'Closing Unit Balance: 200.000 Total Cost Value: Rs. 5,000.00',
    ].join('\n');
  }

  it('the FIRST scheme after the page header still parses (baseline, must not regress)', () => {
    const parsed = parseExtractedDocument(buildText()).parsed!;
    const txn = parsed.transactions.find((t) => t.sourceReference === 'PAGEHDR-A-001');
    expect(txn).toBeTruthy();
    expect(txn!.scheme.rawSchemeName).toContain('Aurora Value Fund');
  });

  it('a SECOND scheme on the same page, with no reprinted column header before its rows, still parses (the real defect)', () => {
    const parsed = parseExtractedDocument(buildText()).parsed!;
    const txn = parsed.transactions.find((t) => t.sourceReference === 'PAGEHDR-B-001');
    expect(txn).toBeTruthy();
    expect(txn!.scheme.rawSchemeName).toContain('Solstice Growth Fund');
    expect(scaledToDecimalString(txn!.unitsScaled!, 3)).toBe('200.000');
    expect(scaledToDecimalString(txn!.amountScaled, 2)).toBe('5000.00');
  });
});

describe('CAMS alt-layout: Price and Units columns glued with no separator (real production incident, 2026-09-07)', () => {
  // pdf-parse's column-gap heuristic can omit the space between the Price
  // and Units columns when the source PDF's rendered gap is too narrow --
  // e.g. a real Price of 12.51 and Units of 799.361 extracted as the
  // literal text "12.51799.361". A naive split is unsafe (multiple
  // syntactically-valid two-number decompositions exist); the fix
  // disambiguates using the row's own arithmetic (price * units ~= amount),
  // accepting a split only when exactly one candidate satisfies it.
  function buildText(gluedRow: string): string {
    return [
      'ZQWX-STMT-TRK-2026-CAMS-GLUED',
      'Consolidated Account Statement',
      'Statement Period : 01-Jan-2020 To 31-Dec-2025',
      '',
      'Folio No: 8800220011003',
      'PAN: PGLUED003F',
      'Nominee 1:  Nominee 2:  Nominee 3:',
      'Meridian Equity Fund - Growth Plan - ISIN: INF700K01CC3(Advisor: ARN00702) Registrar : CAMS',
      'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
      ' Opening Unit Balance: 0.000',
      gluedRow,
      'Closing Unit Balance: 799.361 Total Cost Value: Rs. 10,000.00',
    ].join('\n');
  }

  it('a glued Price+Units run is correctly split using the row\'s own amount = price * units proof', () => {
    // Real price 12.51, real units 799.361 -> 12.51 * 799.361 = 9999.9992 ~= 10,000.00.
    const line = '17-Sep-2020   10,000.00        12.51799.361Systematic Investment                999.361  [Ref: GLUED-001]';
    const parsed = parseExtractedDocument(buildText(line)).parsed!;
    const txn = parsed.transactions.find((t) => t.sourceReference === 'GLUED-001');
    expect(txn).toBeTruthy();
    expect(scaledToDecimalString(txn!.navScaled!, 4)).toBe('12.5100');
    expect(scaledToDecimalString(txn!.unitsScaled!, 3)).toBe('799.361');
    expect(txn!.rawTransactionTypeText).toBe('Systematic Investment');
  });

  it('an AMBIGUOUS glued run (no split uniquely satisfies the arithmetic proof) is reported as an honest parse failure, never a guess', () => {
    // Constructed so amount is far too small for EITHER "12.51"/"799.361" or
    // any other split of "12.51799.361" to plausibly multiply back to it --
    // no candidate passes the tolerance check, so the row must be rejected
    // outright rather than silently accepted with a wrong split.
    const line = '17-Sep-2020   1.00        12.51799.361Systematic Investment                999.361  [Ref: GLUED-AMBIGUOUS]';
    const parsed = parseExtractedDocument(buildText(line)).parsed!;
    const txn = parsed.transactions.find((t) => t.sourceReference === 'GLUED-AMBIGUOUS');
    expect(txn).toBeUndefined();
    const errors = parsed.errors.filter((e) => e.code === 'unparseable_transaction_row');
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('CAMS alt-layout: Stamp Duty/STT fee row split across two lines (real production incident, 2026-09-07)', () => {
  // ALT_FEE_ROW_RE already handled a fee row printed on ONE line ("<date>
  // <amount>*** Stamp Duty ***"). The real document also prints most of
  // these split across TWO lines instead -- "<date> <amount>" alone, then
  // "*** Stamp Duty ***"/"*** STT Paid ***" alone on the very next line.
  // This was the single largest source of missed transactions in the real
  // document once the two defects above were fixed.
  function buildText(): string {
    return [
      'ZQWX-STMT-TRK-2026-CAMS-SPLITFEE',
      'Consolidated Account Statement',
      'Statement Period : 01-Jan-2020 To 31-Dec-2025',
      '',
      'Folio No: 8800220011004',
      'PAN: PSPLIT004F',
      'Nominee 1:  Nominee 2:  Nominee 3:',
      'Zenith Balanced Fund - Growth Plan - ISIN: INF700K01DD4(Advisor: ARN00703) Registrar : CAMS',
      'Date          Amount           Price        Units       Transaction Type                    Unit Balance',
      ' Opening Unit Balance: 0.000',
      '01-Apr-2021   999.95           100.0000     9.9995      Purchase                             9.9995   [Ref: SPLITFEE-PURCHASE-001]',
      // The fee row itself: date+amount alone, label on the NEXT line.
      '01-Apr-2021   0.05',
      '*** Stamp Duty ***',
      // A second fee shape ("STT Paid") to prove both labels this regex
      // recognises are handled, not just Stamp Duty.
      '02-Apr-2021   0.10',
      '*** STT Paid ***',
      'Closing Unit Balance: 9.9995 Total Cost Value: Rs. 999.95',
    ].join('\n');
  }

  it('the genuine purchase row on its own line is unaffected (baseline)', () => {
    const parsed = parseExtractedDocument(buildText()).parsed!;
    const txn = parsed.transactions.find((t) => t.sourceReference === 'SPLITFEE-PURCHASE-001');
    expect(txn).toBeTruthy();
    expect(txn!.canonicalType).toBe('purchase');
  });

  it('a Stamp Duty row split across two lines is recovered as a fee transaction', () => {
    const parsed = parseExtractedDocument(buildText()).parsed!;
    const fee = parsed.transactions.find((t) => t.rawTransactionTypeText === 'Stamp Duty');
    expect(fee).toBeTruthy();
    expect(fee!.canonicalType).toBe('fee');
    expect(scaledToDecimalString(fee!.amountScaled, 2)).toBe('0.05');
    expect(fee!.unitsScaled).toBe(BigInt(0));
    expect(fee!.navScaled).toBeNull();
  });

  it('an STT Paid row split across two lines is also recovered', () => {
    const parsed = parseExtractedDocument(buildText()).parsed!;
    const stt = parsed.transactions.find((t) => t.rawTransactionTypeText === 'STT Paid');
    expect(stt).toBeTruthy();
    expect(scaledToDecimalString(stt!.amountScaled, 2)).toBe('0.10');
  });

  it('the label line is consumed and never separately raised as its own unparseable_transaction_row error', () => {
    const parsed = parseExtractedDocument(buildText()).parsed!;
    const labelErrors = parsed.errors.filter((e) => e.message.includes('*** Stamp Duty ***') || e.message.includes('*** STT Paid ***'));
    expect(labelErrors).toHaveLength(0);
  });
});
