// Runtime proof for migration 0240 (Net Worth current-NAV re-mark): replays the
// real migration chain from an empty PGlite database and runs
// scripts/networth_0240_pglite_verification.mjs, which proves (anti-vacuity first,
// then after, then re-apply) the six nullable investments columns, the basis CHECK,
// the RLS select-only owner policy, service-role insert, append-only revisions,
// cascade, and that applying the file twice is a no-op.
//
// The script takes about a minute on a loaded machine (it replays 230+ migrations).

import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

describe('migration 0240 -- PGlite runtime proof', () => {
  it('passes every named check on a clean replay, with the schema fingerprint proving the migration changed something and re-applying changed nothing', () => {
    const out = execFileSync(process.execPath, ['scripts/networth_0240_pglite_verification.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 540_000, maxBuffer: 20 * 1024 * 1024 });
    expect(out).not.toMatch(/\bFAIL\b/);
    expect(out).toContain('ALL CHECKS PASSED');
    for (const named of [
      'BEFORE: none of the six valuation columns exists on investments',
      'no backfill: every pre-existing row keeps its current_value and updated_at',
      'exactly one policy exists and it is SELECT-only',
      'tenant A cannot INSERT a revision (forged history refused: 42501)',
      'append-only: an UPDATE of a written revision is refused even for the service role',
      're-applying 0240 is a no-op',
    ]) {
      expect(out, `check not run: ${named}`).toContain(named);
    }
  }, 560_000);

  it('NEGATIVE CONTROL: a broken copy of 0240 (immutability trigger removed, policy widened to ALL, RLS not enabled) fails the same proof by name', () => {
    const sql = readFileSync(path.join(ROOT, 'supabase/migrations/0240_networth_current_nav_remark.sql'), 'utf8');
    const broken = sql
      .replace(/drop trigger if exists trg_ii_investment_value_revisions_immutable[\s\S]*?execute function ii_investment_value_revisions_immutable\(\);/, '')
      .replace('for select using (auth.uid() = user_id)', 'for all using (auth.uid() = user_id) with check (auth.uid() = user_id)')
      .replace('alter table ii_investment_value_revisions enable row level security;', '');
    expect(broken).not.toEqual(sql);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'nw0240-'));
    const file = path.join(dir, 'broken_0240.sql');
    writeFileSync(file, broken);
    const r = spawnSync(process.execPath, ['scripts/networth_0240_pglite_verification.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 540_000, maxBuffer: 20 * 1024 * 1024, env: { ...process.env, NW0240_FILE: file } });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/FAIL {2}ii_investment_value_revisions exists with row level security ENABLED/);
    expect(r.stdout).toMatch(/FAIL {2}exactly one policy exists and it is SELECT-only/);
    expect(r.stdout).toMatch(/FAIL {2}append-only: an UPDATE of a written revision is refused even for the service role/);
  }, 560_000);
});
