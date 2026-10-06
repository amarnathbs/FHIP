// The PO pastes docs/ownership/po_apply_0236_dev/*.sql into the Supabase SQL editor. That editor's pre-parser mis-reads the word after
// `into` (and, to be safe, `from` / `join`) INSIDE a comment or string as a statement target (DEV incident 05-10-2026, error 42P01).
// So the READ-ONLY query files written for this hand-over must avoid those constructs. The byte-for-byte shipped files (the migration and
// the backfill) are NOT linted: they are the reviewed artefacts, and the migration is already on DEV with this exact text.
//
// NAMED NEGATIVE CONTROLS
//   NC-H1  the lint flags a comment with "into <word>", a string with "from <word>", a percent sign, a semicolon in a comment, non-ASCII;
//   NC-H2  the pack files that must be byte-identical to a shipped file are (02 / 05 / 09 / 06 with only the last line changed), and the
//          check really fails when one byte is altered;
//   NC-H3  the COMMIT copy cannot be the preview copy by accident: they differ, and only in the final statement.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const PACK = path.join(ROOT, 'docs', 'ownership', 'po_apply_0236_dev');
const read = (f: string) => fs.readFileSync(path.join(PACK, f), 'utf8');

export function hazards(sql: string): string[] {
  const out: string[] = [];
  if (/[^\x00-\x7f]/.test(sql)) out.push('non-ascii');
  if (sql.includes('%')) out.push('percent sign');
  if (sql.includes('$$')) out.push('bare dollar quote');
  const words = /\b(into|from|join)\s+([A-Za-z_][A-Za-z0-9_.]*)/gi;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql.startsWith('--', i)) {
      let j = sql.indexOf('\n', i);
      if (j < 0) j = n;
      const t = sql.slice(i, j);
      if (/[;"']/.test(t)) out.push(`comment has ; or a quote: ${t.slice(0, 40)}`);
      for (const m of t.matchAll(words)) out.push(`comment has "${m[0]}"`);
      i = j;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") break;
        j++;
      }
      const lit = sql.slice(i, j + 1);
      if (/[;"]/.test(lit)) out.push(`string has ; or a double quote: ${lit.slice(0, 40)}`);
      for (const m of lit.matchAll(words)) out.push(`string has "${m[0]}"`);
      i = j + 1;
      continue;
    }
    if (sql[i] === '"') out.push('double quote in code');
    i++;
  }
  return out;
}

const READONLY_FILES = ['01_schema_inventory_BEFORE.sql', '03_schema_inventory_AFTER.sql', '04_preview_counts_readonly.sql', '07_state_after_backfill_readonly.sql', '08_preview_counts_readonly_AGAIN.sql', '10_cron_sweep_jobs_state_readonly.sql'];

describe('PO hand-over pack po_apply_0236_dev', () => {
  for (const f of READONLY_FILES) {
    it(`${f} has no editor hazard and writes nothing`, () => {
      const sql = read(f);
      expect(hazards(sql)).toEqual([]);
      const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
      expect(code).not.toMatch(/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i);
    });
  }

  it('NC-H1: the lint really bites', () => {
    expect(hazards('-- copies into the table\nselect 1;')).not.toEqual([]);
    expect(hazards("select 'rows from the thing';")).not.toEqual([]);
    expect(hazards("select '50%';")).not.toEqual([]);
    expect(hazards('-- a; b\nselect 1;')).not.toEqual([]);
    expect(hazards('select 1; -- café')).not.toEqual([]);
    expect(hazards('-- fine comment\nselect 1;')).toEqual([]);
  });

  it('NC-H2: the shipped artefacts are copied byte for byte', () => {
    const mig = fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', '0236_owner_before_upload_phase1.sql'), 'utf8');
    const backfill = fs.readFileSync(path.join(ROOT, 'docs', 'ownership', 'owner_before_upload_phase1_backfill.sql'), 'utf8');
    expect(read('02_apply_0236_owner_before_upload_phase1.sql')).toBe(mig);
    expect(read('05_backfill_PREVIEW_as_shipped_ROLLBACK.sql')).toBe(backfill);
    expect(read('09_backfill_PREVIEW_again_as_shipped_ROLLBACK.sql')).toBe(backfill);
    expect(read('02_apply_0236_owner_before_upload_phase1.sql') + ' ').not.toBe(mig);
  });

  it('NC-H3: the COMMIT copy differs from the preview copy only in the final statement', () => {
    const preview = read('05_backfill_PREVIEW_as_shipped_ROLLBACK.sql');
    const commit = read('06_backfill_COMMIT.sql');
    expect(commit).not.toBe(preview);
    expect(preview.endsWith('\nrollback;\n')).toBe(true);
    expect(commit).toBe(preview.replace(/\nrollback;\n$/, '\ncommit;\n'));
    expect(/\brollback\b/i.test(commit.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'))).toBe(false);
  });

  it('files 01/03 and 04/08 are the same query', () => {
    expect(read('01_schema_inventory_BEFORE.sql')).toBe(read('03_schema_inventory_AFTER.sql'));
    expect(read('04_preview_counts_readonly.sql')).toBe(read('08_preview_counts_readonly_AGAIN.sql'));
  });
});
