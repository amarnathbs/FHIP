/**
 * M12A section 3 — FDH-BANK AIE CONTRACT.
 *
 * RED REPRODUCTION, RUN AGAINST THE CURRENT CODE BEFORE ANY FIX.
 *
 * The prior mission (M2-OPEN-6, restated in the M11 final certification
 * §6.8) recorded that `app/api/aie/fdh-bank/intake/route.ts:236-239`
 * performs a canonical FDH write inline at intake time, bypassing
 * `lib/aie/review/accept.ts` entirely — no acceptance flag, no re-read of
 * the blocking-item count, no CAS, no explicit user acceptance. No phase of
 * that mission ever touched the route, so the claim was carried forward on
 * paper. This file does not take its word for it.
 *
 * WHAT THIS DRIVES. The REAL Next.js route handler, imported and invoked
 * directly with a real `Request` (the handler's own helpers `ok`/`bad` are
 * plain `Response.json`, so no Next.js server harness is required — this is
 * a stronger reproduction than the prior mission's service-level tests
 * managed). The bytes are a REAL, genuinely valid synthetic PDF built by
 * `buildBankPdfFixture` and run through FDH-5's REAL `classifyPdf`. The
 * parser, the orchestrator, the reconciliation rule, the account-identity
 * resolution and `commitFdhBankStatementImport` itself are all REAL and
 * UNMODIFIED. Only the database, object storage and FDH-5's two terminal
 * write services are substituted — and those are substituted precisely so
 * their invocation can be observed.
 *
 * THE ENVIRONMENT MODELLED. `AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED=true` —
 * i.e. the configuration a production activation of this adapter would have
 * to run in. With the flag OFF the defect is masked (the commit call still
 * happens, but returns `atomic_import_disabled` before touching anything),
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
  auditEvents: { eventType: string }[];
}

let recorded: Recorded;

function resetRecorded() {
  recorded = {
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
    auditEvents: [],
  };
}
resetRecorded();

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    requireCountryConfirmedUser: async () => ({ user: { id: 'user-m12a', email: 'pilot@example.test' }, unauthenticated: null }),
  };
});

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ from: () => ({}) }),
}));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      upsert: async (row: { status: string; target_module: string }) => {
        recorded.writeBatchUpserts.push({ status: row.status, target_module: row.target_module });
        return { data: null, error: null };
      },
    }),
  }),
}));

vi.mock('@/lib/aie/storage', () => ({
  AIE_QUARANTINE_BUCKET: 'aie-document-quarantine',
  buildQuarantineStorageKey: (userId: string, intakeId: string) => `${userId}/${intakeId}/${intakeId}.bin`,
  uploadToQuarantine: async () => ({ ok: true }),
  downloadFromQuarantine: async () => ({ ok: false, message: 'not used by this test' }),
  deleteFromQuarantine: async () => ({ ok: true }),
  verifyQuarantineObjectAbsent: async () => true,
}));

vi.mock('@/lib/aie/audit', () => ({
  recordAieAuditEvent: async (e: { eventType: string }) => {
    recorded.auditEvents.push({ eventType: e.eventType });
  },
}));

vi.mock('@/lib/aie/db/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aie/db/repository')>();
  return {
    ...actual,
    createIntake: async () => ({ id: 'intake-m12a' }),
    updateIntakeStatus: async (p: { intakeId: string; toStatus: string; rejectionReason?: string }) => {
      recorded.intakeStatusUpdates.push(p);
      return { ok: true as const };
    },
    recordFdhBankUploadMetadata: async () => {},
    recordFingerprint: async () => {},
    existingFingerprintHashesForUser: async () => [],
    createRun: async (p: { intakeId: string; userId: string }) => {
      recorded.runsCreated.push(p);
      return { id: 'run-m12a' };
    },
    createUnresolvedItems: async (p: { runId: string; items: { reasonCode: string; severity: string }[] }) => {
      recorded.unresolvedItems.push(p);
      return p.items.map((_, i) => `item-${i}`);
    },
    recordTransition: async () => {},
    recordParserAttempt: async (p: { runId: string; adapterId: string; outcome: string }) => {
      recorded.parserAttempts.push({ runId: p.runId, adapterId: p.adapterId, outcome: p.outcome });
    },
    recordMaskingSummary: async () => {},
    recordAiCompletionAttempt: async () => ({ id: 'attempt-1' }),
    recordSchemaValidationResult: async () => {},
    recordFieldCandidates: async () => {},
    recordReconciliationRuns: async (p: { runId: string; results: { ruleId: string; outcome: string }[] }) => {
      recorded.reconciliationRuns.push({ runId: p.runId, results: p.results.map((r) => ({ ruleId: r.ruleId, outcome: r.outcome })) });
    },
    transitionRunStatusCas: async (p: { runId: string; fromStatus: string; toStatus: string }) => {
      recorded.runTransitions.push(p);
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
    recorded.fdhUploadBankPdfCalls.push({ userId });
    return { accountResolution: 'create', document: { id: 'fdh-statement-upload-1' } };
  },
}));

vi.mock('@/lib/financial-data-hub/services/bankPdfProcessingService', () => ({
  processBankPdfDocument: async (userId: string, documentId: string) => {
    recorded.fdhProcessDocumentCalls.push({ userId, documentId });
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

// The acceptance gate's own feature flag. Reading it at all is the single
// cheapest structural signal that `accept.ts` was consulted; the intake path
// never touches it.
vi.mock('@/lib/aie/review/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aie/review/featureFlags')>();
  return {
    ...actual,
    isAieCanonicalAcceptanceEnabled: () => {
      recorded.acceptanceFlagReads += 1;
      return true;
    },
  };
});

async function cleanCbaStatementBytes(): Promise<Uint8Array> {
  const pdf = buildBankPdfFixture({
    brandLines: ['Commonwealth Bank of Australia', 'Statement of Account'],
    columnHeaderLine: 'Date Transaction Details Debit Credit Balance',
    openingBalanceLine: 'Opening Balance: $1,000.00',
    transactions: [
      { date: '1 Aug 2026', description: 'CARD PURCHASE WOOLWORTHS 1234', amount: '45.20 DR', balance: '954.80' },
      { date: '3 Aug 2026', description: 'SALARY XYZ PTY LTD', amount: '500.00 CR', balance: '1,454.80' },
      { date: '5 Aug 2026', description: 'DIRECT DEBIT INSURANCE', amount: '220.24 DR', balance: '1,234.56' },
    ],
  });
  return new Uint8Array(pdf);
}

function intakeRequest(bytes: Uint8Array): Request {
  return new Request('https://app.test/api/aie/fdh-bank/intake?country_code=AU&currency_code=AUD&filename=statement.pdf', {
    method: 'POST',
    headers: { 'content-length': String(bytes.byteLength), 'content-type': 'application/pdf' },
    body: bytes,
    // Node's undici requires this for a streaming body.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

describe('M12A.3 RED — FDH-bank intake performs a canonical write with no user acceptance', () => {
  beforeEach(() => {
    resetRecorded();
    process.env.AIE_FDH_BANK_ADAPTER_ENABLED = 'true';
    process.env.AIE_DOCUMENT_INTAKE_ENABLED = 'true';
    process.env.AIE_ALLOW_MISSING_SIGNATURE_SCANNER = 'true';
    process.env.AIE_PILOT_COHORT_USER_IDS = 'user-m12a';
    // The configuration a production activation of this adapter would run in.
    process.env.AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED = 'true';
    // Both AI switches stay OFF — the defect has nothing to do with AI.
    delete process.env.AIE_AI_FALLBACK_ENABLED;
    delete process.env.AIE_FDH_BANK_AI_FALLBACK_ENABLED;
  });

  it('a clean, fully-reconciling statement reaches awaiting_acceptance AND is canonically written in the same request', async () => {
    const { POST } = await import('@/app/api/aie/fdh-bank/intake/route');
    const res = await POST(intakeRequest(await cleanCbaStatementBytes()));
    const body = (await res.json()) as { data: { status: string; commit: unknown } };

    // The run genuinely reached the state that is supposed to WAIT for a user.
    expect(body.data.status).toBe('awaiting_acceptance');

    // DEFECT 1 — FDH-5's own canonical write services were invoked during the
    // intake request itself.
    expect(recorded.fdhUploadBankPdfCalls.length).toBe(1);
    expect(recorded.fdhProcessDocumentCalls.length).toBe(1);
    expect(recorded.fdhProcessDocumentCalls[0].documentId).toBe('fdh-statement-upload-1');

    // DEFECT 2 — an `aie_write_batch` row was committed for a run nobody
    // accepted.
    expect(recorded.writeBatchUpserts.map((w) => w.status)).toEqual(['pending', 'committed']);
    expect(recorded.writeBatchUpserts.every((w) => w.target_module === 'fdh_bank')).toBe(true);

    // DEFECT 3 — the AIE-1.5 acceptance gate was never consulted: its feature
    // flag was never read, and not one of the CAS transitions it performs
    // (`awaiting_acceptance -> accepted -> write_pending -> completed`) ever
    // happened.
    expect(recorded.acceptanceFlagReads).toBe(0);
    expect(recorded.runTransitions).toEqual([]);

    // DEFECT 4 — the write result is handed straight back from intake, which
    // is how a caller could reasonably (and wrongly) believe the document is
    // already committed.
    expect(body.data.commit).toMatchObject({ committed: true, statementUploadId: 'fdh-statement-upload-1', transactionsCreated: 3 });
  });

  it('CONTROL: the same statement with a seeded running-balance break is blocked at "unresolved" and writes nothing', async () => {
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

    // This is the control that proves the observation points above are real:
    // the SAME instrumentation records zero canonical-write activity when the
    // reconciliation gate genuinely fails.
    expect(body.data.status).toBe('unresolved');
    expect(recorded.fdhUploadBankPdfCalls.length).toBe(0);
    expect(recorded.fdhProcessDocumentCalls.length).toBe(0);
    expect(recorded.writeBatchUpserts.length).toBe(0);
  });
});
