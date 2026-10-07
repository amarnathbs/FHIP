// Item 13: lineage and migration correctness on a real Postgres (PGlite).
//
// The ledger is replayed up to 0252 (everything the PO has applied before this mission), the properties of every function that the
// new migrations replace are SNAPSHOT, then 0264 to 0268 are applied in order and the properties are compared:
//   * owner, security mode, volatility, search_path setting, language and the SET of roles that may execute stay the same, EXCEPT for the
//     differences this mission intends and lists below;
//   * a function that was dropped and recreated keeps its comment (or had none);
//   * no old overload remains (every replaced function name is defined exactly once), and the number of overloads of the other
//     promo and premium functions is unchanged;
//   * the audit trail triggers are still attached;
//   * applying 0264 to 0268 a second time is harmless (idempotent), apart from the data statements that are safe to repeat.
//
// NAMED NEGATIVE CONTROLS
//   NC-P1  the comparison really detects a changed property: a copy of a replaced function with the security mode flipped is flagged;
//   NC-P2  an extra overload of a replaced function is flagged by the overload count (the check that 0261 added for pc6_nav_row_is_candidate).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { MIG_DIR, expectNamedFailure, migrationFiles, replayAll } from './support/promoTestHelpers';

type Json = Record<string, unknown>;
let db: PGlite;

/** Functions the new migrations replace, with the intended execute grantees AFTER the change. */
const REPLACED: Record<string, { grantees: string[]; secdef: boolean; volatility: 'v' | 's' | 'i' }> = {
  admin_create_promo_code: { grantees: ['authenticated'], secdef: true, volatility: 'v' },
  admin_list_promo_codes: { grantees: ['authenticated'], secdef: true, volatility: 's' },
  redeem_promo_code_for_user: { grantees: ['service_role'], secdef: true, volatility: 'v' },
  admin_manage_premium_entitlement: { grantees: ['authenticated'], secdef: true, volatility: 'v' },
  premium_reminder_claim: { grantees: ['service_role'], secdef: true, volatility: 'v' },
  admin_promo_email_begin: { grantees: ['authenticated'], secdef: true, volatility: 'v' },
  promo_code_events_immutable: { grantees: [], secdef: false, volatility: 'v' },
};

/** Functions of the same families that must be untouched (same overload count and same grants before and after). */
const UNCHANGED = [
  'admin_disable_promo_code', 'admin_promo_code_events', 'admin_promo_email_record', 'premium_reminder_record', 'is_promo_code_admin',
  'is_premium_entitlement_admin', 'promo_normalise_code', 'promo_generate_code', 'premium_grant_max_extensions',
  'admin_search_premium_entitlement_users', 'admin_list_premium_grants', 'admin_entitlement_expiry_summary', 'apply_subscription_entitlement_event',
];

async function snapshot(names: string[]): Promise<Record<string, Json[]>> {
  const out: Record<string, Json[]> = {};
  for (const name of names) {
    const { rows } = await db.query(
      `select p.oid::int as oid, pg_get_userbyid(p.proowner) as owner, p.prosecdef as secdef, p.provolatile as volatility, p.proconfig as config,
              l.lanname as lang, p.prokind as kind, obj_description(p.oid, 'pg_proc') as comment,
              coalesce((select array_agg(distinct case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end order by case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end)
                          from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.privilege_type = 'EXECUTE'), '{}') as grantees
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
        where n.nspname = 'public' and p.proname = $1`,
      [name]
    );
    out[name] = rows as Json[];
  }
  return out;
}

const withoutOid = (r: Json) => {
  const { oid: _oid, ...rest } = r;
  void _oid;
  return rest;
};

let before: Record<string, Json[]>;
let after: Record<string, Json[]>;

