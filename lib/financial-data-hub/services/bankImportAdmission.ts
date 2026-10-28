/**
 * Document2 (4) WP-G (F15, PO-D24-03) -- ADMISSION of a bank statement import: the only work the "process" request does now.
 *
 * Before: the process request parsed the statement, read it through the AI, wrote every line and finished the import inside one web
 * request (28 s limit). Now it ADMITS: it authenticates (the route did), checks everything that is cheap and decides whether the
 * statement may be imported at all (owner/account resolved, malware admission, state), then creates or resumes the statement's ONE
 * job and answers `202 + job id` straight away. A background slice (bankImportWorker.ts) does the work.
 *
 * IDEMPOTENT. The job is unique per statement (database constraint) and per (user, Idempotency-Key). Asking again, from this tab,
 * another tab, after a refresh or after the platform dropped the connection, returns the SAME job; it never starts a second one and
 * never writes a line twice. A finished statement answers inline with its stored result, as the synchronous import did.
 *
 * Checks that used to happen inside the long request, in the same order and with the same answers:
 *   settled (already imported) -> byte-identical copy of an earlier upload -> AI draft already waiting -> malware admission ->
 *   state -> account resolved (else the statement is parked for the account question) -> PDF password attempt rate limit.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { checkFdhDocumentMalwareAdmission, FDH_MALWARE_ADMISSION_REFUSED_MESSAGE } from './malwareScanGate';
import { findEarlierIdenticalUpload, IDENTICAL_UPLOAD_SPECS } from './identicalUpload';
import { claimPendingAiFallbackDraft, loadConfirmedAiFallbackDraft, loadPendingAiFallbackDraft } from './aiFallbackDrafts';
import { recordDocumentAuditEvent } from './auditLog';
import { documentAuditEventsRepository } from '../repositories';
import { checkPasswordAttemptRateLimit } from '../bank-pdf/password';
import {
  findImportedIdenticalCsv,
  summariseExisting as summariseExistingCsv,
} from './bankCsvProcessingService';
import {
  draftResult,
  identicalUploadResult,
  summariseExisting as summariseExistingPdf,
  type BankStatementAiFallbackDraft,
} from './bankPdfProcessingService';
import { csvProcessResponse, pdfProcessResponse } from '../bankImport/processResponse';
import { advanceBankImportJob } from './bankImportWorker';
import { clearImportArtifacts } from './bankImportWorker';
import {
  createJobIfAbsent,
  deleteChunks,
  getJobByDocument,
  resetChunkAttempts,
  transitionJob,
} from './bankImportJobStore';
import { runWithFdhServiceClient } from '../dbContext';
import { processingRunState, STATEMENT_STILL_BEING_READ_MESSAGE } from './interruptedRun';
import type { BankImportJobRow, BankImportPhase, BankImportSourceKind } from '../bankImport/jobModel';
import type { FdhStatementUpload } from '../domain/types';

export type AdmitOutcome =
  /** Answered inline: the statement is already settled, is a copy of one that is, or an AI reading waits for a check. 200. */
  | { kind: 'result'; payload: Record<string, unknown> }
  /** The statement's job (new, resumed or already running). 202. */
  | { kind: 'job'; job: BankImportJobRow }
  | { kind: 'error'; status: number; code: string; message: string };

async function loadOwnedDoc(userId: string, documentId: string): Promise<FdhStatementUpload | null> {
  const { data, error } = await createAdminClient().from('fdh_statement_uploads').select('*').eq('id', documentId).eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as FdhStatementUpload | null) ?? null;
}

const SETTLED_CERTIFICATION = ['certified', 'review_required', 'rejected'];

function resultFor(kind: BankImportSourceKind, doc: FdhStatementUpload): Record<string, unknown> {
  return kind === 'csv' ? csvProcessResponse(summariseExistingCsv(doc)) : pdfProcessResponse(summariseExistingPdf(doc));
}

