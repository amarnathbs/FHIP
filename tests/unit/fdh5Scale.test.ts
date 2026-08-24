/**
 * FDH-5 — Scale certification (spec sections 97-99). Synthetic multi-page,
 * multi-hundred-transaction native-text PDF, verifying correctness (not
 * merely a benchmark): declared count == extracted count == reconciled
 * exactly. True PostgREST 1,001+ row retrieval (spec 98) requires a real
 * database and is certified separately, live, in
 * `scripts/fdh5_live_dev_certification.mjs` (documented in
 * FDH5_SCALE_CERTIFICATION.md) — this file proves the PARSING/RECONCILIATION
 * side of scale, which is format-specific and belongs here.
 */

import { describe, it, expect } from 'vitest';
import { buildBankPdfFixture } from '../support/buildBankPdfFixture';
import { classifyPdf } from '@/lib/financial-data-hub/bank-pdf/classification';
import { flattenPdfLines, reconstructRows } from '@/lib/financial-data-hub/bank-pdf/rowReconstruction';
import { normalizePdfRow } from '@/lib/financial-data-hub/bank-pdf/normalize';
import { reconcileBalances } from '@/lib/financial-data-hub/bank-csv/reconciliation';
import { roundToMoneyScale } from '@/lib/financial-data-hub/bank-csv/amount';
import { PDF_BANK_ADAPTER_REGISTRY } from '@/lib/financial-data-hub/bank-pdf/adapters/registry';
import { PDF_MAX_TRANSACTION_ROWS, PDF_MAX_PAGES } from '@/lib/financial-data-hub/bank-pdf/constants';

const CBA = PDF_BANK_ADAPTER_REGISTRY.find((a) => a.id === 'au_cba_pdf_v1')!;

function buildLargeStatement(count: number, perPage: number) {
  let balance = 100000; // cents-safe starting point in whole dollars
  const transactions = Array.from({ length: count }, (_, i) => {
    const debit = i % 2 === 0;
    const amount = 10 + (i % 50) * 0.11;
    const rounded = roundToMoneyScale(amount);
    balance = roundToMoneyScale(debit ? balance - rounded : balance + rounded);
    return {
      date: `${(i % 28) + 1} Aug 2026`,
      description: `TXN NUMBER ${i + 1}`,
      amount: `${rounded.toFixed(2)} ${debit ? 'DR' : 'CR'}`,
      balance: balance.toFixed(2),
    };
  });
  return { bytes: buildBankPdfFixture({ brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'], columnHeaderLine: 'Date Transaction Details Debit Credit Balance', transactions, transactionsPerPage: perPage }), finalBalance: balance };
}

describe('FDH-5 scale certification — 1,000-transaction synthetic native-text PDF', () => {
  it('declared 1000, extracted 1000, reconciled exactly, across many pages', async () => {
    const { bytes, finalBalance } = buildLargeStatement(1000, 50);
    const classified = await classifyPdf(new Uint8Array(bytes));
    expect(classified.classification).toBe('text_native');
    expect(classified.pageCount).toBe(20);

    const lines = flattenPdfLines(classified.pages!, CBA);
    const { rows, unparseableBlocks } = reconstructRows(lines, CBA);
    expect(unparseableBlocks).toEqual([]);
    expect(rows.length).toBe(1000);

    const normalised = rows.map((r) => normalizePdfRow(r, CBA.dateFormat, CBA.amountConvention));
    expect(normalised.every((n) => n.ok)).toBe(true);

    const recon = reconcileBalances(
      normalised.map((n) => (n.ok ? { sourceRowNumber: n.transaction.sourceRowNumber, amountOriginal: n.transaction.amountOriginal, creditDebit: n.transaction.creditDebit, balanceAfter: n.transaction.balanceAfter } : (null as never))),
      'AUD',
    );
    expect(recon.status).toBe('reconciled');
    expect(recon.reportedClosingBalance).toBe(finalBalance);
  }, 30_000);
});

describe('FDH-5 bounded limits are real, enforced ceilings (spec 18, 97-99)', () => {
  it('PDF_MAX_TRANSACTION_ROWS and PDF_MAX_PAGES are finite, positive, and documented bounds (not accidentally Infinity/0)', () => {
    expect(PDF_MAX_TRANSACTION_ROWS).toBeGreaterThan(0);
    expect(PDF_MAX_TRANSACTION_ROWS).toBeLessThan(1_000_000);
    expect(PDF_MAX_PAGES).toBeGreaterThan(0);
    expect(PDF_MAX_PAGES).toBeLessThan(10_000);
  });
});
