// Static guards on migration 0232 (the behavioural proof is the PGlite script
// scripts/india_mf_0232_pglite_verification.mjs, 42 checks). These catch the
// failure modes a source scan CAN catch: the shared-constraint trap, a missing
// RLS enable, a missing revoke, an accidental schedule, and number collisions.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const MIGS = path.join(ROOT, 'supabase', 'migrations');
const FILE = fs.readdirSync(MIGS).find((f) => f.startsWith('0232_'))!;
const sql = fs.readFileSync(path.join(MIGS, FILE), 'utf8');
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

describe('migration 0232', () => {
  it('has a unique number in the repository migration directory', () => {
    const same = fs.readdirSync(MIGS).filter((f) => f.startsWith('0232_'));
    expect(same).toEqual([FILE]);
  });
  it('drops/recreates NO constraint and touches no shared audit-event list (the sibling-branch trap)', () => {
    expect(code).not.toMatch(/drop\s+constraint/i);
    expect(code).not.toMatch(/ii_audit_events|aie_audit_event|audit_events/i);
    expect(code).not.toMatch(/alter\s+table\s+(?!admin_users|ii_market_index_batches)\w+\s+(add|drop)\s+constraint/i);
  });
  it('enables RLS on the new table, with a capability-only read policy and no write policy', () => {
    expect(code).toMatch(/alter table ii_market_index_batches enable row level security/i);
    expect(code).toMatch(/create policy "capability read ii_market_index_batches"[\s\S]*for select using \(is_market_index_data_admin\(\)\)/i);
    expect(code).not.toMatch(/create policy[^;]*for (insert|update|delete|all)/i);
  });
  it('is append-only: update/delete and truncate are trigger-blocked', () => {
    expect(code).toMatch(/before update or delete on ii_market_index_batches/i);
    expect(code).toMatch(/before truncate on ii_market_index_batches/i);
  });
  it('both SECURITY DEFINER functions pin search_path and revoke from public/anon', () => {
    for (const fn of ['commit_market_index_upload', 'record_market_index_feed_closes']) {
      expect(code).toMatch(new RegExp(String.raw`create or replace function ${fn}[\s\S]*?security definer set search_path = public`, 'i'));
      expect(code).toMatch(new RegExp(String.raw`revoke all on function ${fn}\([^)]*\) from public, anon`, 'i'));
    }
    expect(code).toMatch(/revoke all on function record_market_index_feed_closes\([^)]*\) from public, anon, authenticated/i);
  });
  it('the upload RPC authorises inside the function with auth.uid() and the named predicate', () => {
    expect(code).toMatch(/v_uid uuid := auth\.uid\(\)/);
    expect(code).toMatch(/not public\.is_market_index_data_admin\(\)/);
  });
  it('is idempotent: every create is guarded', () => {
    expect(code).toMatch(/create table if not exists ii_market_index_batches/i);
    expect(code).toMatch(/add column if not exists can_upload_market_index_data/i);
    expect(code.match(/create (unique )?index /gi)!.length).toBe(code.match(/create (unique )?index if not exists/gi)!.length);
  });
  it('registers the daily job disabled and creates no pg_cron schedule', () => {
    expect(code).toMatch(/'market_index_daily_close', false/);
    expect(code).not.toMatch(/cron\.schedule/i);
  });
  it('does not touch any other table\'s RLS or grants', () => {
    expect(code).not.toMatch(/disable row level security/i);
    expect(code).not.toMatch(/drop policy(?! if exists "capability read ii_market_index_batches")/i);
  });
});
