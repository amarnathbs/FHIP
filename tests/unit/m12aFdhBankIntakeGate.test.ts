/**
 * M12D TRACEABILITY — Product-Owner requirement ids this file is evidence for.
 *
 * Added by the M12 Phase D mapping pass. Each id below was checked against this
 * file's ACTUAL assertions; ids it only touches incidentally are deliberately
 * omitted, and where this file does NOT discharge a neighbouring requirement,
 * that is said so explicitly rather than left to be assumed.
 * Full matrix: docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md
 *
 *   AIE13-IMPORT-02  Validate tenant, account, accepted run version and reconciliation
 *                    status server-side.
 *   AIE13-IMPORT-12  Prevent direct AIE/AI writes to transaction tables outside this
 *                    service — M2-OPEN-6 reproduced RED, then the inline intake-time
 *                    write was removed along with its import.
 *   AIE16-ATOM-08    Verify every canonical record links to AIE
 *                    document/run/decision/write batch.
 */
/**
 * M12A section 3 — FDH-BANK AIE CONTRACT. The lifecycle gate, proved end to
 * end.
 *
 * THE DEFECT THIS FILE CLOSES, AND THE RED EVIDENCE FOR IT.
 * The prior mission (`M2-OPEN-6`, restated in the M11 final certification
 * §6.8) recorded that `app/api/aie/fdh-bank/intake/route.ts` performed a
 * canonical FDH write inline at intake time, bypassing
 * `lib/aie/review/accept.ts` entirely — no acceptance flag, no re-read of the
 * blocking-item count, no CAS, no explicit user acceptance. No phase of that
 * mission ever touched the route, so the claim was carried forward on paper.
 * M12A did not take its word for it: the FIRST commit of this file
 * (`test(m12a): RED reproduction of the FDH-bank intake-time canonical
 * write`) asserted the DEFECTIVE behaviour against the then-current code and
 * **passed, 2/2** — a clean, fully-reconciling CBA statement returned
 * `awaiting_acceptance` AND, in the same request, drove FDH-5's own
 * `uploadBankPdf` + `processBankPdfDocument` to completion and committed an
 * `aie_write_batch` row, with `isAieCanonicalAcceptanceEnabled` never read and
 * zero CAS run transitions. That commit is the preserved RED evidence; this
 * file now asserts the inverse.
 *
 * WHAT THIS DRIVES. The REAL Next.js route handler, imported and invoked
 * directly with a real `Request` (its `ok`/`bad` helpers are plain
 * `Response.json`, so no Next.js server harness is needed). REAL, genuinely
 * valid synthetic PDF bytes via `buildBankPdfFixture`. FDH-5's REAL
 * `classifyPdf`, the REAL parser bridge, the REAL AIE-1.1 orchestrator, the
 * REAL reconciliation rule, the REAL `acceptRun`, and the REAL
 * `commitFdhBankStatementImport`. Only the database, object storage and
 * FDH-5's two terminal write services are substituted — and those precisely
 * so their invocation (or non-invocation) can be observed.
 *
 * THE ENVIRONMENT MODELLED: `AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED=true`, i.e.
 * the configuration a production activation of this adapter would have to run
 * in. With the flag OFF the defect was masked — the inline commit call still
 * happened but returned `atomic_import_disabled` before touching anything —
 * which is exactly why it survived unnoticed.
 *
 * No real bank statement, sanitised or otherwise, is used anywhere here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildBankPdfFixture } from '../support/buildBankPdfFixture';

// ---------------------------------------------------------------------------
// Observation points. Every substituted module records what it was asked to
// do, so the assertions below are about observed behaviour, not shape.
// ---------------------------------------------------------------------------

interface Recorded {
  intakeStatusUpdates: { intakeId: string; toStatus: string; rejectionReason?: string }[];
  runsCreated: { intakeId: string; userId: string }[];
  runTransitions: { runId: string; fromStatus: string; toStatus: string }[];
  parserAttempts: { runId: string; adapterId: string; outcome: string }[];
  unresolvedItems: { runId: string; items: { reasonCode: string; severity: string }[] }[];
  reconciliationRuns: { runId: string; results: { ruleId: string; outcome: string }[] }[];
  /** FDH-5's OWN canonical upload service — the first half of a real write. */
  fdhUploadBankPdfCalls: { userId: string }[];
  /** FDH-5's OWN canonical processing service — the half that creates rows. */
  fdhProcessDocumentCalls: { userId: string; documentId: string }[];
  writeBatchUpserts: { status: string; target_module: string }[];
  acceptanceFlagReads: number;
  quarantineDownloads: string[];
  binariesFinalized: string[];
  auditEvents: { eventType: string }[];
  /** M12C section 12: the aie_processing_transition rows accept.ts now writes. */
  fsmTransitionAudits: { from: string; to: string; actorType: string }[];
}

