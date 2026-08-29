/**
 * FHIP Input Data Import Bridge — Liability proposal generation (FDH-10,
 * spec sections 6, 19-20, 41, 50-58).
 *
 * Direct liability analogue of `incomeProposalService.ts` (see that file's
 * header for the shared rationale — not repeated here). This is the ONLY
 * place that turns an approved credit-card/loan STATEMENT (evidence, in
 * `fdh_liability_statements`) into an inert Liability PROPOSAL. It performs
 * no Liability mutation of any kind — it reads the statement, reads the
 * user's existing Liabilities, asks `liabilityAdapter.buildProposal()` for a
 * draft, and persists it via `persistLiabilityProposal()`. Nothing here calls
 * `fdh10_apply_liability_proposal` or writes to `liabilities` (spec section
 * 21's "upload/parse/review/approve-evidence/proposal-generation/compare must
 * all leave the canonical Liability unchanged").
 *
 * GATED ON APPROVAL, exactly like income (spec section 4's journey applied to
 * Liabilities per spec section 22's "...Approve evidence -> Liability
 * proposal..."). A proposal is only generated for a statement whose
 * `approval_status` is `'approved'`.
 */

import { createClient } from '@/lib/supabase/server';
import { liabilityAdapter, type ExistingLiabilityRow, type LiabilityEvidence, type LiabilityFacilityType } from './adapters/liabilityAdapter';
import { persistLiabilityProposal } from './supabaseStore';

export class LiabilityProposalError extends Error {
  constructor(readonly code: 'not_found' | 'not_approved' | 'internal_error', message: string) {
    super(message);
    this.name = 'LiabilityProposalError';
  }
}

interface LiabilityStatementRow {
  id: string;
  user_id: string;
  statement_upload_id: string | null;
  statement_type: 'credit_card' | 'loan';
  facility_type: LiabilityFacilityType;
  country_code: string | null;
  currency_code: string;
  institution_name: string | null;
  masked_identifier: string | null;
  due_date: string | null;
  closing_balance: number | null;
  closing_principal: number | null;
  interest_rate: number | null;
  credit_limit: number | null;
  minimum_payment: number | null;
  payments_total: number | null;
  repayment_frequency: string | null;
  reconciliation_status: string;
  approval_status: string;
}

/** Builds the generic bridge's `LiabilityEvidence` from one statement row. */
function toLiabilityEvidence(statement: LiabilityStatementRow): LiabilityEvidence {
  const reviewReasons: string[] = [];
  if (statement.reconciliation_status === 'variance') reviewReasons.push('statement_reconciliation_variance');
  if (statement.reconciliation_status === 'insufficient_data') reviewReasons.push('statement_reconciliation_insufficient_data');

  const isCreditCard = statement.statement_type === 'credit_card';
  // A loan's "regular repayment" is not a distinct stored column on the
  // statement (spec section 34: only statement-DISCLOSED figures are ever
  // proposed) — the statement's own disclosed PAYMENTS total for the period
  // is the best evidence of it. Flagged for confirmation whenever the
  // statement does not positively state the frequency is monthly, so the
  // review UI never implies more certainty than the evidence supports.
  const monthlyRepaymentAmount = !isCreditCard && statement.payments_total !== null ? statement.payments_total : undefined;
  if (monthlyRepaymentAmount !== undefined && statement.repayment_frequency !== 'monthly') {
    reviewReasons.push('repayment_amount_reflects_this_statement_period_only');
  }

  return {
    statementId: statement.id,
    facilityType: statement.facility_type,
    institutionName: statement.institution_name ?? undefined,
    maskedIdentifier: statement.masked_identifier ?? undefined,
    currencyCode: statement.currency_code,
    countryCode: statement.country_code ?? undefined,
    closingBalance: isCreditCard ? (statement.closing_balance ?? undefined) : undefined,
    closingPrincipal: !isCreditCard ? (statement.closing_principal ?? undefined) : undefined,
    interestRate: statement.interest_rate ?? undefined,
    minimumPayment: isCreditCard ? (statement.minimum_payment ?? undefined) : undefined,
    monthlyRepaymentAmount,
    creditLimit: isCreditCard ? (statement.credit_limit ?? undefined) : undefined,
    dueDate: statement.due_date ?? undefined,
    reviewReasons,
  };
}

/**
 * Generate (or regenerate) the Liability proposal for one approved
 * credit-card/loan statement. Regenerating supersedes any earlier 'ready'
 * proposal for the same statement (see `persistLiabilityProposal`'s own
 * header) so at most one proposal is ever live/applicable per statement.
 */
export async function generateLiabilityProposal(
  userId: string,
  statementId: string,
): Promise<{ proposalId: string; statementUploadId: string | null; recommendedApplyMode: string }> {
  const supabase = await createClient();

  const { data: statement, error } = await supabase
    .from('fdh_liability_statements')
    .select(
      'id, user_id, statement_upload_id, statement_type, facility_type, country_code, currency_code, institution_name, masked_identifier, due_date, closing_balance, closing_principal, interest_rate, credit_limit, minimum_payment, payments_total, repayment_frequency, reconciliation_status, approval_status',
    )
    .eq('id', statementId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !statement) throw new LiabilityProposalError('not_found', 'That statement could not be found.');
  const row = statement as LiabilityStatementRow;
  if (row.approval_status !== 'approved') {
    throw new LiabilityProposalError('not_approved', 'Approve this statement evidence before generating a Liability proposal.');
  }

  const { data: existingRows } = await supabase
    .from('liabilities')
    .select('id, liability_name, debt_type, balance, interest_rate, monthly_repayment, currency_code, country_code, lender, credit_limit, masked_identifier, minimum_payment, due_date, updated_at')
    .eq('user_id', userId)
    .eq('is_active', true);

  const evidence = toLiabilityEvidence(row);
  const draft = liabilityAdapter.buildProposal(evidence, (existingRows ?? []) as ExistingLiabilityRow[]);
  const proposalId = await persistLiabilityProposal(userId, draft, statementId);

  // The FDH document-audit-event write ('liability_proposal_generated') is
  // deliberately NOT done here — same discipline as `incomeProposalService
  // .ts`'s own note: it lives in the API route caller, which already sits
  // inside the one approved FDH consumer surface.
  return { proposalId, statementUploadId: row.statement_upload_id, recommendedApplyMode: draft.recommendedApplyMode };
}

/** Read-model for the compare screen. No write. */
export async function getLiabilityProposalForReview(userId: string, proposalId: string) {
  const supabase = await createClient();
  const { data: proposal, error } = await supabase
    .from('fhip_import_proposals')
    .select('id, target_domain, source_kind, source_liability_statement_id, target_entity_id, recommended_apply_mode, duplicate_of_entity_id, status, currency_code, generated_at')
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

/** All 'ready' proposals awaiting a decision, for a future "you have a
 * statement proposal to review" banner (mirrors `listReadyIncomeProposals`). */
export async function listReadyLiabilityProposals(userId: string) {
  const supabase = await createClient();
  const { data } = await supabase
    .from('fhip_import_proposals')
    .select('id, source_liability_statement_id, recommended_apply_mode, generated_at')
    .eq('user_id', userId)
    .eq('target_domain', 'liability')
    .eq('status', 'ready')
    .order('generated_at', { ascending: false });
  return data ?? [];
}
