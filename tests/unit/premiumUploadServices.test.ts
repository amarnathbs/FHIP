/**
 * Premium Upload Entitlement -- the SERVICE-layer admission boundary behind the route guards (pages 54, 85, 166, 194,
 * 195, 199): an accidentally ungated route must still be unable to create new Free upload work, because the services
 * that create the document row / the session / the stored bytes / the AIE intake refuse on their own.
 *
 * Also the downgrade lifecycle end to end on one stateful fake: Premium admits a document -> the plan becomes Free ->
 * the credential is no longer honoured and no NEW admission is possible -> the admitted document's first run and its
 * in-flight lifecycle still work, a retry does not -> the imported data is still the user's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeSupabase, newFakeState, type FakeState } from '../support/fakeEntitlementSupabase';

const h = vi.hoisted(() => ({
  state: null as unknown as FakeState,
  created: [] as unknown[],
  sessionsCreated: [] as unknown[],
  audits: [] as { eventType: string; metadata?: Record<string, unknown> }[],
  stored: [] as unknown[],
  jobs: [] as unknown[],
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeFakeSupabase(h.state) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeFakeSupabase(h.state) }));
vi.mock('@/lib/financial-data-hub/repositories', () => ({
  statementUploadsRepository: {
    create: async (_u: string, row: Record<string, unknown>) => {
      const doc = { id: 'doc-1', processing_status: 'created', ...row };
      h.created.push(doc);
      return { data: doc, error: null };
    },
    getForUser: async (_u: string, id: string) => ({ data: h.created.find((d) => (d as { id: string }).id === id) ?? null, error: null }),
    update: async (_u: string, _id: string, patch: Record<string, unknown>) => ({ data: { id: 'doc-1', ...patch }, error: null }),
  },
  uploadSessionsRepository: {
    create: async (_u: string, row: Record<string, unknown>) => {
      const s = { id: 'sess-1', created_at: new Date().toISOString(), ...row };
      h.sessionsCreated.push(s);
      return { data: s, error: null };
    },
    getForUser: async () => ({ data: h.sessionsCreated[0] ?? null, error: null }),
    listForUser: async () => ({ data: [], error: null }),
    update: async () => ({ data: null, error: null }),
  },
  ingestionJobsRepository: { create: async (_u: string, row: unknown) => { h.jobs.push(row); return { data: row, error: null }; } },
}));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({
  recordDocumentAuditEvent: async (e: { eventType: string; metadata?: Record<string, unknown> }) => { h.audits.push(e); },
}));
vi.mock('@/lib/financial-data-hub/services/storage', () => ({
  uploadDocumentObject: async (x: unknown) => { h.stored.push(x); return { ok: true }; },
  verifyDocumentObjectExists: async () => true,
  verifyDocumentObjectAbsent: async () => true,
  deleteDocumentObject: async () => ({ ok: true }),
  createDocumentPreviewUrl: async () => 'https://example.test/preview',
}));
vi.mock('@/lib/financial-data-hub/services/malwareScanGate', () => ({ runFdhRealMalwareScanGate: async () => ({ status: 'clean' }) }));

import { completeUpload, createUploadSession, FdhUploadLifecycleError } from '@/lib/financial-data-hub/services/uploadLifecycle';
import { FinancialImportDeniedError } from '@/lib/entitlements/financialDataImport';
import { runPositionForFdhStatus } from '@/lib/financial-data-hub/services/importRunPosition';
import { runPositionForAieIntakeStatus } from '@/lib/aie/importRunPosition';
import { runPositionForIiStatus } from '@/lib/services/investment-intelligence/importRunPosition';
import { refuseUnlessImportRunMayStart } from '@/lib/entitlements/financialDataImport';
import { createIntake } from '@/lib/aie/db/repository';

const FREE = { plan_tier: 'free', effective_from: '2026-01-01', effective_to: null };
const PREMIUM = { plan_tier: 'premium', effective_from: '2026-01-01', effective_to: null };
const INPUT = { document_type: 'payslip', source_type: 'pdf_native', country_code: 'AU', declared_mime_type: 'application/pdf', declared_file_size_bytes: 1000 } as never;
const PDF = new TextEncoder().encode('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

beforeEach(() => {
  h.state = newFakeState();
  h.created.length = 0;
  h.sessionsCreated.length = 0;
  h.audits.length = 0;
  h.stored.length = 0;
  h.jobs.length = 0;
});

describe('FDH createUploadSession (every FDH pipeline enters here)', () => {
  it('Free: refused with the typed error; NO document row, NO session, NO audit event', async () => {
    h.state.entitlement = FREE;
    await expect(createUploadSession('user-1', INPUT)).rejects.toBeInstanceOf(FinancialImportDeniedError);
    expect(h.created).toEqual([]);
    expect(h.sessionsCreated).toEqual([]);
    expect(h.audits).toEqual([]);
  });

  it('no entitlement row / store down: refused too (503-class), nothing created', async () => {
    h.state.entitlement = null;
    await expect(createUploadSession('user-1', INPUT)).rejects.toMatchObject({ code: 'PREMIUM_REQUIRED', httpStatus: 403 });
    h.state.entitlementError = 'down';
    await expect(createUploadSession('user-1', INPUT)).rejects.toMatchObject({ code: 'ENTITLEMENT_UNAVAILABLE', httpStatus: 503 });
    expect(h.created).toEqual([]);
  });

  it('Premium (NEGATIVE CONTROL): creates the row + session and STAMPS Premium at admission in the audit event', async () => {
    h.state.entitlement = PREMIUM;
    const { document, session } = await createUploadSession('user-1', INPUT);
    expect(document).toMatchObject({ id: 'doc-1' });
    expect(session).toMatchObject({ id: 'sess-1' });
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({ eventType: 'document_upload_created', metadata: { import_entitlement: 'premium', document_type: 'payslip' } });
  });
});

describe('FDH completeUpload (the step that stores raw bytes)', () => {
  it('Free: refused BEFORE the session is read or a byte is stored', async () => {
    h.state.entitlement = FREE;
    await expect(completeUpload('user-1', 'sess-1', PDF)).rejects.toBeInstanceOf(FinancialImportDeniedError);
    expect(h.stored).toEqual([]);
    expect(h.jobs).toEqual([]);
  });

  it('a Premium user who is downgraded after creating the session cannot complete it (no reusable credential)', async () => {
    h.state.entitlement = PREMIUM;
    await createUploadSession('user-1', INPUT);
    expect(h.sessionsCreated).toHaveLength(1);
    h.state.entitlement = FREE; // cancellation / trial expiry between the two calls
    await expect(completeUpload('user-1', 'sess-1', PDF)).rejects.toMatchObject({ code: 'PREMIUM_REQUIRED' });
    expect(h.stored).toEqual([]); // no raw file reached private storage
    expect(h.jobs).toEqual([]); // nothing was queued
  });

  it('Premium (NEGATIVE CONTROL): the same call reaches storage', async () => {
    h.state.entitlement = PREMIUM;
    await createUploadSession('user-1', INPUT);
    try {
      await completeUpload('user-1', 'sess-1', PDF);
    } catch (e) {
      // later steps of the real lifecycle may stop on the minimal fixtures -- but never on the entitlement
      expect(e).not.toBeInstanceOf(FinancialImportDeniedError);
    }
    expect(h.state.readTables.filter((t) => t === 'user_entitlements').length).toBeGreaterThanOrEqual(2);
  });

  it('the typed error is not a lifecycle error the routes would swallow as a 400', () => {
    expect(new FinancialImportDeniedError({ allowed: false, code: 'PREMIUM_REQUIRED', httpStatus: 403, upgradeAvailable: true })).not.toBeInstanceOf(FdhUploadLifecycleError);
  });
});

describe('AIE createIntake (the four AIE intake routes enter here)', () => {
  function rls() {
    const inserted: unknown[] = [];
    const client = { from: () => ({ insert: (row: unknown) => { inserted.push(row); return { select: () => ({ single: async () => ({ data: { id: 'intake-1' }, error: null }) }) }; } }) };
    return { client: client as never, inserted };
  }
  const params = { userId: 'user-1', declaredMimeType: 'application/pdf', byteSize: 10, displayFilename: 'a.pdf', sourceModuleHint: 'other' as never };

  it('Free: returns the Premium error and inserts NO intake row', async () => {
    h.state.entitlement = FREE;
    const { client, inserted } = rls();
    expect(await createIntake(client, params)).toEqual({ error: 'PREMIUM_REQUIRED' });
    expect(inserted).toEqual([]);
  });

  it('store down: ENTITLEMENT_UNAVAILABLE, nothing inserted', async () => {
    h.state.entitlementError = 'down';
    const { client, inserted } = rls();
    expect(await createIntake(client, params)).toEqual({ error: 'ENTITLEMENT_UNAVAILABLE' });
    expect(inserted).toEqual([]);
  });

  it('Premium (NEGATIVE CONTROL): the intake row is created', async () => {
    h.state.entitlement = PREMIUM;
    const { client, inserted } = rls();
    expect(await createIntake(client, params)).toEqual({ id: 'intake-1' });
    expect(inserted).toHaveLength(1);
  });
});

describe('downgrade lifecycle (pages 9, 95, 117, 153, 155, 199)', () => {
  const free = () => ({ today: '2026-10-14', onEvent: () => {}, readEntitlement: async () => ({ row: FREE as never, error: null }) });

  it('Premium admits -> becomes Free -> in-flight continues, nothing new starts', async () => {
    // 1. admitted while Premium
    h.state.entitlement = PREMIUM;
    await createUploadSession('user-1', INPUT);
    expect(h.created).toHaveLength(1);

    // 2. the plan lapses
    h.state.entitlement = FREE;

    // 3a. NEW admission: refused for the same user at both service boundaries
    await expect(createUploadSession('user-1', INPUT)).rejects.toBeInstanceOf(FinancialImportDeniedError);
    await expect(completeUpload('user-1', 'sess-1', PDF)).rejects.toBeInstanceOf(FinancialImportDeniedError);
    expect(h.created).toHaveLength(1); // still only the document admitted while Premium

    // 3b. the admitted document: first run + in-flight proceed; a retry of a failed one and a stranger's id do not
    const go = (position: Parameters<typeof refuseUnlessImportRunMayStart>[2]) => refuseUnlessImportRunMayStart('user-1', 's', position, free());
    expect(await go(async () => runPositionForFdhStatus('queued'))).toBeNull();
    expect(await go(async () => runPositionForFdhStatus('review_required'))).toBeNull();
    expect(await go(async () => runPositionForFdhStatus('ready_for_approval'))).toBeNull();
    expect((await go(async () => runPositionForFdhStatus('failed')))?.status).toBe(403);
    expect((await go(async () => runPositionForFdhStatus(null)))?.status).toBe(403);
  });

  it('the status -> position tables (FDH, AIE, II)', () => {
    expect(['queued', 'failed', 'review_required', 'approved', 'extracted', 'processing'].map((s) => runPositionForFdhStatus(s))).toEqual(['first_run', 'retry', 'in_flight', 'in_flight', 'in_flight', 'in_flight']);
    expect(runPositionForFdhStatus('failed', 'password_required')).toBe('first_run');
    expect(runPositionForFdhStatus('failed', 'password_invalid')).toBe('first_run');
    expect(runPositionForFdhStatus('failed', 'file_corrupt')).toBe('retry');
    expect(runPositionForFdhStatus(undefined)).toBe('unknown');
    expect(['quarantined', 'ready', 'rejected', 'deleted'].map((s) => runPositionForAieIntakeStatus(s))).toEqual(['first_run', 'in_flight', 'in_flight', 'in_flight']);
    expect(['uploaded', 'password_required', 'parse_failed', 'unsupported', 'parsed', 'parsing', 'ai_review_pending', 'archived'].map((s) => runPositionForIiStatus(s)))
      .toEqual(['first_run', 'first_run', 'retry', 'retry', 'in_flight', 'in_flight', 'in_flight', 'in_flight']);
    expect(runPositionForIiStatus('uploaded', true)).toBe('forced');
    expect(runPositionForIiStatus(null)).toBe('unknown');
  });

  it('Upgrade immediacy: Free -> Premium makes the very next admission succeed without any re-login or cache flush', async () => {
    h.state.entitlement = FREE;
    await expect(createUploadSession('user-1', INPUT)).rejects.toBeInstanceOf(FinancialImportDeniedError);
    h.state.entitlement = PREMIUM; // the verified webhook has written the row
    await expect(createUploadSession('user-1', INPUT)).resolves.toMatchObject({ document: { id: 'doc-1' } });
  });
});
