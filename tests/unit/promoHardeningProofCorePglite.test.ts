// The DEV proof (scripts/lib/promoHardeningProofCore.mjs) tested BEFORE it is pointed at DEV: the very same checks run here against a
// PGlite replay, in both stages of the release, and with deliberately broken functions to show that the checks can fail.
//
//   stage COEXIST  the old database plus 0264 to 0268 (the old function shapes are still beside the new ones);
//   stage FINAL    the same plus the cleanup 0279 (the old shapes are gone).
//
// What PGlite cannot give (and the DEV run does): real concurrent connections. Here the adapter serialises every call on the single
// connection, so the race checks must still be EXACT, which they are by construction (row lock plus the CHECK backstop).
//
// NAMED NEGATIVE CONTROLS (each runs the whole proof against a function with exactly one rule removed and names the check that goes red)
//   NC-X1  the lifetime ceiling removed from the grant function  -> check 5.1 goes red
//   NC-X2  the capability check removed from the create function -> check 1.3 goes red
//   NC-X3  the paid-Premium refusal removed from the redeem function -> check 7.4 goes red
//   NC-X4  the maximum-redemption check removed from the redeem function -> check 7.1 (or 7.2) goes red, and the CHECK backstop is the only guard

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { runProofs } from '../../scripts/lib/promoHardeningProofCore.mjs';
import { MIG_DIR, TEST_ENV, latestFunctionSql, migrationFiles, replayAll } from './support/promoTestHelpers';

type Row = Record<string, unknown>;
type Res = { data: unknown; error: { message: string; code?: string } | null };
interface Client {
  rpc(name: string, args?: Record<string, unknown>): Promise<Res>;
  select(table: string, columns: string, match?: Record<string, unknown>): Promise<Res>;
  tryWrite(kind: 'update' | 'delete', table: string, match: Record<string, unknown>, values?: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
}

let db: PGlite;
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
};

const toErr = (e: unknown) => ({ message: (e as Error).message, code: (e as { code?: string }).code });

function client(uid: string | null, role: 'authenticated' | 'anon' | 'service_role' | 'postgres'): Client {
  const withRole = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (role === 'postgres') return fn();
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [uid ? JSON.stringify({ sub: uid, role }) : '']);
    await db.exec(`set role ${role};`);
    try {
      return await fn();
    } finally {
      await db.exec('reset role;');
      await db.query(`select set_config('request.jwt.claims', '', false)`);
    }
  };
  return {
    rpc: (name, args = {}) =>
      serial(async () => {
        const keys = Object.keys(args);
        const params = keys.map((k, i) => `${k} => $${i + 1}`).join(', ');
        try {
          const res = await withRole(() => db.query(`select * from public.${name}(${params})`, keys.map((k) => (args[k] === undefined ? null : args[k])) as unknown[]));
          const cols = res.fields.map((f) => f.name);
          if (cols.length === 1 && cols[0] === name) return { data: (res.rows[0] as Row)?.[name] ?? null, error: null };
          return { data: res.rows, error: null };
        } catch (e) {
          return { data: null, error: toErr(e) };
        }
      }),
    select: (table, columns, match = {}) =>
      serial(async () => {
        const keys = Object.keys(match);
        const where = keys.length ? ` where ${keys.map((k, i) => `${k} = $${i + 1}`).join(' and ')}` : '';
        try {
          const res = await withRole(() => db.query(`select ${columns} from public.${table}${where}`, keys.map((k) => match[k]) as unknown[]));
          return { data: res.rows, error: null };
        } catch (e) {
          return { data: null, error: toErr(e) };
        }
      }),
    tryWrite: (kind, table, match, values = {}) =>
      serial(async () => {
        const mk = Object.keys(match);
        const vk = Object.keys(values);
        const where = mk.map((k, i) => `${k} = $${vk.length + i + 1}`).join(' and ');
        const sql = kind === 'delete' ? `delete from public.${table} where ${where}` : `update public.${table} set ${vk.map((k, i) => `${k} = $${i + 1}`).join(', ')} where ${where}`;
        try {
          await withRole(() => db.query(sql, [...vk.map((k) => values[k]), ...mk.map((k) => match[k])] as unknown[]));
          return { error: null };
        } catch (e) {
          return { error: { message: (e as Error).message } };
        }
      }),
  };
}

let seq = 0;
const fixtures: Record<string, { id: string; email: string }> = {};

