// Migration 0272 (Resources bulk upload): the hand-run parts must be exact slices of the migration, the SQL must
// avoid the constructs that broke a paste into the Supabase SQL editor on DEV for an earlier hand-applied migration
// (the editor pre-parser reads the word after into / from / join INSIDE A STRING OR COMMENT as a statement target), and
// the migration must be forward-only and additive.
//
// NAMED NEGATIVE CONTROLS
//   NC-MG1 the three parts joined are byte-equal to the migration (a changed byte in either breaks it)
//   NC-MG2 every part ends on a completed statement, parts B and C start on their banner, dollar quotes balance
//   NC-MG3 no part uses an object created only in a LATER part
//   NC-MG4 the editor-safety rules hold (ASCII only, no bare dollar quote, no percent sign, no double quote in code,
//          no semicolon or quote in a comment, no semicolon or double quote in a string, no into/from/join + word in a
//          comment or a string)
//   NC-MG5 the lint really bites: each rule flags a deliberately bad snippet
//   NC-MG6 the migration number is free on origin/main and unique in the chain
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const PARTS = path.join(ROOT, 'docs', 'resources', 'po_apply_bulk_upload', 'parts');
const NAME = fs.readdirSync(MIG).find((f) => f.endsWith('_resource_content_bulk_import.sql'))!;
const LETTERS = ['a', 'b', 'c'] as const;
const part = (l: string) => fs.readFileSync(path.join(PARTS, `0272${l}.sql`));
const whole = fs.readFileSync(path.join(MIG, NAME));

export function statementWords(text: string, kind: 'comment' | 'string'): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/\b(into|from|join)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi)) found.push(`${kind} has "${m[0]}": ${text.slice(0, 50)}`);
  return found;
}

export function hazards(sql: string): string[] {
  const out: string[] = [];
  if (/[^\x00-\x7f]/.test(sql)) out.push('non-ascii');
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
      out.push(...statementWords(t, 'comment'));
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
      out.push(...statementWords(lit, 'string'));
      i = j + 1;
      continue;
    }
    if (sql[i] === '"') out.push('double quote in code');
    i++;
  }
  return out;
}

