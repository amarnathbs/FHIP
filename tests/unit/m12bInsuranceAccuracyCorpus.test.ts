/**
 * M12B section 5 — INSURANCE ACCURACY CERTIFICATION.
 *
 * Drives the sealed corpus (`tests/support/buildM12bInsuranceCorpus.ts`) through
 * the REAL `/api/aie/insurance/intake` route handler and the REAL
 * `lib/aie/review/accept.ts`, and measures the result against a sealed,
 * hand-authored oracle (`scripts/m12b-insurance-certification/oracle.json`) that
 * never calls production code.
 *
 * REUSES M12A'S HARNESS UNCHANGED (`tests/support/aieAccuracyHarness.ts`). The
 * metric definitions live in that file's header, in code, so the FDH-bank and
 * Insurance reports cannot define "precision" differently. Nothing was added to
 * it and nothing was forked from it.
 *
 * WHAT IS REAL HERE: the route handler, AIE-1.1's admission/validation layer
 * over genuinely valid (and, for B07, genuinely RC4-encrypted) PDF bytes, the
 * real local PDF text extraction, the real registry sniff, AIE-1.4's real
 * deterministic parser, its real label taxonomy, its real reconciliation rule,
 * AIE-1.1's real orchestrator and state machine, the real PII masking layer,
 * the real AI gateway and its kill switch and PII guard, the real acceptance
 * gate and its CAS ladder, and AIE-1.4's real `acceptAndWriteInsuranceCandidates`
 * write gate including `insuranceSchema.safeParse`. WHAT IS SUBSTITUTED: the
 * database, object storage, the AI provider, and the terminal
 * `insurance_policies` save — the last of those substituted precisely so every
 * write attempt is observable.
 *
 * EVERY CASE IS RUN TWICE THROUGH THE LIFECYCLE: an intake, and then an
 * unconditional explicit accept attempt. That is what makes "false canonical
 * write rate" a real measurement rather than a tautology — it asks, of every
 * document in the corpus, "if a user pressed accept, would this be written?"
 * and compares the answer to what the oracle says may ever be written.
 *
 * TWO HARNESS TRAPS M12A DOCUMENTED, BOTH MIRRORED HERE:
 *  1. `vi.mock` factories are instantiated once per importer graph, so shared
 *     fake state lives on `globalThis` and is NEVER reset at module top level.
 *  2. `recordTransition` — not `transitionRunStatusCas` — is what updates
 *     `aie_extraction_run.status` in the real repository. A fake that mirrors
 *     the wrong one makes every accept return `not_ready` and the
 *     false-canonical-write rate vacuously zero.
 *
 * The numbers this file prints are the numbers in the closure report. The
 * report does not retype them; it pastes `results_table.md`.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { M12B_INSURANCE_CORPUS, CORPUS_USER_ID, buildStructurallyCorruptPdf, type InsuranceCorpusCase } from '../support/buildM12bInsuranceCorpus';
import { measureCase, measureCorpus, formatCorpusTable, formatPercent, type CaseMeasurement, type EconomicItem, type FieldObservation } from '../support/aieAccuracyHarness';

const CERT_DIR = path.resolve(__dirname, '../../scripts/m12b-insurance-certification');
const ORACLE_PATH = path.join(CERT_DIR, 'oracle.json');
const RESULTS_PATH = path.join(CERT_DIR, 'results.json');
const TABLE_PATH = path.join(CERT_DIR, 'results_table.md');

// ---------------------------------------------------------------------------
// Oracle shape (read-only; nothing here writes to the oracle).
// ---------------------------------------------------------------------------

interface OracleEconomic {
  key: string;
  amount: number;
  direction: string;
}

interface OracleCase {
  id: string;
  scenario: string;
  expectedDocumentSubClass: string | null;
  documentClassCertified: boolean;
  expectedFields: Record<string, string>;
  printedFactsNotExpectedInFields: Record<string, string>;
  expectedEconomic: OracleEconomic[];
  expectedReconciliation: Record<string, string>;
  expectedUnreadablePrintedFacts?: { label: string; reason: string }[];
  expectedPremiumTotalDelta?: number;
  terminalRunStatus: string;
  expectedPasswordRequired?: boolean;
  acceptable: boolean;
  minimumUnresolvedItemCount: number;
  expectedAiCalls: number;
  requiresMaskingKey?: boolean;
  mustNotAppearInAiPrompt?: string[];
  mustNotBeAnyFieldValue?: string[];
}

const ORACLE = JSON.parse(readFileSync(ORACLE_PATH, 'utf8')) as { corpusVersion: string; cases: OracleCase[] };
const oracleFor = (id: string): OracleCase => {
  const found = ORACLE.cases.find((c) => c.id === id);
  if (!found) throw new Error(`oracle has no case ${id}`);
  return found;
};

// ---------------------------------------------------------------------------
// Fake infrastructure. Shared state lives on `globalThis` — see this file's
// header, trap 1.
// ---------------------------------------------------------------------------

interface Recorded {
  fieldCandidates: { fieldName: string; valueRaw: string | null; isNull: boolean; sourceMethod: string }[];
  reconciliationResults: { ruleId: string; outcome: string; delta?: number | null }[];
  unresolvedItems: { reasonCode: string; severity: string }[];
  aiAttempts: number;
  aiPrompts: string[];
  aiOutcomes: string[];
  intakeStatusUpdates: { toStatus: string; rejectionReason?: string }[];
  policySaves: Record<string, unknown>[];
  binariesFinalized: string[];
  maskingSummaries: { coverageByType: Record<string, number>; belowPolicy: boolean }[];
}

interface SharedState {
  recorded: Recorded;
  runCreated: boolean;
  runStatus: string;
  blockingItemCount: number;
  reconciliationOutcomes: { ruleId: string; outcome: string }[];
  writeBatchStatus: 'pending' | 'committed' | 'failed';
  existingLink: { insurancePolicyId: string } | null;
}

const STATE_KEY = '__m12bInsuranceAccuracyState__';

function freshState(): SharedState {
  return {
    recorded: {
      fieldCandidates: [],
      reconciliationResults: [],
      unresolvedItems: [],
      aiAttempts: 0,
      aiPrompts: [],
      aiOutcomes: [],
      intakeStatusUpdates: [],
      policySaves: [],
      binariesFinalized: [],
      maskingSummaries: [],
    },
    runCreated: false,
    runStatus: 'none',
    blockingItemCount: 0,
    reconciliationOutcomes: [],
    writeBatchStatus: 'pending',
    existingLink: null,
  };
}

function state(): SharedState {
  const g = globalThis as unknown as Record<string, SharedState | undefined>;
  if (!g[STATE_KEY]) g[STATE_KEY] = freshState();
  return g[STATE_KEY]!;
}
const rec = () => state().recorded;

const RUN_ID = 'run-insurance-corpus';
const INTAKE_ID = 'intake-insurance-corpus';
const STORAGE_KEY = `${CORPUS_USER_ID}/${INTAKE_ID}/${INTAKE_ID}.bin`;

function resetState() {
  (globalThis as unknown as Record<string, SharedState>)[STATE_KEY] = freshState();
}

vi.mock('@/lib/services/appCapability', () => ({
  requireModuleCapability: async () => ({ user: { id: CORPUS_USER_ID }, blocked: null, decision: null }),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ from: () => ({}) }) }));

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => ({
      upsert: async () => ({ data: null, error: null }),
      insert: async () => ({ error: null }),
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
    // The AI cost ledger. Left ADMITTING rather than refusing, deliberately —
    // a fake that refused every reservation would block the B05/B13 provider
    // calls for a reason that has nothing to do with the property under test,
    // and those cases would then "pass" their zero-egress assertions while
    // proving nothing. (M12A hit exactly this and recorded it.)
    rpc: async (fn: string) => {
      if (fn === 'aie_reserve_ai_cost') return { data: [{ reserved: true, remaining_usd: 10 }], error: null };
      return { data: null, error: null };
    },
  }),
}));

vi.mock('@/lib/aie/storage', () => ({
  AIE_QUARANTINE_BUCKET: 'aie-document-quarantine',
  buildQuarantineStorageKey: (userId: string, intakeId: string) => `${userId}/${intakeId}/${intakeId}.bin`,
  uploadToQuarantine: async () => ({ ok: true }),
  downloadFromQuarantine: async () => ({ ok: false as const, message: 'insurance never re-fetches the binary — its write is candidate-based' }),
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
          // The adapter's own closed-enum schema is what decides whether this
          // is acceptable — the mock deliberately returns an EMPTY fields
          // array rather than inventing a policy name, because a corpus that
          // scripted the AI into supplying the missing value would be
          // measuring the script, not the system.
          return JSON.stringify({ fields: [] });
        },
      }),
  };
});

// The insurance_policies save is substituted so every canonical write attempt
// is observable. `insuranceSchema.safeParse` upstream of it is NOT substituted.
vi.mock('@/lib/services/registry', () => ({
  makeRegistry: () => ({
    save: async (_userId: string, row: Record<string, unknown>) => {
      rec().policySaves.push(row);
      return { data: { id: `policy-${rec().policySaves.length}` }, error: null };
    },
  }),
}));

vi.mock('@/lib/aie/db/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aie/db/repository')>();
  return {
    ...actual,
    createIntake: async () => ({ id: INTAKE_ID }),
    updateIntakeStatus: async (p: { toStatus: string; rejectionReason?: string }) => {
      rec().intakeStatusUpdates.push({ toStatus: p.toStatus, rejectionReason: p.rejectionReason });
      return { ok: true as const };
    },
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
    // See this file's header, trap 2: recordTransition is what actually
    // UPDATES aie_extraction_run.status in the real repository
    // (repository.ts:267), so the fake mirrors it.
    recordTransition: async (p: { toState: string }) => {
      state().runStatus = p.toState;
    },
    recordParserAttempt: async () => {},
    recordMaskingSummary: async (p: { coverageByType: Record<string, number>; belowPolicy: boolean }) => {
      rec().maskingSummaries.push({ coverageByType: p.coverageByType, belowPolicy: p.belowPolicy });
    },
    recordAiCompletionAttempt: async (p: { outcome: string }) => {
      rec().aiAttempts += 1;
      rec().aiOutcomes.push(p.outcome);
      return { id: 'attempt-1' };
    },
    recordSchemaValidationResult: async () => {},
    recordFieldCandidates: async (p: { candidates: Recorded['fieldCandidates'] }) => {
      rec().fieldCandidates.push(...p.candidates);
    },
    recordReconciliationRuns: async (p: { results: { ruleId: string; outcome: string; delta?: number | null }[] }) => {
      rec().reconciliationResults.push(...p.results);
      state().reconciliationOutcomes = p.results.map((r) => ({ ruleId: r.ruleId, outcome: r.outcome }));
    },
    getRunForUser: async () =>
      state().runCreated ? { id: RUN_ID, intakeId: INTAKE_ID, userId: CORPUS_USER_ID, status: state().runStatus, aiUsed: false, startedAt: new Date().toISOString() } : null,
    getAdapterIdForRun: async () => 'insurance_generic_schedule_v1',
    getIntakeUploadMetadata: async () => ({ storageKey: STORAGE_KEY, declaredMimeType: 'application/pdf', displayFilename: 'policy.pdf' }),
    getFdhBankUploadMetadata: async () => null,
    findCommittedFdhBankWriteForRun: async () => null,
    countItemsBlockingAcceptanceForRun: async () => state().blockingItemCount,
    latestReconciliationOutcomesForRun: async () => state().reconciliationOutcomes,
    listFieldCandidatesForRun: async () => rec().fieldCandidates,
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

// ---------------------------------------------------------------------------
// Driving the real lifecycle.
// ---------------------------------------------------------------------------

function intakeRequest(c: InsuranceCorpusCase, bytes: Uint8Array): Request {
  const q = new URLSearchParams({ filename: c.filename });
  return new Request(`https://app.test/api/aie/insurance/intake?${q.toString()}`, {
    method: 'POST',
    headers: { 'content-length': String(bytes.byteLength), 'content-type': 'application/pdf' },
    body: bytes,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

interface LifecycleObservation {
  finalStatus: string;
  rejectionReason: string | null;
  passwordRequired: boolean;
  intakeThrew: string | null;
  acceptOutcome: { ok: boolean; reason?: string };
  writesDuringIntake: number;
  writesAfterAccept: number;
}

async function runLifecycle(c: InsuranceCorpusCase, bytes: Uint8Array, opts: { attemptAccept: boolean } = { attemptAccept: true }): Promise<LifecycleObservation> {
  const { POST } = await import('@/app/api/aie/insurance/intake/route');
  let finalStatus = 'threw';
  let rejectionReason: string | null = null;
  let passwordRequired = false;
  let intakeThrew: string | null = null;
  try {
    const res = await POST(intakeRequest(c, bytes));
    const body = (await res.json()) as { data?: { status?: string; failure_code?: string; password_required?: boolean }; error?: string };
    finalStatus = body.data?.status ?? `http_error:${body.error ?? 'unknown'}`;
    rejectionReason = body.data?.failure_code ?? null;
    passwordRequired = body.data?.password_required === true;
  } catch (e) {
    intakeThrew = e instanceof Error ? e.message.slice(0, 220) : 'unknown';
  }
  const writesDuringIntake = rec().policySaves.length;

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
    passwordRequired,
    intakeThrew,
    acceptOutcome,
    writesDuringIntake,
    writesAfterAccept: rec().policySaves.length - writesDuringIntake,
  };
}

// ---------------------------------------------------------------------------
// Turning what the system recorded into the harness's vocabulary.
// ---------------------------------------------------------------------------

function candidateValue(fieldName: string): string | null | undefined {
  const found = rec().fieldCandidates.find((c) => c.fieldName === fieldName);
  if (!found) return undefined;
  return found.isNull ? null : found.valueRaw;
}

/**
 * The one field excluded from the precision/recall metric, and the exclusion is
 * argued rather than convenient. `unreadablePrintedFactEvidence` is a JSON blob
 * whose exact serialisation is an implementation detail; pinning it in the
 * oracle would make the oracle agree with the code's formatting rather than
 * with the document, which is the one thing a sealed oracle must never do. Its
 * CONTENT is not unchecked — the oracle states which labels must appear in it
 * and the driver asserts that directly (invariant 11), and the semantic
 * `unreadablePrintedFactCount` stays fully inside the metric.
 */
