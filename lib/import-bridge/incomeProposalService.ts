/**
 * FHIP Input Data Import Bridge — Income proposal generation (spec sections
 * 4, 21, 29, 36-37).
 *
 * This is the ONLY place that turns approved payroll EVIDENCE into an inert
 * Income PROPOSAL. It performs no Income mutation of any kind — it reads the
 * payroll event, reads the user's existing Income sources, asks
 * `incomeAdapter.buildProposal()` for a draft, and persists it via
 * `persistProposal()`. Nothing here calls `fdh9_apply_income_proposal` or
 * writes to `income_sources` (spec section 4's "generating a proposal does
 * not change Income").
 *
 * GATED ON APPROVAL (spec section 4's journey: "...Approve payroll evidence
 * -> Generate Income proposal..."). A proposal is only generated for a
 * payroll event whose `approval_status` is `'approved'` — the one legitimate
 * way to reach that state is `fdh9_approve_payroll_event()`
 * (`applyIncomeProposalAtomic.ts`'s `approvePayrollEventAtomic`).
 */

import { createClient } from '@/lib/supabase/server';
import { incomeAdapter, type ExistingIncomeRow, type IncomeEvidence } from './adapters/incomeAdapter';
import { persistProposal } from './supabaseStore';

/**
 * A deliberate, tiny DUPLICATE of `lib/financial-data-hub/payslip/frequency
 * .ts`'s `toCanonicalIncomeFrequency()`, not an import of it.
 * `tests/unit/fdh1Isolation.test.ts` mechanically forbids any file outside
 * `lib/financial-data-hub/` (other than the two already-named, hand-verified
 * exceptions) from importing that tree — see this file's own note at the call
 * site below and `FDH9_REUSE_AND_GAP_AUDIT.md` for the full rationale. The
 * function is six lines and has no dependency of its own, so duplicating it
 * here preserves the isolation boundary at essentially zero cost; a change to
 * the canonical Income frequency vocabulary would need to update both
 * (unlikely — the six-value enum is fixed by the `income_sources.frequency`
 * check constraint).
 */
function canonicalIncomeFrequencyFor(payFrequency: string): string | null {
  switch (payFrequency) {
    case 'weekly': return 'weekly';
    case 'fortnightly': return 'fortnightly';
    case 'monthly': return 'monthly';
    case 'quarterly': return 'quarterly';
    case 'annual': return 'annually';
    default: return null; // semimonthly / irregular / unknown have no canonical equivalent
  }
}

export class IncomeProposalError extends Error {
  constructor(readonly code: 'not_found' | 'not_approved' | 'internal_error', message: string) {
    super(message);
    this.name = 'IncomeProposalError';
  }
}

interface PayrollEventRow {
  id: string;
  user_id: string;
  statement_upload_id: string | null;
  employer_name: string | null;
  currency_code: string;
  pay_frequency: string;
  pay_frequency_source: string;
  gross_pay: number | null;
  net_pay: number | null;
  bonus_pay: number | null;
  overtime_pay: number | null;
  commission_pay: number | null;
  other_earnings: number | null;
  reimbursements_total: number | null;
  reconciliation_status: string;
  bank_match_status: 'matched' | 'no_match' | 'multiple_candidates' | 'not_attempted';
  approval_status: string;
}

/** Builds the generic bridge's `IncomeEvidence` from one payroll event row.
 * See `incomeAdapter.ts`'s own header for the four financial-correctness
 * rules this shape exists to enforce (gross-never-net, variable-pay-excluded,
 * reimbursements-are-not-income, employer-contributions-are-not-cash-income). */
