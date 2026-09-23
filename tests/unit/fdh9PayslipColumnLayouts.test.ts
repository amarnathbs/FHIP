/**
 * FDH-9 — payslip TABLE-SHAPE certification (2026-09-24).
 *
 * The defect this file exists for: a real AU fortnightly payslip imported in
 * production stored a YEAR-TO-DATE total as the period `base_pay` (out by a
 * factor of ~26) and left `gross_pay` null. Every pre-existing AU fixture
 * passed throughout, because they all share one table shape.
 *
 * Every payslip used here is SYNTHETIC (see the fixture file's own header).
 * No real payslip was read to build them.
 */

import { describe, expect, it } from 'vitest';
import { PAYSLIP_LAYOUT_FIXTURES } from '../fixtures/fdh9/payslipColumnLayouts';
import {
  parsePayslipText,
  planPayslipColumns,
  parsePayslipColumnHeader,
  isYtdSectionHeading,
} from '@/lib/financial-data-hub/payslip/parser';
import { reconcileGrossToNet } from '@/lib/financial-data-hub/payslip/reconciliation';
import type { PayrollExtraction } from '@/lib/financial-data-hub/payslip/types';

const MONEY_FIELDS = [
  'grossPay', 'basePay', 'overtimePay', 'bonusPay', 'commissionPay',
  'allowancesTotal', 'reimbursementsTotal', 'otherEarnings',
  'taxWithheld', 'employeeDeductionsTotal', 'salarySacrifice', 'professionalTax',
  'employerRetirementContribution', 'employeeRetirementContribution',
  'employerNpsContribution', 'employeeNpsContribution',
  'netPay', 'ytdGross', 'ytdTax', 'ytdNet',
] as const;

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
}

function parse(text: string, options?: { declaredCountry?: 'AU' | 'IN'; declaredCurrency?: string }): PayrollExtraction {
  const result = parsePayslipText(text, options);
  if ('error' in result) throw new Error(`expected a successful parse, got ${result.error}`);
  return result;
}

