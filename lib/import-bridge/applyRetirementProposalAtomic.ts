/**
 * FDH-12 — the REAL production apply path for Retirement proposals.
 *
 * Mirrors `applyLiabilityProposalAtomic.ts` exactly (see that file, and
 * `applyIncomeProposalAtomic.ts`'s header, for the full rationale — not
 * repeated here). One network call to `fdh12_apply_retirement_proposal()`
 * (migration 0111 PART I), the single atomic SECURITY DEFINER RPC that does
 * everything inside one Postgres transaction. Correctness depends only on the
 * RPC, not on this function's control flow (spec section 105).
 *
 * TWO RETIREMENT-SPECIFIC RESULT CODES the other domains do not have:
 *   * `SMSF_ACCOUNT_NOT_IMPORTABLE` — the target is a self-managed super fund,
 *     which the SMSF module owns (spec sections 10, 72). Surfaced with a
 *     routing message rather than a raw error.
 *   * `EVIDENCE_NOT_APPROVED` — the underlying statement has not been approved
 *     by the user. Spec section 56: approving evidence and applying it are
 *     different acts, and only the second may touch canonical Retirement.
 */

import { createClient } from '@/lib/supabase/server';
import type { ApplyResult } from './applyService';
import type { ImportApplyErrorCode, PersistedApplyMode, UserApplyDecision } from './types';

export interface ApplyRetirementProposalRequest {
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
  outcome?: 'applied' | 'kept_existing';
  apply_mode?: string;
  target_entity_id?: string;
  application_id?: string;
  applied_fields?: string[];
  field?: string;
  existing?: string | null;
  current?: string | null;
}

/** Retirement-specific refusals the generic `ImportApplyErrorCode` union does
 * not name. Surfaced to the caller as `WRITE_FAILED`-shaped failures carrying
 * their own message, exactly as the RPC returned them. */
export const RETIREMENT_APPLY_REFUSAL_CODES = [
  'SMSF_ACCOUNT_NOT_IMPORTABLE',
  'EVIDENCE_NOT_APPROVED',
] as const;
export type RetirementApplyRefusalCode = (typeof RETIREMENT_APPLY_REFUSAL_CODES)[number];

const GENERIC_CODES = new Set<string>([
  'PROPOSAL_NOT_FOUND', 'PROPOSAL_NOT_ACTIONABLE', 'STALE_PROPOSAL', 'TARGET_NOT_FOUND',
  'FORBIDDEN_FIELD', 'NO_FIELDS_SELECTED', 'INVALID_APPLY_MODE',
  'DOMAIN_VALIDATION_FAILED', 'ALREADY_APPLIED', 'WRITE_FAILED',
]);

export async function applyRetirementProposalAtomic(
  request: ApplyRetirementProposalRequest,
): Promise<ApplyResult & { refusalCode?: RetirementApplyRefusalCode }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh12_apply_retirement_proposal', {
    p_proposal_id: request.proposalId,
    p_decision: request.decision,
    p_selected_fields:
      request.selectedFields && request.selectedFields.length > 0 ? request.selectedFields : null,
  });

  if (error) {
    return { ok: false, code: 'WRITE_FAILED', error: error.message };
  }

  const result = data as RpcResponse;
  if (!result.ok) {
    const rawCode = result.code ?? 'WRITE_FAILED';
    const isRetirementRefusal = (RETIREMENT_APPLY_REFUSAL_CODES as readonly string[]).includes(rawCode);
    return {
      ok: false,
      code: (GENERIC_CODES.has(rawCode) ? rawCode : 'WRITE_FAILED') as ImportApplyErrorCode,
      error: result.error ?? 'The change could not be saved.',
      ...(isRetirementRefusal ? { refusalCode: rawCode as RetirementApplyRefusalCode } : {}),
      ...(rawCode === 'STALE_PROPOSAL'
        ? {
          staleness: {
            stale: true,
            changed: [{
              fieldName: result.field ?? '',
              snapshotValue: result.existing ?? null,
              currentValue: result.current ?? null,
              proposedValue: null,
            }],
          },
        }
        : {}),
    };
  }

  if (result.outcome === 'kept_existing') {
    return {
      ok: true, outcome: 'kept_existing', applyMode: null,
      targetEntityId: null, applicationId: null, appliedFields: [],
    };
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

/**
 * FDH-12's analogue of `approveLiabilityStatementAtomic` — the one legitimate
 * way to move a retirement statement's `approval_status` to 'approved'
 * (migration 0111 PART H's `fdh12_approve_retirement_statement()`).
 *
 * CANONICAL RETIREMENT IS UNTOUCHED BY THIS CALL (spec section 56). It moves
 * the statement's own approval state and nothing else — which is the whole
 * distinction between approving evidence and applying it.
 */
export async function approveRetirementStatementAtomic(
  statementId: string,
): Promise<{ ok: true; code: string } | { ok: false; code: string; error: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh12_approve_retirement_statement', {
    p_statement_id: statementId,
  });
  if (error) return { ok: false, code: 'WRITE_FAILED', error: error.message };
  const result = data as { ok: boolean; code?: string; error?: string };
  if (!result.ok) {
    return {
      ok: false,
      code: result.code ?? 'WRITE_FAILED',
      error: result.error ?? 'Could not approve this statement.',
    };
  }
  return { ok: true, code: result.code ?? 'APPROVED' };
}
