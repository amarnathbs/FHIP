import { createClient } from '@/lib/supabase/server';

export interface FundingSourceCandidate {
  linkedAssetId?: string | null;
  linkedInvestmentId?: string | null;
  linkedRetirementId?: string | null;
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
  const linkedId = candidate.linkedAssetId ?? candidate.linkedInvestmentId ?? candidate.linkedRetirementId ?? null;
  const pct = candidate.allocationPercentage ?? null;
  if (!linkedId || pct === null) {
    // Manual/expected/unlinked sources and fixed-amount allocations (no
    // percentage against a shared balance) carry no double-counting risk.
    return { ok: true, existingAllocatedPct: 0, wouldBeTotalPct: pct ?? 0 };
  }

  const supabase = await createClient();
  const column = candidate.linkedAssetId ? 'linked_asset_id' : candidate.linkedInvestmentId ? 'linked_investment_id' : 'linked_retirement_id';
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

// Forecasting P1 fix FHIP-FC-GOAL-001 — a goal funded (wholly or partly) by
// an allocated share of a linked investment's/retirement account's own
// recurring contribution previously forecasted with $0/month required,
// because nothing ever multiplied the linked record's contribution by the
// funding source's allocation_percentage. This sums that flow across every
// active funding source for one goal — callers add the result on top of
// user_goals.planned_contribution_amount before it reaches a forecast
// calculator; it is NOT written back to plannedContributionAmount's own
// display value, which stays "what the user directly plans to contribute".
export interface AllocatedContributionFundingSource {
  sourceType: string;
  linkedInvestmentId: string | null;
  linkedRetirementId: string | null;
  allocationPercentage: number | null;
}
export interface AllocatedContributionInvestment {
  annualContribution: number | null;
}
export interface AllocatedContributionRetirementAccount {
  employerContribution: number | null;
  personalContribution: number | null;
  contributionFrequency: string | null;
}

const RETIREMENT_CONTRIBUTION_FREQUENCY_TO_MONTHLY: Record<string, number> = {
  weekly: 52 / 12,
  fortnightly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  annually: 1 / 12,
};

export function computeAllocatedMonthlyContribution(
  fundingSources: AllocatedContributionFundingSource[],
  investmentsById: Map<string, AllocatedContributionInvestment>,
  retirementAccountsById: Map<string, AllocatedContributionRetirementAccount>
): number {
  let total = 0;
  for (const source of fundingSources) {
    const pct = source.allocationPercentage;
    if (pct === null || pct === undefined) continue; // fixed-amount sources carry no recurring-contribution signal
    if (source.sourceType === 'investment' && source.linkedInvestmentId) {
      const inv = investmentsById.get(source.linkedInvestmentId);
      if (inv) total += ((inv.annualContribution ?? 0) / 12) * (pct / 100);
    } else if (source.sourceType === 'retirement' && source.linkedRetirementId) {
      const acc = retirementAccountsById.get(source.linkedRetirementId);
      if (acc) {
        const factor = RETIREMENT_CONTRIBUTION_FREQUENCY_TO_MONTHLY[acc.contributionFrequency ?? 'monthly'] ?? 1;
        const monthly = ((acc.employerContribution ?? 0) + (acc.personalContribution ?? 0)) * factor;
        total += monthly * (pct / 100);
      }
    }
  }
  return total;
}

// Resolves the live allocated_amount for a percentage-based funding source
// against its linked asset/investment/retirement account's current value, so
// allocations stay correct as the underlying balance changes rather than
// going stale (spec section 33 — market movement must flow through without
// a separate manual update). Retirement support added alongside the
// Education/Children Investment -> Goal Linkage release; previously only
// asset/investment were handled, leaving a percentage-based retirement
// funding source permanently frozen at its creation-time snapshot.
//
// Filtered by is_active=true (fix: archived-investment stale-funding bug,
// same class as loadLinkedContributionSources() in goalsData.ts) — an
// archived linked record resolves to a $0 snapshot rather than its last
// known value, so a POST (new link) or PATCH (allocation % change) against
// an already-archived holding can't write a stale non-zero amount into
// goal_funding_sources.allocated_amount. Un-archiving the holding and then
// triggering any PATCH that recomputes this (or simply relying on the
// live read-side computeLiveLinkedFundingValue()) resumes real numbers.
export async function resolveAllocatedAmount(
  userId: string,
  source: {
    sourceType: string;
    linkedAssetId?: string | null;
    linkedInvestmentId?: string | null;
    linkedRetirementId?: string | null;
    allocationPercentage?: number | null;
    allocatedAmount: number;
  }
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
      .eq('is_active', true)
      .maybeSingle();
    return ((data?.current_value as number) ?? 0) * (source.allocationPercentage / 100);
  }
  if (source.linkedInvestmentId) {
    const { data } = await supabase
      .from('investments')
      .select('current_value')
      .eq('id', source.linkedInvestmentId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    return ((data?.current_value as number) ?? 0) * (source.allocationPercentage / 100);
  }
  if (source.linkedRetirementId) {
    const { data } = await supabase
      .from('retirement_accounts')
      .select('current_balance')
      .eq('id', source.linkedRetirementId)
      .eq('user_id', userId)
      .eq('is_active', true)
      .maybeSingle();
    return ((data?.current_balance as number) ?? 0) * (source.allocationPercentage / 100);
  }
  return source.allocatedAmount;
}

// ---------------------------------------------------------------------------
// Ownership assertions (Education/Children Investment -> Goal Linkage,
// spec s.60-61) — defense-in-depth at the application layer, matching the
// database-layer trigger added by migration 0092 (gfs_enforce_ownership).
// Neither layer alone is trusted: the trigger protects every write path
// including the service-role client (which bypasses RLS entirely); these
// helpers let API routes reject a forged cross-tenant reference early with
// a clean 404 instead of surfacing a raw Postgres 42501 error to the client.
// ---------------------------------------------------------------------------
export async function assertOwnsGoal(userId: string, goalId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from('user_goals').select('id').eq('id', goalId).eq('user_id', userId).maybeSingle();
  if (error) return error.message;
  if (!data) return 'Goal not found or not owned by the current user';
  return null;
}

export async function assertOwnsFundingTarget(
  userId: string,
  target: { linkedAssetId?: string | null; linkedInvestmentId?: string | null; linkedRetirementId?: string | null }
): Promise<string | null> {
  const supabase = await createClient();
  if (target.linkedAssetId) {
    const { data } = await supabase.from('assets').select('id').eq('id', target.linkedAssetId).eq('user_id', userId).maybeSingle();
    if (!data) return 'Linked asset not found or not owned by the current user';
  }
  if (target.linkedInvestmentId) {
    const { data } = await supabase.from('investments').select('id').eq('id', target.linkedInvestmentId).eq('user_id', userId).maybeSingle();
    if (!data) return 'Linked investment not found or not owned by the current user';
  }
  if (target.linkedRetirementId) {
    const { data } = await supabase.from('retirement_accounts').select('id').eq('id', target.linkedRetirementId).eq('user_id', userId).maybeSingle();
    if (!data) return 'Linked retirement account not found or not owned by the current user';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live linked-funding aggregation (spec s.26, s.32-33, s.37, s.44, s.51,
// s.77-85) — the amount an active investment/asset/retirement-linked
// funding source currently contributes toward its goal, recomputed from
// live current values rather than the stale creation-time snapshot stored
// in goal_funding_sources.allocated_amount. This is purely a READ-time
// projection: it never writes back to goal_funding_sources or to
// user_goals.current_amount (the manual/confirmed-contribution ledger,
// kept in sync transactionally by the contributions API — see
// goalsData.ts's own comment on loadFundingSourcesByGoal). Adding this on
// top of that ledger is therefore additive and backward-compatible: a goal
// funded purely by manual contributions is completely unaffected; a goal
// with an investment/asset/retirement-linked funding source now also gets
// credit for that link without requiring the user to separately log a
// contribution event for the same money (spec s.33's explicit requirement).
export interface LiveLinkedFundingSource {
  sourceType: string;
  linkedAssetId: string | null;
  linkedInvestmentId: string | null;
  linkedRetirementId: string | null;
  allocationPercentage: number | null;
  allocatedAmount: number;
}
export function computeLiveLinkedFundingValue(
  fundingSources: LiveLinkedFundingSource[],
  currentValueById: Map<string, number>
): number {
  let total = 0;
  for (const source of fundingSources) {
    if (!['investment', 'asset', 'retirement'].includes(source.sourceType)) continue; // manual/cash/expected carry no live-value signal
    const linkedId = source.linkedInvestmentId ?? source.linkedAssetId ?? source.linkedRetirementId ?? null;
    if (!linkedId) continue;
    if (source.allocationPercentage !== null && source.allocationPercentage !== undefined) {
      // Percentage-based: recompute live against the linked record's current value (spec s.33).
      const currentValue = currentValueById.get(linkedId) ?? 0;
      total += currentValue * (source.allocationPercentage / 100);
    } else {
      // Fixed-amount: a committed dollar figure independent of the linked balance's
      // later movement (spec s.44's fixed-allocation semantics) — use the stored value.
      total += source.allocatedAmount;
    }
  }
  return total;
}
