import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { emitAuditEvent } from './audit';
import { checkFundingAllocation, resolveAllocatedAmount } from '@/lib/services/goalFundingAllocation';
import type { IiGoalAllocationSource, IiGoalAllocationType } from './types';

// R9_GOAL_ALLOCATION_CONTRACT.md section 1: ii_goal_allocations is kept in
// lockstep with the EXISTING, live goal_funding_sources mechanism, never a
// second allocation-limit model (spec sections 14, 16). The live
// cross-table write only happens when a caller supplies an already-
// published investments.id (linkedInvestmentId) — this module never
// fabricates one.
//
// R9 FIX (discovered during R9-P0 discovery — R9_CANONICAL_INTEGRATION_DISCOVERY.md
// section "Explicit flags requested"): the R1-era version of this module
// inserted directly into goal_funding_sources WITHOUT calling
// checkFundingAllocation() first, so it never actually enforced the <=100%
// allocation cap for allocations created through the Investment
// Intelligence side (spec sections 16, 89 negative-control-2, critical fail
// condition 2). This file closes that gap: every write that carries an
// allocation_percentage against a linkedInvestmentId now goes through
// checkFundingAllocation() exactly like the existing goals-side
// app/api/goals/[id]/funding-sources route already does, and every write
// additionally verifies the caller owns linkedInvestmentId before it is
// referenced (spec sections 66-71 — cross-tenant linkage must fail).
export interface GoalAllocationCandidate {
  goalId: string;
  investmentPositionId: string;
  allocationType: IiGoalAllocationType;
  allocationValue: number | null;
  source: IiGoalAllocationSource;
}

export interface GoalFundingSourcePayload {
  goal_id: string;
  source_type: 'investment';
  linked_investment_id: string;
  allocation_percentage: number | null;
  allocated_amount: number;
  is_active: boolean;
}

// Pure mapping — no I/O. allocation_type='percentage' maps to
// allocation_percentage (goal_funding_sources' cap-checked field);
// 'fixed_amount' maps to allocated_amount with no percentage (matching
// evaluateAllocation()'s existing "null percentage carries no double-
// counting risk" treatment); 'residual' is goal-side-only and does not
// produce a goal_funding_sources percentage either (resolved at read time
// by a future goal-funding calculation layer, per R0_GOAL_INTEGRATION_CONTRACT.md
// section 2 — not a schema concern here).
export function deriveGoalFundingSourcePayload(
  candidate: GoalAllocationCandidate,
  linkedInvestmentId: string
): GoalFundingSourcePayload {
  const isPercentage = candidate.allocationType === 'percentage';
  return {
    goal_id: candidate.goalId,
    source_type: 'investment',
    linked_investment_id: linkedInvestmentId,
    allocation_percentage: isPercentage ? candidate.allocationValue : null,
    allocated_amount: !isPercentage && candidate.allocationValue !== null ? candidate.allocationValue : 0,
    is_active: true,
  };
}

export interface GoalAllocationWriteResult {
  allocationId: string | null;
  error: string | null;
  /** true when the write was rejected specifically by the <=100% allocation cap (spec section 16) — callers surface this as 409, not 500. */
  capExceeded?: boolean;
}

async function assertOwnsInvestment(userId: string, investmentId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from('investments').select('id').eq('id', investmentId).eq('user_id', userId).maybeSingle();
  if (error) return error.message;
  if (!data) return 'Investment not found or not owned by the current user';
  return null;
}

