/**
 * M3 (Phase 4), item I.4 — the AI investment document-facts contract.
 *
 * These tests are about what the schema makes IMPOSSIBLE, not about what it
 * accepts. D.4's anti-invention rules ("AI may NOT invent ownership,
 * transactions, units, NAV, dates, currencies or FX ... never invent an ISIN
 * or canonical instrument") are only worth anything if they are enforced by
 * shape — a policy check at one call site can be forgotten, a `.strict()`
 * schema cannot.
 */

import { describe, it, expect } from 'vitest';
import {
  investmentDocumentFactsSchema,
  AIE_II_DOCUMENT_FACTS_SCHEMA_NAME,
  AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION,
  II_AI_TRANSACTION_TYPE_CANDIDATES,
  II_MISSING_REASON_CODES,
  registerInvestmentDocumentFactsSchema,
} from '@/lib/aie/adapters/investment-intelligence/documentFactsSchema';
import { aieSchemaRegistry } from '@/lib/aie/schema/schemaRegistry';
import type { IiTransactionType } from '@/lib/services/investment-intelligence/types';

/**
 * `IiTransactionType` is a TYPE union with no runtime array, so the subset
 * check below needs a runtime list. Declared with an explicit
 * `IiTransactionType[]` annotation rather than as a free-standing string
 * array: if a value here ever stops being a canonical type, this file stops
 * compiling, which is a louder and earlier failure than a test assertion.
 */
const CANONICAL_TRANSACTION_TYPES: IiTransactionType[] = [
  'purchase',
  'sip',
  'redemption',
  'switch_in',
  'switch_out',
  'dividend',
  'reinvestment',
  'transfer',
  'merger',
  'fee',
  'tax',
  'adjustment',
  'stp_in',
  'stp_out',
  'swp',
  'transfer_in',
  'transfer_out',
  'reversal',
  'segregation',
  'unclassified',
  'bonus',
  'split',
  'sale',
];

function minimalPosition(overrides: Record<string, unknown> = {}) {
  return {
    folioToken: '[MASKED:folio_number:hmac:abcdefghijklmnopqrstuvwx]',
    amcOrInstitutionText: 'Prime Mutual Fund',
    schemeText: 'Prime Flexi Cap Fund - Growth',
    isin: null,
    isinPresentOnDocument: false,
    openingUnitBalance: null,
    openingBalanceStatedOnDocument: false,
    closingUnits: '100.000',
    statementNav: '52.00',
    statementNavDateIso: '2025-03-31',
    statementMarketValue: '5200.00',
    missingReasonCode: null,
    sourceLocation: { page: 1, line: 12, rawText: 'Closing Unit Balance as on 31-Mar-2025 : 100.000 Units' },
    transactions: [],
    ...overrides,
  };
}

function minimalDocument(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION,
    documentTypeCandidate: 'cas_statement',
    sourceInstitutionText: 'CAMS',
    statementPeriodStartIso: '2025-01-01',
    statementPeriodEndIso: '2025-03-31',
    statementAsOfDateIso: '2025-03-31',
    positions: [minimalPosition()],
    missingReasonCode: null,
    ...overrides,
  };
}