interface SharedState {
  recorded: Recorded;
  /** The bytes the route put in quarantine, so accept-time re-fetch is real. */
  quarantinedBytes: Uint8Array;
  /** The one run's genuine status, mutated only by a genuine CAS. */
  runStatus: string;
  blockingItemCount: number;
  reconciliationOutcomes: { ruleId: string; outcome: string }[];
  writeBatchStatus: 'pending' | 'committed' | 'failed';
}

// WHY THIS LIVES ON `globalThis` RATHER THAN IN A MODULE-LEVEL `let`.
// Two different specifiers resolve to the same storage module here — this
// file mocks `@/lib/aie/storage`, while `lib/aie/review/accept.ts` imports
// `../storage` — and Vitest evaluates this file's `vi.mock` factory once per
// resolved importer graph. A module-level `let` is therefore NOT shared
// between the factory instance the intake route sees and the one the
// acceptance gate sees: proved by running exactly that, where the upload
// observed 989 bytes and the download in the same test observed 0. Keying the
// state off `globalThis` gives every factory instance the one object, which is
// the point — the whole test is about one document flowing from intake to a
// genuinely later, separate acceptance request.
const STATE_KEY = '__m12aFdhBankIntakeGateState__';

function freshState(): SharedState {
  return {
    recorded: {
      intakeStatusUpdates: [],
      runsCreated: [],
      runTransitions: [],
      parserAttempts: [],
      unresolvedItems: [],
      reconciliationRuns: [],
      fdhUploadBankPdfCalls: [],
      fdhProcessDocumentCalls: [],
      writeBatchUpserts: [],
      acceptanceFlagReads: 0,
      quarantineDownloads: [],
      binariesFinalized: [],
      auditEvents: [],
      fsmTransitionAudits: [],
    },
    quarantinedBytes: new Uint8Array(),
    runStatus: 'none',
    blockingItemCount: 0,
    reconciliationOutcomes: [],
    writeBatchStatus: 'pending',
  };
}

function state(): SharedState {
  const g = globalThis as unknown as Record<string, SharedState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = freshState();
  return g[STATE_KEY]!;
}

/** Shorthand for the assertions below. */
function rec(): Recorded {
  return state().recorded;
}

const RUN_ID = 'run-m12a';
const INTAKE_ID = 'intake-m12a';
const USER_ID = 'user-m12a';

function resetRecorded() {
  (globalThis as unknown as Record<string, SharedState>)[STATE_KEY] = freshState();
}
// Deliberately NOT called at module top level. This file's own module graph is
// instantiated more than once (see the note above), and a top-level reset
// re-ran mid-test — the moment `lib/aie/review/accept.ts` was first imported —
// wiping the quarantined bytes the intake request had just stored. Resetting
// only in `beforeEach` keeps the lifecycle under the test's control.

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    requireCountryConfirmedUser: async () => ({ user: { id: USER_ID, email: 'pilot@example.test' }, unauthenticated: null }),
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: () => ({}) }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      upsert: async (row: { status: string; target_module: string }) => {
        rec().writeBatchUpserts.push({ status: row.status, target_module: row.target_module });
        return { data: null, error: null };
      },
      // M12C §12 (`M2-OPEN-1`): `acceptRun` now pairs every
      // `transitionRunStatusCas` with `recordRunTransitionAudit`, which inserts
      // into `aie_processing_transition`. This test drives the REAL
      // `createDefaultAcceptRunDeps()`, so that insert reaches this fake — and
      // a fake that only knew `upsert` failed with
      // `admin.from(...).insert is not a function`, which is the fake being
      // out of date rather than the gate being broken.
      //
      // Recorded rather than swallowed, so this file's own claim — that the
      // canonical write moved to the shared acceptance gate and did not
      // disappear — is now backed by the FSM audit trail too, not only by the
      // write-batch upserts.
      insert: async (row: Record<string, unknown>) => {
        if (table === 'aie_processing_transition') {
          rec().fsmTransitionAudits.push({ from: String(row.from_state), to: String(row.to_state), actorType: String(row.actor_type) });
        }
        return { data: null, error: null };
      },
    }),
  }),
}));

