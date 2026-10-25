// Investment Intelligence R2 — the document-processing entry point.
//
// The pipeline itself (SOURCE DOCUMENT -> SAFE EXTRACTION -> SOURCE-SPECIFIC PARSER -> FOLIO/ACCOUNT RESOLUTION -> SCHEME/INSTRUMENT
// RESOLUTION -> TRANSACTION NORMALISATION -> HOLDING RECONCILIATION -> EXCEPTION QUEUE -> CERTIFIED CANONICAL PORTFOLIO) lives in
// statementPipeline.ts as resumable STEPS (Document2 (4) WP-J). This file keeps the public entry points every caller already uses:
//
//   processSourceDocument  runs ALL steps in one go, in memory. This is the synchronous path (tests, scripts, any caller that wants one
//                          answer). Production requests do NOT use it for a statement: they admit a durable job (statementJob/) that
//                          runs the SAME steps in short slices, because a large statement cannot finish inside the platform's
//                          28 second request limit.
//   recertifyPosition      re-runs the certification decision for one position from stored data (no file).
//
// Every DB write uses the service-role client, matching R1's pattern for trusted, already-authenticated server-side pipelines: the CALLER
// (the API route) is responsible for requireUser() and for confirming the document belongs to that user BEFORE calling. The pipeline
// re-checks ownership itself (every query is scoped by user_id), so a guessed id of another user's document finds nothing.

import { createAdminClient } from '@/lib/supabase/admin';
import type { AieDocumentProvider } from './aiFallbackDocumentExtraction';
import { createMemoryStore, initialPipelineState, preflightProcessing, runPipelineSlice, type PipelineEnv, type ProcessSourceDocumentResult } from './statementPipeline';

export type { ProcessSourceDocumentResult } from './statementPipeline';

export interface ProcessSourceDocumentInput {
  /** The AUTHENTICATED session user's id. The AI fallback re-checks this user's Premium entitlement itself, immediately before any provider call. */
  userId: string;
  sourceDocumentId: string;
  password?: string;
  forceReparse?: boolean;
  /** Test/DI seam for the generalized AI-fallback mechanism. Never set outside tests/manual verification. */
  aiDocumentProviderOverride?: AieDocumentProvider | null;
}

// Moved to reconciliationCases.ts so callers that only need this helper do not have to import the pdf-parse dependency chain.
export { openReconciliationCase } from './reconciliationCases';
// Moved to statementStaging.ts (shared by the pipeline and the job); exported here unchanged for existing import sites and tests.
export { mergeSchemeRecords } from './statementStaging';
export { recertifyPosition, evaluatePositionAndCertify } from './positionCertification';

export async function processSourceDocument(input: ProcessSourceDocumentInput): Promise<ProcessSourceDocumentResult> {
  const admin = createAdminClient();
  const pre = await preflightProcessing(admin, input);
  if (pre.kind === 'answer') return pre.result;
  const env: PipelineEnv = {
    userId: input.userId,
    documentId: input.sourceDocumentId,
    admin,
    store: createMemoryStore(),
    state: initialPipelineState('process', input.forceReparse === true),
    save: async () => true,
    timeLeftMs: () => Number.POSITIVE_INFINITY,
    jobId: null,
    attempt: 1,
    password: input.password,
    aiProviderOverride: input.aiDocumentProviderOverride,
  };
  const out = await runPipelineSlice(env);
  if (out.kind === 'finished') return out.result;
  throw new Error('The processing did not finish although it had no time limit.');
}
