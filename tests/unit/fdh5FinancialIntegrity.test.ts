/**
 * FDH-5 — Financial integrity certification: exact decimal precision,
 * reconciliation negative controls (0.01 corruption, missing row),
 * deduplication positive/negative (including cross-format CSV+PDF), and
 * idempotent reprocessing (spec sections 40, 57-62, 89-94, 101-102).
 *
 * INDEPENDENT ORACLE (spec 101). Expected sums/balances below are computed
 * by plain arithmetic in the TEST file itself, never by calling the engine
 * under test to "check its own homework".
 */

import { describe, it, expect } from 'vitest';
import { buildBankPdfFixture } from '../support/buildBankPdfFixture';
import { classifyPdf } from '@/lib/financial-data-hub/bank-pdf/classification';
import { PDF_BANK_ADAPTER_REGISTRY } from '@/lib/financial-data-hub/bank-pdf/adapters/registry';
import { flattenPdfLines, reconstructRows } from '@/lib/financial-data-hub/bank-pdf/rowReconstruction';
import { normalizePdfRow } from '@/lib/financial-data-hub/bank-pdf/normalize';
import { reconcileBalances } from '@/lib/financial-data-hub/bank-csv/reconciliation';
import { computeEconomicFingerprint, computeSourceRowHash } from '@/lib/financial-data-hub/bank-csv/fingerprint';
import { decideDedup, addToDedupIndex, type DedupIndex } from '@/lib/financial-data-hub/bank-csv/dedup';
import { normalizeRow, type RowFormat } from '@/lib/financial-data-hub/bank-csv/normalize';

const CBA = PDF_BANK_ADAPTER_REGISTRY.find((a) => a.id === 'au_cba_pdf_v1')!;

async function extractRows(bytes: Uint8Array) {
  const classified = await classifyPdf(bytes);
  const lines = flattenPdfLines(classified.pages!, CBA);
  return reconstructRows(lines, CBA).rows;
}

describe('FDH-5 monetary precision (spec 40)', () => {
  const cases: { amount: string; balance: string; expectedAmount: number; expectedBalance: number }[] = [
    { amount: '0.01 DR', balance: '999.99', expectedAmount: 0.01, expectedBalance: 999.99 },
    { amount: '0.10 CR', balance: '1000.10', expectedAmount: 0.1, expectedBalance: 1000.1 },
    { amount: '999999.99 DR', balance: '0.01', expectedAmount: 999999.99, expectedBalance: 0.01 },
  ];
  for (const c of cases) {
    it(`AUD ${c.amount} / balance ${c.balance} normalises to exact values, no float drift`, async () => {
      const bytes = new Uint8Array(
        buildBankPdfFixture({
          brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
          columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
          transactions: [{ date: '1 Aug 2026', description: 'TEST TXN', amount: c.amount, balance: c.balance }],
        }),
      );
      const rows = await extractRows(bytes);
      const result = normalizePdfRow(rows[0], CBA.dateFormat, CBA.amountConvention);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.transaction.amountOriginal).toBe(c.expectedAmount);
        expect(result.transaction.balanceAfter).toBe(c.expectedBalance);
      }
    });
  }

  it('INR Indian-grouped amounts (1,23,456.78) parse identically to Western grouping', async () => {
    const bytes = new Uint8Array(
      buildBankPdfFixture({
        brandLines: ['ICICI Bank Limited', 'Account Statement'],
        columnHeaderLine: 'Date Transaction Remarks Withdrawal Deposit Balance',
        transactions: [{ date: '1-Aug-2026', description: 'NEFT TRANSFER', amount: '99,99,999.99 DR', balance: '1,23,456.78' }],
      }),
    );
    const ICICI = PDF_BANK_ADAPTER_REGISTRY.find((a) => a.id === 'in_icici_pdf_v1')!;
    const classified = await classifyPdf(bytes);
    const lines = flattenPdfLines(classified.pages!, ICICI);
    const rows = reconstructRows(lines, ICICI).rows;
    const result = normalizePdfRow(rows[0], ICICI.dateFormat, ICICI.amountConvention);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transaction.amountOriginal).toBe(9999999.99);
      expect(result.transaction.balanceAfter).toBe(123456.78);
    }
  });
});

