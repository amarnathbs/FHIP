import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Chunk 3a RLS verification.
//
// IMPORTANT, disclosed limitation: this sandbox has no DDL execution
// capability (no live DEV/production access) and, per the discovery doc's
// re-check, still has no PGlite/db-rebuild-check tooling on this branch
// (confirmed absent again at the start of this sub-chunk — `scripts/`
// contains no pglite/db-rebuild-check script). A genuine live adversarial
// "User A cannot read User B's row" exploit test — the kind run for the
// FDH-1/Investment-Intelligence modules per prior session memory — is
// therefore NOT POSSIBLE here, and this file does not pretend otherwise.
//
// What this file DOES verify, directly against the actual migration SQL
// text (not by eyeballing it): every new Chunk 3a table (1) enables row
// level security and (2) carries the exact same owner-only predicate,
// `auth.uid() = user_id`, used on BOTH sides of the policy (using + with
// check) that every other user-owned table in this codebase already uses
// (0001_foundation.sql, 0003_module2.sql, 0009_module7_goals.sql's
// household_members). This catches the real regression risk available in
// this sandbox — forgetting to enable RLS, using the wrong column, using a
// weaker predicate, or missing a table entirely — even though it cannot
// prove the policy is enforced by a running Postgres instance.

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'supabase', 'migrations');

function readMigration(filename: string): string {
  return readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
}

const OWNER_ONLY_POLICY = /using \(auth\.uid\(\) = user_id\)\s+with check \(auth\.uid\(\) = user_id\)/i;

function assertOwnerOnlyRls(sql: string, table: string) {
  const enableRe = new RegExp(`alter table ${table} enable row level security`, 'i');
  expect(sql, `${table}: expected "enable row level security"`).toMatch(enableRe);

  // The policy block for this table specifically (from its "create policy"
  // line up to the next blank line/EOF) — narrows the match so a
  // multi-table migration file can't accidentally pass on another table's
  // correctly-written policy.
  const policyBlockRe = new RegExp(`create policy "[^"]+" on ${table}[\\s\\S]*?;`, 'i');
  const match = sql.match(policyBlockRe);
  expect(match, `${table}: expected a "create policy ... on ${table}" block`).not.toBeNull();
  expect(match![0], `${table}: policy must use the owner-only auth.uid() = user_id predicate on both using and with check`).toMatch(
    OWNER_ONLY_POLICY
  );
}

describe('Chunk 3a — new table RLS matches the established owner-only pattern', () => {
  it('smsf_holdings (migration 0070)', () => {
    const sql = readMigration('0070_smsf_structured_model.sql');
    expect(sql).toMatch(/create table smsf_holdings/i);
    // Every row must carry its own user_id — no table in this schema relies
    // on an implicit/joined ownership check.
    expect(sql).toMatch(/user_id uuid not null references auth\.users\(id\) on delete cascade/i);
    assertOwnerOnlyRls(sql, 'smsf_holdings');
  });

  it('retirement_contributions (migration 0071)', () => {
    const sql = readMigration('0071_retirement_member_contribution_model.sql');
    expect(sql).toMatch(/create table retirement_contributions/i);
    expect(sql).toMatch(/user_id uuid not null references auth\.users\(id\) on delete cascade/i);
    assertOwnerOnlyRls(sql, 'retirement_contributions');
  });

  it('household_members already has owner-only RLS (0009) — the table item 4 links target_retirement_age onto', () => {
    const sql = readMigration('0009_module7_goals.sql');
    assertOwnerOnlyRls(sql, 'household_members');
  });
});

describe('Chunk 3a — additive-only guarantees, verified textually', () => {
  it('none of the new migration files contain a DROP or destructive statement', () => {
    for (const file of [
      '0068_master_item_category_metadata.sql',
      '0069_master_item_category_metadata_seed.sql',
      '0070_smsf_structured_model.sql',
      '0071_retirement_member_contribution_model.sql',
      '0072_india_retirement_catalogue.sql',
    ]) {
      const sql = readMigration(file).toLowerCase();
      expect(sql, `${file} must not DROP anything`).not.toMatch(/\bdrop\s+(table|column)\b/);
      expect(sql, `${file} must not TRUNCATE anything`).not.toMatch(/\btruncate\b/);
      expect(sql, `${file} must not DELETE any row`).not.toMatch(/\bdelete\s+from\b/);
    }
  });

  it('0068 uses "add column if not exists" for every new master_financial_items column (safe against a re-run)', () => {
    const sql = readMigration('0068_master_item_category_metadata.sql');
    const addColumnLines = sql.match(/add column[^,;]+/gi) ?? [];
    expect(addColumnLines.length).toBeGreaterThan(0);
    for (const line of addColumnLines) {
      expect(line, `expected "if not exists" in: ${line}`).toMatch(/if not exists/i);
    }
  });

  it('0072 inserts India retirement items with "on conflict ... do nothing" (safe, additive)', () => {
    const sql = readMigration('0072_india_retirement_catalogue.sql');
    expect(sql).toMatch(/insert into master_financial_items/i);
    expect(sql).toMatch(/on conflict \(category, item_key\) do nothing/i);
    for (const key of ['epf', 'ppf', 'nps']) {
      expect(sql).toMatch(new RegExp(`'retirement',\\s*'${key}'`, 'i'));
    }
  });
});
