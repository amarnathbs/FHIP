// Premium grants — CURRENT-MONTH expiry summary (admin grants and promo-code
// entitlements that EXPIRED this month, and those EXPIRING in the rest of this
// month), filterable by source.
//
// Capability: requirePremiumEntitlementAdmin(); the RPC re-checks it in the
// database. There is deliberately NO export (CSV/PDF) of this list: Admin
// Architecture Standard §11 requires an approved operational purpose, explicit
// export roles, audited generation/download and spreadsheet-injection handling
// before any export of personal data (this list carries emails), and none of
// that has been specified or approved. On-screen only.

import { adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { requirePremiumEntitlementAdmin } from '@/lib/services/premiumEntitlementAdmin';
import { callExpirySummary, mapEntitlementRpcError } from '@/lib/services/premiumGrantAdmin';
import { utcToday } from '@/lib/services/entitlementWindow';
import { createClient } from '@/lib/supabase/server';
import { ok, bad } from '@/lib/api';

export const dynamic = 'force-dynamic';

interface SummaryRow {
  entitlement_source: 'admin_grant' | 'promo_code';
  bucket: 'expired_this_month' | 'expiring_this_month';
}

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requirePremiumEntitlementAdmin();
  if (forbidden) return forbidden;

  const sourceParam = new URL(req.url).searchParams.get('source');
  if (sourceParam !== null && sourceParam !== 'admin_grant' && sourceParam !== 'promo_code') {
    return bad('source must be admin_grant or promo_code.', 422, 'ENTITLEMENT_FILTER_INVALID');
  }

  const supabase = await createClient();
  const { data, error } = await callExpirySummary(supabase, sourceParam);
  if (error) {
    const mapped = mapEntitlementRpcError(error);
    if (mapped) return bad(mapped.message, mapped.status, mapped.code);
    return safeDbError(error, 'admin entitlements expiry summary');
  }

  const rows = (data ?? []) as SummaryRow[];
  const count = (bucket: SummaryRow['bucket'], source?: SummaryRow['entitlement_source']) =>
    rows.filter((r) => r.bucket === bucket && (!source || r.entitlement_source === source)).length;
  const today = utcToday();
  return ok({
    as_of: today,
    month: today.slice(0, 7),
    source: sourceParam,
    counts: {
      expired_this_month: count('expired_this_month'),
      expiring_this_month: count('expiring_this_month'),
      by_source: {
        admin_grant: { expired: count('expired_this_month', 'admin_grant'), expiring: count('expiring_this_month', 'admin_grant') },
        promo_code: { expired: count('expired_this_month', 'promo_code'), expiring: count('expiring_this_month', 'promo_code') },
      },
    },
    rows,
  });
});
