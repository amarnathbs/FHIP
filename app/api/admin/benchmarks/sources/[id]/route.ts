import { requireAdmin, adminClient, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';

// Admin A0.2 Wave 3: this route previously spread the entire request body
// verbatim into the update ({...body}), so any extra key a caller included
// (created_by, created_at, id, approved_by, ...) would be written to the
// row unfiltered. It also had no Admin UI caller at all (BACKEND_WITHOUT_UI
// — see the Wave 3 discovery register), which is why the defect was never
// exercised. Both are fixed together: a named field allow-list (matching
// the Standard §6/§11 allow-list discipline already used elsewhere in this
// codebase) and a wired "Approve" / "Suspend" / "Reinstate" affordance on
// the Sources tab (components/admin/AdminBenchmarksClient.tsx).
const WRITABLE_FIELDS = [
  'source_name',
  'source_type',
  'publisher',
  'source_title',
  'country_code',
  'publication_date',
  'reference_period_start',
  'reference_period_end',
  'source_location',
  'licence_type',
  'citation_text',
  'methodology_notes',
  'quality_rating',
  'status',
] as const;

const VALID_STATUSES = ['draft', 'under_review', 'approved', 'active', 'superseded', 'suspended', 'archived'];

export const PUT = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const { user, forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));

  if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
    return bad(`status must be one of: ${VALID_STATUSES.join(', ')}`, 422);
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const field of WRITABLE_FIELDS) {
    if (body[field] !== undefined) patch[field] = body[field];
  }
  if (body.status === 'approved') {
    patch.approved_by = user!.id;
    patch.approved_at = new Date().toISOString();
  }

  const { data, error } = await adminClient().from('benchmark_sources').update(patch).eq('id', id).select('*').single();
  return error ? bad(error.message) : ok(data);
});
