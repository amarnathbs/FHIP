// Runtime proof for migration 0250 (user-supplied investment dates): replays the
// real migration chain from an empty PGlite database and runs
// scripts/ii_investment_date_0250_pglite_verification.mjs, which proves
// (anti-vacuity first, then after, then re-apply) the table, RLS with a
// SELECT-only policy, refused client writes, the constraints, the one-live-
// answer-per-position index, the foreign-key behaviour and that applying the
// file twice is a no-op.
//
// The script takes about a minute (it replays 217 migrations).
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const FILE = 'supabase/migrations/0250_ii_user_supplied_investment_dates.sql';

describe('migration 0250 -- static contract', () => {
  const sql = readFileSync(path.join(ROOT, FILE), 'utf8');
  it('is additive and idempotent: no DROP, every create is guarded, nothing is rewritten', () => {
    expect(sql).not.toMatch(/\bdrop\s+(table|column|constraint)\b/i);
    expect(sql).toMatch(/create table if not exists public\.ii_investment_date_inputs/);
    expect(sql).toMatch(/create unique index if not exists uidx_ii_investment_date_inputs_active/);
    expect(sql).toMatch(/drop policy if exists "read own ii_investment_date_inputs"/); // re-creating ITS OWN policy only
    expect(sql).not.toMatch(/alter table (?!public\.ii_investment_date_inputs)/i); // touches no other table
  });
  it('is numbered 0250 or higher (0242-0249 are reserved for sibling branches)', () => {
    expect(Number(path.basename(FILE).slice(0, 4))).toBeGreaterThanOrEqual(250);
  });
  it('has no write policy for the client roles, and revokes their write privileges', () => {
    expect(sql).not.toMatch(/for (insert|update|delete|all)/i);
    expect(sql).toMatch(/revoke insert, update, delete, truncate on public\.ii_investment_date_inputs from anon, authenticated/);
  });
});

describe('migration 0250 -- PGlite runtime proof', () => {
  it('passes every named check on a clean replay, with the schema fingerprint proving the migration changed something and re-applying changed nothing', () => {
    const out = execFileSync(process.execPath, ['scripts/ii_investment_date_0250_pglite_verification.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 540_000, maxBuffer: 20 * 1024 * 1024 });
    expect(out).not.toMatch(/\bFAIL\b/);
    expect(out).toContain('ALL CHECKS PASSED');
    for (const named of [
      'BEFORE: ii_investment_date_inputs does not exist',
      'exactly one policy exists and it is SELECT-only',
      'tenant A cannot INSERT (a forged date or provenance is refused: 42501)',
      'at most ONE live answer per position (unique violation 23505)',
      're-applying 0250 is a no-op',
    ]) {
      expect(out, `check not run: ${named}`).toContain(named);
    }
  }, 560_000);

  it('NEGATIVE CONTROL: a broken copy (policy widened to ALL, RLS off, live-answer index removed, privileges not revoked) fails the same proof by name', () => {
    const sql = readFileSync(path.join(ROOT, FILE), 'utf8');
    const broken = sql
      .replace('for select using (auth.uid() = user_id)', 'for all using (auth.uid() = user_id) with check (auth.uid() = user_id)')
      .replace('alter table public.ii_investment_date_inputs enable row level security;', '')
      .replace(/create unique index if not exists uidx_ii_investment_date_inputs_active[\s\S]*?;/, '')
      .replace('revoke insert, update, delete, truncate on public.ii_investment_date_inputs from anon, authenticated;', '');
    expect(broken).not.toEqual(sql);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ii0250-'));
    const file = path.join(dir, 'broken_0250.sql');
    writeFileSync(file, broken);
    const r = spawnSync(process.execPath, ['scripts/ii_investment_date_0250_pglite_verification.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 540_000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, II0250_FILE: file } });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/FAIL {2}ii_investment_date_inputs exists with row level security ENABLED/);
    expect(r.stdout).toMatch(/FAIL {2}exactly one policy exists and it is SELECT-only/);
    expect(r.stdout).toMatch(/FAIL {2}at most ONE live answer per position/);
    expect(r.stdout).toMatch(/FAIL {2}tenant A cannot INSERT/);
  }, 560_000);
});
