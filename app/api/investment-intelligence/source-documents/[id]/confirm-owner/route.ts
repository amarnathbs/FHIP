import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { confirmOwnerChange } from '@/lib/services/investment-intelligence/documentOwner';

// POST /api/investment-intelligence/source-documents/:id/confirm-owner
//
// Owner-before-upload (PO decision 2): when a statement's folio already exists
// under a DIFFERENT owner, processing keeps that owner and records the
// difference on the document. This is the user's EXPLICIT confirmation that the
// folios listed should take the owner chosen at upload. Without this call the
// accounts' owners never change.
//
// It can only change accounts that are recorded as owner conflicts on THIS
// document and belong to the caller -- it is not a way to re-own an arbitrary
// account (use PATCH /accounts/:id/owner for a deliberate single-member change).
//
// PER FOLIO (PO-OBU-05): the body lists exactly the folios the user ticked and echoes
// the target owner they were shown (`targetSignature`). The system never assumes every
// folio of a CAS shares the uploaded owner: unlisted folios are not touched, and each
// change is audited on its own.
const bodySchema = z.object({ accountIds: z.array(z.string().uuid()).min(1).max(200), targetSignature: z.string().min(1).max(2000) }).strict();

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badValidation(parsed.error, 422);

  const result = await confirmOwnerChange(user.id, id, parsed.data.accountIds, parsed.data.targetSignature);
  if (!result.ok) return bad(result.message, result.status, 'owner_change_not_applied');
  return ok({ changedAccountIds: result.changed, remainingConflicts: result.remainingConflicts });
}
