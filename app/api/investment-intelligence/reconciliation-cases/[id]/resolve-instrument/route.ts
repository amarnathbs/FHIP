import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { processSourceDocument } from '@/lib/services/investment-intelligence/documentProcessing';
import { z } from 'zod';

// Document2 final non-benchmark closure #3 (2026-09-30) — a genuine
// resolution action for `ambiguous_instrument`, confirmed by discovery to
// have NO real fix path before this (Acknowledge/Dismiss only, per the prior
// mission's own disclosed gap). Preferred architecture per the Product
// Owner's mission spec: Review issue -> show candidate instruments -> user
// selects the correct canonical instrument -> save an explicit resolution ->
// preserve original source evidence -> Re-evaluate -> affected
// transactions/holdings resolve -> issue disappears -> Publish can proceed
// where no other blocker remains.
//
// `resolvedInstrumentId` MUST be one of the case's own recorded
// `candidateInstrumentIds` — this route never accepts an arbitrary
// instrument id, matching the mission's explicit rule to never
// fuzzy-auto-select an economically different instrument.
//
// The correction IS the resolution (same pattern as
// accounts/[id]/owner/route.ts): this route immediately reprocesses the
// ORIGINAL source document (ambiguous_instrument's own `subject_id` IS the
// source document it was raised against — see documentProcessing.ts) with
// `forceReparse: true`. `ambiguousInstrumentResolution.ts`'s override lookup
// runs BEFORE resolveScheme() on that reprocess, so the exact scheme this
// case was raised for now resolves to the user's chosen instrument instead
// of reporting the same ambiguity again — never a second, parallel
// resolution mechanism.
//
// Idempotent: resolving an already-resolved case with the SAME instrument id
// is a no-op success (repeated Save). Resolving with a DIFFERENT instrument
// id once already resolved is refused — that is an AMENDMENT, which goes
// through the existing resolution-history/amend architecture
// (`/api/investment-intelligence/resolutions/[caseId]/amend`) so the
// original decision is never silently overwritten, only superseded with a
// full audit trail, matching every other resolution type in this module.
const resolveSchema = z.object({ resolvedInstrumentId: z.string().uuid() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: caseId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = resolveSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);

  const admin = createAdminClient();

  // Never trust the route param alone — re-verified against this user on
  // every read, matching every other mutation in this module.
  const { data: existing } = await admin
    .from('ii_reconciliation_cases')
    .select('id, status, discrepancy_type, subject_id, discrepancy_details')
    .eq('id', caseId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!existing) return bad('Reconciliation case not found.', 404);
  if (existing.discrepancy_type !== 'ambiguous_instrument') return bad('This case cannot be resolved this way.', 422);

  const details = (existing.discrepancy_details as Record<string, unknown> | null) ?? {};
  const candidateInstrumentIds = Array.isArray(details.candidateInstrumentIds) ? (details.candidateInstrumentIds as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (!candidateInstrumentIds.includes(parsed.data.resolvedInstrumentId)) {
    return bad('That instrument is not one of the candidates offered for this issue.', 422);
  }

  if (existing.status === 'resolved') {
    const alreadyResolvedTo = details.resolvedInstrumentId;
    if (alreadyResolvedTo === parsed.data.resolvedInstrumentId) {
      // Idempotent repeat of the same Save — nothing to do, no error.
      return ok({ caseId, resolvedInstrumentId: parsed.data.resolvedInstrumentId, alreadyResolved: true });
    }
    return bad('This issue has already been resolved with a different instrument. Use the Resolutions history view to amend that decision instead.', 409, 'already_resolved');
  }
  if (existing.status !== 'open') {
    return bad(`Cannot resolve a case with status '${existing.status}'.`, 422);
  }

  const nowIso = new Date().toISOString();
  const mergedDetails = { ...details, resolvedInstrumentId: parsed.data.resolvedInstrumentId };
  const { error: resolveErr } = await admin
    .from('ii_reconciliation_cases')
    .update({
      status: 'resolved',
      resolved_at: nowIso,
      resolution_method: 'user_mapped_instrument',
      resolved_by: user.id,
      resolved_by_actor_type: 'user',
      discrepancy_details: mergedDetails,
    })
    .eq('id', caseId)
    .eq('user_id', user.id)
    .eq('status', 'open'); // race guard: only if still open
  if (resolveErr) return bad(resolveErr.message);

  await emitAuditEvent({
    userId: user.id,
    eventType: 'user_correction',
    subjectType: 'ii_instruments',
    subjectId: parsed.data.resolvedInstrumentId,
    actorType: 'user',
    actorId: user.id,
    metadata: { reconciliationCaseId: caseId, field: 'ambiguous_instrument', candidateInstrumentIds, resolvedInstrumentId: parsed.data.resolvedInstrumentId },
  });

  // The correction IS the resolution: reprocess the original source document
  // now, so the fix takes effect immediately rather than requiring a second,
  // separate "Re-evaluate" click the user has no way to discover. A failure
  // here does not undo the resolution just recorded — it is surfaced to the
  // caller so the UI can prompt a manual Re-evaluate/reprocess retry, exactly
  // the existing fallback already offered elsewhere for a stuck document.
  const sourceDocumentId = existing.subject_id as string;
  let reprocessed = false;
  let reprocessError: string | null = null;
  try {
    const result = await processSourceDocument({ userId: user.id, userEmail: user.email ?? null, sourceDocumentId, forceReparse: true });
    reprocessed = result.ok;
    if (!result.ok) reprocessError = result.error ?? 'Reprocessing did not complete successfully.';
  } catch (e) {
    reprocessError = e instanceof Error ? e.message : 'Reprocessing failed unexpectedly.';
  }

  return ok({ caseId, resolvedInstrumentId: parsed.data.resolvedInstrumentId, reprocessed, reprocessError });
}
