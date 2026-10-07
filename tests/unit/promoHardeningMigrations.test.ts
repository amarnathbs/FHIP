// Items 13 and 14: the hardening migrations 0264 to 0268 — structure, hand-run parts, editor safety, lineage.
//
// NAMED NEGATIVE CONTROLS
//   NC-M1  the parts joined byte-equal each migration file (a changed byte in either breaks it);
//   NC-M2  every part starts on its banner and ends on a completed statement, so each can be pasted alone;
//   NC-M3  no part uses a function or table that is created only in a LATER part (so running A, B, C ... in order always works);
//   NC-M4  the editor-safety rules hold for every part and every migration numbered 0264 or higher;
//   NC-M5  the lint really bites: each rule is shown to flag a deliberately bad snippet (and the confirmed cause, a string with the
//          statement word "into" followed by a name, is flagged);
//   NC-L1  the already APPLIED migrations (0231, 0237, 0238, 0242, 0250, 0251, 0252) are byte-identical to the pinned hashes: an edit is caught;
//   NC-L2  numbering: the new migrations are 0264 to 0268, unique, and above every migration in the repository and above the highest
//          number found on any other ref or worktree when this work was done (0263, NAV2).

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hazards } from '../../scripts/migration_editor_safety_lint.mjs';
import { MIGRATIONS } from '../../scripts/promo_hardening_build_migrations.mjs';
import { MIG_DIR, REPO_ROOT, expectNamedFailure } from './support/promoTestHelpers';

const PARTS_DIR = path.join(REPO_ROOT, 'docs', 'admin', 'po_apply_promo_hardening_release', 'parts');
const part = (name: string) => fs.readFileSync(path.join(PARTS_DIR, `${name}.sql`));
const wholeOf = (file: string) => fs.readFileSync(path.join(MIG_DIR, file));
const text = (b: Buffer) => b.toString('utf8');

/** Highest migration number found on every ref and every worktree (git log --all and every worktree directory) when this work was done. */
const HIGHEST_FOUND_ELSEWHERE = 263;

describe('NC-M1 the hand-run parts are exact slices of the migrations', () => {
  for (const m of MIGRATIONS) {
    it(`${m.file}: the parts ${m.parts.join(', ')} joined are byte-equal to the file`, () => {
      const joined = Buffer.concat(m.parts.map(part));
      expect(joined.equals(wholeOf(m.file))).toBe(true);
    });
  }

  it('the parts directory holds exactly the listed parts and nothing else', () => {
    const listed = MIGRATIONS.flatMap((m) => m.parts.map((p) => `${p}.sql`)).sort();
    expect(fs.readdirSync(PARTS_DIR).sort()).toEqual(listed);
  });

  it('NC-M1: the control is real: changing one byte of a part breaks the equality', () => {
    const m = MIGRATIONS[1];
    const bad = Buffer.from(part('0265c'));
    bad[bad.length - 3] = bad[bad.length - 3] === 0x20 ? 0x21 : 0x20;
    const parts = m.parts.map((p) => (p === '0265c' ? bad : part(p)));
    expect(Buffer.concat(parts).equals(wholeOf(m.file))).toBe(false);
  });
});

