import { createClient } from '@/lib/supabase/server';

export interface FundingSourceCandidate {
  linkedAssetId?: string | null;
  linkedInvestmentId?: string | null;
  allocationPercentage?: number | null;
}

export interface AllocationCheckResult {
  ok: boolean;
  existingAllocatedPct: number;
  wouldBeTotalPct: number;
  error?: string;
}

// Pure decision logic, separated so it's unit-testable without a live
// Supabase client: given how much of a balance is already allocated
// elsewhere and the new candidate percentage, decide whether it fits.
export function evaluateAllocation(existingAllocatedPct: number, candidatePct: number): AllocationCheckResult {
  const wouldBeTotalPct = existingAllocatedPct + candidatePct;
  if (wouldBeTotalPct > 100) {
    return {
      ok: false,
      existingAllocatedPct,
      wouldBeTotalPct,
      error: `This balance is already ${existingAllocatedPct.toFixed(0)}% allocated to other goals — allocating another ${candidatePct.toFixed(0)}% would exceed 100%. Reduce the percentage or the existing allocations first.`,
    };
  }
  return { ok: true, existingAllocatedPct, wouldBeTotalPct };
}

// Prevents the same underlying asset/investment balance from being fully
// counted toward multiple goals: sums allocation_percentage across every
// OTHER active funding source (any goal, this user) referencing the same
// linked record, and rejects if adding the candidate would exceed 100%.
export async function checkFundingAllocation(
  userId: string,
  candidate: FundingSourceCandidate,
  excludeSourceId?: string
): Promise<AllocationCheckResult> {
  const linkedId = candidate.linkedAssetId ?? candidate.linkedInvestmentId ?? null;
  const pct = candidate.allocationPercentage ?? null;
  if (!linkedId || pct === null) {
    // Manual/expected/unlinked sources and fixed-amount allocations (no
    // percentage against a shared balance) carry no double-counting risk.
    return { ok: true, existingAllocatedPct: 0, wouldBeTotalPct: pct ?? 0 };
  }

  const supabase = await createClient();
  const column = candidate.linkedAssetId ? 'linked_asset_id' : 'linked_investment_id';
  let query = supabase
    .from('goal_funding_sources')
    .select('id, allocation_percentage')
    .eq('user_id', userId)
    .eq(column, linkedId)
    .eq('is_active', true);
  if (excludeSourceId) query = query.neq('id', excludeSourceId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const existingAllocatedPct = (data ?? []).reduce((sum, row) => sum + (Number(row.allocation_percentage) || 0), 0);
  return evaluateAllocation(existingAllocatedPct, pct);
}

// Resolves the live allocated_amount for a percentage-based funding source
// against its linked asset/investment's current value, so allocations stay
// correct as the underlying balance changes rather than going stale.
export async function resolveAllocatedAmount(
  userId: string,
  source: { sourceType: string; linkedAssetId?: string | null; linkedInvestmentId?: string | null; allocationPercentage?: number | null; allocatedAmount: number }
): Promise<number> {
  if (source.allocationPercentage === null || source.allocationPercentage === undefined) {
    return source.allocatedAmount;
  }
  const supabase = await createClient();
  if (source.linkedAssetId) {
    const { data } = await supabase
      .from('assets')
      .select('current_value')
      .eq('id', source.linkedAssetId)
      .eq('user_id', userId)
      .maybeSingle();
    return ((data?.current_value as number) ?? 0) * (source.allocationPercentage / 100);
  }
  if (source.linkedInvestmentId) {
    const { data } = await supabase
      .from('investments')
      .select('current_value')
      .eq('id', source.linkedInvestmentId)
      .eq('user_id', userId)
      .maybeSingle();
    return ((data?.current_value as number) ?? 0) * (source.allocationPercentage / 100);
  }
  return source.allocatedAmount;
}
