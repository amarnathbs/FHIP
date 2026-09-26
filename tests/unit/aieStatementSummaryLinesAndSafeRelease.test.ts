/**
 * Two defects from the first AI-read bank statement in production (2026-09-26).
 *
 * 1. GPT-4o mini read the "Brought forward" row (the opening balance, printed
 *    in the transaction table) as a 2,000.00 credit -- 9 rows instead of 8.
 *    A deterministic safety net now drops balance/summary lines by their
 *    whole description, without touching real payees.
 * 2. A confirmation that failed AFTER writing its 9 transactions handed its AI
 *    draft back as `pending_review`, so confirming again could have imported
 *    the statement twice. The draft is now released only if nothing was
 *    written for the upload.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ---- in-memory Supabase for the release check ----
type Row = Record<string, unknown>;
const db: Record<string, Row[]> = {};
const failingTables = new Set<string>();
function query(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let patch: Row | null = null;
  let limitN: number | null = null;
  const run = () => {
    let rows = (db[table] ?? []).filter((r) => filters.every((f) => f(r)));
    if (limitN !== null) rows = rows.slice(0, limitN);
    if (patch) for (const r of rows) Object.assign(r, patch);
    return rows;
  };
  const chain: Record<string, unknown> = {
    select: () => chain,
    update: (p: Row) => { patch = p; return chain; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return chain; },
    limit: (n: number) => { limitN = n; return chain; },
    then: (resolve: (v: { data: Row[] | null; error: { message: string; code?: string } | null }) => unknown) =>
      failingTables.has(table) ? resolve({ data: null, error: { message: 'boom' } }) : resolve({ data: run(), error: null }),
  };
  return chain;
}
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => query(t) }) }));

import { isStatementSummaryLine } from '@/lib/aie/adapters/shared/statementSummaryLines';
import { mapBankStatementFactsToDraft } from '@/lib/aie/adapters/bankStatement/mapping';
import { releaseClaimedAiFallbackDraftIfNothingWritten } from '@/lib/financial-data-hub/services/aiFallbackDrafts';
import type { BankStatementDocumentFacts } from '@/lib/aie/adapters/bankStatement/schema';

describe('balance and summary lines are never transactions', () => {
  it.each([
    'Brought forward', 'BROUGHT FORWARD', 'Balance brought forward', 'Carried forward', 'Carried fwd', 'Balance b/f', 'B/F', 'C/F', 'c / f',
    'Opening balance', 'Closing balance', 'Previous balance', 'New balance', 'Balance at end of period',
    'Totals at end of period', 'Total', 'Totals', 'Subtotal', 'Sub-total', 'Brought forward.',
  ])('drops %j', (d) => expect(isStatementSummaryLine(d)).toBe(true));

  it.each([
    'Total Energies Fuel', 'TOTALLY WILD PTY LTD', 'Opening Hours Cafe', 'Forward Freight Logistics', 'Balance Fitness Club',
    'PAYROLL 5521 Quillfeather Studio Pty Ltd', 'Carried Away Travel', 'Woolworths', '', null,
  ])('keeps a real payee %j', (d) => expect(isStatementSummaryLine(d as string | null)).toBe(false));
});

const txn = (transactionDate: string, descriptionRaw: string, amount: string, creditDebit: 'credit' | 'debit', balanceAfter: string | null) =>
  ({ transactionDate, descriptionRaw, amount, creditDebit, balanceAfter });
const field = <T,>(value: T) => ({ value, missingReasonCode: null, evidenceText: null }) as never;

/** The exact shape GPT-4o mini returned in production: 8 real rows plus "Brought forward". */
function productionFacts(): BankStatementDocumentFacts {
  return {
    schemaVersion: '1',
    documentMissingReasonCode: null,
    institutionName: field('FHIP Test Bank'),
    maskedAccountIdentifier: field(null),
    statementPeriodStart: field('2026-08-01'),
    statementPeriodEnd: field('2026-08-31'),
    declaredOpeningBalance: field('2000.00'),
    declaredClosingBalance: field('3877.25'),
    allTransactionsListed: true,
    transactions: [
      txn('2026-08-01', 'Brought forward', '2000.00', 'credit', null),
      txn('2026-08-03', 'PAYROLL 5521 Quillfeather Studio Pty Ltd', '1850.00', 'credit', '3850.00'),
      txn('2026-08-05', 'Online R4471 Linked Acc Trns To Savings Q...', '500.00', 'debit', '3350.00'),
      txn('2026-08-07', 'Rent 0826 Little Harbour Realty', '950.00', 'debit', '2400.00'),
      txn('2026-08-10', 'BPAY 889201 Origin Energy Holdings', '184.30', 'debit', '2215.70'),
      txn('2026-08-12', 'EFTPOS 3310 Nowhere Woolworths', '123.45', 'debit', '2092.25'),
      txn('2026-08-17', 'PAYROLL 5522 Quillfeather Studio Pty Ltd', '1850.00', 'credit', '3942.25'),
      txn('2026-08-21', 'ATM 0931 Nowhere Cash Withdrawal', '60.00', 'debit', '3882.25'),
      txn('2026-08-28', 'Account Fee Monthly Account Fee', '5.00', 'debit', '3877.25'),
    ],
  } as unknown as BankStatementDocumentFacts;
}

