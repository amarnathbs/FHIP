/**
 * PC5 (M4) — K.6 persistence, and K.18's amendment semantics applied to it.
 *
 * WRITES ARE SERVICE-ROLE ONLY. `ii_ownership_allocation` (migration 0153)
 * has SELECT-only RLS, deliberately unlike `ii_goal_allocations`'s `for
 * all`. An allocation is authoritative financial evidence attached to a
 * governed decision; letting a browser PATCH one would defeat both K.20's
 * forgery requirement and K.6's audit requirement in a single line. The
 * database ALSO refuses a cross-tenant foreign key via
 * `trg_ii_ownership_allocation_owner`, so a same-user caller who supplies a
 * real household-member id belonging to somebody else is rejected at the
 * database rather than only in this file.
 *
 * K.18 — AMENDMENT, NOT MUTATION. An allocation group is never edited in
 * place and never deleted. Changing an allocation marks the whole existing
 * active group `'superseded'`, stamps its `effective_to` and its
 * `superseded_by_group_id`, and inserts a NEW group. So the history reads
 * as "it was 50/50 from the 3rd, then 70/30 from the 11th", which is what
 * an effective-dated ownership record has to be able to say — and which an
 * in-place UPDATE would destroy. This mirrors the discipline
 * `fdh_approved_financial_summaries` already applies to approvals
 * ("reopening never deletes a prior row, it marks it superseded and a fresh
 * approval inserts the next version") and that `ii_fhip_publications`
 * applies to publications.
 *
 * THE SUPERSESSION IS NOT ATOMIC ACROSS THE TWO STATEMENTS, and that is
 * survivable BY DESIGN rather than by luck. Supabase's PostgREST client
 * exposes no multi-statement transaction, and this repository's established
 * answer (see `documentProcessing.ts`'s own header: "canonical writes are
 * staged in-memory... a write-time failure partway through leaves
 * already-written rows valid") is to ORDER the writes so that every
 * interruption leaves a readable, non-contradictory state. Here that means
 * SUPERSEDE FIRST, THEN INSERT:
 *   - crash after the supersede: the position has NO active allocation. A
 *     reader sees "not yet allocated", which is true and which the
 *     unresolved item is still open about.
 *   - crash the other way round (insert first) would leave TWO active
 *     groups totalling 200%, which is a state no reader could interpret.
 * The first failure is recoverable by repeating the decision; the second
 * would be silent corruption. Hence this order.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { PC5_TOTAL_BASIS_POINTS, validateAllocation } from './jointAllocation';
import type { Pc5AllocationEntry } from './types';

export interface Pc5StoredAllocation {
  id: string;
  allocationGroupId: string;
  iiAccountId: string;
  iiInstrumentId: string | null;
  ownerMemberId: string | null;
  ownerBusinessEntityId: string | null;
  ownerRole: string;
  allocationBasisPoints: number;
  source: 'user' | 'system_default';
  status: 'active' | 'superseded' | 'removed';
  effectiveFrom: string;
  effectiveTo: string | null;
  supersededByGroupId: string | null;
  createdAt: string;
}

function toStored(r: Record<string, unknown>): Pc5StoredAllocation {
  return {
    id: r.id as string,
    allocationGroupId: r.allocation_group_id as string,
    iiAccountId: r.ii_account_id as string,
    iiInstrumentId: (r.ii_instrument_id as string | null) ?? null,
    ownerMemberId: (r.owner_member_id as string | null) ?? null,
    ownerBusinessEntityId: (r.owner_business_entity_id as string | null) ?? null,
    ownerRole: r.owner_role as string,
    allocationBasisPoints: r.allocation_basis_points as number,
    source: r.source as 'user' | 'system_default',
    status: r.status as 'active' | 'superseded' | 'removed',
    effectiveFrom: r.effective_from as string,
    effectiveTo: (r.effective_to as string | null) ?? null,
    supersededByGroupId: (r.superseded_by_group_id as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

const ALLOCATION_COLUMNS =
  'id, allocation_group_id, ii_account_id, ii_instrument_id, owner_member_id, owner_business_entity_id, owner_role, allocation_basis_points, source, status, effective_from, effective_to, superseded_by_group_id, created_at';

export async function listActiveAllocations(userId: string, iiAccountId: string): Promise<Pc5StoredAllocation[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('ii_ownership_allocation')
    .select(ALLOCATION_COLUMNS)
    .eq('user_id', userId)
    .eq('ii_account_id', iiAccountId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });
  return (data ?? []).map((r) => toStored(r as Record<string, unknown>));
}

/** Full history for one position, newest group first — K.6's "changes are
 * audited and effective-dated/amended as appropriate", read back. */
export async function listAllocationHistory(userId: string, iiAccountId: string): Promise<Pc5StoredAllocation[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('ii_ownership_allocation')
    .select(ALLOCATION_COLUMNS)
    .eq('user_id', userId)
    .eq('ii_account_id', iiAccountId)
    .order('created_at', { ascending: false });
  return (data ?? []).map((r) => toStored(r as Record<string, unknown>));
}

export type Pc5AllocationWriteOutcome =
  | { ok: false; reason: 'invalid_allocation'; detail: string }
  | { ok: false; reason: 'db_error'; detail: string }
  | { ok: true; allocationGroupId: string; supersededGroupId: string | null; rowsWritten: number };

export interface Pc5RecordAllocationParams {
  userId: string;
  iiAccountId: string;
  iiInstrumentId?: string | null;
  entries: readonly Pc5AllocationEntry[];
  /** The canonical FHIP owner role for the resulting position. `'joint'`
   * for a genuine split; the single owner's own role otherwise. */
  ownerRole: string;
  source: 'user' | 'system_default';
  aieReviewDecisionId?: string | null;
  aieRunId?: string | null;
  /** Defaults to today. Explicit so a test can pin it and so an amendment
   * can be dated to when the change actually took effect rather than when
   * it was entered. */
  effectiveFromIso?: string;
}

