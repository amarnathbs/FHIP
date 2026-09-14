/**
 * AIE-1.5 — item-level decision handler (AIE15-ACT-01..12).
 *
 * This is the ONE path an item's status can change through from a review
 * action (accept/correct/not_present/defer) — it always goes through
 * `recordReviewDecision`'s version-checked update (no direct client
 * mutation of status, section 4), and a `'correct'` decision always
 * triggers a real revalidation pass before returning (DEP-01: "changing a
 * field... reruns... reconciliation").
 */

import { listFieldCandidatesForRun, recordReviewDecision, type DecisionOutcome } from '../db/repository';
import { createAdminClient } from '@/lib/supabase/admin';
import type { AieUnresolvedItemStatus } from '../types';
import { resolveModuleDescriptorByAdapterId, resolveReasonCodeMeta, narrowInsuranceRequiredFieldsCorrection } from './moduleRegistry';
import { findCorrectableFieldSpec, validateCorrection } from './validation';
import { revalidateRun, type RevalidateOutcome } from './revalidate';
import { getAdapterIdForRun } from '../db/repository';

export type ItemDecisionAction = 'correct' | 'not_present' | 'defer';

export interface DecideOnItemParams {
  itemId: string;
  userId: string;
  action: ItemDecisionAction;
  itemVersion: number;
  idempotencyKey: string;
  actorId?: string;
  rationale?: string;
  /** Required (and ONLY meaningful) for action === 'correct'. */
  fieldName?: string;
  rawValue?: string;
}

export type DecideOnItemOutcome =
  | { ok: false; reason: 'not_found' | 'forbidden' | 'stale_conflict' | 'db_error' | 'action_not_permitted' | 'field_not_correctable' | 'invalid_value' }
  | { ok: true; decision: DecisionOutcome; revalidation: RevalidateOutcome | null };

async function loadItemForOwner(itemId: string, userId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from('aie_unresolved_item')
    .select('id, run_id, intake_id, user_id, reason_code, status, item_version')
    .eq('id', itemId)
    .eq('user_id', userId)
    .maybeSingle();
  return data as { id: string; run_id: string; intake_id: string; user_id: string; reason_code: string; status: AieUnresolvedItemStatus; item_version: number } | null;
}

export async function decideOnItem(params: DecideOnItemParams): Promise<DecideOnItemOutcome> {
  // VALID-03 / PRIV-06: ownership is proven by the query itself
  // (`.eq('user_id', userId)`), never assumed from a client-supplied id.
  const item = await loadItemForOwner(params.itemId, params.userId);
  if (!item) return { ok: false, reason: 'not_found' };
  if (item.item_version !== params.itemVersion) return { ok: false, reason: 'stale_conflict' };
  if (item.status !== 'open' && item.status !== 'in_review') return { ok: false, reason: 'stale_conflict' };

  const adapterId = await getAdapterIdForRun(item.run_id);
  const descriptor = resolveModuleDescriptorByAdapterId(adapterId);
  let meta = resolveReasonCodeMeta(descriptor, item.reason_code);

  if (meta.correctableFields && meta.correctableFields.length > 0) {
    // Narrow "which fields are actually missing" for the one rule where
    // that matters (insurance_required_fields_present) — see
    // moduleRegistry.ts's own header on why this is safe to call
    // unconditionally for every reason code.
    const candidates = await listFieldCandidatesForRun(item.run_id);
    const present = new Set(candidates.filter((c) => !c.isNull && c.valueRaw !== null).map((c) => c.fieldName));
    meta = narrowInsuranceRequiredFieldsCorrection(meta, present);
  }

  if (!meta.allowedActions.includes(params.action === 'not_present' ? 'not_present' : params.action)) {
    return { ok: false, reason: 'action_not_permitted' };
  }

  let newStatus: AieUnresolvedItemStatus;
  let decisionType: string;
  let correctionFieldName: string | undefined;
  let correctionValueRaw: string | undefined;
  let correctionValueNormalized: string | undefined;

  if (params.action === 'correct') {
    if (!params.fieldName || params.rawValue === undefined) return { ok: false, reason: 'invalid_value' };
    const spec = findCorrectableFieldSpec(meta.correctableFields, params.fieldName);
    if (!spec) return { ok: false, reason: 'field_not_correctable' }; // ACT-09: no arbitrary field
    const validated = validateCorrection(spec, params.rawValue);
    if (!validated.ok) return { ok: false, reason: 'invalid_value' };
    newStatus = 'in_review'; // a correction alone does not resolve the item — revalidation decides that
    decisionType = 'correct';
    correctionFieldName = params.fieldName;
    correctionValueRaw = params.rawValue;
    correctionValueNormalized = validated.normalized;
  } else if (params.action === 'not_present') {
    // ACT-04: "Not present/Not on document" — a user assertion the field
    // genuinely does not exist, distinct from a correction. Still routes
    // through revalidation (a required-field-missing rule may legitimately
    // stay failed — asserting absence does not fabricate a value).
    newStatus = 'in_review';
    decisionType = 'not_present';
  } else {
    // defer — ACT-06: never a false completion. The item stays open-ish
    // (status 'deferred') and does NOT trigger revalidation or count
    // toward "ready to accept" (userState.ts treats anything other than a
    // fully resolved/superseded item as still blocking via
    // listOpenUnresolvedItemsForRun's own status filter — 'deferred' is
    // deliberately excluded from that filter so a deferred item still
    // blocks acceptance rather than silently vanishing).
    newStatus = 'deferred';
    decisionType = 'defer';
  }

  const decision = await recordReviewDecision({
    itemId: item.id,
    intakeId: item.intake_id,
    userId: item.user_id,
    expectedItemVersion: item.item_version,
    decisionType,
    rationale: params.rationale,
    idempotencyKey: params.idempotencyKey,
    actorId: params.actorId,
    newStatus,
    correctionFieldName,
    correctionValueRaw,
    correctionValueNormalized,
  });
  if (!decision.ok) return { ok: false, reason: decision.reason === 'not_found' ? 'not_found' : decision.reason };

  // Deferred items intentionally never trigger a recheck — nothing about
  // the underlying candidate set changed.
  if (params.action === 'defer') return { ok: true, decision, revalidation: null };

  const revalidation = await revalidateRun({ runId: item.run_id, userId: item.user_id });
  return { ok: true, decision, revalidation };
}
