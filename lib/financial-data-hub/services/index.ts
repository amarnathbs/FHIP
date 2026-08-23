/**
 * Financial Data Hub — service boundary.
 *
 * WHAT THIS LAYER IS FOR. A service owns a decision; a repository owns a
 * query. FDH-1 has very few decisions to make because it implements no
 * ingestion, so this file is deliberately small. It exists to establish the
 * boundary — validate, then decide, then persist — so FDH-3 onwards has a
 * shape to grow into instead of inventing one per phase.
 *
 * WHAT THIS LAYER IS NOT. There is no `financialDataService.ts` god object.
 * The contexts (accounts, documents, transactions, review, quality, master
 * data, provenance) stay separate, matching how `lib/services/**` is already
 * organised in this repository.
 *
 * HARD ISOLATION RULES, restated where they are easiest to violate:
 *
 *   1. Nothing in this module may be imported by `lib/engines/**` — the
 *      dashboard, health score, financial DNA, resilience, goals, forecasting,
 *      Financial Twin, reports or recommendations engines. FDH-1 must have
 *      ZERO downstream analytical side effects.
 *   2. Nothing in this module writes to `income_sources`, `expense_items`,
 *      `assets`, `liabilities`, `investments`, `retirement_accounts` or
 *      `insurance_policies`, and nothing creates an Input Data proposal. The
 *      bridge begins at FDH-15.
 *   3. Nothing in this module imports an Investment Intelligence calculation
 *      engine or modifies an II formula. Should FDH ever need II awareness, it
 *      takes an adapter contract (see FDH1_INVESTMENT_BOUNDARY.md section 5);
 *      the actual integration is FDH-11.
 *
 * All three are asserted by `tests/unit/fdh1Isolation.test.ts`, which reads
 * the real source tree rather than trusting this comment.
 */

import {
  assertDocumentTransition,
  assertPurgeTransition,
  isPurgeEligible,
} from '../domain/documentLifecycle';
import { assertAllocationsReconcile, checkAllocationsReconcile } from '../domain/allocations';
import {
  buildStatementUploadPurgePatch,
  buildTransactionPurgePatch,
  isTransactionSafeToPurgeRaw,
} from '../domain/privacy';
import { toAdminOperationalMetadata } from '../constants/adminBoundary';
import { isFdhDocumentUploadEnabled } from '../constants/featureFlags';
import * as uploadLifecycle from './uploadLifecycle';
import * as purge from './purge';

export * as accountsRepositories from '../repositories';

/**
 * FDH-3 upload-lifecycle service surface (spec section 8/27). Unlike the
 * decision-only surfaces below, these DO have real effects — they write
 * storage bytes and rows — because FDH-3 is the phase that introduces
 * document ingestion. See each function's own module comment in
 * `./uploadLifecycle.ts` for its authorization discipline.
 */
export const documentUploadService = {
  createUploadSession: uploadLifecycle.createUploadSession,
  completeUpload: uploadLifecycle.completeUpload,
  getDocumentStatus: uploadLifecycle.getDocumentStatus,
  listDocuments: uploadLifecycle.listDocuments,
  deleteDocument: uploadLifecycle.userDeleteDocument,
  requestDocumentPreview: uploadLifecycle.requestDocumentPreview,
  isUploadEnabled: isFdhDocumentUploadEnabled,
};

/** FDH-3 purge service surface (spec section 41-43, 99). See
 * `./purge.ts`'s module comment for the invocation contract — no scheduler
 * is wired up; this is called from `scripts/fdh3_run_purge_sweep.mjs`. */
export const documentPurgeService = {
  scheduleApprovedDocumentPurge: purge.scheduleApprovedDocumentPurge,
  runPurgeAttempt: purge.runPurgeAttempt,
  findDuePurges: purge.findDuePurges,
  sweepAbandonedUploadSessions: purge.sweepAbandonedUploadSessions,
};

/**
 * Document lifecycle service surface.
 *
 * FDH-1 exposes the DECISIONS (is this transition legal? is this document
 * eligible for purge?) and none of the effects (upload, extract, approve,
 * delete bytes) — those need storage, parsers and a worker, all of which are
 * later phases.
 */
export const documentLifecycleService = {
  assertTransition: assertDocumentTransition,
  assertPurgeTransition,
  isPurgeEligible,
};

/**
 * Split-transaction integrity service surface.
 *
 * `check…` returns a structured result for a UI to render; `assert…` throws
 * and is what a finalisation path calls.
 */
export const allocationService = {
  check: checkAllocationsReconcile,
  assertFinalised: assertAllocationsReconcile,
};

/**
 * Privacy lifecycle service surface. Builds the patches a future purge worker
 * will apply; performs no writes and deletes no bytes in FDH-1.
 */
export const privacyLifecycleService = {
  buildStatementUploadPurgePatch,
  buildTransactionPurgePatch,
  isTransactionSafeToPurgeRaw,
};

/**
 * The admin boundary, exposed as a service so FDH-13 has exactly one correct
 * way to build an operational-metadata projection.
 *
 * There is no method here that returns document CONTENT, and none that reads
 * another user's rows — Product Owner Decision 3. FDH-1 ships no admin route
 * that calls this.
 */
export const adminOperationalMetadataService = {
  project: toAdminOperationalMetadata,
};
