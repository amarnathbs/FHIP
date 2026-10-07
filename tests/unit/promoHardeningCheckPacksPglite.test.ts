// The PO hand-over check packs (docs/admin/po_apply_promo_hardening_release/checks/*.sql), run for real on PGlite at the stage each
// one is meant for, so a check that cannot run, or that says false on a healthy database, is found HERE and not on the PO's screen.
//
//   D1   the detection pack, on the OLD-WORLD database (the ledger up to 0252): sections A and B true, section C says false (nothing
//        applied yet) and ok is true, section D/F carry facts, the five old function fingerprints equal the repository text;
//   V*   each verification pack right after the migration it belongs to: every row ok;
//   the pack files are editor safe (the same lint as the migrations) and D1 is exactly what its generator writes.
//
// NAMED NEGATIVE CONTROLS
//   NC-K1  an old function edited by hand (a drifted database) turns its fingerprint row red in D1;
//   NC-K2  a migration that DROPPED an old function (instead of adding beside it) turns the V0265 count rows red;
//   NC-K3  a database where a plain code survived the finalise turns V-finalise red;
//   NC-K4  the pack lint really bites: a pack with a statement word followed by a name in a comment is flagged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { hazards } from '../../scripts/migration_editor_safety_lint.mjs';
import { fingerprints, OLD_FUNCTIONS } from '../../scripts/promo_hardening_build_checks.mjs';
import { MIG_DIR, REPO_ROOT, expectNamedFailure, migrationFiles, replayAll } from './support/promoTestHelpers';

const PACK_DIR = path.join(REPO_ROOT, 'docs', 'admin', 'po_apply_promo_hardening_release', 'checks');
const pack = (name: string) => fs.readFileSync(path.join(PACK_DIR, name), 'utf8');
const file = (n: number) => migrationFiles().find((f) => f.startsWith(String(n).padStart(4, '0')) && (n !== 279 || f.includes('legacy_cleanup')))!;

interface Row {
  section?: string;
  check_name: string;
  actual: string | null;
  expected: string | null;
  ok: boolean;
}

let db: PGlite;
const run = async (name: string): Promise<Row[]> => (await db.query(pack(name))).rows as Row[];
const failing = (rows: Row[]) => rows.filter((r) => !r.ok).map((r) => `${r.check_name} (actual ${r.actual}, expected ${r.expected})`);
const apply = async (n: number) => db.exec(fs.readFileSync(path.join(MIG_DIR, file(n)), 'utf8'));

