import { describe, it, expect } from 'vitest';
import { deriveGoalFundingSourcePayload, type GoalAllocationCandidate } from '@/lib/services/investment-intelligence/goalAllocations';

describe('deriveGoalFundingSourcePayload (ii_goal_allocations <-> goal_funding_sources sync)', () => {
  it('maps a percentage allocation onto allocation_percentage, subject to the existing 100%-cap check', () => {
    const candidate: GoalAllocationCandidate = {
      goalId: 'goal-1',
      investmentPositionId: 'pos-1',
      allocationType: 'percentage',
      allocationValue: 40,
      source: 'user',
    };
    const payload = deriveGoalFundingSourcePayload(candidate, 'inv-1');
    expect(payload).toMatchObject({
      goal_id: 'goal-1',
      source_type: 'investment',
      linked_investment_id: 'inv-1',
      allocation_percentage: 40,
      allocated_amount: 0,
      is_active: true,
    });
  });

  it('maps a fixed_amount allocation onto allocated_amount with a null percentage (no double-counting risk, matches evaluateAllocation()\'s existing treatment)', () => {
    const candidate: GoalAllocationCandidate = {
      goalId: 'goal-2',
      investmentPositionId: 'pos-2',
      allocationType: 'fixed_amount',
      allocationValue: 15000,
      source: 'user',
    };
    const payload = deriveGoalFundingSourcePayload(candidate, 'inv-2');
    expect(payload.allocation_percentage).toBeNull();
    expect(payload.allocated_amount).toBe(15000);
  });

  it('maps a residual allocation onto neither a percentage nor an amount (goal-side-only concept)', () => {
    const candidate: GoalAllocationCandidate = {
      goalId: 'goal-3',
      investmentPositionId: 'pos-3',
      allocationType: 'residual',
      allocationValue: null,
      source: 'system_suggested',
    };
    const payload = deriveGoalFundingSourcePayload(candidate, 'inv-3');
    expect(payload.allocation_percentage).toBeNull();
    expect(payload.allocated_amount).toBe(0);
  });

  it('always sets is_active true and source_type investment for a new allocation', () => {
    const candidate: GoalAllocationCandidate = {
      goalId: 'goal-4',
      investmentPositionId: 'pos-4',
      allocationType: 'percentage',
      allocationValue: 100,
      source: 'user',
    };
    const payload = deriveGoalFundingSourcePayload(candidate, 'inv-4');
    expect(payload.is_active).toBe(true);
    expect(payload.source_type).toBe('investment');
  });
});