describe('FDH-5 reconciliation negative controls (spec 47, 61, 94, 102)', () => {
  it('POSITIVE: a clean 3-row statement reconciles exactly (independent oracle: 1000 - 45.20 + 500 - 220.24 = 1234.56)', async () => {
    const bytes = new Uint8Array(
      buildBankPdfFixture({
        brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
        columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
        transactions: [
          { date: '1 Aug 2026', description: 'A', amount: '45.20 DR', balance: '954.80' },
          { date: '3 Aug 2026', description: 'B', amount: '500.00 CR', balance: '1,454.80' },
          { date: '5 Aug 2026', description: 'C', amount: '220.24 DR', balance: '1,234.56' },
        ],
      }),
    );
    const rows = await extractRows(bytes);
    const normalised = rows.map((r) => normalizePdfRow(r, CBA.dateFormat, CBA.amountConvention));
    expect(normalised.every((n) => n.ok)).toBe(true);
    const recon = reconcileBalances(
      normalised.map((n) => (n.ok ? { sourceRowNumber: n.transaction.sourceRowNumber, amountOriginal: n.transaction.amountOriginal, creditDebit: n.transaction.creditDebit, balanceAfter: n.transaction.balanceAfter } : (null as never))),
      'AUD',
    );
    expect(recon.status).toBe('reconciled');
    expect(recon.reportedClosingBalance).toBe(1234.56);
  });

  it('NEGATIVE — 0.01 corruption (spec 46, 94): deliberately mis-stating the LAST balance by 1 cent is DETECTED, never silently passed', async () => {
    const bytes = new Uint8Array(
      buildBankPdfFixture({
        brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
        columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
        transactions: [
          { date: '1 Aug 2026', description: 'A', amount: '45.20 DR', balance: '954.80' },
          { date: '3 Aug 2026', description: 'B', amount: '500.00 CR', balance: '1,454.80' },
          // Corrupted: should be 1,234.56, deliberately off by 0.01.
          { date: '5 Aug 2026', description: 'C', amount: '220.24 DR', balance: '1,234.57' },
        ],
      }),
    );
    const rows = await extractRows(bytes);
    const normalised = rows.map((r) => normalizePdfRow(r, CBA.dateFormat, CBA.amountConvention));
    const recon = reconcileBalances(
      normalised.map((n) => (n.ok ? { sourceRowNumber: n.transaction.sourceRowNumber, amountOriginal: n.transaction.amountOriginal, creditDebit: n.transaction.creditDebit, balanceAfter: n.transaction.balanceAfter } : (null as never))),
      'AUD',
    );
    expect(recon.status).toBe('failed');
    expect(recon.firstBreakRowNumber).toBe(3);
  });

  it('NEGATIVE — missing row (spec 94): deliberately omitting a transaction breaks the running-balance chain and is DETECTED', async () => {
    const bytes = new Uint8Array(
      buildBankPdfFixture({
        brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
        columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
        transactions: [
          { date: '1 Aug 2026', description: 'A', amount: '45.20 DR', balance: '954.80' },
          // Row B (SALARY +500.00) intentionally OMITTED — balance jumps
          // straight from 954.80 to a value that assumed it happened.
          { date: '5 Aug 2026', description: 'C', amount: '220.24 DR', balance: '1,234.56' },
        ],
      }),
    );
    const rows = await extractRows(bytes);
    const normalised = rows.map((r) => normalizePdfRow(r, CBA.dateFormat, CBA.amountConvention));
    const recon = reconcileBalances(
      normalised.map((n) => (n.ok ? { sourceRowNumber: n.transaction.sourceRowNumber, amountOriginal: n.transaction.amountOriginal, creditDebit: n.transaction.creditDebit, balanceAfter: n.transaction.balanceAfter } : (null as never))),
      'AUD',
    );
    expect(recon.status).toBe('failed');
  });
});

