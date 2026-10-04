// Migrations 0260, 0261, 0262: the hand-run parts must be exact slices of the migration, and the SQL must avoid the constructs that
// broke a paste into the Supabase SQL editor on DEV (an error "relation NAV2 does not exist" with no position, cause not identified
// for certain: see docs/nav2/po_apply_0260_0262/README.md section 8).
//
// NAMED NEGATIVE CONTROLS
//   NC-M1  the five parts joined byte-equal the migration file (a changed byte in either breaks it);
//   NC-M2  every part ends on a complete statement and starts on its banner, so it can be pasted alone and run alone;
//   NC-M3  no part refers to a table or function that is created only in a LATER part (so running a to e in order always works);
//   NC-M4  the hazard rules below hold for all three files: ASCII only, no uppercase NAV2, no bare dollar quote, no percent sign, no
//          double quote, no semicolon or quote inside a comment, no semicolon inside a string literal;
//   NC-M5  the lint really bites: each rule is shown to flag a deliberately bad snippet.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const PARTS = path.join(ROOT, 'docs', 'nav2', 'po_apply_0260_0262', 'parts');
const find = (prefix: string) => fs.readdirSync(MIG).find((f) => f.startsWith(prefix))!;
const FILES = { '0260': find('0260_'), '0261': find('0261_'), '0262': find('0262_') };
const LETTERS = ['a', 'b', 'c', 'd', 'e'] as const;
const part = (l: string) => fs.readFileSync(path.join(PARTS, `0260${l}.sql`));
const whole = fs.readFileSync(path.join(MIG, FILES['0260']));

