// WP-C migrations 0295-0299 must be safe to paste in the Supabase SQL editor (same lint as entity phase 1) and must be forward-only.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hazards } from './support/sqlEditorHazards';

const DIR = path.resolve(__dirname, '..', '..', 'supabase', 'migrations');
const WPC = fs.readdirSync(DIR).filter((f) => /^029[5-9]_/.test(f));
const PACK = path.resolve(__dirname, '..', '..', 'docs', 'reviews', 'po_apply_wp_c');
const PACK_SQL = fs.existsSync(PACK) ? fs.readdirSync(PACK).filter((f) => f.endsWith('.sql')) : [];

describe('WP-C migrations: editor safety and forward-only', () => {
  it('uses only the reserved numbers 0295-0299 and leaves 0289/0290 untouched in name', () => {
    expect(WPC.length).toBeGreaterThan(0);
    for (const f of WPC) expect(Number(f.slice(0, 4))).toBeGreaterThanOrEqual(295);
    expect(fs.existsSync(path.join(DIR, '0289_smsf_fund_liabilities.sql'))).toBe(true);
    expect(fs.existsSync(path.join(DIR, '0290_smsf_either_or_mode_rule_and_switch_rpcs.sql'))).toBe(true);
  });

  it.each(WPC)('%s has no editor hazard', (f) => {
    expect(hazards(fs.readFileSync(path.join(DIR, f), 'utf8'))).toEqual([]);
  });

  it.each(WPC)('%s drops nothing that exists in the ledger except its own earlier objects', (f) => {
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8').toLowerCase();
    expect(sql).not.toMatch(/drop\s+table\s+(?!if exists\s+_)/);
    expect(sql).not.toMatch(/\btruncate\b/);
    expect(sql).not.toMatch(/delete\s+from\s+(?!entity_)/);
  });
});

describe('the PO SQL pack (docs/reviews/po_apply_wp_c): editor safe, and read only where it says so', () => {
  it('has the read only checks, the backup and the verification', () => {
    expect(PACK_SQL).toEqual(expect.arrayContaining(['00_readonly_checks.sql', '01_backup.sql', '03_verify_after.sql']));
  });
  it.each(PACK_SQL)('%s has no editor hazard', (f) => {
    expect(hazards(fs.readFileSync(path.join(PACK, f), 'utf8'))).toEqual([]);
  });
  it.each(['00_readonly_checks.sql', '03_verify_after.sql'])('%s changes nothing', (f) => {
    const sql = fs.readFileSync(path.join(PACK, f), 'utf8').toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/(insert|update|delete|drop|alter|create|truncate|grant|revoke)/);
  });
  it('the backup only ever creates copies, it never changes or removes a source row', () => {
    const sql = fs.readFileSync(path.join(PACK, '01_backup.sql'), 'utf8').toLowerCase().replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/(update|delete|drop|truncate)/);
    expect(sql.match(/create table if not exists backup_wpc_/g)!.length).toBeGreaterThanOrEqual(9);
  });
});
