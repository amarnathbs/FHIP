/**
 * FDH-9 — payslip extraction certified against the INDEPENDENT ORACLE.
 *
 * Spec section 64: "Do not certify production code against itself." Every
 * expectation here comes from `tests/fixtures/fdh9/payslips.ts`, whose
 * `expected` blocks were computed by hand from the payslip text and carry
 * their own worked arithmetic. This file only compares.
 *
 * Spec sections 17-18 minimum coverage: AU weekly / fortnightly / monthly,
 * PAYG, super, salary sacrifice, overtime, bonus, allowance, reimbursement,
 * multiple employers; India Basic, HRA, allowances, TDS, employee PF,
 * employer PF, NPS, professional tax, bonus, arrears, multiple employers.
 */

import { describe, expect, it } from 'vitest';
import {
  ALL_PAYSLIP_FIXTURES,
  AU_FIXTURES,
  IN_FIXTURES,
  REJECTION_FIXTURES,
} from '../fixtures/fdh9/payslips';
import { parsePayslipText, payslipFingerprint } from '@/lib/financial-data-hub/payslip/parser';
import { reconcileGrossToNet, checkGrossAgainstComponents } from '@/lib/financial-data-hub/payslip/reconciliation';
import type { PayrollExtraction } from '@/lib/financial-data-hub/payslip/types';

function parseOrFail(
  text: string,
  options?: { declaredCountry?: 'AU' | 'IN'; declaredCurrency?: string },
): PayrollExtraction {
  const result = parsePayslipText(text, options);
  if ('error' in result) throw new Error(`expected a successful parse, got ${result.error}`);
  return result;
}

function parseFixture(fixture: { text: string; parseOptions?: { declaredCountry?: 'AU' | 'IN'; declaredCurrency?: string } }): PayrollExtraction {
  return parseOrFail(fixture.text, fixture.parseOptions);
}

/** The money fields the oracle specifies. Compared exactly. */
const MONEY_FIELDS = [
  'grossPay', 'basePay', 'overtimePay', 'bonusPay', 'commissionPay',
  'allowancesTotal', 'reimbursementsTotal', 'otherEarnings',
  'taxWithheld', 'employeeDeductionsTotal', 'salarySacrifice', 'professionalTax',
  'employerRetirementContribution', 'employeeRetirementContribution',
  'employerNpsContribution', 'employeeNpsContribution',
  'netPay', 'ytdGross', 'ytdTax', 'ytdNet',
] as const;

describe('FDH-9 payslip extraction vs independent oracle', () => {
  for (const fixture of ALL_PAYSLIP_FIXTURES) {
    describe(`${fixture.id} — ${fixture.description}`, () => {
      const extraction = parseFixture(fixture);
      const oracle = fixture.expected;

      it('identifies the jurisdiction and currency from the document', () => {
        expect(extraction.country).toBe(oracle.country);
        expect(extraction.currencyCode).toBe(oracle.currencyCode);
      });

      it('reads the employer and the pay period', () => {
        if (oracle.employerName) expect(extraction.employerName).toBe(oracle.employerName);
        expect(extraction.payPeriodStart).toBe(oracle.payPeriodStart);
        expect(extraction.payPeriodEnd).toBe(oracle.payPeriodEnd);
        expect(extraction.paymentDate).toBe(oracle.paymentDate);
      });

      it('infers pay frequency, and records HOW it knows', () => {
        expect(extraction.payFrequency).toBe(oracle.payFrequency);
        expect(extraction.payFrequencySource).toBe(oracle.payFrequencySource);
      });

      for (const field of MONEY_FIELDS) {
        const expectedValue = oracle[field];
        it(`${field} = ${expectedValue === undefined ? 'not disclosed' : expectedValue}`, () => {
          expect(extraction[field]).toBe(expectedValue);
        });
      }

      it('reconciles gross to net exactly as the oracle specifies', () => {
        const result = reconcileGrossToNet(extraction);
        expect(result.status).toBe(oracle.reconciliationStatus);
        expect(result.variance).toBe(oracle.reconciliationVariance);
      });
    });
  }

  it('covers AU weekly, fortnightly and monthly', () => {
    const frequencies = new Set(AU_FIXTURES.map((f) => f.expected.payFrequency));
    expect(frequencies.has('weekly')).toBe(true);
    expect(frequencies.has('fortnightly')).toBe(true);
    expect(frequencies.has('monthly')).toBe(true);
  });

  it('covers the AU component set the spec names (section 17)', () => {
    const seen = new Set<string>();
    for (const fixture of AU_FIXTURES) {
      const extraction = parseFixture(fixture);
      for (const c of extraction.components) seen.add(c.type);
    }
    for (const required of ['base', 'overtime', 'bonus', 'commission', 'allowance', 'reimbursement', 'income_tax_withheld', 'salary_sacrifice', 'employer_retirement']) {
      expect(seen.has(required), `AU coverage is missing ${required}`).toBe(true);
    }
  });

  it('covers the India component set the spec names (section 18)', () => {
    const seen = new Set<string>();
    for (const fixture of IN_FIXTURES) {
      const extraction = parseFixture(fixture);
      for (const c of extraction.components) seen.add(c.type);
    }
    for (const required of ['basic', 'hra', 'dearness_allowance', 'special_allowance', 'conveyance', 'income_tax_withheld', 'employee_retirement', 'employer_retirement', 'employee_nps', 'employer_nps', 'professional_tax', 'bonus', 'arrears']) {
      expect(seen.has(required), `India coverage is missing ${required}`).toBe(true);
    }
  });

  it('covers more than one employer in each jurisdiction', () => {
    expect(new Set(AU_FIXTURES.map((f) => f.expected.employerName)).size).toBeGreaterThan(1);
    expect(new Set(IN_FIXTURES.map((f) => f.expected.employerName)).size).toBeGreaterThan(1);
  });
});

