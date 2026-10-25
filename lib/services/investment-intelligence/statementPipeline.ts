// Investment Intelligence -- the statement-processing PIPELINE as resumable STEPS (Document2 (4) WP-J).
//
// This is the body of the old single `processSourceDocument` function, cut at the places where it did bulk work, so that the SAME
// code can run
//   (a) in one go, in memory (the synchronous path, used by tests and by any caller that wants one answer), and
//   (b) as short lease-guarded SLICES of a durable job (the production path), each slice a separate web request that stays well inside
//       the platform's 28 second limit, resuming from a checkpoint.
//
//   read -> accounts -> owner -> schemes -> transactions -> holdings -> analyse -> certify -> finalize
//
// WHAT A STEP IS. A step does a bounded amount of work, persists its cursor (and anything later steps need) and either asks for another
// slice (`more`), moves on (`next`) or ends the whole run with an answer (`finished`). Everything a step needs from an earlier step is
// read back from the STAGING store, never from memory, so a killed slice loses nothing but the work of its last unit.
//
// IDEMPOTENT BY CONSTRUCTION (so a killed and resumed run changes nothing economically):
//   * accounts, instruments    resolved by find-or-create; a replay finds what the first attempt created
//   * transactions             matched by their fingerprint (unique per account in the database); rows this run already wrote are
//                              recognised by the run id and are not written, linked twice or counted twice; ids are DERIVED from the run
//                              and the fingerprint, so a replayed review case points at the same row
//   * holding snapshots        insert-if-absent per (account, instrument, date)
//   * review cases             opened idempotently (same user, subject, type, statement while open)
//   * counters                 saved WITH the cursor in one write, so a replayed unit recounts only itself
//
// STAGING. The PDF is read once, in the `read` step, with the password if there is one. The parsed result is then staged as temporary
// server-only rows (statementStaging.ts) and no later step needs the file or the password. The raw file is deleted at the end exactly
// as before (finalize), and the staging with the job.
//
// PERFORMANCE (measured on DEV, docs/reviews/DOCUMENT2_4_REPORT_WP-J.md): the old code certified EVERY (folio, scheme) combination of
// the statement, although a folio holds only a few schemes. For N positions that is about N x N/2 evaluations, each with a handful of
// round trips: two thirds of the whole time for 25 positions, and quadratic after that. Certification now covers only combinations that
// exist (the statement's own lines plus stored snapshots); a combination with neither was answered "nothing to certify" by the old code.

import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { emitAuditEvent } from './audit';
import { downloadSourceDocumentObject } from './storage';
import { purgeSourceDocumentStorage } from './sourceDocumentPurge';
import { hasStoredFile, SOURCE_FILE_NOT_STORED_STATUS, SOURCE_FILE_NOT_STORED_MESSAGE } from './caseLifecycle';
import { extractPdfText } from './pdfExtraction';
import { parseExtractedDocument } from './parsers/registry';
import type { ParsedAccountRecord, ParsedInstrumentRecord } from './parsers/types';
import { createSchemeKeying } from './schemeKeying';
import { matchStatementOwner, type Pc5HouseholdMemberForMatching } from '@/lib/aie/adapters/investment-intelligence/ownerMatching';
import { loadHouseholdMembersForMatching } from '@/lib/aie/adapters/investment-intelligence/householdContext';
import { resolveOrCreateAccount, prefetchActiveAccounts, type PrefetchedAccount } from './accountResolution';
import { applyDocumentOwnerToAccounts, computeHolderNameWarnings, readDocumentOwner, saveOwnerReview, withoutAcknowledgedWarnings, type ApplyAccount, type OwnerReview } from './documentOwner';
import { loadDecidedOwnershipAccountIds, loadExplicitOwnerAccountIds } from './accountOwnership';
import { resolveScheme, type AliasMapRow, type ExistingInstrumentForResolution } from './schemeResolution';
import { computeTransactionFingerprint } from './fingerprint';
import { loadActiveReconciliationConfig } from './reconciliationConfig';
import { scaledToDecimalString, ZERO } from './decimal';
import { normaliseSchemeName } from './parsers/textUtils';
import type { IiPlanType, IiOptionType } from './types';
import { fetchAllRows } from './pagination';
import { NaturalKeyPool, decideReRead, type ReReadLine, type StoredDocTransaction } from './reparseMatching';
import { resolveCrossSourceTransactionMatch, type CrossSourceExistingTransaction } from './crossSourceIdentity';
import {
  findResolvedAmbiguousInstrumentOverride,
  auditUserResolvedAmbiguousInstrument,
  type InstrumentResolutionSignature,
  type AmbiguousInstrumentCandidate,
} from './ambiguousInstrumentResolution';
import { checkPasswordAttemptRateLimit } from '@/lib/financial-data-hub/bank-pdf/password';
import { MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR } from '@/lib/financial-data-hub/bank-pdf/constants';
import { detectMissingTransactions } from './missingTransactionDetection';
import { openReconciliationCase } from './reconciliationCases';
import { CROSS_SOURCE_INSERT_STATUS, CROSS_SOURCE_REVIEW_SEVERITY } from './crossSourceReviewPolicy';
import { openUserDateSupersessionCases, type StatementTransactionForSupersession } from './userDateSupersession';
import { getAiFallbackDocumentExtraction, iiAiCallEvidenceMetadata, type AiFallbackDocumentOutcome, type AieDocumentProvider } from './aiFallbackDocumentExtraction';
import { maskText } from '@/lib/aie/masking/piiMasking';
import { evaluatePositionAndCertify, recertifyPosition, type CertifyCache } from './positionCertification';
import {
  deterministicUuid,
  fromPlain,
  makeResolveRowKey,
  mergeSchemeRecords,
  stageParsed,
  toPlain,
  unstageHold,
  unstageTxn,
  type StagedHold,
  type StagedMeta,
  type StagedTxn,
} from './statementStaging';
import { closeDeadParseRuns } from './statementJob/deadRuns';
import { statementJobProgress, type StatementJobPhase } from './statementJob/model';
import type { StatementChunkKind } from './statementJob/store';

type Admin = ReturnType<typeof createAdminClient>;

// ---------------------------------------------------------------------------------------------------------------------
// Public types (ProcessSourceDocumentResult is the answer the process route has always given)
// ---------------------------------------------------------------------------------------------------------------------
export interface ProcessSourceDocumentResult {
  ok: boolean;
  status: string; // resulting ii_source_documents.status
  parseRunId: string | null;
  summary?: {
    sourceDetected: string | null;
    sourceConfidence: number;
    accountsFound: number;
    schemesFound: number;
    transactionsFound: number;
    holdingsFound: number;
    duplicateTransactionsLinked: number;
    reconciliationCasesOpened: number;
    /** Genuinely new ii_transactions rows this run inserted (not a same-fingerprint duplicate of an already-recorded transaction). */
    newTransactionsCount: number;
    /** Previously-recorded transactions, dated within this statement's own coverage period, that this statement did not re-confirm. */
    missingTransactionsCount: number;
  };
  error: string | null;
  reconciliationCaseId?: string | null;
  /** Set when status === 'ai_review_pending': the id of the ii_ai_extraction_reviews row the user must accept/reject. */
  aiExtractionReviewId?: string | null;
  /** Set by a re-evaluation job (status 'reevaluated'): how many positions were evaluated and how many could not be. */
  reevaluated?: { evaluated: number; failed: number };
}

export type PipelineStep = Exclude<StatementJobPhase, 'done'> | 'done';

export interface PipelineState {
  v: 1;
  kind: 'process' | 'reevaluate';
  forceReparse: boolean;
  step: PipelineStep;
  hadPriorSucceeded: boolean;
  parseRunId: string | null;
  aiAttempted: boolean;
  extractionMethod: string | null;
  detection: { sourceKey: string | null; confidence: number } | null;
  ownerUnresolved: boolean;
  unresolvedSchemeCount: number;
  counts: { assignments: number; schemes: number; txns: number; holdings: number; txnBatches: number; holdBatches: number; covered: number; pairs: number };
  cursors: { accounts: number; owner: number; schemes: number; txnBatch: number; holdBatch: number; analyse: number; supersession: number; certify: number; pairsBuilt: boolean; reversalDone: boolean };
  counters: { casesOpened: number; duplicateLinked: number; missing: number; matchedToExisting: number };
  owner: { conflicts: OwnerReview['conflicts']; warnings: OwnerReview['warnings']; appliedAccountIds: string[]; targetSignature: string | null } | null;
  /** reevaluate jobs: nothing else is needed, the positions are listed in staging. */
  evaluated: number;
  failedEvaluations: number;
}

export function initialPipelineState(kind: 'process' | 'reevaluate', forceReparse: boolean): PipelineState {
  return {
    v: 1,
    kind,
    forceReparse,
    step: kind === 'process' ? 'read' : 'certify',
    hadPriorSucceeded: false,
    parseRunId: null,
    aiAttempted: false,
    extractionMethod: null,
    detection: null,
    ownerUnresolved: false,
    unresolvedSchemeCount: 0,
    counts: { assignments: 0, schemes: 0, txns: 0, holdings: 0, txnBatches: 0, holdBatches: 0, covered: 0, pairs: 0 },
    cursors: { accounts: 0, owner: 0, schemes: 0, txnBatch: 0, holdBatch: 0, analyse: 0, supersession: 0, certify: 0, pairsBuilt: false, reversalDone: false },
    counters: { casesOpened: 0, duplicateLinked: 0, missing: 0, matchedToExisting: 0 },
    owner: null,
    evaluated: 0,
    failedEvaluations: 0,
  };
}

/** Reads a checkpoint written by an older or partial state back into a complete state. */
export function hydratePipelineState(raw: Record<string, unknown> | null | undefined, kind: 'process' | 'reevaluate', forceReparse: boolean): PipelineState {
  const base = initialPipelineState(kind, forceReparse);
  if (!raw || raw.v !== 1) return base;
  const r = raw as Partial<PipelineState>;
  return {
    ...base,
    ...r,
    counts: { ...base.counts, ...(r.counts ?? {}) },
    cursors: { ...base.cursors, ...(r.cursors ?? {}) },
    counters: { ...base.counters, ...(r.counters ?? {}) },
  } as PipelineState;
}

