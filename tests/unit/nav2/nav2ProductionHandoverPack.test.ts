// NAV2 production hand-over pack (docs/nav2/po_apply_production). Text-level proof; the SQL itself is executed, step by step with its
// checks, rollbacks and a second run, by scripts/nav2_production_deploy_order_proof.mjs (PGlite, about 5 minutes: too slow for this suite).
//
// NAMED NEGATIVE CONTROLS
//   NC-H1  the byte comparison bites on a one byte change;
//   NC-H2  the editor-safety lint bites on a deliberately bad snippet (into / from / join before a word in a comment or a string);
//   NC-H3  a README that did not mention a pack file would be caught (every pack file is named in the README);
//   NC-H4  the rollback copy of the retention function equals the 0219 text byte for byte once the dollar tag is normalised.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hazards } from '../support/sqlEditorHazards';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PACK = path.join(ROOT, 'docs', 'nav2', 'po_apply_production');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const readPack = (rel: string) => fs.readFileSync(path.join(PACK, rel));
const readPackText = (rel: string) => fs.readFileSync(path.join(PACK, rel), 'utf8');
const NAV2_MIGRATIONS = [
  '0260_nav2_risk_free_governed_dataset.sql',
  '0261_nav2_fund_analytics_reports_cache_and_pinning.sql',
  '0262_nav2_correction_events_and_monitoring.sql',
  '0263_nav2_risk_free_refresh_attempts.sql',
  '0269_nav2_reports_premium_only_read.sql',
  '0270_nav2_monitoring_snapshot_bounded_cost.sql',
  '0271_nav2_monitoring_snapshot_row_estimate.sql',
];

function listSql(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(PACK, dir), { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...listSql(`${dir}/${e.name}`));
    else if (e.name.endsWith('.sql')) out.push(`${dir}/${e.name}`);
  }
  return out;
}
const ALL_SQL = listSql('sql');
const HAND_WRITTEN = ALL_SQL.filter((f) => !f.startsWith('sql/migrations/') && !f.startsWith('sql/parts/'));

describe('production hand-over pack: the migrations', () => {
  it('the seven migration copies are byte-identical to supabase/migrations', () => {
    for (const n of NAV2_MIGRATIONS) expect(readPack(`sql/migrations/${n}`).equals(fs.readFileSync(path.join(MIG, n))), n).toBe(true);
  });

  it('NC-H1: the comparison bites on a one byte change', () => {
    const changed = Buffer.from(readPack(`sql/migrations/${NAV2_MIGRATIONS[5]}`));
    changed[changed.length - 2] = changed[changed.length - 2] ^ 1;
    expect(changed.equals(fs.readFileSync(path.join(MIG, NAV2_MIGRATIONS[5])))).toBe(false);
  });

  it('the five 0260 parts joined equal the 0260 file, and equal the DEV hand-over parts', () => {
    const parts = ['a', 'b', 'c', 'd', 'e'].map((l) => readPack(`sql/parts/0260${l}.sql`));
    expect(Buffer.concat(parts).equals(fs.readFileSync(path.join(MIG, NAV2_MIGRATIONS[0])))).toBe(true);
    ['a', 'b', 'c', 'd', 'e'].forEach((l, i) => expect(parts[i].equals(fs.readFileSync(path.join(ROOT, 'docs', 'nav2', 'po_apply_0260_0262', 'parts', `0260${l}.sql`)))).toBe(true));
  });

  it('the migration numbers are the NAV2 numbers and nothing else in the tree uses them', () => {
    const names = fs.readdirSync(MIG);
    for (const n of ['0260', '0261', '0262', '0263', '0269', '0270', '0271']) expect(names.filter((x) => x.startsWith(n + '_')), n).toHaveLength(1);
    expect(names.filter((x) => /^02(6[0-3]|69|7[01])_/.test(x)).sort()).toEqual(NAV2_MIGRATIONS);
  });
});

