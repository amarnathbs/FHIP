// Mandatory Country Confirmation — regression test for the AI household
// scope-resolution gap (found during G4 application-wide capability-layer
// review, 2026-09-04, out of that task's scope; fixed as its own change).
//
// lib/ai/household/resolveHouseholdContext.ts used to call the plain,
// auth-only requireUser() instead of requireCountryConfirmedUser(). Every
// route that resolves its scope through it therefore enforced authentication
// but NOT the country-confirmation gate that ~241 other routes enforce (see
// app/api/ai/entitlement/route.ts for the canonical
// `requireCountryConfirmedUser as requireUser` pattern this file was
// missing). Unlike tests/unit/countryGateAccessMatrix.test.ts's MC-16
// reconciliation guard, which walks app/api/**/route.ts for a direct
// `requireUser` import, this gap was invisible to that guard: the affected
// routes only ever imported resolveHouseholdContext(), never requireUser
// directly, so the ungated call was one hop away inside lib/.
//
// This exercises every route that resolves scope through
// resolveHouseholdContext() FOR REAL (only the Supabase client and each
// route's downstream business-logic service are substituted) against a
// genuinely country-unconfirmed session, proving the fix actually closes
// all of them — and against a genuinely confirmed session, proving it
// didn't over-block a legitimate call.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { countryRegistryFrom } from './support/countryRegistryFake';

const USER_ID = 'user-under-test';
const HOUSEHOLD_ID = 'hh-under-test';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

type ProfileRow = {
  country_of_residence: string | null;
  country_confirmed_at: string | null;
  country_source: string | null;
  onboarding_completed: boolean;
};

const UNCONFIRMED: ProfileRow = {
  country_of_residence: 'AU',
  country_confirmed_at: null,
  country_source: null,
  onboarding_completed: true,
};

const CONFIRMED: ProfileRow = {
  country_of_residence: 'AU',
  country_confirmed_at: '2026-08-01T00:00:00Z',
  country_source: 'USER_CONFIRMED',
  onboarding_completed: true,
};

function fakeFromFor(profile: ProfileRow) {
  return (table: string) => {
    const registryHandler = countryRegistryFrom(table);
    if (registryHandler) return registryHandler;
    if (table === 'user_profiles') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) };
    }
    if (table === 'households') {
      return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: HOUSEHOLD_ID }, error: null }) }) }) };
    }
    throw new Error(`unexpected table in this test: ${table}`);
  };
}

// Every downstream business-logic service the affected routes call, mocked
// so this test isolates the country gate itself rather than each module's
// real database access. Each spy's default resolves successfully, so a test
// that gets PAST the gate can prove the route still works end to end.
const listCatalogueSpy = vi.fn(async (..._args: unknown[]) => ({ entitled: true, questions: [] }));
const resolveQuestionSpy = vi.fn(async (..._args: unknown[]) => ({ resolved: true }));
vi.mock('@/lib/ai/standardQuestions/service', () => ({
  AIStandardQuestionService: {
    listCatalogue: (...args: unknown[]) => listCatalogueSpy(...args),
    resolveQuestion: (...args: unknown[]) => resolveQuestionSpy(...args),
  },
}));

const resolveExplanationSpy = vi.fn(async (..._args: unknown[]) => ({ resolved: true }));
vi.mock('@/lib/ai/contextualExplanations/service', () => ({
  AIContextualExplanationService: {
    resolveExplanation: (...args: unknown[]) => resolveExplanationSpy(...args),
  },
}));

const isPersonalisedAIEligibleSpy = vi.fn(async (..._args: unknown[]) => true);
vi.mock('@/lib/ai/entitlement/aiEntitlementService', () => ({
  AIEntitlementService: {
    isPersonalisedAIEligible: (...args: unknown[]) => isPersonalisedAIEligibleSpy(...args),
    getAIPlanEntitlement: vi.fn(),
  },
}));

vi.mock('@/lib/ai/entitlement/capabilities', () => ({
  AI_CAPABILITY_IMPLEMENTED: { AI_CONTEXTUAL_EXPLANATIONS: true },
}));

