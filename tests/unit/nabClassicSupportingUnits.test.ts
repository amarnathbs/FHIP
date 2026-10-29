/**
 * The pieces around the NAB positional reader (30-10-2026). UNIT-TESTED, SYNTHETIC inputs only.
 *   - the shared description cleanup (dotted leaders out, nothing else touched);
 *   - the checkpoint rollforward (exact, to the cent; named failures);
 *   - the registry/detection contract (the REAL layout is detected as v2, the invented v1 layout still reads as v1, neither steals the other);
 *   - the AIE bridge parser stays exactly as unsupported for a positional layout as it was before the reader existed;
 *   - the pre-save AI review panel's text (day-first dates, currency amounts) and the period-disagreement check.
 */
import { describe, expect, it } from 'vitest';
import { cleanStatementDescription, cleanStatementDescriptionOrKeep } from '@/lib/financial-data-hub/bank-pdf/descriptionCleanup';
import { forwardBalancesDisagree, reconcileWithCheckpoints } from '@/lib/financial-data-hub/bank-pdf/checkpointReconciliation';
import { detectPdfBankAdapter } from '@/lib/financial-data-hub/bank-pdf/detection';
import { PDF_BANK_ADAPTER_REGISTRY } from '@/lib/financial-data-hub/bank-pdf/adapters/registry';
import { extractPdfPages } from '@/lib/financial-data-hub/bank-pdf/textExtraction';
import { runBankPdfPipelineFromReadRows } from '@/lib/financial-data-hub/bank-pdf/orchestrator';
import { createFdhBankStatementParser } from '@/lib/aie/adapters/fdhBankStatement/parser';
import { declaredPeriodDiffersFromPrinted } from '@/lib/financial-data-hub/services/bankPdfProcessingService';
import { draftMoneyText, draftPeriodText } from '@/components/expenses/aiDraftDisplay';
import { buildNabClassicPdf, sampleLedger } from '../support/buildNabClassicPdf';

describe('cleanStatementDescription', () => {
  it('removes a dotted leader and collapses whitespace', () => {
    expect(cleanStatementDescription('Sample Payee ..........................')).toBe('Sample Payee');
    expect(cleanStatementDescription('Sample   Payee ... 123456')).toBe('Sample Payee 123456');
    expect(cleanStatementDescription('Online 1234567890 Linked Acc Trns   Sample As.........')).toBe('Online 1234567890 Linked Acc Trns Sample As');
  });
  it('also removes a leader printed with spaces between the dots, and the unicode ellipsis', () => {
    expect(cleanStatementDescription('Payee . . . . . . 25')).toBe('Payee 25');
    expect(cleanStatementDescription('Payee …… 25')).toBe('Payee 25');
  });
  it('a description that was nothing but a leader is kept, not emptied (the AI-read paths)', () => {
    expect(cleanStatementDescription('..........')).toBe('');
    expect(cleanStatementDescriptionOrKeep('..........')).toBe('..........');
    expect(cleanStatementDescriptionOrKeep('Payee ......')).toBe('Payee');
  });
  it('never touches a reference number, a two-dot run, an abbreviation or a decimal', () => {
    expect(cleanStatementDescription('Ref 12.50 Co. Ltd. U.S.A. e.g.. end')).toBe('Ref 12.50 Co. Ltd. U.S.A. e.g.. end');
    expect(cleanStatementDescription('A1B2C3')).toBe('A1B2C3');
  });
});

