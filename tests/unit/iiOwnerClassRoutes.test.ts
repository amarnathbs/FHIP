/**
 * Owner-class scope on the Investment Intelligence API (2026-10-01).
 *
 *  - GET owner-classes lists only the caller's own classes;
 *  - `?ownerClass=<key>` is validated against the caller's OWN classes (another
 *    user's key, or an unknown one, is a 404 with no leak);
 *  - a scoped run NEVER persists (SIP route spy), the consolidated run still does;
 *  - the response says which class (or "Consolidated (macro view only)") it is.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createInMemoryDb, type InMemoryDb, type Row } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';

const mockGetUser = vi.fn();
const mockUserFrom = vi.fn();
const { loadSipDatasetMock, persistMock, runSipMock } = vi.hoisted(() => ({
  loadSipDatasetMock: vi.fn(),
  persistMock: vi.fn(),
  runSipMock: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockUserFrom }) }));
vi.mock('@/lib/services/investment-intelligence/r5Repository', () => ({
  loadSipDataset: loadSipDatasetMock,
  attachAttributableInflows: vi.fn(),
  persistR5Results: persistMock,
}));
vi.mock('@/lib/engines/investment-intelligence/sip/sipOrchestrator', () => ({ runSipAnalytics: runSipMock }));

import { GET as OWNER_CLASSES } from '@/app/api/investment-intelligence/owner-classes/route';
import { GET as SIP } from '@/app/api/investment-intelligence/sip/route';
import { resolveOwnerClassScope } from '@/lib/services/investment-intelligence/ownerClassScope';

const USER_A = 'user-a';
const USER_B = 'user-b';
let db: InMemoryDb;

function seed() {
  db = createInMemoryDb();
  const profile = (u: string) => ({ user_id: u, country_of_residence: 'IN', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true });
  db.reset({
    user_profiles: [profile(USER_A), profile(USER_B)],
    ii_accounts: [
      { id: 'a-asha', user_id: USER_A, owner_member_id: 'm-asha' },
      { id: 'a-trust', user_id: USER_A, owner_member_id: null },
      { id: 'a-bella', user_id: USER_B, owner_member_id: 'm-bella' },
    ],
    ii_ownership_allocation: [{ id: 'o1', user_id: USER_A, ii_account_id: 'a-trust', owner_member_id: null, owner_business_entity_id: 'e-trust', allocation_basis_points: 10000, ii_instrument_id: null, status: 'active' }],
    household_members: [
      { id: 'm-asha', user_id: USER_A, full_name: 'Asha Rao', relationship: 'self' },
      { id: 'm-bella', user_id: USER_B, full_name: 'Bella Other', relationship: 'self' },
    ],
    business_entities: [{ id: 'e-trust', user_id: USER_A, name: 'Rao Family Trust', entity_type: 'family_trust' }],
  } as Record<string, Row[]>);
  mockUserFrom.mockImplementation((t: string) => countryRegistryFrom(t) ?? db.client.from(t));
}

const get = (url: string) => new Request(`http://test${url}`);
const json = async (r: Response) => (await r.json()) as { data?: Record<string, unknown>; error?: string };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_A, email: 'a@example.com' } } });
  seed();
  loadSipDatasetMock.mockResolvedValue({ dataset: { transactions: [] }, warnings: [], empty: false });
  persistMock.mockResolvedValue({ persisted: 0, error: null });
  runSipMock.mockReturnValue({ asOfDate: '2024-07-31', engineVersion: 'x', seriesCount: 0, presentableCount: 0, analytics: [] });
});

describe('GET owner-classes', () => {
  it('lists this user\'s classes with account counts, plus the explicit macro option; never another user\'s', async () => {
    const res = await OWNER_CLASSES();
    expect(res.status).toBe(200);
    const d = (await json(res)).data as { consolidated: { key: string; label: string }; classes: { key: string; accountCount: number }[] };
    expect(d.consolidated).toMatchObject({ key: 'all', label: 'Consolidated (macro view only)' });
    expect(d.classes.map((c) => [c.key, c.accountCount])).toEqual([['member:m-asha', 1], ['entity:e-trust', 1]]);
    expect(JSON.stringify(d)).not.toMatch(/Bella|m-bella/);
  });
  it('401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect((await OWNER_CLASSES()).status).toBe(401);
  });
});

describe('resolveOwnerClassScope', () => {
  const resolve = (qs: string, userId = USER_A) => resolveOwnerClassScope(get(`/x${qs}`), db.client as never, userId);

  it('absent or "all" is the consolidated behaviour, unchanged (inactive, the same client)', async () => {
    for (const qs of ['', '?ownerClass=all']) {
      const s = await resolve(qs);
      expect(s.ok && !s.active && s.client === (db.client as never)).toBe(true);
    }
  });
  it('a known class activates a read-only scoped client', async () => {
    const s = await resolve('?ownerClass=entity:e-trust');
    expect(s.ok && s.active && s.ownerClass.label).toBe('Rao Family Trust');
  });
  it('NEGATIVE CONTROL [tenant isolation]: another user\'s class key, and an unknown key, are 404 OWNER_CLASS_NOT_FOUND', async () => {
    for (const key of ['member:m-bella', 'member:nobody', 'entity:e-ghost']) {
      const s = await resolve(`?ownerClass=${key}`);
      expect(s.ok).toBe(false);
      if (!s.ok) {
        expect(s.response.status).toBe(404);
        expect((await json(s.response)).error).toBe('OWNER_CLASS_NOT_FOUND');
      }
    }
  });
});

describe('SIP route: a per-class run never persists', () => {
  it('consolidated run persists (control); a scoped run does not, and says which class it is', async () => {
    const all = await SIP(get('/api/investment-intelligence/sip'));
    expect(all.status).toBe(200);
    expect(persistMock).toHaveBeenCalledTimes(1);
    expect(((await json(all)).data as { ownerClass: { key: string } }).ownerClass.key).toBe('all');

    persistMock.mockClear();
    const scoped = await SIP(get('/api/investment-intelligence/sip?ownerClass=entity:e-trust'));
    expect(scoped.status).toBe(200);
    expect(persistMock).not.toHaveBeenCalled();
    expect(((await json(scoped)).data as { ownerClass: { key: string; kind: string } }).ownerClass).toMatchObject({ key: 'entity:e-trust', kind: 'entity' });
  });

  it('the loader receives a client narrowed to the class\'s accounts (not the raw client)', async () => {
    await SIP(get('/api/investment-intelligence/sip?ownerClass=entity:e-trust'));
    const clientArg = loadSipDatasetMock.mock.calls[0][0] as { from: (t: string) => { select: (c: string) => PromiseLike<{ data: unknown[] }> } };
    db.tables.ii_transactions = [
      { id: 't1', user_id: USER_A, account_id: 'a-asha' },
      { id: 't2', user_id: USER_A, account_id: 'a-trust' },
    ];
    const rows = await clientArg.from('ii_transactions').select('id');
    expect(rows.data.map((r) => (r as Row).id)).toEqual(['t2']);
  });

  it('NEGATIVE CONTROL [unknown class]: a foreign key is refused before any loader runs', async () => {
    const res = await SIP(get('/api/investment-intelligence/sip?ownerClass=member:m-bella'));
    expect(res.status).toBe(404);
    expect(loadSipDatasetMock).not.toHaveBeenCalled();
  });
});
