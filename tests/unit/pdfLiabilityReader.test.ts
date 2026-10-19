/**
 * Liability PDF reader (layouts CARD-1 and LOAN-1) over the real corpus PDFs: real PDF bytes -> the real local text extractor ->
 * the certified reader. The expected values come from scripts/pdf_routes_corpus.ts (hand-computed); nothing is read back from the reader.
 * The fallback-needing documents must fail LEGITIMATELY (the reader is not weakened to force the AI).
 */
import { describe, expect, it } from 'vitest';
import { LIABILITY_DOCS, buildCorpusPdf, type LiabilityDoc } from '../../scripts/pdf_routes_corpus';
import { readStatementPdf } from '@/lib/financial-data-hub/pdf-statements';
import { readLiabilityPdf } from '@/lib/financial-data-hub/liability/pdfStatement';
import { computeStatementTotals } from '@/lib/financial-data-hub/liability/statementReconciliation';

async function readDoc(d: LiabilityDoc) {
  const text = await readStatementPdf(new Uint8Array(buildCorpusPdf(d)));
  if (!text.ok) return { text, result: null };
  const result = readLiabilityPdf({ text, statementType: d.declared.statement_type as 'credit_card' | 'loan', currencyCode: 'AUD' });
  return { text, result };
}

describe('liability reader: the documents the certified layouts cover', () => {
  for (const d of LIABILITY_DOCS.filter((x) => x.route.deterministic === 'reads')) {
    it(`${d.id} is read line for line and header for header`, async () => {
      const { result } = await readDoc(d);
      expect(result?.ok, d.id).toBe(true);
      if (!result?.ok) return;
      const e = d.expected!;
      expect(result.header.institutionName).toBe(e.institution);
      expect(result.header.maskedIdentifier).toBe(`****${e.last4}`);
      expect(result.header.statementPeriodStart).toBe(e.periodStart);
      expect(result.header.statementPeriodEnd).toBe(e.periodEnd);
      expect(result.header.statementDate).toBe(e.statementDate);
      expect(result.header.dueDate).toBe(e.dueDate);
      expect(result.header.openingBalance).toBe(e.opening);
      expect(result.header.closingBalance).toBe(e.printedClosing);
      expect(result.header.creditLimit).toBe(e.creditLimit);
      expect(result.header.minimumPayment).toBe(e.minimumPayment);
      expect(result.header.interestRate).toBe(e.interestRate);
      expect(result.activities.map((a) => ({ date: a.activityDate, type: a.activityType, amount: a.amount }))).toEqual(
        e.activities.map((a) => ({ date: a.date, type: a.type, amount: a.amount })),
      );
    });
    it(`${d.id}: the existing certified reconciliation gives the expected verdict (${d.route.reconciliation})`, async () => {
      const { result } = await readDoc(d);
      if (!result?.ok) throw new Error('not read');
      const totals = computeStatementTotals({
        statementType: result.statementType,
        activities: result.activities,
        opening: result.header.openingBalance ?? null,
        closing: result.header.closingBalance ?? null,
        currencyCode: 'AUD',
      });
      expect(totals.reconciliation.status).toBe(d.route.reconciliation);
      if (d.id === 'LB-04') expect(totals.reconciliation.variance).toBe(-43.95);
      // Certified = reconciled with no warning at all.
      const certified = totals.reconciliation.status === 'reconciled' && result.warnings.length === 0 && totals.warnings.length === 0;
      expect(certified).toBe(d.route.outcome === 'certified');
    });
  }

  it('LB-06: summary lines are excluded (and counted), the identical genuine pair is kept twice', async () => {
    const { result } = await readDoc(LIABILITY_DOCS.find((x) => x.id === 'LB-06')!);
    if (!result?.ok) throw new Error('not read');
    expect(result.notes.summaryLinesExcluded).toBe(4);
    expect(result.activities.filter((a) => a.amount === 255)).toHaveLength(2);
    expect(result.activities).toHaveLength(6);
  });

  it('LB-02: the loan lines take their direction from the printed running balance', async () => {
    const { result } = await readDoc(LIABILITY_DOCS.find((x) => x.id === 'LB-02')!);
    if (!result?.ok) throw new Error('not read');
    expect(result.activities.map((a) => a.activityType)).toEqual(['PAYMENT', 'PAYMENT', 'INTEREST', 'FEE']);
    expect(result.warnings).toEqual([]);
  });
});

describe('liability reader: legitimate failures (never forced, never guessed)', () => {
  it('LB-03 (year-less dates, section headings) is a layout the certified reader cannot read', async () => {
    const { result } = await readDoc(LIABILITY_DOCS.find((x) => x.id === 'LB-03')!);
    expect(result).toMatchObject({ ok: false, kind: 'layout_unsupported' });
  });
  it('LB-07 (footnote asterisk on an amount) is unread lines, not a dropped line', async () => {
    const { result } = await readDoc(LIABILITY_DOCS.find((x) => x.id === 'LB-07')!);
    expect(result).toMatchObject({ ok: false, kind: 'unread_lines' });
  });
  it('LB-05 (two accounts) is refused as multiple accounts', async () => {
    const { result } = await readDoc(LIABILITY_DOCS.find((x) => x.id === 'LB-05')!);
    expect(result).toMatchObject({ ok: false, kind: 'multiple_accounts' });
  });
  it('LB-08 (a bank account statement) is not this class', async () => {
    const { result } = await readDoc(LIABILITY_DOCS.find((x) => x.id === 'LB-08')!);
    expect(result).toMatchObject({ ok: false, kind: 'not_this_class' });
  });
  it('a card statement declared as a loan (and a loan declared as a card) is not this class', async () => {
    const card = LIABILITY_DOCS.find((x) => x.id === 'LB-01')!;
    const loan = LIABILITY_DOCS.find((x) => x.id === 'LB-02')!;
    const t1 = await readStatementPdf(new Uint8Array(buildCorpusPdf(card)));
    const t2 = await readStatementPdf(new Uint8Array(buildCorpusPdf(loan)));
    if (!t1.ok || !t2.ok) throw new Error('text');
    expect(readLiabilityPdf({ text: t1, statementType: 'loan', currencyCode: 'AUD' })).toMatchObject({ ok: false, kind: 'not_this_class' });
    expect(readLiabilityPdf({ text: t2, statementType: 'credit_card', currencyCode: 'AUD' })).toMatchObject({ ok: false, kind: 'not_this_class' });
  });
  it('every document the corpus says the certified reader cannot read fails with exactly the expected kind', async () => {
    for (const d of LIABILITY_DOCS.filter((x) => x.route.deterministic !== 'reads')) {
      const { result } = await readDoc(d);
      expect(result, d.id).toMatchObject({ ok: false, kind: d.route.deterministic });
    }
  });
});
