/**
 * Premium Upload Entitlement -- every discovered upload / admission / processing ROUTE, exercised directly as the
 * lowest reachable layer (pages 6, 53, 98, 161, 170, 193, 196, 224). The UI is never involved.
 *
 * For each inventory entry, with the REAL route handler, the REAL central capability and the REAL position mapping
 * (only the database, the authenticated session and the heavy downstream services are replaced):
 *
 *   unauthenticated         -> 401 and the entitlement is never read
 *   Free                    -> HTTP 403 { code: 'PREMIUM_REQUIRED' } BEFORE the body is read, with zero writes,
 *                              zero storage objects, zero downstream service calls (parser / AI / queue) and no table
 *                              read other than the caller's own entitlement row
 *   Free + spoofed plan     -> identical (query / header / cookie / body claims of Premium change nothing)
 *   entitlement unreadable  -> HTTP 503 { code: 'ENTITLEMENT_UNAVAILABLE' }, same zero side effects
 *   Premium                 -> NOT refused by the capability (the request proceeds to the route's own next check or to
 *                              the downstream service): the refusal above is the entitlement, not an earlier gate
 *
 * Run-start routes additionally prove the downgrade policy: a Free user's retry of a FAILED document and an unknown
 * document are refused, while the first run (`queued`) and the idempotent in-flight lifecycle may continue.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GATED_ROUTES, type GatedRoute } from '@/lib/entitlements/financialImportInventory';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { makeFakeSupabase, newFakeState, type FakeState } from '../support/fakeEntitlementSupabase';

// The first import of each heavy route module is slow on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });

const h = vi.hoisted(() => ({
  auth: { kind: 'user' as 'user' | 'anon', id: 'user-1' },
  state: null as unknown as FakeState,
  bodyReads: 0,
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  const result = () =>
    h.auth.kind === 'user'
      ? { user: { id: h.auth.id, email: 'free@example.test' }, unauthenticated: null }
      : { user: null, unauthenticated: Response.json({ error: 'Unauthenticated' }, { status: 401 }) };
  return { ...actual, requireCountryConfirmedUser: async () => result() };
});
vi.mock('@/lib/services/appCapability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/appCapability')>();
  return {
    ...actual,
    requireModuleCapability: async () =>
      h.auth.kind === 'user'
        ? { user: { id: h.auth.id }, blocked: null }
        : { user: null, blocked: Response.json({ error: 'Unauthenticated' }, { status: 401 }) },
  };
});
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeFakeSupabase(h.state) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeFakeSupabase(h.state) }));
// The platform-level upload switch is on, so a Premium request is not stopped by it and reaches the route's real next step.
vi.mock('@/lib/financial-data-hub/constants/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/financial-data-hub/constants/featureFlags')>();
  return { ...actual, isFdhDocumentUploadEnabled: () => true };
});
vi.mock('@/lib/aie/audit', () => ({ recordAieAuditEvent: async () => {} }));
vi.mock('@/lib/services/jurisdiction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/jurisdiction')>();
  return { ...actual, getUserFullExperienceHomeCountry: async () => 'AU' };
});

// Heavy downstream services: automocked, so "was the parser / AI / queue / storage path reached?" is a call count.
vi.mock('@/lib/financial-data-hub/services/bankCsvUploadService');
vi.mock('@/lib/financial-data-hub/services/bankPdfUploadService');
vi.mock('@/lib/financial-data-hub/services/bankCsvProcessingService');
vi.mock('@/lib/financial-data-hub/services/bankPdfProcessingService');
vi.mock('@/lib/financial-data-hub/services/payslipProcessingService');
vi.mock('@/lib/financial-data-hub/services/liabilityStatementProcessingService');
vi.mock('@/lib/financial-data-hub/services/investmentStatementProcessingService');
vi.mock('@/lib/financial-data-hub/services/retirementStatementProcessingService');
vi.mock('@/lib/financial-data-hub/services/identicalUpload');
vi.mock('@/lib/financial-data-hub/services/bankOwnerRequest');
vi.mock('@/lib/financial-data-hub/services/documentOwnerRequest');
vi.mock('@/lib/financial-data-hub/services/uploadLifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/financial-data-hub/services/uploadLifecycle')>();
  return { ...actual, createUploadSession: vi.fn(), completeUpload: vi.fn() };
});
vi.mock('@/lib/aie/db/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aie/db/repository')>();
  return { ...actual, createIntake: vi.fn(), updateIntakeStatus: vi.fn() };
});
vi.mock('@/lib/services/investment-intelligence/documentProcessing');
vi.mock('@/lib/services/investment-intelligence/manualImporter');
vi.mock('@/lib/services/investment-intelligence/storage');
vi.mock('@/lib/ownership/validateOwnerSelection');
vi.mock('@/lib/services/investment-intelligence/realScanAdmission');
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistoryKick');

// Paid-provider counter: every AIE route funnels paid extraction through this gateway. A denied Free flow must show ZERO calls.
const providerSpy = vi.spyOn(AieDocumentAiGateway.prototype, 'requestFieldCompletion').mockRejectedValue(new Error('PAID PROVIDER REACHED'));

const FREE = { plan_tier: 'free', effective_from: '2026-01-01', effective_to: null };
const PREMIUM = { plan_tier: 'premium', effective_from: '2026-01-01', effective_to: null };

beforeEach(() => {
  h.auth = { kind: 'user', id: 'user-1' };
  h.state = newFakeState();
  h.state.entitlement = FREE;
  h.bodyReads = 0;
  vi.clearAllMocks();
});

// ---- request builders -------------------------------------------------------------------------------------------

const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

/** A request whose every body-reading method counts, so "the body was never read" is an assertion, not a hope. */
function spyBody(req: Request): Request {
  for (const m of ['arrayBuffer', 'json', 'formData', 'text', 'blob'] as const) {
    const original = (req as unknown as Record<string, () => Promise<unknown>>)[m].bind(req);
    (req as unknown as Record<string, () => Promise<unknown>>)[m] = async () => {
      h.bodyReads += 1;
      return original();
    };
  }
  return req;
}