describe('FDH-9 payslip table shape vs independent oracle', () => {
  for (const fixture of PAYSLIP_LAYOUT_FIXTURES) {
    describe(`${fixture.id} — ${fixture.description}`, () => {
      const extraction = parse(fixture.text, fixture.parseOptions);
      const oracle = fixture.expected;
      const layout = fixture.layout;

      it(`plans the document's columns as ${layout.columnPlanSource}`, () => {
        expect(planPayslipColumns(lines(fixture.text)).source).toBe(layout.columnPlanSource);
      });

      it('reads the pay period and the payment date', () => {
        expect(extraction.payPeriodStart).toBe(oracle.payPeriodStart);
        expect(extraction.payPeriodEnd).toBe(oracle.payPeriodEnd);
        expect(extraction.paymentDate).toBe(oracle.paymentDate);
      });

      it('infers the pay frequency and records how it knows', () => {
        expect(extraction.payFrequency).toBe(oracle.payFrequency);
        expect(extraction.payFrequencySource).toBe(oracle.payFrequencySource);
      });

      for (const field of MONEY_FIELDS) {
        const expectedValue = oracle[field];
        it(`${field} = ${expectedValue === undefined ? 'not disclosed' : expectedValue}`, () => {
          expect(extraction[field]).toBe(expectedValue);
        });
      }

      it('records where the gross figure came from', () => {
        expect(extraction.grossPaySource ?? null).toBe(layout.grossPaySource);
      });

      if (layout.ytdEmployerRetirement !== undefined) {
        it('keeps the year-to-date employer contribution out of the period figure', () => {
          expect(extraction.ytdEmployerRetirement).toBe(layout.ytdEmployerRetirement);
        });
      }

      it('reconciles gross to net exactly as the oracle specifies', () => {
        const result = reconcileGrossToNet(extraction);
        expect(result.status).toBe(oracle.reconciliationStatus);
        expect(result.variance).toBe(oracle.reconciliationVariance);
      });

      it('raises exactly the warnings the layout calls for', () => {
        for (const w of layout.requiredWarnings ?? []) expect(extraction.warnings).toContain(w);
        for (const w of layout.forbiddenWarnings ?? []) expect(extraction.warnings).not.toContain(w);
      });

      it('keeps period earnings within the year-to-date gross the document states', () => {
        // The universal invariant the production defect broke: a year-to-date
        // gross INCLUDES this period, so the period's own earnings can never
        // exceed it. (Equality is legitimate — the first pay run of a year.)
        const periodEarnings = extraction.components
          .filter((c) => !c.isYearToDate && c.side === 'earning')
          .reduce((acc, c) => acc + c.amount, 0);
        if (extraction.ytdGross === undefined || periodEarnings === 0) return;
        expect(
          Number(periodEarnings.toFixed(4)),
          'period earnings exceed the stated year-to-date gross',
        ).toBeLessThanOrEqual(extraction.ytdGross);
      });
    });
  }

  // =========================================================================
  // The specific regressions, asserted by name rather than only by oracle.
  // =========================================================================

  it('PL-02 regression: a YTD-first header does not put the year-to-date total into base pay', () => {
    const f = PAYSLIP_LAYOUT_FIXTURES.find((x) => x.id === 'PL-02')!;
    const extraction = parse(f.text, f.parseOptions);
    expect(extraction.basePay).toBe(2870);
    expect(extraction.basePay).not.toBe(75217.63);
    expect(extraction.ytdGross).toBe(75217.63);
  });

  it('PL-03 regression: an hours quantity is never read as this period’s pay', () => {
    const f = PAYSLIP_LAYOUT_FIXTURES.find((x) => x.id === 'PL-03')!;
    const extraction = parse(f.text, f.parseOptions);
    expect(extraction.basePay).toBe(2870);
    expect(extraction.basePay).not.toBe(76);
    expect(extraction.components.map((c) => c.amount)).not.toContain(37.7632);
  });

  it('PL-04 regression: the production shape — a YTD summary block never becomes period pay', () => {
    const f = PAYSLIP_LAYOUT_FIXTURES.find((x) => x.id === 'PL-04')!;
    const extraction = parse(f.text, f.parseOptions);
    expect(extraction.basePay).toBe(2870);
    expect(extraction.grossPay).toBe(2870);
    expect(extraction.ytdGross).toBe(75217.63);
    // And the YTD figures are present ONLY as year-to-date components.
    const periodAmounts = extraction.components.filter((c) => !c.isYearToDate).map((c) => c.amount);
    expect(periodAmounts).not.toContain(75217.63);
    expect(periodAmounts).not.toContain(18455);
  });

  it('PL-08 regression: an inconsistent payslip is NOT quietly repaired', () => {
    const f = PAYSLIP_LAYOUT_FIXTURES.find((x) => x.id === 'PL-08')!;
    const extraction = parse(f.text, f.parseOptions);
    const result = reconcileGrossToNet(extraction);
    expect(result.status).toBe('variance');
    expect(result.variance).toBe(25);
    expect(result.method).toBe('components');
  });

  it('PL-09 regression: an unprovable gross stays absent — not zero, not guessed', () => {
    const f = PAYSLIP_LAYOUT_FIXTURES.find((x) => x.id === 'PL-09')!;
    const extraction = parse(f.text, f.parseOptions);
    expect(extraction.grossPay).toBeUndefined();
    expect(extraction.grossPay).not.toBe(0);
    expect(extraction.grossPaySource).toBeUndefined();
  });

  // =========================================================================
  // The structural rules, tested directly.
  // =========================================================================

  describe('column-header parsing', () => {
    it('reads a header naming both a period and a YTD column, in order', () => {
      expect(parsePayslipColumnHeader('Description        This Pay      Year to Date')).toEqual(['current', 'ytd']);
      expect(parsePayslipColumnHeader('Description        Year to Date      This Pay')).toEqual(['ytd', 'current']);
    });

    it('records non-money columns in their real positions', () => {
      expect(parsePayslipColumnHeader('Description   Qty   Rate   This Pay   Year to Date'))
        .toEqual(['other', 'other', 'current', 'ytd']);
      expect(parsePayslipColumnHeader('Earnings   Units   Amount   YTD'))
        .toEqual(['other', 'current', 'ytd']);
    });

    it('does not shred a longer marker into a shorter one', () => {
      // "this period" must not also register as "period"; "year to date" must
      // not also register as a date column.
      expect(parsePayslipColumnHeader('Description   This Period   Year to Date')).toEqual(['current', 'ytd']);
    });

    it('refuses a line carrying money — a data row is not a header', () => {
      expect(parsePayslipColumnHeader('Ordinary Hours   2,870.00   75,217.63')).toBeNull();
    });

    it('refuses a line that names only ONE of the two columns', () => {
      expect(parsePayslipColumnHeader('Year to Date')).toBeNull();
      expect(parsePayslipColumnHeader('Description       Amount')).toBeNull();
    });
  });

  describe('year-to-date SECTION headings', () => {
    it('treats a money-free YTD-only line as a section heading', () => {
      expect(isYtdSectionHeading('Year To Date')).toBe(true);
      expect(isYtdSectionHeading('Year to Date Summary')).toBe(true);
      expect(isYtdSectionHeading('YTD')).toBe(true);
    });

    it('does NOT treat a two-column header as a section heading', () => {
      expect(isYtdSectionHeading('Description   This Pay   Year to Date')).toBe(false);
    });

    it('does NOT treat a data row as a section heading', () => {
      expect(isYtdSectionHeading('Gross Payments YTD    75,217.63')).toBe(false);
    });
  });

  describe('the corpus itself', () => {
    it('covers both column orders, a YTD section, a YTD-only and a period-only document', () => {
      const sources = PAYSLIP_LAYOUT_FIXTURES.map((f) => f.layout.columnPlanSource);
      expect(sources).toContain('header');
      expect(sources).toContain('ytd_present_no_header');
      expect(sources).toContain('current_only');
    });

    it('contains at least one document whose expectation is a VARIANCE, not a pass', () => {
      expect(PAYSLIP_LAYOUT_FIXTURES.some((f) => f.expected.reconciliationStatus === 'variance')).toBe(true);
    });

    it('contains at least one document whose expectation is an ABSENT gross', () => {
      expect(PAYSLIP_LAYOUT_FIXTURES.some((f) => f.layout.grossPaySource === null)).toBe(true);
    });
  });
});
