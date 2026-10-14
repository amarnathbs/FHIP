// Item 13 and DEPLOY SAFETY: lineage and migration correctness on a real Postgres (PGlite).
//
// The ledger is replayed up to 0252 (everything the PO has applied before this mission). Then, in TWO PHASES that mirror the
// production runbook:
//   PHASE 1  0264 to 0268 are applied (ADDITIVE). The release that is live today keeps calling the OLD function shapes, so
//            every old shape must still exist, byte for byte unchanged, and every call the old release makes must reach
//            exactly one function (no ambiguity, no silent redirect to a new one). The new shapes are added beside them.
//   PHASE 2  0279, the separate cleanup, removes the old shapes. Afterwards each name is defined exactly once.
// Throughout: owner, security mode, volatility, search_path, language and the SET of roles that may execute stay the same
// (except where this mission intends otherwise), a comment survives, the audit triggers stay attached, thirteen sibling
// functions are untouched, and re-applying is harmless.
//
// NAMED NEGATIVE CONTROLS
//   NC-P1  the comparison really detects a changed property: a copy of a replaced function with the security mode flipped is flagged;
//   NC-P2  an extra overload of a replaced function is flagged by the overload count (the check that 0261 added for pc6_nav_row_is_candidate);
//   NC-O1  the overload-resolution check really detects an ambiguity: a default value on the new override parameter makes the old
//          four argument call match TWO functions (PostgREST would answer PGRST203), and the check reports it;
//   NC-O2  the byte-for-byte check of an old function really detects an edit.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { MIG_DIR, expectNamedFailure, migrationFiles, replayAll } from './support/promoTestHelpers';

type Json = Record<string, unknown>;
let db: PGlite;

/** The OLD shapes the live release calls, and the NEW shapes beside them. Identity arguments as Postgres prints them. */
const SHAPES = {
  admin_create_promo_code: {
    old: 'p_code text, p_duration_days integer, p_max_redemptions integer, p_unlimited boolean, p_expires_on date, p_no_expiry boolean, p_note text, p_bound_email_hash text, p_recipient_count integer',
    new: 'p_code_digest text, p_code_hint text, p_digest_version integer, p_duration_days integer, p_max_redemptions integer, p_unlimited boolean, p_expires_on date, p_no_expiry boolean, p_note text, p_bound_email_hash text, p_recipient_count integer',
    oldKeys: ['p_code', 'p_duration_days', 'p_max_redemptions', 'p_unlimited', 'p_expires_on', 'p_no_expiry', 'p_note'],
    newKeys: ['p_code_digest', 'p_code_hint', 'p_digest_version', 'p_duration_days', 'p_max_redemptions', 'p_unlimited', 'p_expires_on', 'p_no_expiry', 'p_note'],
    grantees: ['authenticated'],
    volatility: 'v',
  },
  redeem_promo_code_for_user: {
    old: 'p_user_id uuid, p_code text, p_ip_hash text, p_email_hash text',
    new: 'p_user_id uuid, p_digests text[], p_ip_hash text, p_email_hash text, p_legacy_code text',
    oldKeys: ['p_user_id', 'p_code', 'p_ip_hash'],
    newKeys: ['p_user_id', 'p_digests', 'p_ip_hash'],
    grantees: ['service_role'],
    volatility: 'v',
  },
  admin_manage_premium_entitlement: {
    old: 'p_action text, p_target_user_id uuid, p_ends_on date, p_reason text',
    new: 'p_action text, p_target_user_id uuid, p_ends_on date, p_reason text, p_override boolean',
    oldKeys: ['p_action', 'p_target_user_id', 'p_ends_on', 'p_reason'],
    newKeys: ['p_action', 'p_target_user_id', 'p_ends_on', 'p_reason', 'p_override'],
    grantees: ['authenticated'],
    volatility: 'v',
  },
  admin_promo_email_begin: {
    old: 'p_request_key text, p_recipient_count integer, p_bound boolean',
    new: 'p_request_key text, p_recipient_count integer, p_bound boolean, p_kind text, p_purpose text, p_replaces uuid',
    oldKeys: ['p_request_key', 'p_recipient_count', 'p_bound'],
    newKeys: ['p_request_key', 'p_recipient_count', 'p_bound', 'p_kind', 'p_purpose', 'p_replaces'],
    grantees: ['authenticated'],
    volatility: 'v',
  },
} as const;
type ShapeName = keyof typeof SHAPES;
const SHAPE_NAMES = Object.keys(SHAPES) as ShapeName[];