beforeAll(async () => {
  db = await PGlite.create();
  await replayAll(db, '0252_zzz');
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('D1 detection pack on the OLD-WORLD database', () => {
  it('every row is ok: the state this release was built against, the old functions match the repository, nothing is applied yet', async () => {
    const rows = await run('D1_before_detect.sql');
    expect(rows.length).toBeGreaterThan(30);
    expect(failing(rows)).toEqual([]);
    expect(rows.filter((r) => r.section === 'C').every((r) => r.actual === 'false')).toBe(true);
    expect(rows.filter((r) => r.section === 'B')).toHaveLength(OLD_FUNCTIONS.length);
  });

  it('the fingerprints in the file are the ones the generator computes from the migrations', () => {
    const text = pack('D1_before_detect.sql');
    for (const [name, md5] of Object.entries(fingerprints())) expect(text, name).toContain(md5);
  });

  it('NC-K1: a drifted old function (edited by hand) turns exactly its fingerprint row red', async () => {
    const def = (await db.query(`select pg_get_functiondef(to_regprocedure('public.admin_promo_email_begin(text,integer,boolean)')) d`)).rows[0] as { d: string };
    const edited = def.d.replace('PROMO_EMAIL_RATE_LIMITED', 'PROMO_EMAIL_RATE_LIMITED_X');
    expect(edited, 'the mutation must change the text').not.toBe(def.d);
    await db.exec(edited);
    try {
      const rows = await run('D1_before_detect.sql');
      const bad = failing(rows);
      await expectNamedFailure(() => expect(bad, 'the database matches the repository').toEqual([]), 'the database matches the repository');
      expect(bad.length).toBe(1);
      expect(bad[0]).toContain('e-mail request start');
    } finally {
      await db.exec(def.d);
    }
    expect(failing(await run('D1_before_detect.sql'))).toEqual([]);
  });

  it('is read only: running it changes nothing (row counts of every promo table are the same before and after)', async () => {
    const count = async () => JSON.stringify((await db.query(`select (select count(*) from promo_codes) a, (select count(*) from promo_code_events) b, (select count(*) from user_entitlements) c, (select count(*) from promo_email_requests) d`)).rows[0]);
    const before = await count();
    await run('D1_before_detect.sql');
    expect(await count()).toBe(before);
  });
});

describe('V packs, each right after its migration', () => {
  it('V0264 after 0264: every row ok', async () => {
    await apply(264);
    expect(failing(await run('V0264_after_0264.sql'))).toEqual([]);
  });

  it('V0265 after 0265: every row ok (the new functions stand beside the old ones)', async () => {
    await apply(265);
    expect(failing(await run('V0265_after_0265.sql'))).toEqual([]);
  });

  it('V0266 after 0266: every row ok', async () => {
    await apply(266);
    expect(failing(await run('V0266_after_0266.sql'))).toEqual([]);
  });

  it('V0267 after 0267: every row ok, and the switches are off', async () => {
    await apply(267);
    expect(failing(await run('V0267_after_0267.sql'))).toEqual([]);
  });

  it('V0268 after 0268: every row ok', async () => {
    await apply(268);
    expect(failing(await run('V0268_after_0268.sql'))).toEqual([]);
  });

  it('D1 after the migrations now says the new things exist (section C flips) and nothing else is lost: section A and B stay ok', async () => {
    const rows = await run('D1_before_detect.sql');
    const sectionC = rows.filter((r) => r.section === 'C');
    expect(sectionC.every((r) => !r.ok), 'every "not applied yet" row now reads as applied').toBe(true);
    expect(failing(rows.filter((r) => r.section === 'A' || r.section === 'B' || r.section === 'E'))).toEqual([]);
  });

  it('NC-K2: had 0265 DROPPED an old function instead of adding beside it, the V0265 count rows would be red', async () => {
    await db.exec(`drop function public.redeem_promo_code_for_user(uuid, text, text, text)`);
    try {
      const bad = failing(await run('V0265_after_0265.sql'));
      await expectNamedFailure(() => expect(bad, 'the old function is still beside the new one').toEqual([]), 'the old function is still beside the new one');
      expect(bad.some((b) => b.startsWith('redeem functions'))).toBe(true);
    } finally {
      const old = fs.readFileSync(path.join(MIG_DIR, migrationFiles().find((f) => f.startsWith('0242'))!), 'utf8');
      const m = /create or replace function public\.redeem_promo_code_for_user[\s\S]*?\n\$fn\$;\n\nrevoke all on function public\.redeem_promo_code_for_user\(uuid, text, text, text\)[^\n]*\ngrant execute on function public\.redeem_promo_code_for_user\(uuid, text, text, text\)[^\n]*/.exec(old);
      await db.exec(m![0]);
    }
    expect(failing(await run('V0265_after_0265.sql'))).toEqual([]);
  });
});

describe('packs after the existing codes are prepared, finalised and cleaned up', () => {
  it('V-prepare: with an old plain code present, the pack is red until it has a verified copy, then green; the finalise pack follows', async () => {
    const user = '99999999-0000-0000-0000-000000000001';
    await db.exec(`insert into auth.users(id,email,email_confirmed_at) values ('${user}','pk@pg.test',now()); insert into admin_users(user_id, can_manage_promo_codes) values ('${user}', true);`);
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: user, role: 'authenticated' })]);
    await db.exec('set role authenticated;');
    await db.query(`select public.admin_create_promo_code(p_code => 'PACKCHECK22', p_duration_days => 30, p_max_redemptions => 2, p_unlimited => false, p_expires_on => (current_date + 30), p_no_expiry => false, p_note => null::text)`);
    await db.exec('reset role;');
    const red = failing(await run('V_after_prepare_existing_codes.sql'));
    expect(red.some((r) => r.startsWith('codes that hold their text but have NO verified protected copy'))).toBe(true);
    // prepare it the way the backfill does
    await db.exec(`update promo_codes set code_digest = encode(sha256(convert_to(code, 'UTF8')), 'hex'), code_digest_version = 1, code_digest_verified_at = now() where code is not null`);
    expect(failing(await run('V_after_prepare_existing_codes.sql'))).toEqual([]);
  });

  it('NC-K3: V-finalise is RED while a plain code survives, and green after the finalise', async () => {
    const bad = failing(await run('V_after_finalise.sql'));
    await expectNamedFailure(() => expect(bad, 'no plain code survives the finalise').toEqual([]), 'no plain code survives the finalise');
    await db.exec(`select public.promo_codes_finalise_hash_only(false)`);
    expect(failing(await run('V_after_finalise.sql'))).toEqual([]);
  });

  it('V0279 after the cleanup: every row ok', async () => {
    await apply(279);
    expect(failing(await run('V0279_after_0279.sql'))).toEqual([]);
  });
});

