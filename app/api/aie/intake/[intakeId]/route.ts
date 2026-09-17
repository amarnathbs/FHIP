import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';

// GET /api/aie/intake/{intakeId} — a privacy-safe status summary (API-03:
// "status/summary endpoints reveal no protected evidence by default").
// Uses the normal RLS-scoped client (never the service-role client) so
// ownership is enforced by Postgres itself, not by an application-level
// check that could be gotten wrong.
export async function GET(_req: Request, { params }: { params: Promise<{ intakeId: string }> }) {
  const { intakeId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const { data: intake, error } = await supabase
    .from('aie_document_intake')
    .select('id, status, declared_mime_type, detected_mime_type, byte_size, display_filename, source_module_hint, rejection_reason, created_at, updated_at')
    .eq('id', intakeId)
    .maybeSingle();
  if (error) return bad('could not load intake', 500);
  if (!intake) return bad('intake not found', 404);

  const { data: runs } = await supabase
    .from('aie_extraction_run')
    .select('id, run_number, status, ai_used, deterministic_outcome, started_at, completed_at')
    .eq('intake_id', intakeId)
    .order('run_number', { ascending: false });

  return ok({ intake, runs: runs ?? [] });
}