/** Where a retry of a failed job resumes, and what it must clear first. */
async function resetFailedJobForRetry(job: BankImportJobRow): Promise<BankImportJobRow | null> {
  const resume = (job.checkpoint.resume_phase as BankImportPhase | undefined) ?? 'read';
  const phase: BankImportPhase = resume === 'ai_read' || resume === 'plan_confirmed' ? resume : 'read';
  await runWithFdhServiceClient(createAdminClient(), async () => {
    if (phase === 'read') {
      // Start clean: the lines a failed attempt wrote must never be mistaken for another statement's duplicates.
      await clearImportArtifacts(job.user_id, job.statement_upload_id);
      await deleteChunks(job.id, job.user_id);
    } else if (phase === 'ai_read') {
      // The parts already read (and paid for) stay; a part that ran out of tries gets a fresh set.
      await resetChunkAttempts(job.id, job.user_id, 'ai_text');
    } else {
      await clearImportArtifacts(job.user_id, job.statement_upload_id);
      await deleteChunks(job.id, job.user_id, ['plan_meta', 'plan_rows']);
    }
  });
  return transitionJob(
    job.id,
    { status: 'failed' },
    {
      status: 'queued',
      phase,
      attempt: job.attempt + 1,
      consecutive_failures: 0,
      error_code: null,
      error_message_sanitised: null,
      result_summary: null,
      progress_done: 0,
      lease_owner: null,
      lease_expires_at: null,
      completed_at: null,
      // a retry starts finalize fresh (nothing derived is left once the lines were cleared or re-planned)
      checkpoint: { ...job.checkpoint, finalize_started: false },
    },
  );
}