describe('production hand-over pack: the hand written SQL', () => {
  it('there is a file for every step the README names', () => {
    for (const f of [
      'sql/prechecks/P1_nav2_not_yet_applied.sql', 'sql/prechecks/P2_foundations_exist.sql', 'sql/prechecks/P3_retention_function_fingerprint.sql', 'sql/prechecks/P4_size.sql',
      'sql/checks/C0260a.sql', 'sql/checks/C0260e.sql', 'sql/checks/C0261.sql', 'sql/checks/C0262.sql', 'sql/checks/C0263.sql', 'sql/checks/C0269.sql', 'sql/checks/C0270_0271.sql', 'sql/checks/C_final_all.sql',
      'sql/grants/grant_upload.sql', 'sql/grants/grant_switch.sql', 'sql/switches/switch_on_fund_analytics.sql', 'sql/switches/switch_off_all_nav2.sql',
      'sql/rollback/rollback_0260.sql', 'sql/rollback/rollback_0261_restore_0219_function.sql', 'sql/rollback/rollback_0261_drop_tables.sql', 'sql/rollback/rollback_0262.sql', 'sql/rollback/rollback_0263.sql', 'sql/rollback/rollback_0269.sql',
    ]) expect(ALL_SQL, f).toContain(f);
    expect(HAND_WRITTEN.length).toBeGreaterThanOrEqual(35);
  });

  it('every hand written file passes the editor-safety lint (no into / from / join before a word in a comment or string, ASCII, no percent sign, no semicolon or quote in a comment)', () => {
    for (const f of HAND_WRITTEN) {
      expect(hazards(readPackText(f)), f).toEqual([]);
      expect(readPackText(f).includes('NAV2'), `${f} has uppercase NAV2`).toBe(false);
    }
  });

  it('NC-H2: the lint bites', () => {
    expect(hazards("-- take the rows from table x\nselect 1;")).not.toEqual([]);
    expect(hazards("select 'insert into table x';")).not.toEqual([]);
    expect(hazards("select 'a' as x -- it's\n;")).not.toEqual([]);
    expect(hazards('select 50% as x;')).not.toEqual([]);
  });

  it('every check file is one single select (the editor shows only the last result, so one query per file) that returns booleans', () => {
    for (const f of ALL_SQL.filter((x) => x.startsWith('sql/checks/') || /P[1-2]_/.test(x))) {
      const body = readPackText(f).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
      expect(body.startsWith('select'), f).toBe(true);
      expect((body.match(/;/g) ?? []).length, f).toBe(1);
      expect(body.endsWith(';'), f).toBe(true);
    }
  });

  it('the P3 fingerprint carries a real md5 (the placeholder is replaced) and the proof script recomputes it', () => {
    const p3 = readPackText('sql/prechecks/P3_retention_function_fingerprint.sql');
    expect(p3).not.toContain('__EXPECTED_0219_BODY_MD5__');
    expect(p3).toMatch(/md5\(p\.prosrc\) = '[0-9a-f]{32}'/);
  });

  it('NC-H4: the rollback copy of the retention function is the 0219 text (only the dollar tag differs)', () => {
    const src = fs.readFileSync(path.join(MIG, '0219_nav1_merger_lineage_and_coverage_gaps.sql'), 'utf8');
    const s = src.indexOf('create or replace function pc6_nav_row_is_candidate(');
    const open = src.indexOf('$$', s);
    const close = src.indexOf('$$', open + 2);
    const body0219 = src.slice(open + 2, close);
    const rb = readPackText('sql/rollback/rollback_0261_restore_0219_function.sql');
    const a = rb.indexOf('$fn$');
    const b = rb.indexOf('$fn$', a + 4);
    expect(rb.slice(a + 4, b)).toBe(body0219);
    expect(rb.slice(a + 4, b).replace(/\s+/g, '')).not.toContain('nav2_report_nav_dependencies');
    expect(rb).toMatch(/revoke execute on function pc6_nav_row_is_candidate\(uuid, date, date\) from public, anon, authenticated;/);
    expect(rb).toMatch(/grant execute on function pc6_nav_row_is_candidate\(uuid, date, date\) to service_role;/);
    // and 0261 itself is the 0219 body plus the pin, so a rollback to 0219 loses exactly the pin
    const m0261 = fs.readFileSync(path.join(MIG, NAV2_MIGRATIONS[1]), 'utf8');
    expect(m0261).toContain('nav2_report_nav_dependencies');
  });

  it('the grant files carry a visible placeholder and no real address; the switch files change one row each, except the emergency stop', () => {
    expect(readPackText('sql/grants/grant_upload.sql')).toContain('REPLACE-WITH-UPLOADER-EMAIL');
    expect(readPackText('sql/grants/grant_switch.sql')).toContain('REPLACE-WITH-SWITCHER-EMAIL');
    for (const f of ALL_SQL.filter((x) => x.startsWith('sql/grants/') || x.startsWith('sql/switches/'))) expect(readPackText(f), f).not.toMatch(/@(?!t\.test)[a-z0-9-]+\.[a-z]{2,}/i);
    for (const k of ['fund_analytics', 'trigger_planner', 'correction_worker', 'weekly_refresh']) {
      const t = readPackText(`sql/switches/switch_on_${k}.sql`);
      expect((t.match(/job_key = '/g) ?? []).length).toBe(1);
      expect(t).toMatch(/enabled = true/);
    }
    expect(readPackText('sql/switches/switch_off_all_nav2.sql')).toMatch(/enabled = false/);
  });
});

describe('production hand-over pack: the README', () => {
  const readme = readPackText('README.md');

  it('states the project check, both references, the order and every step', () => {
    expect(readme).toContain('twwpnltizhtjxhamyoxt');
    expect(readme).toContain('vqycarelcoijzwlpkpcz');
    const order = ['## 2. Step 1', '## 3. Step 2', '## 4. Step 3', '## 5. Step 4', '## 6. Step 5', '## 7. Step 6', '## 8. Step 7', '## 9. What the four switches mean', '## 10. Rollback table'].map((h) => readme.indexOf(h));
    for (const i of order) expect(i).toBeGreaterThan(0);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(readme).toMatch(/never write the words into, from or join followed by a word/);
    expect(readme).toMatch(/git push origin <RELEASE_SHA>:main/);
    expect(readme).toMatch(/Single operator limitation/);
    expect(readme).toMatch(/not dual control/);
  });

  it('NC-H3: every pack file is named in the README (a file the README forgets is caught)', () => {
    const missing = ALL_SQL.filter((f) => !f.startsWith('sql/migrations/') && !f.startsWith('sql/parts/')).filter((f) => !readme.includes(path.basename(f)) && !readme.includes(f));
    // the README names groups by folder for a few files that are only variants of a named one
    const allowedByFolder = new Set(['sql/grants/check_grants.sql', 'sql/grants/revoke_upload.sql', 'sql/switches/read_switches.sql']);
    expect(missing.filter((f) => !allowedByFolder.has(f)), JSON.stringify(missing)).toEqual([]);
    expect(['x_not_in_readme.sql'].filter((f) => !readme.includes(f))).toHaveLength(1);
    for (const n of NAV2_MIGRATIONS.slice(1)) expect(readme, n).toContain(n);
    for (const l of ['a', 'b', 'c', 'd', 'e']) expect(readme).toContain(`sql/parts/0260${l}.sql`);
  });

  it('says all four switches stay OFF at release and what that means, the 28 second limit, synchronous generation and what stays not activated', () => {
    expect(readme).toMatch(/All four NAV2 job switches stay OFF/);
    expect(readme).toMatch(/No new price fetching is started by NAV2/);
    expect(readme).toMatch(/28 seconds/);
    expect(readme).toMatch(/synchronous/);
    expect(readme).toMatch(/Beta, alpha, benchmark returns/);
    expect(readme).toMatch(/Weekly RBI refresh/);
    expect(readme).toMatch(/no per-user allowlist in the code/);
  });

  it('quotes the attestation text exactly as the screen shows it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'services', 'investment-intelligence', 'nav2', 'riskFreeUploadService.ts'), 'utf8');
    const m = /RISK_FREE_ATTESTATION_TEXT =\s*\n\s*"([^"]+)"/.exec(src);
    expect(m).not.toBeNull();
    expect(readme).toContain(m![1]);
  });

  it('the RBI first load files named in the README exist with the promised row counts', () => {
    const dir = path.join(ROOT, 'docs', 'nav2', 'risk_free_first_load');
    const rows = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '').length - 1;
    expect(rows('RBI_91DAY_TBILL_CUTOFF_YIELD_HISTORY.csv')).toBe(1060);
    expect(rows('RBI_91DAY_TBILL_GAP_ROWS.csv')).toBe(13);
    expect(rows('RBI_POLICY_REPO_RATE_HISTORY.csv')).toBe(61);
  });
});
