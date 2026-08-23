import { requireUser, ok, bad } from '@/lib/api';
import { iiGoalAllocationUpdateSchema } from '@/lib/validation/investment-intelligence';
import { updateGoalAllocation, removeGoalAllocation } from '@/lib/services/investment-intelligence/goalAllocations';

// R9 spec section 74: PUT/DELETE /investment-intelligence/goal-allocations/:id.
// Bounded, own-row-only lifecycle operations (spec section 69) — never a
// generic table PATCH; both delegate to goalAllocations.ts which enforces
// ownership + the <=100% cap on every write.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = iiGoalAllocationUpdateSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const result = await updateGoalAllocation(
    user.id,
    id,
    { allocationType: parsed.data.allocationType, allocationValue: parsed.data.allocationValue },
    parsed.data.linkedInvestmentId ?? null
  );
  if (result.error) return bad(result.error, result.capExceeded ? 409 : 400);
  return ok({ allocationId: result.allocationId });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const result = await removeGoalAllocation(user.id, id);
  if (result.error) return bad(result.error, 400);
  return ok({ removed: true });
}
