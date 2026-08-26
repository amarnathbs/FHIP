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

  const supabase = await createClient();

  // Live-DEV verification finding (Education/Children Investment -> Goal
  // Linkage checklist item 2): when a caller PATCHes only
  // allocation_percentage (the common case — the UI never resends the
  // linked_*_id fields it isn't changing), parsed.data.linked_investment_id/
  // linked_asset_id/linked_retirement_id are all undefined. Every check below
  // previously used ONLY those (possibly-undefined) parsed fields, so
  // checkFundingAllocation() resolved linkedId to null and returned ok:true
  // unconditionally — silently skipping the <=100% cap for the single most
  // common edit path. Reproduced live against real DEV: a 50%-allocated row
  // sharing an investment with another goal's 40%-allocated row could be
  // PATCHed to 90% (total 130%) with a 200 response. Fixed the same way
  // updateGoalAllocation() in goalAllocations.ts already resolves this
  // (parsed value ?? existing row's stored value), so the cap and ownership
  // checks always evaluate against the row's REAL linked target, not just
  // whatever subset of fields this particular request happened to resend.
  const { data: existing, error: existingError } = await supabase
    .from('goal_funding_sources')
    .select('source_type, linked_asset_id, linked_investment_id, linked_retirement_id, allocated_amount')
    .eq('id', sourceId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (existingError) return bad(existingError.message);
  if (!existing) return bad('Funding source not found or not owned by the current user', 404);

  const resolvedLinkedAssetId = parsed.data.linked_asset_id !== undefined ? parsed.data.linked_asset_id : (existing.linked_asset_id as string | null);
  const resolvedLinkedInvestmentId = parsed.data.linked_investment_id !== undefined ? parsed.data.linked_investment_id : (existing.linked_investment_id as string | null);
  const resolvedLinkedRetirementId = parsed.data.linked_retirement_id !== undefined ? parsed.data.linked_retirement_id : (existing.linked_retirement_id as string | null);

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
        linkedAssetId: resolvedLinkedAssetId,
        linkedInvestmentId: resolvedLinkedInvestmentId,
        linkedRetirementId: resolvedLinkedRetirementId,
        allocationPercentage: parsed.data.allocation_percentage,
      },
      sourceId
    );
    if (!check.ok) return bad(check.error!, 409);
  }

  const patch: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  if (parsed.data.allocation_percentage !== undefined) {
    patch.allocated_amount = await resolveAllocatedAmount(user.id, {
      sourceType: parsed.data.source_type ?? (existing.source_type as string) ?? 'manual',
      linkedAssetId: resolvedLinkedAssetId,
      linkedInvestmentId: resolvedLinkedInvestmentId,
      linkedRetirementId: resolvedLinkedRetirementId,
      allocationPercentage: parsed.data.allocation_percentage,
      allocatedAmount: parsed.data.allocated_amount ?? (existing.allocated_amount as number) ?? 0,
    });
  }

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