const getPlatformControlsSpy = vi.fn(async (..._args: unknown[]) => ({ ai_globally_enabled: true, contextual_explanations_enabled: true }));
vi.mock('@/lib/ai/entitlement/platformControls', () => ({
  getPlatformControls: (...args: unknown[]) => getPlatformControlsSpy(...args),
}));

const loadContextualTargetRegistrySpy = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
vi.mock('@/lib/ai/contextualExplanations/registryDb', () => ({
  loadContextualTargetRegistry: (...args: unknown[]) => loadContextualTargetRegistrySpy(...args),
}));

const recordContextualExplanationMetricSpy = vi.fn();
vi.mock('@/lib/ai/observability/aiMetrics', () => ({
  recordContextualExplanationMetric: (...args: unknown[]) => recordContextualExplanationMetricSpy(...args),
}));

const resolveAnswerSpy = vi.fn(async (..._args: unknown[]) => ({ resolved: true }));
vi.mock('@/lib/ai/resolution/router', () => ({
  resolveAnswer: (...args: unknown[]) => resolveAnswerSpy(...args),
}));

const buildFinancialContextObjectSpy = vi.fn(async (..._args: unknown[]) => ({
  meta: { certification_status: 'CERTIFIED', currency_integrity_status: 'OK' },
  domain_certification: {},
}));
vi.mock('@/lib/ai/context/financialContextObject', () => ({
  buildFinancialContextObject: (...args: unknown[]) => buildFinancialContextObjectSpy(...args),
}));

const { GET: standardQuestionsGET } = await import('@/app/api/ai/standard-questions/route');
const { POST: standardQuestionResolvePOST } = await import('@/app/api/ai/standard-questions/[questionCode]/resolve/route');
const { GET: contextualExplanationsGET } = await import('@/app/api/ai/contextual-explanations/route');
const { POST: contextualExplanationResolvePOST } = await import('@/app/api/ai/contextual-explanations/resolve/route');
const { POST: internalResolvePOST } = await import('@/app/api/internal/ai/resolve/route');
const { GET: internalContextPreviewGET } = await import('@/app/api/internal/ai/context/preview/route');
const { POST: internalContextValidatePOST } = await import('@/app/api/internal/ai/context/validate/route');
const { __resetCountryRegistryCacheForTests } = await import('@/lib/services/countryGate');

function req(url: string, init?: RequestInit): Request {
  return new Request(url, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetCountryRegistryCacheForTests();
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
});

describe('resolveHouseholdContext.ts is fixed at the source, not just observed via route behaviour', () => {
  it('calls requireCountryConfirmedUser() and no longer imports the ungated requireUser', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../lib/ai/household/resolveHouseholdContext.ts'),
      'utf8'
    );
    // The header comment legitimately mentions requireUser() by name while
    // explaining the history of this fix, so the check below targets the
    // actual `import ... from '@/lib/api'` statement specifically rather
    // than banning the substring anywhere in the file.
    const importLine = src.match(/^import\s*\{[^}]*\}\s*from\s*'@\/lib\/api';?$/m)?.[0];
    expect(importLine).toBeDefined();
    expect(importLine).toMatch(/\brequireCountryConfirmedUser\b/);
    // Deliberately not just "no requireUser call" — the ungated helper must
    // not even be imported, so a future edit can't quietly reintroduce it.
    expect(importLine).not.toMatch(/\brequireUser\b/);
    expect(src).toMatch(/await requireCountryConfirmedUser\(\)/);
  });
});