export async function createOrUpdateGoalAllocation(
  userId: string,
  candidate: GoalAllocationCandidate,
  linkedInvestmentId: string | null
): Promise<GoalAllocationWriteResult> {
  const admin = createAdminClient();

  // R9 fix: verify ownership of the position being linked BEFORE any write
  // (spec sections 66-71). goal ownership is already checked by the API
  // route layer before this function is called.
  if (linkedInvestmentId) {
    const ownershipError = await assertOwnsInvestment(userId, linkedInvestmentId);
    if (ownershipError) return { allocationId: null, error: ownershipError };
  }

  // R9 fix: enforce the <=100% allocation cap for percentage allocations
  // BEFORE inserting the ii_goal_allocations row, so a rejected allocation
  // never leaves an orphaned ii_goal_allocations row with no
  // goal_funding_sources counterpart (spec section 16, critical fail
  // condition 2).
  if (linkedInvestmentId && candidate.allocationType === 'percentage' && candidate.allocationValue !== null) {
    const check = await checkFundingAllocation(userId, {
      linkedInvestmentId,
      allocationPercentage: candidate.allocationValue,
    });
    if (!check.ok) return { allocationId: null, error: check.error!, capExceeded: true };
  }

  const { data: created, error } = await admin
    .from('ii_goal_allocations')
    .insert({
      user_id: userId,
      goal_id: candidate.goalId,
      investment_position_id: candidate.investmentPositionId,
      allocation_type: candidate.allocationType,
      allocation_value: candidate.allocationValue,
      source: candidate.source,
      status: 'active',
      linked_investment_id: linkedInvestmentId,
    })
    .select('id')
    .single();
  if (error || !created) return { allocationId: null, error: error?.message ?? 'Allocation creation failed' };

  if (linkedInvestmentId) {
    const payload = deriveGoalFundingSourcePayload(candidate, linkedInvestmentId);
    const allocatedAmount = await resolveAllocatedAmount(userId, {
      sourceType: payload.source_type,
      linkedInvestmentId,
      allocationPercentage: payload.allocation_percentage,
      allocatedAmount: payload.allocated_amount,
    });
    const { error: syncErr } = await admin
      .from('goal_funding_sources')
      .insert({ ...payload, allocated_amount: allocatedAmount, user_id: userId });
    if (syncErr) {
      // Roll back the ii_goal_allocations row rather than leaving a
      // half-written allocation with no funding-source counterpart.
      await admin.from('ii_goal_allocations').delete().eq('id', created.id as string);
      return { allocationId: null, error: `goal_funding_sources sync failed: ${syncErr.message}` };
    }
  }

  await emitAuditEvent({
    userId,
    eventType: 'goal_allocation_created',
    subjectType: 'ii_goal_allocations',
    subjectId: created.id as string,
    actorType: 'user',
    metadata: {
      allocationId: created.id,
      goalId: candidate.goalId,
      investmentPositionId: candidate.investmentPositionId,
      allocationType: candidate.allocationType,
      allocationValue: candidate.allocationValue,
    },
  });
  return { allocationId: created.id as string, error: null };
}

