/**
 * M3 (Phase 4) — the Investment Intelligence dispatch service, end to end.
 *
 * Covers items I.1 (the real path exists and runs), I.2 (source-document
 * identity), I.3 (certified deterministic parsers stay Level 1), I.5
 * (deterministic reconciliation after extraction), I.9 (no canonical write
 * happens here) and I.10/I.11 (binary lifecycle).
 *
 * WHY THIS DRIVES THE REAL SERVICE RATHER THAN THE ROUTE HANDLER. The route
 * is a thin authentication/admission shell around `dispatchInvestmentDocument`,
 * and Next.js route handlers are not directly invocable in this repository's
 * `node`-environment Vitest setup without a request/response harness that
 * does not exist here. The service is where every property under test lives,
 * it is driven with REAL PDF BYTES through the REAL pdf-parse extraction and
 * the REAL certified parsers, and only the database and object storage are
 * substituted. What is NOT substituted is the thing being asserted.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { buildMinimalTextPdf } from '../support/buildMinimalPdf';
import { buildEncryptedTextPdf } from '../support/buildEncryptedCamsPdf';
import { C1_CAS_BASELINE, C10_RECONCILIATION_FAILURE, C11_UNSUPPORTED, C7_SAME_INSTRUMENT_TWO_FOLIOS } from '../support/buildM3InvestmentCorpus';

// ---------------------------------------------------------------------------
// Fakes. Deliberately minimal: enough shape for the real code's real queries,
// with every write recorded so the tests can assert what was and was not
// written.
// ---------------------------------------------------------------------------

interface Recorded {
  runsCreated: { intakeId: string; userId: string }[];
  unresolvedItems: { runId: string; items: { reasonCode: string; severity: string }[] }[];
  reconciliationRuns: { runId: string; results: { ruleId: string; outcome: string }[] }[];
  intakeStatusUpdates: { intakeId: string; toStatus: string; rejectionReason?: string }[];
  auditEvents: { eventType: string; metadata?: Record<string, unknown> }[];
  storageDeletes: string[];
  runTransitions: { runId: string; fromStatus: string; toStatus: string }[];
}

let recorded: Recorded;
let quarantineBytes: Uint8Array;
let downloadShouldFail = false;

function emptyTableQuery() {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: null }),
    range: async () => ({ data: [], error: null }),
    then: (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null }),
  };
  return builder;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => emptyTableQuery(),
  }),
}));

vi.mock('@/lib/aie/storage', () => ({
  AIE_QUARANTINE_BUCKET: 'aie-document-quarantine',
  buildQuarantineStorageKey: (userId: string, intakeId: string) => `${userId}/${intakeId}/${intakeId}.bin`,
  downloadFromQuarantine: async () => (downloadShouldFail ? { ok: false, message: 'object missing' } : { ok: true, bytes: quarantineBytes }),
  deleteFromQuarantine: async (key: string) => {
    recorded.storageDeletes.push(key);
    return { ok: true };
  },
  verifyQuarantineObjectAbsent: async () => true,
  uploadToQuarantine: async () => ({ ok: true }),
}));

vi.mock('@/lib/aie/db/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aie/db/repository')>();
  return {
    ...actual,
    createRun: async (p: { intakeId: string; userId: string }) => {
      recorded.runsCreated.push(p);
      return { id: `run-for-${p.intakeId}` };
    },
    createUnresolvedItems: async (p: { runId: string; items: { reasonCode: string; severity: string }[] }) => {
      recorded.unresolvedItems.push(p);
      return p.items.map((_, i) => `item-${p.runId}-${i}`);
    },
    recordReconciliationRuns: async (p: { runId: string; results: { ruleId: string; outcome: string }[] }) => {
      recorded.reconciliationRuns.push(p);
    },
    updateIntakeStatus: async (p: { intakeId: string; toStatus: string; rejectionReason?: string }) => {
      recorded.intakeStatusUpdates.push(p);
      return { ok: true as const };
    },
    recordTransition: async () => {},
    transitionRunStatusCas: async (p: { runId: string; fromStatus: string; toStatus: string }) => {
      recorded.runTransitions.push(p);
      return true;
    },
    recordParserAttempt: async () => {},
    recordMaskingSummary: async () => {},
    recordAiCompletionAttempt: async () => ({ id: 'attempt-1' }),
    recordSchemaValidationResult: async () => {},
    recordFieldCandidates: async () => {},
  };
});

vi.mock('@/lib/aie/audit', () => ({
  recordAieAuditEvent: async (e: { eventType: string; metadata?: Record<string, unknown> }) => {
    recorded.auditEvents.push(e);
  },
}));

import { dispatchInvestmentDocument } from '@/lib/aie/adapters/investment-intelligence/dispatch';
import { createDefaultDeps } from '@/lib/aie/orchestrator';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';

function pdfFor(text: string): Uint8Array {
  return new Uint8Array(buildMinimalTextPdf([text.split('\n')]));
}

/** The AI kill switch is OFF here, which is the production default. The
 * certified deterministic parsers declare no AI-eligible gap for a clean
 * fixture anyway, so no AI call can occur on any of these paths — asserted
 * explicitly below rather than assumed. */