describe('reconcileWithCheckpoints', () => {
  const rows = [
    { sourceRowNumber: 1, amountOriginal: 100, creditDebit: 'debit' as const, balanceAfter: null },
    { sourceRowNumber: 2, amountOriginal: 50.25, creditDebit: 'credit' as const, balanceAfter: 950.25 },
    { sourceRowNumber: 3, amountOriginal: 20.1, creditDebit: 'debit' as const, balanceAfter: null },
    { sourceRowNumber: 4, amountOriginal: 0.15, creditDebit: 'debit' as const, balanceAfter: 930 },
  ];
  const base = { rows, openingBalance: 1000, declaredClosingBalance: 930, currencyCode: 'AUD' };

  it('reconciles when every printed balance and the closing balance agree exactly', () => {
    expect(reconcileWithCheckpoints(base)).toMatchObject({ status: 'reconciled', variance: 0, firstBreakRowNumber: null, expectedClosingBalance: 930, extractedCredits: 50.25, extractedDebits: 120.25 });
  });
  it('NEGATIVE CONTROL a printed balance ONE CENT out -> failed at that row', () => {
    const out = reconcileWithCheckpoints({ ...base, rows: rows.map((r) => (r.sourceRowNumber === 2 ? { ...r, balanceAfter: 950.26 } : r)) });
    expect(out.status).toBe('failed');
    expect(out.firstBreakRowNumber).toBe(2);
  });
  it('NEGATIVE CONTROL the closing balance ONE CENT out -> failed, variance exactly one cent', () => {
    const out = reconcileWithCheckpoints({ ...base, declaredClosingBalance: 930.01 });
    expect(out.status).toBe('failed');
    expect(out.variance).toBe(-0.01);
  });
  it('NEGATIVE CONTROL the opening balance ONE CENT out -> failed', () => {
    expect(reconcileWithCheckpoints({ ...base, openingBalance: 1000.01 }).status).toBe('failed');
  });
  it('NEGATIVE CONTROL a printed total ONE CENT out -> failed even though every balance agrees', () => {
    expect(reconcileWithCheckpoints({ ...base, declaredTotalDebits: 120.25, declaredTotalCredits: 50.25 }).status).toBe('reconciled');
    expect(reconcileWithCheckpoints({ ...base, declaredTotalDebits: 120.26 }).status).toBe('failed');
    expect(reconcileWithCheckpoints({ ...base, declaredTotalCredits: 50.24 }).status).toBe('failed');
  });
  it('a balance printed on a narrative row (no amount) is checked against the running balance at that point', () => {
    const ok = reconcileWithCheckpoints({ ...base, standaloneBalances: [{ afterRowCount: 0, balance: 1000 }, { afterRowCount: 1, balance: 900 }] });
    expect(ok.status).toBe('reconciled');
    const bad = reconcileWithCheckpoints({ ...base, standaloneBalances: [{ afterRowCount: 1, balance: 900.01 }] });
    expect(bad.status).toBe('failed');
    expect(bad.firstBreakRowNumber).toBe(1);
  });
  it('a carried-forward balance that differs from the next page\'s brought-forward balance fails the statement', () => {
    expect(reconcileWithCheckpoints({ ...base, forwardMismatch: true }).status).toBe('failed');
    expect(forwardBalancesDisagree([{ pageNumber: 1, kind: 'carried', balance: 10 }, { pageNumber: 2, kind: 'brought', balance: 10 }], 'AUD')).toBe(false);
    expect(forwardBalancesDisagree([{ pageNumber: 1, kind: 'carried', balance: 10 }, { pageNumber: 2, kind: 'brought', balance: 10.01 }], 'AUD')).toBe(true);
  });
  it('never answers "pending": a statement is either proven exactly or it is failed', () => {
    for (const r of [reconcileWithCheckpoints(base), reconcileWithCheckpoints({ ...base, declaredClosingBalance: 1 })]) expect(['reconciled', 'failed']).toContain(r.status);
  });
});

describe('registry and detection', () => {
  it('has the real NAB layout (v2, read by position) AND keeps the old invented v1 layout, and each is detected only for its own text', () => {
    const ids = PDF_BANK_ADAPTER_REGISTRY.map((a) => a.id);
    expect(ids).toContain('au_nab_classic_pdf_v2');
    expect(ids).toContain('au_nab_pdf_v1');
    expect(PDF_BANK_ADAPTER_REGISTRY.find((a) => a.id === 'au_nab_classic_pdf_v2')?.positionalReaderId).toBe('nab_classic');
    expect(PDF_BANK_ADAPTER_REGISTRY.filter((a) => a.positionalReaderId).map((a) => a.id)).toEqual(['au_nab_classic_pdf_v2']);
    const v1Text = 'National Australia Bank Limited Transaction Listing Date Description Debit Credit Balance 10-08-2026 EFTPOS PURCHASE COLES 442 67.10 DR 2,345.67';
    expect(detectPdfBankAdapter(v1Text).adapter?.id).toBe('au_nab_pdf_v1');
  });

  it('detects the text of a statement laid out like the real one as v2', async () => {
    const built = buildNabClassicPdf({ opening: 100, entries: sampleLedger(6) });
    const ex = await extractPdfPages(new Uint8Array(built.pdf));
    expect(ex.ok).toBe(true);
    if (!ex.ok) return;
    const d = detectPdfBankAdapter(ex.pages.join('\n'));
    expect(d.status).toBe('detected');
    expect(d.adapter?.id).toBe('au_nab_classic_pdf_v2');
  });

  it('the AIE bridge parser leaves a positional layout exactly as unsupported as it was before the reader existed', async () => {
    const built = buildNabClassicPdf({ opening: 100, entries: sampleLedger(6) });
    const ex = await extractPdfPages(new Uint8Array(built.pdf));
    if (!ex.ok) throw new Error('extract');
    const text = ex.pages.join('\n');
    const parser = createFdhBankStatementParser({ financialAccountId: 'a', currencyCode: 'AUD', statementUploadId: 'u', dedupIndex: new Map(), priorStatementRanges: new Map() });
    expect(parser.sniff(text)).toBe(false);
    const out = parser.parse(text);
    expect(out.outcome).toBe('failed');
    expect(out.failureReason).toBe('unsupported_layout');
  });
});

