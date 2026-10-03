// /api/investment-intelligence/investment-dates -- the route around the service
// (Document2 D-3, PO decision 2026-10-03). The service itself is covered in
// iiInvestmentDateService.test.ts; this proves the route's own contract:
// authentication, input shape, the typed date is sent to the server's validator
// (not parsed by the client), the existing re-evaluation is called once a date
// is applied, and the caller's id (never a body field) scopes everything.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockUserFrom = vi.fn();
const listInvestmentDateItems = vi.fn();
const submitInvestmentDate = vi.fn();
const recertifyPosition = vi.fn().mockResolvedValue({ ok: true, error: null });

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockUserFrom }) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: () => ({}) }) }));
vi.mock('@/lib/services/investment-intelligence/investmentDateService', () => ({
  listInvestmentDateItems: (...a: unknown[]) => listInvestmentDateItems(...a),
  submitInvestmentDate: (...a: unknown[]) => submitInvestmentDate(...a),
}));
const liveFetchNavForOneFund = vi.fn();
vi.mock('@/lib/services/investment-intelligence/pc6/userNavHistoryLive', () => ({ liveFetchNavForOneFund: (...a: unknown[]) => liveFetchNavForOneFund(...a) }));
vi.mock('@/lib/services/investment-intelligence/documentProcessing', () => ({ recertifyPosition: (...a: unknown[]) => recertifyPosition(...a) }));

import { GET, POST } from '@/app/api/investment-intelligence/investment-dates/route';

const USER = 'user-1';
const post = (body: unknown) => POST(new Request('http://t/x', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  const db = createInMemoryDb();
  db.reset({ user_profiles: [{ user_id: USER, country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }] });
  mockUserFrom.mockImplementation((table: string) => countryRegistryFrom(table) ?? db.client.from(table));
  mockGetUser.mockResolvedValue({ data: { user: { id: USER, email: 'u@example.com' } } });
});

describe('investment-dates route', () => {
  it('401 when unauthenticated (GET and POST), calling nothing', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect((await GET()).status).toBe(401);
    expect((await post({ accountId: 'a', instrumentId: 'i', date: '14-03-2024' })).status).toBe(401);
    expect(listInvestmentDateItems).not.toHaveBeenCalled();
    expect(submitInvestmentDate).not.toHaveBeenCalled();
  });

  it('GET lists for the caller only', async () => {
    listInvestmentDateItems.mockResolvedValue([{ accountId: 'a' }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).data.items).toEqual([{ accountId: 'a' }]);
    expect(listInvestmentDateItems.mock.calls[0][0]).toBe(USER);
  });

  it('POST rejects a malformed body without touching the service', async () => {
    expect((await post('not json')).status).toBe(422);
    expect((await post({ accountId: 'a' })).status).toBe(422);
    expect(submitInvestmentDate).not.toHaveBeenCalled();
  });

  it('POST hands the TYPED text to the server validator, scoped by the caller\'s id (a user id in the body is ignored)', async () => {
    submitInvestmentDate.mockResolvedValue({ ok: true, state: 'applied', navStatus: 'applied', message: 'Done.', appliedNow: true, inputId: 'in-1', investmentDate: '2024-03-14', unchanged: false });
    const res = await post({ accountId: 'acc-1', instrumentId: 'ins-1', date: '14-03-2024', userId: 'someone-else' });
    expect(res.status).toBe(200);
    expect(submitInvestmentDate.mock.calls[0][0]).toMatchObject({ userId: USER, accountId: 'acc-1', instrumentId: 'ins-1', dateText: '14-03-2024' });
    expect(submitInvestmentDate.mock.calls[0][0].todayIso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await res.json()).toMatchObject({ data: { state: 'applied', investmentDate: '2024-03-14' } });
  });

  it('re-evaluates the position (the existing Re-evaluate function) once a date is applied, but not on an unchanged repeat or while waiting for prices', async () => {
    submitInvestmentDate.mockResolvedValue({ ok: true, state: 'applied', navStatus: 'applied', message: 'Done.', appliedNow: true, inputId: 'in-1', investmentDate: '2024-03-14', unchanged: false });
    await post({ accountId: 'acc-1', instrumentId: 'ins-1', date: '14-03-2024' });
    expect(recertifyPosition).toHaveBeenCalledWith(USER, 'acc-1', 'ins-1');

    recertifyPosition.mockClear();
    submitInvestmentDate.mockResolvedValue({ ok: true, state: 'applied', navStatus: 'applied', message: 'Done.', appliedNow: false, inputId: 'in-1', investmentDate: '2024-03-14', unchanged: true });
    await post({ accountId: 'acc-1', instrumentId: 'ins-1', date: '14-03-2024' });
    submitInvestmentDate.mockResolvedValue({ ok: true, state: 'awaiting_nav', navStatus: 'waiting_for_nav', message: 'We will keep trying.', appliedNow: false, inputId: 'in-1', investmentDate: '2024-03-14', unchanged: false });
    await post({ accountId: 'acc-1', instrumentId: 'ins-1', date: '14-03-2024' });
    expect(recertifyPosition).not.toHaveBeenCalled();
  });

  it('a failure of the re-evaluation never undoes the saved date', async () => {
    submitInvestmentDate.mockResolvedValue({ ok: true, state: 'applied', navStatus: 'applied', message: 'Done.', appliedNow: true, inputId: 'in-1', investmentDate: '2024-03-14', unchanged: false });
    recertifyPosition.mockRejectedValueOnce(new Error('boom'));
    expect((await post({ accountId: 'acc-1', instrumentId: 'ins-1', date: '14-03-2024' })).status).toBe(200);
  });

  it('passes the service\'s refusal through with its status and a stable code', async () => {
    submitInvestmentDate.mockResolvedValue({ ok: false, status: 422, code: 'in_future', message: 'The investment date cannot be in the future.' });
    const res = await post({ accountId: 'acc-1', instrumentId: 'ins-1', date: '04-10-2026' });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'in_future', message: 'The investment date cannot be in the future.' });
    expect(recertifyPosition).not.toHaveBeenCalled();
  });
});