export async function admitBankImport(params: {
  userId: string;
  documentId: string;
  kind: BankImportSourceKind;
  idempotencyKey?: string | null;
  /** A protected PDF's password: used in memory by the one inline read slice below, never stored. */
  password?: string;
}): Promise<AdmitOutcome> {
  const { userId, documentId, kind } = params;
  const doc = await loadOwnedDoc(userId, documentId);
  if (!doc) return { kind: 'error', status: 404, code: 'not_found', message: 'document not found' };

  // 1. Already imported and settled: the stored result, as before.
  if (doc.certification_status && SETTLED_CERTIFICATION.includes(doc.certification_status) && doc.processing_completed_at) {
    return { kind: 'result', payload: resultFor(kind, doc) };
  }

  // 2. A byte-identical copy of a statement already imported (or whose AI reading waits): nothing is read again.
  if (kind === 'csv') {
    const originalId = await findImportedIdenticalCsv(userId, documentId);
    if (originalId) {
      const original = await loadOwnedDoc(userId, originalId);
      if (original) {
        return {
          kind: 'result',
          payload: csvProcessResponse({ ...summariseExistingCsv(original), transactionsCreated: 0, duplicatesSkipped: original.certified_row_count ?? 0, rejectedRows: 0, duplicateOfDocumentId: originalId }),
        };
      }
    }
  } else {
    if (doc.processing_status === 'processing') {
      const own = await loadPendingAiFallbackDraft(userId, documentId);
      if (own.found) return { kind: 'result', payload: pdfProcessResponse(draftResult(doc, own.payload as BankStatementAiFallbackDraft)) };
    }
    const identical = await findEarlierIdenticalUpload(userId, documentId, IDENTICAL_UPLOAD_SPECS.bank);
    if (identical) return { kind: 'result', payload: pdfProcessResponse(await identicalUploadResult(userId, doc, identical)) };
  }

  // 3. The statement's job, if it has one.
  const existing = await getJobByDocument(userId, documentId);
  if (existing) return resumeExisting(existing, doc, params);

  // 4. A new job: everything cheap that decides whether this statement may be imported at all.
  // A document left in `processing` by the OLD synchronous import (the platform killed the request; it has no job): a run that is
  // still young is not started twice, an old one is taken over by the job (the read slice clears whatever it left).
  if (doc.processing_status === 'processing' && processingRunState(doc) === 'live') {
    return { kind: 'error', status: 409, code: 'statement_in_progress', message: STATEMENT_STILL_BEING_READ_MESSAGE };
  }
  if (!checkFdhDocumentMalwareAdmission(doc).admitted) {
    return { kind: 'error', status: 400, code: 'invalid_state', message: FDH_MALWARE_ADMISSION_REFUSED_MESSAGE };
  }
  if (kind === 'csv') {
    if (!doc.detection_status || doc.detection_status === 'invalid' || doc.detection_status === 'unsupported') {
      return { kind: 'error', status: 400, code: 'invalid_state', message: 'this document has not been successfully detected' };
    }
    if ((doc.detection_status === 'ambiguous' || doc.detection_status === 'manual_mapping_required') && !doc.mapping_template_id) {
      return { kind: 'error', status: 400, code: 'mapping_required', message: 'We could read this CSV, but we do not recognise its layout, so we cannot tell which column is the date, the description and the amount. Choose the columns and the import will carry on.' };
    }
  } else if (!['queued', 'failed', 'processing'].includes(doc.processing_status)) {
    return { kind: 'error', status: 400, code: 'invalid_state', message: 'This document is not currently ready to be processed.' };
  }
  if (!doc.financial_account_id) {
    // ACCOUNT_REVIEW_REQUIRED fail-safe (spec 31): halt cleanly, never guess; the person resolves the account and asks again.
    if (['queued', 'failed', 'processing'].includes(doc.processing_status)) {
      await createAdminClient()
        .from('fdh_statement_uploads')
        .update({ processing_status: 'review_required', certification_status: 'review_required', review_status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', documentId)
        .eq('user_id', userId);
    }
    return { kind: 'error', status: 400, code: 'account_unresolved', message: 'We could not tell which account this statement belongs to. Please resolve the account before processing.' };
  }
  if (kind === 'pdf' && doc.error_code === 'password_required') {
    // PASSWORD RATE LIMIT (spec 24): consulted BEFORE the one decrypt attempt, from persisted audit TIMESTAMPS only.
    const { data: allEvents } = await documentAuditEventsRepository.listForUser(userId, 500);
    const recent = (allEvents ?? []).filter((e) => e.document_id === documentId);
    if (!checkPasswordAttemptRateLimit({ recentAuditEvents: recent, nowIso: new Date().toISOString() }).allowed) {
      return { kind: 'error', status: 429, code: 'rate_limited', message: 'Too many password attempts for this document recently. Please try again later.' };
    }
  }

  const created = await createJobIfAbsent({ userId, documentId, kind, idempotencyKey: params.idempotencyKey });
  if (created.outcome === 'idempotency_key_in_use') {
    return { kind: 'error', status: 409, code: 'idempotency_key_in_use', message: 'That request key was already used for a different statement.' };
  }
  const job = created.job;
  if (created.outcome === 'existing') return resumeExisting(job, doc, params);
  return runPasswordSliceIfGiven(job, params);
}

/** A protected PDF's password is used in memory by exactly one slice, run inside this request; every other slice has no password. */
async function runPasswordSliceIfGiven(job: BankImportJobRow, params: { userId: string; password?: string }): Promise<AdmitOutcome> {
  if (!params.password || job.source_kind !== 'pdf') return { kind: 'job', job };
  const out = await advanceBankImportJob(job.id, { userId: params.userId, password: params.password, sliceBudgetMs: 8_000 });
  if (out.kind === 'advanced' || out.kind === 'busy' || out.kind === 'not_runnable') return { kind: 'job', job: out.job };
  return { kind: 'job', job };
}

async function resumeExisting(
  job: BankImportJobRow,
  doc: FdhStatementUpload,
  params: { userId: string; documentId: string; kind: BankImportSourceKind; password?: string },
): Promise<AdmitOutcome> {
  switch (job.status) {
    case 'queued':
    case 'processing':
      return runPasswordSliceIfGiven(job, params);
    case 'completed':
      return { kind: 'result', payload: (job.result_summary as Record<string, unknown> | null) ?? resultFor(params.kind, doc) };
    case 'review_required': {
      if (job.review_reason === 'ai_draft') {
        const own = await loadPendingAiFallbackDraft(params.userId, params.documentId);
        if (own.found) return { kind: 'result', payload: pdfProcessResponse(draftResult(doc, own.payload as BankStatementAiFallbackDraft)) };
        // The reading was discarded or is gone: the job can only start again from the file.
        const restarted = await transitionJob(job.id, { status: 'review_required', reviewReason: 'ai_draft' }, {
          status: 'queued', phase: 'read', review_reason: null, attempt: job.attempt + 1, progress_done: 0, consecutive_failures: 0, lease_owner: null, lease_expires_at: null,
        });
        return { kind: 'job', job: restarted ?? job };
      }
      // Waiting for the PDF's password.
      if (!params.password) {
        return { kind: 'result', payload: (job.result_summary as Record<string, unknown> | null) ?? { pipeline_status: 'encrypted', error_code: 'password_required', document_id: params.documentId } };
      }
      if (doc.error_code === 'password_required') {
        const { data: allEvents } = await documentAuditEventsRepository.listForUser(params.userId, 500);
        const recent = (allEvents ?? []).filter((e) => e.document_id === params.documentId);
        if (!checkPasswordAttemptRateLimit({ recentAuditEvents: recent, nowIso: new Date().toISOString() }).allowed) {
          return { kind: 'error', status: 429, code: 'rate_limited', message: 'Too many password attempts for this document recently. Please try again later.' };
        }
      }
      const requeued = await transitionJob(job.id, { status: 'review_required', reviewReason: 'password' }, {
        status: 'queued', phase: 'read', review_reason: null, result_summary: null, consecutive_failures: 0, lease_owner: null, lease_expires_at: null,
      });
      return runPasswordSliceIfGiven(requeued ?? job, params);
    }
    case 'failed': {
      const retried = await resetFailedJobForRetry(job);
      if (!retried) return { kind: 'job', job: (await getJobByDocument(params.userId, params.documentId)) ?? job };
      return runPasswordSliceIfGiven(retried, params);
    }
    default:
      return { kind: 'error', status: 409, code: 'statement_in_progress', message: STATEMENT_STILL_BEING_READ_MESSAGE };
  }
}


// ---------------------------------------------------------------------------
// CONFIRMING an AI reading: queues the writing of the checked lines, it does not write them in the request
// ---------------------------------------------------------------------------

export interface ReviewedAiStatement {
  rows: ReadonlyArray<{ sourceRowNumber: number; transactionDate: string; descriptionRaw: string; amountOriginal: number; creditDebit: 'credit' | 'debit'; balanceAfter: number | null }>;
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
  declaredOpeningBalance: number | null;
  declaredClosingBalance: number | null;
  maskedAccountIdentifier: string | null;
}

export type ConfirmOutcome =
  | { kind: 'job'; job: BankImportJobRow }
  | { kind: 'result'; payload: Record<string, unknown> }
  | { kind: 'error'; status: number; code: string; message: string };

/**
 * The person has checked the AI reading and confirms it. Claiming the draft is ONE conditional update (pending_review -> confirmed),
 * so a replayed or concurrent confirmation claims nothing and writes nothing; the job then moves review_required -> queued for the
 * `plan_confirmed` phase, which builds the plan from the CONFIRMED draft stored in the database (never from the browser again), so a
 * killed or failed slice resumes without the person confirming twice and without the raw file (it may already be gone).
 *
 * Healing: if an earlier request claimed the draft and died before the job moved on, the next confirm finds the draft already
 * confirmed and moves the job on.
 */
export async function confirmAiDraftIntoJob(params: { userId: string; documentId: string; reviewed: ReviewedAiStatement }): Promise<ConfirmOutcome> {
  const { userId, documentId, reviewed } = params;
  const doc = await loadOwnedDoc(userId, documentId);
  if (!doc) return { kind: 'error', status: 404, code: 'not_found', message: 'document not found' };
  if (!doc.financial_account_id) {
    return { kind: 'error', status: 422, code: 'account_unresolved', message: 'We could not tell which account this statement belongs to. Please resolve the account before confirming.' };
  }
  if (reviewed.rows.length === 0) return { kind: 'error', status: 409, code: 'invalid_state', message: 'At least one transaction is required.' };
  const noDraft: ConfirmOutcome = { kind: 'error', status: 409, code: 'invalid_state', message: 'This statement has no AI-extracted draft awaiting confirmation.' };

  let job = await getJobByDocument(userId, documentId);
  if (!job) {
    // A reading made before background import existed: give it a job that waits for exactly this confirmation.
    if (doc.processing_status !== 'processing') return noDraft;
    const created = await createJobIfAbsent({ userId, documentId, kind: 'pdf' });
    if (created.outcome === 'idempotency_key_in_use') return noDraft;
    job = created.job;
    if (job.status === 'queued') {
      job = (await transitionJob(job.id, { status: 'queued' }, { status: 'review_required', review_reason: 'ai_draft', phase: 'ai_review', checkpoint: { resume_phase: 'plan_confirmed', origin: 'ai' } })) ?? job;
    }
  }

  if (job.status === 'completed') return { kind: 'result', payload: (job.result_summary as Record<string, unknown> | null) ?? resultFor('pdf', doc) };
  if ((job.status === 'queued' || job.status === 'processing') && ['plan_confirmed', 'persist', 'finalize'].includes(job.phase)) {
    return { kind: 'job', job }; // a replay of a confirmation that is already being saved
  }
  if (job.status !== 'review_required' || job.review_reason !== 'ai_draft') return noDraft;

  const claim = await claimPendingAiFallbackDraft({ userId, documentId, confirmedPayload: reviewed });
  if (!claim.claimed) {
    const already = await loadConfirmedAiFallbackDraft(userId, documentId);
    if (!already.found) return noDraft;
  } else {
    await recordDocumentAuditEvent({ userId, documentId, eventType: 'bank_statement_ai_fallback_confirmed', actorType: 'user' });
  }
  const moved = await transitionJob(job.id, { status: 'review_required', reviewReason: 'ai_draft' }, {
    status: 'queued',
    phase: 'plan_confirmed',
    review_reason: null,
    progress_done: 0,
    progress_total: reviewed.rows.length,
    consecutive_failures: 0,
    lease_owner: null,
    lease_expires_at: null,
    checkpoint: { ...job.checkpoint, resume_phase: 'plan_confirmed', origin: 'ai_confirmed' },
  });
  return { kind: 'job', job: moved ?? (await getJobByDocument(userId, documentId)) ?? job };
}