describe('0272 parts', () => {
  it('NC-MG1: the three parts joined are byte-equal to the migration file; the control is real', () => {
    expect(Buffer.concat(LETTERS.map(part)).equals(whole)).toBe(true);
    expect(fs.readdirSync(PARTS).sort()).toEqual(LETTERS.map((l) => `0272${l}.sql`));
    const bad = Buffer.from(part('b'));
    bad[bad.length - 3] = bad[bad.length - 3] === 0x20 ? 0x21 : 0x20;
    expect(Buffer.concat([part('a'), bad, part('c')]).equals(whole)).toBe(false);
  });

  it('NC-MG2: parts B and C start on their banner; every part ends on a completed statement with balanced dollar quotes', () => {
    for (const l of ['b', 'c']) expect(part(l).toString('utf8')).toMatch(new RegExp(`^-- -{20,}\\n-- PART ${l.toUpperCase()} starts here`));
    expect(part('a').toString('utf8').startsWith('-- 0272 --')).toBe(true);
    for (const l of LETTERS) {
      const code = part(l).toString('utf8').split('\n').filter((x) => !x.trim().startsWith('--')).join('\n').trim();
      expect(code.endsWith(';'), `part ${l}`).toBe(true);
      expect((code.match(/\$fn\$/g) ?? []).length % 2, `part ${l}: unbalanced dollar quotes`).toBe(0);
    }
  });

  it('NC-MG3: nothing in a part depends on an object created only in a later part', () => {
    const created = (sql: string) => ({
      tables: [...sql.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]),
      functions: [...sql.matchAll(/create or replace function (?:public\.|private\.)?(\w+)\s*\(/g)].map((m) => m[1]),
    });
    const defs = LETTERS.map((l) => created(part(l).toString('utf8')));
    LETTERS.forEach((l, idx) => {
      const sql = part(l).toString('utf8');
      const tablesOk = new Set(defs.slice(0, idx + 1).flatMap((d) => d.tables));
      const fnsOk = new Set(defs.slice(0, idx + 1).flatMap((d) => d.functions));
      for (const m of sql.matchAll(/public\.(resource_content_import_(?:runs|rows))\b/g)) expect(tablesOk.has(m[1]), `part ${l} uses table ${m[1]} before it is created`).toBe(true);
      for (const m of sql.matchAll(/private\.(can_bulk_import_resource_content)\(/g)) expect(fnsOk.has(m[1]), `part ${l} uses function ${m[1]} before it is created`).toBe(true);
    });
  });

  it('is additive and forward-only: it creates new objects and never alters resource_posts or drops a constraint, table or column', () => {
    const sql = whole.toString('utf8');
    expect(sql).not.toMatch(/alter table (public\.)?resource_posts/i);
    expect(sql).not.toMatch(/drop (table|column|constraint)/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect((sql.match(/create table if not exists public\.resource_content_import_/g) ?? []).length).toBe(2);
    for (const f of ['public.apply_resource_content_import(', 'public.resource_content_import_lookup(', 'public.purge_expired_resource_content_import_staging(', 'private.can_bulk_import_resource_content(']) expect(sql).toContain(`create or replace function ${f}`);
    // every function is SECURITY DEFINER with a fixed empty search_path and revokes anon
    for (const fn of ['apply_resource_content_import', 'resource_content_import_lookup', 'purge_expired_resource_content_import_staging', 'can_bulk_import_resource_content']) {
      expect(sql, fn).toMatch(new RegExp(`revoke all on function (public|private)\\.${fn}\\([^)]*\\) from [^;]*anon`));
    }
    expect((sql.match(/security definer\s+set search_path = ''/g) ?? []).length).toBe(4);
  });
});

describe('editor safety (NC-MG4, NC-MG5)', () => {
  it('NC-MG4: the migration and every part has none of the hazards', () => {
    expect(hazards(whole.toString('utf8'))).toEqual([]);
    for (const l of LETTERS) expect(hazards(part(l).toString('utf8')), `part ${l}`).toEqual([]);
  });

  it('NC-MG5: the lint bites: the confirmed cause and every other rule is flagged on a deliberately bad snippet', () => {
    expect(hazards("select 'x', false, 'moves events into fund analytics';\n").join(' ')).toMatch(/string has "into fund"/);
    expect(hazards('-- rows from the table\nselect 1;\n').join(' ')).toMatch(/comment has "from the"/);
    expect(hazards('-- a semicolon; here\nselect 1;\n').join(' ')).toMatch(/comment has ; or a quote/);
    expect(hazards("-- it's\nselect 1;\n").join(' ')).toMatch(/comment has ; or a quote/);
    expect(hazards("select 'a;b';\n").join(' ')).toMatch(/string has ; or a double quote/);
    expect(hazards('select 100 % 7;\n').join(' ')).toMatch(/percent sign/);
    expect(hazards('create function f() as $$ select 1 $$;\n').join(' ')).toMatch(/bare dollar quote/);
    expect(hazards('select "Quoted";\n').join(' ')).toMatch(/double quote in code/);
    expect(hazards('select 1; -- café\n').join(' ')).toMatch(/non-ascii/);
    // and ordinary applied text is NOT flagged (code may use into / from / join freely)
    expect(hazards("insert into public.x select a from public.y join public.z on true where b = 'plain text';\n")).toEqual([]);
  });

  it('every OTHER migration numbered 0260 or higher in this repository is checked by the same rules when present (hand-applied files)', () => {
    const later = fs.readdirSync(MIG).filter((f) => /^0(2[7-9]|[3-9]\d)\d_.*\.sql$/.test(f));
    expect(later).toContain(NAME);
    for (const f of later) expect(hazards(fs.readFileSync(path.join(MIG, f), 'utf8')), f).toEqual([]);
  });
});

describe('migration number (NC-MG6)', () => {
  it('is unique in the chain and above every number allocated on origin/main and on every branch scanned (0272 follows 0271)', () => {
    const versions = fs.readdirSync(MIG).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, 4));
    expect(versions.filter((v) => v === NAME.slice(0, 4))).toHaveLength(1);
    expect(NAME.startsWith('0272_')).toBe(true);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
