/**
 * FDH-10 — the REAL production apply path for Liability proposals.
 *
 * One network call to `fdh10_apply_liability_proposal()` (migration 0096,
 * Part I; extended by migration 0209), the single atomic SECURITY DEFINER RPC
 * that does everything inside one Postgres transaction. Correctness depends
 * only on the RPC, not on this function's control flow (spec section 53).
 *
 * WP-11 (0209): the same RPC now also writes the statement's activities to
 * the canonical ledger (fdh_transactions + allocations + confirmed settlement
 * links), in the same transaction as the liability update, and returns what
 * it wrote (`ledger`). It accepts the owner of the card/loan (G8), an
 * acknowledgement that unclassified lines are recorded as not counted, and a
 * 'reject_statement' decision (G10).
 */

import { createClient } from '@/lib/supabase/server';
import type { ImportApplyErrorCode, PersistedApplyMode, UserApplyDecision } from './types';

/** The decisions the liability Apply accepts: the shared four plus reject. */
export const LIABILITY_APPLY_DECISIONS = ['add_new', 'update_existing', 'apply_selected_fields', 'keep_existing', 'reject_statement'] as const;
export type LiabilityApplyDecision = UserApplyDecision | 'reject_statement';

/** Whose card or loan this is (PO D-10; fdh_financial_accounts.owner_role). */
export const LIABILITY_IMPORT_OWNERS = ['self', 'spouse', 'joint', 'smsf'] as const;
export type LiabilityImportOwner = (typeof LIABILITY_IMPORT_OWNERS)[number];

export type LiabilityApplyErrorCode =
  | ImportApplyErrorCode
  | 'BLOCKING_REVIEW'
  | 'FOREIGN_TRANSACTION'
  | 'UNSUPPORTED_CURRENCY'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_OWNER';

/** The HTTP status the apply route answers with for each refusal (route contract test). */
export function statusForLiabilityApplyError(code: LiabilityApplyErrorCode): number {
  switch (code) {
    case 'PROPOSAL_NOT_FOUND':
      return 404;
    case 'STALE_PROPOSAL':
    case 'ALREADY_APPLIED':
    case 'BLOCKING_REVIEW':
      return 409;
    case 'NO_FIELDS_SELECTED':
    case 'FORBIDDEN_FIELD':
    case 'INVALID_APPLY_MODE':
    case 'DOMAIN_VALIDATION_FAILED':
    case 'UNSUPPORTED_CURRENCY':
    case 'CURRENCY_MISMATCH':
    case 'INVALID_OWNER':
    case 'FOREIGN_TRANSACTION':
      return 422;
    default:
      return 400;
  }
}

export interface LiabilityApplyRequest {
  proposalId: string;
  decision: LiabilityApplyDecision;
  /** Ignored for `keep_existing` / `reject_statement`. Omit (or leave empty)
   * for `update_existing` to mean "the proposal's recommended changes" (never
   * a field that needs the user's confirmation -- X-01). */
  selectedFields?: string[];
  owner?: LiabilityImportOwner;
  /** The user saw the ADJUSTMENT / OTHER lines and accepts that they are
   * recorded as NOT counted. Without it such a statement is BLOCKING_REVIEW. */
  acknowledgeUnclassified?: boolean;
}

/** What the ledger phase wrote (fhip_import_applications.ledger_effects). */
export interface LiabilityLedgerEffects {
  financialAccountId: string | null;
  transactionsCreated: number;
  duplicatesSkipped: number;
  allocationsCreated: number;
  linksCreated: number;
  linksCompleted: number;
  linksDeferred: number;
  bankLegsReclassified: number;
  excludedUnclassified: number;
  /** Set when the statement's activities were already recorded (or rejected). */
  skipped: string | null;
}

export interface LiabilityApplyBlocker {
  activityId: string;
  activityType: string;
  reason: 'unclassified_line' | 'multiple_bank_candidates' | 'component_mismatch' | 'foreign_transaction' | 'bank_match_invalid' | string;
}

export type LiabilityApplyResult =
  | {
      ok: true;
      outcome: 'applied' | 'kept_existing' | 'rejected_statement';
      applyMode: PersistedApplyMode | null;
      targetEntityId: string | null;
      applicationId: string | null;
      appliedFields: string[];
      ledger: LiabilityLedgerEffects | null;
      activitiesRejected: number;
    }
  | {
      ok: false;
      code: LiabilityApplyErrorCode;
      error: string;
      staleness?: { stale: true; changed: { fieldName: string; snapshotValue: string | null; currentValue: string | null; proposedValue: null }[] };
      blockers?: LiabilityApplyBlocker[];
    };

interface RpcLedger {
  financial_account_id?: string | null;
  transactions_created?: number;
  duplicates_skipped?: number;
  allocations_created?: number;
  links_created?: number;
  links_completed?: number;
  links_deferred?: number;
  bank_legs_reclassified?: number;
  excluded_unclassified?: number;
  skipped?: string;
}

interface RpcResponse {
  ok: boolean;
  code?: string;
  error?: string;
  outcome?: 'applied' | 'kept_existing' | 'rejected_statement';
  apply_mode?: string;
  target_entity_id?: string;
  application_id?: string;
  applied_fields?: string[];
  field?: string;
  existing?: string | null;
  current?: string | null;
  ledger?: RpcLedger | null;
  activities_rejected?: number;
  blockers?: Array<{ activity_id: string; activity_type: string; reason: string }>;
}