function toIncomeEvidence(event: PayrollEventRow): IncomeEvidence {
  const reviewReasons: string[] = [];
  if (event.reconciliation_status === 'variance') reviewReasons.push('gross_to_net_variance');
  if (event.reconciliation_status === 'insufficient_data') reviewReasons.push('gross_to_net_insufficient_data');

  return {
    payrollEventId: event.id,
    employerName: event.employer_name ?? undefined,
    currencyCode: event.currency_code,
    canonicalFrequency: canonicalIncomeFrequencyFor(event.pay_frequency),
    frequencyStated: event.pay_frequency_source === 'stated_on_payslip',
    grossPay: event.gross_pay ?? undefined,
    netPay: event.net_pay ?? undefined,
    bonusPay: event.bonus_pay ?? undefined,
    overtimePay: event.overtime_pay ?? undefined,
    commissionPay: event.commission_pay ?? undefined,
    arrearsPay: event.other_earnings ?? undefined,
    reimbursementsTotal: event.reimbursements_total ?? undefined,
    // Conservative default (spec section 38: "reimbursements are not
    // income"): a payslip's own stated gross is treated as ALREADY including
    // any reimbursement line whenever one is present, so it is always
    // subtracted out of the recurring-gross proposal rather than risking
    // silently inflating income. See FDH9_FINANCIAL_INTEGRITY_CERTIFICATION.md.
    reimbursementsIncludedInGross: (event.reimbursements_total ?? 0) > 0,
    reviewReasons,
    bankMatchStatus: event.bank_match_status,
  };
}

/**
 * Generate (or regenerate) the Income proposal for one approved payroll
 * event. Regenerating supersedes any earlier 'ready' proposal for the same
 * event (see `persistProposal`'s own header) so at most one proposal is ever
 * live/applicable per payroll event at a time.
 */
export async function generateIncomeProposal(
  userId: string,
  payrollEventId: string,
): Promise<{ proposalId: string; statementUploadId: string | null; recommendedApplyMode: string }> {
  const supabase = await createClient();

  const { data: event, error } = await supabase
    .from('fdh_payroll_events')
    .select(
      'id, user_id, statement_upload_id, employer_name, currency_code, pay_frequency, pay_frequency_source, gross_pay, net_pay, bonus_pay, overtime_pay, commission_pay, other_earnings, reimbursements_total, reconciliation_status, bank_match_status, approval_status',
    )
    .eq('id', payrollEventId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !event) throw new IncomeProposalError('not_found', 'That payroll event could not be found.');
  const row = event as PayrollEventRow;
  if (row.approval_status !== 'approved') {
    throw new IncomeProposalError('not_approved', 'Approve this payroll evidence before generating an Income proposal.');
  }

  const { data: existingRows } = await supabase
    .from('income_sources')
    .select('id, source_name, income_type, amount, net_amount, frequency, currency_code, owner, is_taxable, employer_name, notes, master_item_key, source_type, updated_at')
    .eq('user_id', userId)
    .eq('is_active', true);

  const evidence = toIncomeEvidence(row);
  const draft = incomeAdapter.buildProposal(evidence, (existingRows ?? []) as ExistingIncomeRow[]);
  const proposalId = await persistProposal(userId, draft, payrollEventId);

  // The FDH document-audit-event write ('income_proposal_generated') is
  // deliberately NOT done here — it lives in the API route caller
  // (app/api/financial-data-hub/payslip/[documentId]/proposal/route.ts),
  // which already sits inside the one approved FDH consumer surface, so this
  // generic bridge module never needs to import anything from
  // `lib/financial-data-hub/` (see `canonicalIncomeFrequencyFor` above for
  // the same discipline applied to frequency mapping).
  return { proposalId, statementUploadId: row.statement_upload_id, recommendedApplyMode: draft.recommendedApplyMode };
}

/** Read-model for the compare screen (spec sections 37-38). No write. */
export async function getIncomeProposalForReview(userId: string, proposalId: string) {
  const supabase = await createClient();
  const { data: proposal, error } = await supabase
    .from('fhip_import_proposals')
    .select('id, target_domain, source_kind, source_payroll_event_id, target_entity_id, recommended_apply_mode, duplicate_of_entity_id, status, currency_code, generated_at')
    .eq('id', proposalId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !proposal) return null;

  const { data: fields } = await supabase
    .from('fhip_import_proposal_fields')
    .select('field_name, value_kind, proposed_value, existing_value, is_recommended, requires_confirmation, confidence, reason_code')
    .eq('proposal_id', proposalId)
    .eq('user_id', userId);

  return { proposal, fields: fields ?? [] };
}

/** All 'ready' proposals awaiting a decision, for the Income tab's
 * "you have a payslip proposal to review" banner. */
export async function listReadyIncomeProposals(userId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from('fhip_import_proposals')
    .select('id, source_payroll_event_id, recommended_apply_mode, generated_at')
    .eq('user_id', userId)
    .eq('target_domain', 'income')
    .eq('status', 'ready')
    .order('generated_at', { ascending: false });
  return data ?? [];
}