describe('FDH-9 extraction refuses what it cannot honestly read', () => {
  for (const fixture of REJECTION_FIXTURES) {
    it(`${fixture.id} — ${fixture.description}`, () => {
      const result = parsePayslipText(fixture.text);
      expect('error' in result).toBe(true);
      expect((result as { error: string }).error).toBe(fixture.expectedError);
    });
  }

  it('refuses to assume a jurisdiction: AU-05 parses only because the UPLOAD declared one', () => {
    // AU-05 carries no PAYG, no superannuation, no ABN — nothing that names a
    // jurisdiction. Without a declared country the parser must refuse rather
    // than default to AU; with the country the user supplied on the Income tab
    // it proceeds. This is the negative control for country detection.
    const fixture = AU_FIXTURES.find((f) => f.id === 'AU-05')!;
    const withoutDeclared = parsePayslipText(fixture.text);
    expect('error' in withoutDeclared).toBe(true);
    expect((withoutDeclared as { error: string }).error).toBe('country_not_identified');

    const withDeclared = parsePayslipText(fixture.text, fixture.parseOptions);
    expect('error' in withDeclared).toBe(false);
  });

  it('document evidence OVERRIDES a wrong declared country', () => {
    // An India payslip uploaded by a user whose profile says AU must still be
    // read as India — the document is the authority, not the metadata.
    const indiaFixture = IN_FIXTURES[0];
    const result = parsePayslipText(indiaFixture.text, { declaredCountry: 'AU', declaredCurrency: 'AUD' });
    expect('error' in result).toBe(false);
    expect((result as PayrollExtraction).country).toBe('IN');
    expect((result as PayrollExtraction).currencyCode).toBe('INR');
  });
});

describe('FDH-9 YTD is evidence, never another payment (spec section 35)', () => {
  it('never folds a year-to-date figure into a current-period total', () => {
    // AU-01 states YTD gross 13,350 alongside current gross 4,450. If the two
    // were ever added the gross would read 17,800.
    const extraction = parseOrFail(AU_FIXTURES[0].text);
    expect(extraction.grossPay).toBe(4450);
    expect(extraction.ytdGross).toBe(13350);
    expect(extraction.grossPay! + extraction.ytdGross!).toBe(17800); // the wrong answer, stated explicitly
    expect(extraction.grossPay).not.toBe(17800);
  });

  it('keeps YTD component lines flagged and out of current-period sums', () => {
    const extraction = parseOrFail(AU_FIXTURES[0].text);
    const ytdLines = extraction.components.filter((c) => c.isYearToDate);
    const currentLines = extraction.components.filter((c) => !c.isYearToDate);
    expect(ytdLines.length).toBeGreaterThan(0);
    const currentEarnings = currentLines
      .filter((c) => c.side === 'earning')
      .reduce((a, c) => a + c.amount, 0);
    expect(currentEarnings).toBe(4450);
  });
});

describe('FDH-9 gross-vs-components consistency is reported separately', () => {
  it('AU-02: stated gross excludes the reimbursement, and that is consistent', () => {
    const extraction = parseOrFail(AU_FIXTURES[1].text);
    const check = checkGrossAgainstComponents(extraction);
    expect(check.checked).toBe(true);
    expect(check.agrees).toBe(true);
    expect(check.componentGross).toBe(1645);
  });
});

describe('FDH-9 duplicate vs revision fingerprinting (spec section 34/35)', () => {
  it('the same payslip twice produces the same fingerprint', () => {
    const a = parseOrFail(AU_FIXTURES[0].text);
    const b = parseOrFail(AU_FIXTURES[0].text);
    expect(payslipFingerprint(a)).toBe(payslipFingerprint(b));
  });

  it('a REVISED payslip produces a DIFFERENT fingerprint, so it is not blocked as a duplicate', () => {
    const original = parseOrFail(AU_FIXTURES[0].text);
    const revised = parseOrFail(AU_FIXTURES[3].text); // AU-04: same employer/period, net differs by 0.01
    expect(payslipFingerprint(revised)).not.toBe(payslipFingerprint(original));
  });

  it('a different employer produces a different fingerprint', () => {
    const a = parseOrFail(AU_FIXTURES[0].text);
    const b = parseOrFail(AU_FIXTURES[5].text);
    expect(payslipFingerprint(a)).not.toBe(payslipFingerprint(b));
  });
});
