import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { refuseUnlessImportRunMayStart } from '@/lib/entitlements/financialDataImport';
import { fdhDocumentRunPosition } from '@/lib/financial-data-hub/services/importRunPosition';
import { admitBankImport } from '@/lib/financial-data-hub/services/bankImportAdmission';
import { normaliseIdempotencyKey } from '@/lib/financial-data-hub/bankImport/jobModel';
import { acceptedJobResponse, isUnavailable, unavailableResponse } from '@/lib/financial-data-hub/bankImport/routeHelpers';

const bodySchema = z.object({ password: z.string().max(200).optional() }).optional();

// A short request: it admits the statement and, for a protected PDF only, reads it once inside this request (the password must not
// outlive the request; the platform's own limit of about 28 s applies, and the read itself stops at PDF_EXTRACTION_TIMEOUT_MS).
export const maxDuration = 30;

// POST /api/financial-data-hub/bank-pdf/{documentId}/process -- spec sections 6, 13-46, 55-56, 89-90.
//
// DOCUMENT2 (4) WP-G (F15, PO-D24-03): this request no longer reads a statement that may take minutes. It ADMITS it (owner/account
// resolved, malware admission, state, password attempt rate limit), then creates or resumes the statement's ONE background job and
// answers 202 + job id straight away. The certified-layout read, the AI reading (in page-group parts) and the writing of the lines
// are done by short resumable slices (lib/financial-data-hub/services/bankImportWorker.ts) driven by
// POST /api/financial-data-hub/bank-import-jobs/{jobId}/advance and by the scheduled backstop. A settled statement, a byte-identical
// copy of one, or an AI reading that already waits for a check still answers 200 inline, exactly as before.
//
// `password`, when the document is awaiting one, travels ONLY in this request's JSON body -- never a query string (spec 23) -- and
// is used exactly once, in memory, by the single read slice run inside this request, then discarded. It is never stored on the job.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  // Premium Upload Entitlement (14-10-2026): starting NEW extraction work (a retry / re-parse) is Premium; the first run of a
  // document admitted while Premium and the idempotent in-flight lifecycle still complete after a downgrade.
  const importDenied = await refuseUnlessImportRunMayStart(user.id, 'fdh.bank_pdf.process', () => fdhDocumentRunPosition(user.id, documentId));
  if (importDenied) return importDenied;

  if (!isFdhDocumentUploadEnabled()) {
    return bad('Bank PDF processing is not currently enabled in this environment.', 403);
  }

  let password: string | undefined;
  const contentLength = Number(req.headers.get('content-length') ?? '0');
  if (contentLength > 0) {
    const rawBody = await req.json().catch(() => null);
    const parsedBody = bodySchema.safeParse(rawBody);
    if (!parsedBody.success) return bad('Invalid request body.', 422);
    password = parsedBody.data?.password;
  }

  try {
    const outcome = await admitBankImport({
      userId: user.id,
      documentId,
      kind: 'pdf',
      idempotencyKey: normaliseIdempotencyKey(req.headers.get('idempotency-key')),
      password,
    });
    if (outcome.kind === 'job') return acceptedJobResponse(outcome.job);
    if (outcome.kind === 'result') return ok(outcome.payload);
    return bad(outcome.message, outcome.status, outcome.code === 'statement_in_progress' || outcome.code === 'idempotency_key_in_use' ? outcome.code : undefined);
  } catch (e) {
    if (isUnavailable(e)) return unavailableResponse();
    // F15: see the bank-csv route; the failing stage is in the server log and the answer carries a stable code.
    console.error('[bank-pdf/process] unexpected failure', { documentIdPrefix: documentId.slice(0, 8), name: e instanceof Error ? e.name : typeof e, message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) });
    return bad('We could not process this bank statement.', 500, 'process_failed');
  }
}
