// Benchmark Data - upload help text and limits. Capability `view`. Static content.
import { ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { DEFAULT_LIMITS, UPLOAD_HELP_SECTIONS } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import { guarded } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async () => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  return ok({ sections: UPLOAD_HELP_SECTIONS, limits: DEFAULT_LIMITS });
});