describe('a country-unconfirmed (but authenticated) session is refused by every route resolving scope through resolveHouseholdContext()', () => {
  beforeEach(() => {
    mockFrom.mockImplementation(fakeFromFor(UNCONFIRMED));
  });

  it('GET /api/ai/standard-questions is blocked and never reaches the catalogue service', async () => {
    const res = await standardQuestionsGET();
    expect(res.status).not.toBe(200);
    expect((await res.json()).error).toBe('COUNTRY_CONFIRMATION_REQUIRED');
    expect(listCatalogueSpy).not.toHaveBeenCalled();
  });

  it('POST /api/ai/standard-questions/{questionCode}/resolve is blocked and never reaches the resolution service', async () => {
    const res = await standardQuestionResolvePOST(
      req('http://localhost/api/ai/standard-questions/SQ-AI-001/resolve', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({ questionCode: 'SQ-AI-001' }) }
    );
    expect(res.status).not.toBe(200);
    expect((await res.json()).error).toBe('COUNTRY_CONFIRMATION_REQUIRED');
    expect(resolveQuestionSpy).not.toHaveBeenCalled();
  });

  it('GET /api/ai/contextual-explanations is blocked and never reads entitlement or the target registry', async () => {
    const res = await contextualExplanationsGET();
    expect(res.status).not.toBe(200);
    expect((await res.json()).error).toBe('COUNTRY_CONFIRMATION_REQUIRED');
    expect(isPersonalisedAIEligibleSpy).not.toHaveBeenCalled();
    expect(loadContextualTargetRegistrySpy).not.toHaveBeenCalled();
  });

  it('POST /api/ai/contextual-explanations/resolve is blocked and never reaches the resolution service', async () => {
    const res = await contextualExplanationResolvePOST(
      req('http://localhost/api/ai/contextual-explanations/resolve', {
        method: 'POST',
        body: JSON.stringify({ target_code: 'SCORE_OVERALL' }),
      })
    );
    expect(res.status).not.toBe(200);
    expect((await res.json()).error).toBe('COUNTRY_CONFIRMATION_REQUIRED');
    expect(resolveExplanationSpy).not.toHaveBeenCalled();
  });

  it('POST /api/internal/ai/resolve is blocked and never reaches the resolution router', async () => {
    const res = await internalResolvePOST(
      req('http://localhost/api/internal/ai/resolve', { method: 'POST', body: JSON.stringify({ question: 'test' }) })
    );
    expect(res.status).not.toBe(200);
    expect((await res.json()).error).toBe('COUNTRY_CONFIRMATION_REQUIRED');
    expect(resolveAnswerSpy).not.toHaveBeenCalled();
  });

  it('GET /api/internal/ai/context/preview is blocked and never builds the financial context object', async () => {
    const res = await internalContextPreviewGET(req('http://localhost/api/internal/ai/context/preview'));
    expect(res.status).not.toBe(200);
    expect((await res.json()).error).toBe('COUNTRY_CONFIRMATION_REQUIRED');
    expect(buildFinancialContextObjectSpy).not.toHaveBeenCalled();
  });

  it('POST /api/internal/ai/context/validate is blocked and never builds the financial context object', async () => {
    const res = await internalContextValidatePOST(
      req('http://localhost/api/internal/ai/context/validate', { method: 'POST', body: '{}' })
    );
    expect(res.status).not.toBe(200);
    expect((await res.json()).error).toBe('COUNTRY_CONFIRMATION_REQUIRED');
    expect(buildFinancialContextObjectSpy).not.toHaveBeenCalled();
  });
});

describe('a genuinely country-confirmed session is NOT over-blocked by the fix', () => {
  beforeEach(() => {
    mockFrom.mockImplementation(fakeFromFor(CONFIRMED));
  });

  it('GET /api/ai/standard-questions succeeds and reaches the catalogue service with the session scope', async () => {
    const res = await standardQuestionsGET();
    expect(res.status).toBe(200);
    expect(listCatalogueSpy).toHaveBeenCalledWith(USER_ID, HOUSEHOLD_ID);
  });

  it('POST /api/ai/contextual-explanations/resolve succeeds and reaches the resolution service with the session scope', async () => {
    const res = await contextualExplanationResolvePOST(
      req('http://localhost/api/ai/contextual-explanations/resolve', {
        method: 'POST',
        body: JSON.stringify({ target_code: 'SCORE_OVERALL' }),
      })
    );
    expect(res.status).toBe(200);
    const [userId, householdId] = resolveExplanationSpy.mock.calls[0];
    expect(userId).toBe(USER_ID);
    expect(householdId).toBe(HOUSEHOLD_ID);
  });

  it('GET /api/internal/ai/context/preview succeeds and builds the context object for the session user', async () => {
    const res = await internalContextPreviewGET(req('http://localhost/api/internal/ai/context/preview'));
    expect(res.status).toBe(200);
    expect(buildFinancialContextObjectSpy).toHaveBeenCalled();
    expect(buildFinancialContextObjectSpy.mock.calls[0][0]).toBe(USER_ID);
  });
});
