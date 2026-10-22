import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { recertifyPosition } from '@/lib/services/investment-intelligence/documentProcessing';

// Document2 (4) WP-B (F7) -- "Re-evaluate all positions" / "Rebuild from retained structured data".
//
// Re-runs the certification decision for every position this statement produced, from what is retained in the database
// (holding snapshots, transactions, owners, open cases). It never reads the raw statement file, so it works after the file
// has been deleted. It changes no holding or transaction; only each position's Portfolio Truth status is recomputed.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const { data: doc } = await supabase.from('ii_source_documents').select('id').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!doc) return bad('Statement not found.', 404);

  const admin = createAdminClient();
  const { data: snapshots, error } = await admin.from('ii_holding_snapshots').select('account_id, instrument_id').eq('user_id', user.id).eq('source_document_id', id);
  if (error) return bad(error.message, 500);
  const positions = [...new Map(((snapshots ?? []) as { account_id: string; instrument_id: string }[]).map((p) => [`${p.account_id}:${p.instrument_id}`, p] as const)).values()];
  if (positions.length === 0) return ok({ evaluated: 0, failed: 0, message: 'No positions were recorded for this statement, so there is nothing to re-evaluate.' });

  let evaluated = 0;
  let failed = 0;
  for (const p of positions) {
    const r = await recertifyPosition(user.id, p.account_id, p.instrument_id);
    if (r.ok) evaluated += 1;
    else failed += 1;
  }
  return ok({ evaluated, failed });
}
