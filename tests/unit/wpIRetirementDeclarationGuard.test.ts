// DOCUMENT2 (4) WP-I, PO-D24-02 (21-10-2026): the server-side invariant behind "I don't have any retirement savings".
// The two canonical write routes (PUT /api/user/profile and PUT /api/user/section-status) refuse to SAVE the declaration as true while the
// person holds an active retirement account or an active SMSF, with a readable 409 and nothing written. EVIDENCE LABEL: UNIT-TESTED (the real
// route handlers over the in-memory PostgREST fake); the database half (migration 0298) is in wpIRetirementDeclarationGuardPglite.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type InMemoryDb, type Row } from './support/inMemorySupabase';
import {
  RETIREMENT_DECLARATION_CONFLICT_CODE,
  loadRetirementDeclarationBlockers,
  retirementDeclarationRefusalMessage,
} from '@/lib/services/retirementDeclarationGuard';

const { userMock } = vi.hoisted(() => ({ userMock: vi.fn(() => ({ id: 'user-a' })) }));
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    requireCountryConfirmedUser: async () => ({ user: userMock(), unauthenticated: null, blocked: null }),
    requireCountryConfirmedUserAllowingGeneric: async () => ({ user: userMock(), unauthenticated: null, blocked: null }),
  };
});

type Hook = (table: string, op: 'update' | 'upsert') => void;

/** A world whose client can run a hook just before a write reaches a table (to model another request landing in the gap). */
async function world(tables: Record<string, Row[]>, beforeWrite?: Hook): Promise<InMemoryDb> {
  vi.resetModules();
  userMock.mockReturnValue({ id: 'user-a' });
  const db = createInMemoryDb({ upsertMerges: true });
  db.reset(tables);
  const client = {
    from: (table: string) => {
      const chain = db.client.from(table) as Record<string, (...a: unknown[]) => unknown>;
      if (!beforeWrite) return chain;
      return new Proxy(chain, {
        get(target, prop: string) {
          if (prop === 'update' || prop === 'upsert') {
            return (...args: unknown[]) => {
              beforeWrite(table, prop as 'update' | 'upsert');
              return target[prop](...args);
            };
          }
          return target[prop];
        },
      });
    },
    auth: { getUser: async () => ({ data: { user: userMock() } }) },
  };
  vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
  return db;
}

const put = (body: unknown) => new Request('http://x', { method: 'PUT', body: JSON.stringify(body) });
const PROFILE = { full_name: 'Test Person', country_of_residence: 'AU', preferred_currency: 'AUD' };

const profile = (flag = false, user = 'user-a'): Row => ({ user_id: user, full_name: 'Test Person', country_of_residence: 'AU', preferred_currency: 'AUD', not_applicable_retirement: flag });
const account = (id: string, user = 'user-a', extra: Row = {}): Row => ({ id, user_id: user, account_name: id, master_item_key: 'industry_super', is_active: true, current_balance: 100_000, ...extra });
const smsfMirror = (user = 'user-a'): Row => account('smsf-mirror', user, { master_item_key: 'smsf', account_name: 'SMSF' });
const fund = (id: string, user = 'user-a', extra: Row = {}): Row => ({ id, user_id: user, retirement_account_id: 'smsf-mirror', fund_name: 'Test SMSF', is_active: true, ...extra });

async function profilePut(body: Row) {
  const { PUT } = await import('@/app/api/user/profile/route');
  return PUT(put({ ...PROFILE, ...body }));
}
async function sectionPut(body: Row) {
  const { PUT } = await import('@/app/api/user/section-status/route');
  return PUT(put(body));
}

describe('the message says what happened, why, and how to fix it', () => {
  it('counts accounts and SMSFs in plain words, with singular and plural', () => {
    expect(retirementDeclarationRefusalMessage({ activeAccounts: 2, activeSmsfFunds: 1, total: 3 })).toMatch(/2 active retirement accounts and an active SMSF/);
    expect(retirementDeclarationRefusalMessage({ activeAccounts: 1, activeSmsfFunds: 0, total: 1 })).toMatch(/1 active retirement account,/);
    const m = retirementDeclarationRefusalMessage({ activeAccounts: 0, activeSmsfFunds: 1, total: 1 });
    expect(m).toMatch(/not saved/i); // what happened
    expect(m).toMatch(/contradict/i); // why
    expect(m).toMatch(/Remove or deactivate it first/); // how to fix
    expect(m).not.toMatch(/retirement account/); // an SMSF-only person is not told about accounts they do not have
  });
});

