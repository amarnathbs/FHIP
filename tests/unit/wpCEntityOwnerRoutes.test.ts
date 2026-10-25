// DOCUMENT2 (4) review, WP-C, F21 / F22 / F23 (PO, 20-10-2026): the personal Liabilities, Income and Expenses registers are never a route into an
// SMSF, trust, HUF or company. A NEW row, or a change of owner TO an entity value, is refused with a coded 422 and writes nothing. An existing
// entity-tagged row stays editable in its other fields. EVIDENCE LABEL: UNIT-TESTED (real route handlers over the in-memory PostgREST fake).
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';
import { ENTITY_OWNER_REFUSED_CODE, introducesEntityOwner } from '@/lib/services/entityOwnerGuard';
import { liabilityGridConfig, incomeGridConfig, expenseGridConfig, insuranceGridConfig } from '@/lib/grid/configs';

const { userMock } = vi.hoisted(() => ({ userMock: vi.fn(() => ({ user: { id: 'user-a' }, unauthenticated: null, blocked: null })) }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, requireCountryConfirmedUser: () => userMock() };
});
vi.mock('@/lib/services/appCapability', () => ({ requireModuleCapability: async () => userMock() }));

async function world(tables: Record<string, Row[]>) {
  vi.resetModules();
  const db = createInMemoryDb();
  db.reset(tables);
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => db.client }));
  return db;
}
const post = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) });
const patchReq = (body: unknown) => new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const LIAB = { liability_name: 'SMSF property loan', balance: 370_000, currency_code: 'AUD', debt_type: 'mortgage' };

describe('the pure rule', () => {
  it('refuses a NEW entity owner and a change TO one, never an unchanged owner or a personal one', () => {
    expect(introducesEntityOwner('smsf')).toBe(true);
    expect(introducesEntityOwner('company', 'self')).toBe(true);
    expect(introducesEntityOwner('family_trust', null)).toBe(true);
    expect(introducesEntityOwner('smsf', 'smsf')).toBe(false);
    for (const o of ['self', 'spouse', 'joint', 'child', 'other', null, undefined]) expect(introducesEntityOwner(o as string | null | undefined, 'self')).toBe(false);
  });
});

describe('personal Liabilities (F21)', () => {
  it('POST owner smsf: coded 422, plain wording, NOTHING written', async () => {
    const db = await world({ liabilities: [] });
    const { POST } = await import('@/app/api/liabilities/route');
    const res = await POST(post({ ...LIAB, owner: 'smsf' }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe(ENTITY_OWNER_REFUSED_CODE);
    expect(body.message).toMatch(/SMSF/);
    expect(body.message).toMatch(/Investment & Retirement > SMSF/);
    expect(db.writes).toHaveLength(0);
    expect(db.tables.liabilities).toHaveLength(0);
  });

  it('POST with a personal owner still creates the row', async () => {
    const db = await world({ liabilities: [] });
    const { POST } = await import('@/app/api/liabilities/route');
    const res = await POST(post({ ...LIAB, owner: 'joint' }));
    expect(res.status).toBe(200);
    expect(db.tables.liabilities).toHaveLength(1);
  });

  it('PATCH changing the owner of a personal row TO smsf is refused; the row is untouched', async () => {
    const db = await world({ liabilities: [{ id: 'l1', user_id: 'user-a', owner: 'joint', balance: 100, is_active: true }] });
    const { PATCH } = await import('@/app/api/liabilities/[id]/route');
    const res = await PATCH(patchReq({ owner: 'smsf' }), params('l1'));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(ENTITY_OWNER_REFUSED_CODE);
    expect(db.tables.liabilities[0].owner).toBe('joint');
  });

  it('an EXISTING smsf-tagged row can still be edited (owner unchanged): PATCH and the grid upsert POST both succeed', async () => {
    const db = await world({ liabilities: [{ id: 'l2', user_id: 'user-a', owner: 'smsf', master_item_key: 'smsf_property_loan', balance: 365_000, is_active: true }] });
    const { PATCH } = await import('@/app/api/liabilities/[id]/route');
    const patched = await PATCH(patchReq({ owner: 'smsf', balance: 370_000 }), params('l2'));
    expect(patched.status).toBe(200);
    expect(db.tables.liabilities[0].balance).toBe(370_000);
    const { POST } = await import('@/app/api/liabilities/route');
    const upsert = await POST(post({ ...LIAB, owner: 'smsf', master_item_key: 'smsf_property_loan', balance: 371_000 }));
    expect(upsert.status).toBe(200);
  });

  it('another household\'s row cannot be changed to smsf either (scoped by user, answers like a missing row)', async () => {
    await world({ liabilities: [{ id: 'l3', user_id: 'user-b', owner: 'self', balance: 1, is_active: true }] });
    const { PATCH } = await import('@/app/api/liabilities/[id]/route');
    const res = await PATCH(patchReq({ owner: 'smsf' }), params('l3'));
    expect(res.status).toBe(422);
  });
});

describe('personal Income (F22) and Expenses (F23)', () => {
  it('POST /api/income owner smsf: coded 422 and nothing written', async () => {
    const db = await world({ income_sources: [] });
    const { POST } = await import('@/app/api/income/route');
    const res = await POST(post({ source_name: 'SMSF rent', amount: 600, frequency: 'weekly', currency_code: 'AUD', owner: 'smsf' }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(ENTITY_OWNER_REFUSED_CODE);
    expect(db.writes).toHaveLength(0);
  });

  it('POST /api/expenses owner smsf: coded 422 and nothing written', async () => {
    const db = await world({ expense_items: [] });
    const { POST } = await import('@/app/api/expenses/route');
    const res = await POST(post({ expense_name: 'SMSF audit fee', amount: 550, frequency: 'annually', currency_code: 'AUD', owner: 'smsf' }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe(ENTITY_OWNER_REFUSED_CODE);
    expect(db.writes).toHaveLength(0);
  });

  it('PATCH income / expense owner TO smsf is refused', async () => {
    await world({ income_sources: [{ id: 'i1', user_id: 'user-a', owner: 'self', is_active: true }], expense_items: [{ id: 'x1', user_id: 'user-a', owner: 'self', is_active: true }] });
    const inc = await import('@/app/api/income/[id]/route');
    const exp = await import('@/app/api/expenses/[id]/route');
    expect((await inc.PATCH(patchReq({ owner: 'smsf' }), params('i1'))).status).toBe(422);
    expect((await exp.PATCH(patchReq({ owner: 'smsf' }), params('x1'))).status).toBe(422);
  });
});

describe('the grids stop offering the entity owner (and the SMSF loan catalogue item) for new rows', () => {
  it.each([['liability', liabilityGridConfig], ['income', incomeGridConfig], ['expense', expenseGridConfig]] as const)('%s grid hides smsf, company and family_trust from new selection', (_n, cfg) => {
    const hidden = (cfg.restrictedOwnerValues ?? []).filter((r) => r.requiredCountry === undefined).map((r) => r.value);
    expect(hidden).toEqual(expect.arrayContaining(['smsf', 'company', 'family_trust']));
  });

  it('the Insurance grid keeps its own AU-only SMSF rule (unchanged)', () => {
    expect((insuranceGridConfig.restrictedOwnerValues ?? []).some((r) => r.value === 'smsf' && r.requiredCountry === 'AU')).toBe(true);
  });

  it('personal Liabilities withholds the SMSF property loan catalogue item from the picker, and the grid keeps saved rows visible', () => {
    expect(liabilityGridConfig.withholdMasterItemKeysFromPicker).toContain('smsf_property_loan');
  });
});