describe('the pack files themselves', () => {
  const files = fs.readdirSync(PACK_DIR).filter((f) => f.endsWith('.sql'));

  it('there is a detection pack and a verification pack for every step of the runbook', () => {
    expect(files.sort()).toEqual(['D1_before_detect.sql', 'V0264_after_0264.sql', 'V0265_after_0265.sql', 'V0266_after_0266.sql', 'V0267_after_0267.sql', 'V0268_after_0268.sql', 'V0279_after_0279.sql', 'V_after_finalise.sql', 'V_after_prepare_existing_codes.sql']);
  });

  it('every pack passes the editor safety lint (ASCII, no percent sign, no statement word followed by a name in a comment or string)', () => {
    for (const f of files) expect(hazards(pack(f)), f).toEqual([]);
  });

  it('every pack is a single statement (the editor shows only the last result of a run) and writes nothing', () => {
    for (const f of files) {
      const code = pack(f).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      expect(code.trim().split(';').filter((s) => s.trim() !== ''), `${f} has one statement`).toHaveLength(1);
      expect(/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i.test(code.replace(/'(?:[^']|'')*'/g, "''")), `${f} writes nothing`).toBe(false);
    }
  });

  it('NC-K4: the lint bites on a pack with a statement word and a name in a comment', async () => {
    const bad = pack('V0264_after_0264.sql').replace('-- Paste the whole file in the SQL editor', '-- Paste the whole file into the SQL editor');
    expect(bad, 'the mutation must change the text').not.toBe(pack('V0264_after_0264.sql'));
    await expectNamedFailure(() => expect(hazards(bad), 'the pack is editor safe').toEqual([]), 'the pack is editor safe');
  });
});

describe('the emergency files (stop and resume the promo e-mails without a redeploy)', () => {
  const EMERGENCY = path.join(REPO_ROOT, 'docs', 'admin', 'po_apply_promo_hardening_release', 'emergency');
  const sql = (f: string) => fs.readFileSync(path.join(EMERGENCY, f), 'utf8');
  const status = async () => ((await db.query(`select public.promo_email_circuit_status() v`)).rows[0] as { v: { open: boolean } }).v.open;

  it('both files are editor safe', () => {
    for (const f of ['STOP_promo_emails.sql', 'RESUME_promo_emails.sql']) expect(hazards(sql(f)), f).toEqual([]);
  });

  it('STOP opens the pause (the breaker status the application reads says open), RESUME closes it, both are safe to repeat', async () => {
    expect(await status()).toBe(false);
    await db.exec(sql('STOP_promo_emails.sql'));
    expect(await status(), 'sending is paused after STOP').toBe(true);
    await db.exec(sql('STOP_promo_emails.sql'));
    expect(await status()).toBe(true);
    await db.exec(sql('RESUME_promo_emails.sql'));
    expect(await status(), 'sending is allowed again after RESUME').toBe(false);
    await db.exec(sql('RESUME_promo_emails.sql'));
    expect(await status()).toBe(false);
  });

  it('STOP works on a database where the pause row was never created (a fresh project)', async () => {
    await db.exec('delete from public.promo_email_circuit');
    await db.exec(sql('STOP_promo_emails.sql'));
    expect(await status()).toBe(true);
    await db.exec(sql('RESUME_promo_emails.sql'));
    expect(await status()).toBe(false);
  });
});