function deps() {
  return createDefaultDeps(new AieDocumentAiGateway(new MockAieProvider({ respond: () => '{}' }), { isKillSwitchEnabled: () => false }));
}

beforeAll(() => {
  process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = 'a1'.repeat(32);
});

beforeEach(() => {
  recorded = { runsCreated: [], unresolvedItems: [], reconciliationRuns: [], intakeStatusUpdates: [], auditEvents: [], storageDeletes: [], runTransitions: [] };
  downloadShouldFail = false;
  quarantineBytes = pdfFor(C1_CAS_BASELINE.text);
});

describe('M3 I.1 — the real Investment Intelligence dispatch path', () => {
  it('runs a CAS baseline end to end and produces a run, with the certified parser having claimed the document', async () => {
    const outcome = await dispatchInvestmentDocument({
      intakeId: 'intake-1',
      userId: 'user-1',
      storageKey: 'user-1/intake-1/intake-1.bin',
      countryCode: 'IN',
      ownerMemberId: 'member-1',
      deps: deps(),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.runId).toBe('run-for-intake-1');
    // I.3: a certified deterministic parser claimed it, and is named.
    expect(outcome.parserCode).toBe('cams_detailed_v1');
    expect(outcome.certifiedDocumentClass).toBe(true);
    expect(outcome.candidateCount).toBeGreaterThan(0);
  });

  it('I.3: ZERO AI calls occur on a clean fixture — the deterministic path is genuinely Level 1, not a formality', async () => {
    const outcome = await dispatchInvestmentDocument({
      intakeId: 'intake-1',
      userId: 'user-1',
      storageKey: 'k',
      countryCode: 'IN',
      ownerMemberId: 'member-1',
      deps: deps(),
    });
    expect(outcome.ok && outcome.aiWasUsed).toBe(false);
  });

  it('I.5: deterministic reconciliation runs and is RECORDED, so the acceptance gate has something real to re-check', async () => {
    await dispatchInvestmentDocument({ intakeId: 'intake-1', userId: 'user-1', storageKey: 'k', countryCode: 'IN', ownerMemberId: 'member-1', deps: deps() });
    const recon = recorded.reconciliationRuns.flatMap((r) => r.results);
    expect(recon.length).toBeGreaterThan(0);
    // The adapter's own rules ran — not the generic "no domain adapter"
    // placeholder, which `accept.ts` explicitly refuses as "a document
    // nothing ever actually checked".
    expect(recon.some((r) => r.ruleId.startsWith('ii_adapter_'))).toBe(true);
    expect(recon.some((r) => r.ruleId === 'aie1_1_no_domain_adapter_registered')).toBe(false);
  });

  it('refuses a document no certified parser claims, rather than handing an unknown layout to an AI fallback', async () => {
    quarantineBytes = pdfFor(C11_UNSUPPORTED.text + '\n'.repeat(3) + 'padding line to satisfy the minimum extractable text threshold for this fixture');
    const outcome = await dispatchInvestmentDocument({ intakeId: 'intake-2', userId: 'user-1', storageKey: 'k', countryCode: 'IN', ownerMemberId: 'member-1', deps: deps() });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('not_an_investment_document');
    // No run is created for a document that was never processed.
    expect(recorded.runsCreated).toHaveLength(0);
    expect(recorded.intakeStatusUpdates.some((u) => u.toStatus === 'rejected')).toBe(true);
  });

  it('a failed reconciliation blocks the run at "unresolved" and never reports awaiting_acceptance', async () => {
    quarantineBytes = pdfFor(C10_RECONCILIATION_FAILURE.text);
    const outcome = await dispatchInvestmentDocument({ intakeId: 'intake-3', userId: 'user-1', storageKey: 'k', countryCode: 'IN', ownerMemberId: 'member-1', deps: deps() });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.finalStatus).toBe('unresolved');
    expect(outcome.unresolvedItemIds.length).toBeGreaterThan(0);
  });

  it('a multi-folio document keeps its positions SEPARATE (PC4-INV-07\'s account-scoped FIFO depends on it)', async () => {
    quarantineBytes = pdfFor(C7_SAME_INSTRUMENT_TWO_FOLIOS.text);
    const outcome = await dispatchInvestmentDocument({ intakeId: 'intake-4', userId: 'user-1', storageKey: 'k', countryCode: 'IN', ownerMemberId: 'member-1', deps: deps() });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Two folios, same scheme — must not be collapsed into one position.
    expect(outcome.candidateCount).toBeGreaterThan(2);
  });
});