describe('PUT /api/user/profile (direct API, no UI)', () => {
  it('refuses the declaration with 409 while accounts AND an SMSF exist; nothing is written to the profile', async () => {
    const db = await world({
      user_profiles: [profile()],
      retirement_accounts: [account('a1'), account('a2'), smsfMirror()],
      smsf_funds: [fund('f1')],
    });
    const res = await profilePut({ not_applicable_retirement: true });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe(RETIREMENT_DECLARATION_CONFLICT_CODE);
    expect(body.error).toBe(body.message);
    expect(body.message).toMatch(/2 active retirement accounts and an active SMSF/);
    expect(body.blockers).toEqual({ activeAccounts: 2, activeSmsfFunds: 1, total: 3 });
    expect(db.tables.user_profiles[0].not_applicable_retirement).toBe(false);
    expect(db.writes.filter((w) => w.table === 'user_profiles')).toHaveLength(0);
  });

  it('SMSF-only: the fund (and its mirror row) is refused as ONE item, and the message does not invent accounts', async () => {
    const db = await world({ user_profiles: [profile()], retirement_accounts: [smsfMirror()], smsf_funds: [fund('f1')] });
    const res = await profilePut({ not_applicable_retirement: true });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.blockers).toEqual({ activeAccounts: 0, activeSmsfFunds: 1, total: 1 });
    expect(body.message).toMatch(/an active SMSF/);
    expect(body.message).not.toMatch(/retirement accounts?[ ,]/);
    expect(db.tables.user_profiles[0].not_applicable_retirement).toBe(false);
  });

  it('inactive accounts and an inactive SMSF do not block the declaration', async () => {
    const db = await world({
      user_profiles: [profile()],
      retirement_accounts: [account('a1', 'user-a', { is_active: false }), account('a2', 'user-a', { is_active: false }), smsfMirror()],
      smsf_funds: [fund('f1', 'user-a', { is_active: false })],
    });
    const res = await profilePut({ not_applicable_retirement: true });
    expect(res.status).toBe(200);
    expect(db.tables.user_profiles[0].not_applicable_retirement).toBe(true);
  });

  it('an account with a missing is_active (database default true) counts as active', async () => {
    await world({ user_profiles: [profile()], retirement_accounts: [{ id: 'a1', user_id: 'user-a', master_item_key: null }], smsf_funds: [] });
    const res = await profilePut({ not_applicable_retirement: true });
    expect(res.status).toBe(409);
  });

  it('a person with no retirement items can declare it', async () => {
    const db = await world({ user_profiles: [profile()], retirement_accounts: [], smsf_funds: [] });
    const res = await profilePut({ not_applicable_retirement: true });
    expect(res.status).toBe(200);
    expect(db.tables.user_profiles[0].not_applicable_retirement).toBe(true);
  });

  it('clearing the declaration is never refused, even next to active accounts (the person is fixing the contradiction)', async () => {
    const db = await world({ user_profiles: [profile(true)], retirement_accounts: [account('a1')], smsf_funds: [] });
    const res = await profilePut({ not_applicable_retirement: false });
    expect(res.status).toBe(200);
    expect(db.tables.user_profiles[0].not_applicable_retirement).toBe(false);
  });

  it('a profile save that does not touch the declaration is unaffected by it', async () => {
    const db = await world({ user_profiles: [profile(true)], retirement_accounts: [account('a1')], smsf_funds: [] });
    const res = await profilePut({ full_name: 'New Name' });
    expect(res.status).toBe(200);
    expect(db.tables.user_profiles[0].full_name).toBe('New Name');
  });

  it('the other two declarations (investments, insurance) are not changed by this rule', async () => {
    const db = await world({ user_profiles: [profile()], retirement_accounts: [account('a1')], smsf_funds: [] });
    const res = await profilePut({ not_applicable_investments: true });
    expect(res.status).toBe(200);
    expect(db.tables.user_profiles[0].not_applicable_investments).toBe(true);
  });

  it('TWO-USER ISOLATION: another person\'s accounts neither block nor are touched by this person\'s declaration', async () => {
    const db = await world({
      user_profiles: [profile(false, 'user-a'), profile(false, 'user-b')],
      retirement_accounts: [account('b1', 'user-b'), account('b2', 'user-b')],
      smsf_funds: [fund('fb', 'user-b')],
    });
    const res = await profilePut({ not_applicable_retirement: true });
    expect(res.status).toBe(200); // user-a holds nothing, whatever user-b holds
    expect(db.tables.user_profiles.find((p) => p.user_id === 'user-a')!.not_applicable_retirement).toBe(true);
    expect(db.tables.user_profiles.find((p) => p.user_id === 'user-b')!.not_applicable_retirement).toBe(false);
    // and the other way round: user-b is blocked by its own items only
    userMock.mockReturnValue({ id: 'user-b' });
    const resB = await profilePut({ not_applicable_retirement: true });
    expect(resB.status).toBe(409);
    expect((await resB.json()).blockers).toEqual({ activeAccounts: 2, activeSmsfFunds: 1, total: 3 });
  });

  it('NO RACE: an account that lands between the check and the write is caught by the re-check and the declaration is put back', async () => {
    let injected = false;
    const db = await world({ user_profiles: [profile()], retirement_accounts: [], smsf_funds: [] }, (table, op) => {
      if (table === 'user_profiles' && op === 'update' && !injected) {
        injected = true; // the other request commits an account right before this write
        db.tables.retirement_accounts.push(account('late'));
      }
    });
    const res = await profilePut({ not_applicable_retirement: true });
    expect(injected).toBe(true);
    expect(res.status).toBe(409);
    expect((await res.json()).blockers.activeAccounts).toBe(1);
    expect(db.tables.user_profiles[0].not_applicable_retirement).toBe(false); // reverted to what it was
  });

  it('NEGATIVE CONTROL: the same race WITHOUT the re-check leaves the contradiction behind (so the test above can fail)', async () => {
    // Replays the old behaviour by hand: check passes, an account lands, the write goes through, nothing re-checks.
    const db = await world({ user_profiles: [profile()], retirement_accounts: [], smsf_funds: [] });
    const client = (await import('@/lib/supabase/server')) as unknown as { createClient: () => Promise<{ from: (t: string) => { update: (p: Row) => { eq: (c: string, v: string) => Promise<unknown> } } }> };
    const sb = await client.createClient();
    expect((await loadRetirementDeclarationBlockers(sb as never, 'user-a')).total).toBe(0); // the check
    db.tables.retirement_accounts.push(account('late')); // the other request
    await sb.from('user_profiles').update({ not_applicable_retirement: true }).eq('user_id', 'user-a'); // the write
    expect(db.tables.user_profiles[0].not_applicable_retirement).toBe(true); // contradiction
    expect((await loadRetirementDeclarationBlockers(sb as never, 'user-a')).total).toBe(1);
  });
});