const FIELD_EXCLUDED_FROM_METRIC = 'unreadablePrintedFactEvidence';

/** Every field the system ASSERTED, in the harness's vocabulary. The
 * denominator of precision is what the system asserted, so this must be the
 * complete asserted set — not a curated subset. */
function observedFields(): FieldObservation[] {
  const seen = new Set<string>();
  const out: FieldObservation[] = [];
  for (const c of rec().fieldCandidates) {
    if (c.fieldName === FIELD_EXCLUDED_FROM_METRIC) continue;
    if (seen.has(c.fieldName)) continue;
    seen.add(c.fieldName);
    out.push({ fieldName: c.fieldName, value: c.isNull ? null : c.valueRaw });
  }
  return out;
}

/** The labels the adapter reported it could not read, parsed back out of the
 * evidence candidate. Never a guess at what they meant — a label and a reason. */
function observedUnreadableFacts(): { label: string; reason: string }[] {
  const raw = candidateValue(FIELD_EXCLUDED_FROM_METRIC);
  if (raw === undefined || raw === null) return [];
  return JSON.parse(raw) as { label: string; reason: string }[];
}

function expectedFields(o: OracleCase): FieldObservation[] {
  return Object.entries(o.expectedFields).map(([fieldName, value]) => ({ fieldName, value }));
}

