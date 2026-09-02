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

  const admin = adminClient();

  const { data: before, error: beforeErr } = await admin.from('benchmark_sources').select('status').eq('id', id).maybeSingle();
  if (beforeErr) return bad(beforeErr.message);
  if (!before) return bad('Benchmark source not found.', 404);

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const field of WRITABLE_FIELDS) {
    if (body[field] !== undefined) patch[field] = body[field];
  }
  if (body.status === 'approved') {
    patch.approved_by = user!.id;
    patch.approved_at = new Date().toISOString();
  }

  const { data, error } = await admin.from('benchmark_sources').update(patch).eq('id', id).select('*').single();
  if (error) return bad(error.message);

  // Admin A0.2 Wave 4 (spec §9, priorities 2/4): every status-changing
  // action on a benchmark source (approve/suspend/reinstate) now produces
  // immutable audit evidence, mirroring the sibling dataset lifecycle
  // (datasets/[id]/activate, migration 0011) rather than leaving this as
  // the one Benchmarks lifecycle action with zero audit trail. Recorded
  // only when the status actually changed — an edit to a non-status field
  // (e.g. methodology_notes) is not itself a lifecycle event and does not
  // need one (see the audit inventory: AUDIT_NOT_REQUIRED for non-status
  // field edits, AUDITED_COMPLETE for status transitions).
  if (body.status !== undefined && body.status !== before.status) {
    const { error: auditErr } = await admin.from('benchmark_update_runs').insert({
      source_id: id,
      dataset_id: null,
      approval_status: body.status,
      previous_version: before.status,
      new_version: body.status,
      audit_user: user!.id,
    });
    // Audit failure must never be reported as if the underlying status
    // change failed — the write above already committed. Log and continue
    // (same "log, don't fail the business result" discipline already used
    // for the Resources version-snapshot failure path in
    // app/api/admin/resources/content/[id]/workflow/route.ts).
    if (auditErr) console.error('Benchmark source audit-log insert error:', auditErr);
  }

  return ok(data);
});