describe('PUT /api/user/section-status (direct API, no UI)', () => {
  it('refuses retirement not_applicable with 409 while an account or the SMSF exists; no row is written', async () => {
    const db = await world({ user_financial_section_status: [], retirement_accounts: [account('a1')], smsf_funds: [fund('f1')] });
    const res = await sectionPut({ section: 'retirement', status: 'not_applicable' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe(RETIREMENT_DECLARATION_CONFLICT_CODE);
    expect(body.message).toMatch(/1 active retirement account and an active SMSF/);
    expect(db.tables.user_financial_section_status).toHaveLength(0);
    expect(db.writes.filter((w) => w.table === 'user_financial_section_status')).toHaveLength(0);
  });

  it('SMSF-only is refused', async () => {
    const db = await world({ user_financial_section_status: [], retirement_accounts: [smsfMirror()], smsf_funds: [fund('f1')] });
    const res = await sectionPut({ section: 'retirement', status: 'not_applicable' });
    expect(res.status).toBe(409);
    expect(db.tables.user_financial_section_status).toHaveLength(0);
  });

  it('inactive items do not block it', async () => {
    const db = await world({
      user_financial_section_status: [],
      retirement_accounts: [account('a1', 'user-a', { is_active: false })],
      smsf_funds: [fund('f1', 'user-a', { is_active: false })],
    });
    const res = await sectionPut({ section: 'retirement', status: 'not_applicable' });
    expect(res.status).toBe(200);
    expect(db.tables.user_financial_section_status[0]).toMatchObject({ user_id: 'user-a', section: 'retirement', status: 'not_applicable' });
  });

  it('clearing (null) and the other states are not refused; other sections are unaffected by retirement holdings', async () => {
    const db = await world({
      user_financial_section_status: [{ user_id: 'user-a', section: 'retirement', status: 'not_applicable' }],
      retirement_accounts: [account('a1')],
      smsf_funds: [],
    });
    expect((await sectionPut({ section: 'retirement', status: null })).status).toBe(200);
    expect(db.tables.user_financial_section_status.find((r) => r.section === 'retirement')).toBeUndefined();
    expect((await sectionPut({ section: 'retirement', status: 'reviewed_with_data' })).status).toBe(200);
    expect((await sectionPut({ section: 'insurance', status: 'not_applicable' })).status).toBe(200);
  });

  it('TWO-USER ISOLATION: user-b\'s accounts do not block user-a', async () => {
    const db = await world({ user_financial_section_status: [], retirement_accounts: [account('b1', 'user-b')], smsf_funds: [fund('fb', 'user-b')] });
    expect((await sectionPut({ section: 'retirement', status: 'not_applicable' })).status).toBe(200);
    expect(db.tables.user_financial_section_status.every((r) => r.user_id === 'user-a')).toBe(true);
    userMock.mockReturnValue({ id: 'user-b' });
    expect((await sectionPut({ section: 'retirement', status: 'not_applicable' })).status).toBe(409);
  });

  it('NO RACE: an account that lands between the check and the write is caught by the re-check and the earlier confirmation is restored', async () => {
    let injected = false;
    const db = await world(
      { user_financial_section_status: [{ user_id: 'user-a', section: 'retirement', status: 'reviewed_zero' }], retirement_accounts: [], smsf_funds: [] },
      (table, op) => {
        if (table === 'user_financial_section_status' && op === 'upsert' && !injected) {
          injected = true;
          db.tables.retirement_accounts.push(account('late'));
        }
      },
    );
    const res = await sectionPut({ section: 'retirement', status: 'not_applicable' });
    expect(injected).toBe(true);
    expect(res.status).toBe(409);
    expect(db.tables.user_financial_section_status.find((r) => r.section === 'retirement')!.status).toBe('reviewed_zero');
  });

  it('a database refusal (migration 0298) is turned into the same readable 409', async () => {
    const db = await world({ user_financial_section_status: [], retirement_accounts: [], smsf_funds: [] });
    // The route's own check passes (nothing held); the database then refuses because an account landed.
    const original = db.client.from;
    db.client.from = (table: string) => {
      const chain = original(table) as Record<string, (...a: unknown[]) => unknown>;
      if (table !== 'user_financial_section_status') return chain;
      return {
        ...chain,
        upsert: () => {
          db.tables.retirement_accounts.push(account('late'));
          return Promise.resolve({ data: null, error: { message: 'RETIREMENT_DECLARATION_CONFLICT: you have 1 active retirement account or SMSF items, remove or deactivate them' } });
        },
      };
    };
    const res = await sectionPut({ section: 'retirement', status: 'not_applicable' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(RETIREMENT_DECLARATION_CONFLICT_CODE);
  });
});

describe('both routes apply ONE shared rule', () => {
  it('route sources use the shared guard (no second copy of the rule)', async () => {
    const fs = await import('node:fs');
    for (const f of ['app/api/user/profile/route.ts', 'app/api/user/section-status/route.ts']) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src).toContain("from '@/lib/services/retirementDeclarationGuard'");
      expect(src).toContain('refuseRetirementDeclarationIfConflicting');
    }
  });
});