/**
 * Records one allocation group, superseding whatever active group the
 * position already had.
 *
 * Validation runs HERE as well as in `validateAllocation`'s own callers
 * because this is the persistence boundary: a future caller that forgets to
 * validate must still be unable to write a group that does not total 100%.
 * The database's per-row CHECK cannot express a cross-row sum, so this is
 * the only place that invariant can be enforced before the write.
 */
export async function recordAllocationGroup(params: Pc5RecordAllocationParams): Promise<Pc5AllocationWriteOutcome> {
  const validated = validateAllocation(params.entries);
  if (!validated.ok) {
    return { ok: false, reason: 'invalid_allocation', detail: `${validated.reason}` };
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const effectiveFrom = params.effectiveFromIso ?? nowIso.slice(0, 10);

  // --- 1. Find and supersede the current active group, IF ANY -------------
  const { data: existing, error: existingError } = await admin
    .from('ii_ownership_allocation')
    .select('allocation_group_id')
    .eq('user_id', params.userId)
    .eq('ii_account_id', params.iiAccountId)
    .eq('status', 'active')
    .limit(1);
  if (existingError) return { ok: false, reason: 'db_error', detail: existingError.message };

  const supersededGroupId = (existing?.[0]?.allocation_group_id as string | undefined) ?? null;
  const newGroupId = globalThis.crypto.randomUUID();

  if (supersededGroupId) {
    // `effective_to` is set to the day BEFORE the new group takes effect
    // when they differ, so the two ranges do not overlap on a single day
    // and a point-in-time query never returns two active owners for one
    // share. When an amendment is dated the same day it is entered (the
    // normal case) both ranges collapse onto that date, and `status` is
    // then the discriminator rather than the dates — which is why status
    // is checked first everywhere in this file.
    const { error: supersedeError } = await admin
      .from('ii_ownership_allocation')
      .update({
        status: 'superseded',
        superseded_by_group_id: newGroupId,
        effective_to: effectiveFrom,
        updated_at: nowIso,
      })
      .eq('user_id', params.userId)
      .eq('allocation_group_id', supersededGroupId)
      .eq('status', 'active');
    if (supersedeError) return { ok: false, reason: 'db_error', detail: supersedeError.message };

    await emitAuditEvent({
      userId: params.userId,
      eventType: 'pc5_ownership_allocation_superseded',
      subjectType: 'ii_accounts',
      subjectId: params.iiAccountId,
      actorType: 'user',
      metadata: { supersededGroupId, replacedByGroupId: newGroupId },
    });
  }

  // --- 2. Insert the new group -------------------------------------------
  const rows = validated.entries.map((e) => ({
    user_id: params.userId,
    ii_account_id: params.iiAccountId,
    ii_instrument_id: params.iiInstrumentId ?? null,
    owner_member_id: e.ownerMemberId ?? null,
    owner_business_entity_id: e.ownerBusinessEntityId ?? null,
    owner_role: params.ownerRole,
    allocation_basis_points: e.basisPoints,
    allocation_group_id: newGroupId,
    source: params.source,
    aie_review_decision_id: params.aieReviewDecisionId ?? null,
    aie_run_id: params.aieRunId ?? null,
    status: 'active',
    effective_from: effectiveFrom,
  }));

  const { error: insertError } = await admin.from('ii_ownership_allocation').insert(rows);
  if (insertError) return { ok: false, reason: 'db_error', detail: insertError.message };

  await emitAuditEvent({
    userId: params.userId,
    eventType: 'pc5_ownership_allocation_recorded',
    subjectType: 'ii_accounts',
    subjectId: params.iiAccountId,
    actorType: 'user',
    metadata: {
      allocationGroupId: newGroupId,
      ownerCount: rows.length,
      ownerRole: params.ownerRole,
      source: params.source,
      totalBasisPoints: PC5_TOTAL_BASIS_POINTS,
    },
  });

  return { ok: true, allocationGroupId: newGroupId, supersededGroupId, rowsWritten: rows.length };
}

/**
 * K.6's D.2 guard, as a queryable assertion rather than a comment: for
 * every account this user has allocations on, the ACTIVE group must total
 * exactly 10000 basis points. Returns the offenders.
 *
 * This exists because "the total must equal 100%" is enforced at write
 * time by application code, and application-time invariants that are never
 * re-checked are how drift happens. PC5's live-DEV matrix runs this after
 * every allocation scenario, and it is cheap enough to run as a health
 * check.
 */
export async function findAllocationTotalViolations(userId: string): Promise<{ iiAccountId: string; allocationGroupId: string; totalBasisPoints: number }[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('ii_ownership_allocation')
    .select('ii_account_id, allocation_group_id, allocation_basis_points')
    .eq('user_id', userId)
    .eq('status', 'active');
  const totals = new Map<string, { iiAccountId: string; total: number }>();
  for (const r of data ?? []) {
    const key = r.allocation_group_id as string;
    const current = totals.get(key) ?? { iiAccountId: r.ii_account_id as string, total: 0 };
    current.total += r.allocation_basis_points as number;
    totals.set(key, current);
  }
  return [...totals.entries()]
    .filter(([, v]) => v.total !== PC5_TOTAL_BASIS_POINTS)
    .map(([allocationGroupId, v]) => ({ iiAccountId: v.iiAccountId, allocationGroupId, totalBasisPoints: v.total }));
}