vi.mock('@/lib/aie/storage', () => ({
  AIE_QUARANTINE_BUCKET: 'aie-document-quarantine',
  buildQuarantineStorageKey: (userId: string, intakeId: string) => `${userId}/${intakeId}/${intakeId}.bin`,
  uploadToQuarantine: async (p: { bytes: Uint8Array }) => {
    // COPIED, not aliased, and the reason is not stylistic. The route's bytes
    // come from `await req.arrayBuffer()`, and by the time the accept-time
    // re-fetch runs, that ArrayBuffer has been DETACHED further down the same
    // request (a detached view reports `byteLength === 0`, which is exactly
    // what a retained alias produced here: the upload observed 989 bytes and
    // the later download observed 0). The real storage layer uploads the bytes
    // to Supabase Storage, so nothing in production depends on the caller's
    // buffer staying alive; this copy is what makes the fake behave like the
    // real one rather than like a reference.
    state().quarantinedBytes = new Uint8Array(p.bytes);
    return { ok: true };
  },
  downloadFromQuarantine: async (key: string) => {
    rec().quarantineDownloads.push(key);
    return state().quarantinedBytes.byteLength > 0 ? { ok: true as const, bytes: state().quarantinedBytes } : { ok: false as const, message: 'object missing' };
  },
  deleteFromQuarantine: async () => ({ ok: true }),
  verifyQuarantineObjectAbsent: async () => true,
}));

vi.mock('@/lib/aie/services/purge', () => ({
  finalizeDocumentBinaryAfterRun: async (p: { storageKey: string }) => {
    rec().binariesFinalized.push(p.storageKey);
    return { status: 'deleted' as const };
  },
}));

vi.mock('@/lib/aie/audit', () => ({
  recordAieAuditEvent: async (e: { eventType: string }) => {
    rec().auditEvents.push({ eventType: e.eventType });
  },
}));

vi.mock('@/lib/aie/db/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aie/db/repository')>();
  return {
    ...actual,
    createIntake: async () => ({ id: INTAKE_ID }),
    updateIntakeStatus: async (p: { intakeId: string; toStatus: string; rejectionReason?: string }) => {
      rec().intakeStatusUpdates.push(p);
      return { ok: true as const };
    },
    recordFdhBankUploadMetadata: async () => {},
    recordFingerprint: async () => {},
    existingFingerprintHashesForUser: async () => [],
    createRun: async (p: { intakeId: string; userId: string }) => {
      rec().runsCreated.push(p);
      return { id: RUN_ID };
    },
    createUnresolvedItems: async (p: { runId: string; items: { reasonCode: string; severity: string }[] }) => {
      rec().unresolvedItems.push(p);
      return p.items.map((_, i) => `item-${i}`);
    },
    // recordTransition is what actually UPDATES aie_extraction_run.status in
    // the real repository (repository.ts:267), so the fake mirrors it — the run
    // reaches 'awaiting_acceptance' because the pipeline genuinely drove it
    // there, not because the fake was seeded that way.
    recordTransition: async (p: { toState: string }) => {
      state().runStatus = p.toState;
    },
    recordParserAttempt: async (p: { runId: string; adapterId: string; outcome: string }) => {
      rec().parserAttempts.push({ runId: p.runId, adapterId: p.adapterId, outcome: p.outcome });
    },
    recordMaskingSummary: async () => {},
    recordAiCompletionAttempt: async () => ({ id: 'attempt-1' }),
    recordSchemaValidationResult: async () => {},
    recordFieldCandidates: async () => {},
    recordReconciliationRuns: async (p: { runId: string; results: { ruleId: string; outcome: string }[] }) => {
      const results = p.results.map((r) => ({ ruleId: r.ruleId, outcome: r.outcome }));
      rec().reconciliationRuns.push({ runId: p.runId, results });
      // The acceptance gate re-reads the LATEST outcomes from the database
      // rather than trusting anything the intake request computed — so the
      // fake database has to actually hold them.
      state().reconciliationOutcomes = results;
    },
    // --- acceptance-gate reads, backed by the same fake state -------------
    getRunForUser: async (runId: string, userId: string) =>
      runId === RUN_ID && userId === USER_ID
        ? { id: RUN_ID, intakeId: INTAKE_ID, userId: USER_ID, status: state().runStatus, aiUsed: false, startedAt: new Date().toISOString() }
        : null,
    getAdapterIdForRun: async () => rec().parserAttempts.at(-1)?.adapterId ?? null,
    getIntakeUploadMetadata: async () => ({ storageKey: `${USER_ID}/${INTAKE_ID}/${INTAKE_ID}.bin`, declaredMimeType: 'application/pdf', displayFilename: 'statement.pdf' }),
    getFdhBankUploadMetadata: async () => ({ country_code: 'AU', currency_code: 'AUD' }),
    findCommittedFdhBankWriteForRun: async () => null,
    countItemsBlockingAcceptanceForRun: async () => state().blockingItemCount,
    latestReconciliationOutcomesForRun: async () => state().reconciliationOutcomes,
    listFieldCandidatesForRun: async () => [],
    listLatestCorrectionsForRun: async () => [],
    findOrCreateWriteBatch: async () => ({ id: 'outer-batch-1', status: state().writeBatchStatus }),
    markWriteBatchStatus: async (_id: string, status: 'pending' | 'committed' | 'failed') => {
      state().writeBatchStatus = status;
    },
    transitionRunStatusCas: async (p: { runId: string; fromStatus: string; toStatus: string }) => {
      rec().runTransitions.push(p);
      if (state().runStatus !== p.fromStatus) return false; // a genuine compare-and-swap
      state().runStatus = p.toStatus;
      return true;
    },
  };
});

