/**
 * M12A section 4 — FDH-BANK ACCURACY CERTIFICATION.
 *
 * Drives the sealed corpus (`tests/support/buildM12aFdhBankCorpus.ts`) through
 * the REAL `/api/aie/fdh-bank/intake` route handler and the REAL
 * `lib/aie/review/accept.ts`, and measures the result against a sealed,
 * hand-authored oracle (`scripts/m12a-fdh-bank-certification/oracle.json`) that
 * never calls production code.
 *
 * WHAT IS REAL HERE: the route handler, FDH-5's `classifyPdf` over genuinely
 * valid (and, for A09, genuinely RC4-encrypted) PDF bytes, layout detection,
 * row reconstruction, normalisation, economic fingerprinting, dedup, balance
 * reconciliation, date-coverage and overlap analysis, AIE-1.1's orchestrator,
 * the adapter's reconciliation rule, PII masking, the AI gateway's kill switch,
 * the acceptance gate and its CAS ladder. WHAT IS SUBSTITUTED: the database,
 * object storage, the AI provider, and FDH-5's two terminal canonical-write
 * services — the last of those substituted precisely so every write attempt is
 * observable.
 *
 * EVERY CASE IS RUN TWICE THROUGH THE LIFECYCLE: an intake, and then an
 * unconditional explicit accept attempt. That is what makes "false canonical
 * write rate" a real measurement rather than a tautology — it asks, of every
 * document in the corpus, "if a user pressed accept, would this be written?"
 * and compares the answer to what the oracle says may ever be written.
 *
 * The numbers this file prints are the numbers in the closure report. The
 * report does not retype them; it pastes `results.json`.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  M12A_FDH_BANK_CORPUS,
  CORPUS_USER_ID,
  buildStructurallyCorruptPdf,
  type CorpusCase,
} from '../support/buildM12aFdhBankCorpus';
import {
  measureCase,
  measureCorpus,
  formatCorpusTable,
  formatPercent,
  type CaseMeasurement,
  type EconomicItem,
  type FieldObservation,
} from '../support/aieAccuracyHarness';

const CERT_DIR = path.resolve(__dirname, '../../scripts/m12a-fdh-bank-certification');
const ORACLE_PATH = path.join(CERT_DIR, 'oracle.json');
const RESULTS_PATH = path.join(CERT_DIR, 'results.json');
const TABLE_PATH = path.join(CERT_DIR, 'results_table.md');

// ---------------------------------------------------------------------------
// Oracle shape (read-only; nothing here writes to the oracle).
// ---------------------------------------------------------------------------

interface OracleTxn {
  sourceRowNumber: number;
  transactionDate: string | null;
  amountOriginal: number;
  creditDebit: string;
  balanceAfter: number | null;
  descriptionClean: string;
}

interface OracleCase {
  id: string;
  scenario: string;
  institution: string | null;
  currencyCode: string;
  accountIdentityToken: string | null;
  printedTransactionCount: number;
  printedTransactions: OracleTxn[];
  expectedExtracted: number[];
  omissionExplainedBy: Record<string, string>;
  reconciliation: { status: string | null; variance: number | null };
  terminalRunStatus: string;
  expectedRejectionReason?: string;
  acceptable: boolean;
  expectedUnresolvedItemCount: number;
  expectedAiCalls: number;
  requiresMaskingKey?: boolean;
  mustNotAppearInAiPrompt?: string;
  reimport?: {
    expectedDedupStatusForEveryRow: string;
    expectedNewEconomicTransactions: number;
    reconciliation: { status: string | null; variance: number | null };
    terminalRunStatus: string;
    acceptable: boolean;
    minimumUnresolvedItemCount: number;
  };
}

const ORACLE = JSON.parse(readFileSync(ORACLE_PATH, 'utf8')) as { corpusVersion: string; cases: OracleCase[] };
const oracleFor = (id: string): OracleCase => {
  const found = ORACLE.cases.find((c) => c.id === id);
  if (!found) throw new Error(`oracle has no case ${id}`);
  return found;
};

// ---------------------------------------------------------------------------
// Fake infrastructure. Identical discipline to
// `tests/unit/m12aFdhBankIntakeGate.test.ts`: shared state lives on
// `globalThis`, because this file's `vi.mock` factories are instantiated once
// per importer graph and a module-level `let` is not shared between the
// instance the route sees and the instance the acceptance gate sees.
// ---------------------------------------------------------------------------

interface Recorded {
  fieldCandidates: { fieldName: string; valueRaw: string | null; isNull: boolean; sourceMethod: string; sourceReference?: Record<string, unknown> }[];
  reconciliationResults: { ruleId: string; outcome: string; delta?: number | null; materiality?: string | null }[];
  unresolvedItems: { reasonCode: string; severity: string }[];
  aiAttempts: number;
  aiPrompts: string[];
  dedupIndexLoadedForAccountIds: string[];
  intakeStatusUpdates: { toStatus: string; rejectionReason?: string }[];
  fdhUploadBankPdfCalls: number;
  fdhProcessDocumentCalls: number;
  writeBatchUpserts: string[];
  binariesFinalized: string[];
}

interface SharedState {
  recorded: Recorded;
  quarantinedBytes: Uint8Array;
  runCreated: boolean;
  runStatus: string;
  existingAccounts: { id: string; accountFingerprint: string | null }[];
  dedupIndex: Map<string, unknown>;
  priorStatementRanges: Map<string, { start: string; end: string }>;
  blockingItemCount: number;
  reconciliationOutcomes: { ruleId: string; outcome: string }[];
  writeBatchStatus: 'pending' | 'committed' | 'failed';
  aiScriptedFields: unknown[];
}

const STATE_KEY = '__m12aFdhBankAccuracyState__';

function freshState(): SharedState {
  return {
    recorded: {
      fieldCandidates: [],
      reconciliationResults: [],
      unresolvedItems: [],
      aiAttempts: 0,
      aiPrompts: [],
      dedupIndexLoadedForAccountIds: [],
      intakeStatusUpdates: [],
      fdhUploadBankPdfCalls: 0,
      fdhProcessDocumentCalls: 0,
      writeBatchUpserts: [],
      binariesFinalized: [],
    },
    quarantinedBytes: new Uint8Array(),
    runCreated: false,
    runStatus: 'none',
    existingAccounts: [],
    dedupIndex: new Map(),
    priorStatementRanges: new Map(),
    blockingItemCount: 0,
    reconciliationOutcomes: [],
    writeBatchStatus: 'pending',
    aiScriptedFields: [],
  };
}

function state(): SharedState {
  const g = globalThis as unknown as Record<string, SharedState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = freshState();
  return g[STATE_KEY]!;
}
const rec = () => state().recorded;

const RUN_ID = 'run-corpus';
const INTAKE_ID = 'intake-corpus';
const STORAGE_KEY = `${CORPUS_USER_ID}/${INTAKE_ID}/${INTAKE_ID}.bin`;

function resetState(preserve?: Partial<Pick<SharedState, 'dedupIndex' | 'priorStatementRanges' | 'existingAccounts'>>) {
  const next = freshState();
  if (preserve?.dedupIndex) next.dedupIndex = preserve.dedupIndex;
  if (preserve?.priorStatementRanges) next.priorStatementRanges = preserve.priorStatementRanges;
  if (preserve?.existingAccounts) next.existingAccounts = preserve.existingAccounts;
  (globalThis as unknown as Record<string, SharedState>)[STATE_KEY] = next;
}

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    requireCountryConfirmedUser: async () => ({ user: { id: CORPUS_USER_ID, email: 'pilot@example.test' }, unauthenticated: null }),
  };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from: () => ({}) }) }));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      upsert: async (row: { status: string }) => {
        rec().writeBatchUpserts.push(row.status);
        return { data: null, error: null };
      },
    }),
    // The AI cost ledger. Left ADMITTING rather than refusing, deliberately:
    // a fake that refused every reservation would block the A05 provider call
    // for a reason that has nothing to do with the property under test, and
    // the case would then "pass" its zero-egress assertions while proving
    // nothing. (That is not hypothetical — the first run of this corpus threw
    // `admin.rpc is not a function` here, and the unset-masking-key case
    // recorded a throw for the wrong reason until this was added.)
    rpc: async (fn: string) => {
      if (fn === 'aie_reserve_ai_cost') return { data: [{ reserved: true, remaining_usd: 10 }], error: null };
      return { data: null, error: null };
    },
  }),
}));

vi.mock('@/lib/aie/storage', () => ({
  AIE_QUARANTINE_BUCKET: 'aie-document-quarantine',
  buildQuarantineStorageKey: (userId: string, intakeId: string) => `${userId}/${intakeId}/${intakeId}.bin`,
  // Copied, not aliased: the route's request ArrayBuffer is detached later in
  // the same request, so a retained alias reads back as zero bytes.
  uploadToQuarantine: async (p: { bytes: Uint8Array }) => {
    state().quarantinedBytes = new Uint8Array(p.bytes);
    return { ok: true };
  },
  downloadFromQuarantine: async () =>
    state().quarantinedBytes.byteLength > 0
      ? { ok: true as const, bytes: state().quarantinedBytes }
      : { ok: false as const, message: 'object missing' },
  deleteFromQuarantine: async () => ({ ok: true }),
  verifyQuarantineObjectAbsent: async () => true,
}));

vi.mock('@/lib/aie/services/purge', () => ({
  finalizeDocumentBinaryAfterRun: async (p: { storageKey: string }) => {
    rec().binariesFinalized.push(p.storageKey);
    return { status: 'deleted' as const };
  },
}));

vi.mock('@/lib/aie/audit', () => ({ recordAieAuditEvent: async () => {} }));

vi.mock('@/lib/aie/provider/providerFactory', async () => {
  const { MockAieProvider } = await import('@/lib/aie/provider/mockAieProvider');
  return {
    createAieAiProvider: () =>
      new MockAieProvider({
        respond: (req: { userPrompt: string }) => {
          rec().aiPrompts.push(req.userPrompt);
          return JSON.stringify({ fields: state().aiScriptedFields });
        },
      }),
  };
});

vi.mock('@/lib/aie/db/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aie/db/repository')>();
  return {
    ...actual,
    createIntake: async () => ({ id: INTAKE_ID }),
    updateIntakeStatus: async (p: { toStatus: string; rejectionReason?: string }) => {
      rec().intakeStatusUpdates.push({ toStatus: p.toStatus, rejectionReason: p.rejectionReason });
      return { ok: true as const };
    },
    recordFdhBankUploadMetadata: async () => {},
    recordFingerprint: async () => {},
    existingFingerprintHashesForUser: async () => [],
    createRun: async () => {
      state().runCreated = true;
      state().runStatus = 'local_extracting';
      return { id: RUN_ID };
    },
    createUnresolvedItems: async (p: { items: { reasonCode: string; severity: string }[] }) => {
      rec().unresolvedItems.push(...p.items.map((i) => ({ reasonCode: i.reasonCode, severity: i.severity })));
      state().blockingItemCount = rec().unresolvedItems.filter((i) => i.severity === 'blocking').length;
      return p.items.map((_, i) => `item-${i}`);
    },
    // recordTransition is what actually UPDATES aie_extraction_run.status in the
    // real repository (repository.ts:267), so the fake mirrors it. Without this
    // the run never reaches 'awaiting_acceptance' in the fake database, every
    // accept attempt returns not_ready, and 'false canonical write rate = 0'
    // would be vacuously true because nothing was ever acceptable.
    recordTransition: async (p: { toState: string }) => {
      state().runStatus = p.toState;
    },
    recordParserAttempt: async () => {},
    recordMaskingSummary: async () => {},
    recordAiCompletionAttempt: async () => {
      rec().aiAttempts += 1;
      return { id: 'attempt-1' };
    },
    recordSchemaValidationResult: async () => {},
    recordFieldCandidates: async (p: { candidates: Recorded['fieldCandidates'] }) => {
      rec().fieldCandidates.push(...p.candidates);
    },
    recordReconciliationRuns: async (p: { results: { ruleId: string; outcome: string; delta?: number | null; materiality?: string | null }[] }) => {
      rec().reconciliationResults.push(...p.results);
      state().reconciliationOutcomes = p.results.map((r) => ({ ruleId: r.ruleId, outcome: r.outcome }));
    },
    getRunForUser: async () =>
      state().runCreated
        ? { id: RUN_ID, intakeId: INTAKE_ID, userId: CORPUS_USER_ID, status: state().runStatus, aiUsed: false, startedAt: new Date().toISOString() }
        : null,
    getAdapterIdForRun: async () => 'aie_fdh_bank_statement_bridge_v1',
    getIntakeUploadMetadata: async () => ({ storageKey: STORAGE_KEY, declaredMimeType: 'application/pdf', displayFilename: 'statement.pdf' }),
    getFdhBankUploadMetadata: async () => ({ country_code: 'AU', currency_code: 'AUD' }),
    findCommittedFdhBankWriteForRun: async () => null,
    countItemsBlockingAcceptanceForRun: async () => state().blockingItemCount,
    latestReconciliationOutcomesForRun: async () => state().reconciliationOutcomes,
    listFieldCandidatesForRun: async () => [],
    listLatestCorrectionsForRun: async () => [],
    findOrCreateWriteBatch: async () => ({ id: 'outer-batch', status: state().writeBatchStatus }),
    markWriteBatchStatus: async (_id: string, status: 'pending' | 'committed' | 'failed') => {
      state().writeBatchStatus = status;
    },
    transitionRunStatusCas: async (p: { fromStatus: string; toStatus: string }) => {
      if (state().runStatus !== p.fromStatus) return false;
      state().runStatus = p.toStatus;
      return true;
    },
  };
});

vi.mock('@/lib/financial-data-hub/bank-csv/repository', () => ({
  loadDedupIndexForAccount: async (_userId: string, accountId: string) => {
    rec().dedupIndexLoadedForAccountIds.push(accountId);
    return state().dedupIndex;
  },
  loadPriorStatementDateRanges: async () => state().priorStatementRanges,
  loadExistingAccountsForInstitutionCurrency: async () => state().existingAccounts,
}));

vi.mock('@/lib/financial-data-hub/services/bankPdfUploadService', () => ({
  uploadBankPdf: async () => {
    rec().fdhUploadBankPdfCalls += 1;
    return { accountResolution: 'create', document: { id: 'fdh-statement-upload-1' } };
  },
}));

vi.mock('@/lib/financial-data-hub/services/bankPdfProcessingService', () => ({
  processBankPdfDocument: async () => {
    rec().fdhProcessDocumentCalls += 1;
    return { certificationStatus: 'certified', pipelineStatus: 'completed', transactionsCreated: 4 };
  },
  BankPdfProcessingError: class BankPdfProcessingError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

// ---------------------------------------------------------------------------
// Driving the real lifecycle.
// ---------------------------------------------------------------------------

// The adapter's own field NAMES are imported rather than retyped — a
// certification that silently looked for a field the adapter stopped emitting
// would report a perfect zero instead of a failure. The oracle's VALUES remain
// entirely independent; only the vocabulary is shared.
import {
  ADAPTER_ID_FIELD_NAME,
  RECONCILIATION_STATUS_FIELD_NAME,
  RECONCILIATION_VARIANCE_FIELD_NAME,
  TRANSACTION_ROW_FIELD_PREFIX as TXN_PREFIX,
} from '@/lib/aie/adapters/fdhBankStatement/types';

function intakeRequest(c: CorpusCase, bytes: Uint8Array): Request {
  const q = new URLSearchParams({
    country_code: c.request.country_code,
    currency_code: c.request.currency_code,
    institution_id: c.request.institution_id,
    masked_identifier: c.request.masked_identifier,
    filename: c.request.filename,
  });
  return new Request(`https://app.test/api/aie/fdh-bank/intake?${q.toString()}`, {
    method: 'POST',
    headers: { 'content-length': String(bytes.byteLength), 'content-type': 'application/pdf' },
    body: bytes,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

interface LifecycleObservation {
  finalStatus: string;
  rejectionReason: string | null;
  intakeThrew: string | null;
  acceptOutcome: { ok: boolean; reason?: string };
  writeDuringIntake: number;
  writeAfterAccept: number;
}

async function runLifecycle(c: CorpusCase, bytes: Uint8Array, opts: { attemptAccept: boolean } = { attemptAccept: true }): Promise<LifecycleObservation> {
  const { POST } = await import('@/app/api/aie/fdh-bank/intake/route');
  let finalStatus = 'threw';
  let rejectionReason: string | null = null;
  let intakeThrew: string | null = null;
  try {
    const res = await POST(intakeRequest(c, bytes));
    const body = (await res.json()) as { data?: { status?: string; failure_code?: string }; error?: string };
    finalStatus = body.data?.status ?? `http_error:${body.error ?? 'unknown'}`;
    rejectionReason = body.data?.failure_code ?? null;
  } catch (e) {
    intakeThrew = e instanceof Error ? e.message.slice(0, 200) : 'unknown';
  }
  const writeDuringIntake = rec().fdhUploadBankPdfCalls;

  let acceptOutcome: { ok: boolean; reason?: string } = { ok: false, reason: 'not_attempted' };
  if (opts.attemptAccept) {
    const { acceptRun } = await import('@/lib/aie/review/accept');
    const outcome = await acceptRun({
      runId: RUN_ID,
      userId: CORPUS_USER_ID,
      acceptedByUserId: CORPUS_USER_ID,
      ownerHouseholdRole: 'self',
      idempotencyKey: `${RUN_ID}:accept:1`,
    });
    acceptOutcome = outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
  }

  return {
    finalStatus,
    rejectionReason,
    intakeThrew,
    acceptOutcome,
    writeDuringIntake,
    writeAfterAccept: rec().fdhUploadBankPdfCalls - writeDuringIntake,
  };
}

// ---------------------------------------------------------------------------
// Turning what the system recorded into the harness's vocabulary.
// ---------------------------------------------------------------------------

interface ParsedRowCandidate {
  sourceRowNumber: number;
  transactionDate: string | null;
  descriptionClean: string;
  amountOriginal: number;
  creditDebit: string;
  balanceAfter: number | null;
  dedupStatus: string;
}

function observedRowCandidates(): ParsedRowCandidate[] {
  return rec()
    .fieldCandidates.filter((c) => c.fieldName.startsWith(TXN_PREFIX))
    .map((c) => ({ sourceRowNumber: Number(c.fieldName.slice(TXN_PREFIX.length)), ...(JSON.parse(c.valueRaw as string) as Omit<ParsedRowCandidate, 'sourceRowNumber'>) }));
}

function candidateValue(fieldName: string): string | null | undefined {
  const found = rec().fieldCandidates.find((c) => c.fieldName === fieldName);
  if (!found) return undefined;
  return found.isNull ? null : (found.valueRaw as string);
}

function observedFieldsFor(rows: ParsedRowCandidate[]): FieldObservation[] {
  const fields: FieldObservation[] = [];
  const institution = candidateValue(ADAPTER_ID_FIELD_NAME);
  if (institution !== undefined) fields.push({ fieldName: 'institution', value: institution });
  const status = candidateValue(RECONCILIATION_STATUS_FIELD_NAME);
  if (status !== undefined) fields.push({ fieldName: 'reconciliation_status', value: status });
  const variance = candidateValue(RECONCILIATION_VARIANCE_FIELD_NAME);
  if (variance !== undefined) fields.push({ fieldName: 'reconciliation_variance', value: variance === null ? null : String(Number(variance)) });
  for (const r of rows) {
    fields.push({ fieldName: `txn:${r.sourceRowNumber}:date`, value: r.transactionDate });
    fields.push({ fieldName: `txn:${r.sourceRowNumber}:amount`, value: String(r.amountOriginal) });
    fields.push({ fieldName: `txn:${r.sourceRowNumber}:direction`, value: r.creditDebit });
    fields.push({ fieldName: `txn:${r.sourceRowNumber}:balance`, value: r.balanceAfter === null ? null : String(r.balanceAfter) });
    fields.push({ fieldName: `txn:${r.sourceRowNumber}:description`, value: r.descriptionClean });
  }
  return fields;
}

function expectedFieldsFor(o: OracleCase): FieldObservation[] {
  const fields: FieldObservation[] = [];
  if (o.institution) fields.push({ fieldName: 'institution', value: o.institution });
  if (o.reconciliation.status) fields.push({ fieldName: 'reconciliation_status', value: o.reconciliation.status });
  if (o.reconciliation.variance !== null) fields.push({ fieldName: 'reconciliation_variance', value: String(o.reconciliation.variance) });
  for (const n of o.expectedExtracted) {
    const t = o.printedTransactions.find((p) => p.sourceRowNumber === n)!;
    fields.push({ fieldName: `txn:${n}:date`, value: t.transactionDate });
    fields.push({ fieldName: `txn:${n}:amount`, value: String(t.amountOriginal) });
    fields.push({ fieldName: `txn:${n}:direction`, value: t.creditDebit });
    fields.push({ fieldName: `txn:${n}:balance`, value: t.balanceAfter === null ? null : String(t.balanceAfter) });
    fields.push({ fieldName: `txn:${n}:description`, value: t.descriptionClean });
  }
  return fields;
}

const toEconomic = (t: OracleTxn): EconomicItem => ({ key: t.sourceRowNumber, date: t.transactionDate, amount: t.amountOriginal, direction: t.creditDebit, balance: t.balanceAfter });
const rowToEconomic = (r: ParsedRowCandidate): EconomicItem => ({ key: r.sourceRowNumber, date: r.transactionDate, amount: r.amountOriginal, direction: r.creditDebit, balance: r.balanceAfter });

/**
 * WHAT COUNTS AS THE SYSTEM ACCOUNTING FOR A MISSING ROW. Deliberately narrow:
 * the run must have refused the document outright (`rejected`), or stopped
 * short of an acceptable state with a blocking item raised (`unresolved`), or
 * crashed rather than returning a clean answer. A run that reaches
 * `awaiting_acceptance` has accounted for nothing, however good its reasons —
 * from the user's side it is a document ready to be written.
 */