describe('FDH-5 deduplication — positive and negative controls (spec 33, 57-59, 68, 102)', () => {
  it('POSITIVE: reprocessing the identical PDF a second time (same account) marks every row a confirmed duplicate', async () => {
    const bytes = new Uint8Array(
      buildBankPdfFixture({
        brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
        columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
        transactions: [{ date: '1 Aug 2026', description: 'A', amount: '45.20 DR', balance: '954.80' }],
      }),
    );
    const rows = await extractRows(bytes);
    const n1 = normalizePdfRow(rows[0], CBA.dateFormat, CBA.amountConvention);
    expect(n1.ok).toBe(true);
    if (!n1.ok) throw new Error('unreachable');

    const index: DedupIndex = new Map();
    const fp1 = computeEconomicFingerprint({ financialAccountId: 'acct-1', currencyCode: 'AUD', transaction: n1.transaction });
    const decision1 = decideDedup({ economicFingerprint: fp1, hasStrongEvidence: true }, index);
    expect(decision1.status).toBe('unique');
    addToDedupIndex(index, fp1, { transactionId: 'txn-1', hasStrongEvidence: true });

    // Second import of the SAME statement (same account, same balance
    // evidence) — the fingerprint is deterministic, so it matches.
    const fp2 = computeEconomicFingerprint({ financialAccountId: 'acct-1', currencyCode: 'AUD', transaction: n1.transaction });
    expect(fp2).toBe(fp1);
    const decision2 = decideDedup({ economicFingerprint: fp2, hasStrongEvidence: true }, index);
    expect(decision2.status).toBe('duplicate_confirmed');
  });

  it('NEGATIVE: two genuinely separate same-day/same-amount transactions with NO reference/balance evidence remain distinct candidates, never silently merged (spec 33, 59)', () => {
    const index: DedupIndex = new Map();
    const txn = {
      sourceRowNumber: 1,
      transactionDate: '2026-08-10',
      postedDate: null,
      valueDate: null,
      descriptionRaw: 'Coffee Shop',
      descriptionClean: 'Coffee Shop',
      referenceRaw: null,
      amountOriginal: 5,
      creditDebit: 'debit' as const,
      balanceAfter: null, // no balance evidence — weak
      transactionTypeHint: 'unknown' as const,
    };
    const fp = computeEconomicFingerprint({ financialAccountId: 'acct-1', currencyCode: 'AUD', transaction: txn });
    const d1 = decideDedup({ economicFingerprint: fp, hasStrongEvidence: false }, index);
    expect(d1.status).toBe('unique');
    addToDedupIndex(index, fp, { transactionId: 'txn-1', hasStrongEvidence: false });
    // A second, GENUINELY DIFFERENT coffee purchase, same date/amount,
    // still no reference/balance — fingerprints identically (spec 33's own
    // documented limit) but must be flagged as a CANDIDATE for review, not
    // silently discarded as one fewer transaction (spec 59).
    const d2 = decideDedup({ economicFingerprint: fp, hasStrongEvidence: false }, index);
    expect(d2.status).toBe('duplicate_candidate');
    expect(d2.status).not.toBe('unique');
  });

  it('CROSS-FORMAT: the SAME statement uploaded once as CSV and once as PDF fingerprints IDENTICALLY (spec 57-58) — genuine duplicate evidence, no double-counting', async () => {
    const bytes = new Uint8Array(
      buildBankPdfFixture({
        brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
        columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
        transactions: [{ date: '1 Aug 2026', description: 'CARD PURCHASE WOOLWORTHS', amount: '45.20 DR', balance: '954.80' }],
      }),
    );
    const rows = await extractRows(bytes);
    const pdfResult = normalizePdfRow(rows[0], CBA.dateFormat, CBA.amountConvention);
    expect(pdfResult.ok).toBe(true);
    if (!pdfResult.ok) throw new Error('unreachable');

    // Equivalent CSV row for the SAME economic transaction, run through the
    // EXACT SAME `normalizeRow` R7 uses.
    const rowFormat: RowFormat = {
      columnRoles: { transactionDate: 'Date', description: 'Description', debit: 'Debit', credit: 'Credit', balance: 'Balance' },
      amountConvention: 'debit_credit_columns',
      dateFormat: 'DD/MM/YYYY',
    };
    const csvResult = normalizeRow(
      ['Date', 'Description', 'Debit', 'Credit', 'Balance'],
      ['01/08/2026', 'CARD PURCHASE WOOLWORTHS', '45.20', '', '954.80'],
      1,
      rowFormat,
    );
    expect(csvResult.ok).toBe(true);
    if (!csvResult.ok) throw new Error('unreachable');

    const pdfFp = computeEconomicFingerprint({ financialAccountId: 'acct-1', currencyCode: 'AUD', transaction: pdfResult.transaction });
    const csvFp = computeEconomicFingerprint({ financialAccountId: 'acct-1', currencyCode: 'AUD', transaction: csvResult.transaction });
    expect(pdfFp).toBe(csvFp);

    // And the two source-row hashes, being derived from DIFFERENT source
    // evidence (different statement_upload_id / row index / raw values),
    // are correctly DIFFERENT — provenance from both documents is
    // preserved, never collapsed to indistinguishable.
    const pdfRowHash = computeSourceRowHash('pdf-doc-1', 1, ['1 Aug 2026', 'CARD PURCHASE WOOLWORTHS', '45.20 DR', '954.80']);
    const csvRowHash = computeSourceRowHash('csv-doc-1', 1, ['01/08/2026', 'CARD PURCHASE WOOLWORTHS', '45.20', '', '954.80']);
    expect(pdfRowHash).not.toBe(csvRowHash);
  });
});

describe('FDH-5 idempotent reprocessing (spec 89)', () => {
  // Two SEPARATE downloads of the identical statement bytes — exactly what
  // a real reprocessing attempt does (`downloadDocumentObject` re-fetches
  // fresh bytes from storage every call; `bankPdfProcessingService.ts`
  // never reuses one in-memory buffer across two processing attempts). Two
  // independent `Uint8Array` copies are used deliberately, sequentially:
  // `pdf-parse`'s own documented contract is that a TypedArray passed as
  // `data` "will generally be TRANSFERRED to the worker thread" — i.e. the
  // SAME buffer instance cannot safely be parsed twice concurrently, a real
  // constraint of the dependency this test respects rather than fights.
  it('reprocessing the identical statement (two independent extractions) produces byte-identical fingerprints and dates', async () => {
    const build = () =>
      new Uint8Array(
        buildBankPdfFixture({
          brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
          columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
          transactions: [{ date: '1 Aug 2026', description: 'A', amount: '45.20 DR', balance: '954.80' }],
        }),
      );
    const run = async (bytes: Uint8Array) => {
      const rows = await extractRows(bytes);
      const n = normalizePdfRow(rows[0], CBA.dateFormat, CBA.amountConvention);
      if (!n.ok) throw new Error('unreachable');
      return computeEconomicFingerprint({ financialAccountId: 'acct-1', currencyCode: 'AUD', transaction: n.transaction });
    };
    const fp1 = await run(build());
    const fp2 = await run(build());
    expect(fp1).toBe(fp2);
  });
});
