// Document2 (4) WP-I, PO-D24-01: POST /api/forecast/retirement/family. Read only, signed-in, retirement only, answers { available: false } without an SMSF.
// EVIDENCE LABEL: UNIT-TESTED (the real route handler, the service mocked at its edge).
import { describe, expect, it, vi } from 'vitest';

const { userMock, viewMock } = vi.hoisted(() => ({
  userMock: vi.fn(),
  viewMock: vi.fn(),
}));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireCountryConfirmedUser: async () => userMock() };
});
vi.mock('@/lib/services/forecastData', () => ({ runFamilyRetirementView: viewMock }));

const post = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) });

describe('POST /api/forecast/retirement/family', () => {
  it('an unauthenticated caller gets the gate response and the service is never reached', async () => {
    viewMock.mockReset();
    userMock.mockReturnValue({ user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) });
    const { POST } = await import('@/app/api/forecast/retirement/family/route');
    const res = await POST(post({ forecast_type: 'retirement' }));
    expect(res.status).toBe(401);
    expect(viewMock).not.toHaveBeenCalled();
  });

  it('only the retirement forecast type is accepted', async () => {
    viewMock.mockReset();
    userMock.mockReturnValue({ user: { id: 'u1' }, unauthenticated: null });
    const { POST } = await import('@/app/api/forecast/retirement/family/route');
    const res = await POST(post({ forecast_type: 'net_worth' }));
    expect(res.status).toBe(422);
    expect(viewMock).not.toHaveBeenCalled();
  });

  it('passes the same options the personal run takes, scoped to the signed-in person only', async () => {
    viewMock.mockReset();
    viewMock.mockResolvedValue({ available: false, reason: 'no_smsf' });
    userMock.mockReturnValue({ user: { id: 'u1' }, unauthenticated: null });
    const { POST } = await import('@/app/api/forecast/retirement/family/route');
    const res = await POST(post({ forecast_type: 'retirement', retirement_target_method: 'target_corpus', retirement_target_corpus: 2_000_000, retirement_what_if_age_self: 62, user_id: 'someone-else' }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ available: false, reason: 'no_smsf' });
    expect(viewMock).toHaveBeenCalledTimes(1);
    expect(viewMock.mock.calls[0][0]).toBe('u1'); // never a user id from the body
    expect(viewMock.mock.calls[0][1]).toMatchObject({ retirementTargetMethod: 'target_corpus', retirementTargetCorpus: 2_000_000, whatIfRetirementAges: { self: 62, spouse: null } });
  });

  it('a failure is reported as an error with a readable message, not a stack', async () => {
    viewMock.mockReset();
    viewMock.mockRejectedValue(new Error('The family retirement position could not be worked out because your SMSF records could not be read. Try again in a moment.'));
    userMock.mockReturnValue({ user: { id: 'u1' }, unauthenticated: null });
    const { POST } = await import('@/app/api/forecast/retirement/family/route');
    const res = await POST(post({ forecast_type: 'retirement' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/could not be worked out/);
  });
});
