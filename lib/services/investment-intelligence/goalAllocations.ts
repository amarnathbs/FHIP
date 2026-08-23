import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from './audit';
import type { IiGoalAllocationSource, IiGoalAllocationType } from './types';

// R0_GOAL_INTEGRATION_CONTRACT.md section 1: ii_goal_allocations is kept in
// lockstep with the EXISTING, live goal_funding_sources mechanism, never a
// second allocation-limit model. Because R1 does not activate real FHIP
// publishing (lib/services/investment-intelligence/publishing.ts), there is
// usually no real investments.id yet to link goal_funding_sources.
// linked_investment_id to — so the live cross-table write only happens when
// a caller supplies an already-published investments.id; the pure mapping
// function below is what's unit tested per R1_IMPLEMENTATION_SPEC.md section
// 13 ("ii_goal_allocations <-> goal_funding_sources sync"), proving the
// shape is correct and ready for R2 to wire against real publications.
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

export async function createOrUpdateGoalAllocation(
  userId: string,
  candidate: GoalAllocationCandidate,
  linkedInvestmentId: string | null
): Promise<{ allocationId: string | null; error: string | null }> {
  const admin = createAdminClient();

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
    })
    .select('id')
    .single();
  if (error || !created) return { allocationId: null, error: error?.message ?? 'Allocation creation failed' };

  // Only attempt the live goal_funding_sources write-through when the
  // position has actually been published (see module comment above) — R1
  // never fabricates a fake linked_investment_id.
  if (linkedInvestmentId) {
    const payload = deriveGoalFundingSourcePayload(candidate, linkedInvestmentId);
    const { error: syncErr } = await admin.from('goal_funding_sources').insert({ ...payload, user_id: userId });
    if (syncErr) return { allocationId: created.id as string, error: `Allocation created but goal_funding_sources sync failed: ${syncErr.message}` };
  }

  await emitAuditEvent({
    userId,
    eventType: 'goal_allocation',
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
