// Investment Intelligence -- the ordinary "password required / incorrect" state, reached at the malware-scan gate instead of at the parser
// (Document2 (4) WP-H2). The statement is not damaged, not blocked and nothing is deleted; it is simply waiting for its password. This
// puts the document where the existing screen already knows how to handle that: status `password_required`, one open blocking
// `document_password_required` case, the same audit event the parser path writes. Only the outcome kind is recorded, never a password.

import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from './audit';
import { openReconciliationCase } from './reconciliationCases';
import { II_SCAN_PASSWORD_NEEDED_MESSAGE, II_SCAN_WRONG_PASSWORD_MESSAGE } from './scanRefusal';

export interface PasswordPromptResult {
  ok: false;
  status: 'password_required';
  parseRunId: null;
  error: string;
}

export async function recordPasswordNeededAtScanGate(userId: string, sourceDocumentId: string, kind: 'password_required' | 'wrong_password'): Promise<PasswordPromptResult> {
  const admin = createAdminClient();
  const { data: doc } = await admin.from('ii_source_documents').select('status').eq('id', sourceDocumentId).eq('user_id', userId).maybeSingle();
  // A statement that was already read successfully keeps its status (a failed attempt never drags it backwards).
  if (doc && (doc as { status: string }).status !== 'parsed') {
    await admin.from('ii_source_documents').update({ status: 'password_required', parse_error: null }).eq('id', sourceDocumentId).eq('user_id', userId);
  }
  await openReconciliationCase(userId, {
    subjectType: 'account',
    subjectId: sourceDocumentId,
    discrepancyType: 'document_password_required',
    severity: 'blocking',
    sourceDocumentId,
    idempotent: {},
    details: { kind, stage: 'scan_gate' },
  });
  await emitAuditEvent({
    userId,
    eventType: 'document_processing_failed',
    subjectType: 'ii_source_documents',
    subjectId: sourceDocumentId,
    actorType: 'system',
    metadata: { kind, stage: 'scan_gate' },
  });
  return { ok: false, status: 'password_required', parseRunId: null, error: kind === 'wrong_password' ? II_SCAN_WRONG_PASSWORD_MESSAGE : II_SCAN_PASSWORD_NEEDED_MESSAGE };
}
