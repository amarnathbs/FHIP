import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { getAccounts } from '@/lib/financial-data-hub/analytics/financialActivityAnalytics';
import { parseActivityParams } from '@/lib/financial-data-hub/analytics/requestParams';
import { createClient } from '@/lib/supabase/server';

// GET /api/financial-data-hub/activity/accounts — FDH-8 spec 41-43.
// Never exposes a full account number: only `masked_identifier`.
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const { period, error } = parseActivityParams(url);
  if (error) return bad(error, 400);

  try {
    const [activity, accountsResult] = await Promise.all([
      getAccounts(user.id, { period }),
      (async () => {
        const supabase = await createClient();
        return supabase
          .from('fdh_financial_accounts')
          .select('id, institution_id, account_type, display_name, masked_identifier, currency_code, status')
          .eq('user_id', user.id)
          .eq('status', 'active');
      })(),
    ]);
    if (accountsResult.error) return bad('could not list accounts', 500);

    return ok({
      period,
      household: activity.household,
      accounts: (accountsResult.data ?? []).map((a) => ({
        ...a,
        activity: activity.perAccount.filter((p) => p.accountId === a.id),
      })),
    });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'could not load accounts', 500);
  }
}