describe('M3 I.2 — source-document identity is the immutable intake id, never a reusable storage path', () => {
  it('two documents with the SAME filename and DIFFERENT bytes process as two distinct documents', async () => {
    // The dispatch's own named test case. `storageKey` is used only to fetch
    // bytes; identity is `intakeId`, a server-generated UUID.
    quarantineBytes = pdfFor(C1_CAS_BASELINE.text);
    const first = await dispatchInvestmentDocument({ intakeId: 'intake-A', userId: 'user-1', storageKey: 'user-1/intake-A/intake-A.bin', countryCode: 'IN', ownerMemberId: 'm', deps: deps() });

    quarantineBytes = pdfFor(C10_RECONCILIATION_FAILURE.text);
    const second = await dispatchInvestmentDocument({ intakeId: 'intake-B', userId: 'user-1', storageKey: 'user-1/intake-B/intake-B.bin', countryCode: 'IN', ownerMemberId: 'm', deps: deps() });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.runId).not.toBe(second.runId);
    expect(recorded.runsCreated.map((r) => r.intakeId)).toEqual(['intake-A', 'intake-B']);
    // Each action processed exactly the intended document: A reconciled, B
    // did not.
    expect(second.finalStatus).toBe('unresolved');
  });

  it('the storage key is derived from two UUIDs, so the same filename cannot produce a colliding object', async () => {
    const { buildQuarantineStorageKey } = await import('@/lib/aie/storage');
    const a = buildQuarantineStorageKey('user-1', 'intake-A');
    const b = buildQuarantineStorageKey('user-1', 'intake-B');
    expect(a).not.toBe(b);
    // And it contains no filename component at all, so a user-supplied name
    // can never influence object identity (UPL-08).
    expect(a).not.toMatch(/\.pdf$/i);
  });

  it('processing is keyed by intake id — the run created belongs to the intake that was asked for', async () => {
    await dispatchInvestmentDocument({ intakeId: 'intake-XYZ', userId: 'user-1', storageKey: 'anything', countryCode: 'IN', ownerMemberId: 'm', deps: deps() });
    expect(recorded.runsCreated).toHaveLength(1);
    expect(recorded.runsCreated[0]).toMatchObject({ intakeId: 'intake-XYZ', userId: 'user-1' });
  });
});

describe('M3 — password-protected statements (I.1 "decrypt if needed", I.12 scenario)', () => {
  const PASSWORD = 'm3-test-pass';

  beforeEach(() => {
    quarantineBytes = new Uint8Array(buildEncryptedTextPdf([C1_CAS_BASELINE.text.split('\n')], PASSWORD).bytes);
  });

  it('with NO password: typed `password_required`, the document stays unprocessed, and NO run is created', async () => {
    const outcome = await dispatchInvestmentDocument({ intakeId: 'intake-p1', userId: 'user-1', storageKey: 'k', countryCode: 'IN', ownerMemberId: 'm', deps: deps() });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('password_required');
    // PC4-INV-17's "failed attempts create no canonical rows", preserved on
    // this new surface.
    expect(recorded.runsCreated).toHaveLength(0);
  });

  it('with the WRONG password: typed `wrong_password`, distinguished by EXCEPTION TYPE, never by string-matching a message', async () => {
    const outcome = await dispatchInvestmentDocument({ intakeId: 'intake-p2', userId: 'user-1', storageKey: 'k', countryCode: 'IN', ownerMemberId: 'm', password: 'not-the-password', deps: deps() });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('wrong_password');
    expect(recorded.runsCreated).toHaveLength(0);
  });

  it('with the CORRECT password: the document decrypts and yields the IDENTICAL economic result as the unencrypted original', async () => {
    const encrypted = await dispatchInvestmentDocument({ intakeId: 'intake-p3', userId: 'user-1', storageKey: 'k', countryCode: 'IN', ownerMemberId: 'm', password: PASSWORD, deps: deps() });

    quarantineBytes = pdfFor(C1_CAS_BASELINE.text);
    const plain = await dispatchInvestmentDocument({ intakeId: 'intake-p4', userId: 'user-1', storageKey: 'k', countryCode: 'IN', ownerMemberId: 'm', deps: deps() });

    expect(encrypted.ok && plain.ok).toBe(true);
    if (!encrypted.ok || !plain.ok) return;
    expect(encrypted.parserCode).toBe(plain.parserCode);
    expect(encrypted.candidateCount).toBe(plain.candidateCount);
    expect(encrypted.finalStatus).toBe(plain.finalStatus);
  });

  it('the password never appears in any audit metadata', async () => {
    await dispatchInvestmentDocument({ intakeId: 'intake-p5', userId: 'user-1', storageKey: 'k', countryCode: 'IN', ownerMemberId: 'm', password: 'not-the-password', deps: deps() });
    expect(JSON.stringify(recorded.auditEvents)).not.toContain('not-the-password');
    // It records THAT an attempt was made, which is what makes rate limiting
    // possible without persisting the value.
    expect(JSON.stringify(recorded.auditEvents)).toContain('password_supplied');
  });
});

