// Investment Intelligence R11 — representative professional read-proxy
// endpoint (spec section 60's "professional dashboard... minimal
// workspace"). Deliberately narrow: structured, already-computed holding
// data only (account type/institution/instrument name/value/currency),
// gated live on VIEW_INVESTMENTS. NEVER touches ii_source_documents/
// storage — raw documents are unreachable from this or any professional-
// facing path (spec section 51 — VIEW_RAW_DOCUMENTS does not exist as a
// grantable scope in R11 at all, see permissions.ts).
//
// This uses the SERVICE-ROLE client deliberately (the professional is not
// the row owner, so the RLS-respecting client would correctly return
// nothing) — but only after checkAccessLive() has independently verified,
// against freshly-read rows, that this exact (professional, client, scope)
// triple is currently authorised. This is the same pattern documentProcessing.ts
// already uses for cross-user-safe service-role reads gated by an
// application-level check rather than RLS.
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkAccessLive } from '@/lib/services/professional-access/access';

export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const clientUserId = url.searchParams.get('clientUserId');
  if (!clientUserId) return bad('clientUserId query parameter is required.');

  const decision = await checkAccessLive(clientUserId, user.id, 'VIEW_INVESTMENTS');
  if (!decision.allow) return bad(decision.reason, 403);

  const admin = createAdminClient();
  const { data: accounts } = await admin.from('ii_accounts').select('id, institution_name, account_type, country_code, currency_code').eq('user_id', clientUserId).eq('status', 'active');
  const { data: snapshots } = await admin
    .from('ii_holding_snapshots')
    .select('account_id, instrument_id, as_of_date, units, value, currency_code')
    .eq('user_id', clientUserId)
    .order('as_of_date', { ascending: false });

  // Collapse to the latest snapshot per (account_id, instrument_id) —
  // identical "latest wins" reduction the client's own positions endpoint
  // uses (app/api/investment-intelligence/positions/route.ts), reused here
  // rather than re-derived, so a professional sees the SAME canonical
  // positions the client sees, never a separately-computed view.
  const latestByPosition = new Map<string, NonNullable<typeof snapshots>[number]>();
  for (const row of snapshots ?? []) {
    const key = `${row.account_id}:${row.instrument_id}`;
    const existing = latestByPosition.get(key);
    if (!existing || (row.as_of_date as string) > (existing.as_of_date as string)) latestByPosition.set(key, row);
  }

  return ok({
    accounts: accounts ?? [],
    positions: Array.from(latestByPosition.values()),
  });
}