// R9 addition — lifecycle support (spec sections 19, 20, 69): changing an
// allocation never silently overwrites the old row (historical
// forecast/review evidence may depend on it). The old row is marked
// 'superseded' with effective_to=today; a fresh row is inserted. The
// goal_funding_sources counterpart row is updated in place (it has no
// separate history table of its own — matching how the existing goals-side
// PUT /api/goals/[id]/funding-sources/[sourceId] route already treats it).
export async function updateGoalAllocation(
  userId: string,
  allocationId: string,
  patch: { allocationType: IiGoalAllocationType; allocationValue: number | null },
  linkedInvestmentId: string | null
): Promise<GoalAllocationWriteResult> {
  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from('ii_goal_allocations')
    .select('*')
    .eq('id', allocationId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (fetchErr) return { allocationId: null, error: fetchErr.message };
  if (!existing) return { allocationId: null, error: 'Allocation not found, not owned by the current user, or no longer active' };

  if (linkedInvestmentId) {
    const ownershipError = await assertOwnsInvestment(userId, linkedInvestmentId);
    if (ownershipError) return { allocationId: null, error: ownershipError };
  }

  // Preserve the existing link when the caller doesn't supply a new one
  // (e.g. changing only the percentage of an already-published allocation).
  const resolvedLinkedInvestmentId = linkedInvestmentId ?? (existing.linked_investment_id as string | null) ?? null;
  if (resolvedLinkedInvestmentId && patch.allocationType === 'percentage' && patch.allocationValue !== null) {
    // Exclude the OLD goal_funding_sources row (matched by linked_investment_id + goal_id) from the cap check —
    // it is being replaced, not added on top of.
    const { data: oldSource } = await admin
      .from('goal_funding_sources')
      .select('id')
      .eq('user_id', userId)
      .eq('goal_id', existing.goal_id as string)
      .eq('linked_investment_id', resolvedLinkedInvestmentId)
      .eq('is_active', true)
      .maybeSingle();
    const check = await checkFundingAllocation(
      userId,
      { linkedInvestmentId: resolvedLinkedInvestmentId, allocationPercentage: patch.allocationValue },
      (oldSource?.id as string) ?? undefined
    );
    if (!check.ok) return { allocationId: null, error: check.error!, capExceeded: true };
  }

  const today = new Date().toISOString().slice(0, 10);
  const { error: supersedeErr } = await admin
    .from('ii_goal_allocations')
    .update({ status: 'superseded', effective_to: today, updated_at: new Date().toISOString() })
    .eq('id', allocationId)
    .eq('user_id', userId);
  if (supersedeErr) return { allocationId: null, error: supersedeErr.message };

  const { data: created, error: insertErr } = await admin
    .from('ii_goal_allocations')
    .insert({
      user_id: userId,
      goal_id: existing.goal_id,
      investment_position_id: existing.investment_position_id,
      allocation_type: patch.allocationType,
      allocation_value: patch.allocationValue,
      source: 'user',
      status: 'active',
      effective_from: today,
      linked_investment_id: resolvedLinkedInvestmentId,
    })
    .select('id')
    .single();
  if (insertErr || !created) return { allocationId: null, error: insertErr?.message ?? 'Allocation update failed' };

  if (resolvedLinkedInvestmentId) {
    const payload = deriveGoalFundingSourcePayload(
      { goalId: existing.goal_id as string, investmentPositionId: existing.investment_position_id as string, allocationType: patch.allocationType, allocationValue: patch.allocationValue, source: 'user' },
      resolvedLinkedInvestmentId
    );
    const allocatedAmount = await resolveAllocatedAmount(userId, {
      sourceType: payload.source_type,
      linkedInvestmentId: resolvedLinkedInvestmentId,
      allocationPercentage: payload.allocation_percentage,
      allocatedAmount: payload.allocated_amount,
    });
    await admin
      .from('goal_funding_sources')
      .update({ allocation_percentage: payload.allocation_percentage, allocated_amount: allocatedAmount, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('goal_id', existing.goal_id as string)
      .eq('linked_investment_id', resolvedLinkedInvestmentId)
      .eq('is_active', true);
  }

  await emitAuditEvent({
    userId,
    eventType: 'goal_allocation_changed',
    subjectType: 'ii_goal_allocations',
    subjectId: created.id as string,
    actorType: 'user',
    metadata: { previousAllocationId: allocationId, allocationId: created.id, goalId: existing.goal_id },
  });
  return { allocationId: created.id as string, error: null };
}

// R9 addition — removal marks 'removed' with effective_to=today (never a
// hard delete of history — spec section 20) and deactivates the
// goal_funding_sources counterpart the same way the existing
// DELETE /api/goals/[id]/funding-sources/[sourceId] route already does
// (soft is_active=false, not a row delete).
export async function removeGoalAllocation(userId: string, allocationId: string): Promise<{ error: string | null }> {
  const admin = createAdminClient();
  const { data: existing, error: fetchErr } = await admin
    .from('ii_goal_allocations')
    .select('*')
    .eq('id', allocationId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (fetchErr) return { error: fetchErr.message };
  if (!existing) return { error: 'Allocation not found, not owned by the current user, or already inactive' };

  const today = new Date().toISOString().slice(0, 10);
  const { error: updateErr } = await admin
    .from('ii_goal_allocations')
    .update({ status: 'removed', effective_to: today, updated_at: new Date().toISOString() })
    .eq('id', allocationId)
    .eq('user_id', userId);
  if (updateErr) return { error: updateErr.message };

  // Only deactivate the SPECIFIC goal_funding_sources row this allocation
  // produced (matched by its persisted linked_investment_id), never every
  // investment-sourced funding source on the goal — a goal may have several,
  // one per allocated investment (spec section 15, "multiple investments ->
  // one goal"). Best-effort: an allocation created before the position was
  // published has no linked_investment_id, so there is nothing to deactivate.
  if (existing.linked_investment_id) {
    await admin
      .from('goal_funding_sources')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('goal_id', existing.goal_id as string)
      .eq('linked_investment_id', existing.linked_investment_id as string)
      .eq('source_type', 'investment');
  }

  await emitAuditEvent({
    userId,
    eventType: 'goal_allocation_removed',
    subjectType: 'ii_goal_allocations',
    subjectId: allocationId,
    actorType: 'user',
    metadata: { allocationId, goalId: existing.goal_id },
  });
  return { error: null };
}
