/**
 * The three upload ROUTES with a PDF body: the REAL route handlers and the REAL central Premium capability; the database, the session and the
 * heavy services replaced. Proves the order of refusals promised in docs/ai/pdf_routes_liab_ret_auinv/00_COMMON_SPEC.md section 2:
 *
 *   1. Free (or a spoofed plan) -> 403 PREMIUM_REQUIRED before the body is read, nothing downstream touched;
 *   2. Premium + PDF + that class's switch OFF -> 403 with plain words, nothing downstream touched;
 *   3. a CSV is never affected by the PDF switch;
 *   4. Premium + PDF + switch ON -> the service is called with the bytes; a loan PDF needs the loan type chosen first;
 *   5. an oversized PDF is refused before any service call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFakeSupabase, newFakeState, type FakeState } from '../support/fakeEntitlementSupabase';
import { PDF_ROUTE_DISABLED_MESSAGE } from '@/lib/financial-data-hub/pdf-statements';

vi.setConfig({ testTimeout: 60_000 });

const h = vi.hoisted(() => ({ state: null as unknown as FakeState, bodyReads: 0 }));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, requireCountryConfirmedUser: async () => ({ user: { id: 'user-1', email: 'u@example.test' }, unauthenticated: null }) };
});
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeFakeSupabase(h.state) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeFakeSupabase(h.state) }));
vi.mock('@/lib/financial-data-hub/constants/featureFlags', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/financial-data-hub/constants/featureFlags')>();
  return { ...actual, isFdhDocumentUploadEnabled: () => true };
});
vi.mock('@/lib/services/jurisdiction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/jurisdiction')>();
  return { ...actual, getUserFullExperienceHomeCountry: async () => 'AU' };
});
vi.mock('@/lib/financial-data-hub/services/liabilityStatementProcessingService');
vi.mock('@/lib/financial-data-hub/services/investmentStatementProcessingService');
vi.mock('@/lib/financial-data-hub/services/retirementStatementProcessingService');
vi.mock('@/lib/financial-data-hub/services/documentOwnerRequest', () => ({
  resolveUploadOwnerFromUrl: async () => ({ ok: true, owner: { ownerRole: 'self' } }),
  assertNoIdenticalDocumentWithDifferentOwner: async () => undefined,
  recordDocumentOwner: async () => undefined,
  documentOwnerConflictResponse: () => null,
}));

const PREMIUM = { plan_tier: 'premium', effective_from: '2026-01-01', effective_to: null };
const FREE = { plan_tier: 'free', effective_from: '2026-01-01', effective_to: null };
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0x25, 0x45, 0x4f, 0x46]);
const CSV = new TextEncoder().encode('Date,Description,Amount\n2026-07-01,X,1.00\n');

function request(path: string, bytes: Uint8Array, headers: Record<string, string> = {}): Request {
  const req = new Request(`https://app.test${path}`, {
    method: 'POST',
    headers: { 'content-length': String(bytes.byteLength), ...headers },
    body: bytes,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  for (const m of ['arrayBuffer', 'json', 'text', 'blob'] as const) {
    const original = (req as unknown as Record<string, () => Promise<unknown>>)[m].bind(req);
    (req as unknown as Record<string, () => Promise<unknown>>)[m] = async () => { h.bodyReads += 1; return original(); };
  }
  return req;
}

const LIAB = '/api/financial-data-hub/liability-statement/upload?statement_type=credit_card&country_code=AU&currency_code=AUD';
const LIAB_LOAN = '/api/financial-data-hub/liability-statement/upload?statement_type=loan&country_code=AU&currency_code=AUD';
const RET = '/api/financial-data-hub/retirement-statement/upload?jurisdiction=AU&currency_code=AUD';
const INV = '/api/financial-data-hub/investment-statement/upload?csv_kind=portfolio&currency_code=AUD';

const ROUTES = [
  { name: 'liability', path: LIAB, flag: 'AIE_LIABILITY_PDF_ROUTE_ENABLED', load: () => import('@/app/api/financial-data-hub/liability-statement/upload/route'), service: async () => (await import('@/lib/financial-data-hub/services/liabilityStatementProcessingService')).uploadAndProcessLiabilityStatement },
  { name: 'retirement', path: RET, flag: 'AIE_RETIREMENT_PDF_ROUTE_ENABLED', load: () => import('@/app/api/financial-data-hub/retirement-statement/upload/route'), service: async () => (await import('@/lib/financial-data-hub/services/retirementStatementProcessingService')).uploadAndProcessRetirementStatement },
  { name: 'investment', path: INV, flag: 'AIE_AU_INVESTMENT_PDF_ROUTE_ENABLED', load: () => import('@/app/api/financial-data-hub/investment-statement/upload/route'), service: async () => (await import('@/lib/financial-data-hub/services/investmentStatementProcessingService')).uploadAndProcessAuInvestmentStatement },
] as const;

const FLAGS = ROUTES.map((r) => r.flag);
beforeEach(() => {
  h.state = newFakeState();
  h.state.entitlement = PREMIUM;
  h.bodyReads = 0;
  vi.clearAllMocks();
  for (const f of FLAGS) delete process.env[f];
});

describe.each(ROUTES)('$name PDF upload route', (route) => {
  it('Free: 403 PREMIUM_REQUIRED BEFORE the body is read, the service never reached (even with the PDF switch on)', async () => {
    h.state.entitlement = FREE;
    process.env[route.flag] = 'true';
    const { POST } = await route.load();
    const res = await POST(request(route.path, PDF));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PREMIUM_REQUIRED');
    expect(h.bodyReads).toBe(0);
    expect(vi.mocked(await route.service())).not.toHaveBeenCalled();
  });

  it('Free with a spoofed plan in the query and headers: identical refusal', async () => {
    h.state.entitlement = FREE;
    process.env[route.flag] = 'true';
    const { POST } = await route.load();
    const res = await POST(request(`${route.path}&plan_tier=premium&isPremium=true`, PDF, { 'x-plan-tier': 'premium', 'x-premium': 'true' }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PREMIUM_REQUIRED');
    expect(vi.mocked(await route.service())).not.toHaveBeenCalled();
  });

  it('Premium + PDF + switch OFF (the default): refused with plain words, the service never reached', async () => {
    const { POST } = await route.load();
    const res = await POST(request(route.path + (route.name === 'liability' ? '' : ''), PDF));
    expect(res.status).toBe(403);
    expect((await res.json()).error ?? '').toContain(PDF_ROUTE_DISABLED_MESSAGE.slice(0, 40));
    expect(vi.mocked(await route.service())).not.toHaveBeenCalled();
  });

  it('a switch with any value other than the literal "true" leaves the route off', async () => {
    const { POST } = await route.load();
    for (const v of ['1', 'TRUE', 'yes', 'on']) {
      process.env[route.flag] = v;
      const res = await POST(request(route.path, PDF));
      expect(res.status, v).toBe(403);
    }
    expect(vi.mocked(await route.service())).not.toHaveBeenCalled();
  });

  it('a CSV is never affected by the PDF switch (it reaches the service with the switch off)', async () => {
    const service = vi.mocked(await route.service());
    service.mockResolvedValue({ document: { id: 'd1', processing_status: 'queued' }, statementId: 's1', pipelineStatus: 'ok', positionsExtracted: 0, activitiesExtracted: 0 } as never);
    const { POST } = await route.load();
    const res = await POST(request(route.path, CSV));
    expect(res.status).toBe(200);
    expect(service).toHaveBeenCalledTimes(1);
  });

  it('Premium + PDF + switch ON: the service receives the PDF bytes', async () => {
    process.env[route.flag] = 'true';
    const service = vi.mocked(await route.service());
    service.mockResolvedValue({ document: { id: 'd1', processing_status: 'queued' }, statementId: 's1', pipelineStatus: 'ok', positionsExtracted: 0, activitiesExtracted: 0 } as never);
    const url = route.name === 'liability' ? `${route.path}` : route.path;
    const { POST } = await route.load();
    const res = await POST(request(url, PDF));
    expect(res.status).toBe(200);
    expect(service).toHaveBeenCalledTimes(1);
    const bytes = service.mock.calls[0][2] as Uint8Array;
    expect(Array.from(bytes.subarray(0, 5))).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
  });
});

describe('liability: a loan PDF needs the loan type chosen first', () => {
  it('without facility_type: 422 and the service is never reached; with it, the service gets the person\'s choice', async () => {
    process.env.AIE_LIABILITY_PDF_ROUTE_ENABLED = 'true';
    const service = vi.mocked((await import('@/lib/financial-data-hub/services/liabilityStatementProcessingService')).uploadAndProcessLiabilityStatement);
    service.mockResolvedValue({ document: { id: 'd1', processing_status: 'queued' }, statementId: 's1', pipelineStatus: 'ok' } as never);
    const { POST } = await import('@/app/api/financial-data-hub/liability-statement/upload/route');
    const no = await POST(request(LIAB_LOAN, PDF));
    expect(no.status).toBe(422);
    expect(service).not.toHaveBeenCalled();
    const bad = await POST(request(`${LIAB_LOAN}&facility_type=credit_card`, PDF));
    expect(bad.status).toBe(422);
    expect(service).not.toHaveBeenCalled();
    const yes = await POST(request(`${LIAB_LOAN}&facility_type=home_loan`, PDF));
    expect(yes.status).toBe(200);
    expect(service.mock.calls[0][1]).toMatchObject({ facilityType: 'home_loan', statementType: 'loan' });
  });
});

describe('size limits', () => {
  it('a PDF over 20 MB is refused before any service call; a CSV over 10 MB is refused too (liability and investment read the length first)', async () => {
    process.env.AIE_LIABILITY_PDF_ROUTE_ENABLED = 'true';
    const { POST } = await import('@/app/api/financial-data-hub/liability-statement/upload/route');
    const big = new Request(`https://app.test${LIAB}`, { method: 'POST', headers: { 'content-length': String(21 * 1024 * 1024) }, body: PDF, duplex: 'half' } as RequestInit & { duplex: 'half' });
    const res = await POST(big);
    expect(res.status).toBe(413);
    expect(vi.mocked((await import('@/lib/financial-data-hub/services/liabilityStatementProcessingService')).uploadAndProcessLiabilityStatement)).not.toHaveBeenCalled();
  });
});
