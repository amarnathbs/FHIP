/**
 * Shared answers for the bank-import routes (process admission, job status, advance, backstop). Pure apart from `Response`.
 */
import { toBankImportJobView, type BankImportJobRow, BANK_IMPORT_POLL_WAIT_MS } from './jobModel';
import { BankImportJobsUnavailableError } from '../services/bankImportJobStore';

/** 202: the statement's job was admitted (or is already running). The browser polls `advance` with `job.job_id`. */
export function acceptedJobResponse(job: BankImportJobRow): Response {
  const view = toBankImportJobView(job);
  return Response.json(
    { data: { async_job: true, job_id: view.job_id, job: view, poll_after_ms: view.keep_polling ? BANK_IMPORT_POLL_WAIT_MS : 0 } },
    { status: 202, headers: { 'Cache-Control': 'private, no-store', Location: `/api/financial-data-hub/bank-import-jobs/${view.job_id}` } },
  );
}

export function jobViewResponse(job: BankImportJobRow, extra: Record<string, unknown> = {}): Response {
  const view = toBankImportJobView(job);
  return Response.json({ data: { job: view, poll_after_ms: view.keep_polling ? BANK_IMPORT_POLL_WAIT_MS : 0, ...extra } }, { headers: { 'Cache-Control': 'private, no-store' } });
}

/** A database that does not have migration 0310 yet answers plainly, never with SQL. */
export function unavailableResponse(): Response {
  return Response.json(
    { error: 'bank_import_unavailable', message: 'Background statement import is not available in this environment yet.' },
    { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

export function isUnavailable(e: unknown): boolean {
  return e instanceof BankImportJobsUnavailableError;
}