/** admin_list_promo_codes is replaced by a NEW NAME (no overload is possible with zero arguments). */
const LIST_OLD = 'admin_list_promo_codes';
const LIST_NEW = 'admin_list_promo_codes_v2';

/** Replaced under the SAME signature (a body change only). */
const IN_PLACE: Record<string, { grantees: string[]; secdef: boolean; volatility: 'v' | 's' | 'i' }> = {
  premium_reminder_claim: { grantees: ['service_role'], secdef: true, volatility: 'v' },
  promo_code_events_immutable: { grantees: [], secdef: false, volatility: 'v' },
};

/** Functions of the same families that must be untouched (same overload count and same grants before and after). */
const UNCHANGED = [
  'admin_disable_promo_code', 'admin_promo_code_events', 'admin_promo_email_record', 'premium_reminder_record', 'is_promo_code_admin',
  'is_premium_entitlement_admin', 'promo_normalise_code', 'promo_generate_code', 'premium_grant_max_extensions',
  'admin_search_premium_entitlement_users', 'admin_list_premium_grants', 'admin_entitlement_expiry_summary', 'apply_subscription_entitlement_event',
];

const ALL_NAMES = [...SHAPE_NAMES, LIST_OLD, LIST_NEW, ...Object.keys(IN_PLACE), ...UNCHANGED];

interface Fn extends Json {
  ident: string;
  def: string;
  owner: string;
  secdef: boolean;
  volatility: string;
  config: unknown;
  lang: string;
  kind: string;
  comment: string | null;
  grantees: string[];
}

async function snapshot(names: string[]): Promise<Record<string, Fn[]>> {
  const out: Record<string, Fn[]> = {};
  for (const name of names) {
    const { rows } = await db.query(
      `select pg_get_function_identity_arguments(p.oid) as ident, pg_get_functiondef(p.oid) as def,
              pg_get_userbyid(p.proowner) as owner, p.prosecdef as secdef, p.provolatile as volatility, p.proconfig as config,
              l.lanname as lang, p.prokind as kind, obj_description(p.oid, 'pg_proc') as comment,
              coalesce((select array_agg(distinct case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end order by case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end)
                          from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.privilege_type = 'EXECUTE'), '{}') as grantees
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
        where n.nspname = 'public' and p.proname = $1
        order by 1`,
      [name]
    );
    out[name] = rows as Fn[];
  }
  return out;
}

/** How many functions named `name` would a call with exactly these named arguments reach (PostgREST resolves by argument names)? */
async function candidates(name: string, keys: readonly string[]): Promise<string[]> {
  const { rows } = await db.query(
    `select pg_get_function_identity_arguments(p.oid) as ident
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = $1
        and not exists (select 1 from unnest($2::text[]) k where not (k = any(p.proargnames)))
        and not exists (select 1 from unnest(p.proargnames[1:p.pronargs - p.pronargdefaults]) r where not (r = any($2::text[])))`,
    [name, keys as string[]]
  );
  return (rows as { ident: string }[]).map((r) => r.ident);
}

const stripOwner = (g: string[], owner: string) => g.filter((x) => x !== owner).sort();
const byIdent = (fns: Fn[], ident: string) => fns.find((f) => f.ident === ident);

let before: Record<string, Fn[]>;
let phase1: Record<string, Fn[]>;
let phase2: Record<string, Fn[]>;

