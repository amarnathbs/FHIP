import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { iiManualFixtureSchema } from '@/lib/validation/investment-intelligence';
import { importManualFixture } from '@/lib/services/investment-intelligence/manualImporter';

// Manual-test-importer-backed in R1, NOT a real parser
// (R1_IMPLEMENTATION_SPEC.md section 9 — explicitly documented as such).
// Developer/QA-only: the caller supplies a validated fixture body (see
// lib/fixtures/investment-intelligence/*.json for the canonical set); this
// route does not read the uploaded PDF/CSV bytes at all — no production CAS
// parsing logic exists anywhere in this codebase (non-goal).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = iiManualFixtureSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.message, 422);

  // The route path's [id] must match a real, owned ii_source_documents row
  // — this endpoint does not create a fresh document out of thin air. In
  // R1's manual-test-importer flow the fixture is self-contained and
  // creates its own document row when new; existing callers pass the id
  // they got back from POST /source-documents to keep the two steps linked.
  void id;

  const result = await importManualFixture(user.id, parsed.data);
  if (result.error) return bad(result.error, 500);
  return ok(result);
}