function omissionsAccountedFor(o: OracleCase, obs: LifecycleObservation, observedKeys: Set<number>): number[] {
  const blocked = obs.finalStatus === 'rejected' || obs.finalStatus === 'unresolved' || obs.finalStatus === 'privacy_blocked' || obs.intakeThrew !== null;
  if (!blocked) return [];
  return o.printedTransactions.map((t) => t.sourceRowNumber).filter((n) => !observedKeys.has(n));
}

// ---------------------------------------------------------------------------

const measurements: CaseMeasurement[] = [];
const oracleAcceptableFlags: boolean[] = [];
const perCaseEvidence: Record<string, unknown> = {};

describe('M12A.4 — FDH-bank accuracy certification against a sealed corpus', () => {
  beforeEach(() => {
    resetState();
    process.env.AIE_FDH_BANK_ADAPTER_ENABLED = 'true';
    process.env.AIE_DOCUMENT_INTAKE_ENABLED = 'true';
    process.env.AIE_ALLOW_MISSING_SIGNATURE_SCANNER = 'true';
    process.env.AIE_PILOT_COHORT_USER_IDS = CORPUS_USER_ID;
    process.env.AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED = 'true';
    process.env.AIE_REVIEW_CANONICAL_ACCEPTANCE_ENABLED = 'true';
    delete process.env.AIE_AI_FALLBACK_ENABLED;
    delete process.env.AIE_FDH_BANK_AI_FALLBACK_ENABLED;
    delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
  });

  for (const c of M12A_FDH_BANK_CORPUS) {
    it(`${c.id} — ${c.title}`, async () => {
      const o = oracleFor(c.id);

      // Seed the account the oracle's identity token belongs to, so "did the
      // system compute the same account identity we did?" is answered by the
      // system's own behaviour: it reuses this account only if its independently
      // computed fingerprint equals the oracle's.
      if (o.accountIdentityToken) {
        state().existingAccounts = [{ id: 'oracle-account-1', accountFingerprint: o.accountIdentityToken }];
      }

      // A05 is the one case that reaches the masking stage. Run it under an
      // EPHEMERAL, in-process key so the deterministic invariants can still be
      // measured; the unset-key behaviour is proved separately below and is why
      // this case is reported CONDITIONAL rather than PASS.
      if (o.requiresMaskingKey) {
        process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'a1'.repeat(32);
        process.env.AIE_AI_FALLBACK_ENABLED = 'true';
        process.env.AIE_FDH_BANK_AI_FALLBACK_ENABLED = 'true';
      }

      const obs = await runLifecycle(c, c.bytes());
      const rows = observedRowCandidates();
      const observedKeys = new Set(rows.map((r) => r.sourceRowNumber));

      const measurement = measureCase({
        caseId: c.id,
        scenario: o.scenario,
        expectedFields: expectedFieldsFor(o),
        observedFields: observedFieldsFor(rows),
        expectedEconomic: o.printedTransactions.map(toEconomic),
        observedEconomic: rows.map(rowToEconomic),
        omissionsAccountedFor: omissionsAccountedFor(o, obs, observedKeys),
        oracleAcceptable: o.acceptable,
        observedAcceptable: obs.finalStatus === 'awaiting_acceptance',
        canonicalWriteOccurred: obs.writeDuringIntake + obs.writeAfterAccept > 0,
        explicitAcceptPerformed: obs.acceptOutcome.ok,
      });
      measurements.push(measurement);
      oracleAcceptableFlags.push(o.acceptable);
      perCaseEvidence[c.id] = {
        observedTerminalStatus: obs.finalStatus,
        observedRejectionReason: obs.rejectionReason,
        intakeThrew: obs.intakeThrew,
        acceptOutcome: obs.acceptOutcome,
        canonicalWritesDuringIntake: obs.writeDuringIntake,
        canonicalWritesAfterExplicitAccept: obs.writeAfterAccept,
        aiCompletionAttempts: rec().aiAttempts,
        unresolvedItems: rec().unresolvedItems,
        reconciliationResults: rec().reconciliationResults,
        accountIdentityReuseObserved: rec().dedupIndexLoadedForAccountIds,
        intakeStatusUpdates: rec().intakeStatusUpdates,
      };

      // --- Per-case invariants the corpus exists to enforce ----------------

      // 1. No canonical write ever happens at intake, for any document.
      expect(obs.writeDuringIntake).toBe(0);

      // 2. A document the oracle says may never be written is never written,
      //    even when acceptance is explicitly attempted.
      if (!o.acceptable) {
        expect(obs.writeAfterAccept).toBe(0);
        expect(obs.acceptOutcome.ok).toBe(false);
      }

      // 3. Account identity: when the system got as far as resolving an
      //    account, it must have computed the oracle's own token — observable
      //    because it reuses the seeded account only on an exact match.
      if (o.accountIdentityToken && rec().dedupIndexLoadedForAccountIds.length > 0) {
        expect(rec().dedupIndexLoadedForAccountIds).toEqual(['oracle-account-1']);
      }

      // 4. AI is consulted exactly where the oracle says, and nowhere else.
      expect(rec().aiAttempts).toBe(o.expectedAiCalls);

      // 5. Nothing the oracle forbids in an AI prompt ever reaches the provider.
      if (o.mustNotAppearInAiPrompt) {
        expect(rec().aiPrompts.length).toBeGreaterThan(0);
        for (const prompt of rec().aiPrompts) expect(prompt).not.toContain(o.mustNotAppearInAiPrompt);
      }

      // 6. No unexplained economic omission, anywhere in the corpus.
      expect(measurement.unexplainedOmissions).toEqual([]);

      // 7. Field and economic agreement with the oracle, disagreements named.
      expect(measurement.fieldDisagreements).toEqual([]);
      expect(measurement.economicDisagreements.filter((d) => d.observed !== null)).toEqual([]);

      // 8. The observed terminal state is the one the oracle demands.
      expect(obs.finalStatus).toBe(o.terminalRunStatus);
      if (o.expectedRejectionReason) expect(obs.rejectionReason).toBe(o.expectedRejectionReason);
    });
  }

  it('FDH-A07R — the reimport pass: every row dedups, nothing new is created, and the run does not reach acceptance', async () => {
    const c = M12A_FDH_BANK_CORPUS.find((x) => x.id === 'FDH-A07')!;
    const o = oracleFor('FDH-A07');
    const reimport = o.reimport!;

    // Pass 1 populates the account's dedup index for real, from the economic
    // fingerprints the first import produced — not from a hand-written map.
    state().existingAccounts = [{ id: 'oracle-account-1', accountFingerprint: o.accountIdentityToken! }];
    await runLifecycle(c, c.bytes(), { attemptAccept: false });
    const firstPassRows = observedRowCandidates();
    expect(firstPassRows.length).toBe(o.printedTransactionCount);
    const fingerprints = rec()
      .fieldCandidates.filter((f) => f.fieldName.startsWith(TXN_PREFIX))
      .map((f) => (f.sourceReference as { economicFingerprint: string }).economicFingerprint);
    expect(new Set(fingerprints).size).toBe(o.printedTransactionCount);

    const dedupIndex = new Map<string, unknown>();
    for (const fp of fingerprints) dedupIndex.set(fp, [{ transactionId: `already-imported-${fp.slice(0, 8)}`, hasStrongEvidence: true }]);
    const priorRanges = new Map<string, { start: string; end: string }>([['prior-import', { start: '2026-08-01', end: '2026-08-08' }]]);

    // Pass 2: the same document, same account, against what pass 1 created.
    resetState({ dedupIndex, priorStatementRanges: priorRanges, existingAccounts: [{ id: 'oracle-account-1', accountFingerprint: o.accountIdentityToken! }] });
    const obs = await runLifecycle(c, c.bytes());
    const rows = observedRowCandidates();

    expect(rows.length).toBe(o.printedTransactionCount);
    for (const r of rows) expect(r.dedupStatus).toBe(reimport.expectedDedupStatusForEveryRow);
    expect(candidateValue(RECONCILIATION_STATUS_FIELD_NAME)).toBe(reimport.reconciliation.status);
    expect(obs.finalStatus).toBe(reimport.terminalRunStatus);
    expect(rec().unresolvedItems.length).toBeGreaterThanOrEqual(reimport.minimumUnresolvedItemCount);
    expect(obs.acceptOutcome.ok).toBe(false);
    expect(obs.writeDuringIntake + obs.writeAfterAccept).toBe(reimport.expectedNewEconomicTransactions);

    perCaseEvidence['FDH-A07R'] = {
      observedTerminalStatus: obs.finalStatus,
      dedupStatuses: [...new Set(rows.map((r) => r.dedupStatus))],
      unresolvedItems: rec().unresolvedItems,
      reconciliationResults: rec().reconciliationResults,
      acceptOutcome: obs.acceptOutcome,
      canonicalWrites: obs.writeDuringIntake + obs.writeAfterAccept,
    };
  });

  it('CONTROL — a structurally corrupt PDF is refused, with nothing extracted and nothing written', async () => {
    const c = M12A_FDH_BANK_CORPUS[0];
    const obs = await runLifecycle(c, buildStructurallyCorruptPdf());
    expect(obs.finalStatus).toBe('rejected');
    expect(observedRowCandidates()).toEqual([]);
    expect(obs.writeDuringIntake + obs.writeAfterAccept).toBe(0);
    perCaseEvidence['CONTROL-corrupt-pdf'] = { observedTerminalStatus: obs.finalStatus, observedRejectionReason: obs.rejectionReason, intakeStatusUpdates: rec().intakeStatusUpdates };
  });

  it('FDH-A05 CONDITIONAL — with AIE_MASK_TOKEN_ENCRYPTION_KEY unset (this environment), the ambiguous-layout run cannot complete at all', async () => {
    const c = M12A_FDH_BANK_CORPUS.find((x) => x.id === 'FDH-A05')!;
    // No key. No workaround. This is the environment as it actually stands.
    expect(process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY).toBeUndefined();

    const obs = await runLifecycle(c, c.bytes(), { attemptAccept: false });

    // Masking fails CLOSED, which is the correct security posture — but the
    // route has no handler for it, so the request does not degrade to
    // `unresolved`: it does not return at all. Recorded exactly as observed.
    expect(obs.intakeThrew).not.toBeNull();
    expect(obs.writeDuringIntake).toBe(0);
    expect(rec().aiAttempts).toBe(0);
    expect(observedRowCandidates()).toEqual([]);
    perCaseEvidence['FDH-A05-no-masking-key'] = {
      intakeThrew: obs.intakeThrew,
      canonicalWrites: obs.writeDuringIntake,
      aiCompletionAttempts: rec().aiAttempts,
      note: 'AIE_MASK_TOKEN_ENCRYPTION_KEY is unset in this environment and is a Product-Owner/operator-owned blocker; no workaround was attempted.',
    };
  });

  afterAll(() => {
    mkdirSync(CERT_DIR, { recursive: true });
    const corpus = measureCorpus(measurements, oracleAcceptableFlags);
    const payload = {
      corpusVersion: ORACLE.corpusVersion,
      generatedBy: 'tests/unit/m12aFdhBankAccuracyCorpus.test.ts',
      summary: {
        caseCount: corpus.caseCount,
        fieldPrecision: corpus.fieldPrecision,
        fieldRecall: corpus.fieldRecall,
        economicPrecision: corpus.economicPrecision,
        economicRecall: corpus.economicRecall,
        falseAcceptRate: corpus.falseAcceptRate,
        falseAcceptCount: corpus.falseAcceptCount,
        falseAcceptDenominator: corpus.falseAcceptDenominator,
        falseCanonicalWriteRate: corpus.falseCanonicalWriteRate,
        falseCanonicalWriteCount: corpus.falseCanonicalWriteCount,
        totalUnexplainedOmissions: corpus.totalUnexplainedOmissions,
      },
      cases: corpus.cases,
      evidence: perCaseEvidence,
    };
    writeFileSync(RESULTS_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    writeFileSync(
      TABLE_PATH,
      `${formatCorpusTable(corpus)}\n\n- unexplained economic omissions: **${corpus.totalUnexplainedOmissions}**\n` +
        `- false accept rate: **${formatPercent(corpus.falseAcceptRate)}** (${corpus.falseAcceptCount} of ${corpus.falseAcceptDenominator} must-not-be-acceptable cases)\n` +
        `- false canonical write rate: **${formatPercent(corpus.falseCanonicalWriteRate)}** (${corpus.falseCanonicalWriteCount} of ${corpus.caseCount} cases)\n`,
    );
  });
});