describe('NC-M2 and NC-M3 each part can be pasted alone, in order', () => {
  for (const m of MIGRATIONS) {
    it(`${m.file}: banners, completed statements, balanced dollar quotes`, () => {
      m.parts.forEach((p, i) => {
        const sql = text(part(p));
        if (i === 0) expect(sql.startsWith(`-- ${m.file.slice(0, 4)} `), `${p} starts with the migration banner`).toBe(true);
        else expect(sql, `${p} starts on its PART banner`).toMatch(new RegExp(`^-- -{20,}\\n-- PART ${String.fromCharCode(65 + i)} starts here`));
        const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
        expect(code.endsWith(';'), `${p} ends on a completed statement`).toBe(true);
        expect((code.match(/\$fn\$/g) ?? []).length % 2, `${p}: unbalanced $fn$ quotes`).toBe(0);
        expect((code.match(/\$cron\$/g) ?? []).length % 2, `${p}: unbalanced $cron$ quotes`).toBe(0);
      });
    });

    it(`${m.file}: nothing in a part depends on an object created only in a later part`, () => {
      const created = (sql: string) => ({
        tables: [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map((x) => x[1]),
        functions: [...sql.matchAll(/create or replace function public\.(\w+)\s*\(/g)].map((x) => x[1]),
      });
      const defs = m.parts.map((p) => created(text(part(p))));
      m.parts.forEach((p, idx) => {
        const sql = text(part(p));
        const laterOnlyTables = new Set(defs.slice(idx + 1).flatMap((d) => d.tables).filter((t) => !defs.slice(0, idx + 1).some((d) => d.tables.includes(t))));
        const laterOnlyFns = new Set(defs.slice(idx + 1).flatMap((d) => d.functions).filter((f) => !defs.slice(0, idx + 1).some((d) => d.functions.includes(f))));
        // strip comments and string literals before looking for references
        const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/'(?:[^']|'')*'/g, "''");
        for (const t of laterOnlyTables) expect(new RegExp(`public\\.${t}\\b`).test(code), `${p} uses table ${t} before it is created`).toBe(false);
        for (const f of laterOnlyFns) expect(new RegExp(`public\\.${f}\\s*\\(`).test(code), `${p} uses function ${f} before it is created`).toBe(false);
      });
    });
  }
});

describe('NC-M4 and NC-M5 editor safety', () => {
  for (const m of MIGRATIONS) {
    it(`NC-M4: ${m.file} has none of the hazards`, () => {
      expect(hazards(text(wholeOf(m.file)))).toEqual([]);
    });
  }
  it('NC-M4: every part passes too', () => {
    for (const m of MIGRATIONS) for (const p of m.parts) expect(hazards(text(part(p))), p).toEqual([]);
  });
  it('NC-M4: every migration numbered 0264 or higher in this repository passes as well (anything hand applied from now on)', () => {
    const later = fs.readdirSync(MIG_DIR).filter((f) => /^0(2[6-9]|[3-9]\d)\d_.*\.sql$/.test(f) && Number(f.slice(0, 4)) >= 264);
    expect(later.length).toBeGreaterThanOrEqual(5);
    for (const f of later) expect(hazards(text(wholeOf(f))), f).toEqual([]);
  });

  it('NC-M5: the confirmed cause is flagged (into, from or join followed by a name inside a string or a comment) and ordinary text is not', () => {
    expect(hazards("select 'x', false, 'processes events into fund analytics.';\n").join(' ')).toMatch(/string has "into fund"/);
    expect(hazards("select left('Accepted from the review queue: ' || p_note, 500);\n").join(' ')).toMatch(/string has "from the"/);
    expect(hazards("select 'rows are joined with join tables';\n").join(' ')).toMatch(/join tables/);
    expect(hazards('-- the value goes into the ledger\n').join(' ')).toMatch(/comment has "into the"/);
    expect(hazards('-- rows come from the batch\n').join(' ')).toMatch(/comment has "from the"/);
    expect(hazards('-- two things; and a semicolon\n').join(' ')).toMatch(/comment has ; or a quote/);
    expect(hazards("-- it's an apostrophe\n").join(' ')).toMatch(/comment has ; or a quote/);
    expect(hazards("select 'a; b';\n").join(' ')).toMatch(/string has ; or a double quote/);
    expect(hazards('select 1 as "quoted";\n').join(' ')).toMatch(/double quote in code/);
    expect(hazards("select 'café';\n").join(' ')).toMatch(/non-ascii/);
    expect(hazards('select $$x$$;\n').join(' ')).toMatch(/bare dollar quote/);
    expect(hazards("select format('%s', 1);\n").join(' ')).toMatch(/percent sign/);
    // clean text passes, including a tagged dollar quote and real statements
    expect(hazards("-- plain comment, no statement words\ncreate or replace function f() returns int language sql as $fn$ select 1; $fn$;\ninsert into t(a) select 'x' from u;\n")).toEqual([]);
  });

  it('NC-M5: a mutated copy of a real part is flagged (the lint is not vacuous against real files)', async () => {
    const real = text(part('0266b'));
    expect(hazards(real)).toEqual([]);
    const broken = real.replace('A refusal RETURNS a result', 'A refusal RETURNS a result into the audit table');
    await expectNamedFailure(() => expect(hazards(broken), 'the lint finds the statement word in a comment').toEqual([]), 'the lint finds the statement word in a comment');
  });
});