beforeAll(async () => {
  db = await PGlite.create();
  await replayAll(db, '0252_zzz');
  before = await snapshot([...Object.keys(REPLACED), ...UNCHANGED]);
  // apply the hardening migrations in order, exactly as the PO will (file by file)
  for (const f of migrationFiles().filter((x) => Number(x.slice(0, 4)) >= 264)) {
    await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  }
  after = await snapshot([...Object.keys(REPLACED), ...UNCHANGED]);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('functions replaced by 0264 to 0268', () => {
  it('each existed before and exists exactly ONCE after: no old overload remains', () => {
    for (const name of Object.keys(REPLACED)) {
      expect(before[name].length, `${name} existed before`).toBeGreaterThanOrEqual(1);
      expect(after[name], `${name} must exist exactly once after (no old overload)`).toHaveLength(1);
    }
  });

  it('owner, security mode, volatility, language and search_path are preserved (or are the intended value)', () => {
    for (const [name, want] of Object.entries(REPLACED)) {
      const b = before[name][0];
      const a = after[name][0];
      expect(a.owner, `${name} owner`).toBe(b.owner);
      expect(a.secdef, `${name} security mode`).toBe(b.secdef);
      expect(a.secdef, `${name} security mode is the intended one`).toBe(want.secdef);
      expect(a.volatility, `${name} volatility`).toBe(b.volatility);
      expect(a.volatility, `${name} volatility is the intended one`).toBe(want.volatility);
      expect(a.lang, `${name} language`).toBe(b.lang);
      expect(a.kind, `${name} kind`).toBe(b.kind);
      expect(a.config, `${name} search_path setting`).toEqual(b.config);
    }
  });

  it('the set of roles that may execute is the SAME as before, and never public or anon (redeem: service role only)', () => {
    for (const [name, want] of Object.entries(REPLACED)) {
      if (name === 'promo_code_events_immutable') continue; // a trigger function: execute is not a call path
      const grantees = (after[name][0].grantees as string[]).filter((g) => g !== (after[name][0].owner as string)).sort();
      const was = (before[name][0].grantees as string[]).filter((g) => g !== (before[name][0].owner as string)).sort();
      expect(grantees, `${name} grantees are unchanged`).toEqual(was);
      expect(grantees, `${name} must not be executable by public`).not.toContain('public');
      expect(grantees, `${name} must not be executable by anon`).not.toContain('anon');
      for (const g of want.grantees) expect(grantees, `${name} stays executable by ${g}`).toContain(g);
    }
    const redeem = (after.redeem_promo_code_for_user[0].grantees as string[]).filter((g) => g !== (after.redeem_promo_code_for_user[0].owner as string));
    expect(redeem, 'redeem is not executable by a signed-in user').not.toContain('authenticated');
  });

  it('where the old function had a comment, the new one still has one that starts the same way (the text may be updated for the new rules)', () => {
    for (const name of Object.keys(REPLACED)) {
      const b = before[name][0].comment as string | null;
      const a = after[name][0].comment as string | null;
      if (b) {
        expect(a, `${name} keeps a comment`).not.toBeNull();
        expect(String(a).slice(0, 25), `${name} comment keeps its subject`).toBe(b.slice(0, 25));
      }
    }
  });

  it('the audit trail triggers are still attached to the append only tables', async () => {
    const t = (await db.query(`select tgname from pg_trigger where tgrelid = 'public.promo_code_events'::regclass and not tgisinternal order by tgname`)).rows.map((r) => (r as { tgname: string }).tgname);
    expect(t).toEqual(['trg_promo_code_events_no_change', 'trg_promo_code_events_no_truncate']);
    const e = (await db.query(`select tgname from pg_trigger where tgrelid = 'public.admin_entitlement_events'::regclass and not tgisinternal order by tgname`)).rows.map((r) => (r as { tgname: string }).tgname);
    expect(e.length).toBeGreaterThanOrEqual(2);
  });
});

describe('functions the mission did NOT replace are untouched', () => {
  it('same overload count, same properties and same grants before and after', () => {
    for (const name of UNCHANGED) {
      expect(after[name].length, `${name} overload count`).toBe(before[name].length);
      expect(after[name].map(withoutOid), `${name} properties`).toEqual(before[name].map(withoutOid));
    }
  });
});

describe('NC-P1 and NC-P2 the comparison is not vacuous', () => {
  it('NC-P1: flipping the security mode of a replaced function is detected by the same assertions', async () => {
    const check = async () => {
      const snap = await snapshot(['admin_create_promo_code']);
      expect(snap.admin_create_promo_code[0].secdef, 'admin_create_promo_code security mode').toBe(true);
    };
    await check();
    await db.exec(`alter function public.admin_create_promo_code(text, text, int, int, int, boolean, date, boolean, text, text, int) security invoker`);
    try {
      await expectNamedFailure(check, 'admin_create_promo_code security mode');
    } finally {
      await db.exec(`alter function public.admin_create_promo_code(text, text, int, int, int, boolean, date, boolean, text, text, int) security definer`);
    }
    await check();
  });

  it('NC-P2: an extra overload of a replaced function is caught by the overload count', async () => {
    const countIsOne = async () => {
      const snap = await snapshot(['redeem_promo_code_for_user']);
      expect(snap.redeem_promo_code_for_user, 'redeem_promo_code_for_user must exist exactly once').toHaveLength(1);
    };
    await countIsOne();
    await db.exec(`create function public.redeem_promo_code_for_user(p_user_id uuid, p_code text, p_ip_hash text) returns jsonb language sql as $fn$ select '{}'::jsonb; $fn$`);
    try {
      await expectNamedFailure(countIsOne, 'redeem_promo_code_for_user must exist exactly once');
    } finally {
      await db.exec(`drop function public.redeem_promo_code_for_user(uuid, text, text)`);
    }
    await countIsOne();
  });
});

describe('re-applying the hardening migrations is harmless', () => {
  it('a second application of 0264 to 0268 succeeds and changes nothing that matters (functions are replaced by themselves, tables are kept)', async () => {
    const countBefore = ((await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)).rows[0] as { n: number }).n;
    for (const f of migrationFiles().filter((x) => Number(x.slice(0, 4)) >= 264)) {
      await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    }
    const countAfter = ((await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)).rows[0] as { n: number }).n;
    expect(countAfter, 'no function was added or lost by the second run').toBe(countBefore);
    const again = await snapshot(Object.keys(REPLACED));
    for (const name of Object.keys(REPLACED)) expect(again[name].map(withoutOid), name).toEqual(after[name].map(withoutOid));
  });

  it('the policy table keeps one row per data set after a second run (the seed inserts only what is missing)', async () => {
    expect(((await db.query(`select count(*)::int n from promo_retention_policy`)).rows[0] as { n: number }).n).toBe(6);
    expect(((await db.query(`select count(*)::int n from premium_reminder_job_control where job_key in ('expiry_email','promo_retention')`)).rows[0] as { n: number }).n).toBe(2);
  });
});
