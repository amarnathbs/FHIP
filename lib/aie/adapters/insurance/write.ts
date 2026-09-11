/**
 * AIE-1.4 — Insurance adapter: the gated, idempotent canonical write
 * (execution sequence step 6/AIE14-INS-12: "Write accepted data only
 * through canonical Insurance services with amendment lineage") — GATED so
 * it never fires until reconciliation passes and (since this phase has no
 * production authority) behind a feature flag defaulted OFF.
 *
 * NO NEW DIRECT-TO-TABLE WRITE PATH. This function performs exactly the
 * SAME write `app/api/insurance/route.ts`'s own POST handler already
 * performs for a normal manual entry: `insuranceSchema.safeParse(...)` then
 * `makeRegistry('insurance_policies').save(userId, row)` — unchanged,
 * uncopied logic, just called from here instead of from a browser form
 * submit. `save()`'s own upsert-on-master_item_key behaviour (see
 * lib/services/registry.ts) is what gives an accepted RENEWAL/PREMIUM
 * NOTICE amendment lineage: supplying the SAME `master_item_key` as an
 * earlier accepted POLICY SCHEDULE for this policy updates that same row
 * (an update, not a duplicate insert) — the caller (the future AIE-1.5
 * review UI) is responsible for supplying that continuity key; this
 * function does not invent one.
 *
 * `owner` IS NEVER DERIVED FROM DOCUMENT TEXT. `insurance_policies.owner`
 * is a HOUSEHOLD-ROLE enum (self/spouse/joint/child/family_trust/company/
 * smsf/other) — it answers "whose household item is this", not "who is the
 * legal policy owner/insured/beneficiary printed on the document" (those
 * three roles have no column at all — see documentCatalogue.ts's header).
 * Exactly like the real manual-entry UI, `ownerHouseholdRole` here is
 * always an explicit caller-supplied value (the accepting user's own
 * choice), never inferred from `policyOwnerName`/`insuredPersonName`
 * candidates — inventing that mapping would be exactly the "ownership
 * invention" AIE14 section 4 forbids.
 *
 * GATES, IN ORDER (all must hold, checked in the order a reviewer would
 * want to see refused first):
 *   1. `isInsuranceAdapterCanonicalWriteEnabled()` — the kill switch,
 *      default OFF.
 *   2. The reconciliation outcome passed to this function is `pass` or
 *      `pass_with_tolerance` — never `fail`/`indeterminate`/`not_applicable`
 *      (P4: no confidence parameter exists anywhere in this file).
 *   3. No open BLOCKING unresolved item remains for this run — represented
 *      the same honest way AIE-1.2's `write.ts` represents "required user
 *      acceptance" today (AIE-1.5's real review/acceptance UI does not
 *      exist yet): an explicit `acceptedByUserId` the caller must supply
 *      AND a caller-verified absence of open blocking items.
 *
 * IDEMPOTENCY. `aie_insurance_adapter_link` (migration 0143) has a unique
 * constraint on `aie_run_id` — a second call for the same run finds the
 * existing link and refuses to write again, rather than re-inserting or
 * silently re-updating.
 */

import { insuranceSchema } from '@/lib/validation/insurance';
import { makeRegistry } from '@/lib/services/registry';
import { createAdminClient } from '@/lib/supabase/admin';
import type { Owner as OwnerValue } from '@/lib/constants';
import type { AieFieldCandidate, AieReconciliationOutcome } from '../../types';
import { isInsuranceAdapterCanonicalWriteEnabled } from './featureFlags';

export interface AcceptAndWriteInsuranceInput {
  aieIntakeId: string;
  aieRunId: string;
  userId: string;
  /** Never derived from document text — see this file's header. */
  ownerHouseholdRole: OwnerValue;
  candidates: readonly AieFieldCandidate[];
  acceptedByUserId: string;
  reconciliationOutcome: AieReconciliationOutcome;
  hasOpenBlockingUnresolvedItems: boolean;
  masterItemKey?: string | null;
  notes?: string | null;
}

export type AcceptAndWriteInsuranceOutcome =
  | { ok: false; reason: 'feature_flag_disabled' | 'reconciliation_not_passed' | 'unresolved_items_open' }
  | { ok: false; reason: 'already_written'; insurancePolicyId: string }
  | { ok: false; reason: 'schema_validation_failed'; message: string }
  | { ok: false; reason: 'insurance_policy_save_failed' | 'link_insert_failed'; message: string }
  | { ok: true; insurancePolicyId: string };

export interface AcceptAndWriteInsuranceDeps {
  findExistingLink: (aieRunId: string) => Promise<{ insurancePolicyId: string } | null>;
  saveInsurancePolicy: (userId: string, row: Record<string, unknown>) => Promise<{ id: string } | { error: string }>;
  recordLink: (params: { aieIntakeId: string; aieRunId: string; userId: string; insurancePolicyId: string; acceptedByUserId: string }) => Promise<{ ok: true } | { ok: false; message: string }>;
}