vi.mock('@/lib/financial-data-hub/bank-csv/repository', () => ({
  loadDedupIndexForAccount: async () => new Map(),
  loadPriorStatementDateRanges: async () => new Map(),
  loadExistingAccountsForInstitutionCurrency: async () => [],
}));

// FDH-5's OWN canonical write services, left REAL in every other respect —
// `commitFdhBankStatementImport` itself is NOT mocked, so what these two
// observation points record is a genuine attempt at a canonical FDH write.
vi.mock('@/lib/financial-data-hub/services/bankPdfUploadService', () => ({
  uploadBankPdf: async (userId: string) => {
    rec().fdhUploadBankPdfCalls.push({ userId });
    return { accountResolution: 'create', document: { id: 'fdh-statement-upload-1' } };
  },
}));

vi.mock('@/lib/financial-data-hub/services/bankPdfProcessingService', () => ({
  processBankPdfDocument: async (userId: string, documentId: string) => {
    rec().fdhProcessDocumentCalls.push({ userId, documentId });
    return { certificationStatus: 'certified', pipelineStatus: 'completed', transactionsCreated: 3 };
  },
  BankPdfProcessingError: class BankPdfProcessingError extends Error {
    code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));

// The acceptance gate's own feature flag. Reading it at all is the cheapest
// structural signal that `accept.ts` was consulted.
vi.mock('@/lib/aie/review/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aie/review/featureFlags')>();
  return {
    ...actual,
    isAieCanonicalAcceptanceEnabled: () => {
      rec().acceptanceFlagReads += 1;
      return true;
    },
  };
});

function cleanCbaStatementBytes(): Uint8Array {
  return new Uint8Array(
    buildBankPdfFixture({
      brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
      columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
      openingBalanceLine: 'Opening Balance: $1,000.00',
      transactions: [
        { date: '1 Aug 2026', description: 'CARD PURCHASE WOOLWORTHS 1234', amount: '45.20 DR', balance: '954.80' },
        { date: '3 Aug 2026', description: 'SALARY XYZ PTY LTD', amount: '500.00 CR', balance: '1,454.80' },
        { date: '5 Aug 2026', description: 'DIRECT DEBIT INSURANCE', amount: '220.24 DR', balance: '1,234.56' },
      ],
    }),
  );
}

