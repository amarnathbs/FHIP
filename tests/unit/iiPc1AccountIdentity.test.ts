/**
 * II-PC1-D1 — CAMS folio/AMC identity attribution.
 *
 * Original defect (documentProcessing.ts, pre-fix):
 *   institutionName: acc.amcName || (parsed.transactions[0]?.scheme.amcName ?? 'Unknown AMC')
 * `parsed.transactions[0]` is the first transaction of the WHOLE uploaded
 * document — not scoped to the folio being resolved in that loop
 * iteration. Both real parsers (camsParser.ts, kfintechParser.ts) always
 * emit `ParsedAccountRecord.amcName === ''`, so this fallback was
 * UNCONDITIONALLY reached for every real folio.
 *
 * This file proves (a) the OLD expression really does misattribute AMC
 * across folios (RED, reproduced against real parsed structures) and (b)
 * the NEW `planFolioAccountResolution` (accountResolution.ts) resolves
 * every required scenario correctly (GREEN), including the mandatory
 * same-folio-number/different-AMC negative control (D1-R5).
 */
import { describe, it, expect } from 'vitest';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import {
  planFolioAccountResolution,
  accountResolutionKey,
} from '@/lib/services/investment-intelligence/accountResolution';
import type {
  ParsedAccountRecord,
  ParsedTransactionRecord,
  ParsedHoldingRecord,
  ParsedInstrumentRecord,
} from '@/lib/services/investment-intelligence/parsers/types';

// --- Test helpers -----------------------------------------------------------

function scheme(overrides: Partial<ParsedInstrumentRecord> & { amcName: string }): ParsedInstrumentRecord {
  return {
    rawSchemeName: overrides.rawSchemeName ?? 'Test Scheme - Growth',
    normalisedSchemeName: overrides.normalisedSchemeName ?? 'test scheme growth',
    amcName: overrides.amcName,
    planType: overrides.planType ?? 'direct',
    optionType: overrides.optionType ?? 'growth',
    isin: overrides.isin ?? null,
    amfiSchemeCode: overrides.amfiSchemeCode ?? null,
  };
}

function account(folioNumber: string | null, amcName = ''): ParsedAccountRecord {
  return {
    folioNumber,
    accountNumberMasked: null,
    amcName, // both real parsers always emit '' here — see camsParser.ts/kfintechParser.ts parseAccounts()
    holderName: 'Test Investor',
    panMasked: null,
    jointHolders: [],
    holdingModeRaw: 'SI',
    raw: '',
  };
}

function txn(folioNumber: string | null, amcName: string, overrides: Partial<ParsedTransactionRecord> = {}): ParsedTransactionRecord {
  return {
    folioNumber,
    scheme: scheme({ amcName }),
    transactionDateIso: '2025-02-01',
    rawTransactionTypeText: 'Purchase',
    canonicalType: 'purchase',
    classificationConfidence: 1,
    amountScaled: BigInt(1000000),
    unitsScaled: BigInt(10000),
    navScaled: BigInt(1000000),
    balanceUnitsAfterScaled: null,
    sourceReference: null,
    sourceDescription: 'Purchase',
    ...overrides,
  };
}

function holding(folioNumber: string | null, amcName: string, overrides: Partial<ParsedHoldingRecord> = {}): ParsedHoldingRecord {
  return {
    folioNumber,
    scheme: scheme({ amcName }),
    asOfDateIso: '2025-06-30',
    unitsScaled: BigInt(10000),
    valueScaled: BigInt(1200000),
    navScaled: BigInt(1200000),
    ...overrides,
  };
}

/** The EXACT pre-fix expression from documentProcessing.ts, reproduced here for the RED proof. */
function oldBuggyInstitutionName(acc: ParsedAccountRecord, transactions: ParsedTransactionRecord[]): string {
  return acc.amcName || (transactions[0]?.scheme.amcName ?? 'Unknown AMC');
}

describe('PC1-D1-RED — the old expression misattributes AMC across folios', () => {
  it('a folio with NO transactions of its own gets the WRONG institution from the document\'s first transaction', () => {
    const folioA = account('FOLIO-A');
    const folioB = account('FOLIO-B');
    // FOLIO-A's own transaction is first in document order; FOLIO-B has no
    // transactions in this reproduction (e.g. holdings-only folio).
    const transactions = [txn('FOLIO-A', 'AMC Alpha')];

    const attributedA = oldBuggyInstitutionName(folioA, transactions);
    const attributedB = oldBuggyInstitutionName(folioB, transactions);

    expect(attributedA).toBe('AMC Alpha'); // correct by coincidence (folio A happens to be transactions[0])
    expect(attributedB).toBe('AMC Alpha'); // WRONG — FOLIO-B has no relationship to AMC Alpha at all
  });

  it('reproduces the exact live-reported failure: two folios, two AMCs, first-transaction AMC bleeds onto every other folio', () => {
    const folioA = account('FOLIO-A');
    const folioB = account('FOLIO-B');
    const transactions = [txn('FOLIO-A', 'AMC Alpha'), txn('FOLIO-B', 'AMC Beta')];

    expect(oldBuggyInstitutionName(folioA, transactions)).toBe('AMC Alpha'); // correct
    expect(oldBuggyInstitutionName(folioB, transactions)).toBe('AMC Alpha'); // BUG: should be 'AMC Beta'
  });
});

