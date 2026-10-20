// Investment Intelligence — reconciliation-case creation.
//
// Extracted out of documentProcessing.ts (2026-09-17, Holdings drilldown
// task) with NO behaviour change, purely so callers that only need this one
// small helper (aiFallbackReconciliation.ts, and unit tests) do not have to
// import the entire document-processing orchestrator — which transitively
// pulls in pdfExtraction.ts's pdf-parse/pdfjs-dist dependency, a real
// canvas/DOMMatrix-requiring native module that cannot load in the plain
// Node vitest environment this module's own tests run under. Re-exported
// from documentProcessing.ts unchanged so every existing import site
// (`import { openReconciliationCase } from './documentProcessing'`)
// continues to work with no call-site changes anywhere in the codebase.

import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from './audit';

export async function openReconciliationCase(
  userId: string,
  input: {
    subjectType: 'holding_snapshot' | 'transaction' | 'account';
    subjectId: string;
    discrepancyType: string;
    severity: 'info' | 'low' | 'medium' | 'high' | 'blocking';
    sourceDocumentId: string | null;
    details: Record<string, unknown>;
    evidence?: Record<string, unknown>;
    /**
     * Document2 (4) WP-B (F8, 20-10-2026): idempotent opening. Reprocessing one document used to open a fresh case for the
     * same account / document / type every time (about 50 `owner unmatched` rows for 12 folios). With this set, an OPEN
     * (or user-reviewing) case for the same user, subject, type and source document is returned instead of inserting a
     * second one. `discriminator` names a `details` key that must also match when one subject legitimately carries several
     * independent cases of the same type (for example one per instrument).
     */
    idempotent?: { discriminator?: string };
  }
): Promise<string | null> {
  const admin = createAdminClient();
  if (input.idempotent) {
    let existingQuery = admin
      .from('ii_reconciliation_cases')
      .select('id, discrepancy_details')
      .eq('user_id', userId)
      .eq('subject_type', input.subjectType)
      .eq('subject_id', input.subjectId)
      .eq('discrepancy_type', input.discrepancyType)
      .in('status', ['open', 'user_reviewing']);
    existingQuery = input.sourceDocumentId === null ? existingQuery.is('source_document_id', null) : existingQuery.eq('source_document_id', input.sourceDocumentId);
    const { data: existingRows } = await existingQuery;
    const key = input.idempotent.discriminator;
    const match = ((existingRows ?? []) as { id: string; discrepancy_details: Record<string, unknown> | null }[]).find((r) => !key || r.discrepancy_details?.[key] === input.details[key]);
    if (match) return match.id;
  }
  const { data, error } = await admin
    .from('ii_reconciliation_cases')
    .insert({
      user_id: userId,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      discrepancy_type: input.discrepancyType,
      status: 'open',
      severity: input.severity,
      source_document_id: input.sourceDocumentId,
      discrepancy_details: input.details,
      evidence: input.evidence ?? null,
    })
    .select('id')
    .single();
  if (error || !data) return null;
  await emitAuditEvent({
    userId,
    eventType: 'reconciliation_case_created',
    subjectType: 'ii_reconciliation_cases',
    subjectId: data.id as string,
    actorType: 'system',
    metadata: { discrepancyType: input.discrepancyType, severity: input.severity, subjectType: input.subjectType, subjectId: input.subjectId },
  });
  return data.id as string;
}
