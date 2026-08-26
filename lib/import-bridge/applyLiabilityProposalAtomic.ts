/**
 * FDH-10 — the REAL production apply path for Liability proposals.
 *
 * Mirrors `applyIncomeProposalAtomic.ts` exactly (see that file's header for
 * the full rationale — not repeated here). One network call to
 * `fdh10_apply_liability_proposal()` (migration 0096, Part I), the single
 * atomic SECURITY DEFINER RPC that does everything inside one Postgres
 * transaction. Correctness depends only on the RPC, not on this function's
 * control flow (spec section 53).
 */

import { createClient } from '@/lib/supabase/server';
import type { ApplyResult } from './applyService';
import type { ImportApplyErrorCode, PersistedApplyMode, UserApplyDecision } from './types';

export interface ApplyLiabilityProposalRequest {
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

export async function applyLiabilityProposalAtomic(request: ApplyLiabilityProposalRequest): Promise<ApplyResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh10_apply_liability_proposal', {
    p_proposal_id: request.proposalId,
    p_decision: request.decision,
    p_selected_fields: request.selectedFields && request.selectedFields.length > 0 ? request.selectedFields : null,
  });

  if (error) {
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
