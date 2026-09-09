// LR-11 — Company entity API routes. Exercises the real route handlers via
// a typed fake Supabase client, mirroring tests/unit/accountCloseRoutes.
// test.ts's own pattern. NEG-08 "cross-entity data leak": every fetch below
// is scoped by BOTH the row's own id and the caller's user_id — a request
// for another tenant's entity/asset/liability must resolve as "not found",
// never leak the row or silently succeed against it.
import { describe, it, expect, vi } from 'vitest';

const USER_A = 'user-a';
const USER_B = 'user-b';

const { requireUserMock } = vi.hoisted(() => ({
  requireUserMock: vi.fn(() => ({ user: { id: 'user-a' }, unauthenticated: null })),
}));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireCountryConfirmedUser: () => requireUserMock() };
});

type FakeRow = Record<string, unknown>;

function makeFakeSupabase(tables: Record<string, FakeRow[]>) {
  const client = {
    from(table: string) {
      const rows = tables[table];
      if (!rows) throw new Error(`unexpected table: ${table}`);
      let filtered = [...rows];
      let mode: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let pendingWrite: FakeRow | null = null;
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          filtered = filtered.filter((r) => r[col] === val);
          return builder;
        },
        order() {
          return builder;
        },
        insert(row: FakeRow) {
          mode = 'insert';
          pendingWrite = row;
          return builder;
        },
        update(patch: FakeRow) {
          mode = 'update';
          pendingWrite = patch;
          return builder;
        },
        delete() {
          mode = 'delete';
          return builder;
        },
        single() {
          if (mode === 'insert') {
            const newRow: FakeRow = { id: `row-${rows.length + 1}`, is_active: true, ...pendingWrite };
            rows.push(newRow);
            return Promise.resolve({ data: newRow, error: null });
          }
          if (mode === 'update') {
            const target = filtered[0];
            if (!target) return Promise.resolve({ data: null, error: { message: 'not found' } });
            Object.assign(target, pendingWrite);
            return Promise.resolve({ data: target, error: null });
          }
          return Promise.resolve({ data: filtered[0] ?? null, error: filtered[0] ? null : { message: 'not found' } });
        },
        then(resolve: (v: { data: FakeRow[] | null; error: unknown }) => void) {
          if (mode === 'delete') {
            for (const r of filtered) {
              const idx = rows.indexOf(r);
              if (idx >= 0) rows.splice(idx, 1);
            }
            return Promise.resolve(resolve({ data: null, error: null }));
          }
          return Promise.resolve(resolve({ data: filtered, error: null }));
        },
      };
      return builder;
    },
  };
  return { client, tables };
}

function asUser(userId: string) {
  requireUserMock.mockReturnValue({ user: { id: userId }, unauthenticated: null });
}

describe('GET/POST /api/business-entities', () => {
  it('creates an entity owned by the caller and lists only the caller\'s own entities', async () => {
    vi.resetModules();
    asUser(USER_A);
    const fake = makeFakeSupabase({
      business_entities: [{ id: 'e-other', user_id: USER_B, name: 'Other Co', is_active: true }],
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { GET, POST } = await import('@/app/api/business-entities/route');

    const created = await POST(
      new Request('http://x', {
        method: 'POST',
        body: JSON.stringify({ name: 'My Co', ownership_percentage: 100, currency_code: 'AUD', valuation_mode: 'summary', summary_net_asset_value: 1000 }),
      })
    );
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.data.user_id).toBe(USER_A);
    expect(createdBody.data.entity_type).toBe('company');

    const listed = await GET();
    const listedBody = await listed.json();
    // NEG-08: user A's list never includes user B's entity, even though both
    // rows exist in the same fake table.
    expect(listedBody.data.every((e: FakeRow) => e.user_id === USER_A)).toBe(true);
    expect(listedBody.data.some((e: FakeRow) => e.id === 'e-other')).toBe(false);
  });

  // LR-13 — Family Trust fast-follow.
  it('creates a Family Trust entity when entity_type is explicitly requested', async () => {
    vi.resetModules();
    asUser(USER_A);
    const fake = makeFakeSupabase({ business_entities: [] });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { POST } = await import('@/app/api/business-entities/route');

    const created = await POST(
      new Request('http://x', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Smith Family Trust',
          entity_type: 'family_trust',
          ownership_percentage: 40,
          currency_code: 'AUD',
          valuation_mode: 'summary',
          summary_net_asset_value: 500_000,
        }),
      })
    );
    expect(created.status).toBe(200);
    const body = await created.json();
    expect(body.data.entity_type).toBe('family_trust');
    expect(body.data.user_id).toBe(USER_A);
  });
});

describe('NEG-08 — GET/PATCH/DELETE /api/business-entities/[id] cross-tenant isolation', () => {
  it('user B cannot read user A\'s entity through the single-entity route', async () => {
    vi.resetModules();
    asUser(USER_B);
    const fake = makeFakeSupabase({
      business_entities: [{ id: 'e-a', user_id: USER_A, name: 'A Co', is_active: true }],
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { GET } = await import('@/app/api/business-entities/[id]/route');
    const res = await GET(new Request('http://x'), { params: Promise.resolve({ id: 'e-a' }) });
    expect(res.status).toBe(404);
  });

  it('user B cannot update user A\'s entity', async () => {
    vi.resetModules();
    asUser(USER_B);
    const fake = makeFakeSupabase({
      business_entities: [{ id: 'e-a', user_id: USER_A, name: 'A Co', is_active: true, ownership_percentage: 100 }],
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { PATCH } = await import('@/app/api/business-entities/[id]/route');
    const res = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ name: 'Hijacked' }) }), {
      params: Promise.resolve({ id: 'e-a' }),
    });
    expect(res.status).not.toBe(200);
    const row = fake.tables.business_entities.find((r) => r.id === 'e-a')!;
    expect(row.name).toBe('A Co'); // untouched
  });

  it('user A can update their own entity', async () => {
    vi.resetModules();
    asUser(USER_A);
    const fake = makeFakeSupabase({
      business_entities: [{ id: 'e-a', user_id: USER_A, name: 'A Co', is_active: true, ownership_percentage: 100 }],
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { PATCH } = await import('@/app/api/business-entities/[id]/route');
    const res = await PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ ownership_percentage: 60 }) }), {
      params: Promise.resolve({ id: 'e-a' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ownership_percentage).toBe(60);
  });
});

describe('NEG-08 — asset/liability sub-resource cross-tenant isolation', () => {
  it('user B cannot list or delete an asset belonging to user A\'s entity', async () => {
    vi.resetModules();
    asUser(USER_B);
    const fake = makeFakeSupabase({
      business_entity_assets: [{ id: 'asset-a', user_id: USER_A, business_entity_id: 'e-a', label: 'Cash', value: 5000, currency_code: 'AUD' }],
    });
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => fake.client }));
    const { GET } = await import('@/app/api/business-entities/[id]/assets/route');
    const res = await GET(new Request('http://x'), { params: Promise.resolve({ id: 'e-a' }) });
    const body = await res.json();
    // Filtered by user_id, so user B's request for entity e-a's assets sees nothing.
    expect(body.data).toEqual([]);

    const { DELETE } = await import('@/app/api/business-entities/[id]/assets/[assetId]/route');
    await DELETE(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ assetId: 'asset-a' }) });
    expect(fake.tables.business_entity_assets).toHaveLength(1); // untouched — delete filtered by user_id found nothing
  });
});
