import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { goalFundingSourceSchema } from '@/lib/validation/goalFundingSource';
import { checkFundingAllocation, resolveAllocatedAmount, assertOwnsFundingTarget } from '@/lib/services/goalFundingAllocation';

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; sourceId: string }> }) {
  const { sourceId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = goalFundingSourceSchema.partial().safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  // Education/Children Investment -> Goal Linkage, spec s.60-61: re-pointing
  // a funding source at a different linked_asset_id/linked_investment_id/
  // linked_retirement_id must be ownership-checked the same as creating one
  // — this PATCH previously had no such check at all.
  if (parsed.data.linked_asset_id !== undefined || parsed.data.linked_investment_id !== undefined || parsed.data.linked_retirement_id !== undefined) {
    const targetOwnershipError = await assertOwnsFundingTarget(user.id, {
      linkedAssetId: parsed.data.linked_asset_id,
      linkedInvestmentId: parsed.data.linked_investment_id,
      linkedRetirementId: parsed.data.linked_retirement_id,
    });
    if (targetOwnershipError) return bad(targetOwnershipError, 404);
  }

  if (parsed.data.allocation_percentage !== undefined) {
    const check = await checkFundingAllocation(
      user.id,
      {
        linkedAssetId: parsed.data.linked_asset_id,
        linkedInvestmentId: parsed.data.linked_investment_id,
        linkedRetirementId: parsed.data.linked_retirement_id,
        allocationPercentage: parsed.data.allocation_percentage,
      },
      sourceId
    );
    if (!check.ok) return bad(check.error!, 409);
  }

  const patch: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  if (parsed.data.allocation_percentage !== undefined) {
    patch.allocated_amount = await resolveAllocatedAmount(user.id, {
      sourceType: parsed.data.source_type ?? 'manual',
      linkedAssetId: parsed.data.linked_asset_id,
      linkedInvestmentId: parsed.data.linked_investment_id,
      linkedRetirementId: parsed.data.linked_retirement_id,
      allocationPercentage: parsed.data.allocation_percentage,
      allocatedAmount: parsed.data.allocated_amount ?? 0,
    });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('goal_funding_sources')
    .update(patch)
    .eq('id', sourceId)
    .eq('user_id', user.id)
    .select()
    .single();
  return error ? bad(error.message) : ok(data);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; sourceId: string }> }) {
  const { sourceId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { error } = await supabase
    .from('goal_funding_sources')
    .update({ is_active: false })
    .eq('id', sourceId)
    .eq('user_id', user.id);
  return error ? bad(error.message) : ok({ archived: true });
}
