// /api/investment-intelligence/nav-history and the confirm routes' kick (PO
// extension 2026-10-03). NC-D4: the confirm response does not wait on the fetch.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockUserFrom = vi.fn();
const getUserNavHistoryStatus = vi.fn();
const runLiveUserNavHistoryBatch = vi.fn();
const applyPendingInvestmentDates = vi.fn();
const recertifyPosition = vi.fn().mockResolvedValue({ ok: true, error: null });
const kickUserNavHistory = vi.fn().mockReturnValue(true);
const processSourceDocument = vi.fn();
const applyAiExtractionReview = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockUserFrom }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: () => ({}) }) }));
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistory', () => ({ getUserNavHistoryStatus: (...a: unknown[]) => getUserNavHistoryStatus(...a) }));
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistoryLive', () => ({ runLiveUserNavHistoryBatch: (...a: unknown[]) => runLiveUserNavHistoryBatch(...a) }));
vi.mock('@/lib/services/investment-intelligence/investmentDateService', () => ({ applyPendingInvestmentDates: (...a: unknown[]) => applyPendingInvestmentDates(...a) }));
vi.mock('@/lib/services/investment-intelligence/documentProcessing', () => ({ recertifyPosition: (...a: unknown[]) => recertifyPosition(...a), processSourceDocument: (...a: unknown[]) => processSourceDocument(...a) }));
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistoryKick', () => ({ kickUserNavHistory: (...a: unknown[]) => kickUserNavHistory(...a) }));
vi.mock('@/lib/services/investment-intelligence/realScanAdmission', () => ({
  ensureIiRealScanAdmissible: async () => ({ admitted: true }),
  II_SCAN_PENDING_MESSAGE: 'p', II_SCAN_BLOCKED_MESSAGE: 'b', II_SCAN_UNAVAILABLE_MESSAGE: 'u',
}));
vi.mock('@/lib/services/investment-intelligence/aiExtractionReviewApply', () => ({ applyAiExtractionReview: (...a: unknown[]) => applyAiExtractionReview(...a) }));

import { GET, POST } from '@/app/api/investment-intelligence/nav-history/route';
import { POST as processPOST } from '@/app/api/investment-intelligence/source-documents/[id]/process/route';
import { POST as acceptPOST } from '@/app/api/investment-intelligence/ai-extraction-reviews/[reviewId]/accept/route';

const USER = 'user-1';
const status = { summary: { total: 2, loaded: 1, fetching: 1, waiting: 0, headline: 'Fetching price history for 1 of 2 funds', waitingLines: [] }, schemes: [{ instrumentId: 'f1', schemeName: 'Fund 1', state: 'pending', loadingFrom: '2022-01-01', gap: { state: 'gap' } }] };

beforeEach(() => {
  vi.clearAllMocks();
  const db = createInMemoryDb();
  db.reset({ user_profiles: [{ user_id: USER, country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }] });
  mockUserFrom.mockImplementation((table: string) => countryRegistryFrom(table) ?? db.client.from(table));
  mockGetUser.mockResolvedValue({ data: { user: { id: USER, email: 'u@example.com' } } });
  getUserNavHistoryStatus.mockResolvedValue(status);
  runLiveUserNavHistoryBatch.mockResolvedValue({ status, attempted: [{ instrumentId: 'f1' }], remaining: 1, rateLimited: false });
  applyPendingInvestmentDates.mockResolvedValue({ applied: 0, stillWaiting: 0, appliedPositions: [] });
});

describe('GET /nav-history', () => {
  it('401 unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect((await GET()).status).toBe(401);
  });
  it('is read-only: reports where the caller\'s funds stand and NEVER fetches', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()).data;
    expect(body.summary.headline).toBe('Fetching price history for 1 of 2 funds');
    expect(body.schemes[0]).toEqual({ instrumentId: 'f1', schemeName: 'Fund 1', state: 'pending', loadingFrom: '2022-01-01' }); // the internal gap object is not exposed
    expect(getUserNavHistoryStatus.mock.calls[0][1]).toBe(USER);
    expect(runLiveUserNavHistoryBatch).not.toHaveBeenCalled();
  });
});