describe('AI-read rows share the description cleanup', () => {
  it('a dotted leader in an AI-read description is removed before the row is fingerprinted and stored', () => {
    const pipeline = runBankPdfPipelineFromReadRows({
      statementUploadId: 'u',
      financialAccountId: 'a',
      currencyCode: 'AUD',
      dedupIndex: new Map(),
      rows: [{ sourceRowNumber: 1, transactionDate: '2024-03-04', descriptionRaw: 'Sample As.........', amountOriginal: 10, creditDebit: 'debit', balanceAfter: null }],
      statementMetadata: { declaredOpeningBalance: null, declaredClosingBalance: null, maskedAccountIdentifier: null, statementPeriodStart: null, statementPeriodEnd: null },
      pageCount: 1,
      parserVersion: 'test',
    });
    expect(pipeline.accepted[0].descriptionRaw).toBe('Sample As');
    expect(pipeline.accepted[0].descriptionClean).toBe('Sample As');
  });
});

describe('the pre-save AI review panel text', () => {
  it('shows the period day-first (AU dd/mm/yyyy, India dd-mm-yyyy), never year-first', () => {
    expect(draftPeriodText('2024-03-04', '2024-06-01', 'AUD')).toBe('04/03/2024 to 01/06/2024');
    expect(draftPeriodText('2024-03-04', '2024-06-01', 'INR')).toBe('04-03-2024 to 01-06-2024');
    expect(draftPeriodText(null, null, 'AUD')).toBe('Not shown');
    expect(draftPeriodText('2024-03-04', '2024-06-01', 'AUD')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
  it('shows a balance and an amount as money in the account currency with both decimals, and "Not shown" when there is none', () => {
    expect(draftMoneyText(1234.56, 'AUD')).toBe('$1,234.56');
    expect(draftMoneyText(0.5, 'AUD')).toBe('$0.50');
    expect(draftMoneyText(1234567.8, 'INR')).toContain('12,34,567.80');
    expect(draftMoneyText(null, 'AUD')).toBe('Not shown');
    expect(draftMoneyText(1234.56, 'AUD')).not.toBe('1234.56');
  });
});

describe('a period typed at upload that disagrees with the period the statement prints', () => {
  const printed = { statementPeriodStart: '2024-03-04', statementPeriodEnd: '2024-06-01' };
  it('is reported; an agreeing, absent or unprinted period is not', () => {
    expect(declaredPeriodDiffersFromPrinted({ statement_period_start: '2024-03-02', statement_period_end: '2024-05-31' }, printed)).toBe(true);
    expect(declaredPeriodDiffersFromPrinted({ statement_period_start: '2024-03-04', statement_period_end: '2024-05-31' }, printed)).toBe(true);
    expect(declaredPeriodDiffersFromPrinted({ statement_period_start: '2024-03-04', statement_period_end: '2024-06-01' }, printed)).toBe(false);
    expect(declaredPeriodDiffersFromPrinted({ statement_period_start: null, statement_period_end: null }, printed)).toBe(false);
    expect(declaredPeriodDiffersFromPrinted({ statement_period_start: '2024-03-02', statement_period_end: '2024-05-31' }, { statementPeriodStart: null, statementPeriodEnd: null })).toBe(false);
    expect(declaredPeriodDiffersFromPrinted({ statement_period_start: '2024-03-02', statement_period_end: '2024-05-31' }, null)).toBe(false);
  });
});