/**
 * The money the system actually asserts. An insurance run asserts exactly one
 * cover amount and one premium, because the canonical row holds one of each —
 * which is precisely why a document printing two of either has to be FLAGGED
 * rather than quietly reduced to the first.
 */
function observedEconomic(): EconomicItem[] {
  const out: EconomicItem[] = [];
  const cover = candidateValue('coverAmount');
  if (cover !== undefined && cover !== null) out.push({ key: 'cover:1', date: null, amount: Number(cover), direction: 'cover', balance: null });
  const premium = candidateValue('premium');
  if (premium !== undefined && premium !== null) out.push({ key: 'premium:1', date: null, amount: Number(premium), direction: 'premium', balance: null });
  return out;
}

const toEconomic = (e: OracleEconomic): EconomicItem => ({ key: e.key, date: null, amount: e.amount, direction: e.direction, balance: null });

/**
 * WHAT COUNTS AS THE SYSTEM ACCOUNTING FOR MISSING MONEY. Deliberately narrow,
 * and identical in substance to M12A's rule: the run must have refused the
 * document outright, or stopped short of an acceptable state with a blocking
 * item raised, or crashed rather than returning a clean answer. A run that
 * reaches `awaiting_acceptance` has accounted for nothing, however good its
 * reasons — from the user's side it is a document ready to be written.
 */