async function makeFixtureUsers() {
  const spec: [string, Record<string, boolean> | null, boolean?][] = [
    ['ent', { can_manage_premium_entitlements: true }],
    ['promo', { can_manage_promo_codes: true }],
    ['both', { can_manage_premium_entitlements: true, can_manage_promo_codes: true }],
    ['ovr', { can_manage_premium_entitlements: true, can_manage_promo_codes: true, can_override_entitlement_limits: true }],
    ['ovronly', { can_override_entitlement_limits: true }],
    ['super', {}],
    ['user1', null],
    ['paid', null, true],
  ];
  for (const [label, caps, paid] of spec) {
    seq += 1;
    const id = `cccccccc-0000-0000-0000-${String(seq).padStart(12, '0')}`;
    const email = `fx-${label}@pg.test`;
    await db.exec(`insert into auth.users(id,email,email_confirmed_at) values ('${id}','${email}',now());`);
    if (caps) {
      await db.exec(`insert into admin_users(user_id) values ('${id}');`);
      for (const [col, v] of Object.entries(caps)) await db.exec(`update admin_users set ${col} = ${v} where user_id = '${id}';`);
    }
    if (paid) await db.exec(`insert into user_entitlements(user_id, plan_tier, entitlement_source) values ('${id}', 'premium', 'payment') on conflict (user_id) do update set plan_tier='premium', entitlement_source='payment';`);
    fixtures[label] = { id, email };
  }
}

function makeCtx(record: (name: string, ok: boolean, detail?: string) => void) {
  const clients: Record<string, Client> = {};
  return {
    service: client(null, 'service_role') as Client & { select: Client['select'] },
    anon: client(null, 'anon'),
    as: (label: string) => (clients[label] ??= client(fixtures[label].id, 'authenticated')),
    users: fixtures,
    secrets: { digest: TEST_ENV.PROMO_CODE_DIGEST_SECRET, bind: TEST_ENV.PREMIUM_PROMO_EMAIL_BIND_SECRET },
    record,
    async verifyUser(id: string) {
      await serial(() => db.exec(`update auth.users set email_confirmed_at = now() where id = '${id}';`));
    },
    async newUser(opts: { confirmed?: boolean; email?: string } = {}) {
      seq += 1;
      const id = `dddddddd-0000-0000-0000-${String(seq).padStart(12, '0')}`;
      const email = opts.email ?? `u${seq}@promo-proof.invalid`;
      await serial(() => db.exec(`insert into auth.users(id,email,email_confirmed_at) values ('${id}','${email}', ${opts.confirmed === false ? 'null' : 'now()'});`));
      return { id, email };
    },
  };
}

/** The proof reads server-only tables as the server role; on PGlite that role has no table grants, so the adapter reads them as the owner. */
function withOwnerReads(ctx: ReturnType<typeof makeCtx>) {
  const owner = client(null, 'postgres');
  return { ...ctx, service: { rpc: ctx.service.rpc, select: owner.select, tryWrite: owner.tryWrite } };
}

async function runStage(): Promise<{ stage: string; results: { name: string; ok: boolean; detail: string }[] }> {
  const results: { name: string; ok: boolean; detail: string }[] = [];
  // A fresh start for the repeatable fixtures: the hourly e-mail request ledger (the proof sends requests as the same admins) and the paid user.
  await db.exec(`delete from public.promo_email_requests;`);
  await db.exec(
    `update user_entitlements set plan_tier='premium', entitlement_source='payment', effective_from=current_date - 10, effective_to=null, admin_grant_ends_on=null, reserve_source=null, promo_code_id=null where user_id = '${fixtures.paid.id}';`
  );
  const ctx = withOwnerReads(makeCtx((name, ok, detail = '') => results.push({ name, ok, detail })));
  const out = await runProofs(ctx);
  return { stage: out.stage, results };
}

const failing = (r: { results: { name: string; ok: boolean; detail: string }[] }) => {
  const bad = r.results.filter((x) => !x.ok).map((x) => `${x.name}  [${x.detail}]`);
  if (bad.length && process.env.PROOF_DEBUG) console.log(bad.join('\n'));
  return bad;
};

async function applyFiles(from: number, to: number, only?: string) {
  for (const f of migrationFiles().filter((x) => Number(x.slice(0, 4)) >= from && Number(x.slice(0, 4)) <= to && (!only || x.includes(only)))) await db.exec(fs.readFileSync(path.join(MIG_DIR, f), 'utf8'));
}