/** Progress as a figure out of 100, from the state alone. */
export function pipelineProgress(state: PipelineState): { done: number; total: number } {
  const c = state.cursors;
  const n = state.counts;
  const frac = (done: number, total: number) => (total <= 0 ? 1 : done / total);
  switch (state.step) {
    case 'accounts':
      return statementJobProgress('accounts', frac(c.accounts, n.assignments));
    case 'owner':
      return statementJobProgress('owner', frac(c.owner, n.assignments));
    case 'schemes':
      return statementJobProgress('schemes', frac(c.schemes, n.schemes));
    case 'transactions':
      return statementJobProgress('transactions', frac(c.txnBatch, n.txnBatches));
    case 'holdings':
      return statementJobProgress('holdings', frac(c.holdBatch, n.holdBatches));
    case 'analyse':
      return statementJobProgress('analyse', frac(c.analyse, n.covered));
    case 'certify': {
      if (state.kind === 'reevaluate') return { done: Math.round(frac(c.certify, n.pairs) * 100), total: 100 };
      return statementJobProgress('certify', c.pairsBuilt ? frac(c.certify, n.pairs) : 0);
    }
    default:
      return statementJobProgress(state.step as StatementJobPhase, null);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Staging store (a database table for a job, a Map for the in-memory run)
// ---------------------------------------------------------------------------------------------------------------------
export interface PipelineStore {
  put(kind: StatementChunkKind, seq: number, payload: unknown): Promise<void>;
  get(kind: StatementChunkKind, seq: number): Promise<unknown | null>;
  list(kind: StatementChunkKind): Promise<Array<{ seq: number; payload: unknown }>>;
  clear(kinds?: StatementChunkKind[]): Promise<void>;
}

export function createMemoryStore(): PipelineStore {
  const m = new Map<string, unknown>();
  const key = (k: string, s: number) => `${k}:${s}`;
  return {
    async put(kind, seq, payload) {
      m.set(key(kind, seq), JSON.parse(JSON.stringify(payload)));
    },
    async get(kind, seq) {
      return m.get(key(kind, seq)) ?? null;
    },
    async list(kind) {
      return [...m.entries()]
        .filter(([k]) => k.startsWith(`${kind}:`))
        .map(([k, payload]) => ({ seq: Number(k.slice(kind.length + 1)), payload }))
        .sort((a, b) => a.seq - b.seq);
    },
    async clear(kinds) {
      for (const k of [...m.keys()]) if (!kinds || kinds.some((x) => k.startsWith(`${x}:`))) m.delete(k);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The environment a step runs in
// ---------------------------------------------------------------------------------------------------------------------
export interface PipelineEnv {
  userId: string;
  documentId: string;
  admin: Admin;
  store: PipelineStore;
  state: PipelineState;
  /** Persists `state`. false = the lease was lost (another slice took over): the step must stop writing. */
  save: () => Promise<boolean>;
  timeLeftMs: () => number;
  jobId: string | null;
  attempt: number;
  /** The document password for the `read` step of THIS call only. Never stored, never staged. */
  password?: string;
  aiProviderOverride?: AieDocumentProvider | null;
  /** Test seam: called at named points; a test throws from it to simulate a slice killed there. */
  fault?: (point: string) => void | Promise<void>;
}

type StepOut = { kind: 'more' } | { kind: 'next'; to: PipelineStep } | { kind: 'finished'; result: ProcessSourceDocumentResult } | { kind: 'lost' };

export type SliceOutcome = { kind: 'more' } | { kind: 'finished'; result: ProcessSourceDocumentResult } | { kind: 'lost' };

const more = (): StepOut => ({ kind: 'more' });

/**
 * Time check for a step's loop. The FIRST unit of every slice always runs (so a slice always makes progress, whatever its budget);
 * after that the step stops when the slice's time is spent.
 */
function unitGuard(env: PipelineEnv): () => boolean {
  let units = 0;
  return () => units++ > 0 && env.timeLeftMs() <= 0;
}
const next = (to: PipelineStep): StepOut => ({ kind: 'next', to });
const finished = (result: ProcessSourceDocumentResult): StepOut => ({ kind: 'finished', result });

async function fault(env: PipelineEnv, point: string): Promise<void> {
  await env.fault?.(point);
}

/** Runs `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const chunked = <T,>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------
// Preflight: everything the old function decided BEFORE it started a run (shared by the synchronous path and job admission)
// ---------------------------------------------------------------------------------------------------------------------
const PASSWORD_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

export type Preflight =
  | { kind: 'answer'; result: ProcessSourceDocumentResult }
  | { kind: 'run'; doc: Record<string, unknown> };

export async function preflightProcessing(
  admin: Admin,
  input: { userId: string; sourceDocumentId: string; password?: string; forceReparse?: boolean },
  opts: { liveJobId?: string | null } = {},
): Promise<Preflight> {
  const { userId, sourceDocumentId } = input;
  const { data: doc, error: docErr } = await admin.from('ii_source_documents').select('*').eq('id', sourceDocumentId).eq('user_id', userId).maybeSingle();
  if (docErr || !doc) return { kind: 'answer', result: { ok: false, status: 'not_found', parseRunId: null, error: 'Source document not found.' } };

  // Resuming an AI reading that awaits the user's review: the review is returned straight away -- no download, no parse, no provider call.
  if (!input.forceReparse && doc.status === 'ai_review_pending') {
    const { data: pendingReview } = await admin
      .from('ii_ai_extraction_reviews')
      .select('id')
      .eq('user_id', userId)
      .eq('source_document_id', sourceDocumentId)
      .eq('status', 'pending_review')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (pendingReview) return { kind: 'answer', result: { ok: false, status: 'ai_review_pending', parseRunId: null, error: null, aiExtractionReviewId: pendingReview.id as string } };
  }

  const { data: priorSucceededRun } = await admin
    .from('ii_document_parse_runs')
    .select('*')
    .eq('source_document_id', sourceDocumentId)
    .eq('run_status', 'succeeded')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // Idempotency: at most one active run at a time. A run is ALIVE only if something is demonstrably working on it (a live job, or a
  // very recent run of the old synchronous path); anything else is dead and is closed here with an honest reason (deadRuns.ts).
  const { alive } = await closeDeadParseRuns(admin, sourceDocumentId, { liveJobId: opts.liveJobId ?? null });
  if (alive) return { kind: 'answer', result: { ok: false, status: doc.status as string, parseRunId: alive.id, error: 'This document is already being processed.' } };

  // A prior SUCCEEDED run is not silently re-run unless forced.
  if (!input.forceReparse && priorSucceededRun) {
    if (doc.status !== 'parsed') await admin.from('ii_source_documents').update({ status: 'parsed', parse_error: null }).eq('id', sourceDocumentId);
    return {
      kind: 'answer',
      result: {
        ok: true,
        status: 'parsed',
        parseRunId: priorSucceededRun.id as string,
        summary: {
          sourceDetected: priorSucceededRun.source_detected as string | null,
          sourceConfidence: (priorSucceededRun.source_confidence as number) ?? 0,
          accountsFound: priorSucceededRun.accounts_found as number,
          schemesFound: priorSucceededRun.schemes_found as number,
          transactionsFound: priorSucceededRun.transactions_found as number,
          holdingsFound: priorSucceededRun.holdings_found as number,
          duplicateTransactionsLinked: (priorSucceededRun.duplicate_transactions_linked as number) ?? 0,
          reconciliationCasesOpened: 0,
          newTransactionsCount: (priorSucceededRun.new_transactions_count as number) ?? 0,
          missingTransactionsCount: (priorSucceededRun.missing_transactions_count as number) ?? 0,
        },
        error: null,
      },
    };
  }

  // The raw file is TEMPORARY by design (WP-B): a file-dependent run needs a replacement copy, it never opens a run on a deleted file.
  if (!hasStoredFile({ storagePath: (doc.storage_path as string | null) ?? null, storagePurgedAt: (doc.storage_purged_at as string | null) ?? null })) {
    return { kind: 'answer', result: { ok: false, status: SOURCE_FILE_NOT_STORED_STATUS, parseRunId: null, error: SOURCE_FILE_NOT_STORED_MESSAGE } };
  }

  // M12C §10: the shared password-attempt limiter. The attempt is recorded as the run row written (with password_supplied) before any
  // decryption; a REFUSED attempt consumes no slot.
  if (typeof input.password === 'string' && input.password.length > 0) {
    const windowStartIso = new Date(Date.now() - PASSWORD_ATTEMPT_WINDOW_MS).toISOString();
    const { data: priorAttempts } = await admin
      .from('ii_document_parse_runs')
      .select('started_at')
      .eq('source_document_id', sourceDocumentId)
      .eq('user_id', userId)
      .eq('password_supplied', true)
      .gte('started_at', windowStartIso)
      .order('started_at', { ascending: false })
      .limit(MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR + 1);
    const rateLimit = checkPasswordAttemptRateLimit({
      recentAuditEvents: (priorAttempts ?? []).map((r) => ({ event_type: 'pdf_password_required', created_at: r.started_at as string })),
      nowIso: new Date().toISOString(),
    });
    if (!rateLimit.allowed) {
      await emitAuditEvent({
        userId,
        eventType: 'document_processing_failed',
        subjectType: 'ii_source_documents',
        subjectId: sourceDocumentId,
        actorType: 'system',
        metadata: { kind: 'password_rate_limited', attemptsInWindow: rateLimit.attemptsInWindow },
      });
      return { kind: 'answer', result: { ok: false, status: 'password_rate_limited', parseRunId: null, error: 'Too many password attempts for this document recently. Please try again later.' } };
    }
  }
  return { kind: 'run', doc };
}

// ---------------------------------------------------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------------------------------------------------
function honestFailureMessage(baseMessage: string, aiOutcome: AiFallbackDocumentOutcome): string {
  switch (aiOutcome.outcome) {
    case 'premium_required':
      return `${baseMessage} AI-assisted re-extraction is a Premium feature; you can upgrade to Premium to have this statement read for you.`;
    case 'malware_scan_not_enforced':
      return `${baseMessage} AI-assisted re-extraction is not available right now.`;
    case 'daily_limit_reached':
      return `${baseMessage} You have reached the daily limit for AI-assisted reading, so it was not attempted. The limit resets every day: please try again tomorrow, or enter the figures manually.`;
    case 'entitlement_unavailable':
      return `${baseMessage} We could not confirm your plan just now, so AI-assisted re-extraction was not attempted. Please try again in a moment.`;
    case 'unavailable':
      return `${baseMessage} An AI-assisted re-extraction was also attempted and is not available in this deployment.`;
    case 'no_usable_data':
      return `${baseMessage} An AI-assisted re-extraction was also attempted and could not produce usable scheme/cost-value/market-value/unit data either.`;
    case 'still_failed':
      return `${baseMessage} An AI-assisted re-extraction was also attempted and failed (${aiOutcome.reason}).`;
    case 'already_decided':
      return aiOutcome.status === 'rejected' ? `${baseMessage} An AI-assisted extraction was previously attempted and reviewed, but you declined to accept its results.` : baseMessage;
    case 'disabled':
    default:
      return baseMessage;
  }
}

function aiEvidenceMetadataFor(aiOutcome: AiFallbackDocumentOutcome): Record<string, unknown> {
  return 'evidence' in aiOutcome ? iiAiCallEvidenceMetadata(aiOutcome.evidence) : {};
}

async function failRun(admin: Admin, parseRunId: string, message: string) {
  await admin.from('ii_document_parse_runs').update({ run_status: 'failed', completed_at: new Date().toISOString(), errors: [{ code: 'orchestration_error', message, severity: 'error' }] }).eq('id', parseRunId);
}

async function updateDocumentStatusUnlessSucceeded(env: PipelineEnv, fields: Record<string, unknown>) {
  if (env.state.hadPriorSucceeded) return;
  await env.admin.from('ii_source_documents').update(fields).eq('id', env.documentId);
}

async function handleExtractionFailure(
  admin: Admin,
  userId: string,
  sourceDocumentId: string,
  parseRunId: string,
  kind: 'password_required' | 'wrong_password' | 'corrupt' | 'insufficient_text' | 'unknown_error',
  errorMessage: string,
  preserveDocumentStatus = false,
): Promise<ProcessSourceDocumentResult> {
  const statusByKind: Record<typeof kind, string> = {
    password_required: 'password_required',
    wrong_password: 'password_required',
    corrupt: 'parse_failed',
    insufficient_text: 'unsupported',
    unknown_error: 'parse_failed',
  };
  const discrepancyByKind: Record<typeof kind, string> = {
    password_required: 'document_password_required',
    wrong_password: 'document_password_required',
    corrupt: 'document_corrupt',
    insufficient_text: 'unsupported_document',
    unknown_error: 'document_corrupt',
  };
  const status = statusByKind[kind];
  // A failed re-supply must be reported truthfully to THIS caller but must never drag a document that already succeeded out of 'parsed'.
  if (!preserveDocumentStatus) {
    await admin.from('ii_source_documents').update({ status, parse_error: null }).eq('id', sourceDocumentId); // errorMessage is never stored verbatim: it could echo a password-shaped input
  }
  await admin
    .from('ii_document_parse_runs')
    .update({
      run_status: 'failed',
      completed_at: new Date().toISOString(),
      password_required: kind === 'password_required' || kind === 'wrong_password',
      password_supplied: kind === 'wrong_password',
      errors: [{ code: kind, message: errorMessage, severity: 'error' }],
    })
    .eq('id', parseRunId);
  const caseId = await openReconciliationCase(userId, {
    subjectType: 'account',
    subjectId: sourceDocumentId,
    discrepancyType: discrepancyByKind[kind],
    severity: 'blocking',
    sourceDocumentId,
    idempotent: {},
    details: { kind }, // the password itself is NEVER included
  });
  await emitAuditEvent({ userId, eventType: 'document_processing_failed', subjectType: 'ii_source_documents', subjectId: sourceDocumentId, actorType: 'system', metadata: { kind, parseRunId } });
  return { ok: false, status, parseRunId, error: errorMessage, reconciliationCaseId: caseId };
}

interface AcctEntry {
  key: string;
  accountId: string | null;
  created: boolean;
  folioNumber: string | null;
  amcName: string;
}
interface InstEntry {
  key: string;
  instrumentId: string | null;
}

async function loadMeta(env: PipelineEnv): Promise<StagedMeta> {
  const raw = await env.store.get('parsed_meta', 0);
  if (!raw) throw new Error('The staged statement is missing (parsed_meta).');
  return fromPlain<StagedMeta>(raw);
}

async function loadResolution(env: PipelineEnv): Promise<{ accounts: Map<string, AcctEntry>; instruments: Map<string, string>; unresolved: Set<string> }> {
  const accounts = new Map<string, AcctEntry>();
  for (const c of await env.store.list('acct')) for (const e of c.payload as AcctEntry[]) if (e.accountId) accounts.set(e.key, e);
  const instruments = new Map<string, string>();
  const unresolved = new Set<string>();
  for (const c of await env.store.list('inst')) {
    for (const e of c.payload as InstEntry[]) {
      if (e.instrumentId) instruments.set(e.key, e.instrumentId);
      else unresolved.add(e.key);
    }
  }
  return { accounts, instruments, unresolved };
}

async function loadDoc(env: PipelineEnv): Promise<Record<string, unknown> | null> {
  const { data } = await env.admin.from('ii_source_documents').select('*').eq('id', env.documentId).eq('user_id', env.userId).maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}

function uniqueSchemesOf(meta: StagedMeta) {
  const keying = createSchemeKeying(meta.schemes);
  const unique = new Map<string, ParsedInstrumentRecord>();
  for (const s of meta.schemes) {
    const key = keying.keyOf(s);
    const existing = unique.get(key);
    unique.set(key, existing ? mergeSchemeRecords(existing, s) : s);
  }
  return { keying, unique };
}

// ---------------------------------------------------------------------------------------------------------------------
// STEP read
// ---------------------------------------------------------------------------------------------------------------------
async function readStep(env: PipelineEnv): Promise<StepOut> {
  const { admin, userId, documentId: sourceDocumentId, state } = env;
  const doc = await loadDoc(env);
  if (!doc) return finished({ ok: false, status: 'not_found', parseRunId: state.parseRunId, error: 'Source document not found.' });

  const { data: prior } = await admin.from('ii_document_parse_runs').select('id').eq('source_document_id', sourceDocumentId).eq('run_status', 'succeeded').limit(1).maybeSingle();
  state.hadPriorSucceeded = Boolean(prior);

  if (!hasStoredFile({ storagePath: (doc.storage_path as string | null) ?? null, storagePurgedAt: (doc.storage_purged_at as string | null) ?? null })) {
    if (state.parseRunId) await failRun(admin, state.parseRunId, SOURCE_FILE_NOT_STORED_MESSAGE);
    return finished({ ok: false, status: SOURCE_FILE_NOT_STORED_STATUS, parseRunId: state.parseRunId, error: SOURCE_FILE_NOT_STORED_MESSAGE });
  }

  // The run row: written BEFORE any decryption, so an attempt that crashes still counts against the password limiter. A job's run is
  // keyed by the job and its attempt, so a slice that died right after writing it finds it again instead of colliding with it.
  const passwordSupplied = typeof env.password === 'string' && env.password.length > 0;
  let parseRunId = state.parseRunId;
  if (!parseRunId) {
    const runKey = env.jobId ? `job:${env.jobId}:${env.attempt}` : `${sourceDocumentId}:r2-orchestrator:${randomUUID()}`;
    if (env.jobId) {
      const { data: own } = await admin.from('ii_document_parse_runs').select('id, run_status').eq('source_document_id', sourceDocumentId).eq('idempotency_key', runKey).maybeSingle();
      if (own && own.run_status === 'running') parseRunId = own.id as string;
    }
    if (!parseRunId) {
      const { alive } = await closeDeadParseRuns(admin, sourceDocumentId, { liveJobId: env.jobId });
      if (alive) return finished({ ok: false, status: doc.status as string, parseRunId: alive.id, error: 'This document is already being processed.' });
      const { data: run, error: runErr } = await admin
        .from('ii_document_parse_runs')
        .insert({
          user_id: userId,
          source_document_id: sourceDocumentId,
          parser_code: 'r2-orchestrator',
          parser_version: 'pending',
          run_status: 'running',
          idempotency_key: runKey,
          password_supplied: passwordSupplied,
        })
        .select('id')
        .single();
      if (runErr || !run) return finished({ ok: false, status: doc.status as string, parseRunId: null, error: runErr?.message ?? 'Could not start a processing run.' });
      parseRunId = run.id as string;
      await fault(env, 'read:run_created');
      await emitAuditEvent({ userId, eventType: 'parse_started', subjectType: 'ii_source_documents', subjectId: sourceDocumentId, actorType: 'user', actorId: userId, metadata: { parseRunId } });
    }
    state.parseRunId = parseRunId;
    if (!(await env.save())) return { kind: 'lost' };
  }

  // --- 1. Safe document extraction (the ONLY place the file and the password are used) -------------------------------------------
  const { bytes, error: dlErr } = await downloadSourceDocumentObject(doc.storage_path as string);
  if (dlErr || !bytes) {
    await failRun(admin, parseRunId, SOURCE_FILE_NOT_STORED_MESSAGE);
    return finished({ ok: false, status: SOURCE_FILE_NOT_STORED_STATUS, parseRunId, error: SOURCE_FILE_NOT_STORED_MESSAGE });
  }
  let text: string;
  let extractionMethod: string;
  if (doc.mime_type === 'application/pdf') {
    const extraction = await extractPdfText(bytes, env.password);
    if (!extraction.ok) return finished(await handleExtractionFailure(admin, userId, sourceDocumentId, parseRunId, extraction.kind, extraction.error, state.hadPriorSucceeded));
    text = extraction.text;
    extractionMethod = 'pdf_text_native';
  } else {
    text = Buffer.from(bytes).toString('utf8');
    extractionMethod = 'csv_text';
  }

  // --- 2. Source identification + parser run -------------------------------------------------------------------------------------
  const { detection, parsed } = parseExtractedDocument(text);
  await emitAuditEvent({
    userId,
    eventType: 'source_detected',
    subjectType: 'ii_source_documents',
    subjectId: sourceDocumentId,
    actorType: 'system',
    metadata: { sourceDetected: detection.detection.sourceKey, confidence: detection.detection.confidence, candidates: detection.allCandidates.map((c) => ({ parserCode: c.parserCode, confidence: c.detection.confidence })) },
  });

  const aiGuard = async (): Promise<StepOut | null> => {
    // The AI reading is billed. A slice that died inside the call must never repeat it silently: the attempt is recorded BEFORE the call.
    if (state.aiAttempted) {
      const message = 'The AI-assisted reading of this statement did not finish. Please try again later, or upload the statement in a supported layout.';
      await failRun(admin, parseRunId!, message);
      await updateDocumentStatusUnlessSucceeded(env, { status: 'parse_failed', parse_error: 'ai_reading_interrupted' });
      return finished({ ok: false, status: 'parse_failed', parseRunId, error: message });
    }
    state.aiAttempted = true;
    if (!(await env.save())) return { kind: 'lost' };
    return null;
  };

  if (!detection.parser || !parsed) {
    const guarded = await aiGuard();
    if (guarded) return guarded;
    const aiOutcome = await getAiFallbackDocumentExtraction({
      userId,
      sourceDocumentId,
      parseRunId,
      triggerReason: 'format_unrecognized',
      buildRequest: () => ({ maskedDocumentText: maskText(text, { tenantKey: userId }).maskedText }),
      providerOverride: env.aiProviderOverride,
    });
    const aiEvidenceMeta = aiEvidenceMetadataFor(aiOutcome);
    if (aiOutcome.outcome === 'pending_review' || aiOutcome.outcome === 'already_pending') {
      await updateDocumentStatusUnlessSucceeded(env, { status: 'ai_review_pending', source_detected: detection.detection.sourceKey, source_confidence: detection.detection.confidence, extraction_method: extractionMethod });
      await admin.from('ii_document_parse_runs').update({ run_status: 'failed', completed_at: new Date().toISOString(), source_detected: detection.detection.sourceKey, source_confidence: detection.detection.confidence, errors: [{ code: 'ai_review_pending', message: 'Format not recognized by the deterministic parser; an AI-assisted extraction is pending user review.', severity: 'info' }] }).eq('id', parseRunId);
      await emitAuditEvent({ userId, eventType: 'parse_failed', subjectType: 'ii_source_documents', subjectId: sourceDocumentId, actorType: 'system', metadata: { reason: 'ai_review_pending', triggerReason: 'format_unrecognized', reviewId: aiOutcome.reviewId, parseRunId, ...aiEvidenceMeta } });
      return finished({ ok: false, status: 'ai_review_pending', parseRunId, error: null, aiExtractionReviewId: aiOutcome.reviewId });
    }
    const status = detection.detection.confidence > 0 ? 'reconciliation_required' : 'unsupported';
    await updateDocumentStatusUnlessSucceeded(env, { status, source_detected: detection.detection.sourceKey, source_confidence: detection.detection.confidence, extraction_method: extractionMethod });
    const caseId = await openReconciliationCase(userId, {
      subjectType: 'account',
      subjectId: sourceDocumentId,
      discrepancyType: 'unsupported_document',
      severity: 'blocking',
      sourceDocumentId,
      idempotent: {},
      details: { sourceConfidence: detection.detection.confidence, candidates: detection.allCandidates, aiFallbackOutcome: aiOutcome.outcome },
    });
    await admin.from('ii_document_parse_runs').update({ run_status: 'failed', completed_at: new Date().toISOString(), source_detected: detection.detection.sourceKey, source_confidence: detection.detection.confidence }).eq('id', parseRunId);
    await emitAuditEvent({ userId, eventType: 'parse_failed', subjectType: 'ii_source_documents', subjectId: sourceDocumentId, actorType: 'system', metadata: { reason: 'source_undetected_or_unsupported', parseRunId, aiFallbackOutcome: aiOutcome.outcome, ...aiEvidenceMeta } });
    return finished({ ok: false, status, parseRunId, error: honestFailureMessage('Statement source/format could not be confidently identified.', aiOutcome), reconciliationCaseId: caseId });
  }

  await emitAuditEvent({ userId, eventType: 'parser_version_used', subjectType: 'ii_source_documents', subjectId: sourceDocumentId, actorType: 'system', metadata: { parserCode: parsed.parserCode, parserVersion: parsed.parserVersion, parseRunId } });

  const validation = detection.parser.validateParsedOutput(parsed);
  if (!validation.ok) {
    const guarded = await aiGuard();
    if (guarded) return guarded;
    const aiOutcome = await getAiFallbackDocumentExtraction({
      userId,
      sourceDocumentId,
      parseRunId,
      triggerReason: 'parse_failed',
      buildRequest: () => ({ maskedDocumentText: maskText(text, { tenantKey: userId }).maskedText }),
      providerOverride: env.aiProviderOverride,
    });
    const aiEvidenceMeta = aiEvidenceMetadataFor(aiOutcome);
    if (aiOutcome.outcome === 'pending_review' || aiOutcome.outcome === 'already_pending') {
      await updateDocumentStatusUnlessSucceeded(env, { status: 'ai_review_pending', parse_error: validation.errors.join('; '), source_detected: detection.detection.sourceKey, source_confidence: detection.detection.confidence, extraction_method: extractionMethod });
      await admin.from('ii_document_parse_runs').update({ run_status: 'failed', completed_at: new Date().toISOString(), errors: [...validation.errors.map((e) => ({ code: 'validation_error', message: e, severity: 'error' as const })), { code: 'ai_review_pending', message: 'Parser validation failed; an AI-assisted extraction is pending user review.', severity: 'info' as const }] }).eq('id', parseRunId);
      await emitAuditEvent({ userId, eventType: 'parse_failed', subjectType: 'ii_source_documents', subjectId: sourceDocumentId, actorType: 'system', metadata: { reason: 'ai_review_pending', triggerReason: 'parse_failed', reviewId: aiOutcome.reviewId, parseRunId, ...aiEvidenceMeta } });
      return finished({ ok: false, status: 'ai_review_pending', parseRunId, error: null, aiExtractionReviewId: aiOutcome.reviewId });
    }
    await updateDocumentStatusUnlessSucceeded(env, { status: 'parse_failed', parse_error: validation.errors.join('; '), source_detected: detection.detection.sourceKey, source_confidence: detection.detection.confidence, extraction_method: extractionMethod });
    const caseId = await openReconciliationCase(userId, {
      subjectType: 'account',
      subjectId: sourceDocumentId,
      discrepancyType: 'parse_incomplete',
      severity: 'blocking',
      sourceDocumentId,
      idempotent: {},
      details: { errors: validation.errors, aiFallbackOutcome: aiOutcome.outcome },
    });
    await admin.from('ii_document_parse_runs').update({ run_status: 'failed', completed_at: new Date().toISOString(), errors: validation.errors }).eq('id', parseRunId);
    await emitAuditEvent({ userId, eventType: 'parse_failed', subjectType: 'ii_source_documents', subjectId: sourceDocumentId, actorType: 'system', metadata: { reason: 'validation_failed', errors: validation.errors, aiFallbackOutcome: aiOutcome.outcome, parseRunId, ...aiEvidenceMeta } });
    return finished({ ok: false, status: 'parse_failed', parseRunId, error: honestFailureMessage(validation.errors.join('; '), aiOutcome), reconciliationCaseId: caseId });
  }

  // --- 3. Stage the structured result; from here no step needs the file or the password ------------------------------------------
  const staged = stageParsed(parsed);
  await env.store.put('parsed_meta', 0, toPlain(staged.meta));
  for (let i = 0; i < staged.txnBatches.length; i++) await env.store.put('parsed_txns', i, toPlain(staged.txnBatches[i]));
  for (let i = 0; i < staged.holdBatches.length; i++) await env.store.put('parsed_holds', i, toPlain(staged.holdBatches[i]));
  await fault(env, 'read:staged');
  const { unique } = uniqueSchemesOf(staged.meta);
  state.extractionMethod = extractionMethod;
  state.detection = { sourceKey: detection.detection.sourceKey, confidence: detection.detection.confidence };
  state.counts = {
    ...state.counts,
    assignments: staged.meta.assignments.length,
    schemes: unique.size,
    txns: staged.meta.txnCount,
    holdings: staged.meta.holdCount,
    txnBatches: staged.meta.txnBatches,
    holdBatches: staged.meta.holdBatches,
  };
  return next('accounts');
}

// ---------------------------------------------------------------------------------------------------------------------
// STEP accounts
// ---------------------------------------------------------------------------------------------------------------------
const ACCOUNT_BATCH = 25;

async function accountsStep(env: PipelineEnv): Promise<StepOut> {
  const stop = unitGuard(env);
  const { userId, documentId: sourceDocumentId, state } = env;
  const meta = await loadMeta(env);
  const doc = await loadDoc(env);
  if (!doc) return finished({ ok: false, status: 'not_found', parseRunId: state.parseRunId, error: 'Source document not found.' });
  const countryCode = doc.country_code as string;
  const currencyCode = countryCode === 'IN' ? 'INR' : 'AUD';
  let prefetched: PrefetchedAccount[] | null = null;
  while (state.cursors.accounts < meta.assignments.length) {
    if (stop()) return more();
    prefetched ??= await prefetchActiveAccounts(userId);
    const from = state.cursors.accounts;
    const slice = meta.assignments.slice(from, from + ACCOUNT_BATCH);
    const entries: AcctEntry[] = [];
    for (const assignment of slice) {
      const resolved = await resolveOrCreateAccount(
        userId,
        {
          accountType: 'mf_folio',
          institutionName: assignment.amcName,
          countryCode,
          currencyCode,
          folioNumber: assignment.folioNumber,
          accountNumberMasked: assignment.accountNumberMasked,
          ownerMemberId: (doc.owner_member_id as string | null) ?? null,
          sourceDocumentId,
        },
        prefetched,
      );
      entries.push({ key: assignment.key, accountId: resolved.accountId, created: resolved.created, folioNumber: assignment.folioNumber, amcName: assignment.amcName });
      if (resolved.accountId) {
        await emitAuditEvent({ userId, eventType: 'account_resolved', subjectType: 'ii_accounts', subjectId: resolved.accountId, actorType: 'system', metadata: { folioNumber: assignment.folioNumber, amcName: assignment.amcName, created: resolved.created, parseRunId: state.parseRunId } });
      }
    }
    await env.store.put('acct', Math.floor(from / ACCOUNT_BATCH), entries);
    await fault(env, 'accounts:written');
    state.cursors.accounts = from + slice.length;
    if (!(await env.save())) return { kind: 'lost' };
  }
  return next('owner');
}

// ---------------------------------------------------------------------------------------------------------------------
// STEP owner
// ---------------------------------------------------------------------------------------------------------------------
const OWNER_BATCH = 40;

async function ownerStep(env: PipelineEnv): Promise<StepOut> {
  const stop = unitGuard(env);
  const { admin, userId, documentId: sourceDocumentId, state } = env;
  const meta = await loadMeta(env);
  const doc = await loadDoc(env);
  if (!doc) return finished({ ok: false, status: 'not_found', parseRunId: state.parseRunId, error: 'Source document not found.' });
  const { accounts } = await loadResolution(env);
  const documentOwner = readDocumentOwner(doc);
  const ownerUnresolved = !documentOwner && !doc.owner_member_id;
  state.ownerUnresolved = ownerUnresolved;
  const parsedAccountByFolio = new Map<string, ParsedAccountRecord>();
  for (const acc of meta.accounts) {
    const key = acc.folioNumber ?? '__no_folio__';
    if (!parsedAccountByFolio.has(key)) parsedAccountByFolio.set(key, acc);
  }
  let members: Pc5HouseholdMemberForMatching[] | null = null;

  while (state.cursors.owner < meta.assignments.length) {
    if (stop()) return more();
    const from = state.cursors.owner;
    const slice = meta.assignments.slice(from, from + OWNER_BATCH);
    const withAccount = slice.map((a) => ({ a, entry: accounts.get(a.key) })).filter((x): x is { a: typeof slice[number]; entry: AcctEntry } => Boolean(x.entry));
    const batchIds = withAccount.map((x) => x.entry.accountId as string);
    const decided = await loadDecidedOwnershipAccountIds(admin, userId, batchIds);
    const explicit = await loadExplicitOwnerAccountIds(admin, userId, batchIds);
    let opened = 0;

    if (documentOwner) {
      // Owner-before-upload: the chosen owner is applied to every folio (never overwriting a DIFFERENT existing owner).
      const applyAccounts: ApplyAccount[] = withAccount.map((x) => ({ accountId: x.entry.accountId as string, created: x.entry.created, folioNumber: x.a.folioNumber, institutionName: x.a.amcName }));
      const review = await applyDocumentOwnerToAccounts(userId, sourceDocumentId, documentOwner, applyAccounts);
      const acc = state.owner ?? { conflicts: [], warnings: [], appliedAccountIds: [], targetSignature: review.targetSignature ?? null };
      acc.conflicts.push(...review.conflicts);
      acc.appliedAccountIds.push(...review.appliedAccountIds);
      acc.targetSignature = review.targetSignature ?? null;
      state.owner = acc;
    } else if (ownerUnresolved) {
      for (const { a, entry } of withAccount) {
        const accountId = entry.accountId as string;
        if (decided.has(accountId)) continue; // owner already decided as entity / joint split
        const acctRecord = parsedAccountByFolio.get(a.folioNumber ?? '__no_folio__');
        if (acctRecord) {
          members ??= await loadHouseholdMembersForMatching(userId);
          const outcome = matchStatementOwner({ holderName: acctRecord.holderName, jointHolders: acctRecord.jointHolders, holdingModeRaw: acctRecord.holdingModeRaw }, members);
          if (outcome.kind === 'joint_holding') {
            const caseId = await openReconciliationCase(userId, {
              subjectType: 'account',
              subjectId: accountId,
              discrepancyType: 'joint_holding_allocation_required',
              severity: 'blocking',
              sourceDocumentId,
              idempotent: {},
              details: {
                maskedHolderName: outcome.maskedHolderName,
                maskedJointHolders: outcome.maskedJointHolders,
                matchedMemberIds: outcome.matchedMemberIds,
                declaredOwnerMemberId: null,
                reason: 'This statement prints a joint holding and no household member was specified at upload time. A single owner cannot be asserted without an allocation decision.',
              },
            });
            if (caseId) opened++;
            continue;
          }
        }
        if (explicit.has(accountId)) continue; // an owner a person already chose stands: never re-ask, never guess
        const caseId = await openReconciliationCase(userId, {
          subjectType: 'account',
          subjectId: accountId,
          discrepancyType: 'owner_unmatched',
          severity: 'blocking',
          sourceDocumentId,
          idempotent: {},
          details: { reason: 'No household member was specified for this statement at upload time.' },
        });
        if (caseId) opened++;
      }
    } else {
      const declaredOwnerMemberId = doc.owner_member_id as string;
      for (const { a, entry } of withAccount) {
        const accountId = entry.accountId as string;
        if (decided.has(accountId)) continue;
        const acctRecord = parsedAccountByFolio.get(a.folioNumber ?? '__no_folio__');
        if (!acctRecord) continue; // no per-account holder evidence printed at all for this folio
        members ??= await loadHouseholdMembersForMatching(userId);
        const outcome = matchStatementOwner({ holderName: acctRecord.holderName, jointHolders: acctRecord.jointHolders, holdingModeRaw: acctRecord.holdingModeRaw }, members);
        if (outcome.kind === 'no_owner_evidence') continue;
        if (outcome.kind === 'joint_holding') {
          const caseId = await openReconciliationCase(userId, {
            subjectType: 'account',
            subjectId: accountId,
            discrepancyType: 'joint_holding_allocation_required',
            severity: 'blocking',
            sourceDocumentId,
            idempotent: {},
            details: {
              maskedHolderName: outcome.maskedHolderName,
              maskedJointHolders: outcome.maskedJointHolders,
              matchedMemberIds: outcome.matchedMemberIds,
              declaredOwnerMemberId,
              reason: 'This statement prints a joint holding. A single declared owner cannot be asserted without an allocation decision.',
            },
          });
          if (caseId) opened++;
          continue;
        }
        const isMatchToDeclared = outcome.kind === 'exact_match' && outcome.memberId === declaredOwnerMemberId;
        if (isMatchToDeclared) continue;
        const caseId = await openReconciliationCase(userId, {
          subjectType: 'account',
          subjectId: accountId,
          discrepancyType: 'owner_mismatch',
          severity: 'blocking',
          sourceDocumentId,
          idempotent: {},
          details: {
            outcomeKind: outcome.kind,
            maskedHolderName: outcome.maskedHolderName,
            declaredOwnerMemberId,
            candidateMemberIds: outcome.kind === 'mismatch' || outcome.kind === 'ambiguous' ? outcome.candidateMemberIds : [],
            matchedMemberId: outcome.kind === 'exact_match' ? outcome.memberId : null,
            reason:
              outcome.kind === 'exact_match'
                ? 'This statement’s printed holder name matches a different household member than the one this statement was filed under.'
                : 'This statement’s printed holder name does not match the household member it was filed under.',
          },
        });
        if (caseId) opened++;
      }
    }
    await fault(env, 'owner:applied');
    state.counters.casesOpened += opened;
    state.cursors.owner = from + slice.length;
    if (!(await env.save())) return { kind: 'lost' };
  }

  if (documentOwner) {
    // The owner review is written once, when every folio has been looked at.
    const review: OwnerReview = {
      conflicts: state.owner?.conflicts ?? [],
      warnings: [...(state.owner?.warnings ?? [])],
      appliedAccountIds: state.owner?.appliedAccountIds ?? [],
      targetSignature: state.owner?.targetSignature ?? null,
    };
    if (documentOwner.kind === 'member' && meta.accounts.length > 0) {
      const membersForWarnings = await loadHouseholdMembersForMatching(userId);
      review.warnings.push(
        ...computeHolderNameWarnings({
          declaredOwnerMemberId: documentOwner.ownerMemberId as string,
          assignments: meta.assignments.map((a) => ({ folioNumber: a.folioNumber, accountId: accounts.get(a.key)?.accountId ?? null })),
          parsedAccounts: meta.accounts,
          members: membersForWarnings,
        }),
      );
    }
    const acknowledged = ((doc as Record<string, unknown>).owner_review as OwnerReview | null)?.acknowledgedSoleOwner;
    review.warnings = withoutAcknowledgedWarnings(review.warnings, acknowledged);
    if (acknowledged?.length) review.acknowledgedSoleOwner = acknowledged;
    await saveOwnerReview(userId, sourceDocumentId, review);
  }
  return next('schemes');
}

// ---------------------------------------------------------------------------------------------------------------------
// STEP schemes
// ---------------------------------------------------------------------------------------------------------------------
const SCHEME_BATCH = 40;

interface Universe {
  existingForResolution: ExistingInstrumentForResolution[];
  aliasRows: AliasMapRow[];
  instrumentNameById: Map<string, string>;
}

/** The active scheme universe (read in parallel pages; it is the reference set every incoming scheme is resolved against). */
async function loadUniverse(admin: Admin): Promise<Universe> {
  const [existingIdentifierRows, existingInstrumentRows, aliasRowsRaw] = await Promise.all([
    fetchAllRows<{ instrument_id: string; identifier_scheme: string; identifier_value: string; country_code: string }>(
      () => admin.from('ii_instrument_identifiers').select('instrument_id, identifier_scheme, identifier_value, country_code').eq('is_active', true).order('id', { ascending: true }),
      1000,
      { concurrency: 4 },
    ),
    fetchAllRows<{ id: string; instrument_name: string; amc_name: string | null; plan_type: string | null; option_type: string | null; country_of_domicile: string }>(
      () => admin.from('ii_instruments').select('id, instrument_name, amc_name, plan_type, option_type, country_of_domicile').eq('is_active', true).order('id', { ascending: true }),
      1000,
      { concurrency: 4 },
    ),
    fetchAllRows<Record<string, unknown>>(() => admin.from('ii_scheme_alias_map').select('*').eq('is_active', true).order('id', { ascending: true }), 1000, { concurrency: 2 }),
  ]);
  // Grouped by instrument in one pass (O(n + m)); the first identifier of each type wins, as the old array scan did.
  const identifiersByInstrument = new Map<string, { isin: string | null; amfi: string | null; internalCode: string | null }>();
  for (const row of existingIdentifierRows) {
    let entry = identifiersByInstrument.get(row.instrument_id);
    if (!entry) {
      entry = { isin: null, amfi: null, internalCode: null };
      identifiersByInstrument.set(row.instrument_id, entry);
    }
    if (row.identifier_scheme === 'isin' && entry.isin === null) entry.isin = row.identifier_value;
    else if (row.identifier_scheme === 'amfi_scheme_code' && entry.amfi === null) entry.amfi = row.identifier_value;
    else if (row.identifier_scheme === 'internal_provisional' && entry.internalCode === null) entry.internalCode = row.identifier_value;
  }
  const existingForResolution: ExistingInstrumentForResolution[] = existingInstrumentRows.map((r) => {
    const ids = identifiersByInstrument.get(r.id);
    return {
      instrumentId: r.id,
      isin: ids?.isin ?? null,
      amfiSchemeCode: ids?.amfi ?? null,
      internalProvisionalCode: ids?.internalCode ?? null,
      normalisedSchemeName: normaliseSchemeName(r.instrument_name),
      amcName: r.amc_name ?? null,
      planType: (r.plan_type as IiPlanType) ?? null,
      optionType: (r.option_type as IiOptionType) ?? null,
      countryCode: r.country_of_domicile,
    };
  });
  const aliasRows: AliasMapRow[] = aliasRowsRaw.map((a) => ({
    rawSchemeNameNormalised: a.raw_scheme_name_normalised as string,
    amcName: (a.amc_name as string) ?? null,
    planType: (a.plan_type as IiPlanType) ?? null,
    optionType: (a.option_type as IiOptionType) ?? null,
    countryCode: (a.country_code as string) ?? null,
    resolvedInstrumentId: a.resolved_instrument_id as string,
  }));
  return { existingForResolution, aliasRows, instrumentNameById: new Map(existingInstrumentRows.map((r) => [r.id, r.instrument_name])) };
}

async function schemesStep(env: PipelineEnv): Promise<StepOut> {
  const stop = unitGuard(env);
  const { admin, userId, documentId: sourceDocumentId, state } = env;
  const meta = await loadMeta(env);
  const doc = await loadDoc(env);
  if (!doc) return finished({ ok: false, status: 'not_found', parseRunId: state.parseRunId, error: 'Source document not found.' });
  const countryCode = doc.country_code as string;
  const currencyCode = countryCode === 'IN' ? 'INR' : 'AUD';
  const { keying, unique } = uniqueSchemesOf(meta);
  const entries = [...unique.entries()];
  let universe: Universe | null = null;

  while (state.cursors.schemes < entries.length) {
    if (stop()) return more();
    universe ??= await loadUniverse(admin);
    const { existingForResolution, aliasRows, instrumentNameById } = universe;
    const from = state.cursors.schemes;
    const slice = entries.slice(from, from + SCHEME_BATCH);

    // Reads that do not depend on each other run together.
    const signatures = slice.map(([, scheme]): InstrumentResolutionSignature => ({
      isin: scheme.isin,
      amfiSchemeCode: scheme.amfiSchemeCode,
      normalisedSchemeName: scheme.normalisedSchemeName,
      amcName: scheme.amcName,
      planType: scheme.planType,
      optionType: scheme.optionType,
      countryCode,
    }));
    const overrides = await mapLimit(slice, 8, async ([key], i) => (keying.noIdentifierKeys.has(key) ? null : await findResolvedAmbiguousInstrumentOverride(admin, userId, signatures[i])));

    const out: InstEntry[] = [];
    const toCreate: Array<{ key: string; scheme: ParsedInstrumentRecord; id: string }> = [];
    let opened = 0;
    for (let i = 0; i < slice.length; i++) {
      const [key, scheme] = slice[i];
      const signature = signatures[i];
      const userOverrideInstrumentId = overrides[i];
      if (userOverrideInstrumentId) {
        out.push({ key, instrumentId: userOverrideInstrumentId });
        await auditUserResolvedAmbiguousInstrument(userId, userOverrideInstrumentId, state.parseRunId as string, scheme.rawSchemeName);
        continue;
      }
      if (keying.noIdentifierKeys.has(key)) {
        out.push({ key, instrumentId: null });
        const siblingSchemes = keying.siblingKeysOf(key).map((k) => unique.get(k)).filter((x): x is ParsedInstrumentRecord => !!x);
        const siblingIsins = new Set(siblingSchemes.map((x) => x.isin?.toUpperCase()).filter((x): x is string => !!x));
        const siblingAmfis = new Set(siblingSchemes.map((x) => x.amfiSchemeCode).filter((x): x is string => !!x));
        const candidates: AmbiguousInstrumentCandidate[] = existingForResolution
          .filter((e) => (e.isin && siblingIsins.has(e.isin.toUpperCase())) || (e.amfiSchemeCode && siblingAmfis.has(e.amfiSchemeCode)))
          .map((e) => ({ instrumentId: e.instrumentId, displayName: instrumentNameById.get(e.instrumentId) ?? scheme.rawSchemeName, amcName: e.amcName ?? null, isin: e.isin ?? null, planType: e.planType ?? null, optionType: e.optionType ?? null }));
        const caseId = await openReconciliationCase(userId, {
          subjectType: 'account',
          subjectId: sourceDocumentId,
          discrepancyType: 'ambiguous_instrument',
          severity: 'high',
          sourceDocumentId,
          idempotent: { discriminator: 'scheme' },
          details: {
            scheme: scheme.rawSchemeName,
            matchedVia: 'none',
            candidateInstrumentIds: candidates.map((c) => c.instrumentId),
            candidates,
            reason: `The statement lists "${scheme.rawSchemeName}" under ${siblingSchemes.length} different ISINs or AMFI codes, and this line carries none, so it cannot be matched to one of them. It was not matched to any fund.`,
            signature: { isin: scheme.isin, amfiSchemeCode: scheme.amfiSchemeCode, normalisedSchemeName: scheme.normalisedSchemeName, amcName: scheme.amcName, planType: scheme.planType, optionType: scheme.optionType, countryCode },
          },
        });
        if (caseId) opened++;
        continue;
      }
      const outcome = resolveScheme(
        { isin: scheme.isin, amfiSchemeCode: scheme.amfiSchemeCode, internalProvisionalCode: null, normalisedSchemeName: scheme.normalisedSchemeName, amcName: scheme.amcName, planType: scheme.planType, optionType: scheme.optionType, countryCode },
        existingForResolution,
        aliasRows,
      );
      if (outcome.kind === 'resolved') {
        out.push({ key, instrumentId: outcome.instrumentId });
        await emitAuditEvent({ userId, eventType: 'instrument_resolved', subjectType: 'ii_instruments', subjectId: outcome.instrumentId, actorType: 'system', metadata: { matchedVia: outcome.matchedVia, confidence: outcome.confidence, scheme: scheme.rawSchemeName, parseRunId: state.parseRunId } });
        continue;
      }
      if (outcome.kind === 'ambiguous') {
        out.push({ key, instrumentId: null });
        const candidates: AmbiguousInstrumentCandidate[] = outcome.candidateInstrumentIds.map((id) => {
          const found = existingForResolution.find((e) => e.instrumentId === id);
          return { instrumentId: id, displayName: instrumentNameById.get(id) ?? scheme.rawSchemeName, amcName: found?.amcName ?? null, isin: found?.isin ?? null, planType: found?.planType ?? null, optionType: found?.optionType ?? null };
        });
        const caseId = await openReconciliationCase(userId, {
          subjectType: 'account',
          subjectId: sourceDocumentId,
          discrepancyType: 'ambiguous_instrument',
          severity: 'high',
          sourceDocumentId,
          idempotent: { discriminator: 'scheme' },
          details: { scheme: scheme.rawSchemeName, matchedVia: outcome.matchedVia, candidateInstrumentIds: outcome.candidateInstrumentIds, candidates, reason: outcome.reason, signature },
        });
        if (caseId) opened++;
        continue;
      }
      // unresolved: a genuinely first-seen scheme gets a provisional instrument (not a blocker). The id is DERIVED from the user, the
      // statement and the scheme key, so a replayed batch creates the same instrument once.
      toCreate.push({ key, scheme, id: deterministicUuid('ii-instrument', userId, sourceDocumentId, key) });
      out.push({ key, instrumentId: deterministicUuid('ii-instrument', userId, sourceDocumentId, key) });
    }

    if (toCreate.length > 0) {
      const { error: createErr } = await admin.from('ii_instruments').upsert(
        toCreate.map((c) => ({
          id: c.id,
          instrument_name: c.scheme.rawSchemeName,
          instrument_class: 'mutual_fund',
          country_of_domicile: countryCode,
          base_currency: currencyCode,
          isin: c.scheme.isin,
          status: 'provisional',
          plan_type: c.scheme.planType,
          option_type: c.scheme.optionType,
          amc_name: c.scheme.amcName,
        })),
        { onConflict: 'id', ignoreDuplicates: true },
      );
      if (createErr) {
        // Same as before: a scheme whose instrument could not be created stays unresolved.
        for (const c of toCreate) {
          const e = out.find((x) => x.key === c.key);
          if (e) e.instrumentId = null;
        }
      } else {
        const identifierRows: { instrument_id: string; identifier_scheme: string; identifier_value: string; country_code: string }[] = [];
        for (const c of toCreate) {
          if (c.scheme.isin) identifierRows.push({ instrument_id: c.id, identifier_scheme: 'isin', identifier_value: c.scheme.isin, country_code: countryCode });
          if (c.scheme.amfiSchemeCode) identifierRows.push({ instrument_id: c.id, identifier_scheme: 'amfi_scheme_code', identifier_value: c.scheme.amfiSchemeCode, country_code: countryCode });
        }
        if (identifierRows.length > 0) await admin.from('ii_instrument_identifiers').insert(identifierRows);
        for (const c of toCreate) {
          await emitAuditEvent({ userId, eventType: 'instrument_resolved', subjectType: 'ii_instruments', subjectId: c.id, actorType: 'system', metadata: { matchedVia: 'created_provisional', scheme: c.scheme.rawSchemeName, parseRunId: state.parseRunId } });
        }
      }
    }
    await env.store.put('inst', Math.floor(from / SCHEME_BATCH), out);
    await fault(env, 'schemes:written');
    state.counters.casesOpened += opened;
    state.unresolvedSchemeCount += out.filter((e) => !e.instrumentId).length;
    state.cursors.schemes = from + slice.length;
    if (!(await env.save())) return { kind: 'lost' };
  }
  return next('transactions');
}

// ---------------------------------------------------------------------------------------------------------------------
// STEP transactions
// ---------------------------------------------------------------------------------------------------------------------
const INSERT_CHUNK = 500;
const FINGERPRINT_LOOKUP_CHUNK = 50;

/** What one re-read line was matched to in the document's own earlier rows (WP-H3), recorded per batch BEFORE anything is written. */
interface ClaimRecord {
  /** Position of the line inside its staged batch. */
  li: number;
  oldId: string;
  kind: 'link_existing' | 'supersede';
  changed: string[];
  /** The stored row's own fingerprint and position, so missing-transaction detection still counts it as confirmed. */
  fp: string | null;
  accountId: string;
  instrumentId: string;
}

/** The rows an EARLIER parse of this same document wrote (rows of this run are never part of it). */
async function loadPriorDocRows(env: PipelineEnv): Promise<StoredDocTransaction[]> {
  const rows = await fetchAllRows<StoredDocTransaction & { parse_run_id: string | null }>(() =>
    env.admin
      .from('ii_transactions')
      .select('id, account_id, instrument_id, transaction_date, gross_amount, transaction_type, units, price_per_unit, status, transaction_fingerprint, corrects_transaction_id, parse_run_id')
      .eq('user_id', env.userId)
      .eq('source_document_id', env.documentId)
      .order('id', { ascending: true }),
  );
  return rows.filter((r) => r.parse_run_id !== env.state.parseRunId);
}

function lineFingerprint(meta: StagedMeta, t: ReturnType<typeof unstageTxn>, accountId: string, instrumentId: string): string {
  return computeTransactionFingerprint({
    sourceKey: meta.metadata.sourceKey,
    accountId,
    instrumentId,
    transactionDateIso: t.transactionDateIso,
    transactionType: t.canonicalType,
    amountScaled: t.amountScaled,
    unitsScaled: t.unitsScaled,
    navScaled: t.navScaled,
    sourceReference: t.sourceReference,
  });
}

/** Pass 1 of WP-H3: prior rows this statement already matches EXACTLY by fingerprint (they can never be claimed by natural key). */
async function priorRowsMatchedByFingerprint(env: PipelineEnv, priorRows: readonly StoredDocTransaction[], meta: StagedMeta): Promise<Set<string>> {
  const claimed = new Set<string>();
  if (priorRows.length === 0) return claimed;
  const keying = uniqueSchemesOf(meta).keying;
  const resolveRowKey = makeResolveRowKey(meta.accAmcNameByFolio);
  const resolution = await loadResolution(env);
  const lineKeys = new Set<string>();
  for (let b = 0; b < env.state.counts.txnBatches; b++) {
    const raw = await env.store.get('parsed_txns', b);
    if (!raw) continue;
    for (const st of fromPlain<StagedTxn[]>(raw)) {
      const t = unstageTxn(st, meta.schemes);
      const accountId = resolution.accounts.get(resolveRowKey(t.folioNumber, t.scheme.amcName))?.accountId;
      const instrumentId = resolution.instruments.get(keying.keyOf(t.scheme));
      if (!accountId || !instrumentId) continue;
      lineKeys.add(`${accountId}:${lineFingerprint(meta, t, accountId, instrumentId)}`);
    }
  }
  for (const r of priorRows) if (r.transaction_fingerprint && lineKeys.has(`${r.account_id}:${r.transaction_fingerprint}`)) claimed.add(r.id);
  return claimed;
}

async function loadClaims(env: PipelineEnv, belowBatch?: number): Promise<ClaimRecord[]> {
  const out: ClaimRecord[] = [];
  for (const c of await env.store.list('claims')) if (belowBatch === undefined || c.seq < belowBatch) out.push(...((c.payload as { decisions: ClaimRecord[] }).decisions ?? []));
  return out;
}

async function transactionsStep(env: PipelineEnv): Promise<StepOut> {
  const stop = unitGuard(env);
  const { admin, userId, documentId: sourceDocumentId, state } = env;
  const meta = await loadMeta(env);
  const doc = await loadDoc(env);
  if (!doc) return finished({ ok: false, status: 'not_found', parseRunId: state.parseRunId, error: 'Source document not found.' });
  const countryCode = doc.country_code as string;
  const currencyCode = countryCode === 'IN' ? 'INR' : 'AUD';
  const parseRunId = state.parseRunId as string;
  const { keying } = uniqueSchemesOf(meta);
  const resolveRowKey = makeResolveRowKey(meta.accAmcNameByFolio);
  const resolution = await loadResolution(env);
  const config = await loadActiveReconciliationConfig();

  // WP-H3 (re-reading a document that already wrote rows). Real CAS lines carry no reference, and the fingerprint covers units, NAV and
  // type, which a parser fix legitimately corrects: a corrected re-read used to insert a second copy of every changed line. Lines that
  // match no fingerprint are matched by natural key WITHIN THIS DOCUMENT (reparseMatching.ts), each stored row claimed at most once.
  // The claims of finished batches are kept in staging, so a resumed job never claims a stored row twice.
  const priorRows = state.cursors.txnBatch < state.counts.txnBatches ? await loadPriorDocRows(env) : [];
  const storedById = new Map(priorRows.map((r) => [r.id, r]));
  const personSettledIds = new Set<string>();
  if (priorRows.length > 0) {
    const settled = await fetchAllRows<{ id: string; subject_id: string | null }>(() =>
      admin.from('ii_audit_events').select('id, subject_id').eq('user_id', userId).eq('event_type', 'user_correction').eq('subject_type', 'ii_transactions').order('id', { ascending: true }),
    );
    for (const e of settled) if (e.subject_id) personSettledIds.add(e.subject_id);
  }
  const claimedByFingerprint = await priorRowsMatchedByFingerprint(env, priorRows, meta);

  const crossSourcePositionCache = new Map<string, CrossSourceExistingTransaction[]>();
  const loadCrossSourceCandidates = async (accountId: string, instrumentId: string): Promise<CrossSourceExistingTransaction[]> => {
    const key = `${accountId}:${instrumentId}`;
    const cached = crossSourcePositionCache.get(key);
    if (cached) return cached;
    const rows = await fetchAllRows<{ id: string; account_id: string; instrument_id: string; transaction_date: string; transaction_type: string; gross_amount: string; units: string | null; source_reference: string | null; source_document_id: string | null; status: string }>(() =>
      admin
        .from('ii_transactions')
        .select('id, account_id, instrument_id, transaction_date, transaction_type, gross_amount, units, source_reference, source_document_id, status')
        .eq('user_id', userId)
        .eq('account_id', accountId)
        .eq('instrument_id', instrumentId)
        .order('id', { ascending: true }),
    );
    const mapped: CrossSourceExistingTransaction[] = rows
      .filter((r) => r.source_document_id !== null)
      .map((r) => ({
        id: r.id,
        sourceKey: '',
        sourceDocumentId: r.source_document_id as string,
        accountId: r.account_id,
        instrumentId: r.instrument_id,
        transactionDate: r.transaction_date,
        transactionType: r.transaction_type,
        grossAmount: String(r.gross_amount),
        units: r.units === null ? null : String(r.units),
        sourceReference: r.source_reference,
        status: r.status,
      }));
    crossSourcePositionCache.set(key, mapped);
    return mapped;
  };

  while (state.cursors.txnBatch < state.counts.txnBatches) {
    if (stop()) return more();
    const batchIdx = state.cursors.txnBatch;
    const raw = await env.store.get('parsed_txns', batchIdx);
    if (!raw) throw new Error(`The staged transactions are missing (batch ${batchIdx}).`);
    const txns = fromPlain<StagedTxn[]>(raw).map((t) => unstageTxn(t, meta.schemes));

    // The natural-key pool for THIS batch: prior rows, minus those matched by fingerprint, minus those claimed by earlier batches, minus
    // those this very batch claimed in an attempt that was killed (its recorded claims are applied as they were decided).
    const earlierClaims = await loadClaims(env, batchIdx);
    const recordedChunk = (await env.store.get('claims', batchIdx)) as { decisions: ClaimRecord[] } | null;
    const recorded = new Map<number, ClaimRecord>((recordedChunk?.decisions ?? []).map((d) => [d.li, d]));
    const excluded = new Set<string>([...claimedByFingerprint, ...earlierClaims.map((c) => c.oldId), ...[...recorded.values()].map((c) => c.oldId)]);
    const pool = new NaturalKeyPool(priorRows, excluded);
    const decisions: ClaimRecord[] = [];

    interface Item {
      li: number;
      t: (typeof txns)[number];
      accountId: string;
      instrumentId: string;
      fingerprint: string;
      newId: string;
    }
    const items: Item[] = [];
    txns.forEach((t, li) => {
      const accountId = resolution.accounts.get(resolveRowKey(t.folioNumber, t.scheme.amcName))?.accountId;
      const instrumentId = resolution.instruments.get(keying.keyOf(t.scheme));
      if (!accountId || !instrumentId) return; // unresolved: already a review case, no orphaned transaction is written
      const fingerprint = lineFingerprint(meta, t, accountId, instrumentId);
      // Derived from the run and the fingerprint: a replayed batch gives a row (and the review cases about it) the same id.
      items.push({ li, t, accountId, instrumentId, fingerprint, newId: deterministicUuid('ii-txn', parseRunId, accountId, fingerprint) });
    });

    // Which of this batch already exist (by the database's own unique key: account + fingerprint), read in a few exact lookups.
    interface Existing {
      id: string;
      account_id: string;
      transaction_fingerprint: string;
      source_document_id: string | null;
      parse_run_id: string | null;
    }
    const existing = new Map<string, Existing>();
    const found = await mapLimit(chunked(items, FINGERPRINT_LOOKUP_CHUNK), 4, async (chunk) => {
      const { data, error } = await admin
        .from('ii_transactions')
        .select('id, account_id, transaction_fingerprint, source_document_id, parse_run_id')
        .eq('user_id', userId)
        .in('account_id', [...new Set(chunk.map((x) => x.accountId))])
        .in('transaction_fingerprint', [...new Set(chunk.map((x) => x.fingerprint))]);
      if (error) throw new Error(error.message);
      return (data ?? []) as Existing[];
    });
    for (const rows of found) for (const r of rows) existing.set(`${r.account_id}:${r.transaction_fingerprint}`, r);

    // Candidate lists for the positions that may need a cross-source decision, read together.
    const needCandidates = [...new Set(items.filter((x) => !existing.has(`${x.accountId}:${x.fingerprint}`)).map((x) => `${x.accountId}:${x.instrumentId}`))];
    await mapLimit(needCandidates, 6, async (k) => {
      const [a, i] = k.split(':');
      await loadCrossSourceCandidates(a, i);
    });

    const linkUpserts: Array<Record<string, unknown>> = [];
    const pendingTransactionInserts: Record<string, unknown>[] = [];
    const pendingSourceLinkInserts: Record<string, unknown>[] = [];
    let duplicateLinked = 0;
    let matchedToExisting = 0;
    let opened = 0;

    for (const it of items) {
      const { li, t, accountId, instrumentId, fingerprint, newId } = it;
      const ex = existing.get(`${accountId}:${fingerprint}`);
      if (ex) {
        if (ex.source_document_id === sourceDocumentId && ex.parse_run_id === parseRunId) {
          // Written by THIS run in a slice that was killed before it could checkpoint: it is ours, not a duplicate. Make sure it has its
          // originating link (the kill may have fallen between the row and its link). Its claim, if it replaced a row, is already recorded.
          linkUpserts.push({ user_id: userId, transaction_id: ex.id, source_document_id: sourceDocumentId, parse_run_id: parseRunId, is_originating: true });
          const rec = recorded.get(li);
          if (rec) decisions.push(rec);
          continue;
        }
        linkUpserts.push({ user_id: userId, transaction_id: ex.id, source_document_id: sourceDocumentId, parse_run_id: parseRunId, is_originating: false });
        duplicateLinked++;
        continue;
      }

      // WP-H3: no fingerprint match. Is this the same real line, written by an earlier parse of THIS document?
      let supersedes: StoredDocTransaction | null = null;
      {
        let twin: StoredDocTransaction | null = null;
        let decisionKind: 'link_existing' | 'supersede' | null = null;
        let changed: string[] = [];
        const rec = recorded.get(li);
        if (rec) {
          twin = storedById.get(rec.oldId) ?? null;
          decisionKind = rec.kind;
          changed = rec.changed;
        } else {
          const line: ReReadLine = {
            accountId,
            instrumentId,
            dateIso: t.transactionDateIso,
            amount: scaledToDecimalString(t.amountScaled, 2),
            type: t.canonicalType,
            units: t.unitsScaled === null ? null : scaledToDecimalString(t.unitsScaled),
            navPerUnit: t.navScaled === null ? null : scaledToDecimalString(t.navScaled),
          };
          twin = pool.take(line);
          if (twin) {
            const d = decideReRead(twin, line, personSettledIds);
            if (d.kind === 'link_existing' || d.kind === 'supersede') {
              decisionKind = d.kind;
              changed = d.kind === 'supersede' ? d.changed : [];
            }
          }
        }
        if (twin && decisionKind) {
          decisions.push({ li, oldId: twin.id, kind: decisionKind, changed, fp: twin.transaction_fingerprint, accountId, instrumentId });
          if (decisionKind === 'link_existing') {
            linkUpserts.push({ user_id: userId, transaction_id: twin.id, source_document_id: sourceDocumentId, parse_run_id: parseRunId, is_originating: false });
            duplicateLinked++;
            matchedToExisting++;
            continue;
          }
          supersedes = twin;
        }
      }

      // Cross-source identity (a different source already evidences the same real-world transaction).
      const crossSourceCandidates = supersedes ? [] : crossSourcePositionCache.get(`${accountId}:${instrumentId}`) ?? [];
      if (crossSourceCandidates.length > 0) {
        const match = resolveCrossSourceTransactionMatch(
          {
            sourceKey: meta.metadata.sourceKey,
            sourceDocumentId,
            accountId,
            instrumentId,
            transactionDate: t.transactionDateIso,
            transactionType: t.canonicalType,
            grossAmount: scaledToDecimalString(t.amountScaled, 2),
            units: t.unitsScaled === null ? null : scaledToDecimalString(t.unitsScaled),
            sourceReference: t.sourceReference,
          },
          crossSourceCandidates,
          config,
        );
        if ((match.state === 'exact' || match.state === 'high_confidence') && match.matchedExistingId) {
          linkUpserts.push({
            user_id: userId,
            transaction_id: match.matchedExistingId,
            source_document_id: sourceDocumentId,
            parse_run_id: parseRunId,
            is_originating: false,
            match_basis: match.state === 'exact' ? 'cross_source_exact' : 'cross_source_high_confidence',
          });
          const caseId = await openReconciliationCase(userId, {
            subjectType: 'transaction',
            subjectId: match.matchedExistingId,
            discrepancyType: match.state === 'exact' ? 'cross_source_exact_duplicate' : 'cross_source_high_confidence_duplicate',
            severity: 'info',
            sourceDocumentId,
            details: { matchedFields: match.matchedFields, differingFields: match.differingFields, rationale: match.rationale },
            evidence: { comparedTransactionIds: [match.matchedExistingId], engineVersion: match.engineVersion, newSourceDocumentId: sourceDocumentId },
            idempotent: { discriminator: 'rationale' },
          });
          if (caseId) {
            await admin.from('ii_reconciliation_cases').update({ status: 'resolved', resolved_at: new Date().toISOString(), resolved_by_actor_type: 'system', resolution_method: 'auto_resolved_cross_source_precedence' }).eq('id', caseId);
            opened++;
          }
          duplicateLinked++;
          continue;
        }
        if (match.state === 'conflict' || match.state === 'ambiguous') {
          // Never silently merged: both pieces of evidence are kept; the new row is inserted counted and the case is a non-blocking highlight (D-5).
          const caseId = await openReconciliationCase(userId, {
            subjectType: 'transaction',
            subjectId: accountId,
            discrepancyType: match.state === 'conflict' ? 'cross_source_conflict' : 'cross_source_review_required',
            severity: CROSS_SOURCE_REVIEW_SEVERITY,
            sourceDocumentId,
            details: { matchedFields: match.matchedFields, differingFields: match.differingFields, rationale: match.rationale, transactionDate: t.transactionDateIso, newTransactionId: newId },
            evidence: { comparedTransactionIds: match.ambiguousCandidateIds.length > 0 ? match.ambiguousCandidateIds : match.matchedExistingId ? [match.matchedExistingId] : [], engineVersion: match.engineVersion, newSourceDocumentId: sourceDocumentId, newTransactionId: newId },
            idempotent: { discriminator: 'newTransactionId' },
          });
          if (caseId) opened++;
        }
      }

      if (t.canonicalType === 'unclassified') {
        const material = t.amountScaled !== ZERO;
        const caseId = await openReconciliationCase(userId, {
          subjectType: 'account',
          subjectId: accountId,
          discrepancyType: 'transaction_unclassified',
          severity: material ? 'high' : 'low',
          sourceDocumentId,
          details: { description: t.rawTransactionTypeText, date: t.transactionDateIso, amount: scaledToDecimalString(t.amountScaled), material, newTransactionId: newId },
          idempotent: { discriminator: 'newTransactionId' },
        });
        if (caseId) opened++;
      }

      pendingTransactionInserts.push({
        id: newId,
        user_id: userId,
        account_id: accountId,
        instrument_id: instrumentId,
        source_document_id: sourceDocumentId,
        currency_code: currencyCode,
        // WP-H3: a corrected re-read of a line this document already wrote is a correction row pointing at the row it replaces.
        status: supersedes ? 'corrected' : CROSS_SOURCE_INSERT_STATUS,
        corrects_transaction_id: supersedes ? supersedes.id : null,
        transaction_type: t.canonicalType,
        transaction_date: t.transactionDateIso,
        units: t.unitsScaled === null ? null : scaledToDecimalString(t.unitsScaled),
        price_per_unit: t.navScaled === null ? null : scaledToDecimalString(t.navScaled),
        gross_amount: scaledToDecimalString(t.amountScaled, 2),
        source_reference: t.sourceReference,
        parse_run_id: parseRunId,
        parser_code: meta.parserCode,
        parser_version_used: meta.parserVersion,
        source_description: t.sourceDescription,
        confidence: t.classificationConfidence,
        transaction_fingerprint: fingerprint,
      });
      pendingSourceLinkInserts.push({ user_id: userId, transaction_id: newId, source_document_id: sourceDocumentId, parse_run_id: parseRunId, is_originating: true });
      existing.set(`${accountId}:${fingerprint}`, { id: newId, account_id: accountId, transaction_fingerprint: fingerprint, source_document_id: sourceDocumentId, parse_run_id: parseRunId });
      crossSourcePositionCache.get(`${accountId}:${instrumentId}`)?.push({
        id: newId,
        sourceKey: '',
        sourceDocumentId,
        accountId,
        instrumentId,
        transactionDate: t.transactionDateIso,
        transactionType: t.canonicalType,
        grossAmount: scaledToDecimalString(t.amountScaled, 2),
        units: t.unitsScaled === null ? null : scaledToDecimalString(t.unitsScaled),
        sourceReference: t.sourceReference,
        status: CROSS_SOURCE_INSERT_STATUS,
      });
    }
    // The claims are recorded BEFORE any row is written: a resumed batch applies them as decided instead of deciding again.
    if (decisions.length > 0) await env.store.put('claims', batchIdx, { decisions });
    await fault(env, 'transactions:decided');

    for (const links of chunked(linkUpserts, INSERT_CHUNK)) {
      const { error } = await admin.from('ii_transaction_source_links').upsert(links, { onConflict: 'transaction_id,source_document_id', ignoreDuplicates: true });
      if (error) throw new Error(`Transaction link write failed: ${error.message}`);
    }
    for (let i = 0; i < pendingTransactionInserts.length; i += INSERT_CHUNK) {
      const txnChunk = pendingTransactionInserts.slice(i, i + INSERT_CHUNK);
      const linkChunk = pendingSourceLinkInserts.slice(i, i + INSERT_CHUNK);
      const { error: batchTxnError } = await admin.from('ii_transactions').insert(txnChunk);
      if (batchTxnError) {
        const message = `Batched transaction insert failed (rows ${i}-${i + txnChunk.length}): ${batchTxnError.message}`;
        await failRun(admin, parseRunId, message);
        await updateDocumentStatusUnlessSucceeded(env, { status: 'parse_failed', parse_error: 'transaction_write_failed' });
        return finished({ ok: false, status: 'parse_failed', parseRunId, error: message });
      }
      await fault(env, 'transactions:rows_written_before_links');
      const { error: batchLinkError } = await admin.from('ii_transaction_source_links').upsert(linkChunk, { onConflict: 'transaction_id,source_document_id', ignoreDuplicates: true });
      if (batchLinkError) {
        const message = `Batched transaction-source-link insert failed (rows ${i}-${i + linkChunk.length}): ${batchLinkError.message}`;
        await failRun(admin, parseRunId, message);
        await updateDocumentStatusUnlessSucceeded(env, { status: 'parse_failed', parse_error: 'transaction_write_failed' });
        return finished({ ok: false, status: 'parse_failed', parseRunId, error: message });
      }
    }
    await fault(env, 'transactions:written');
    state.counters.duplicateLinked += duplicateLinked;
    state.counters.matchedToExisting += matchedToExisting;
    state.counters.casesOpened += opened;
    state.cursors.txnBatch = batchIdx + 1;
    if (!(await env.save())) return { kind: 'lost' };
  }

  // WP-H3, once per document: the replaced rows leave the figures only AFTER every correction is written (soft, audited, reversible: the
  // same `reversed` exclusion every ledger reader honours). It runs here, after the last batch and before holdings and certification,
  // because certification reads the figures. Updating a row to reversed twice changes nothing, and the audit event is written once.
  if (!state.cursors.reversalDone) {
    const prior = await loadPriorDocRows(env);
    const claims = await loadClaims(env);
    const claimedFp = await priorRowsMatchedByFingerprint(env, prior, meta);
    const replacedIds = claims.filter((c) => c.kind === 'supersede').map((c) => c.oldId);
    // Self-healing: a correction whose predecessor is still counted (an earlier run stopped between the two writes) is finished now.
    const healIds = prior
      .filter((r) => r.status === 'corrected' && r.corrects_transaction_id && claimedFp.has(r.id))
      .map((r) => r.corrects_transaction_id as string)
      .filter((id) => prior.some((o) => o.id === id && o.status !== 'reversed'));
    const reverseIds = [...new Set([...replacedIds, ...healIds])];
    for (const part of chunked(reverseIds, INSERT_CHUNK)) {
      const { error: reverseError } = await admin.from('ii_transactions').update({ status: 'reversed' }).eq('user_id', userId).in('id', part);
      if (reverseError) {
        const message = `Replacing re-read transactions failed: ${reverseError.message}`;
        await failRun(admin, state.parseRunId as string, message);
        await updateDocumentStatusUnlessSucceeded(env, { status: 'parse_failed', parse_error: 'transaction_write_failed' });
        return finished({ ok: false, status: 'parse_failed', parseRunId: state.parseRunId, error: message });
      }
    }
    await fault(env, 'transactions:reversed');
    if (reverseIds.length > 0 || state.counters.matchedToExisting > 0) {
      const { data: already } = await admin.from('ii_audit_events').select('id').eq('user_id', userId).eq('event_type', 'document_superseded').eq('subject_id', sourceDocumentId).contains('metadata', { parseRunId: state.parseRunId }).limit(1);
      if ((already ?? []).length === 0) {
        await emitAuditEvent({
          userId,
          eventType: 'document_superseded',
          subjectType: 'ii_source_documents',
          subjectId: sourceDocumentId,
          actorType: 'system',
          // counts and ids only; every replaced row is also reachable through ii_transactions.corrects_transaction_id
          metadata: { kind: 'transactions_reconciled_on_reparse', parseRunId: state.parseRunId, replaced: replacedIds.length, healed: healIds.length, matchedToExisting: state.counters.matchedToExisting, replacedIdSample: claims.filter((c) => c.kind === 'supersede').slice(0, 20).map((c) => ({ old: c.oldId, changed: c.changed })) },
        });
      }
    }
    state.cursors.reversalDone = true;
    if (!(await env.save())) return { kind: 'lost' };
  }
  return next('holdings');
}

// ---------------------------------------------------------------------------------------------------------------------
// STEP holdings
// ---------------------------------------------------------------------------------------------------------------------
async function holdingsStep(env: PipelineEnv): Promise<StepOut> {
  const stop = unitGuard(env);
  const { admin, userId, documentId: sourceDocumentId, state } = env;
  if (state.cursors.holdBatch >= state.counts.holdBatches) return next('analyse');
  const meta = await loadMeta(env);
  const doc = await loadDoc(env);
  if (!doc) return finished({ ok: false, status: 'not_found', parseRunId: state.parseRunId, error: 'Source document not found.' });
  const currencyCode = (doc.country_code as string) === 'IN' ? 'INR' : 'AUD';
  const { keying } = uniqueSchemesOf(meta);
  const resolveRowKey = makeResolveRowKey(meta.accAmcNameByFolio);
  const resolution = await loadResolution(env);
  const parseRunId = state.parseRunId as string;
  while (state.cursors.holdBatch < state.counts.holdBatches) {
    if (stop()) return more();
    const batchIdx = state.cursors.holdBatch;
    const raw = await env.store.get('parsed_holds', batchIdx);
    if (!raw) throw new Error(`The staged holdings are missing (batch ${batchIdx}).`);
    const holds = fromPlain<StagedHold[]>(raw).map((h) => unstageHold(h, meta.schemes));
    const rows: Record<string, unknown>[] = [];
    const covered: Array<[string, string]> = [];
    for (const h of holds) {
      const accountId = resolution.accounts.get(resolveRowKey(h.folioNumber, h.scheme.amcName))?.accountId;
      const instrumentId = resolution.instruments.get(keying.keyOf(h.scheme));
      if (!accountId || !instrumentId) continue;
      covered.push([accountId, instrumentId]);
      rows.push({
        user_id: userId,
        account_id: accountId,
        instrument_id: instrumentId,
        source_document_id: sourceDocumentId,
        currency_code: currencyCode,
        quality_status: 'warning', // upgraded to certified once the position's Portfolio Truth reaches certified
        as_of_date: h.asOfDateIso,
        units: scaledToDecimalString(h.unitsScaled),
        value: h.valueScaled === null ? '0' : scaledToDecimalString(h.valueScaled, 2),
        parse_run_id: parseRunId,
        parser_code: meta.parserCode,
        parser_version_used: meta.parserVersion,
        source_nav: h.navScaled === null ? null : scaledToDecimalString(h.navScaled),
      });
    }
    if (rows.length > 0) {
      const { error: snapshotError } = await admin.from('ii_holding_snapshots').upsert(rows, { onConflict: 'account_id,instrument_id,as_of_date', ignoreDuplicates: true });
      if (snapshotError) {
        // Not routed through emitAuditEvent (a closed audit vocabulary): visible in the server log, diagnosable.
        console.error('[investment-intelligence] ii_holding_snapshots upsert failed', { userId, sourceDocumentId, rows: rows.length, errorMessage: snapshotError.message, errorCode: snapshotError.code ?? null, parseRunId });
      }
    }
    await env.store.put('pairs', batchIdx, { covered });
    await fault(env, 'holdings:written');
    state.counts.covered += covered.length;
    state.cursors.holdBatch = batchIdx + 1;
    if (!(await env.save())) return { kind: 'lost' };
  }
  return next('analyse');
}

// ---------------------------------------------------------------------------------------------------------------------
// STEP analyse (missing-transaction detection, then the user-typed-date check)
// ---------------------------------------------------------------------------------------------------------------------
const ANALYSE_BATCH = 30;
const COVERED_CHUNK_BASE = 0; // pairs chunks 0..holdBatches-1 hold covered positions
const CERTIFY_CHUNK_BASE = 100_000; // pairs chunks from here hold the certification list

async function loadCovered(env: PipelineEnv): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for (const c of await env.store.list('pairs')) if (c.seq < CERTIFY_CHUNK_BASE) out.push(...((c.payload as { covered: Array<[string, string]> }).covered ?? []));
  return out;
}

async function analyseStep(env: PipelineEnv): Promise<StepOut> {
  const stop = unitGuard(env);
  const { admin, userId, documentId: sourceDocumentId, state } = env;
  const meta = await loadMeta(env);
  const covered = await loadCovered(env);
  const periodStartIso = meta.metadata.statementPeriodStartIso;
  const periodEndIso = meta.metadata.statementPeriodEndIso;

  if (state.cursors.analyse < covered.length) {
    // The fingerprints this statement confirmed, per position (recomputed from the staged lines: a pure function of them).
    const keying = uniqueSchemesOf(meta).keying;
    const resolveRowKey = makeResolveRowKey(meta.accAmcNameByFolio);
    const resolution = await loadResolution(env);
    const confirmed = new Map<string, Set<string>>();
    if (periodStartIso && periodEndIso) {
      for (let b = 0; b < state.counts.txnBatches; b++) {
        const raw = await env.store.get('parsed_txns', b);
        if (!raw) continue;
        for (const st of fromPlain<StagedTxn[]>(raw)) {
          const t = unstageTxn(st, meta.schemes);
          const accountId = resolution.accounts.get(resolveRowKey(t.folioNumber, t.scheme.amcName))?.accountId;
          const instrumentId = resolution.instruments.get(keying.keyOf(t.scheme));
          if (!accountId || !instrumentId) continue;
          const fp = computeTransactionFingerprint({ sourceKey: meta.metadata.sourceKey, accountId, instrumentId, transactionDateIso: t.transactionDateIso, transactionType: t.canonicalType, amountScaled: t.amountScaled, unitsScaled: t.unitsScaled, navScaled: t.navScaled, sourceReference: t.sourceReference });
          const k = `${accountId}:${instrumentId}`;
          const set = confirmed.get(k) ?? new Set<string>();
          set.add(fp);
          confirmed.set(k, set);
        }
      }
    }
    // WP-H3: the stored row a re-read line was matched to is confirmed by this statement too (its own fingerprint is the one
    // missing-transaction detection knows).
    if (periodStartIso && periodEndIso) {
      for (const c of await loadClaims(env)) {
        if (!c.fp) continue;
        const k = `${c.accountId}:${c.instrumentId}`;
        const set = confirmed.get(k) ?? new Set<string>();
        set.add(c.fp);
        confirmed.set(k, set);
      }
    }
    while (state.cursors.analyse < covered.length) {
      if (stop()) return more();
      const from = state.cursors.analyse;
      const slice = covered.slice(from, from + ANALYSE_BATCH).map(([accountId, instrumentId]) => ({ accountId, instrumentId }));
      const missingCases = await detectMissingTransactions(admin as unknown as import('./missingTransactionDetection').MissingTransactionQueryClient, userId, sourceDocumentId, slice, confirmed, periodStartIso, periodEndIso);
      let missing = 0;
      let opened = 0;
      for (const { accountId, instrumentId, missing: m } of missingCases) {
        missing += m.length;
        const caseId = await openReconciliationCase(userId, {
          subjectType: 'account',
          subjectId: accountId,
          discrepancyType: 'transaction_missing_from_restatement',
          severity: 'medium',
          sourceDocumentId,
          idempotent: { discriminator: 'instrumentId' },
          details: {
            instrumentId,
            statementPeriodStartIso: periodStartIso,
            statementPeriodEndIso: periodEndIso,
            missingTransactionIds: m.map((x) => x.id),
            missingTransactionCount: m.length,
            reason: 'One or more previously-recorded transactions for this position, dated within this new statement’s own coverage period, were not re-confirmed by this statement. Nothing was deleted or changed — this is a review item for a human to look at.',
          },
          evidence: { missingTransactions: m },
        });
        if (caseId) opened++;
      }
      await fault(env, 'analyse:cases');
      state.counters.missing += missing;
      state.counters.casesOpened += opened;
      state.cursors.analyse = from + slice.length;
      if (!(await env.save())) return { kind: 'lost' };
    }
  }

  // A position whose purchase date the user typed in now has real statement history: ask, never auto-remove. Best effort. Skipped
  // altogether when the person has typed in no date at all (nothing to compare), which is nearly every statement.
  if (state.cursors.supersession === 0) {
    try {
      const { data: anyInput } = await admin.from('ii_investment_date_inputs').select('id').eq('user_id', userId).eq('status', 'applied').limit(1);
      if ((anyInput ?? []).length > 0) {
        const rows = await fetchAllRows<{ id: string; account_id: string; instrument_id: string; transaction_type: string; transaction_date: string }>(() =>
          admin.from('ii_transactions').select('id, account_id, instrument_id, transaction_type, transaction_date').eq('user_id', userId).eq('parse_run_id', state.parseRunId as string).order('id', { ascending: true }),
        );
        const stmt: StatementTransactionForSupersession[] = rows.map((r) => ({ id: r.id, accountId: r.account_id, instrumentId: r.instrument_id, type: r.transaction_type, date: r.transaction_date }));
        const supersession = await openUserDateSupersessionCases({ db: admin, userId, sourceDocumentId, statementTransactions: stmt });
        state.counters.casesOpened += supersession.opened;
      }
    } catch (err) {
      console.error('[investment-intelligence] user-supplied investment date supersession check failed', err instanceof Error ? err.message : err);
    }
    state.cursors.supersession = 1;
    if (!(await env.save())) return { kind: 'lost' };
  }
  return next('certify');
}

// ---------------------------------------------------------------------------------------------------------------------
// STEP certify
// ---------------------------------------------------------------------------------------------------------------------
const CERTIFY_BATCH = 24;
const CERTIFY_CONCURRENCY = 6;
const PAIR_CHUNK = 500;

/** Positions to certify: the statement's own lines plus every stored snapshot of its accounts (the combinations that can have anything to certify). */
async function buildCertificationPairs(env: PipelineEnv): Promise<Array<[string, string]>> {
  const { admin, userId } = env;
  const meta = await loadMeta(env);
  const resolution = await loadResolution(env);
  const keying = uniqueSchemesOf(meta).keying;
  const resolveRowKey = makeResolveRowKey(meta.accAmcNameByFolio);
  const pairs = new Set<string>();
  for (const [a, i] of await loadCovered(env)) pairs.add(`${a}:${i}`);
  for (let b = 0; b < env.state.counts.txnBatches; b++) {
    const raw = await env.store.get('parsed_txns', b);
    if (!raw) continue;
    for (const st of fromPlain<StagedTxn[]>(raw)) {
      const t = unstageTxn(st, meta.schemes);
      const accountId = resolution.accounts.get(resolveRowKey(t.folioNumber, t.scheme.amcName))?.accountId;
      const instrumentId = resolution.instruments.get(keying.keyOf(t.scheme));
      if (accountId && instrumentId) pairs.add(`${accountId}:${instrumentId}`);
    }
  }
  // Stored snapshots of these accounts for these instruments (an earlier statement's position that this one touches by account and fund).
  const accountIds = [...new Set([...resolution.accounts.values()].map((e) => e.accountId as string))];
  const instrumentIds = new Set(resolution.instruments.values());
  for (const batch of chunked(accountIds, 40)) {
    const rows = await fetchAllRows<{ account_id: string; instrument_id: string }>(
      () => admin.from('ii_holding_snapshots').select('account_id, instrument_id').eq('user_id', userId).in('account_id', batch).order('id', { ascending: true }),
      1000,
      { concurrency: 2 },
    );
    for (const r of rows) if (instrumentIds.has(r.instrument_id)) pairs.add(`${r.account_id}:${r.instrument_id}`);
  }
  return [...pairs].sort().map((k) => k.split(':') as [string, string]);
}

async function loadCertificationPairs(env: PipelineEnv): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for (const c of await env.store.list('pairs')) if (c.seq >= CERTIFY_CHUNK_BASE) out.push(...((c.payload as { pairs: Array<[string, string]> }).pairs ?? []));
  return out;
}

async function certifyStep(env: PipelineEnv): Promise<StepOut> {
  const stop = unitGuard(env);
  const { admin, userId, documentId: sourceDocumentId, state } = env;
  if (!state.cursors.pairsBuilt) {
    const pairs = state.kind === 'reevaluate' ? await listStatementPositions(admin, userId, sourceDocumentId) : await buildCertificationPairs(env);
    const chunks = chunked(pairs, PAIR_CHUNK);
    for (let i = 0; i < chunks.length; i++) await env.store.put('pairs', CERTIFY_CHUNK_BASE + i, { pairs: chunks[i] });
    state.counts.pairs = pairs.length;
    state.cursors.pairsBuilt = true;
    if (!(await env.save())) return { kind: 'lost' };
  }
  const pairs = await loadCertificationPairs(env);
  if (state.cursors.certify >= pairs.length) return next('finalize');

  if (state.kind === 'reevaluate') {
    while (state.cursors.certify < pairs.length) {
      if (stop()) return more();
      const from = state.cursors.certify;
      const batch = pairs.slice(from, from + CERTIFY_BATCH);
      const results = await mapLimit(batch, CERTIFY_CONCURRENCY, async ([a, i]) => recertifyPosition(userId, a, i));
      await fault(env, 'certify:batch');
      state.evaluated += results.filter((r) => r.ok).length;
      state.failedEvaluations += results.filter((r) => !r.ok).length;
      state.cursors.certify = from + batch.length;
      if (!(await env.save())) return { kind: 'lost' };
    }
    return next('finalize');
  }

  const meta = await loadMeta(env);
  const config = await loadActiveReconciliationConfig();
  const certifyCache: CertifyCache = new Map();
  const explicitCache = new Map<string, boolean>();
  while (state.cursors.certify < pairs.length) {
    if (stop()) return more();
    const from = state.cursors.certify;
    const batch = pairs.slice(from, from + CERTIFY_BATCH);
    const need = [...new Set(batch.map(([a]) => a))].filter((a) => !explicitCache.has(a));
    if (need.length > 0) {
      const explicit = await loadExplicitOwnerAccountIds(admin, userId, need);
      for (const a of need) explicitCache.set(a, explicit.has(a));
    }
    // Positions are independent of each other (each writes its own rows), so a few are evaluated at the same time.
    await mapLimit(batch, CERTIFY_CONCURRENCY, async ([accountId, instrumentId]) =>
      evaluatePositionAndCertify(admin, userId, accountId, instrumentId, sourceDocumentId, config, state.ownerUnresolved && !explicitCache.get(accountId), state.unresolvedSchemeCount > 0, meta.errors.length > 0, certifyCache),
    );
    await fault(env, 'certify:batch');
    state.cursors.certify = from + batch.length;
    if (!(await env.save())) return { kind: 'lost' };
  }
  return next('finalize');
}

// ---------------------------------------------------------------------------------------------------------------------
// STEP finalize
// ---------------------------------------------------------------------------------------------------------------------
async function finalizeStep(env: PipelineEnv): Promise<StepOut> {
  const { admin, userId, documentId: sourceDocumentId, state } = env;
  if (state.kind === 'reevaluate') {
    return finished({ ok: true, status: 'reevaluated', parseRunId: null, error: null, reevaluated: { evaluated: state.evaluated, failed: state.failedEvaluations } });
  }
  const meta = await loadMeta(env);
  const doc = await loadDoc(env);
  if (!doc) return finished({ ok: false, status: 'not_found', parseRunId: state.parseRunId, error: 'Source document not found.' });
  const parseRunId = state.parseRunId as string;
  const { accounts } = await loadResolution(env);

  await admin
    .from('ii_source_documents')
    .update({
      status: 'parsed',
      parser_version: meta.parserVersion,
      parse_completed_at: new Date().toISOString(),
      source_detected: state.detection?.sourceKey ?? null,
      source_confidence: state.detection?.confidence ?? null,
      document_type_detected: meta.metadata.documentTypeDetected,
      format_version_detected: meta.metadata.formatVersionDetected,
      extraction_method: state.extractionMethod,
      statement_period_start: meta.metadata.statementPeriodStartIso,
      statement_period_end: meta.metadata.statementPeriodEndIso,
      statement_as_of_date: meta.metadata.statementAsOfDateIso,
    })
    .eq('id', sourceDocumentId);

  // A successful parse proves whatever blocked an earlier attempt (a document_password_required case) no longer does.
  await admin
    .from('ii_reconciliation_cases')
    .update({ status: 'resolved', resolved_at: new Date().toISOString(), resolution_method: 'auto_resolved_on_reparse', resolved_by_actor_type: 'system' })
    .eq('user_id', userId)
    .eq('source_document_id', sourceDocumentId)
    .eq('discrepancy_type', 'document_password_required')
    .eq('status', 'open');

  await fault(env, 'finalize:before_purge');
  // The raw statement bytes have done their job: purge them (strict deletion). A purge failure is recorded for retry, never surfaced.
  if (doc.storage_path) await purgeSourceDocumentStorage(admin, sourceDocumentId, doc.storage_path as string);
  await fault(env, 'finalize:after_purge');

  // Genuinely new rows of THIS run, counted in the database (exact even after a killed and resumed slice).
  const { count: newCount } = await admin.from('ii_transactions').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('parse_run_id', parseRunId);
  const newTransactionsCount = newCount ?? 0;
  const { unique } = uniqueSchemesOf(meta);
  const accountsFound = new Set([...accounts.values()].map((e) => e.accountId)).size;

  const succeededRunPatch = {
    run_status: 'succeeded',
    completed_at: new Date().toISOString(),
    parser_code: meta.parserCode,
    parser_version: meta.parserVersion,
    source_detected: state.detection?.sourceKey ?? null,
    source_confidence: state.detection?.confidence ?? null,
    document_type_detected: meta.metadata.documentTypeDetected,
    format_version_detected: meta.metadata.formatVersionDetected,
    extraction_method: state.extractionMethod,
    accounts_found: accountsFound,
    schemes_found: unique.size,
    transactions_found: meta.txnCount,
    holdings_found: meta.holdCount,
    warnings: meta.warnings,
    errors: meta.errors,
    duplicate_transactions_linked: state.counters.duplicateLinked,
    new_transactions_count: newTransactionsCount,
    missing_transactions_count: state.counters.missing,
  };
  const { error: runCloseError } = await admin.from('ii_document_parse_runs').update(succeededRunPatch).eq('id', parseRunId);
  if (runCloseError) {
    // Deployment-order safety: the three counters come from migration 0159 / 0312. Where they are absent this update fails; the run is
    // then closed without them (and the server log says so) instead of staying running.
    const { duplicate_transactions_linked: _d, new_transactions_count: _n, missing_transactions_count: _m, ...withoutCounters } = succeededRunPatch;
    void _d;
    void _n;
    void _m;
    const { error: retryError } = await admin.from('ii_document_parse_runs').update(withoutCounters).eq('id', parseRunId);
    console.error('[investment-intelligence] parse run could not be closed with its counters (is migration 0312 applied?)', { parseRunId, firstError: runCloseError.message, retryError: retryError?.message ?? null });
  }
  await emitAuditEvent({ userId, eventType: 'parse_completed', subjectType: 'ii_source_documents', subjectId: sourceDocumentId, actorType: 'user', actorId: userId, metadata: { parseRunId, parserCode: meta.parserCode, parserVersion: meta.parserVersion, transactionsCreated: meta.txnCount, status: 'parsed' } });

  return finished({
    ok: true,
    status: 'parsed',
    parseRunId,
    summary: {
      sourceDetected: state.detection?.sourceKey ?? null,
      sourceConfidence: state.detection?.confidence ?? 0,
      accountsFound,
      schemesFound: unique.size,
      transactionsFound: meta.txnCount,
      holdingsFound: meta.holdCount,
      duplicateTransactionsLinked: state.counters.duplicateLinked,
      reconciliationCasesOpened: state.counters.casesOpened,
      newTransactionsCount,
      missingTransactionsCount: state.counters.missing,
    },
    error: null,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------------------------------
const STEPS: Record<Exclude<PipelineStep, 'done'>, (env: PipelineEnv) => Promise<StepOut>> = {
  read: readStep,
  accounts: accountsStep,
  owner: ownerStep,
  schemes: schemesStep,
  transactions: transactionsStep,
  holdings: holdingsStep,
  analyse: analyseStep,
  certify: certifyStep,
  finalize: finalizeStep,
};

/**
 * Runs steps until the budget is spent, the run ends, or the lease is lost. A step that moves on is checkpointed before the next one
 * starts, so the work of a killed slice is at most one unit of one step.
 */
export async function runPipelineSlice(env: PipelineEnv): Promise<SliceOutcome> {
  for (;;) {
    if (env.state.step === 'done') throw new Error('The pipeline already finished.');
    const out = await STEPS[env.state.step](env);
    if (out.kind === 'finished') return out;
    if (out.kind === 'lost') return out;
    if (out.kind === 'more') return out;
    env.state.step = out.to;
    if (!(await env.save())) return { kind: 'lost' };
    if (env.timeLeftMs() <= 0 && out.to !== 'finalize') return { kind: 'more' };
  }
}

/** Positions a re-evaluation covers: those the statement produced snapshots for (what the Re-evaluate route has always done). */
export async function listStatementPositions(admin: Admin, userId: string, sourceDocumentId: string): Promise<Array<[string, string]>> {
  const rows = await fetchAllRows<{ account_id: string; instrument_id: string }>(() =>
    admin.from('ii_holding_snapshots').select('account_id, instrument_id').eq('user_id', userId).eq('source_document_id', sourceDocumentId).order('id', { ascending: true }),
  );
  return [...new Set(rows.map((p) => `${p.account_id}:${p.instrument_id}`))].map((k) => k.split(':') as [string, string]);
}

export const REEVALUATE_PAIR_CHUNK_BASE = CERTIFY_CHUNK_BASE;
export const REEVALUATE_PAIR_CHUNK_SIZE = PAIR_CHUNK;
export { COVERED_CHUNK_BASE };
