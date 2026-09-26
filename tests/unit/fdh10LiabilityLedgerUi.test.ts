/**
 * WP-11 (G7, G4, G8, G10): the Liabilities-tab surfaces of the ledger Apply --
 * the import panel's "how each line will count" table and bank-payment picker,
 * Statement history, the apply route's contract -- rendered from the EXACT
 * snake_case rows the APIs return (a camelCase cast renders blank: the
 * negative control below proves the render test would catch it).
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ActivityLedgerPreview, describeRecordedLedger } from '@/components/liabilities/LiabilityImportPanel';
import { StatementHistoryTable, NOT_READ_FROM_STATEMENTS, type HistoryStatementRow } from '@/components/liabilities/LiabilityStatementHistory';
import { ACTIVITY_LEDGER_OUTCOME, BLOCKER_LABELS, describeExtractionWarning } from '@/components/liabilities/liabilityLedgerCopy';
import { LIABILITY_LEDGER_MAPPING } from '@/lib/financial-data-hub/liability/creditCardEconomics';
import { LIABILITY_ACTIVITY_TYPES } from '@/lib/financial-data-hub/liability/types';
import { statusForLiabilityApplyError, toLedgerEffects } from '@/lib/import-bridge/applyLiabilityProposalAtomic';

const render = (el: React.ReactElement) => renderToStaticMarkup(el);
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

describe('the user-facing words match what the Apply writes, for all ten activity types', () => {
  it('every activity type has a label and a "how it counts" sentence', () => {
    for (const t of LIABILITY_ACTIVITY_TYPES) {
      expect(ACTIVITY_LEDGER_OUTCOME[t]?.label, t).toBeTruthy();
      expect(ACTIVITY_LEDGER_OUTCOME[t]?.counts, t).toBeTruthy();
    }
  });

  it('only the types the ledger records as expense say "Counted as spending"; a repayment is never spending, a drawdown never income', () => {
    for (const t of LIABILITY_ACTIVITY_TYPES) {
      const saysSpending = ACTIVITY_LEDGER_OUTCOME[t].counts === 'Counted as spending';
      expect(saysSpending, t).toBe(LIABILITY_LEDGER_MAPPING[t]?.economicType === 'expense');
    }
    expect(ACTIVITY_LEDGER_OUTCOME.PAYMENT.counts).toMatch(/never spending/);
    expect(ACTIVITY_LEDGER_OUTCOME.LOAN_ADVANCE.counts).toMatch(/never income/);
    expect(ACTIVITY_LEDGER_OUTCOME.ADJUSTMENT.counts).toMatch(/Not counted/);
  });

  it('every blocker reason the RPC can return has user copy', () => {
    const sql = read('supabase/migrations/0209_fdh10_liability_apply_ledger.sql');
    const block = /create or replace function fdh10_internal_ledger_blockers[\s\S]*?\$\$ language sql/.exec(sql)![0];
    const reasons = [...block.matchAll(/then '([a-z_]+)'/g)].map((m) => m[1]);
    expect(reasons.sort()).toEqual(['bank_match_invalid', 'component_mismatch', 'foreign_transaction', 'multiple_bank_candidates', 'unclassified_line']);
    for (const r of reasons) expect(BLOCKER_LABELS[r], r).toBeTruthy();
  });

  it('persisted extraction warnings read as sentences, with the row', () => {
    expect(describeExtractionWarning({ code: 'zero_amount', row: 4 })).toBe('A $0.00 line was left out (it moves no money). (row 4)');
    expect(describeExtractionWarning({ code: 'unrecognised_activity_type', row: 7, detail: 'Cashback' })).toContain('(row 7: "Cashback")');
    expect(describeExtractionWarning({ code: 'something_new' })).toBeTruthy();
  });
});

const ROWS = [
  { id: 'a1', activity_type: 'PURCHASE', activity_date: '2026-08-03', amount: 200, description_raw: 'WOOLWORTHS 123', bank_match_status: 'not_attempted' },
  { id: 'a2', activity_type: 'PAYMENT', activity_date: '2026-08-20', amount: 220, description_raw: null, bank_match_status: 'multiple_candidates', bank_match_candidate_ids: ['b1', 'b2'] },
  { id: 'a3', activity_type: 'PAYMENT', activity_date: '2026-08-15', amount: 2000, description_raw: null, bank_match_status: 'matched', principal_component: 1550, interest_component: 430, fee_component: 20 },
  { id: 'a4', activity_type: 'LOAN_ADVANCE', activity_date: '2026-08-02', amount: 5000, description_raw: null, bank_match_status: 'not_attempted' },
];
const CANDIDATES = [
  { id: 'b1', transaction_date: '2026-08-19', amount_original: 220, currency_original: 'AUD', description_clean: 'TEST BANK CARD PMT' },
  { id: 'b2', transaction_date: '2026-08-21', amount_original: 220, currency_original: 'AUD', description_clean: 'TEST BANK CARD PMT 2' },
];

describe('import panel: every line and how it will count (G7), and the bank-payment picker (G4)', () => {
  const props = { activities: ROWS as never, currency: 'AUD', bankCandidates: CANDIDATES, candidateChoice: {}, onChoose: vi.fn(), onSaveChoice: vi.fn(), busy: false };

  it('renders every activity type, not just PAYMENT, from snake_case rows', () => {
    const html = render(React.createElement(ActivityLedgerPreview, props));
    expect(html).toContain('Card purchase');
    expect(html).toContain('WOOLWORTHS 123');
    expect(html).toContain('Counted as spending');
    expect(html).toContain('Drawdown');
    expect(html).toContain('never income');
    expect(html).toContain('Principal $1,550.00 · interest $430.00 · fee $20.00');
  });

  it('offers the persisted candidates (date, amount, narrative) and "None of these"', () => {
    const html = render(React.createElement(ActivityLedgerPreview, props));
    expect(html).toContain('Which bank payment was the 2026-08-20 repayment of $220.00?');
    expect(html).toContain('2026-08-19 — $220.00 — TEST BANK CARD PMT');
    expect(html).toContain('2026-08-21 — $220.00 — TEST BANK CARD PMT 2');
    expect(html).toContain('None of these');
  });

  it('NEGATIVE CONTROL: the same rows cast to camelCase render blank lines (why the contract is snake_case)', () => {
    const camel = ROWS.map((r) => ({ id: r.id, activityType: r.activity_type, activityDate: r.activity_date, amount: r.amount, bankMatchStatus: r.bank_match_status }));
    const html = render(React.createElement(ActivityLedgerPreview, { ...props, activities: camel as never }));
    expect(html).not.toContain('Card purchase');
    expect(html).not.toContain('2026-08-03');
  });

  it('the success message reports what was recorded, and never counts twice', () => {
    expect(describeRecordedLedger({ transactionsCreated: 3, duplicatesSkipped: 0, excludedUnclassified: 0 })).toBe(' 3 statement line(s) were recorded in your figures.');
    expect(describeRecordedLedger({ transactionsCreated: 1, duplicatesSkipped: 2, excludedUnclassified: 1 }))
      .toBe(' 1 statement line(s) were recorded in your figures; 2 already recorded from an earlier statement were not counted twice; 1 unclassified line(s) are shown but not counted.');
    expect(describeRecordedLedger(null)).toBe('');
  });

  it('the panel sends the owner and the acknowledgement, offers Reject, hides "keep" without a liability, and posts the pick', () => {
    const panel = read('components/liabilities/LiabilityImportPanel.tsx');
    expect(panel).toMatch(/owner,\s*\n\s*\/\/ WP-11: the user accepted that unrecognised lines are not counted\.\s*\n\s*acknowledgeUnclassified,/);
    expect(panel).toContain("'reject_statement'] as Decision[])");
    expect(panel).toContain(".filter((d) => d !== 'keep_existing' || hasTarget)");
    expect(panel).toContain('/match-payment`');
    expect(panel).toContain("json.code === 'BLOCKING_REVIEW'");
    // The old PAYMENT-only review list is gone.
    expect(panel).not.toContain("activities.filter((a) => a.activity_type === 'PAYMENT').map(");
  });
});

const STATEMENT: HistoryStatementRow = {
  id: 's1', statement_type: 'loan', institution_name: 'Test Bank', masked_identifier: 'xx1234', statement_period_start: '2026-08-01', statement_period_end: '2026-08-31',
  currency_code: 'AUD', statement_date: '2026-08-31', due_date: '2026-09-15', opening_balance: null, closing_balance: null, opening_principal: 20000, closing_principal: 18450,
  interest_rate: 6.2, credit_limit: null, minimum_payment: null,
  totals: { purchases: null, cash_advances: null, refunds: null, payments: 2000, interest: 430, fees: 20, adjustments: null, drawdowns: 5000, capitalised: null, principal_repayments: 1550 },
  reconciliation_status: 'reconciled', ledger_status: 'applied', ledger_rejected_reason: null,
  extraction_warnings: [{ code: 'zero_amount', row: 4 }], can_record: false,
  activities: [
    { id: 'x1', activity_type: 'PAYMENT', activity_date: '2026-08-15', amount: 2000, currency_code: 'AUD', description_raw: 'REPAYMENT', gst_amount_raw: null, bank_match_status: 'matched', ledger_disposition: 'ledger_row',
      ledger: { transaction_id: 't1', credit_debit: 'credit', economic_transaction_type: 'debt_principal', amount: 2000, settlement_link_status: 'confirmed',
        allocations: [{ economic_transaction_type: 'debt_principal', amount: 1550 }, { economic_transaction_type: 'debt_interest', amount: 430 }, { economic_transaction_type: 'fee', amount: 20 }] } },
    { id: 'x2', activity_type: 'FEE', activity_date: '2026-08-02', amount: 9, currency_code: 'AUD', description_raw: 'ANNUAL FEE', gst_amount_raw: '0.82', bank_match_status: 'not_attempted', ledger_disposition: 'duplicate_of_existing', ledger: null },
  ],
};

describe('Statement history (G7): what each line BECAME, after Apply', () => {
  it('shows the split of a loan repayment, its bank settlement, duplicates, GST, warnings, totals and what is not read', () => {
    const html = render(React.createElement(StatementHistoryTable, { statement: STATEMENT }));
    expect(html).toContain('Principal (reduces what you owe): $1,550.00');
    expect(html).toContain('Interest (cost of debt): $430.00');
    expect(html).toContain('Fee (cost of debt): $20.00');
    expect(html).toContain('Matched to your bank payment');
    expect(html).toContain('Already recorded from an earlier statement — not counted twice');
    expect(html).toContain('GST shown on statement: 0.82');
    expect(html).toContain('A $0.00 line was left out (it moves no money). (row 4)');
    expect(html).toContain('Drawdowns (money borrowed — never income)');
    expect(html).toContain('$5,000.00');
    expect(html).toContain('6.2% p.a.');
    expect(html).toContain(NOT_READ_FROM_STATEMENTS.slice(0, 40));
  });

  it('a rejected statement says so, and nothing from it is presented as counted', () => {
    const html = render(React.createElement(StatementHistoryTable, { statement: { ...STATEMENT, ledger_status: 'rejected', activities: [{ ...STATEMENT.activities[1], ledger_disposition: 'rejected' }] } }));
    expect(html).toContain('You rejected this statement, so none of its lines are counted.');
    expect(html).toContain('Not counted — you rejected this statement');
  });
});

describe('apply route contract', () => {
  it('maps every refusal to an HTTP status (blockers are a 409 the panel handles, not a 400)', () => {
    expect(statusForLiabilityApplyError('BLOCKING_REVIEW')).toBe(409);
    expect(statusForLiabilityApplyError('ALREADY_APPLIED')).toBe(409);
    expect(statusForLiabilityApplyError('UNSUPPORTED_CURRENCY')).toBe(422);
    expect(statusForLiabilityApplyError('FOREIGN_TRANSACTION')).toBe(422);
    expect(statusForLiabilityApplyError('INVALID_OWNER')).toBe(422);
    expect(statusForLiabilityApplyError('PROPOSAL_NOT_FOUND')).toBe(404);
  });

  it('the RPC ledger JSON (snake_case) reaches the caller intact', () => {
    expect(toLedgerEffects({ transactions_created: 3, duplicates_skipped: 1, allocations_created: 3, links_created: 1, links_completed: 0, links_deferred: 0, bank_legs_reclassified: 1, excluded_unclassified: 0, financial_account_id: 'acc' }))
      .toEqual({ financialAccountId: 'acc', transactionsCreated: 3, duplicatesSkipped: 1, allocationsCreated: 3, linksCreated: 1, linksCompleted: 0, linksDeferred: 0, bankLegsReclassified: 1, excludedUnclassified: 0, skipped: null });
    expect(toLedgerEffects(null)).toBeNull();
  });

  it('the route no longer writes an audit event after the commit (G12: the RPC writes it with the document id)', () => {
    const route = read('app/api/financial-data-hub/liability-proposals/[proposalId]/apply/route.ts');
    expect(route).not.toContain('recordDocumentAuditEvent');
    const sql = read('supabase/migrations/0209_fdh10_liability_apply_ledger.sql');
    expect(sql).toContain("values (v_uid, v_statement.statement_upload_id,\n          case when p_decision = 'keep_existing' then 'liability_proposal_dismissed' else 'liability_proposal_applied' end");
  });
});
