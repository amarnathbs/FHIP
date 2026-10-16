/**
 * Premium Upload Entitlement -- where an already-admitted Investment Intelligence source document is in its run (see
 * lib/entitlements/financialDataImport.ts, `refuseUnlessImportRunMayStart`).
 *
 * A source-document row exists only because the upload route passed the Premium check.
 *   uploaded / password_required        -> the first run (or the password it is waiting for): bounded continuation
 *   parse_failed / unsupported          -> a retry (a NEW parse attempt): Premium
 *   forceReparse requested              -> 'forced' (throws away a result and parses again): Premium, whatever the status
 *   parsing / parsed / ai_review_pending / reconciliation_required / superseded / archived
 *                                       -> already past the first run (idempotent; no new extraction)
 * Not found / someone else's -> 'unknown'.
 */

import type { AdmittedRunPosition } from '@/lib/entitlements/financialDataImport';
import { createClient } from '@/lib/supabase/server';

export function runPositionForIiStatus(status: string | null | undefined, forceReparse = false): AdmittedRunPosition {
  if (forceReparse) return 'forced';
  if (status === 'uploaded' || status === 'password_required') return 'first_run';
  if (status === 'parse_failed' || status === 'unsupported') return 'retry';
  if (typeof status === 'string' && status.length > 0) return 'in_flight';
  return 'unknown';
}

export async function iiSourceDocumentRunPosition(userId: string, sourceDocumentId: string, forceReparse = false): Promise<AdmittedRunPosition> {
  const supabase = await createClient();
  const { data } = await supabase.from('ii_source_documents').select('status').eq('id', sourceDocumentId).eq('user_id', userId).maybeSingle();
  if (!data) return 'unknown';
  return runPositionForIiStatus((data as { status?: string | null }).status, forceReparse);
}