function bytesRequest(path: string, extra: { headers?: Record<string, string> } = {}): Request {
  return spyBody(
    new Request(`https://app.test${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf', 'content-length': String(BYTES.byteLength), ...(extra.headers ?? {}) },
      body: BYTES,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' }),
  );
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  const text = JSON.stringify(body);
  return spyBody(
    new Request(`https://app.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(text.length), ...headers }, body: text }),
  );
}

function multipartRequest(path: string): Request {
  const form = new FormData();
  form.append('file', new File([BYTES], 'statement.pdf', { type: 'application/pdf' }));
  form.append('meta', JSON.stringify({ sourceKey: 'cams' }));
  return spyBody(new Request(`https://app.test${path}`, { method: 'POST', body: form }));
}

interface Probe {
  request: (extra?: { headers?: Record<string, string>; querySuffix?: string }) => Request;
  params?: Record<string, string>;
}

const DOC_ID = '11111111-1111-4111-8111-111111111111';

const ADMISSION_PROBES: Record<string, Probe> = {
  'fdh.upload_session.create': {
    request: (x) =>
      jsonRequest(`/api/financial-data-hub/documents/upload-sessions${x?.querySuffix ?? ''}`, {
        document_type: 'tax_document',
        source_type: 'pdf_native',
        country_code: 'AU',
        declared_mime_type: 'application/pdf',
        declared_file_size_bytes: 1000,
        // a hostile client's claim, which must change nothing
        ...(x?.headers?.['x-spoof'] ? { plan_tier: 'premium', isPremium: true } : {}),
      }, x?.headers),
  },
  'fdh.upload_session.complete': { request: (x) => bytesRequest(`/api/financial-data-hub/documents/upload-sessions/s-1/complete${x?.querySuffix ?? ''}`, x), params: { sessionId: 's-1' } },
  'fdh.bank_csv.upload': { request: (x) => bytesRequest(`/api/financial-data-hub/bank-csv/upload?country_code=AU&currency_code=AUD&filename=s.csv${x?.querySuffix ?? ''}`, x) },
  'fdh.bank_pdf.upload': { request: (x) => bytesRequest(`/api/financial-data-hub/bank-pdf/upload?country_code=AU&currency_code=AUD&filename=s.pdf${x?.querySuffix ?? ''}`, x) },
  'fdh.liability_statement.upload': { request: (x) => bytesRequest(`/api/financial-data-hub/liability-statement/upload?filename=s.csv${x?.querySuffix ?? ''}`, x) },
  'fdh.investment_statement.upload': { request: (x) => bytesRequest(`/api/financial-data-hub/investment-statement/upload?filename=s.csv${x?.querySuffix ?? ''}`, x) },
  'fdh.retirement_statement.upload': { request: (x) => bytesRequest(`/api/financial-data-hub/retirement-statement/upload?filename=s.csv${x?.querySuffix ?? ''}`, x) },
  'aie.intake.upload': { request: (x) => bytesRequest(`/api/aie/intake?filename=s.pdf${x?.querySuffix ?? ''}`, x) },
  'aie.insurance.intake': { request: (x) => bytesRequest(`/api/aie/insurance/intake?filename=s.pdf${x?.querySuffix ?? ''}`, x) },
  'aie.fdh_bank.intake': { request: (x) => bytesRequest(`/api/aie/fdh-bank/intake?country_code=AU&currency_code=AUD&filename=s.pdf${x?.querySuffix ?? ''}`, x) },
  'aie.investment_intelligence.intake': { request: (x) => bytesRequest(`/api/aie/investment-intelligence/intake?filename=s.pdf${x?.querySuffix ?? ''}`, x) },
  'ii.source_document.upload': { request: (x) => multipartRequest(`/api/investment-intelligence/source-documents${x?.querySuffix ?? ''}`) },
  'ii.source_document.parse_fixture': { request: (x) => jsonRequest(`/api/investment-intelligence/source-documents/${DOC_ID}/parse${x?.querySuffix ?? ''}`, { not: 'a fixture' }, x?.headers), params: { id: DOC_ID } },
};

const RUN_PARAMS = (entry: GatedRoute): Record<string, string> =>
  entry.file.includes('[documentId]') ? { documentId: DOC_ID } : entry.file.includes('[intakeId]') ? { intakeId: DOC_ID } : { id: DOC_ID };

function runStartRequest(entry: GatedRoute, extraBody: Record<string, unknown> = {}): Request {
  const path = entry.file.replace('app', '').replace('/route.ts', '').replace('[documentId]', DOC_ID).replace('[intakeId]', DOC_ID).replace('[id]', DOC_ID);
  return jsonRequest(path, extraBody);
}

// ---- the route table --------------------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each route has its own params shape; the harness passes whatever the route needs
type RouteHandler = (req: Request, ctx: any) => Promise<Response>;
const LOADERS: Record<string, () => Promise<{ POST: RouteHandler }>> = {
  'fdh.upload_session.create': () => import('@/app/api/financial-data-hub/documents/upload-sessions/route'),
  'fdh.upload_session.complete': () => import('@/app/api/financial-data-hub/documents/upload-sessions/[sessionId]/complete/route'),
  'fdh.bank_csv.upload': () => import('@/app/api/financial-data-hub/bank-csv/upload/route'),
  'fdh.bank_pdf.upload': () => import('@/app/api/financial-data-hub/bank-pdf/upload/route'),
  'fdh.liability_statement.upload': () => import('@/app/api/financial-data-hub/liability-statement/upload/route'),
  'fdh.investment_statement.upload': () => import('@/app/api/financial-data-hub/investment-statement/upload/route'),
  'fdh.retirement_statement.upload': () => import('@/app/api/financial-data-hub/retirement-statement/upload/route'),
  'aie.intake.upload': () => import('@/app/api/aie/intake/route'),
  'aie.insurance.intake': () => import('@/app/api/aie/insurance/intake/route'),
  'aie.fdh_bank.intake': () => import('@/app/api/aie/fdh-bank/intake/route'),
  'aie.investment_intelligence.intake': () => import('@/app/api/aie/investment-intelligence/intake/route'),
  'ii.source_document.upload': () => import('@/app/api/investment-intelligence/source-documents/route'),
  'ii.source_document.parse_fixture': () => import('@/app/api/investment-intelligence/source-documents/[id]/parse/route'),
  'fdh.bank_csv.detect': () => import('@/app/api/financial-data-hub/bank-csv/[documentId]/detect/route'),
  'fdh.bank_csv.map': () => import('@/app/api/financial-data-hub/bank-csv/[documentId]/map/route'),
  'fdh.bank_csv.process': () => import('@/app/api/financial-data-hub/bank-csv/[documentId]/process/route'),
  'fdh.bank_pdf.process': () => import('@/app/api/financial-data-hub/bank-pdf/[documentId]/process/route'),
  'fdh.bank_pdf.ai_fallback_confirm': () => import('@/app/api/financial-data-hub/bank-pdf/[documentId]/ai-fallback/confirm/route'),
  'fdh.payslip.process': () => import('@/app/api/financial-data-hub/payslip/[documentId]/process/route'),
  'fdh.payslip.ai_fallback_confirm': () => import('@/app/api/financial-data-hub/payslip/[documentId]/ai-fallback/confirm/route'),
  'fdh.liability_statement.process': () => import('@/app/api/financial-data-hub/liability-statement/[documentId]/process/route'),
  'fdh.liability_statement.ai_fallback_confirm': () => import('@/app/api/financial-data-hub/liability-statement/[documentId]/ai-fallback/confirm/route'),
  'fdh.investment_statement.process': () => import('@/app/api/financial-data-hub/investment-statement/[documentId]/process/route'),
  'fdh.investment_statement.ai_fallback_confirm': () => import('@/app/api/financial-data-hub/investment-statement/[documentId]/ai-fallback/confirm/route'),
  'fdh.retirement_statement.process': () => import('@/app/api/financial-data-hub/retirement-statement/[documentId]/process/route'),
  'fdh.retirement_statement.ai_fallback_confirm': () => import('@/app/api/financial-data-hub/retirement-statement/[documentId]/ai-fallback/confirm/route'),
  'aie.investment_intelligence.process': () => import('@/app/api/aie/investment-intelligence/intake/[intakeId]/process/route'),
  'ii.source_document.process': () => import('@/app/api/investment-intelligence/source-documents/[id]/process/route'),
};

async function load(entry: GatedRoute) {
  const mod = await LOADERS[entry.surface]();
  return mod.POST;
}

it('every inventory surface has a loader (the table covers the whole inventory)', () => {
  expect(Object.keys(LOADERS).sort()).toEqual(GATED_ROUTES.map((g) => g.surface).sort());
});

async function call(entry: GatedRoute, req: Request, params: Record<string, string>): Promise<{ res: Response | null; body: Record<string, unknown> | null; threw: unknown }> {
  const POST = await load(entry);
  try {
    const res = await POST(req, { params: Promise.resolve(params) });
    const body = (await res.clone().json().catch(() => null)) as Record<string, unknown> | null;
    return { res, body, threw: null };
  } catch (e) {
    return { res: null, body: null, threw: e };
  }
}

const isPremiumRefusal = (body: Record<string, unknown> | null) => body?.code === 'PREMIUM_REQUIRED' || body?.code === 'ENTITLEMENT_UNAVAILABLE';

/** Every mocked downstream function that is a spy, as call counts. */
async function downstreamCalls(): Promise<number> {
  const mods = await Promise.all([
    import('@/lib/financial-data-hub/services/bankCsvUploadService'),
    import('@/lib/financial-data-hub/services/bankPdfUploadService'),
    import('@/lib/financial-data-hub/services/bankCsvProcessingService'),
    import('@/lib/financial-data-hub/services/bankPdfProcessingService'),
    import('@/lib/financial-data-hub/services/payslipProcessingService'),
    import('@/lib/financial-data-hub/services/liabilityStatementProcessingService'),
    import('@/lib/financial-data-hub/services/investmentStatementProcessingService'),
    import('@/lib/financial-data-hub/services/retirementStatementProcessingService'),
    import('@/lib/financial-data-hub/services/uploadLifecycle'),
    import('@/lib/aie/db/repository'),
    import('@/lib/services/investment-intelligence/documentProcessing'),
    import('@/lib/services/investment-intelligence/manualImporter'),
    import('@/lib/services/investment-intelligence/storage'),
  ]);
  let total = providerSpy.mock.calls.length;
  for (const m of mods) for (const v of Object.values(m)) if (vi.isMockFunction(v)) total += v.mock.calls.length;
  return total;
}

const admission = GATED_ROUTES.filter((g) => g.guard === 'admission');
const runStart = GATED_ROUTES.filter((g) => g.guard === 'run_start');

describe('admission routes -- a Free customer can start NO new ingestion through any of them', () => {
  for (const entry of admission) {
    describe(entry.surface, () => {
      const probe = ADMISSION_PROBES[entry.surface];
      it('has a probe (the table covers the whole inventory)', () => expect(probe).toBeDefined());

      it('unauthenticated => 401, entitlement never read, body never read', async () => {
        h.auth = { kind: 'anon', id: '' };
        const { res } = await call(entry, probe.request(), probe.params ?? {});
        expect(res?.status).toBe(401);
        expect(h.state.readTables).not.toContain('user_entitlements');
        expect(h.bodyReads).toBe(0);
      });

      it('Free => 403 PREMIUM_REQUIRED before the body, with zero writes / storage / downstream work', async () => {
        h.state.entitlement = FREE;
        const { res, body } = await call(entry, probe.request(), probe.params ?? {});
        expect(res?.status).toBe(403);
        expect(body?.code).toBe('PREMIUM_REQUIRED');
        expect((body?.data as { upgrade_path?: string })?.upgrade_path).toBe('/profile');
        expect(h.bodyReads).toBe(0);
        expect(h.state.writes).toEqual([]);
        expect(h.state.readTables.filter((t) => t !== 'user_entitlements')).toEqual([]);
        expect(await downstreamCalls()).toBe(0);
      });

      it('no entitlement row at all => same refusal (missing row is Free)', async () => {
        h.state.entitlement = null;
        const { res, body } = await call(entry, probe.request(), probe.params ?? {});
        expect([res?.status, body?.code]).toEqual([403, 'PREMIUM_REQUIRED']);
        expect(h.bodyReads).toBe(0);
        expect(await downstreamCalls()).toBe(0);
      });

      it('Free + spoofed Premium (query, header, cookie, body) => unchanged refusal', async () => {
        h.state.entitlement = FREE;
        const headers = { 'x-spoof': '1', 'x-plan-tier': 'premium', 'x-premium': 'true', cookie: 'plan_tier=premium; is_premium=1' };
        const { res, body } = await call(entry, probe.request({ headers, querySuffix: '&plan=premium&plan_tier=premium&isPremium=true&price=0&country=AU' }), probe.params ?? {});
        expect([res?.status, body?.code]).toEqual([403, 'PREMIUM_REQUIRED']);
        expect(h.bodyReads).toBe(0);
        expect(h.state.writes).toEqual([]);
        expect(await downstreamCalls()).toBe(0);
      });

      it('expired Premium window => refused', async () => {
        h.state.entitlement = { plan_tier: 'premium', effective_from: '2020-01-01', effective_to: '2020-12-31' };
        const { res, body } = await call(entry, probe.request(), probe.params ?? {});
        expect([res?.status, body?.code]).toEqual([403, 'PREMIUM_REQUIRED']);
      });

      it('entitlement store down => 503 ENTITLEMENT_UNAVAILABLE (fail closed), same zero side effects', async () => {
        h.state.entitlementError = 'connection refused';
        const { res, body } = await call(entry, probe.request(), probe.params ?? {});
        expect([res?.status, body?.code]).toEqual([503, 'ENTITLEMENT_UNAVAILABLE']);
        expect(h.bodyReads).toBe(0);
        expect(h.state.writes).toEqual([]);
        expect(await downstreamCalls()).toBe(0);
      });

      it('NEGATIVE CONTROL: the same request as Premium is NOT refused by the capability', async () => {
        h.state.entitlement = PREMIUM;
        const { body, threw } = await call(entry, probe.request(), probe.params ?? {});
        // The request moved on to the route's own next step (validation, a feature flag, the downstream service) --
        // whatever it answered, it did not answer with the Premium refusal.
        expect(isPremiumRefusal(body)).toBe(false);
        void threw;
      });
    });
  }
});

describe('run-start routes -- the downgrade / in-flight policy, per route', () => {
  const fdhRow = (processing_status: string, error_code: string | null = null) => ({ id: DOC_ID, user_id: 'user-1', processing_status, error_code });

  function seed(entry: GatedRoute, status: string, errorCode: string | null = null) {
    if (entry.file.includes('/app/api/financial-data-hub/') || entry.file.startsWith('app/api/financial-data-hub/')) {
      h.state.tables.fdh_statement_uploads = [fdhRow(status, errorCode)];
    } else if (entry.surface.startsWith('aie.')) {
      h.state.tables.aie_document_intake = [{ id: DOC_ID, user_id: 'user-1', status, storage_key: 'k', display_filename: 'f' }];
    } else {
      h.state.tables.ii_source_documents = [{ id: DOC_ID, user_id: 'user-1', status }];
    }
  }
  const statusFor = {
    firstRun: (e: GatedRoute) => (e.surface.startsWith('aie.') ? 'quarantined' : e.surface.startsWith('ii.') ? 'uploaded' : 'queued'),
    retry: (e: GatedRoute) => (e.surface.startsWith('aie.') ? 'quarantined' : e.surface.startsWith('ii.') ? 'parse_failed' : 'failed'),
    inFlight: (e: GatedRoute) => (e.surface.startsWith('aie.') ? 'ready' : e.surface.startsWith('ii.') ? 'parsed' : 'review_required'),
  };

  for (const entry of runStart) {
    describe(entry.surface, () => {
      // The AIE intake process route has no "retry" status: quarantined IS its first run, so its retry case is "not found".
      const hasRetryState = !entry.surface.startsWith('aie.');

      it('unauthenticated => 401, nothing read', async () => {
        h.auth = { kind: 'anon', id: '' };
        const { res } = await call(entry, runStartRequest(entry), RUN_PARAMS(entry));
        expect(res?.status).toBe(401);
        expect(h.state.readTables).toEqual([]);
      });

      it('Free + a document that does not exist (or is not theirs) => 403, no downstream work', async () => {
        h.state.entitlement = FREE;
        const { res, body } = await call(entry, runStartRequest(entry), RUN_PARAMS(entry));
        expect([res?.status, body?.code]).toEqual([403, 'PREMIUM_REQUIRED']);
        expect(await downstreamCalls()).toBe(0);
        expect(h.state.writes).toEqual([]);
      });

      if (hasRetryState) {
        it('Free + a FAILED / retryable document => 403 (a retry is new extraction work), no downstream work', async () => {
          h.state.entitlement = FREE;
          seed(entry, statusFor.retry(entry));
          const { res, body } = await call(entry, runStartRequest(entry), RUN_PARAMS(entry));
          expect([res?.status, body?.code]).toEqual([403, 'PREMIUM_REQUIRED']);
          expect(await downstreamCalls()).toBe(0);
          expect(h.state.writes).toEqual([]);
        });
      }

      it('Free after a downgrade + the FIRST run of a document admitted while Premium => allowed to continue', async () => {
        h.state.entitlement = FREE;
        seed(entry, statusFor.firstRun(entry));
        const { body } = await call(entry, runStartRequest(entry), RUN_PARAMS(entry));
        expect(isPremiumRefusal(body)).toBe(false);
      });

      it('Free after a downgrade + an already in-flight document => allowed (idempotent lifecycle, nothing is stranded)', async () => {
        h.state.entitlement = FREE;
        seed(entry, statusFor.inFlight(entry));
        const { body } = await call(entry, runStartRequest(entry), RUN_PARAMS(entry));
        expect(isPremiumRefusal(body)).toBe(false);
      });

      it('entitlement store down => 503 and the document is not even looked up', async () => {
        h.state.entitlementError = 'timeout';
        seed(entry, statusFor.firstRun(entry));
        const { res, body } = await call(entry, runStartRequest(entry), RUN_PARAMS(entry));
        expect([res?.status, body?.code]).toEqual([503, 'ENTITLEMENT_UNAVAILABLE']);
        expect(h.state.readTables.filter((t) => t !== 'user_entitlements')).toEqual([]);
      });

      it('NEGATIVE CONTROL: Premium may retry a failed document (the refusal is the entitlement, not the status)', async () => {
        h.state.entitlement = PREMIUM;
        seed(entry, statusFor.retry(entry));
        const { body } = await call(entry, runStartRequest(entry), RUN_PARAMS(entry));
        expect(isPremiumRefusal(body)).toBe(false);
        // and a Premium caller costs exactly one entitlement read and no document lookup of its own
        expect(h.state.readTables.filter((t) => t === 'user_entitlements').length).toBeGreaterThanOrEqual(1);
      });
    });
  }

  it('II: a forced re-parse is Premium even for a first-run document', async () => {
    const entry = GATED_ROUTES.find((g) => g.surface === 'ii.source_document.process')!;
    h.state.entitlement = FREE;
    seed(entry, 'uploaded');
    const { res, body } = await call(entry, runStartRequest(entry, { forceReparse: true }), RUN_PARAMS(entry));
    expect([res?.status, body?.code]).toEqual([403, 'PREMIUM_REQUIRED']);
    h.state.entitlement = PREMIUM;
    const again = await call(entry, runStartRequest(entry, { forceReparse: true }), RUN_PARAMS(entry));
    expect(isPremiumRefusal(again.body)).toBe(false);
  });

  it('FDH: a document that is only waiting for its PDF password is still a first run', async () => {
    const entry = GATED_ROUTES.find((g) => g.surface === 'fdh.payslip.process')!;
    h.state.entitlement = FREE;
    seed(entry, 'failed', 'password_required');
    const { body } = await call(entry, runStartRequest(entry), RUN_PARAMS(entry));
    expect(isPremiumRefusal(body)).toBe(false);
    seed(entry, 'failed', 'unsupported_file_type');
    const refused = await call(entry, runStartRequest(entry), RUN_PARAMS(entry));
    expect(refused.body?.code).toBe('PREMIUM_REQUIRED');
  });
});

describe('IDOR / ownership (pages 162, 163, 170): the entitlement is the callers own and never extends to other users documents', () => {
  const payslip = () => GATED_ROUTES.find((g) => g.surface === 'fdh.payslip.process')!;

  it('Free caller + a QUEUED document owned by someone else => refused (the position lookup is scoped to the caller)', async () => {
    h.state.entitlement = FREE;
    h.state.tables.fdh_statement_uploads = [{ id: DOC_ID, user_id: 'user-2', processing_status: 'queued', error_code: null }];
    const { res, body } = await call(payslip(), runStartRequest(payslip()), RUN_PARAMS(payslip()));
    expect([res?.status, body?.code]).toEqual([403, 'PREMIUM_REQUIRED']);
    expect(await downstreamCalls()).toBe(0);
  });

  it("Premium caller + someone else's document id: the Premium check passes, and the downstream service is handed the CALLER's id (its own ownership check refuses)", async () => {
    h.state.entitlement = PREMIUM;
    h.state.tables.fdh_statement_uploads = [{ id: DOC_ID, user_id: 'user-2', processing_status: 'queued', error_code: null }];
    await call(payslip(), runStartRequest(payslip()), RUN_PARAMS(payslip()));
    const svc = await import('@/lib/financial-data-hub/services/payslipProcessingService');
    const processFn = vi.mocked(svc.processPayslipDocument);
    expect(processFn).toHaveBeenCalledTimes(1);
    expect(processFn.mock.calls[0][0]).toBe('user-1'); // the authenticated caller, never a body / query / param value
    expect(processFn.mock.calls[0][1]).toBe(DOC_ID);
  });

  it('a body that names another user changes nothing: the entitlement read is for the session user only', async () => {
    h.state.entitlement = FREE;
    const entry = payslip();
    const req = jsonRequest(`/api/financial-data-hub/payslip/${DOC_ID}/process`, { user_id: 'user-premium-elsewhere', userId: 'user-premium-elsewhere' });
    const { res, body } = await call(entry, req, RUN_PARAMS(entry));
    expect([res?.status, body?.code]).toEqual([403, 'PREMIUM_REQUIRED']);
  });
});

describe('the upload-status read (what the UI draws from) is the same server decision', () => {
  it('reports allowed / premium_required / unavailable and touches nothing else', async () => {
    const { GET } = await import('@/app/api/financial-data-hub/upload-status/route');
    const get = async () => (await (await GET()).json()).data.import_access as string;
    h.state.entitlement = PREMIUM;
    expect(await get()).toBe('allowed');
    h.state.entitlement = FREE;
    expect(await get()).toBe('premium_required');
    h.state.entitlementError = 'down';
    expect(await get()).toBe('unavailable');
    expect(h.state.writes).toEqual([]);
  });
});
