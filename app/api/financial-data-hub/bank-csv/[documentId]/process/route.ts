import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { refuseUnlessImportRunMayStart } from '@/lib/entitlements/financialDataImport';
import { fdhDocumentRunPosition } from '@/lib/financial-data-hub/services/importRunPosition';
import { admitBankImport } from '@/lib/financial-data-hub/services/bankImportAdmission';
import { normaliseIdempotencyKey } from '@/lib/financial-data-hub/bankImport/jobModel';
import { acceptedJobResponse, isUnavailable, unavailableResponse } from '@/lib/financial-data-hub/bankImport/routeHelpers';

// POST /api/financial-data-hub/bank-csv/{documentId}/process -- spec 32-46, 54, 55-56, 57 step 5.
//
// DOCUMENT2 (4) WP-G (F15, PO-D24-03): this request no longer reads the statement. It ADMITS it: the cheap checks that decide whether
// the statement may be imported at all (owner/account resolved, malware admission, state), then it creates or resumes the statement's
// ONE background job and answers 202 + job id straight away. The parsing, the staging and the writing of the lines are done by short
// resumable slices (lib/financial-data-hub/services/bankImportWorker.ts) that the browser drives with
// POST /api/financial-data-hub/bank-import-jobs/{jobId}/advance and the scheduled backstop drives for abandoned jobs.
// An already-settled statement, or a byte-identical copy of one, still answers 200 inline with its stored result, exactly as before.
// Idempotent: asking again (another tab, a refresh, a dropped connection) returns the same job and never writes a line twice.
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  // Premium Upload Entitlement (14-10-2026): starting NEW extraction work (a retry / re-parse) is Premium; the first run of a
  // document admitted while Premium and the idempotent in-flight lifecycle still complete after a downgrade.
  const importDenied = await refuseUnlessImportRunMayStart(user.id, 'fdh.bank_csv.process', () => fdhDocumentRunPosition(user.id, documentId));
  if (importDenied) return importDenied;

  try {
    const outcome = await admitBankImport({
      userId: user.id,
      documentId,
      kind: 'csv',
      idempotencyKey: normaliseIdempotencyKey(req.headers.get('idempotency-key')),
    });
    if (outcome.kind === 'job') return acceptedJobResponse(outcome.job);
    if (outcome.kind === 'result') return ok(outcome.payload);
    // Stable machine-readable codes only where a client branches on them (the in-progress answer F15 introduced, a reused key).
    return bad(outcome.message, outcome.status, outcome.code === 'statement_in_progress' || outcome.code === 'idempotency_key_in_use' ? outcome.code : undefined);
  } catch (e) {
    if (isUnavailable(e)) return unavailableResponse();
    // F15: the failing stage is in the server log and the answer carries a stable code (never the file, never an amount).
    console.error('[bank-csv/process] unexpected failure', { documentIdPrefix: documentId.slice(0, 8), name: e instanceof Error ? e.name : typeof e, message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) });
    return bad('We could not process this bank statement.', 500, 'process_failed');
  }
}
