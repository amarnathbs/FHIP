import { createAdminClient } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';

// R9_GOAL_ALLOCATION_CONTRACT.md — pure attribution/aggregation over the
// EXISTING canonical `investments` and `goal_funding_sources` tables. This
// module computes NO new financial truth (spec sections 6, 24, 25): it
// reads the current_value FHIP/Investment-Intelligence publishing already
// wrote and the allocation_percentage the existing <=100%-capped
// goal_funding_sources mechanism already enforces, and multiplies. The
// result is an ANALYTICAL ATTRIBUTION view, never a second balance (spec
// section 25 — "Goal allocation is analytical attribution. It must NOT
// create another asset balance.").
//
// Every read here is pagination-safe (spec sections 78-79, 92, 116, 120) —
// PostgREST's default/implicit row cap is 1000; fetchAllPages() loops with
// .range() until a page returns fewer rows than the page size, so a result
// that depends on row 1001+ is never silently truncated.

const PAGE_SIZE = 500;

async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await build(from, to);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

export interface InvestmentRow {
  id: string;
  current_value: number;
  currency_code: string;
  source_type: string;
  is_active: boolean;
}

export interface FundingSourceRow {
  id: string;
  goal_id: string;
  linked_investment_id: string | null;
  allocation_percentage: number | null;
  allocated_amount: number;
  is_active: boolean;
}

export async function fetchAllInvestments(userId: string, client?: SupabaseClient): Promise<InvestmentRow[]> {
  const db = client ?? createAdminClient();
  return fetchAllPages<InvestmentRow>((from, to) =>
    db
      .from('investments')
      .select('id, current_value, currency_code, source_type, is_active')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(from, to)
  );
}

export async function fetchAllInvestmentFundingSources(userId: string, client?: SupabaseClient): Promise<FundingSourceRow[]> {
  const db = client ?? createAdminClient();
  return fetchAllPages<FundingSourceRow>((from, to) =>
    db
      .from('goal_funding_sources')
      .select('id, goal_id, linked_investment_id, allocation_percentage, allocated_amount, is_active')
      .eq('user_id', userId)
      .eq('source_type', 'investment')
      .eq('is_active', true)
      .not('linked_investment_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to)
  );
}

export interface PerInvestmentAttribution {
  investmentId: string;
  currentValue: number;
  currencyCode: string;
  sourceType: string;
  allocatedPct: number; // sum of active percentage allocations against this investment, across all goals (deterministically <=100 under the enforced cap — see note below)
  allocatedValue: number; // currentValue * allocatedPct/100, plus any fixed-amount allocations, capped at currentValue
  unallocatedValue: number; // currentValue - allocatedValue, floored at 0
  goalIds: string[];
}

// The cap enforced by checkFundingAllocation() is applied AT WRITE TIME,
// per (user, linked_investment_id) — so summing allocation_percentage
// across every active funding source referencing the same investment here
// is expected to total <=100 for any investment whose allocations were all
// created/updated through the R9-fixed write path. This function does not
// itself re-enforce the cap; it is a read-side aggregation used by the
// Review Centre to DETECT any pre-existing violation (see
// reviewCentre.ts's over-allocation detection), which is why it reports the
// raw summed percentage rather than silently clamping it.
export function attributeInvestments(investments: InvestmentRow[], fundingSources: FundingSourceRow[]): PerInvestmentAttribution[] {
  const byInvestment = new Map<string, FundingSourceRow[]>();
  for (const fs of fundingSources) {
    if (!fs.linked_investment_id) continue;
    const list = byInvestment.get(fs.linked_investment_id) ?? [];
    list.push(fs);
    byInvestment.set(fs.linked_investment_id, list);
  }

  return investments.map((inv) => {
    const sources = byInvestment.get(inv.id) ?? [];
    const allocatedPct = sources.reduce((sum, s) => sum + (s.allocation_percentage ?? 0), 0);
    const fixedAmount = sources.reduce((sum, s) => sum + (s.allocation_percentage === null ? s.allocated_amount || 0 : 0), 0);
    const pctValue = inv.current_value * (Math.min(allocatedPct, 100) / 100);
    const allocatedValue = Math.min(pctValue + fixedAmount, inv.current_value);
    return {
      investmentId: inv.id,
      currentValue: inv.current_value,
      currencyCode: inv.currency_code,
      sourceType: inv.source_type,
      allocatedPct,
      allocatedValue,
      unallocatedValue: Math.max(inv.current_value - allocatedValue, 0),
      goalIds: [...new Set(sources.map((s) => s.goal_id))],
    };
  });
}

export interface GoalAllocatedValue {
  goalId: string;
  allocatedValue: number;
  currencyCode: string | null; // null when a goal's linked investments span more than one currency and no cross-border conversion input is supplied — callers must use canonical FX (spec section 21/22), never invent one here
}

// Goal-linked current value (spec section 23):
//   Goal-linked current value = Sigma(Investment current value x active goal allocation)
// Grouped by goal_id, across whichever investments are actively allocated
// to it (spec section 15 — many-to-many).
export function computeGoalLinkedValues(investments: InvestmentRow[], fundingSources: FundingSourceRow[]): GoalAllocatedValue[] {
  const investmentById = new Map(investments.map((i) => [i.id, i]));
  const byGoal = new Map<string, { total: number; currencies: Set<string> }>();
  for (const fs of fundingSources) {
    if (!fs.linked_investment_id) continue;
    const inv = investmentById.get(fs.linked_investment_id);
    if (!inv) continue; // investment no longer active/visible — excluded, never fabricated
    const share = fs.allocation_percentage !== null ? inv.current_value * (fs.allocation_percentage / 100) : fs.allocated_amount;
    const entry = byGoal.get(fs.goal_id) ?? { total: 0, currencies: new Set<string>() };
    entry.total += share;
    entry.currencies.add(inv.currency_code);
    byGoal.set(fs.goal_id, entry);
  }
  return [...byGoal.entries()].map(([goalId, { total, currencies }]) => ({
    goalId,
    allocatedValue: total,
    currencyCode: currencies.size === 1 ? [...currencies][0] : null,
  }));
}

export interface PortfolioAllocationSummary {
  totalValue: number;
  allocatedValue: number;
  unallocatedValue: number;
  perInvestment: PerInvestmentAttribution[];
}

export async function computePortfolioAllocationSummary(userId: string, client?: SupabaseClient): Promise<PortfolioAllocationSummary> {
  const [investments, fundingSources] = await Promise.all([fetchAllInvestments(userId, client), fetchAllInvestmentFundingSources(userId, client)]);
  const perInvestment = attributeInvestments(investments, fundingSources);
  const totalValue = perInvestment.reduce((sum, i) => sum + i.currentValue, 0);
  const allocatedValue = perInvestment.reduce((sum, i) => sum + i.allocatedValue, 0);
  return { totalValue, allocatedValue, unallocatedValue: Math.max(totalValue - allocatedValue, 0), perInvestment };
}
