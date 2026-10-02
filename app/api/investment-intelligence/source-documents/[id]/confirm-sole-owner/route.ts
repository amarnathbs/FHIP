import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { confirmSoleOwner } from '@/lib/services/investment-intelligence/documentOwner';

// POST /api/investment-intelligence/source-documents/:id/confirm-sole-owner
//
// The statement printed a JOINT holding, but the user chose a single owner at
// upload and the holdings were filed under that owner. This is the user's
// explicit "this is not joint": it dismisses the advisory warning for the listed
// folios (and keeps it dismissed on reprocess). It does not change any account's
// owner. Use the Review / Resolutions owner dialog to make a folio genuinely joint.
const bodySchema = z.object({ accountIds: z.array(z.string().uuid()).min(1).max(200) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badValidation(parsed.error, 422);
  const result = await confirmSoleOwner(user.id, id, parsed.data.accountIds);
  if (!result.ok) return bad(result.message, result.status, 'sole_owner_not_confirmed');
  return ok({ acknowledgedAccountIds: result.acknowledged, remainingWarnings: result.remainingWarnings });
}
