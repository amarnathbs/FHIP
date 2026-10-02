// Market Index Data - upload templates (static example CSVs). Capability `view`. No data is read.
import { bad } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { BENCHMARK_UPLOAD_TEMPLATES } from '@/lib/services/investment-intelligence/benchmarkData/fileIngest';
import { csvResponse, guarded } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async (_req: Request, { params }: { params: Promise<{ name: string }> }) => {
  const g = await guarded('view');
  if (!g.ok) return g.response;
  const { name } = await params;
  const templates = BENCHMARK_UPLOAD_TEMPLATES as unknown as Record<string, { csv: string; fileName?: string }>;
  const t = Object.prototype.hasOwnProperty.call(templates, name) ? templates[name] : undefined;
  if (!t) return bad('Unknown template', 404);
  return csvResponse(t.csv, t.fileName ?? `${name}.csv`);
});