function omissionsAccountedFor(o: OracleCase, obs: LifecycleObservation, observedKeys: Set<string>): string[] {
  const blocked = obs.finalStatus === 'rejected' || obs.finalStatus === 'unresolved' || obs.finalStatus === 'privacy_blocked' || obs.finalStatus === 'quarantined' || obs.intakeThrew !== null;
  if (!blocked) return [];
  return o.expectedEconomic.map((e) => e.key).filter((k) => !observedKeys.has(k));
}

// ---------------------------------------------------------------------------

const measurements: CaseMeasurement[] = [];
const oracleAcceptableFlags: boolean[] = [];
const perCaseEvidence: Record<string, unknown> = {};

describe('M12B.5 — Insurance accuracy certification against a sealed corpus', () => {
  beforeEach(() => {
    resetState();
    process.env.AIE_INSURANCE_ADAPTER_ENABLED = 'true';
    process.env.AIE_DOCUMENT_INTAKE_ENABLED = 'true';
    process.env.AIE_ALLOW_MISSING_SIGNATURE_SCANNER = 'true';
    process.env.AIE_PILOT_COHORT_USER_IDS = CORPUS_USER_ID;
    process.env.AIE_REVIEW_CANONICAL_ACCEPTANCE_ENABLED = 'true';
    process.env.AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED = 'true';
    delete process.env.AIE_AI_FALLBACK_ENABLED;
    delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
  });

  for (const c of M12B_INSURANCE_CORPUS) {
    it(`${c.id} — ${c.title}`, async () => {
      const o = oracleFor(c.id);

      // B05 and B13 are the two cases that reach the masking stage. They are
      // run under an EPHEMERAL, in-process key so the deterministic invariants
      // can still be measured; the unset-key behaviour — the environment as it
      // actually stands — is proved separately below, and is why these cases
      // are reported CONDITIONAL rather than PASS.
      if (o.requiresMaskingKey) {
        process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'a1'.repeat(32);
        process.env.AIE_AI_FALLBACK_ENABLED = 'true';
      }

      const obs = await runLifecycle(c, c.bytes());
      const observed = observedEconomic();
      // Economic keys are authored as strings on both sides (the harness's
      // `EconomicItem.key` is deliberately `string | number` so FDH-bank can
      // key on a row number); narrowed here so the comparison cannot silently
      // become string-vs-number.
      const observedKeys = new Set(observed.map((e) => String(e.key)));

      const measurement = measureCase({
        caseId: c.id,
        scenario: o.scenario,
        expectedFields: expectedFields(o),
        observedFields: observedFields(),
        expectedEconomic: o.expectedEconomic.map(toEconomic),
        observedEconomic: observed,
        omissionsAccountedFor: omissionsAccountedFor(o, obs, observedKeys),
        oracleAcceptable: o.acceptable,
        observedAcceptable: obs.finalStatus === 'awaiting_acceptance',
        canonicalWriteOccurred: obs.writesDuringIntake + obs.writesAfterAccept > 0,
        explicitAcceptPerformed: obs.acceptOutcome.ok,
      });
      measurements.push(measurement);
      oracleAcceptableFlags.push(o.acceptable);
      perCaseEvidence[c.id] = {
        observedTerminalStatus: obs.finalStatus,
        observedRejectionReason: obs.rejectionReason,
        passwordRequired: obs.passwordRequired,
        intakeThrew: obs.intakeThrew,
        acceptOutcome: obs.acceptOutcome,
        canonicalWritesDuringIntake: obs.writesDuringIntake,
        canonicalWritesAfterExplicitAccept: obs.writesAfterAccept,
        aiCompletionAttempts: rec().aiAttempts,
        aiOutcomes: rec().aiOutcomes,
        maskingSummaries: rec().maskingSummaries,
        unresolvedItems: rec().unresolvedItems,
        reconciliationResults: rec().reconciliationResults,
        intakeStatusUpdates: rec().intakeStatusUpdates,
        binariesFinalized: rec().binariesFinalized,
        canonicalRowsWritten: rec().policySaves,
      };

      // --- Per-case invariants the corpus exists to enforce ------------------

      // 1. No canonical write ever happens at intake, for any document. (The
      //    Insurance route removed its intake-time self-accept before M12A;
      //    this asserts that it stayed removed.)
      expect(obs.writesDuringIntake).toBe(0);

      // 2. A document the oracle says may never be written is never written,
      //    even when acceptance is explicitly attempted.
      if (!o.acceptable) {
        expect(obs.writesAfterAccept).toBe(0);
        expect(obs.acceptOutcome.ok).toBe(false);
      }

      // 3. AI is consulted exactly where the oracle says, and nowhere else.
      expect(rec().aiAttempts).toBe(o.expectedAiCalls);

      // 4. Nothing the oracle forbids in an AI prompt ever reaches the provider.
      if (o.mustNotAppearInAiPrompt) {
        expect(rec().aiPrompts.length).toBeGreaterThan(0);
        for (const prompt of rec().aiPrompts) {
          for (const forbidden of o.mustNotAppearInAiPrompt) expect(prompt).not.toContain(forbidden);
        }
      }

      // 5. An injected, money-shaped figure never becomes a field value.
      if (o.mustNotBeAnyFieldValue) {
        for (const f of rec().fieldCandidates) {
          for (const forbidden of o.mustNotBeAnyFieldValue) expect(f.valueRaw ?? '').not.toBe(forbidden);
        }
      }

      // 6. No unexplained economic omission, anywhere in the corpus.
      expect(measurement.unexplainedOmissions).toEqual([]);

      // 7. Field agreement with the oracle, disagreements named.
      expect(measurement.fieldDisagreements).toEqual([]);

      // 8. The observed terminal state is the one the oracle demands.
      expect(obs.finalStatus).toBe(o.terminalRunStatus);
      if (o.expectedPasswordRequired) expect(obs.passwordRequired).toBe(true);

      // 9. The reconciliation rules produced exactly the outcomes the oracle
      //    derived independently from the printed document.
      if (Object.keys(o.expectedReconciliation).length > 0) {
        for (const [ruleId, outcome] of Object.entries(o.expectedReconciliation)) {
          const actual = rec().reconciliationResults.find((r) => r.ruleId === ruleId);
          expect(actual, `expected reconciliation rule ${ruleId} to have run`).toBeDefined();
          expect(actual!.outcome, `rule ${ruleId}`).toBe(outcome);
        }
      }
      if (o.expectedPremiumTotalDelta !== undefined) {
        expect(rec().reconciliationResults.find((r) => r.ruleId === 'insurance_premium_totals_reconciled')?.delta).toBeCloseTo(o.expectedPremiumTotalDelta, 6);
      }

      // 10. A document that must not be accepted is genuinely blocked with at
      //     least one item a reviewer can act on — never merely "not accepted".
      expect(rec().unresolvedItems.filter((i) => i.severity === 'blocking').length).toBeGreaterThanOrEqual(o.minimumUnresolvedItemCount);

      // 11. Every printed fact the adapter could not read is NAMED, and only
      //     the ones the oracle says are genuinely unreadable. A reason code is
      //     asserted alongside each label so "we could not read it" cannot
      //     degrade into an unexplained flag.
      if (o.expectedUnreadablePrintedFacts !== undefined) {
        expect(observedUnreadableFacts()).toEqual(o.expectedUnreadablePrintedFacts);
      }
    });
  }

  it('CONTROL — a structurally corrupt PDF is refused, with nothing extracted and nothing written', async () => {
    const c = M12B_INSURANCE_CORPUS[0];
    const obs = await runLifecycle(c, buildStructurallyCorruptPdf());
    expect(obs.finalStatus).toBe('rejected');
    expect(rec().fieldCandidates).toEqual([]);
    expect(obs.writesDuringIntake + obs.writesAfterAccept).toBe(0);
    perCaseEvidence['CONTROL-corrupt-pdf'] = {
      observedTerminalStatus: obs.finalStatus,
      observedRejectionReason: obs.rejectionReason,
      intakeStatusUpdates: rec().intakeStatusUpdates,
    };
  });

  it('INS-B01 idempotency — a second explicit accept writes once, not twice', async () => {
    const c = M12B_INSURANCE_CORPUS[0];
    const obs = await runLifecycle(c, c.bytes());
    expect(obs.acceptOutcome.ok).toBe(true);
    expect(rec().policySaves.length).toBe(1);

    const { acceptRun } = await import('@/lib/aie/review/accept');
    const second = await acceptRun({
      runId: RUN_ID,
      userId: CORPUS_USER_ID,
      acceptedByUserId: CORPUS_USER_ID,
      ownerHouseholdRole: 'self',
      idempotencyKey: `${RUN_ID}:accept:1`,
    });
    expect(second).toEqual({ ok: true, alreadyCompleted: true });
    expect(rec().policySaves.length).toBe(1);
    perCaseEvidence['INS-B01-idempotent-replay'] = { secondAccept: second, canonicalWrites: rec().policySaves.length };
  });

  it('INS-B05/B13 CONDITIONAL — with AIE_MASK_TOKEN_ENCRYPTION_KEY unset (this environment), a missing-policy-name run cannot reach the AI fallback', async () => {
    // No key. No workaround. This is the environment as it actually stands.
    expect(process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY).toBeUndefined();

    const evidence: Record<string, unknown> = {};
    for (const id of ['INS-B05', 'INS-B13']) {
      resetState();
      const c = M12B_INSURANCE_CORPUS.find((x) => x.id === id)!;
      const obs = await runLifecycle(c, c.bytes(), { attemptAccept: false });
      evidence[id] = {
        observedTerminalStatus: obs.finalStatus,
        intakeThrew: obs.intakeThrew,
        canonicalWrites: obs.writesDuringIntake,
        aiCompletionAttempts: rec().aiAttempts,
        unresolvedItems: rec().unresolvedItems,
      };
      // Whatever the shape of the failure, these three must hold: nothing is
      // written, no AI call is made, and the run never becomes acceptable.
      expect(obs.writesDuringIntake).toBe(0);
      expect(rec().aiAttempts).toBe(0);
      expect(obs.finalStatus).not.toBe('awaiting_acceptance');
    }
    perCaseEvidence['MASKING-KEY-UNSET'] = {
      ...evidence,
      note: 'AIE_MASK_TOKEN_ENCRYPTION_KEY is unset in this environment and is a Product-Owner/operator-owned blocker; no workaround was attempted and no key was provisioned.',
    };
  });

  afterAll(() => {
    mkdirSync(CERT_DIR, { recursive: true });
    const corpus = measureCorpus(measurements, oracleAcceptableFlags);
    const payload = {
      corpusVersion: ORACLE.corpusVersion,
      generatedBy: 'tests/unit/m12bInsuranceAccuracyCorpus.test.ts',
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