describe('POST /nav-history ("check now")', () => {
  it('401 unauthenticated, fetching nothing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect((await POST()).status).toBe(401);
    expect(runLiveUserNavHistoryBatch).not.toHaveBeenCalled();
  });

  it('runs ONE slice for the caller only (it takes no body, so nothing wider can be named) and reports status in words', async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(runLiveUserNavHistoryBatch).toHaveBeenCalledTimes(1);
    expect(runLiveUserNavHistoryBatch).toHaveBeenCalledWith(USER);
    expect(POST.length).toBe(0); // no request parameter: no user-controlled input reaches the fetch
    const body = (await res.json()).data;
    expect(body).toMatchObject({ attempted: 1, remaining: 1, rateLimited: false, appliedDates: 0 });
    expect(body.summary.headline).toContain('Fetching price history');
  });

  it('applies saved investment dates that were waiting for this history and re-evaluates those positions', async () => {
    applyPendingInvestmentDates.mockResolvedValue({ applied: 1, stillWaiting: 0, appliedPositions: [{ accountId: 'acc-1', instrumentId: 'f1' }] });
    const res = await POST();
    expect((await res.json()).data.appliedDates).toBe(1);
    expect(recertifyPosition).toHaveBeenCalledWith(USER, 'acc-1', 'f1');
  });

  it('a failure applying dates never fails the slice; a failure of the slice is a soft 500 with "we will keep trying"', async () => {
    applyPendingInvestmentDates.mockRejectedValue(new Error('db'));
    expect((await POST()).status).toBe(200);
    runLiveUserNavHistoryBatch.mockRejectedValue(new Error('source down'));
    const res = await POST();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('We will keep trying');
  });
});

describe('NC-D4: the confirm routes kick the fetch and do not wait for it', () => {
  it('after a processed statement the route kicks for THIS user and returns the normal body', async () => {
    processSourceDocument.mockResolvedValue({ ok: true, status: 'parsed', parseRunId: 'r', summary: { transactionsFound: 3 }, error: null });
    const res = await processPOST(new Request('http://t/x', { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: 'doc-1' }) });
    expect(res.status).toBe(200);
    expect(kickUserNavHistory).toHaveBeenCalledTimes(1);
    expect(kickUserNavHistory).toHaveBeenCalledWith(USER);
    expect(runLiveUserNavHistoryBatch).not.toHaveBeenCalled(); // nothing was fetched inside the request
    expect((await res.json()).data.status).toBe('parsed');
  });

  it('the confirm succeeds even when the kick cannot be scheduled (false), and when nothing was processed nothing is kicked', async () => {
    kickUserNavHistory.mockReturnValue(false);
    processSourceDocument.mockResolvedValue({ ok: true, status: 'parsed', parseRunId: 'r', summary: { transactionsFound: 3 }, error: null });
    expect((await processPOST(new Request('http://t/x', { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: 'doc-1' }) })).status).toBe(200);
    kickUserNavHistory.mockClear();
    processSourceDocument.mockResolvedValue({ ok: false, status: 'parse_failed', parseRunId: 'r', error: 'x' });
    await processPOST(new Request('http://t/x', { method: 'POST', body: '{}' }), { params: Promise.resolve({ id: 'doc-1' }) });
    expect(kickUserNavHistory).not.toHaveBeenCalled();
  });

  it('accepting an AI extraction kicks as well, after the apply, and a failed accept kicks nothing', async () => {
    applyAiExtractionReview.mockResolvedValue({ ok: true, summary: { applied: true } });
    expect((await acceptPOST(new Request('http://t/x', { method: 'POST' }), { params: Promise.resolve({ reviewId: 'rv-1' }) })).status).toBe(200);
    expect(kickUserNavHistory).toHaveBeenCalledWith(USER);
    kickUserNavHistory.mockClear();
    applyAiExtractionReview.mockResolvedValue({ ok: false, code: 'already_decided', error: 'x' });
    expect((await acceptPOST(new Request('http://t/x', { method: 'POST' }), { params: Promise.resolve({ reviewId: 'rv-1' }) })).status).toBe(409);
    expect(kickUserNavHistory).not.toHaveBeenCalled();
  });
});
