// Market Index Data - cancel an unpublished job (deletes its staged copy). Any of upload/publish/correct;
// the database additionally restricts it to the staging admin or a publisher/corrector.
import { ok } from '@/lib/api';
import { adminRoute } from '@/lib/services/adminAuth';
import { cancelBenchmarkImport } from '@/lib/services/investment-intelligence/benchmarkData/publishService';
import { requireBenchmarkCapability, type BenchmarkCapability } from '@/lib/services/investment-intelligence/benchmarkData/guards';
import { idParam } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

export const POST = adminRoute(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const id = await idParam(params);
  // Unauthenticated callers must get 401 even for a malformed id, so guard first.
  let last: Response | null = null;
  for (const cap of ['upload', 'publish', 'correct'] as BenchmarkCapability[]) {
    const r = await requireBenchmarkCapability(cap);
    if (!r.forbidden) {
      if (!id.ok) return id.response;
      const outcome = await cancelBenchmarkImport(await createClient(), id.id);
      if (outcome.status === 'failed') return Response.json({ error: outcome.message, code: outcome.kind }, { status: outcome.httpStatus });
      return ok(outcome);
    }
    last = r.forbidden;
    if (r.forbidden.status === 401) return r.forbidden;
  }
  return last as Response;
});
