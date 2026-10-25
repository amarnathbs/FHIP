import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { processSourceDocument } from '@/lib/services/investment-intelligence/documentProcessing';
import { kickUserNavHistory } from '@/lib/services/investment-intelligence/pc6/userNavHistoryKick';
import { z } from 'zod';
import { refuseUnlessImportRunMayStart } from '@/lib/entitlements/financialDataImport';
import { iiSourceDocumentRunPosition } from '@/lib/services/investment-intelligence/importRunPosition';
import { ensureIiRealScanAdmissible } from '@/lib/services/investment-intelligence/realScanAdmission';
import { scanRefusalHttp } from '@/lib/services/investment-intelligence/scanRefusal';
import { recordPasswordNeededAtScanGate } from '@/lib/services/investment-intelligence/scanPasswordPrompt';
import { admitStatementJob } from '@/lib/services/investment-intelligence/statementJob/admission';
import { acceptedJobResponse, isUnavailable } from '@/lib/services/investment-intelligence/statementJob/routeHelpers';
import { normaliseStatementIdempotencyKey } from '@/lib/services/investment-intelligence/statementJob/model';

// Document2 (4) WP-J -- this route is the ADMISSION of a statement processing request, no longer the processing itself.
//
// A real consolidated statement (many funds, a long history) cannot be read, matched and certified inside the platform's 28 second
// request limit: the request was killed with no chance to answer, the browser waited for ever and the parse run stayed `running`.
// So the request now only decides what is to happen, quickly, and answers
//   202  {async_job, job_id, job}  a durable job was created, or the unfinished one RESUMED (never a second job for a statement). The
//                                   browser then asks POST /api/investment-intelligence/statement-jobs/{job_id}/advance repeatedly; each
//                                   call is one short slice, the same pipeline run in resumable steps.
//   200  {ok, status, ...}         an immediate answer that needs no work (the statement is already processed, an AI reading is waiting,
//                                   the file is gone and a replacement copy is needed, the password is needed ...), exactly as before.
//
// The password is used HERE only for the malware scan (WP-H2: opened in memory, the decrypted copy is scanned and discarded) and for the
// attempt limiter. It is not part of the job. The browser sends it again with the first slice, the one step that opens the file; it is
// held in memory for that call and never stored, staged or logged.
//
// If the job tables are not there yet (migration 0313 not applied) the earlier one-request behaviour is used, so a deployment that runs
// ahead of the database still works for small statements.
//
// Ownership is re-verified inside admission and the pipeline (every query is scoped by user_id), so a guessed id of another user's
// document finds nothing. Optional header Idempotency-Key (8 to 120 safe characters): the same key always answers the same job.
export const maxDuration = 30;

const processBodySchema = z.object({
  password: z.string().max(256).optional(),
  forceReparse: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const bodyRaw = await req.json().catch(() => ({}));
  const parsed = processBodySchema.safeParse(bodyRaw);
  if (!parsed.success) return badValidation(parsed.error, 422);

  // Premium Upload Entitlement (14-10-2026): a retry or a forced re-parse is NEW extraction work and needs Premium; the first run of
  // a document admitted while Premium (and the password it is waiting for) still completes after a downgrade.
  const importDenied = await refuseUnlessImportRunMayStart(user.id, 'ii.source_document.process', () =>
    iiSourceDocumentRunPosition(user.id, id, parsed.data.forceReparse === true),
  );
  if (importDenied) return importDenied;

  // AIE-1 final completion (2026-09-25): nothing parses these bytes until the real malware scan has cleared them (a no-op while the scan
  // is switched off). 409 is retryable -- the client polls; 422 is final.
  const scan = await ensureIiRealScanAdmissible(user.id, id, { password: parsed.data.password });
  if (!scan.admitted) {
    if (scan.reason === 'not_found') return bad('Source document not found.', 404);
    // WP-H2: a protected statement is opened in memory with its password for the scan. A missing or wrong password is the ordinary
    // password step (the document goes to `password_required`, nothing is deleted), not a scan verdict.
    if (scan.reason === 'password_required' || scan.reason === 'wrong_password') return ok(await recordPasswordNeededAtScanGate(user.id, id, scan.reason));
    const refusal = scanRefusalHttp(scan);
    return bad(refusal.message, refusal.status, refusal.code);
  }

  let admitted;
  try {
    admitted = await admitStatementJob({
      userId: user.id,
      documentId: id,
      kind: 'process',
      forceReparse: parsed.data.forceReparse,
      password: parsed.data.password,
      idempotencyKey: normaliseStatementIdempotencyKey(req.headers.get('idempotency-key')),
    });
  } catch (e) {
    if (!isUnavailable(e)) throw e;
    // Migration 0313 is not applied here: the earlier synchronous behaviour.
    const result = await processSourceDocument({ userId: user.id, sourceDocumentId: id, password: parsed.data.password, forceReparse: parsed.data.forceReparse });
    if (!result.ok && result.status === 'not_found') return bad('Source document not found.', 404);
    if (!result.ok && result.status === 'password_rate_limited') return bad(result.error ?? 'Too many password attempts for this document.', 429, 'password_rate_limited');
    if (result.ok && result.summary) kickUserNavHistory(user.id);
    return ok(result);
  }

  if (admitted.kind === 'conflict') return bad('That Idempotency-Key was already used for a different statement.', 409, 'idempotency_key_in_use');
  if (admitted.kind === 'job') return acceptedJobResponse(admitted.job, { resumed: admitted.resumed });

  // An immediate answer. The response NEVER echoes back the supplied password in any field.
  const result = admitted.result;
  if (!result.ok && result.status === 'not_found') return bad('Source document not found.', 404);
  // M12C §10 (`M2-OPEN-8`): the shared password-attempt limiter refused this attempt. 429 matches the bank-PDF and AIE unlock routes.
  if (!result.ok && result.status === 'password_rate_limited') return bad(result.error ?? 'Too many password attempts for this document.', 429, 'password_rate_limited');
  if (result.ok && result.summary) kickUserNavHistory(user.id);
  return ok(result);
}