describe('PC1-D1-GREEN — planFolioAccountResolution (D1-R1: two folios, two AMCs)', () => {
  it('resolves FOLIO-A -> AMC Alpha and FOLIO-B -> AMC Beta, independent of document order', () => {
    const accounts = [account('FOLIO-A'), account('FOLIO-B')];
    const transactions = [txn('FOLIO-A', 'AMC Alpha'), txn('FOLIO-B', 'AMC Beta')];
    const plan = planFolioAccountResolution({ accounts, transactions, holdings: [] });

    expect(plan.assignments).toHaveLength(2);
    const byFolio = new Map(plan.assignments.map((a) => [a.folioNumber, a.amcName]));
    expect(byFolio.get('FOLIO-A')).toBe('AMC Alpha');
    expect(byFolio.get('FOLIO-B')).toBe('AMC Beta');

    // Every transaction resolves to the assignment matching ITS OWN folio.
    expect(plan.resolveRowKey('FOLIO-A', 'AMC Alpha')).toBe(accountResolutionKey('FOLIO-A', 'AMC Alpha'));
    expect(plan.resolveRowKey('FOLIO-B', 'AMC Beta')).toBe(accountResolutionKey('FOLIO-B', 'AMC Beta'));
  });
});

describe('PC1-D1-GREEN (D1-R2: transaction-order independence)', () => {
  it('the SAME economic input, with transactions reordered, resolves to the IDENTICAL account set', () => {
    const accounts = [account('FOLIO-A'), account('FOLIO-B')];
    const forward = [txn('FOLIO-A', 'AMC Alpha'), txn('FOLIO-B', 'AMC Beta')];
    const reversed = [txn('FOLIO-B', 'AMC Beta'), txn('FOLIO-A', 'AMC Alpha')];

    const planForward = planFolioAccountResolution({ accounts, transactions: forward, holdings: [] });
    const planReversed = planFolioAccountResolution({ accounts, transactions: reversed, holdings: [] });

    const keysForward = new Set(planForward.assignments.map((a) => a.key));
    const keysReversed = new Set(planReversed.assignments.map((a) => a.key));
    expect(keysReversed).toEqual(keysForward);
    expect(planForward.assignments).toHaveLength(2);
    expect(planReversed.assignments).toHaveLength(2);
  });
});

describe('PC1-D1-GREEN (D1-R3: monthly delta touches only one folio)', () => {
  it('a delta statement containing ONLY folio B resolves to folio B\'s own AMC — never folio A\'s, never a new duplicate', () => {
    // The delta statement's own accounts array only contains folio B (a
    // real monthly re-upload only prints folios with activity/holdings).
    const deltaAccounts = [account('FOLIO-B')];
    const deltaTransactions = [txn('FOLIO-B', 'AMC Beta')];
    const plan = planFolioAccountResolution({ accounts: deltaAccounts, transactions: deltaTransactions, holdings: [] });

    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].folioNumber).toBe('FOLIO-B');
    expect(plan.assignments[0].amcName).toBe('AMC Beta'); // NOT 'AMC Alpha', NOT 'Unknown AMC'
  });
});

describe('PC1-D1-GREEN (D1-R4: multi-scheme, same folio, same AMC)', () => {
  it('two schemes under one folio/AMC resolve to exactly ONE account, not two', () => {
    const accounts = [account('FOLIO-A')];
    const transactions = [
      txn('FOLIO-A', 'AMC Alpha', { scheme: scheme({ amcName: 'AMC Alpha', rawSchemeName: 'Alpha Scheme 1' }) }),
      txn('FOLIO-A', 'AMC Alpha', { scheme: scheme({ amcName: 'AMC Alpha', rawSchemeName: 'Alpha Scheme 2' }) }),
    ];
    const plan = planFolioAccountResolution({ accounts, transactions, holdings: [] });

    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].amcName).toBe('AMC Alpha');
  });
});

describe('PC1-D1-GREEN (D1-R5, MANDATORY negative control: same folio number, different AMCs)', () => {
  it('per the (user, institution_name, folio) identity model (accountResolution.ts resolveOrCreateAccount / accounts.ts), these are DISTINCT accounts — never collapsed', () => {
    // Two economically distinct folios that happen to share the printed
    // folio number "12345" under two different AMCs.
    const accounts = [account('12345'), account('12345')];
    const transactions = [txn('12345', 'AMC Alpha'), txn('12345', 'AMC Beta')];
    const plan = planFolioAccountResolution({ accounts, transactions, holdings: [] });

    expect(plan.assignments).toHaveLength(2); // NOT 1 — must not silently collapse
    const amcNames = plan.assignments.map((a) => a.amcName).sort();
    expect(amcNames).toEqual(['AMC Alpha', 'AMC Beta']);
    expect(plan.assignments.every((a) => a.folioNumber === '12345')).toBe(true);

    // Each transaction still resolves to ITS OWN (folio, amc) — never
    // merged into the other AMC's account.
    const keyAlpha = plan.resolveRowKey('12345', 'AMC Alpha');
    const keyBeta = plan.resolveRowKey('12345', 'AMC Beta');
    expect(keyAlpha).not.toBe(keyBeta);
  });
});