async function withMutation<T>(name: string, mutate: (sql: string) => string, fn: () => Promise<T>): Promise<T> {
  // the NEWEST definition of the NEW shape (the file that creates the version with the digest or the override flag)
  const live = latestFunctionSql(name);
  const mutated = mutate(live);
  expect(mutated, `the mutation of ${name} must change the SQL`).not.toBe(live);
  await db.exec(mutated);
  try {
    return await fn();
  } finally {
    await db.exec(live);
  }
}

beforeAll(async () => {
  db = await PGlite.create();
  await replayAll(db, '0252_zzz');
  await db.exec(`
    create schema if not exists vault;
    create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
  `);
  await applyFiles(264, 268);
  await makeFixtureUsers();
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('the DEV proof, stage COEXIST (0264 to 0268 applied, old shapes still there)', () => {
  it('every check passes, and the stage is detected as coexist', async () => {
    const r = await runStage();
    expect(r.stage).toBe('coexist');
    expect(r.results.length).toBeGreaterThan(45);
    expect(failing(r)).toEqual([]);
  }, 120_000);

  it('the proof prints nothing that looks like a code, a protected copy or a secret', async () => {
    const r = await runStage();
    const text = JSON.stringify(r.results);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    for (const v of Object.values(TEST_ENV)) expect(text).not.toContain(v);
    expect(text).not.toMatch(/"[A-HJ-KM-NP-Z2-9]{10}"/);
  }, 120_000);

  it('NC-X1: with the lifetime ceiling removed from the grant function, check 5.1 goes red', async () => {
    const r = await withMutation(
      'admin_manage_premium_entitlement',
      (sql) => sql.replace("v_life_hit := v_row.admin_lifetime_grant_units >= v_ceiling;\n    v_life_hit := v_row.admin_lifetime_grant_units >= v_ceiling;", '').replace(/v_life_hit := v_row\.admin_lifetime_grant_units >= v_ceiling;/g, 'v_life_hit := false;'),
      runStage
    );
    expect(failing(r).some((f) => f.startsWith('5.1 '))).toBe(true);
  }, 120_000);

  it('NC-X2: with the capability check removed from the create function, check 1.3 goes red', async () => {
    const r = await withMutation('admin_create_promo_code', (sql) => sql.replace("if not public.is_promo_code_admin() then raise exception 'PROMO_ADMIN_REQUIRED' using errcode = '42501'; end if;", ''), runStage);
    expect(failing(r).some((f) => f.startsWith('1.3 '))).toBe(true);
  }, 120_000);

  it('NC-X3: with the paid-Premium refusal removed from the redeem function, check 7.4 goes red', async () => {
    const r = await withMutation('redeem_promo_code_for_user', (sql) => sql.replace(/if v_paid_active then\s+return jsonb_build_object\('ok', false, 'code', 'PROMO_PAID_ACTIVE'\);\s+end if;/, ''), runStage);
    expect(failing(r).some((f) => f.startsWith('7.4 '))).toBe(true);
  }, 120_000);

  it('NC-X4: with the maximum-redemption check removed from the redeem function, the race checks go red (the table CHECK is the only guard left)', async () => {
    const r = await withMutation('redeem_promo_code_for_user', (sql) => sql.replace("or (v_promo.max_redemptions is not null and v_promo.redemption_count >= v_promo.max_redemptions)", ''), runStage);
    expect(failing(r).some((f) => f.startsWith('7.1 ') || f.startsWith('7.2 '))).toBe(true);
  }, 120_000);

  it('after the controls the real functions are back and the whole proof is green again', async () => {
    expect(failing(await runStage())).toEqual([]);
  }, 120_000);
});

describe('the DEV proof, stage FINAL (0279 applied, old shapes gone)', () => {
  it('every check passes, and the stage is detected as final', async () => {
    // The cleanup refuses while any code still holds its text (the old release created some during the COEXIST run). Do what the runbook
    // does: prepare them (digest, verify) and finalise, then apply the cleanup.
    await db.exec(`update promo_codes set code_digest = encode(sha256(convert_to(code, 'UTF8')), 'hex'), code_digest_version = 1, code_digest_verified_at = now() where code is not null and code_digest is null`);
    await db.exec(`update promo_codes set code_digest_verified_at = now() where code is not null and code_digest_verified_at is null`);
    await db.exec('select public.promo_codes_finalise_hash_only(false)');
    await applyFiles(279, 279, 'legacy_cleanup');
    const r = await runStage();
    expect(r.stage).toBe('final');
    expect(failing(r)).toEqual([]);
  }, 120_000);
});

describe('the DEV-only residue cleanup (docs/admin/po_apply_promo_hardening_release/cleanup/DEV_ONLY_residue_cleanup.sql)', () => {
  const sql = fs.readFileSync(path.join(MIG_DIR, '..', '..', 'docs', 'admin', 'po_apply_promo_hardening_release', 'cleanup', 'DEV_ONLY_residue_cleanup.sql'), 'utf8');
  const count = async (q: string) => ((await db.query(q)).rows[0] as { n: number }).n;
  const PROOF_NOTES = `('promo hardening proof, safe to disable', 'DEV proof code', 'DEV proof default', 'old shape proof', 'browser certification code, safe to disable')`;

  it('refuses on a database that carries the production marker, and changes nothing', async () => {
    const before = await count(`select count(*)::int n from promo_codes`);
    await db.exec(`insert into platform_deployment_environment(environment) values ('production')`);
    let message = '';
    try {
      await db.exec(sql);
    } catch (e) {
      message = (e as Error).message;
    }
    await db.exec(`delete from platform_deployment_environment`);
    expect(message).toContain('REFUSED');
    expect(await count(`select count(*)::int n from promo_codes`)).toBe(before);
    expect(await count(`select count(*)::int n from pg_trigger where tgrelid = 'public.promo_code_events'::regclass and not tgisinternal and tgenabled = 'O'`), 'append-only protection still on').toBe(2);
  });

  it('removes what the proofs left behind and nothing else, and the append-only protection is back on afterwards', async () => {
    // things that must SURVIVE: a code whose note is not a proof note, and a grant of a user who still exists
    const keeperAdmin = 'eeeeeeee-0000-0000-0000-000000000001';
    const keeperUser = 'eeeeeeee-0000-0000-0000-000000000002';
    await db.exec(`insert into auth.users(id,email,email_confirmed_at) values ('${keeperAdmin}','keeper-admin@keep.test',now()),('${keeperUser}','keeper-user@keep.test',now());
                   insert into admin_users(user_id, can_manage_promo_codes, can_manage_premium_entitlements) values ('${keeperAdmin}', true, true);`);
    const keeper = client(keeperAdmin, 'authenticated');
    const made = await keeper.rpc('admin_create_promo_code', { p_code_digest: 'a'.repeat(64), p_code_hint: 'KE******PR', p_digest_version: 1, p_duration_days: 30, p_max_redemptions: 1, p_unlimited: false, p_expires_on: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), p_no_expiry: false, p_note: 'the operator real code' });
    expect(made.error).toBeNull();
    const grant = await keeper.rpc('admin_manage_premium_entitlement', { p_action: 'grant', p_target_user_id: keeperUser, p_ends_on: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10), p_reason: 'A real grant that must survive', p_override: false });
    expect(grant.error).toBeNull();

    // the proof users are deleted, as the fixture cleanup and the proof do on DEV
    await db.exec(`delete from auth.users where email like '%@promo-proof.invalid' or email like 'fx-%@pg.test' or email like 'u%@promo-proof.invalid'`);
    expect(await count(`select count(*)::int n from promo_codes where note in ${PROOF_NOTES}`), 'the proofs left probe codes').toBeGreaterThan(5);

    await db.exec(sql);

    expect(await count(`select count(*)::int n from promo_codes where note in ${PROOF_NOTES}`), 'probe codes are gone').toBe(0);
    expect(await count(`select count(*)::int n from promo_codes where note = 'the operator real code'`), 'the real code survives').toBe(1);
    expect(await count(`select count(*)::int n from admin_entitlement_events where target_user_id = '${keeperUser}'`), 'the real grant audit row survives').toBe(1);
    expect(await count(`select count(*)::int n from admin_entitlement_events where not exists (select 1 from auth.users u where u.id = target_user_id) and not exists (select 1 from auth.users u where u.id = actor_user_id)`), 'no orphaned proof audit row is left').toBe(0);
    expect(await count(`select count(*)::int n from admin_monitoring_events`)).toBe(0);
    expect(await count(`select count(*)::int n from premium_entitlement_overrides`)).toBe(0);
    expect(await count(`select count(*)::int n from pg_trigger where tgrelid = 'public.promo_code_events'::regclass and not tgisinternal and tgenabled = 'O'`), 'append-only protection is back on').toBe(2);
    // and the protection really works again
    await expect(db.exec(`update promo_code_events set code_hint = code_hint`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`delete from promo_codes where note = 'the operator real code'`)).rejects.toThrow(/never deleted/);
  }, 120_000);

  it('is safe to repeat', async () => {
    await db.exec(sql);
    expect(await count(`select count(*)::int n from promo_codes where note = 'the operator real code'`)).toBe(1);
  });
});
