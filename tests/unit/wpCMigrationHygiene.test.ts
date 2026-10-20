// WP-C migrations 0295-0299 must be safe to paste in the Supabase SQL editor (same lint as entity phase 1) and must be forward-only.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hazards } from './support/sqlEditorHazards';

const DIR = path.resolve(__dirname, '..', '..', 'supabase', 'migrations');
const WPC = fs.readdirSync(DIR).filter((f) => /^029[5-9]_/.test(f));

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
