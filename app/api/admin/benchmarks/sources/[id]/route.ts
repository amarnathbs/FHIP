import { requireAdmin, adminClient, adminRoute, safeDbError } from '@/lib/services/adminAuth';
import { createClient } from '@/lib/supabase/server';
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

// Admin A0.2 Wave 4, Round 2 (Product Owner remediation): the "critical
// defect" flagged against Round 1's implementation — commit the status
// mutation, THEN attempt the audit insert, then log-and-swallow an audit
// failure while still reporting business success — is fixed by making the
// status transition itself go through public.admin_transition_benchmark_source
// (migration 0125), a single atomic Pattern A RPC. There is no longer any
// application-level "update, then separately insert" sequence for a status
// change: if the audit insert fails inside the RPC for any reason, the
// ENTIRE transaction (including the benchmark_sources UPDATE) rolls back,
// and the RPC call itself raises — so this route can never return success
// for a status change whose audit evidence didn't also commit. Real,
// PGlite-Postgres-verified proof of this (including a genuine forced
// audit-insert failure) lives in
// scripts/admin_a02_wave4_benchmark_source_certification.mjs, Section 3.
//
// Called via the CALLER's own authenticated session (createClient(), never
// the service-role adminClient()) — Pattern A's whole point is that
// auth.uid() inside the function resolves to the real signed-in caller, not
// a service-role context with no caller identity at all. requireAdmin() is
// still called first as defence-in-depth (Standard §4: every layer enforces
// independently) even though the RPC re-checks admin_users itself.
async function callTransitionRpc(sourceId: string, newStatus: string): Promise<{ data: unknown; error: null } | { data: null; error: Response }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('admin_transition_benchmark_source', {
    p_source_id: sourceId,
    p_new_status: newStatus,
  });

  if (!error) return { data, error: null };

  // Gate G6: map to stable, safe result states — never the raw
  // PostgREST/Postgres message (which can name internal tables, columns or
  // constraints). This RPC raises plain `raise exception '<message>'` for
  // its own auth/validation checks (no custom SQLSTATE), matching the
  // existing transition_resource_post_status precedent
  // (lib/resources/workflow.ts) — message-text classification is therefore
  // the correct, already-proven approach for these specific, fixed,
  // developer-authored strings (not a heuristic over arbitrary Postgres
  // errors, which safeDbError() below handles instead).
  const msg = error.message ?? '';
  if (/not authenticated/i.test(msg)) return { data: null, error: bad('You must be signed in.', 401) };
  if (/admin access required/i.test(msg)) return { data: null, error: bad('Admin access required.', 403) };
  if (/not found/i.test(msg)) return { data: null, error: bad('Benchmark source not found.', 404) };
  if (/invalid target status/i.test(msg)) return { data: null, error: bad(`status must be one of: ${VALID_STATUSES.join(', ')}`, 422) };

  // Unexpected — never leak `msg` itself. Log server-side only.
  return { data: null, error: safeDbError(error, 'Benchmark source transition') };
}

export const PUT = adminRoute(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({}));

  if (body.status !== undefined && !VALID_STATUSES.includes(body.status)) {
    return bad(`status must be one of: ${VALID_STATUSES.join(', ')}`, 422);
  }

  let data: unknown = null;

  if (body.status !== undefined) {
    const result = await callTransitionRpc(id, body.status);
    if (result.error) return result.error;
    data = result.data;
  }

  // Metadata-only fields (source_name, publisher, methodology_notes, etc.)
  // are not a lifecycle event and carry no audit requirement (see the Wave
  // 4 audit inventory: AUDIT_NOT_REQUIRED for non-status field edits) — this
  // path is unchanged from Round 1 except that 'status' itself is excluded
  // (it is handled exclusively by the atomic RPC above, never by this
  // direct, non-transactional update).
  const metadataFields = WRITABLE_FIELDS.filter((f) => f !== 'status' && body[f] !== undefined);
  if (metadataFields.length > 0) {
    const admin = adminClient();
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const field of metadataFields) patch[field] = body[field];
    const { data: updated, error } = await admin.from('benchmark_sources').update(patch).eq('id', id).select('*').maybeSingle();
    if (error) return safeDbError(error, 'Benchmark source metadata update');
    if (!updated) return bad('Benchmark source not found.', 404);
    data = updated;
  }

  if (data === null) {
    // Neither a status nor any writable metadata field was supplied — the
    // request asked to change nothing. Fetch and return the current row so
    // the caller still gets an authoritative, non-misleading response
    // rather than a bare null.
    const { data: current, error } = await adminClient().from('benchmark_sources').select('*').eq('id', id).maybeSingle();
    if (error) return safeDbError(error, 'Benchmark source lookup');
    if (!current) return bad('Benchmark source not found.', 404);
    data = current;
  }

  return ok(data);
});
