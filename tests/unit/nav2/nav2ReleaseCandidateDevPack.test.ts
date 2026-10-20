// The DEV hand-over pack of the release candidate (docs/nav2/po_apply_dev_release_candidate): text-level proof. The SQL itself is executed on PGlite by
// scripts/nav2_production_deploy_order_proof.mjs (the migrations, checks, retention queries and rollbacks) and nav2ReleaseCandidateMigrations.test.ts.
//
// NAMED NEGATIVE CONTROLS
//   NC-P1  the migration copies are byte-identical to supabase/migrations (a one byte change is caught);
//   NC-P2  every hand written file passes the SQL editor lint (the hazard that broke a paste on DEV) and names no production project;
//   NC-P3  every file is named in the README, in the order the README gives;
//   NC-P4  each read-only query is ONE statement (the editor shows only the last result) and none of them writes.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hazards } from '../support/sqlEditorHazards';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PACK = path.join(ROOT, 'docs', 'nav2', 'po_apply_dev_release_candidate');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const files = fs.readdirSync(path.join(PACK, 'sql')).filter((f) => f.endsWith('.sql')).sort();
const text = (f: string) => fs.readFileSync(path.join(PACK, 'sql', f), 'utf8');
const readme = fs.readFileSync(path.join(PACK, 'README.md'), 'utf8');
const body = (f: string) => text(f).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();

describe('DEV pack', () => {
  it('NC-P1: the migration copies equal the migration files, byte for byte, and a one byte change is caught', () => {
    const a = fs.readFileSync(path.join(PACK, 'sql', '10_migration_0281.sql'));
    const b = fs.readFileSync(path.join(PACK, 'sql', '12_migration_0282.sql'));
    expect(a.equals(fs.readFileSync(path.join(MIG, '0281_nav2_report_idempotency_key.sql')))).toBe(true);
    expect(b.equals(fs.readFileSync(path.join(MIG, '0282_nav2_ambiguity_case_summary.sql')))).toBe(true);
    const changed = Buffer.from(a);
    changed[changed.length - 2] ^= 1;
    expect(changed.equals(fs.readFileSync(path.join(MIG, '0281_nav2_report_idempotency_key.sql')))).toBe(false);
    expect(fs.readFileSync(path.join(PACK, 'sql', '03_catalog_inventory.sql'), 'utf8')).toBe(fs.readFileSync(path.join(ROOT, 'docs', 'nav2', 'dev_inventory', 'nav2_catalog_inventory.sql'), 'utf8'));
  });

  it('NC-P2: every file passes the editor lint, has no uppercase project word, no production project and no e-mail address', () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const f of files) {
      const t = text(f);
      expect(hazards(t), f).toEqual([]);
      expect(t.includes('twwpnltizhtjxhamyoxt'), f).toBe(false);
      expect(/[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[a-z]{2,}/.test(t.replace(/@example\.test/g, '')), f).toBe(false);
    }
    expect(hazards("-- take the rows from table x\nselect 1;")).not.toEqual([]); // the lint bites
  });

  it('NC-P3: every file is named in the README, and the numbered order is the order of the table', () => {
    for (const f of files) expect(readme, f).toContain(f);
    const order = ['00_state_readonly', '01_weekly_refresh_off', '02_retention_function_identity', '02b_retention', '02d_retention', '03_catalog_inventory', '10_migration_0281', '12_migration_0282', '30_fixture_residue'].map((n) => readme.indexOf(n));
    for (const i of order) expect(i).toBeGreaterThan(0);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(readme).toContain('vqycarelcoijzwlpkpcz');
    expect(readme).toMatch(/must NOT contain `twwpnltizhtjxhamyoxt`/);
  });

  it('NC-P4: the read-only files are one select each and write nothing; the only writers are the weekly switch file, the two migrations and the rollbacks', () => {
    const writers = new Set(['01_weekly_refresh_off.sql', '10_migration_0281.sql', '12_migration_0282.sql', '90_rollback_0281.sql', '91_rollback_0282.sql']);
    for (const f of files.filter((x) => !writers.has(x))) {
      const b = body(f);
      expect(/^(select|with)\b/i.test(b), f).toBe(true);
      expect((b.match(/;/g) ?? []).length, f).toBe(1);
      expect(/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i.test(b), f).toBe(false);
    }
    const sw = body('01_weekly_refresh_off.sql');
    expect(sw).toMatch(/where job_key = 'nav2_risk_free_weekly_refresh'/);
    expect((sw.match(/job_key =/g) ?? []).length).toBe(1); // exactly one row can change
    expect(sw).toMatch(/enabled = false/);
  });
});
