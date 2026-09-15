// App Review 2026-09-15, item 3, requirement 2:
//
//   "Ensure future migrations never write internal audit text into
//    user-editable/user-visible fields. If provenance must be tracked, store
//    it in an internal audit/metadata column, not `notes`."
//
// A rule that lives only in a code-review habit is a rule that comes back.
// This scans every migration for a literal string containing developer or
// migration provenance being written into a column this app renders to the
// user, and fails if one is found. Migration 0084 — the one the review
// caught — is the worked example the pattern below is built from:
//
//   insert into smsf_funds (..., notes)
//   select ..., 'Backfilled by migration 0084 from the pre-existing
//                retirement_accounts row (Summary Mode, value unchanged).'
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');

// Words that mark a string as developer/migration provenance rather than
// content a household would ever want to read.
const PROVENANCE = /\b(backfilled|backfill|migration \d{3,4}|pre-existing|preexisting|legacy row|TODO|FIXME|deprecated column)\b/i;

// Columns this app renders as user-facing free text or names.
const USER_FACING_COLUMNS = [
  'notes',
  'description',
  'asset_name',
  'liability_name',
  'investment_name',
  'account_name',
  'fund_name',
  'goal_name',
  'expense_name',
  'source_name',
  'policy_name',
  'holding_name',
  'household_name',
  'label',
  'display_name',
];

/** Strip SQL comments — prose in a `--` comment is documentation, not data,
 *  and its apostrophes otherwise fake the start of a string literal. */
function stripComments(src: string): string {
  return src
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Statements (split on `;`) that write a user-facing column, paired with the
 *  single-quoted literals they carry. */
function writingStatements(src: string): { stmt: string; offsetLine: number }[] {
  const code = stripComments(src);
  const out: { stmt: string; offsetLine: number }[] = [];
  let cursor = 0;
  for (const stmt of code.split(';')) {
    const offsetLine = code.slice(0, cursor).split('\n').length;
    cursor += stmt.length + 1;
    if (!/^\s*(insert|update)\b/i.test(stmt)) continue;
    out.push({ stmt, offsetLine });
  }
  return out;
}

function literals(stmt: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stmt)) !== null) out.push(m[1]);
  return out;
}

// The three historical offenders this review uncovered. They are already
// applied to DEV and production, and this repo's rule is forward-only: an
// applied migration is never edited, its effects are re-emitted forward.
// Migration 0156 does exactly that — it cleans the rows they wrote. They stay
// listed here so the guard keeps protecting every NEW migration, and so the
// list itself is the record of what was remediated. Nothing may be added to
// this list: a new entry means a new leak, which is what 0156 exists to stop.
const REMEDIATED_BY_0156 = new Set([
  '0077_retirement_member_target_age.sql',
  '0078_property_liability_linking.sql',
  '0084_geo_jurisdiction_smsf.sql',
]);

describe('item 3 — no migration writes internal provenance into a user-facing column', () => {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));

  it('has migrations to scan (guards against a silently empty sweep)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('finds no provenance literal in a statement that targets a user-facing column', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (REMEDIATED_BY_0156.has(file)) continue;
      const src = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
      for (const { stmt, offsetLine } of writingStatements(src)) {
        // Only an insert/update that actually targets a user-facing column
        // can leak into one.
        if (!USER_FACING_COLUMNS.some((c) => new RegExp(`\\b${c}\\b`).test(stmt))) continue;
        for (const lit of literals(stmt)) {
          if (!PROVENANCE.test(lit)) continue;
          if (lit.length < 25) continue; // an enum value or a key, not prose
          // Migration 0156 is the fix: it matches the offending literals in
          // order to clear or rewrite them, and never writes one anywhere.
          if (file.startsWith('0156_')) continue;
          offenders.push(`${file}:~${offsetLine} -> ${lit.slice(0, 110)}`);
        }
      }
    }
    expect(
      offenders,
      'A migration is writing internal provenance into a user-visible column.\n' +
        'Store it in an internal audit/metadata column instead (see\n' +
        'smsf_funds.backfill_source, added by migration 0156).\n  ' +
        offenders.join('\n  ')
    ).toEqual([]);
  });

  it('migration 0156 remediates every one of the three known offenders', () => {
    const src = fs.readFileSync(path.join(MIGRATIONS, '0156_app_review_0915_clear_leaked_migration_notes.sql'), 'utf8');
    // Internal homes for the provenance, on the two tables that need one.
    expect(src).toMatch(/alter table smsf_funds[\s\S]*?add column if not exists backfill_source/);
    expect(src).toMatch(/alter table retirement_members[\s\S]*?add column if not exists backfill_source/);
    // The three tables the audit found.
    expect(src).toMatch(/update smsf_funds/);
    expect(src).toMatch(/update property_liability_links/);
    expect(src).toMatch(/update retirement_members/);
    // Exact-literal matching only — a user's own note can never be destroyed.
    expect(src).toContain("where notes = 'Backfilled by migration 0084");
    expect(src).toContain("'Auto-linked by migration 0078: exactly one active Principal Residence");
    // The one note that is rewritten rather than cleared keeps its ages.
    expect(src).toContain('None was assumed — please confirm your target retirement age.');
    expect(src).toContain("substring(notes from 'accounts \\(([^)]*)\\)')");
  });

  it('the remediation list is exactly the three offenders found, and no more', () => {
    expect([...REMEDIATED_BY_0156].sort()).toEqual([
      '0077_retirement_member_target_age.sql',
      '0078_property_liability_linking.sql',
      '0084_geo_jurisdiction_smsf.sql',
    ]);
  });
});
