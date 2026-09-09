import { requireCountryConfirmedUser as requireUser, bad } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { loadSmsfFundReportBundle } from '@/lib/services/smsfReportData';
import { currentSmsfFinancialYear, recentSmsfFinancialYears } from '@/lib/engines/smsf/smsfReportingPeriod';
import { buildSmsfAccountantExportCsv } from '@/lib/services/smsfExport';

// GET /api/smsf/[id]/export?period=FY2025-26
//
// LR-6 (WP-09/WP-10) — structured CSV accountant/auditor export for one SMSF
// fund. Same ownership enforcement and same period semantics as
// /api/smsf/[id]/report (see that route's header) — this route builds its
// export from the identical bundle rather than a second, divergent
// computation, which is exactly what NEG-04 ("export totals differ from
// UI") exists to prevent: the UI's Reports tab and this CSV always read the
// same loadSmsfFundReportBundle() call.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const { data: bundle, error } = await loadSmsfFundReportBundle(id, user.id, supabase);
  if (error || !bundle) return bad(error?.message ?? 'not found', 404);

  const url = new URL(req.url);
  const requestedLabel = url.searchParams.get('period');
  const available = recentSmsfFinancialYears(5);
  const period = available.find((p) => p.label === requestedLabel) ?? currentSmsfFinancialYear();

  const csv = buildSmsfAccountantExportCsv(bundle, period);
  const fileName = `smsf-${bundle.fund.fund_name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${period.label}.csv`;

  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}