describe('PC1-D1-GREEN — holdings-only folio (no transactions) still resolves via holding evidence', () => {
  it('uses holding.scheme.amcName when a folio has holdings but no transactions', () => {
    const accounts = [account('FOLIO-C')];
    const holdings = [holding('FOLIO-C', 'AMC Gamma')];
    const plan = planFolioAccountResolution({ accounts, transactions: [], holdings });

    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].amcName).toBe('AMC Gamma');
    expect(plan.resolveRowKey('FOLIO-C', 'AMC Gamma')).toBe(plan.assignments[0].key);
  });

  it('a folio with genuinely zero AMC evidence anywhere falls back to Unknown AMC (never crashes, never guesses another folio\'s AMC)', () => {
    const accounts = [account('FOLIO-EMPTY')];
    const plan = planFolioAccountResolution({ accounts, transactions: [], holdings: [] });
    expect(plan.assignments).toHaveLength(1);
    expect(plan.assignments[0].amcName).toBe('Unknown AMC');
  });
});

describe('PC1-D1-GREEN — real CAMS parser integration (not just hand-built objects)', () => {
  it('a real multi-folio, multi-AMC CAMS document resolves each folio to its OWN AMC end-to-end through the real parser', () => {
    const text = [
      'CAMS Consolidated Account Statement',
      'Statement Period : 01-Jan-2025 To 30-Jun-2025',
      '',
      'Folio No: 1201040011111',
      'PAN: ABCDE1111F',
      'Name: TEST INVESTOR ONE',
      'Holding Mode: SI',
      '',
      'AMC Name: Alpha Mutual Fund',
      'Scheme Name: Alpha Flexi Cap Fund - Growth (Direct Plan)',
      'ISIN: INF000A01111',
      'AMFI Code: 100001',
      'Registrar: CAMS',
      '',
      'Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance',
      '01-Feb-2025   Purchase                                  10000.00  100.000  100.0000  100.000 [Ref: ALPHAREF1]',
      '',
      'Closing Unit Balance as on 30-Jun-2025 : 100.000 Units   Valuation : Rs. 12000.00   NAV as on 30-Jun-2025 : Rs. 120.0000',
      '',
      'Folio No: 1201040022222',
      'PAN: ABCDE2222F',
      'Name: TEST INVESTOR TWO',
      'Holding Mode: SI',
      '',
      'AMC Name: Beta Mutual Fund',
      'Scheme Name: Beta Bluechip Fund - Growth (Direct Plan)',
      'ISIN: INF000B02222',
      'AMFI Code: 100002',
      'Registrar: CAMS',
      '',
      'Date          Description                              Amount(Rs.)      Units         NAV(Rs.)      Unit Balance',
      '05-Mar-2025   Purchase                                  20000.00  200.000  100.0000  200.000 [Ref: BETAREF1]',
      '',
      'Closing Unit Balance as on 30-Jun-2025 : 200.000 Units   Valuation : Rs. 24000.00   NAV as on 30-Jun-2025 : Rs. 120.0000',
    ].join('\n');

    const result = parseExtractedDocument(text);
    const parsed = result.parsed!;
    expect(parsed.accounts.map((a) => a.folioNumber)).toEqual(['1201040011111', '1201040022222']);
    // Both real parsers emit '' here (see camsParser.ts comment) — the RED
    // reproduction depends on this being true, so assert it explicitly.
    expect(parsed.accounts.every((a) => a.amcName === '')).toBe(true);

    const plan = planFolioAccountResolution({ accounts: parsed.accounts, transactions: parsed.transactions, holdings: parsed.holdings });
    expect(plan.assignments).toHaveLength(2);
    const byFolio = new Map(plan.assignments.map((a) => [a.folioNumber, a.amcName]));
    expect(byFolio.get('1201040011111')).toBe('Alpha Mutual Fund');
    expect(byFolio.get('1201040022222')).toBe('Beta Mutual Fund');

    // Contrast with the OLD buggy expression on the SAME real parser output:
    // it would have attributed BOTH folios to whichever AMC owns
    // parsed.transactions[0] (Alpha, since it's first in document order).
    const folioTwoAccRecord = parsed.accounts.find((a) => a.folioNumber === '1201040022222')!;
    expect(oldBuggyInstitutionName(folioTwoAccRecord, parsed.transactions)).toBe('Alpha Mutual Fund'); // the historical bug
    expect(byFolio.get('1201040022222')).not.toBe('Alpha Mutual Fund'); // the fix
  });
});
