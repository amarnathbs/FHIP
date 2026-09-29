import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { iiReviewActionSchema } from '@/lib/validation/investment-intelligence';

// Review Centre "more resolution actions" (2026-09-29) — a REAL fix action
// for three discrepancy types confirmed live in production (twwpnltizhtjxhamyoxt)
// to have open, real, user-facing cases: 'unsupported_document',
// 'document_corrupt', 'parse_incomplete'. All three share the exact same
// shape: documentProcessing.ts opens them BEFORE any account/transaction is
// ever created for the document (format detection failed, the file could not
// be read at all, or parser validation rejected the output before step 3's
// folio/account resolution ever runs — see documentProcessing.ts lines
// ~482-499, ~539-556, ~1440-1489) and NONE of the three has any retry path
// that could ever succeed on the same uploaded bytes: re-clicking "Process"
// on the same file reproduces the identical failure every time. Unlike
// 'document_password_required' (which genuinely can and does succeed again
// once the right password is supplied — see the auto_resolved_on_reparse
// path this file's sibling route relies on), these three are permanently
// dead ends for the document as uploaded. The only real fix is to let the
// user acknowledge that and clear it, so it stops sitting open forever and
// they know to re-upload a corrected file instead.
//
// This is why "Acknowledge" (ii_review_items bookkeeping only) is not
// enough: it never touches ii_source_documents.status or the underlying
// ii_reconciliation_cases row, so the document stays stuck at
// 'unsupported'/'parse_failed'/'reconciliation_required' forever with no
// user-visible signal that anything was ever done about it — the exact
// "generic Acknowledge/Dismiss don't fix anything" gap this task set out to
// close, verified live in production data (6 open document_password_required
// + 3 open unsupported_document cases found on 2026-09-29; zero occurrences
// ever of ambiguous_instrument/cross_source_*/other less-common types, which
// is why those are NOT given a bespoke action here).
//
// WHAT THIS ACTUALLY FIXES (never a blind status flip):
//  1. ii_source_documents.status -> 'archived' (a pre-existing, valid value
//     per the current ii_source_documents_status_check, migration 0160 —
//     already used passively elsewhere; this is simply the first place that
//     actually SETS it for a document, from a user action).
//  2. Every OPEN reconciliation case of one of these three types tied to
//     this document is resolved for real, same admin-client pattern as
//     accounts/[id]/owner/route.ts (ii_reconciliation_cases.discrepancy_details
//     is system-authoritative per migration 0087's trigger — an
//     authenticated-role write to it is refused outright, so this must use
//     the admin client exactly as that route documents).
// A document that already succeeded ('parsed') or is mid-flight is refused
// outright — this route only ever discards a document that is provably
// stuck, never one that might still resolve on its own or already has real
// canonical data behind it.
const DISCARDABLE_DISCREPANCY_TYPES = ['unsupported_document', 'document_corrupt', 'parse_incomplete'] as const;
const NON_DISCARDABLE_STATUSES = new Set(['parsed', 'parsing', 'uploaded', 'ai_review_pending', 'password_required', 'archived', 'superseded']);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: sourceDocumentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = iiReviewActionSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badValidation(parsed.error, 422);

  const supabase = await createClient();
  const { data: doc } = await supabase.from('ii_source_documents').select('id, status').eq('id', sourceDocumentId).eq('user_id', user.id).maybeSingle();
  if (!doc) return bad('Source document not found.', 404);
  if (NON_DISCARDABLE_STATUSES.has(doc.status as string)) {
    return bad(doc.status === 'archived' ? 'This document has already been discarded.' : 'This document cannot be discarded from here.', 409);
  }

  // ADMIN CLIENT, DELIBERATELY, for the same reason accounts/[id]/owner/route.ts
  // uses it: discrepancy_details/status transitions on ii_reconciliation_cases
  // are system-authoritative once the case exists (migration 0087). Ownership
  // of the target document is already verified above via the RLS-scoped
  // `supabase` client before this point is ever reached.
  const admin = createAdminClient();

  const { data: openCases, error: openCasesErr } = await admin
    .from('ii_reconciliation_cases')
    .select('id, discrepancy_details')
    .eq('user_id', user.id)
    .eq('source_document_id', sourceDocumentId)
    .in('discrepancy_type', DISCARDABLE_DISCREPANCY_TYPES)
    .eq('status', 'open');
  if (openCasesErr) return bad(openCasesErr.message);
  if (!openCases || openCases.length === 0) {
    return bad('No discardable issue is open for this document.', 422);
  }

  const { error: updateDocErr } = await admin.from('ii_source_documents').update({ status: 'archived' }).eq('id', sourceDocumentId).eq('user_id', user.id);
  if (updateDocErr) return bad(updateDocErr.message);

  const nowIso = new Date().toISOString();
  let resolvedCaseCount = 0;
  for (const c of openCases) {
    const mergedDetails = { ...((c.discrepancy_details as Record<string, unknown> | null) ?? {}), discardedAt: nowIso, discardNote: parsed.data.note ?? null };
    const { error: resolveErr } = await admin
      .from('ii_reconciliation_cases')
      .update({
        status: 'resolved',
        resolved_at: nowIso,
        resolution_method: 'user_discarded_document',
        resolved_by: user.id,
        resolved_by_actor_type: 'user',
        discrepancy_details: mergedDetails,
      })
      .eq('id', c.id as string)
      .eq('status', 'open'); // race guard: only this row, only if still open
    if (!resolveErr) resolvedCaseCount++;
  }

  await emitAuditEvent({
    userId: user.id,
    eventType: 'archive',
    subjectType: 'ii_source_documents',
    subjectId: sourceDocumentId,
    actorType: 'user',
    actorId: user.id,
    metadata: { previousStatus: doc.status, resolvedCaseCount, note: parsed.data.note ?? null },
  });

  return ok({ sourceDocumentId, resolvedCaseCount });
}