/** snake_case RPC ledger JSON -> the camelCase shape callers use. Exported for its contract test. */
export function toLedgerEffects(raw: RpcLedger | null | undefined): LiabilityLedgerEffects | null {
  if (!raw) return null;
  return {
    financialAccountId: raw.financial_account_id ?? null,
    transactionsCreated: raw.transactions_created ?? 0,
    duplicatesSkipped: raw.duplicates_skipped ?? 0,
    allocationsCreated: raw.allocations_created ?? 0,
    linksCreated: raw.links_created ?? 0,
    linksCompleted: raw.links_completed ?? 0,
    linksDeferred: raw.links_deferred ?? 0,
    bankLegsReclassified: raw.bank_legs_reclassified ?? 0,
    excludedUnclassified: raw.excluded_unclassified ?? 0,
    skipped: raw.skipped ?? null,
  };
}

export async function applyLiabilityProposalAtomic(request: LiabilityApplyRequest): Promise<LiabilityApplyResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh10_apply_liability_proposal', {
    p_proposal_id: request.proposalId,
    p_decision: request.decision,
    p_selected_fields: request.selectedFields && request.selectedFields.length > 0 ? request.selectedFields : null,
    p_owner: request.owner ?? null,
    p_acknowledge_unclassified: request.acknowledgeUnclassified ?? false,
  });

  if (error) {
    return { ok: false, code: 'WRITE_FAILED', error: error.message };
  }

  const result = data as RpcResponse;
  if (!result.ok) {
    return {
      ok: false,
      code: (result.code as LiabilityApplyErrorCode | undefined) ?? 'WRITE_FAILED',
      error: result.error ?? 'The change could not be saved.',
      ...(result.code === 'STALE_PROPOSAL'
        ? { staleness: { stale: true as const, changed: [{ fieldName: result.field ?? '', snapshotValue: result.existing ?? null, currentValue: result.current ?? null, proposedValue: null }] } }
        : {}),
      ...(result.blockers
        ? { blockers: result.blockers.map((b) => ({ activityId: b.activity_id, activityType: b.activity_type, reason: b.reason })) }
        : {}),
    };
  }

  if (result.outcome === 'rejected_statement') {
    return { ok: true, outcome: 'rejected_statement', applyMode: null, targetEntityId: null, applicationId: null, appliedFields: [], ledger: null, activitiesRejected: result.activities_rejected ?? 0 };
  }
  if (result.outcome === 'kept_existing') {
    return { ok: true, outcome: 'kept_existing', applyMode: null, targetEntityId: result.target_entity_id ?? null, applicationId: null, appliedFields: [], ledger: toLedgerEffects(result.ledger), activitiesRejected: 0 };
  }

  return {
    ok: true,
    outcome: 'applied',
    applyMode: (result.apply_mode as PersistedApplyMode | undefined) ?? null,
    targetEntityId: result.target_entity_id ?? null,
    applicationId: result.application_id ?? null,
    appliedFields: result.applied_fields ?? [],
    ledger: toLedgerEffects(result.ledger),
    activitiesRejected: 0,
  };
}

/**
 * FDH-10's analogue of `approvePayrollEventAtomic` — the one legitimate way
 * to move a liability statement's `approval_status` to 'approved' (migration
 * 0096 Part F.5's `fdh10_approve_liability_statement()`). Canonical Liability
 * is untouched by this call (spec section 21) — it only moves the statement's
 * own approval state.
 */
export async function approveLiabilityStatementAtomic(statementId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh10_approve_liability_statement', { p_statement_id: statementId });
  if (error) return { ok: false, error: error.message };
  const result = data as { ok: boolean; error?: string };
  if (!result.ok) return { ok: false, error: result.error ?? 'Could not approve this statement.' };
  return { ok: true };
}

/**
 * WP-11: record the ledger for a statement whose proposal was applied (or
 * kept against a liability) before migration 0209 -- `fdh10_record_liability_statement_ledger`.
 */
export async function recordLiabilityStatementLedger(request: { statementId: string; owner?: LiabilityImportOwner; acknowledgeUnclassified?: boolean }): Promise<LiabilityApplyResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh10_record_liability_statement_ledger', {
    p_statement_id: request.statementId,
    p_owner: request.owner ?? null,
    p_acknowledge_unclassified: request.acknowledgeUnclassified ?? false,
  });
  if (error) return { ok: false, code: 'WRITE_FAILED', error: error.message };
  const result = data as RpcResponse;
  if (!result.ok) {
    return {
      ok: false,
      code: (result.code as LiabilityApplyErrorCode | undefined) ?? 'WRITE_FAILED',
      error: result.error ?? 'The statement could not be recorded.',
      ...(result.blockers ? { blockers: result.blockers.map((b) => ({ activityId: b.activity_id, activityType: b.activity_type, reason: b.reason })) } : {}),
    };
  }
  return { ok: true, outcome: 'applied', applyMode: null, targetEntityId: result.target_entity_id ?? null, applicationId: null, appliedFields: [], ledger: toLedgerEffects(result.ledger), activitiesRejected: 0 };
}