export function createDefaultAcceptAndWriteInsuranceDeps(): AcceptAndWriteInsuranceDeps {
  const registry = makeRegistry('insurance_policies');
  return {
    findExistingLink: async (aieRunId) => {
      const admin = createAdminClient();
      const { data } = await admin.from('aie_insurance_adapter_link').select('insurance_policy_id').eq('aie_run_id', aieRunId).maybeSingle();
      return data ? { insurancePolicyId: data.insurance_policy_id as string } : null;
    },
    saveInsurancePolicy: async (userId, row) => {
      const { data, error } = await registry.save(userId, row);
      if (error || !data) return { error: error?.message ?? 'insurance_policies save failed' };
      return { id: (data as { id: string }).id };
    },
    recordLink: async (params) => {
      const admin = createAdminClient();
      const { error } = await admin.from('aie_insurance_adapter_link').insert({
        aie_intake_id: params.aieIntakeId,
        aie_run_id: params.aieRunId,
        user_id: params.userId,
        insurance_policy_id: params.insurancePolicyId,
        accepted_by_user_id: params.acceptedByUserId,
      });
      if (error) {
        if (error.code === '23505') return { ok: true }; // idempotent replay — link already exists
        return { ok: false, message: error.message };
      }
      return { ok: true };
    },
  };
}

/** Reads the canonical-field candidates this run produced back into the
 * exact shape `insuranceSchema` expects. Evidence-only fields (masked
 * policy number, owner/insured/beneficiary names, exclusions text, excess,
 * printed annual total) are deliberately NOT included — none of them has a
 * column on `insurance_policies` (documentCatalogue.ts's header). */
export function buildInsurancePolicyRow(
  candidates: readonly AieFieldCandidate[],
  ownerHouseholdRole: OwnerValue,
  masterItemKey?: string | null,
  notes?: string | null,
): Record<string, unknown> {
  const value = (fieldName: string): string | undefined => candidates.find((c) => c.fieldName === fieldName && !c.isNull)?.valueRaw ?? undefined;
  const row: Record<string, unknown> = {
    policy_name: value('policyName'),
    cover_type: value('coverType') ?? 'other',
    cover_amount: value('coverAmount') !== undefined ? Number(value('coverAmount')) : undefined,
    premium: value('premium') !== undefined ? Number(value('premium')) : undefined,
    premium_frequency: value('premiumFrequency'),
    currency_code: value('currencyCode'),
    renewal_date: value('renewalDate') ?? null,
    waiting_period_days: value('waitingPeriodDays') !== undefined ? Number(value('waitingPeriodDays')) : null,
    benefit_period: value('benefitPeriod') ?? null,
    provider: value('provider') ?? null,
    owner: ownerHouseholdRole,
    master_item_key: masterItemKey ?? null,
    notes: notes ?? null,
  };
  return row;
}

export async function acceptAndWriteInsuranceCandidates(
  input: AcceptAndWriteInsuranceInput,
  deps: AcceptAndWriteInsuranceDeps,
): Promise<AcceptAndWriteInsuranceOutcome> {
  if (!isInsuranceAdapterCanonicalWriteEnabled()) return { ok: false, reason: 'feature_flag_disabled' };
  if (input.reconciliationOutcome === 'fail' || input.reconciliationOutcome === 'indeterminate' || input.reconciliationOutcome === 'not_applicable') {
    return { ok: false, reason: 'reconciliation_not_passed' };
  }
  if (input.hasOpenBlockingUnresolvedItems) return { ok: false, reason: 'unresolved_items_open' };

  const existing = await deps.findExistingLink(input.aieRunId);
  if (existing) return { ok: false, reason: 'already_written', insurancePolicyId: existing.insurancePolicyId };

  const row = buildInsurancePolicyRow(input.candidates, input.ownerHouseholdRole, input.masterItemKey, input.notes);
  const parsed = insuranceSchema.safeParse(row);
  if (!parsed.success) return { ok: false, reason: 'schema_validation_failed', message: parsed.error.message };

  const saved = await deps.saveInsurancePolicy(input.userId, parsed.data);
  if ('error' in saved) return { ok: false, reason: 'insurance_policy_save_failed', message: saved.error };

  const link = await deps.recordLink({
    aieIntakeId: input.aieIntakeId,
    aieRunId: input.aieRunId,
    userId: input.userId,
    insurancePolicyId: saved.id,
    acceptedByUserId: input.acceptedByUserId,
  });
  if (!link.ok) return { ok: false, reason: 'link_insert_failed', message: link.message };

  return { ok: true, insurancePolicyId: saved.id };
}
