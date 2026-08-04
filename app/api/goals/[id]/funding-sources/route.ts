import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { goalFundingSourceSchema } from '@/lib/validation/goalFundingSource';
import { checkFundingAllocation, resolveAllocatedAmount } from '@/lib/services/goalFundingAllocation';

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

  const check = await checkFundingAllocation(user.id, {
    linkedAssetId: parsed.data.linked_asset_id,
    linkedInvestmentId: parsed.data.linked_investment_id,
    allocationPercentage: parsed.data.allocation_percentage,
  });
  if (!check.ok) return bad(check.error!, 409);

  const allocatedAmount = await resolveAllocatedAmount(user.id, {
    sourceType: parsed.data.source_type,
    linkedAssetId: parsed.data.linked_asset_id,
    linkedInvestmentId: parsed.data.linked_investment_id,
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
