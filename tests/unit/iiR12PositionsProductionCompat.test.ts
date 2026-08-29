// II-R12 terminal certification — production compatibility regression test.
//
// WHY THIS EXISTS: live read-only REST verification against the real
// production Supabase project (2026-08-26) proved `ii_holding_snapshots`
// does NOT have the `price_source` column that migration 0092 adds (0092 is
// not yet applied to production, per the standing R12 production-
// authorisation rule). The deployed GET /api/investment-intelligence/positions
// route unconditionally selected `price_source` in its query — which
// PostgREST rejects with `42703 column ... does not exist` regardless of
// RLS, breaking the position list for EVERY Investment Intelligence user in
// production, not just R12 users, since this is the same route the pre-R12
// dashboard/InvestmentIntelligenceClient has always used.
//
// This test proves the fix: the route detects that exact schema-absence
// condition and degrades to the pre-R12 shape (price_source always null)
// instead of failing the whole request. Any OTHER query error must still
// propagate as a 400 (never silently swallowed).
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
// requireUser() and the route's own createClient() call both resolve through
// this single mocked module — one client shape serves both.
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  }),
}));

import { GET } from '@/app/api/investment-intelligence/positions/route';

function rangeableQuery(pages: Array<{ data: unknown[] | null; error: { message: string } | null }>) {
  let call = 0;
  return {
    range: vi.fn(async () => pages[Math.min(call++, pages.length - 1)]),
  };
}

// Mandatory Country Confirmation (2026-08-29) added a country-confirmation
// pre-check to requireCountryConfirmedUser (aliased as requireUser in this
// route, per lib/api.ts) — every route.ts wired onto it now issues one extra
// `.from('user_profiles').select(...).eq(...).maybeSingle()` call before its
// own logic. This route's certification predates that change and mocked
// mockFrom to expect exactly one table name; a CONFIRMED, supported-country
// profile response for 'user_profiles' keeps this test's original intent
// (production-shape compatibility for ii_holding_snapshots) unaffected.
function withCountryConfirmed(handleOtherTable: (table: string) => unknown) {
  return (table: string) => {
    if (table === 'user_profiles') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                country_of_residence: 'AU',
                country_confirmed_at: '2026-08-29T00:00:00Z',
                country_source: 'USER_CONFIRMED',
                onboarding_completed: true,
              },
              error: null,
            }),
          }),
        }),
      };
    }
    return handleOtherTable(table);
  };
}

describe('II-R12 production compatibility: GET positions vs missing price_source column', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  });

  it('degrades gracefully (price_source: null) when the DB does not yet have the price_source column (production-shape)', async () => {
    const row = {
      id: 'snap-1',
      account_id: 'acc-1',
      instrument_id: 'inst-1',
      as_of_date: '2026-08-01',
      units: 10,
      value: 1000,
      currency_code: 'INR',
      quality_status: 'verified',
      created_at: '2026-08-01T00:00:00Z',
    };
    let selectCallCount = 0;
    mockFrom.mockImplementation(withCountryConfirmed((table: string) => {
      expect(table).toBe('ii_holding_snapshots');
      return {
        select: vi.fn((cols: string) => {
          selectCallCount++;
          if (cols.includes('price_source')) {
            // Simulates the real production error observed live.
            return {
              eq: () => ({
                order: () => ({
                  order: () => rangeableQuery([{ data: null, error: { message: 'column ii_holding_snapshots.price_source does not exist' } }]),
                }),
              }),
            };
          }
          // Fallback query without price_source succeeds.
          return {
            eq: () => ({
              order: () => ({
                order: () => rangeableQuery([{ data: [row], error: null }, { data: [], error: null }]),
              }),
            }),
          };
        }),
      };
    }));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].price_source).toBeNull();
    expect(body.data[0].priceFreshness).toBeNull();
    expect(body.data[0].id).toBe('snap-1');
    expect(selectCallCount).toBe(2); // first attempt (with price_source) + fallback
  });

  it('uses price_source normally once the column exists (post-0092 DEV/prod shape)', async () => {
    const row = {
      id: 'snap-2',
      account_id: 'acc-1',
      instrument_id: 'inst-2',
      as_of_date: '2026-08-01',
      units: 5,
      value: 500,
      currency_code: 'INR',
      quality_status: 'verified',
      created_at: '2026-08-01T00:00:00Z',
      price_source: 'manual_entry',
    };
    mockFrom.mockImplementation(withCountryConfirmed(() => ({
      select: vi.fn(() => ({
        eq: () => ({
          order: () => ({
            order: () => rangeableQuery([{ data: [row], error: null }, { data: [], error: null }]),
          }),
        }),
      })),
    })));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].price_source).toBe('manual_entry');
  });

  it('still propagates a genuine, unrelated database error as 400 (never silently swallowed)', async () => {
    mockFrom.mockImplementation(withCountryConfirmed(() => ({
      select: vi.fn(() => ({
        eq: () => ({
          order: () => ({
            order: () => rangeableQuery([{ data: null, error: { message: 'permission denied for table ii_holding_snapshots' } }]),
          }),
        }),
      })),
    })));

    const res = await GET();
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/permission denied/);
  });
});