describe('NC-L1 and NC-L2 lineage: the applied migrations are untouched, the numbering is clean', () => {
  const sha = (file: string) => crypto.createHash('sha256').update(text(wholeOf(file)).replace(/\r/g, '')).digest('hex');
  const PINNED: Record<string, string> = {
    '0231_admin_premium_entitlement_grants.sql': 'aac92b5c0e04a24e33a176d3f64ba02b8ca438ff90f3693e1192baa1d0d43628',
    '0237_admin_promo_codes_extension_cap_expiry_summary.sql': 'eec24209db7ca1080ca2bd4cf9474effc69948436219bffd58d24dc88ad999b0',
    '0238_premium_expiry_email_reminders.sql': '5d43850369003341ce7332a61a56a7a6c1ec6d19f85d4cde26baf829927348cf',
    '0242_promo_code_email_send.sql': 'd8a44d9e1484f818c54705bbf61ea03008757ca76a215e27385e112d3d87985f',
    '0250_ii_user_supplied_investment_dates.sql': '08dd29cb46fa0831f56b78d167e8ec6ac7a5cd55c24916fff5269cfd0fbef568',
    '0251_bench1_held_schemes_for_benchmark_mapping.sql': '236fd3422a5453b4f567b9cb6e17ff1691db18556f76ab5cb1b5f4305644970a',
    '0252_bench1_factsheet_benchmark_reader.sql': '72adcd3690b0aee91ff6a66a0fa991c1f265d6f72028d0897fbca5efb93dd454',
  };

  it('NC-L1: 0231, 0237, 0238, 0242, 0250, 0251 and 0252 are byte-identical to the versions that were applied (line endings ignored)', () => {
    for (const [file, hash] of Object.entries(PINNED)) expect(sha(file), `${file} was edited`).toBe(hash);
  });

  it('NC-L1: the pin is real: a one byte edit would change the hash', async () => {
    const file = '0242_promo_code_email_send.sql';
    const edited = crypto.createHash('sha256').update(text(wholeOf(file)).replace(/\r/g, '') + ' ').digest('hex');
    await expectNamedFailure(() => expect(edited, '0242 was edited').toBe(PINNED[file]), '0242 was edited');
  });

  it('the applied ancestors exist and sort before the new migrations, in the order they were applied', () => {
    const files = fs.readdirSync(MIG_DIR).filter((f) => f.endsWith('.sql')).sort();
    const idx = (prefix: string) => files.findIndex((f) => f.startsWith(prefix));
    for (const [a, b] of [['0231_', '0237_'], ['0237_', '0238_'], ['0238_', '0242_'], ['0242_', '0264_'], ['0252_', '0264_'], ['0264_', '0265_'], ['0265_', '0266_'], ['0266_', '0267_'], ['0267_', '0268_'], ['0268_', '0279_'], ['0278_', '0279_']]) {
      expect(idx(a), a).toBeGreaterThanOrEqual(0);
      expect(idx(b), b).toBeGreaterThan(idx(a));
    }
  });

  it('NC-L2: numbers 0264 to 0268 are unique, in this repository nothing else uses them, and all are above the highest number found elsewhere', () => {
    const files = fs.readdirSync(MIG_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f));
    const numbers = files.map((f) => Number(f.slice(0, 4)));
    expect(new Set(numbers).size, 'no two migrations share a number').toBe(numbers.length);
    expect(MIGRATIONS.map((m) => Number(m.file.slice(0, 4)))).toEqual([264, 265, 266, 267, 268, 279]);
    // The five additive ones sit above 0263 (NAV2, the highest when they were written). The cleanup, 0279, sits above 0278
    // (Planning Benchmarks, the highest on main when it was added): nothing on any ref or worktree uses 0279 or above.
    for (const m of MIGRATIONS.slice(0, 5)) expect(Number(m.file.slice(0, 4))).toBeGreaterThan(HIGHEST_FOUND_ELSEWHERE);
    expect(Number(MIGRATIONS[5].file.slice(0, 4))).toBeGreaterThan(278);
    expect(Math.max(...numbers.filter((n) => n < 264))).toBeLessThan(263);
  });

  // DEPLOY SAFETY (the crux): 0264 to 0268 must be ADDITIVE. The release that is live today calls the old function shapes,
  // so none of them may be dropped until the PO runs the separate cleanup, 0279, after the new release is verified.
  it('NC-A1: 0264 to 0268 DROP no function at all (additive: the live release keeps working while the database and the application overlap)', () => {
    for (const m of MIGRATIONS.slice(0, 5)) {
      const code = text(wholeOf(m.file)).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      expect(/drop function/i.test(code), `${m.file} drops a function`).toBe(false);
    }
  });

  it('NC-A1: the control is real: a drop of an old function inside an additive migration is detected', async () => {
    const bad = 'drop function if exists public.redeem_promo_code_for_user(uuid, text, text, text);';
    await expectNamedFailure(() => expect(/drop function/i.test(bad), 'an additive migration drops a function').toBe(false), 'an additive migration drops a function');
  });

  it('every function the cleanup (0279) drops was created by an earlier migration (no phantom drop), and has a live successor created by an earlier hardening migration', () => {
    const earlier = fs
      .readdirSync(MIG_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) < 264)
      .map((f) => text(wholeOf(f)))
      .join('\n');
    const created = new Set([...earlier.matchAll(/create (?:or replace )?function (?:public\.)?(\w+)\s*\(/g)].map((m) => m[1]));
    const hardening = MIGRATIONS.slice(0, 5).map((m) => text(wholeOf(m.file))).join('\n');
    const successor: Record<string, string> = {
      admin_create_promo_code: 'admin_create_promo_code',
      admin_list_promo_codes: 'admin_list_promo_codes_v2',
      redeem_promo_code_for_user: 'redeem_promo_code_for_user',
      admin_manage_premium_entitlement: 'admin_manage_premium_entitlement',
      admin_promo_email_begin: 'admin_promo_email_begin',
    };
    const sql = text(wholeOf(MIGRATIONS[5].file));
    const dropped = [...sql.matchAll(/drop function if exists public\.(\w+)\(/g)].map((d) => d[1]);
    expect(dropped.sort()).toEqual(Object.keys(successor).sort());
    for (const name of dropped) {
      expect(created.has(name), `0279 drops ${name}, which no earlier migration created`).toBe(true);
      expect(new RegExp(`create or replace function public\\.${successor[name]}\\s*\\(`).test(hardening), `0279 drops ${name} but ${successor[name]} is not created by 0264 to 0268`).toBe(true);
    }
  });

  it('every table the new migrations ALTER exists earlier (or is created earlier in the same file)', () => {
    const earlier = fs
      .readdirSync(MIG_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) < 264)
      .map((f) => text(wholeOf(f)))
      .join('\n');
    const known = new Set([...earlier.matchAll(/create table (?:if not exists )?(?:public\.)?(\w+)/g)].map((m) => m[1]));
    for (const m of MIGRATIONS) {
      const sql = text(wholeOf(m.file));
      for (const c of sql.matchAll(/create table if not exists public\.(\w+)/g)) known.add(c[1]);
      for (const a of sql.matchAll(/alter table (?:if exists )?public\.(\w+)/g)) expect(known.has(a[1]), `${m.file} alters ${a[1]}, which is not created before it`).toBe(true);
    }
  });

  it('every new function states its security mode and an empty search_path (or the trigger function the original used), and every grant revokes public first', () => {
    for (const m of MIGRATIONS) {
      const sql = text(wholeOf(m.file));
      const fns = [...sql.matchAll(/create or replace function public\.(\w+)\s*\(([\s\S]*?)\$fn\$/g)];
      for (const f of fns) {
        const head = f[0];
        expect(/set search_path\s*=\s*(''|public, pg_temp|public)/.test(head), `${m.file}: ${f[1]} sets a search_path`).toBe(true);
      }
      for (const g of sql.matchAll(/grant execute on function (public\.\w+\([^)]*\)) to /g)) {
        expect(sql.includes(`revoke all on function ${g[1]} from `), `${m.file}: ${g[1]} is revoked before it is granted`).toBe(true);
      }
    }
  });
});
