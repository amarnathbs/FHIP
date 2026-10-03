// /api/investment-intelligence/investment-dates -- the immediate NAV fetch wiring
// (PO 2026-10-03). The service itself (fetch on save, failure never loses the
// answer, applied in the same request) is in iiInvestmentDateService.test.ts;
// this proves the route's part: it injects the ONE-fund live fetcher, returns the
// plain status to the UI, re-evaluates when a retry is what applied the answer,
// and gives the bounded fetch room without making the save depend on it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockUserFrom = vi.fn();
const submitInvestmentDate = vi.fn();
const recertifyPosition = vi.fn().mockResolvedValue({ ok: true, error: null });
const liveFetchNavForOneFund = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockUserFrom }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: () => ({}) }) }));
vi.mock('@/lib/services/investment-intelligence/investmentDateService', () => ({ listInvestmentDateItems: vi.fn(), submitInvestmentDate: (...a: unknown[]) => submitInvestmentDate(...a) }));
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistoryLive', () => ({ liveFetchNavForOneFund: (...a: unknown[]) => liveFetchNavForOneFund(...a) }));
vi.mock('@/lib/services/investment-intelligence/documentProcessing', () => ({ recertifyPosition: (...a: unknown[]) => recertifyPosition(...a) }));

import { POST } from '@/app/api/investment-intelligence/investment-dates/route';

const USER = 'user-1';
const post = (body: unknown) => POST(new Request('http://t/x', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  const db = createInMemoryDb();
  db.reset({ user_profiles: [{ user_id: USER, country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }] });
  mockUserFrom.mockImplementation((table: string) => countryRegistryFrom(table) ?? db.client.from(table));
  mockGetUser.mockResolvedValue({ data: { user: { id: USER, email: 'u@example.com' } } });
});

describe('investment-dates route: immediate NAV fetch wiring', () => {
  it('injects the one-fund live fetcher into the save, and returns the plain status to the UI', async () => {
    submitInvestmentDate.mockResolvedValue({ ok: true, state: 'awaiting_nav', navStatus: 'waiting_for_nav', message: 'We have your date. We will keep trying.', appliedNow: false, inputId: 'in-1', investmentDate: '2024-03-14', unchanged: false });
    const res = await post({ accountId: 'acc-1', instrumentId: 'ins-1', date: '14-03-2024' });
    expect(res.status).toBe(200);
    // The injected fetcher is the live one-fund fetcher (it takes a user and ONE fund id, nothing wider).
    liveFetchNavForOneFund.mockResolvedValue({ outcome: 'fetched' });
    await submitInvestmentDate.mock.calls[0][0].fetchNav({ userId: USER, instrumentId: 'ins-1' });
    expect(liveFetchNavForOneFund).toHaveBeenCalledWith({ userId: USER, instrumentId: 'ins-1' });
    expect(submitInvestmentDate.mock.calls[0][0].userId).toBe(USER);
    expect(await res.json()).toMatchObject({ data: { state: 'awaiting_nav', navStatus: 'waiting_for_nav', message: expect.stringContaining('keep trying') } });
    expect(recertifyPosition).not.toHaveBeenCalled();
  });

  it('re-evaluates when this request (including a RETRY of the same date) is what applied the answer', async () => {
    submitInvestmentDate.mockResolvedValue({ ok: true, state: 'applied', navStatus: 'applied', message: 'Done.', appliedNow: true, inputId: 'in-1', investmentDate: '2024-03-14', unchanged: true });
    await post({ accountId: 'acc-1', instrumentId: 'ins-1', date: '14-03-2024' });
    expect(recertifyPosition).toHaveBeenCalledWith(USER, 'acc-1', 'ins-1');
  });

  it('does not re-evaluate when nothing was applied by this request', async () => {
    submitInvestmentDate.mockResolvedValue({ ok: true, state: 'applied', navStatus: 'applied', message: 'Done.', appliedNow: false, inputId: 'in-1', investmentDate: '2024-03-14', unchanged: true });
    await post({ accountId: 'acc-1', instrumentId: 'ins-1', date: '14-03-2024' });
    expect(recertifyPosition).not.toHaveBeenCalled();
  });

  it('allows time for the bounded fetch (maxDuration); the fetch has its own 25s deadline inside it', async () => {
    const mod = await import('@/app/api/investment-intelligence/investment-dates/route');
    expect(mod.maxDuration).toBe(60);
  });
});
