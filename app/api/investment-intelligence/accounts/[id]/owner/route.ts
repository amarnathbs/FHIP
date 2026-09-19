import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { z } from 'zod';

// Fixes a real, previously unresolvable dead end: an 'owner_unmatched'
// reconciliation case (opened by documentProcessing.ts whenever a statement
// is uploaded with no household member specified) had NO way to actually be
// resolved -- the upload form never collects an owner, and the generic
// "Resolve" button (reconciliation-cases/[id]/resolve) only ever marks a
// case resolved without touching ii_accounts.owner_member_id at all. This
// route is the missing piece: it actually sets the account's real owner,
// then auto-resolves every open 'owner_unmatched' case for that account —
// the correction IS the resolution, not a separate manual step.
const setOwnerSchema = z.object({ ownerMemberId: z.string().uuid() });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: accountId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = setOwnerSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);

  const supabase = await createClient();

  const { data: account } = await supabase.from('ii_accounts').select('id').eq('id', accountId).eq('user_id', user.id).maybeSingle();
  if (!account) return bad('Account not found.', 404);

  // Never trust the household member id blindly -- confirm it belongs to
  // this same user before it can ever be attached to their financial data.
  const { data: member } = await supabase.from('household_members').select('id').eq('id', parsed.data.ownerMemberId).eq('user_id', user.id).maybeSingle();
  if (!member) return bad('Household member not found.', 404);

  const { error: updateErr } = await supabase.from('ii_accounts').update({ owner_member_id: parsed.data.ownerMemberId }).eq('id', accountId).eq('user_id', user.id);
  if (updateErr) return bad(updateErr.message);

  const nowIso = new Date().toISOString();
  const { data: resolvedCases, error: resolveErr } = await supabase
    .from('ii_reconciliation_cases')
    .update({
      status: 'resolved',
      resolved_at: nowIso,
      resolution_method: 'user_mapped_owner',
      resolved_by: user.id,
      resolved_by_actor_type: 'user',
    })
    .eq('user_id', user.id)
    .eq('subject_type', 'account')
    .eq('subject_id', accountId)
    .eq('discrepancy_type', 'owner_unmatched')
    .eq('status', 'open')
    .select('id');
  if (resolveErr) return bad(resolveErr.message);

  await emitAuditEvent({
    userId: user.id,
    eventType: 'user_correction',
    subjectType: 'ii_accounts',
    subjectId: accountId,
    actorType: 'user',
    actorId: user.id,
    metadata: { field: 'owner_member_id', newValue: parsed.data.ownerMemberId, resolvedCaseCount: resolvedCases?.length ?? 0 },
  });

  return ok({ accountId, ownerMemberId: parsed.data.ownerMemberId, resolvedCaseCount: resolvedCases?.length ?? 0 });
}