describe('M3 I.9 / M2-OPEN-6 — no canonical write happens at dispatch time', () => {
  it('a clean, fully-reconciling document still performs NO canonical write and NO binary deletion here', async () => {
    const outcome = await dispatchInvestmentDocument({ intakeId: 'intake-5', userId: 'user-1', storageKey: 'user-1/intake-5/intake-5.bin', countryCode: 'IN', ownerMemberId: 'member-1', deps: deps() });
    expect(outcome.ok).toBe(true);

    // The M2-OPEN-6 anti-pattern, asserted as ABSENT: the fdh-bank route
    // commits a canonical write inline at intake. This path does not.
    expect(recorded.storageDeletes).toHaveLength(0);
    // And the quarantine bytes are still needed — Investment Intelligence's
    // accept-time write re-fetches them. Deleting here would break
    // acceptance outright (I.10: retained only as long as required, which
    // includes "until the write that consumes them has succeeded").
    expect(recorded.intakeStatusUpdates.some((u) => u.toStatus === 'deleted')).toBe(false);
  });

  it('an unresolved owner produces a BLOCKING item rather than a guess (PC4-INV-12 has no mismatch detection to fall back on)', async () => {
    const outcome = await dispatchInvestmentDocument({ intakeId: 'intake-6', userId: 'user-1', storageKey: 'k', countryCode: 'IN', ownerMemberId: null, deps: deps() });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const items = recorded.unresolvedItems.flatMap((u) => u.items);
    expect(items.some((i) => i.reasonCode === 'ii_adapter:owner_unresolved' && i.severity === 'blocking')).toBe(true);
    // And the reported status reflects it — reporting `awaiting_acceptance`
    // while a blocking item exists would mislead the caller even though
    // accept.ts would still refuse.
    expect(outcome.finalStatus).toBe('unresolved');

    // M3 FIX, found by the live-DEV proof: the RUN ROW must move too, not
    // just the returned value. Before this, the dispatch reported
    // `unresolved` while the database row still read `awaiting_acceptance` —
    // the state the acceptance gate reads as "ready". Routed via
    // `reconciling`, matching revalidate.ts's own idiom.
    expect(recorded.runTransitions).toEqual([
      { runId: 'run-for-intake-6', fromStatus: 'awaiting_acceptance', toStatus: 'reconciling' },
      { runId: 'run-for-intake-6', fromStatus: 'reconciling', toStatus: 'unresolved' },
    ]);
  });

  it('an identity-derived blocking item is ALSO recorded as a failing reconciliation run, so both acceptance signals agree', async () => {
    await dispatchInvestmentDocument({ intakeId: 'intake-7', userId: 'user-1', storageKey: 'k', countryCode: 'IN', ownerMemberId: null, deps: deps() });
    const recon = recorded.reconciliationRuns.flatMap((r) => r.results);
    // A document blocked for one reason but reading as `pass` on the other
    // is the inconsistency that invites an "accept anyway" shortcut later.
    expect(recon.some((r) => r.ruleId.startsWith('ii_adapter_identity:') && r.outcome === 'fail')).toBe(true);
  });
});

describe('M3 — failure handling', () => {
  it('a quarantine download failure is typed and creates no run', async () => {
    downloadShouldFail = true;
    const outcome = await dispatchInvestmentDocument({ intakeId: 'intake-8', userId: 'user-1', storageKey: 'k', countryCode: 'IN', ownerMemberId: 'm', deps: deps() });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('quarantine_download_failed');
    expect(recorded.runsCreated).toHaveLength(0);
  });
});
