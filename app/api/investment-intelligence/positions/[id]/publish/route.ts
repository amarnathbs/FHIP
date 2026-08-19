import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { computePublicationTarget, publishPositionStructural } from '@/lib/services/investment-intelligence/publishing';

// STRUCTURAL ONLY — proves the ii_fhip_publications mechanism (routing +
// dedup constraint) works, but never writes into assets/investments/
// retirement_accounts (spec section 33, acceptance checklist "no active
// FHIP publication implemented"). [id] is an ii_holding_snapshots.id
// (a canonical_position_id) owned by the caller.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const { data: snapshot, error: snapErr } = await supabase
    .from('ii_holding_snapshots')
    .select('id, account_id, instrument_id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (snapErr) return bad(snapErr.message);
  if (!snapshot) return bad('Position not found', 404);

  const [{ data: account }, { data: instrument }] = await Promise.all([
    supabase.from('ii_accounts').select('account_type').eq('id', snapshot.account_id).eq('user_id', user.id).maybeSingle(),
    supabase.from('ii_instruments').select('instrument_class').eq('id', snapshot.instrument_id).maybeSingle(),
  ]);
  if (!account || !instrument) return bad('Position references a missing account/instrument', 409);

  const target = computePublicationTarget(instrument.instrument_class, account.account_type);
  const result = await publishPositionStructural({ userId: user.id, canonicalPositionId: id, publicationTarget: target });
  if (result.error) return bad(result.error, 500);
  return ok({ publicationId: result.publicationId, publicationTarget: target, note: 'Structural R1 publication only — no assets/investments/retirement_accounts row was created or updated.' });
}
