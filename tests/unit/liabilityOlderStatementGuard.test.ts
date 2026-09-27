/**
 * Economic-oracle certification (2026-09-27), reproduced live on DEV: after an
 * AUGUST loan statement (closing 398,450) was applied, the JULY statement's
 * proposal RECOMMENDED -- and the Liabilities panel PRE-TICKED -- overwriting
 * the balance with July's 400,000 (and a card's due date with an older one).
 * Applying it with the panel defaults regressed the canonical liability.
 *
 * The liability sibling of retirement's GAP-RET-06 guard: an older statement's
 * point-in-time figures are offered but never recommended, always need an
 * explicit tick (the 0209 RPC only auto-applies recommended, confirmation-free
 * fields), and the recommended decision is keep_existing (its lines are still
 * recorded in the ledger -- 0209 G10).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => { throw new Error('not used'); } }));

import { liabilityAdapter, LIABILITY_POINT_IN_TIME_FIELDS, type ExistingLiabilityRow, type LiabilityEvidence } from '@/lib/import-bridge/adapters/liabilityAdapter';
import { loadAppliedAsOfByLiability } from '@/lib/import-bridge/liabilityProposalService';
import { makeFakeSupabase } from './readModels/helpers/fakeSupabase';

const LOAN: ExistingLiabilityRow = {
  id: 'L1', liability_name: 'Home Loan — FHIP Test Home Loan', debt_type: 'mortgage', balance: 398450, interest_rate: 6.14,
  monthly_repayment: 2000, currency_code: 'AUD', country_code: 'AU', lender: 'FHIP Test Home Loan', credit_limit: null,
  masked_identifier: 'xxxx5602', minimum_payment: null, due_date: '2026-09-15', updated_at: '2026-09-27T00:00:00Z',
};

const julyEvidence = (applied: Record<string, string> | undefined, end: string | null = '2026-07-31'): LiabilityEvidence => { const periodEnd = end ?? undefined; return {
  statementId: 'S-jul', facilityType: 'home_loan', institutionName: 'FHIP Test Home Loan', maskedIdentifier: 'xxxx5602', currencyCode: 'AUD',
  countryCode: 'AU', closingPrincipal: 400000, interestRate: 6.14, monthlyRepaymentAmount: 0, dueDate: '2026-08-15',
  statementPeriodEnd: periodEnd, statementDate: periodEnd, appliedAsOfByLiability: applied, reviewReasons: [],
}; };

const f = (draft: ReturnType<typeof liabilityAdapter.buildProposal>, name: string) => draft.fields.find((x) => x.fieldName === name)!;
const panelDefault = (draft: ReturnType<typeof liabilityAdapter.buildProposal>) =>
  draft.fields.filter((x) => x.isRecommended && !x.requiresConfirmation && x.proposedValue !== x.existingValue).map((x) => x.fieldName);

describe('liability proposal: an OLDER statement never regresses figures a newer one set', () => {
  it('July after August: balance / due date offered but NOT recommended, confirmation required, decision keep_existing', () => {
    const draft = liabilityAdapter.buildProposal(julyEvidence({ L1: '2026-08-31' }), [LOAN]);
    expect(draft.targetEntityId).toBe('L1');
    expect(f(draft, 'balance')).toMatchObject({ proposedValue: '400000.00', existingValue: '398450.00', isRecommended: false, requiresConfirmation: true, reasonCode: 'statement_older_than_last_applied' });
    expect(f(draft, 'due_date')).toMatchObject({ isRecommended: false, requiresConfirmation: true });
    expect(f(draft, 'interest_rate')).toMatchObject({ isRecommended: false, requiresConfirmation: true });
    expect(panelDefault(draft)).toEqual([]);
    expect(draft.recommendedApplyMode).toBe('keep_existing');
    expect(draft.summary.reviewReasons).toContain('statement_is_older_than_one_already_applied_figures_not_recommended');
  });

  it('identity fields (lender, masked identifier) are unaffected by the age gate', () => {
    const draft = liabilityAdapter.buildProposal(julyEvidence({ L1: '2026-08-31' }), [LOAN]);
    expect(f(draft, 'lender').isRecommended).toBe(true);
    expect(LIABILITY_POINT_IN_TIME_FIELDS).not.toContain('lender');
  });

  it('negative controls: a NEWER statement, or none applied yet, is recommended exactly as before', () => {
    const newer = liabilityAdapter.buildProposal(julyEvidence({ L1: '2026-06-30' }), [LOAN]);
    expect(f(newer, 'balance')).toMatchObject({ isRecommended: true, requiresConfirmation: false, reasonCode: 'statement_closing_principal' });
    expect(newer.recommendedApplyMode).toBe('update_existing');
    expect(panelDefault(newer)).toContain('balance');
    const first = liabilityAdapter.buildProposal(julyEvidence(undefined), [LOAN]);
    expect(f(first, 'balance').isRecommended).toBe(true);
  });

  it('a statement with NO date against an already-applied liability is not recommended either', () => {
    const draft = liabilityAdapter.buildProposal(julyEvidence({ L1: '2026-08-31' }, null), [LOAN]);
    expect(f(draft, 'balance').isRecommended).toBe(false);
    expect(draft.summary.reviewReasons).toContain('statement_date_unknown_a_statement_is_already_applied_figures_not_recommended');
  });

  it('a NEW liability (no target) is never gated', () => {
    const draft = liabilityAdapter.buildProposal(julyEvidence({ L1: '2026-08-31' }), []);
    expect(draft.recommendedApplyMode).toBe('add_new');
    expect(f(draft, 'balance').isRecommended).toBe(true);
  });
});

describe('loadAppliedAsOfByLiability: read from the application ledger', () => {
  const user = 'u1';
  const tables = {
    fhip_import_applications: [
      { user_id: user, target_domain: 'liability', target_entity_id: 'L1', source_liability_statement_id: 'S-aug', applied_fields: ['balance'] },
      { user_id: user, target_domain: 'liability', target_entity_id: 'L1', source_liability_statement_id: 'S-jun', applied_fields: ['balance'] },
      // keep_existing wrote no figure: it never counts as "applied"
      { user_id: user, target_domain: 'liability', target_entity_id: 'L1', source_liability_statement_id: 'S-sep', applied_fields: [] },
      { user_id: user, target_domain: 'liability', target_entity_id: 'L2', source_liability_statement_id: 'S-cur', applied_fields: ['balance'] },
      { user_id: 'other', target_domain: 'liability', target_entity_id: 'LX', source_liability_statement_id: 'S-x', applied_fields: ['balance'] },
    ],
    fdh_liability_statements: [
      { id: 'S-aug', user_id: user, statement_period_end: '2026-08-31', statement_date: '2026-08-31' },
      { id: 'S-jun', user_id: user, statement_period_end: null, statement_date: '2026-06-30' },
      { id: 'S-sep', user_id: user, statement_period_end: '2026-09-30', statement_date: null },
      { id: 'S-cur', user_id: user, statement_period_end: '2026-10-31', statement_date: null },
      { id: 'S-x', user_id: 'other', statement_period_end: '2027-01-31', statement_date: null },
    ],
  };
  it('takes the latest statement per liability that actually applied a figure, excluding the current statement and other users', async () => {
    const { client } = makeFakeSupabase(tables);
    const out = await loadAppliedAsOfByLiability(client as never, user, 'S-cur');
    expect(out).toEqual({ L1: '2026-08-31' });
  });
});