describe('the production statement maps to its 8 real transactions', () => {
  it('drops "Brought forward", keeps the 8, and says so', () => {
    const mapped = mapBankStatementFactsToDraft(productionFacts())!;
    expect(mapped.rows).toHaveLength(8);
    expect(mapped.rows.some((r) => /brought forward/i.test(r.descriptionRaw))).toBe(false);
    expect(mapped.warnings).toContain('ai_row_1_summary_line_dropped');
  });

  it('the kept rows now roll forward exactly: 2,000.00 opening -> 3,877.25 closing', () => {
    const mapped = mapBankStatementFactsToDraft(productionFacts())!;
    const net = mapped.rows.reduce((s, r) => s + (r.creditDebit === 'credit' ? r.amountOriginal : -r.amountOriginal), 0);
    expect(Math.round((2000 + net) * 100) / 100).toBe(3877.25);
  });
});

describe('a failed confirmation hands its draft back only if nothing was written', () => {
  beforeEach(() => {
    failingTables.clear();
    for (const k of Object.keys(db)) delete db[k];
    db.fdh_ai_fallback_drafts = [{ id: 'draft-1', user_id: 'u1', statement_upload_id: 'doc-1', status: 'confirmed', confirmed_at: 'x', confirmed_payload: {} }];
  });

  it('PRODUCTION CASE: transactions already written -> the draft stays confirmed (no second import possible)', async () => {
    db.fdh_transactions = [{ id: 't1', user_id: 'u1', statement_upload_id: 'doc-1' }];
    const r = await releaseClaimedAiFallbackDraftIfNothingWritten('u1', 'draft-1', 'doc-1');
    expect(r).toEqual({ released: false, reason: 'rows_written' });
    expect(db.fdh_ai_fallback_drafts[0].status).toBe('confirmed');
  });

  it('the same for every statement type (payroll event, liability, retirement, investment)', async () => {
    for (const t of ['fdh_payroll_events', 'fdh_liability_statements', 'fdh_retirement_statements', 'fdh_investment_statements']) {
      for (const k of Object.keys(db)) if (k !== 'fdh_ai_fallback_drafts') delete db[k];
      db.fdh_ai_fallback_drafts[0].status = 'confirmed';
      db[t] = [{ id: 'x', user_id: 'u1', statement_upload_id: 'doc-1' }];
      expect((await releaseClaimedAiFallbackDraftIfNothingWritten('u1', 'draft-1', 'doc-1')).released, t).toBe(false);
    }
  });

  it('nothing written -> released back to pending_review so the user can retry', async () => {
    const r = await releaseClaimedAiFallbackDraftIfNothingWritten('u1', 'draft-1', 'doc-1');
    expect(r).toEqual({ released: true });
    expect(db.fdh_ai_fallback_drafts[0].status).toBe('pending_review');
  });

  it("another user's rows for the same upload id do not block (scoped by user)", async () => {
    db.fdh_transactions = [{ id: 't1', user_id: 'someone-else', statement_upload_id: 'doc-1' }];
    expect((await releaseClaimedAiFallbackDraftIfNothingWritten('u1', 'draft-1', 'doc-1')).released).toBe(true);
  });

  it('if the check itself fails, it keeps the claim (never re-opens a draft it cannot prove unwritten)', async () => {
    failingTables.add('fdh_transactions');
    const r = await releaseClaimedAiFallbackDraftIfNothingWritten('u1', 'draft-1', 'doc-1');
    expect(r).toEqual({ released: false, reason: 'check_failed' });
    expect(db.fdh_ai_fallback_drafts[0].status).toBe('confirmed');
  });
});