const additive = () => migrationFiles().filter((x) => Number(x.slice(0, 4)) >= 264 && Number(x.slice(0, 4)) <= 268);
const cleanup = () => migrationFiles().filter((x) => Number(x.slice(0, 4)) >= 279 && x.includes('promo_hardening_legacy_cleanup'));

beforeAll(async () => {
  db = await PGlite.create();
  await replayAll(db, '0252_zzz');
  before = await snapshot(ALL_NAMES);
  // PHASE 1: the additive migrations, in order, exactly as the PO will (file by file)
  for (const f of additive()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
  phase1 = await snapshot(ALL_NAMES);
  // PHASE 2 is applied inside its own describe, after the phase 1 assertions have run
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('PHASE 1 (0264 to 0268, additive): the release that is live today keeps working', () => {
  it('every OLD function shape still exists and is BYTE FOR BYTE what it was (definition, owner, comment, grants)', () => {
    for (const name of [...SHAPE_NAMES, LIST_OLD] as string[]) {
      const ident = name === LIST_OLD ? '' : SHAPES[name as ShapeName].old;
      const was = byIdent(before[name], ident);
      const now = byIdent(phase1[name], ident);
      expect(was, `${name}(${ident}) existed before`).toBeDefined();
      expect(now, `${name}(${ident}) must still exist after 0264 to 0268`).toBeDefined();
      expect(now!.def, `${name}(${ident}) definition must be unchanged`).toBe(was!.def);
      expect(now!.owner).toBe(was!.owner);
      expect(now!.comment).toBe(was!.comment);
      expect(now!.grantees).toEqual(was!.grantees);
    }
  });

  it('NC-O2: the byte-for-byte check is real: an edited old function is detected', async () => {
    const name = 'admin_promo_email_begin';
    const ident = SHAPES[name].old;
    const original = byIdent(phase1[name], ident)!.def;
    const edited = original.replace(/PROMO_EMAIL_RATE_LIMITED/, 'PROMO_EMAIL_RATE_LIMITED_EDITED');
    expect(edited, 'the mutation must change the text').not.toBe(original);
    await db.exec(edited);
    try {
      const now = byIdent((await snapshot([name]))[name], ident)!;
      await expectNamedFailure(() => expect(now.def, 'old function definition must be unchanged').toBe(original), 'old function definition must be unchanged');
    } finally {
      await db.exec(original);
    }
    expect(byIdent((await snapshot([name]))[name], ident)!.def).toBe(original);
  });

  it('each overloaded name now has exactly TWO definitions, the old one and the new one', () => {
    for (const name of SHAPE_NAMES) {
      expect(phase1[name].map((f) => f.ident).sort(), `${name} overloads`).toEqual([SHAPES[name].new, SHAPES[name].old].sort());
    }
    expect(phase1[LIST_OLD].map((f) => f.ident)).toEqual(['']);
    expect(phase1[LIST_NEW].map((f) => f.ident)).toEqual(['']);
  });

  it('a call made with the OLD argument names reaches exactly the OLD function, and a call made with the NEW names exactly the NEW one (no PGRST203 ambiguity)', async () => {
    for (const name of SHAPE_NAMES) {
      expect(await candidates(name, SHAPES[name].oldKeys), `${name}: old call`).toEqual([SHAPES[name].old]);
      expect(await candidates(name, SHAPES[name].newKeys), `${name}: new call`).toEqual([SHAPES[name].new]);
    }
    // the e-mail begin and create have optional trailing arguments: the old release also sends them
    expect(await candidates('admin_create_promo_code', [...SHAPES.admin_create_promo_code.oldKeys, 'p_bound_email_hash', 'p_recipient_count'])).toEqual([SHAPES.admin_create_promo_code.old]);
    expect(await candidates('admin_create_promo_code', [...SHAPES.admin_create_promo_code.newKeys, 'p_bound_email_hash', 'p_recipient_count'])).toEqual([SHAPES.admin_create_promo_code.new]);
    expect(await candidates('redeem_promo_code_for_user', [...SHAPES.redeem_promo_code_for_user.oldKeys, 'p_email_hash'])).toEqual([SHAPES.redeem_promo_code_for_user.old]);
    expect(await candidates('redeem_promo_code_for_user', [...SHAPES.redeem_promo_code_for_user.newKeys, 'p_email_hash', 'p_legacy_code'])).toEqual([SHAPES.redeem_promo_code_for_user.new]);
  });

  it('NC-O1: the resolution check really detects an ambiguity (a default on the override flag makes the old four argument call match two functions)', async () => {
    const live = byIdent(phase1.admin_manage_premium_entitlement, SHAPES.admin_manage_premium_entitlement.new)!.def;
    expect(await candidates('admin_manage_premium_entitlement', SHAPES.admin_manage_premium_entitlement.oldKeys)).toHaveLength(1);
    const mutated = live.replace('p_override boolean', 'p_override boolean default false');
    expect(mutated, 'the mutation must change the text').not.toBe(live);
    await db.exec(mutated);
    try {
      await expectNamedFailure(async () => expect(await candidates('admin_manage_premium_entitlement', SHAPES.admin_manage_premium_entitlement.oldKeys), 'the four argument call must reach exactly one function').toHaveLength(1), 'the four argument call must reach exactly one function');
    } finally {
      await db.exec('drop function public.admin_manage_premium_entitlement(text, uuid, date, text, boolean)');
      await db.exec(live);
    }
    expect(await candidates('admin_manage_premium_entitlement', SHAPES.admin_manage_premium_entitlement.oldKeys)).toHaveLength(1);
  });

  it('the NEW overloads match their old sibling: owner, security mode, language, search_path and the set of roles that may execute', () => {
    for (const name of SHAPE_NAMES) {
      const o = byIdent(phase1[name], SHAPES[name].old)!;
      const n = byIdent(phase1[name], SHAPES[name].new)!;
      expect(n.owner, `${name} owner`).toBe(o.owner);
      expect(n.secdef, `${name} security mode`).toBe(o.secdef);
      expect(n.secdef, `${name} security mode is the intended one`).toBe(true);
      expect(n.volatility, `${name} volatility`).toBe(SHAPES[name].volatility);
      expect(n.lang, `${name} language`).toBe(o.lang);
      expect(n.config, `${name} search_path setting`).toEqual(o.config);
      const g = stripOwner(n.grantees, n.owner);
      expect(g, `${name} grantees equal the old sibling's`).toEqual(stripOwner(o.grantees, o.owner));
      expect(g, `${name} must not be executable by public`).not.toContain('public');
      expect(g, `${name} must not be executable by anon`).not.toContain('anon');
      for (const want of SHAPES[name].grantees) expect(g, `${name} stays executable by ${want}`).toContain(want);
    }
    const redeem = stripOwner(byIdent(phase1.redeem_promo_code_for_user, SHAPES.redeem_promo_code_for_user.new)!.grantees, 'postgres');
    expect(redeem, 'redeem is not executable by a signed-in user').not.toContain('authenticated');
    const list = phase1[LIST_NEW][0];
    expect(list.secdef).toBe(true);
    expect(stripOwner(list.grantees, list.owner)).toEqual(stripOwner(phase1[LIST_OLD][0].grantees, phase1[LIST_OLD][0].owner));
  });

  it('the functions replaced under the SAME signature keep owner, security mode, volatility, language, search_path and grants', () => {
    for (const [name, want] of Object.entries(IN_PLACE)) {
      const b = before[name][0];
      const a = phase1[name][0];
      expect(phase1[name], `${name} must exist exactly once`).toHaveLength(1);
      expect(a.owner, `${name} owner`).toBe(b.owner);
      expect(a.secdef, `${name} security mode`).toBe(b.secdef);
      expect(a.secdef).toBe(want.secdef);
      expect(a.volatility).toBe(b.volatility);
      expect(a.volatility).toBe(want.volatility);
      expect(a.lang).toBe(b.lang);
      expect(a.config).toEqual(b.config);
      if (name !== 'promo_code_events_immutable') expect(stripOwner(a.grantees, a.owner)).toEqual(stripOwner(b.grantees, b.owner));
    }
  });

  it('the audit trail triggers are still attached to the append only tables', async () => {
    const t = (await db.query(`select tgname from pg_trigger where tgrelid = 'public.promo_code_events'::regclass and not tgisinternal order by tgname`)).rows.map((r) => (r as { tgname: string }).tgname);
    expect(t).toEqual(['trg_promo_code_events_no_change', 'trg_promo_code_events_no_truncate']);
    const e = (await db.query(`select tgname from pg_trigger where tgrelid = 'public.admin_entitlement_events'::regclass and not tgisinternal order by tgname`)).rows.map((r) => (r as { tgname: string }).tgname);
    expect(e.length).toBeGreaterThanOrEqual(2);
  });

  it('functions the mission did NOT replace are untouched (same overload count, same properties, same definition, same grants)', () => {
    for (const name of UNCHANGED) {
      expect(phase1[name].length, `${name} overload count`).toBe(before[name].length);
      expect(phase1[name], `${name} properties`).toEqual(before[name]);
    }
  });
});

describe('PHASE 1 re-application is harmless', () => {
  it('a second application of 0264 to 0268 succeeds, adds and loses no function, and leaves the old shapes byte for byte as they were', async () => {
    const count = async () => ((await db.query(`select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`)).rows[0] as { n: number }).n;
    const countBefore = await count();
    for (const f of additive()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    expect(await count(), 'no function was added or lost by the second run').toBe(countBefore);
    const again = await snapshot(ALL_NAMES);
    for (const name of ALL_NAMES) expect(again[name], name).toEqual(phase1[name]);
  });

  it('the policy table keeps one row per data set after a second run (the seed inserts only what is missing)', async () => {
    expect(((await db.query(`select count(*)::int n from promo_retention_policy`)).rows[0] as { n: number }).n).toBe(6);
    expect(((await db.query(`select count(*)::int n from premium_reminder_job_control where job_key in ('expiry_email','promo_retention')`)).rows[0] as { n: number }).n).toBe(2);
  });
});

describe('PHASE 2 (0279, the separate cleanup): the old shapes go, each name is defined exactly once', () => {
  beforeAll(async () => {
    for (const f of cleanup()) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
    phase2 = await snapshot(ALL_NAMES);
  }, 120_000);

  it('the cleanup file exists and is the one named 0279', () => {
    expect(cleanup()).toHaveLength(1);
  });

  it('each replaced name exists exactly ONCE after (no old overload remains) and it is the NEW shape', () => {
    for (const name of SHAPE_NAMES) {
      expect(phase2[name], `${name} must exist exactly once after the cleanup (no old overload)`).toHaveLength(1);
      expect(phase2[name][0].ident, `${name} is the new shape`).toBe(SHAPES[name].new);
    }
    expect(phase2[LIST_OLD], 'the old list function is gone').toHaveLength(0);
    expect(phase2[LIST_NEW]).toHaveLength(1);
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

  it('where the old function had a comment, the surviving one still has one that starts the same way', () => {
    for (const name of SHAPE_NAMES) {
      const b = byIdent(before[name], SHAPES[name].old)!.comment;
      const a = phase2[name][0].comment;
      if (b) {
        expect(a, `${name} keeps a comment`).not.toBeNull();
        expect(String(a).slice(0, 25), `${name} comment keeps its subject`).toBe(b.slice(0, 25));
      }
    }
  });

  it('functions the mission did NOT replace are still untouched after the cleanup', () => {
    for (const name of UNCHANGED) expect(phase2[name], `${name} properties`).toEqual(before[name]);
  });
});
