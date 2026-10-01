/**
 * Owner-before-upload: GET /api/ownership/options is PURELY READ-ONLY; "Self" is
 * created by the explicit idempotent POST /api/ownership/self; and a role-only
 * "Spouse" can never come back (PO-OBU-03): a spouse is always a real household
 * member, added inline when missing.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';
import { ownerSelectionSchema } from '@/lib/ownership/ownerSelection';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, user: null as { id: string } | null }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.sessionClient(h.user!.id) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  requireCountryConfirmedUser: async () =>
    h.user ? { user: h.user } : { user: null, unauthenticated: Response.json({ error: 'unauthenticated' }, { status: 401 }) },
}));

const A = 'a0000000-0000-4000-8000-00000000000a';
const B = 'b0000000-0000-4000-8000-00000000000b';
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8').replace(/\r\n/g, '\n');

async function get(flow: string) {
  const route = await import('@/app/api/ownership/options/route');
  const res: Response = await route.GET(new Request(`http://local/x?flow=${flow}`));
  return { status: res.status, json: await res.json() as any, headers: res.headers };
}
async function postSelf() {
  const route = await import('@/app/api/ownership/self/route');
  const res: Response = await route.POST();
  return { status: res.status, json: await res.json() as any };
}
const members = (u: string) => h.db.rows('household_members').filter((m) => m.user_id === u);

beforeEach(() => {
  h.db = createFakeDb();
  h.user = { id: A };
  h.db.insert('user_profiles', { user_id: A, country_of_residence: 'AU', full_name: 'Anil Sharma' });
  h.db.insert('user_profiles', { user_id: B, country_of_residence: 'AU', full_name: 'Bob' });
});

describe('GET /api/ownership/options never writes', () => {
  it('a user with NO Self member: the read returns the list and creates NOTHING', async () => {
    const r = await get('bank');
    expect(r.status).toBe(200);
    expect(r.json.data.members).toEqual([]);
    expect(h.db.rows('household_members')).toHaveLength(0); // no side effect
    // repeated / prefetched reads are equally inert
    await get('ii_cas');
    await get('bank');
    expect(h.db.rows('household_members')).toHaveLength(0);
  });
  it('it is dynamic and no-store, and reads only the caller\'s own owners', async () => {
    h.db.insert('household_members', { id: 'a1111111-1111-4111-8111-111111111111', user_id: A, full_name: 'Anil', relationship: 'self', is_active: true });
    h.db.insert('household_members', { id: 'b1111111-1111-4111-8111-111111111111', user_id: B, full_name: 'Bob', relationship: 'self', is_active: true });
    const r = await get('bank');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.json.data.members.map((m: any) => m.label)).toEqual(['Anil']);
    expect(JSON.stringify(r.json)).not.toContain('Bob');
    const route = await import('@/app/api/ownership/options/route');
    expect((route as any).dynamic).toBe('force-dynamic');
  });
  it('the handler source contains no write call (structural control)', () => {
    const src = read('app/api/ownership/options/route.ts');
    expect(src).not.toMatch(/ensureSelfHouseholdMember|\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  });
  it('unauthenticated -> 401; unknown flow -> 422', async () => {
    h.user = null;
    expect((await get('bank')).status).toBe(401);
    h.user = { id: A };
    expect((await get('payslip')).status).toBe(422);
  });
});

describe('POST /api/ownership/self: the one place Self is created', () => {
  it('creates the caller\'s Self once from their own profile; a repeat is a no-op; it takes no input', async () => {
    const first = await postSelf();
    expect(first.status).toBe(200);
    expect(members(A)).toHaveLength(1);
    expect(members(A)[0]).toMatchObject({ relationship: 'self', full_name: 'Anil Sharma' });
    // The real table defaults is_active to true; the in-memory fake has no column defaults.
    for (const m of members(A)) if (m.is_active === undefined) m.is_active = true;
    const again = await postSelf();
    expect(again.json.data.memberId).toBe(first.json.data.memberId);
    expect(members(A)).toHaveLength(1); // idempotent
    expect(members(B)).toHaveLength(0); // never another user's
    const route = await import('@/app/api/ownership/self/route');
    expect(route.POST.length).toBe(0); // no request body or params are read
  });
  it('unauthenticated -> 401 and nothing is written', async () => {
    h.user = null;
    expect((await postSelf()).status).toBe(401);
    expect(h.db.rows('household_members')).toHaveLength(0);
  });
  it('after POST, GET offers Self first (the first-use journey)', async () => {
    expect((await get('bank')).json.data.members).toEqual([]);
    await postSelf();
    expect((await get('bank')).json.data.members.map((m: any) => `${m.label}:${m.ownerRole}`)).toEqual(['Anil Sharma:self']);
  });
});

describe('the selector: Self first, then the read; no role-only Spouse (PO-OBU-03)', () => {
  const selector = read('components/ownership/OwnerSelector.tsx');
  it("calls POST /api/ownership/self BEFORE GET /api/ownership/options, with no-store", () => {
    const post = selector.indexOf("fetch('/api/ownership/self', { method: 'POST' })");
    const getIdx = selector.indexOf('/api/ownership/options?flow=');
    expect(post).toBeGreaterThan(0);
    expect(getIdx).toBeGreaterThan(post);
    expect(selector).toMatch(/cache: 'no-store'/);
  });
  it('a bank user with no spouse/partner member is told to add one (a real member) and is never offered a bare role', () => {
    expect(selector).toContain('data-testid="no-spouse-hint"');
    expect(selector).toContain("m.ownerRole === 'spouse'");
    expect(selector).toMatch(/Add household member/);
    expect(selector).toMatch(/saved as a real household member and then selected/);
    // after saving, the NEW member's id is what is selected
    expect(selector).toMatch(/onChange\(\{ kind: 'member', memberId: id \}\)/);
    // no role-only value anywhere in the selector
    expect(selector).not.toMatch(/<option value="spouse"|handleChoice\('spouse'\)|kind: 'spouse'/);
  });
  it('bank restricts the inline relationship choices to spouse / partner', () => {
    expect(selector).toMatch(/flow === 'bank' \? RELATIONSHIPS\.filter\(\(r\) => r\.value === 'spouse' \|\| r\.value === 'partner'\)/);
  });
  it('the wire format can only name a real member id: a role is not a selection', () => {
    expect(ownerSelectionSchema.safeParse({ kind: 'member', role: 'spouse' }).success).toBe(false);
    expect(ownerSelectionSchema.safeParse({ kind: 'spouse' }).success).toBe(false);
    expect(ownerSelectionSchema.safeParse({ kind: 'member', memberId: 'spouse' }).success).toBe(false);
  });
  it('neither the bank query builder nor the panel carries a role parameter any more', () => {
    expect(read('components/expenses/bankUploadParams.ts')).not.toMatch(/owner_role/);
    expect(read('components/expenses/BankStatementImportPanel.tsx')).not.toMatch(/OWNER_OPTIONS|owner_role|setOwnerRole/);
  });
});
