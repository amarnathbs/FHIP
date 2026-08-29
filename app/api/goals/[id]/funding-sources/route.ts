import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { goalFundingSourceSchema } from '@/lib/validation/goalFundingSource';
import { checkFundingAllocation, resolveAllocatedAmount, assertOwnsGoal, assertOwnsFundingTarget } from '@/lib/services/goalFundingAllocation';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('goal_funding_sources')
    .select('*')
    .eq('goal_id', id)
    .eq('user_id', user.id)
    .eq('is_active', true);
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = goalFundingSourceSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  // Education/Children Investment -> Goal Linkage, spec s.60-61: verify the
  // goal itself, and whichever balance is being linked, are both actually
  // owned by the caller BEFORE any write is attempted. This route
  // previously inserted goal_id=id (the path param) with no ownership check
  // at all — a real gap matching the class of defect fixed for Property<->
  // Liability Linking (spec s.60's own precedent). Migration 0092 also adds
  // a database-layer trigger as defense in depth; this is the clean
  // application-layer rejection so a forged request gets a normal 404
  // instead of a raw Postgres error.
  const goalOwnershipError = await assertOwnsGoal(user.id, id);
  if (goalOwnershipError) return bad(goalOwnershipError, 404);
  const targetOwnershipError = await assertOwnsFundingTarget(user.id, {
    linkedAssetId: parsed.data.linked_asset_id,
    linkedInvestmentId: parsed.data.linked_investment_id,
    linkedRetirementId: parsed.data.linked_retirement_id,
  });
  if (targetOwnershipError) return bad(targetOwnershipError, 404);

  const check = await checkFundingAllocation(user.id, {
    linkedAssetId: parsed.data.linked_asset_id,
    linkedInvestmentId: parsed.data.linked_investment_id,
    linkedRetirementId: parsed.data.linked_retirement_id,
    allocationPercentage: parsed.data.allocation_percentage,
  });
  if (!check.ok) return bad(check.error!, 409);

  const allocatedAmount = await resolveAllocatedAmount(user.id, {
    sourceType: parsed.data.source_type,
    linkedAssetId: parsed.data.linked_asset_id,
    linkedInvestmentId: parsed.data.linked_investment_id,
    linkedRetirementId: parsed.data.linked_retirement_id,
    allocationPercentage: parsed.data.allocation_percentage,
    allocatedAmount: parsed.data.allocated_amount,
  });

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('goal_funding_sources')
    .insert({ ...parsed.data, allocated_amount: allocatedAmount, goal_id: id, user_id: user.id })
    .select()
    .single();
  return error ? bad(error.message) : ok(data);
}