/** The rule set (one function so the control can run it against bad text). */
export function hazards(sql: string): string[] {
  const out: string[] = [];
  if (/[^\x00-\x7f]/.test(sql)) out.push('non-ascii');
  if (sql.includes('NAV2')) out.push('uppercase NAV2');
  if (sql.includes('$$')) out.push('bare dollar quote');
  if (sql.includes('%')) out.push('percent sign');
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql.startsWith('--', i)) {
      let j = sql.indexOf('\n', i);
      if (j < 0) j = n;
      const t = sql.slice(i, j);
      if (/[;"']/.test(t)) out.push(`comment has ; or a quote: ${t.slice(0, 50)}`);
      i = j;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j++;
      }
      const lit = sql.slice(i, j + 1);
      if (/[;"]/.test(lit)) out.push(`string has ; or a double quote: ${lit.slice(0, 50)}`);
      i = j + 1;
      continue;
    }
    if (sql[i] === '"') out.push('double quote in code');
    i++;
  }
  return out;
}

describe('0260 parts (NC-M1, NC-M2, NC-M3)', () => {
  it('NC-M1: the five parts joined are byte-equal to the migration file', () => {
    expect(Buffer.concat(LETTERS.map(part)).equals(whole)).toBe(true);
    expect(fs.readdirSync(PARTS).sort()).toEqual(LETTERS.map((l) => `0260${l}.sql`));
  });

  it('NC-M1: the control is real: changing one byte of a part breaks the equality', () => {
    const bad = Buffer.from(part('c'));
    bad[bad.length - 2] = bad[bad.length - 2] === 0x20 ? 0x21 : 0x20;
    expect(Buffer.concat([part('a'), part('b'), bad, part('d'), part('e')]).equals(whole)).toBe(false);
  });

  it('NC-M2: parts b to e start on their PART banner; every part ends on a completed statement', () => {
    for (const l of ['b', 'c', 'd', 'e']) expect(part(l).toString('utf8')).toMatch(new RegExp(`^-- -{20,}\\n-- PART ${l.toUpperCase()} starts here`));
    expect(part('a').toString('utf8').startsWith('-- 0260 --')).toBe(true);
    for (const l of LETTERS) {
      const code = part(l).toString('utf8').split('\n').filter((x) => !x.trim().startsWith('--')).join('\n').trim();
      expect(code.endsWith(';'), `part ${l}`).toBe(true);
      expect(((code.match(/\$fn\$/g) ?? []).length) % 2, `part ${l}: unbalanced dollar quotes`).toBe(0);
    }
  });

  it('NC-M3: nothing in a part depends on an object created only in a later part', () => {
    const created = (sql: string) => ({
      tables: [...sql.matchAll(/create table if not exists (\w+)/g)].map((m) => m[1]),
      functions: [...sql.matchAll(/create or replace function (\w+)\s*\(/g)].map((m) => m[1]),
    });
    const defs = LETTERS.map((l) => created(part(l).toString('utf8')));
    LETTERS.forEach((l, idx) => {
      const sql = part(l).toString('utf8');
      const tablesBefore = new Set(defs.slice(0, idx + 1).flatMap((d) => d.tables).concat(['admin_users', 'ii_reference_job_control']));
      const fnsBefore = new Set(defs.slice(0, idx + 1).flatMap((d) => d.functions));
      const tableRefs = [...sql.matchAll(/(?:references|alter table|create (?:unique )?index (?:if not exists )?\w+\s+on|create trigger \w+ [^;]*? on|drop trigger if exists \w+ on|create policy \w+ on|drop policy if exists \w+ on) (ii_risk_free_\w+)/g)].map((m) => m[1]);
      for (const t of tableRefs) expect(tablesBefore.has(t), `part ${l} uses table ${t} before it is created`).toBe(true);
      const fnRefs = [...sql.matchAll(/(?:execute function|using \(|or |and |not )\s*(is_risk_free_\w+|ii_risk_free_\w+)\(/g)].map((m) => m[1]);
      for (const f of fnRefs) expect(fnsBefore.has(f), `part ${l} uses function ${f} before it is created`).toBe(true);
    });
  });

  it('keeps the contract: six tables, five functions, two predicates, two capability columns, four DISABLED switches', () => {
    const sql = whole.toString('utf8');
    expect((sql.match(/create table if not exists ii_risk_free_/g) ?? []).length).toBe(6);
    for (const f of ['commit_risk_free_upload', 'record_risk_free_refresh_results', 'resolve_risk_free_review_item', 'correct_risk_free_observation', 'set_risk_free_series_state', 'is_risk_free_data_admin', 'is_risk_free_series_switch_admin']) expect(sql).toContain(`create or replace function ${f}(`);
    expect(sql).toMatch(/add column if not exists can_upload_risk_free_data/);
    expect(sql).toMatch(/add column if not exists can_switch_risk_free_series/);
    for (const k of ['nav2_risk_free_weekly_refresh', 'nav2_fund_analytics', 'nav2_trigger_planner', 'nav2_correction_worker']) expect(sql).toMatch(new RegExp(`select '${k}', false,`));
    expect(sql).not.toMatch(/rowtype/);
  });
});

describe('editor safety (NC-M4, NC-M5)', () => {
  for (const [k, f] of Object.entries(FILES)) {
    it(`NC-M4: ${k} has none of the hazards`, () => {
      expect(hazards(fs.readFileSync(path.join(MIG, f), 'utf8'))).toEqual([]);
    });
  }
  it('NC-M4: every part passes too (they are slices, but the check is cheap and explicit)', () => {
    for (const l of LETTERS) expect(hazards(part(l).toString('utf8')), `part ${l}`).toEqual([]);
  });
  it('NC-M5: the lint bites: each rule flags a bad snippet', () => {
    expect(hazards('-- NAV2 note\n')).toContain('uppercase NAV2');
    expect(hazards('select 1; -- it\'s here\n').join(' ')).toMatch(/comment has/);
    expect(hazards("-- a; b\n").join(' ')).toMatch(/comment has/);
    expect(hazards("select 'a; b';\n").join(' ')).toMatch(/string has/);
    expect(hazards('select 1 where x like \'%a\';\n')).toContain('percent sign');
    expect(hazards('create function f() returns int language sql as $$ select 1 $$;')).toContain('bare dollar quote');
    expect(hazards('create policy "p q" on t;\n')).toContain('double quote in code');
    expect(hazards('-- café\n')).toContain('non-ascii');
  });
});