describe('M3 I.4 — versioned strict AI investment document-facts schema', () => {
  it('accepts a well-formed document', () => {
    expect(investmentDocumentFactsSchema.safeParse(minimalDocument()).success).toBe(true);
  });

  it('registers against AIE-1.1\'s existing registry — no second schema mechanism is introduced', () => {
    registerInvestmentDocumentFactsSchema();
    const found = aieSchemaRegistry.get(AIE_II_DOCUMENT_FACTS_SCHEMA_NAME, AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION);
    expect(found).toBeTruthy();
  });

  describe('D.4 — the model is structurally unable to invent identity', () => {
    it('has NO field anywhere for a canonical id — not accountId, instrumentId, userId, householdId or taxLotId', () => {
      // Not a policy check that a reviewer has to remember: `.strict()` at
      // every level means naming one is a validation FAILURE, so "AI must
      // never invent a canonical instrument" is a sentence this contract
      // cannot express rather than a rule someone enforces later.
      for (const forbidden of ['accountId', 'instrumentId', 'userId', 'householdId', 'taxLotId', 'canonicalAccountId']) {
        const result = investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ [forbidden]: 'anything' })] }));
        expect(result.success, `${forbidden} was accepted`).toBe(false);
      }
    });

    it('has NO confidence field — P4/REC-04, a score must never be able to move a reconciliation outcome', () => {
      for (const forbidden of ['confidence', 'confidenceScore', 'certainty', 'probability']) {
        expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ [forbidden]: 0.99 })).success, `${forbidden} was accepted`).toBe(false);
        expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ [forbidden]: 0.99 })] })).success).toBe(false);
      }
    });

    it('REJECTS an ISIN supplied while the model states it was not printed (an invented instrument identifier)', () => {
      const result = investmentDocumentFactsSchema.safeParse(
        minimalDocument({ positions: [minimalPosition({ isin: 'INF999K01AB1', isinPresentOnDocument: false })] }),
      );
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('isinPresentOnDocument is false');
    });

    it('REJECTS the reverse incoherence — claiming an ISIN was printed while supplying none', () => {
      expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ isin: null, isinPresentOnDocument: true })] })).success).toBe(false);
    });

    it('ACCEPTS an ISIN that the model states WAS printed — the rule is about evidence, not about refusing ISINs', () => {
      expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ isin: 'INF999K01AB1', isinPresentOnDocument: true })] })).success).toBe(true);
    });

    it('REJECTS an opening balance the model admits was not stated on the document (PC4-INV-08)', () => {
      // This is how a fabricated tax lot with an invented cost base starts.
      const result = investmentDocumentFactsSchema.safeParse(
        minimalDocument({ positions: [minimalPosition({ openingUnitBalance: '200.000', openingBalanceStatedOnDocument: false })] }),
      );
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('never inferred');
    });

    it('models an opening balance as its OWN field, never as a transaction typed "purchase"', () => {
      // A schema that could only express an opening balance as a transaction
      // would invite exactly the PC4-INV-08 mistake it is meant to prevent.
      const position = minimalPosition({ openingUnitBalance: '200.000', openingBalanceStatedOnDocument: true });
      expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [position] })).success).toBe(true);
      expect(Object.keys(position)).toContain('openingUnitBalance');
    });
  });

  describe('D.5 — null plus a reason code is valid; a plausible guess is not', () => {
    it('every missing-reason code describes the DOCUMENT, never the model\'s own certainty', () => {
      expect([...II_MISSING_REASON_CODES]).toEqual(['not_present_on_document', 'illegible', 'ambiguous', 'conflicting_values_on_document']);
      // `low_confidence` would be a certainty claim, and would reopen exactly
      // the "hide errors behind a confidence score" channel I.13 forbids.
      expect(II_MISSING_REASON_CODES as readonly string[]).not.toContain('low_confidence');
    });

    it('rejects a missing-reason code outside the closed enum', () => {
      expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ missingReasonCode: 'seemed_wrong' })] })).success).toBe(false);
    });
  });

  describe('exactness — money and units never travel as JSON numbers', () => {
    it('rejects a float for units, NAV or amount', () => {
      // A JSON number is an IEEE-754 double; II's entire money layer is exact
      // scaled integers precisely because a double silently loses unit and
      // NAV precision. This is the one boundary where that would be hardest
      // to notice.
      expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ closingUnits: 100.0 })] })).success).toBe(false);
    });

    it('rejects a decimal string with more precision than the exact-decimal layer carries', () => {
      expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ closingUnits: '100.1234567' })] })).success).toBe(false);
    });

    it('accepts a negative exact decimal — an outflow is a real value, not an error', () => {
      expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ closingUnits: '-100.000' })] })).success).toBe(true);
    });
  });

  describe('transaction facts', () => {
    const txn = {
      transactionDateIso: '2025-01-10',
      narrative: 'Purchase',
      transactionTypeCandidate: 'purchase',
      amount: '5000.00',
      units: '100.000',
      navOrPrice: '50.0000',
      runningUnitBalance: '100.000',
      feeAmount: null,
      feeKind: 'none',
      missingReasonCode: null,
      sourceLocation: { page: 1, line: 9, rawText: '10-Jan-2025 5,000.00 50.0000 100.000 Purchase 100.000' },
    };

    it('accepts a complete transaction fact', () => {
      expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ transactions: [txn] })] })).success).toBe(true);
    });

    it('every wire transaction-type is a REAL canonical type, so a mapping to canonical is always total', () => {
      // The wire enum is versioned and deliberately narrower than the
      // canonical union (see the schema's own comment on why). What must
      // hold is the SUBSET relation: a typo here would create a value that
      // maps to no canonical type at all, and that would surface only at
      // write time, far from its cause.
      const canonical = new Set(CANONICAL_TRANSACTION_TYPES);
      for (const wireType of II_AI_TRANSACTION_TYPE_CANDIDATES) {
        if (wireType === 'unknown') continue;
        expect(canonical.has(wireType), `wire type "${wireType}" is not a canonical IiTransactionType`).toBe(true);
      }
    });

    it('EXCLUDES the cost-basis-bearing types a narrative cannot support (PC4-INV-18\'s reasoning)', () => {
      // Guards the deliberate narrowing against a well-meaning future
      // widening. Letting the model emit `switch_in` would seed a tax lot
      // with an invented cost base, which is a materially worse outcome than
      // an `unknown` that a human resolves.
      for (const excluded of ['switch_in', 'switch_out', 'stp_in', 'stp_out', 'swp', 'merger', 'bonus', 'split', 'sale']) {
        expect(II_AI_TRANSACTION_TYPE_CANDIDATES as readonly string[], `${excluded} must not be AI-emittable`).not.toContain(excluded);
      }
    });

    it('rejects a transaction type outside the closed enum', () => {
      expect(
        investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ transactions: [{ ...txn, transactionTypeCandidate: 'invented_type' }] })] })).success,
      ).toBe(false);
    });

    it('requires source provenance on every fact — an assertion with no location is not evidence', () => {
      const { sourceLocation: _omitted, ...withoutLocation } = txn;
      expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ transactions: [withoutLocation] })] })).success).toBe(false);
    });

    it('keeps fees separate from the economic amount, so a fee is never treated as a purchase', () => {
      const fee = { ...txn, feeAmount: '0.50', feeKind: 'stamp_duty' };
      expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ transactions: [fee] })] })).success).toBe(true);
      expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ transactions: [{ ...txn, feeKind: 'invented_fee' }] })] })).success).toBe(false);
    });

    it('rejects an unknown key anywhere in the tree (JSC-03 composed with .strict())', () => {
      expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ positions: [minimalPosition({ transactions: [{ ...txn, exfiltrationUrl: 'https://attacker.example.com' }] })] })).success).toBe(false);
    });
  });

  it('pins the schema version — a field change must bump the version, not mutate this one in place', () => {
    expect(AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION).toBe('1');
    expect(investmentDocumentFactsSchema.safeParse(minimalDocument({ schemaVersion: '2' })).success).toBe(false);
  });
});
