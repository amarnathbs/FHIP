/**
 * FDH-9 — the REAL production apply path for Income proposals.
 *
 * `applyService.ts`'s `applyImportProposal()` remains in the tree as the
 * certified, database-free guard-logic module (see its own header and
 * `tests/unit/fdh9IncomeBridge.test.ts`) — useful for fast, friendly
 * client-side/pre-flight validation and for exercising adversarial inputs
 * without a database. It is NOT, on its own, the security boundary: it
 * orchestrates several separate Supabase calls (claim, mutate, record,
 * stamp), which is exactly the non-atomic shape the disclosed defect
 * exploited.
 *
 * THIS function is what any future route must call to actually change
 * Income. It performs no multi-step orchestration at all — it makes ONE
 * network call to `fdh9_apply_income_proposal()` (migration 0091, Part D),
 * the single atomic SECURITY DEFINER RPC that does everything (ownership,
 * staleness, allow-list, the Income mutation, the application audit insert,
 * and the proposal's applied transition) inside one Postgres transaction.
 * Correctness here does not depend on this function's own control flow —
 * only on the RPC, per spec section 41.
 */

import { createClient } from '@/lib/supabase/server';
import type { ApplyResult } from './applyService';
import type { ImportApplyErrorCode, PersistedApplyMode, UserApplyDecision } from './types';

export interface ApplyIncomeProposalRequest {
  proposalId: string;
  decision: UserApplyDecision;
  /** Ignored for `keep_existing`. Omit (or leave empty) for `update_existing`
   * to mean "every field the proposal contains". */
  selectedFields?: string[];
}

interface RpcResponse {
  ok: boolean;
  code?: string;
  error?: string;
  outcome?: 'applied' | 'kept_existing' | 'already_approved' | 'approved';
  apply_mode?: string;
  target_entity_id?: string;
  application_id?: string;
  applied_fields?: string[];
  field?: string;
  existing?: string | null;
  current?: string | null;
  proposal_currency?: string | null;
  target_currency?: string | null;
}

/**
 * Apply (or decline) an Income import proposal through the atomic database
 * RPC. Returns the SAME `ApplyResult` shape `applyImportProposal()` returns,
 * so calling code and error handling are identical regardless of which path
 * is wired in.
 */
export async function applyIncomeProposalAtomic(request: ApplyIncomeProposalRequest): Promise<ApplyResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh9_apply_income_proposal', {
    p_proposal_id: request.proposalId,
    p_decision: request.decision,
    p_selected_fields: request.selectedFields && request.selectedFields.length > 0 ? request.selectedFields : null,
  });

  if (error) {
    // A raised exception (auth required, or a genuinely unexpected DB error —
    // e.g. a check-constraint violation, or the forced mid-operation failure
    // negative control) surfaces here. The transaction has already been
    // rolled back in full by Postgres itself before this response exists.
    return { ok: false, code: 'WRITE_FAILED', error: error.message };
  }

  const result = data as RpcResponse;
  if (!result.ok) {
    return {
      ok: false,
      code: (result.code as ImportApplyErrorCode | undefined) ?? 'WRITE_FAILED',
      error: result.error ?? 'The change could not be saved.',
      ...(result.code === 'STALE_PROPOSAL'
        ? { staleness: { stale: true, changed: [{ fieldName: result.field ?? '', snapshotValue: result.existing ?? null, currentValue: result.current ?? null, proposedValue: null }] } }
        : {}),
      // WP-09 (0210): ALREADY_APPLIED at the payroll-EVENT level names the
      // Income row the payslip is already in, so the UI can point at it.
      ...(result.code === 'ALREADY_APPLIED' && result.target_entity_id
        ? { details: { targetEntityId: result.target_entity_id, applicationId: result.application_id ?? null } }
        : {}),
      ...(result.code === 'CURRENCY_MISMATCH'
        ? { details: { proposalCurrency: result.proposal_currency ?? null, targetCurrency: result.target_currency ?? null } }
        : {}),
    };
  }

  if (result.outcome === 'kept_existing') {
    return { ok: true, outcome: 'kept_existing', applyMode: null, targetEntityId: null, applicationId: null, appliedFields: [] };
  }

  return {
    ok: true,
    outcome: 'applied',
    applyMode: (result.apply_mode as PersistedApplyMode | undefined) ?? null,
    targetEntityId: result.target_entity_id ?? null,
    applicationId: result.application_id ?? null,
    appliedFields: result.applied_fields ?? [],
  };
}

export type PayslipIncomeOwner = 'self' | 'spouse';

export interface ApprovePayrollEventOptions {
  /** Whose payslip this is (GAP-05). Fixed at approval; decides which
   * household member's Income row the payslip may create or update. */
  incomeOwner?: PayslipIncomeOwner;
  /** The user has looked at the figures the payslip flagged for review. */
  acknowledgeReview?: boolean;
}

export type ApprovePayrollEventResult =
  | { ok: true; incomeOwner: PayslipIncomeOwner; alreadyApproved: boolean }
  | { ok: false; code: string; error: string };

/** PostgREST's "no function with these arguments" -- 0210 not applied yet. */
function isMissingFunction(error: { code?: string; message?: string } | null): boolean {
  return Boolean(error && (error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '')));
}

/**
 * Approve a payroll event through `fdh9_approve_payroll_event()` — the one
 * legitimate path for `approval_status` (spec sections 10, 42). Since 0210 it
 * also records whose payslip it is and requires a flagged review to be
 * acknowledged.
 *
 * Before 0210 is applied the three-argument RPC does not exist. A SELF
 * approval then falls back to the one-argument function (exactly the old
 * behaviour; the route has already enforced the review acknowledgement). A
 * SPOUSE approval cannot be represented without 0210, so it is refused rather
 * than silently recorded as the user's own income.
 */
export async function approvePayrollEventAtomic(
  payrollEventId: string,
  options: ApprovePayrollEventOptions = {},
): Promise<ApprovePayrollEventResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh9_approve_payroll_event', {
    p_payroll_event_id: payrollEventId,
    p_income_owner: options.incomeOwner ?? null,
    p_acknowledge_review: Boolean(options.acknowledgeReview),
  });
  type Response = { ok: boolean; code?: string; error?: string; outcome?: string; income_owner?: string } | null;
  let response = data as Response;
  if (error && isMissingFunction(error)) {
    if (options.incomeOwner === 'spouse') {
      return { ok: false, code: 'MIGRATION_PENDING', error: "Recording a spouse's payslip needs a database update that has not been applied yet. Please try again later." };
    }
    const legacy = await supabase.rpc('fdh9_approve_payroll_event', { p_payroll_event_id: payrollEventId });
    if (legacy.error) return { ok: false, code: 'WRITE_FAILED', error: legacy.error.message };
    response = legacy.data as Response;
  } else if (error) {
    return { ok: false, code: 'WRITE_FAILED', error: error.message };
  }
  if (!response?.ok) {
    return { ok: false, code: response?.code ?? 'WRITE_FAILED', error: response?.error ?? 'Could not approve this payroll event.' };
  }
  return {
    ok: true,
    incomeOwner: response.income_owner === 'spouse' ? 'spouse' : 'self',
    alreadyApproved: response.outcome === 'already_approved',
  };
}