function intakeRequest(bytes: Uint8Array): Request {
  return new Request('https://app.test/api/aie/fdh-bank/intake?country_code=AU&currency_code=AUD&filename=statement.pdf', {
    method: 'POST',
    headers: { 'content-length': String(bytes.byteLength), 'content-type': 'application/pdf' },
    body: bytes,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

const ACCEPT_PARAMS = {
  runId: RUN_ID,
  userId: USER_ID,
  acceptedByUserId: USER_ID,
  ownerHouseholdRole: 'self' as const,
  idempotencyKey: `${RUN_ID}:accept:1`,
};

describe('M12A.3 — FDH-bank intake must never create a canonical FDH record', () => {
  beforeEach(() => {
    resetRecorded();
    process.env.AIE_FDH_BANK_ADAPTER_ENABLED = 'true';
    process.env.AIE_DOCUMENT_INTAKE_ENABLED = 'true';
    process.env.AIE_ALLOW_MISSING_SIGNATURE_SCANNER = 'true';
    process.env.AIE_PILOT_COHORT_USER_IDS = USER_ID;
    // The configuration a production activation of this adapter would run in.
    // Under the OLD code this alone was enough to make intake write.
    process.env.AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED = 'true';
    process.env.AIE_REVIEW_CANONICAL_ACCEPTANCE_ENABLED = 'true';
    delete process.env.AIE_AI_FALLBACK_ENABLED;
    delete process.env.AIE_FDH_BANK_AI_FALLBACK_ENABLED;
  });

  it('a clean, fully-reconciling statement stops at awaiting_acceptance and writes NOTHING (the RED case, inverted)', async () => {
    const { POST } = await import('@/app/api/aie/fdh-bank/intake/route');
    const res = await POST(intakeRequest(cleanCbaStatementBytes()));
    const body = (await res.json()) as { data: { status: string; commit: unknown; accepted: boolean; accept_endpoint: string | null } };

    // The run reaches exactly the state that is supposed to WAIT for a user.
    expect(body.data.status).toBe('awaiting_acceptance');

    // The four observations that were TRUE under the defect are now all false.
    expect(rec().fdhUploadBankPdfCalls).toEqual([]);
    expect(rec().fdhProcessDocumentCalls).toEqual([]);
    expect(rec().writeBatchUpserts).toEqual([]);
    expect(rec().runTransitions).toEqual([]);
    expect(body.data.commit).toBeNull();
    expect(body.data.accepted).toBe(false);

    // And the response names the ONE place a write can now happen.
    expect(body.data.accept_endpoint).toBe(`/api/aie/review/runs/${RUN_ID}/accept`);

    // The quarantined binary is deliberately NOT deleted at intake: the
    // accept-time write re-fetches these exact bytes.
    expect(rec().binariesFinalized).toEqual([]);
  });

  it('the intake route no longer imports the canonical-write service at all', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync('app/api/aie/fdh-bank/intake/route.ts', 'utf8');
    // Removal, not a dormant flagged branch: a future re-introduction has to
    // be a deliberate act rather than flipping a switch.
    expect(source).not.toMatch(/^import .*commitFdhBankStatementImport/m);
    expect(source).not.toMatch(/await commitFdhBankStatementImport\(/);
  });

  it('CONTROL: a seeded running-balance break is blocked at "unresolved", and acceptance then refuses it too', async () => {
    const pdf = buildBankPdfFixture({
      brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
      columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
      transactions: [
        { date: '1 Aug 2026', description: 'CARD PURCHASE A', amount: '10.00 DR', balance: '990.00' },
        { date: '2 Aug 2026', description: 'CARD PURCHASE B', amount: '10.00 DR', balance: '9999.00' },
      ],
    });
    const { POST } = await import('@/app/api/aie/fdh-bank/intake/route');
    const res = await POST(intakeRequest(new Uint8Array(pdf)));
    const body = (await res.json()) as { data: { status: string } };

    expect(body.data.status).toBe('unresolved');
    expect(rec().fdhUploadBankPdfCalls).toEqual([]);

    // The second half of the control: even if a client called accept anyway,
    // the shared gate refuses — the run is not `awaiting_acceptance`.
    state().runStatus = 'unresolved';
    const { acceptRun } = await import('@/lib/aie/review/accept');
    const outcome = await acceptRun(ACCEPT_PARAMS);
    expect(outcome).toEqual({ ok: false, reason: 'not_ready' });
    expect(rec().fdhUploadBankPdfCalls).toEqual([]);
  });
});

describe('M12A.3 — the canonical write moved to the shared acceptance gate, it did not disappear', () => {
  beforeEach(() => {
    resetRecorded();
    process.env.AIE_FDH_BANK_ADAPTER_ENABLED = 'true';
    process.env.AIE_DOCUMENT_INTAKE_ENABLED = 'true';
    process.env.AIE_ALLOW_MISSING_SIGNATURE_SCANNER = 'true';
    process.env.AIE_PILOT_COHORT_USER_IDS = USER_ID;
    process.env.AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED = 'true';
    process.env.AIE_REVIEW_CANONICAL_ACCEPTANCE_ENABLED = 'true';
  });

  async function intakeCleanStatement() {
    const { POST } = await import('@/app/api/aie/fdh-bank/intake/route');
    const res = await POST(intakeRequest(cleanCbaStatementBytes()));
    return (await res.json()) as { data: { status: string; run_id: string } };
  }

  it('the run records the FDH-bank adapter id, which is what routes acceptance to the right write service', async () => {
    await intakeCleanStatement();
    const { FDH_BANK_STATEMENT_ADAPTER_ID } = await import('@/lib/aie/adapters/fdhBankStatement/parser');
    expect(rec().parserAttempts.at(-1)?.adapterId).toBe(FDH_BANK_STATEMENT_ADAPTER_ID);
  });

  it('an EXPLICIT accept — and only then — performs the canonical FDH write, through the full gate', async () => {
    const intake = await intakeCleanStatement();
    expect(intake.data.status).toBe('awaiting_acceptance');
    expect(rec().fdhUploadBankPdfCalls).toEqual([]); // nothing yet

    const { acceptRun } = await import('@/lib/aie/review/accept');
    const outcome = await acceptRun(ACCEPT_PARAMS);

    expect(outcome).toEqual({ ok: true, alreadyCompleted: false, statementUploadId: 'fdh-statement-upload-1' });

    // The acceptance gate was genuinely consulted this time.
    expect(rec().acceptanceFlagReads).toBe(1);
    // And the full CAS ladder ran, in order.
    expect(rec().runTransitions.map((t) => `${t.fromStatus}->${t.toStatus}`)).toEqual([
      'awaiting_acceptance->accepted',
      'accepted->write_pending',
      'write_pending->completed',
    ]);
    expect(state().runStatus).toBe('completed');

    // M12C §12 (`M2-OPEN-1`): every one of those three edges now also leaves an
    // `aie_processing_transition` row, in the same order — so the FSM audit
    // table finally records what the CAS actually did, and the user-commanded
    // edge is attributed to the user while the machine-driven ones are not.
    expect(rec().fsmTransitionAudits.map((a) => `${a.from}->${a.to}`)).toEqual([
      'awaiting_acceptance->accepted',
      'accepted->write_pending',
      'write_pending->completed',
    ]);
    expect(rec().fsmTransitionAudits.map((a) => a.actorType)).toEqual(['user', 'system', 'system']);

    // The write itself happened exactly once, at accept time, through FDH-5's
    // own unmodified services — re-fetching the SAME quarantined bytes.
    expect(rec().quarantineDownloads).toEqual([`${USER_ID}/${INTAKE_ID}/${INTAKE_ID}.bin`]);
    expect(rec().fdhUploadBankPdfCalls.length).toBe(1);
    expect(rec().fdhProcessDocumentCalls.length).toBe(1);
    expect(rec().writeBatchUpserts.map((w) => w.status)).toEqual(['pending', 'committed']);

    // Only now is the quarantine copy released.
    expect(rec().binariesFinalized).toEqual([`${USER_ID}/${INTAKE_ID}/${INTAKE_ID}.bin`]);
  });

  it('acceptance refuses a run with an open blocking item, even one whose reconciliation passed', async () => {
    await intakeCleanStatement();
    state().blockingItemCount = 1;

    const { acceptRun } = await import('@/lib/aie/review/accept');
    expect(await acceptRun(ACCEPT_PARAMS)).toEqual({ ok: false, reason: 'items_still_blocking' });
    expect(rec().fdhUploadBankPdfCalls).toEqual([]);
    expect(rec().runTransitions).toEqual([]);
  });

  it('a second accept is idempotent: one canonical write, not two', async () => {
    await intakeCleanStatement();
    const { acceptRun } = await import('@/lib/aie/review/accept');

    const first = await acceptRun(ACCEPT_PARAMS);
    expect(first.ok).toBe(true);
    const second = await acceptRun(ACCEPT_PARAMS);
    expect(second).toEqual({ ok: true, alreadyCompleted: true });

    expect(rec().fdhUploadBankPdfCalls.length).toBe(1);
    expect(rec().fdhProcessDocumentCalls.length).toBe(1);
  });
});
