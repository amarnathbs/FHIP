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

/** Approve a payroll event through `fdh9_approve_payroll_event()` — the one
 * legitimate path for `approval_status` (spec sections 10, 42). */
export async function approvePayrollEventAtomic(payrollEventId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh9_approve_payroll_event', { p_payroll_event_id: payrollEventId });
  if (error) return { ok: false, error: error.message };
  const result = data as { ok: boolean; error?: string };
  if (!result.ok) return { ok: false, error: result.error ?? 'Could not approve this payroll event.' };
  return { ok: true };
}
