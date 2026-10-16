// NAV2 production partial state (found 17-10-2026): parts a, b and c of migration 0260 are on production, parts d, e and everything later are not.
// This suite proves, in an in-process Postgres (PGlite), the READ-ONLY reconciliation precheck P1z and the backup/listing files of step 1b.
// Evidence level: PGLITE-VERIFIED (not production evidence).
//
// NAMED NEGATIVE CONTROLS (each one breaks a pre-existing object in ONE named way, and P1z must name exactly that aspect)
//   NC-R1  a column type; NC-R2 a column default; NC-R3 a missing policy; NC-R4 a missing trigger; NC-R5 a changed function body; NC-R6 row level security off;
//   NC-R7  a write grant to authenticated; NC-R8 a changed seed value; NC-R9 a disabled seed row; NC-R10 a dropped constraint; NC-R11 a dropped index;
//   NC-R12 part d already applied (commit_risk_free_upload exists); NC-R13 a stored row in a table that must be empty is REPORTED (not compared);
//   NC-R14 the generated files equal what the generator produces now (a stale file would be caught).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { hazards } from '../support/sqlEditorHazards';
// @ts-expect-error plain .mjs tool without types
import { stubDb, applyPartsAC, expectedFingerprints, detailSql, summarySql, compareInventories, parseInventory } from '../../../scripts/nav2_reconcile_0260.mjs';

const PACK = path.resolve(__dirname, '..', '..', '..', 'docs', 'nav2', 'po_apply_production', 'sql');
const sql = (rel: string) => readFileSync(path.join(PACK, rel), 'utf8');
const FILES = [
  'prechecks/P1x_list_existing_nav2_objects.sql', 'prechecks/P1y_existing_nav2_row_counts.sql', 'prechecks/P1z_reconcile_partial_0260_detail.sql', 'prechecks/P1z_reconcile_partial_0260_summary.sql',
  'backup/B1b_backup_existing_nav2_tables.sql', 'backup/B2b_backup_existing_nav2_check.sql', 'backup/B3b_drop_existing_nav2_backups_after_release.sql',
];
type Row = Record<string, unknown>;
let db: PGlite;
beforeEach(async () => {
  db = await stubDb();
  await db.exec(`create table public.ii_reference_job_control (job_key text primary key, enabled boolean not null default false);`);
  await applyPartsAC(db);
}, 60_000);

const summary = async () => (await db.query<Row>(sql('prechecks/P1z_reconcile_partial_0260_summary.sql'))).rows[0];
const detailDiffs = async () => (await db.query<Row>(sql('prechecks/P1z_reconcile_partial_0260_detail.sql'))).rows.filter((r) => r.matches === false).map((r) => `${r.object}.${r.aspect}`);

describe('P1z reconciliation precheck', () => {
  it('every file passes the editor-safety lint', () => {
    for (const f of FILES) expect(hazards(sql(f)), f).toEqual([]);
  });

  it('positive control: on the exact state of parts a, b and c everything matches and the other five tables are empty', async () => {
    const s = await summary();
    expect(s).toMatchObject({ differing: 0, all_match: true, differing_aspects: null, series_rows: 2, data_rows_in_the_other_five_tables: 0, administrators_holding_a_permission: 0 });
    expect(Number(s.checks)).toBe(Number(s.matching));
    expect(Number(s.checks)).toBeGreaterThanOrEqual(45);
    expect(await detailDiffs()).toEqual([]);
  });

  it('the seed rows are exactly the two the Product Owner described', async () => {
    const r = (await db.query<Row>('select series_id, role, cadence, max_staleness_days, enabled, terms_review_status from public.ii_risk_free_series order by series_id')).rows;
    expect(r).toEqual([
      { series_id: 'RBI_91D_TBILL_CUTOFF_YIELD', role: 'primary', cadence: 'weekly_auction', max_staleness_days: 21, enabled: true, terms_review_status: 'po_accepted_2026-10-03' },
      { series_id: 'RBI_POLICY_REPO_RATE', role: 'secondary', cadence: 'policy_change', max_staleness_days: 90, enabled: true, terms_review_status: 'po_accepted_2026-10-03' },
    ]);
  });

  const BREAKS: Array<[string, string, string]> = [
    ['NC-R1 column type', 'alter table public.ii_risk_free_series alter column max_staleness_days type bigint', 'ii_risk_free_series.columns'],
    ['NC-R2 column default', 'alter table public.ii_risk_free_batches alter column attested set default true', 'ii_risk_free_batches.columns'],
    ['NC-R3 policy missing', 'drop policy read_ii_risk_free_observations on public.ii_risk_free_observations', 'ii_risk_free_observations.policies'],
    ['NC-R4 trigger missing', 'drop trigger trg_ii_risk_free_corrections_no_change on public.ii_risk_free_corrections', 'ii_risk_free_corrections.triggers'],
    ['NC-R5 function body', "create or replace function public.ii_risk_free_append_only() returns trigger language plpgsql as $f$ begin return new; end $f$", 'ii_risk_free_append_only.function'],
    ['NC-R6 row level security off', 'alter table public.ii_risk_free_review_items disable row level security', 'ii_risk_free_review_items.rls'],
    ['NC-R7 write grant', 'grant insert on public.ii_risk_free_observations to authenticated', 'ii_risk_free_observations.write_grants'],
    ['NC-R8 seed value', "update public.ii_risk_free_series set max_staleness_days = 22 where series_id = 'RBI_91D_TBILL_CUTOFF_YIELD'", 'ii_risk_free_series.seed_rows'],
    ['NC-R9 seed disabled', "update public.ii_risk_free_series set enabled = false where series_id = 'RBI_POLICY_REPO_RATE'", 'ii_risk_free_series.seed_rows'],
    ['NC-R10 constraint dropped', 'alter table public.ii_risk_free_batches drop constraint ii_risk_free_batches_csv_attested', 'ii_risk_free_batches.constraints'],
    ['NC-R11 index dropped', 'drop index public.idx_ii_risk_free_batches_recent', 'ii_risk_free_batches.indexes'],
    ['NC-R12 part d already there', 'create function public.commit_risk_free_upload() returns int language sql as $f$ select 1 $f$', 'commit_risk_free_upload.absent'],
  ];
  for (const [name, ddl, aspect] of BREAKS) {
    it(`${name}: P1z flips to differing and names ${aspect}`, async () => {
      await db.exec(ddl);
      const s = await summary();
      expect(s.all_match, name).toBe(false);
      expect(Number(s.differing), name).toBeGreaterThanOrEqual(1);
      expect(String(s.differing_aspects), name).toContain(aspect);
      expect(await detailDiffs(), name).toContain(aspect);
    });
  }

  it('NC-R13: stored data and held permissions are REPORTED (a different answer, not a silent pass)', async () => {
    await db.exec(`insert into public.admin_users (user_id, can_upload_risk_free_data) values ('00000000-0000-4000-8000-000000000001', true);`);
    await db.exec(`insert into public.ii_risk_free_batches (series_id, source_kind, file_name, file_sha256, attested, attested_at, uploader_user_id) values ('RBI_91D_TBILL_CUTOFF_YIELD', 'admin_csv', 'x.csv', 'abc', true, now(), '00000000-0000-4000-8000-000000000001')`).catch(() => undefined);
    const s = await summary();
    expect(Number(s.administrators_holding_a_permission)).toBe(1);
  });

  it('NC-R14: the checked-in files are exactly what the generator produces now', async () => {
    const fresh = await expectedFingerprints(db);
    expect(sql('prechecks/P1z_reconcile_partial_0260_detail.sql')).toBe(detailSql(fresh));
    expect(sql('prechecks/P1z_reconcile_partial_0260_summary.sql')).toBe(summarySql(fresh));
  });
});

describe('step 1b listing and backup files', () => {
  it('P1x lists exactly the 6 tables, 2 columns and 4 functions of the partial state and no switch row; P1y counts 2 / 0 / 0 / 0 / 0 / 0', async () => {
    const x = (await db.query<{ kind: string; name: string }>(sql('prechecks/P1x_list_existing_nav2_objects.sql'))).rows;
    expect(x.filter((r) => r.kind === 'table').map((r) => r.name).sort()).toEqual(['ii_risk_free_batches', 'ii_risk_free_corrections', 'ii_risk_free_observations', 'ii_risk_free_review_items', 'ii_risk_free_series', 'ii_risk_free_series_state_log']);
    expect(x.filter((r) => r.kind === 'column').map((r) => r.name).sort()).toEqual(['can_switch_risk_free_series', 'can_upload_risk_free_data']);
    expect(x.filter((r) => r.kind === 'function').map((r) => r.name).sort()).toEqual(['ii_risk_free_append_only', 'ii_risk_free_obs_guard', 'is_risk_free_data_admin', 'is_risk_free_series_switch_admin']);
    expect(x.filter((r) => r.kind === 'switch row')).toEqual([]);
    const y = Object.fromEntries((await db.query<{ table_name: string; row_count: number }>(sql('prechecks/P1y_existing_nav2_row_counts.sql'))).rows.map((r) => [r.table_name, Number(r.row_count)]));
    expect(y).toEqual({ ii_risk_free_series: 2, ii_risk_free_batches: 0, ii_risk_free_observations: 0, ii_risk_free_review_items: 0, ii_risk_free_corrections: 0, ii_risk_free_series_state_log: 0 });
  });

  it('B1b copies the six tables (rows included), B2b agrees, a second run keeps the FIRST copy, the copies are locked, B3b removes exactly the six', async () => {
    await db.exec(sql('backup/B1b_backup_existing_nav2_tables.sql'));
    const r1 = (await db.query<Row>(sql('backup/B2b_backup_existing_nav2_check.sql'))).rows[0];
    expect(r1).toMatchObject({ series_saved: 2, series_now: 2, batches_saved: 0, observations_saved: 0, review_items_saved: 0, corrections_saved: 0, state_log_saved: 0, copies_locked_to_service_role: true });
    const saved = (await db.query<{ series_id: string }>('select series_id from public.nav2_backup_20261016_rf_series order by 1')).rows.map((r) => r.series_id);
    expect(saved).toEqual(['RBI_91D_TBILL_CUTOFF_YIELD', 'RBI_POLICY_REPO_RATE']);
    await db.exec(`update public.ii_risk_free_series set max_staleness_days = 30 where series_id = 'RBI_POLICY_REPO_RATE'`);
    await db.exec(sql('backup/B1b_backup_existing_nav2_tables.sql'));
    const first = (await db.query<{ max_staleness_days: number }>(`select max_staleness_days from public.nav2_backup_20261016_rf_series where series_id = 'RBI_POLICY_REPO_RATE'`)).rows[0];
    expect(first.max_staleness_days).toBe(90);
    await db.exec('set role authenticated');
    await expect(db.query('select * from public.nav2_backup_20261016_rf_series')).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
    await db.exec(sql('backup/B3b_drop_existing_nav2_backups_after_release.sql'));
    const left = await db.query(`select 1 from pg_class where relname like 'nav2_backup_20261016_rf_%'`);
    expect(left.rows).toHaveLength(0);
    expect((await db.query('select count(*)::int c from public.ii_risk_free_series')).rows[0]).toEqual({ c: 2 });
  });
});

describe('compare mode: the production catalog inventory against the expected inventory restricted to 0260 parts a to c', () => {
  const expected = JSON.parse(readFileSync(path.join(PACK, '..', 'inventory', 'expected_inventory.json'), 'utf8'));
  const T = ['ii_risk_free_series', 'ii_risk_free_batches', 'ii_risk_free_observations', 'ii_risk_free_review_items', 'ii_risk_free_corrections', 'ii_risk_free_series_state_log'];
  const F = ['is_risk_free_data_admin', 'is_risk_free_series_switch_admin', 'ii_risk_free_append_only', 'ii_risk_free_obs_guard'];
  const abc = () => {
    const out = JSON.parse(JSON.stringify(expected));
    out.columns = expected.columns.filter((r: string[]) => T.includes(r[0]) || r[0] === 'admin_users');
    out.constraints = expected.constraints.filter((r: string[]) => T.includes(r[0]) && r[2] !== 'n'); // a Postgres below 18 has no not-null constraint entries
    for (const k of ['indexes', 'rls', 'policies', 'grants', 'triggers']) out[k] = expected[k].filter((r: string[]) => T.includes(r[0]));
    out.functions = expected.functions.filter((r: string[]) => F.includes(r[0]));
    out.job_keys = [];
    return JSON.parse(JSON.stringify(out)); // a deep copy, so a negative control never edits the expected inventory
  };
  it('positive control: the partial state of parts a, b and c is an exact match (as JSON and as a one cell CSV export)', () => {
    expect(compareInventories(abc(), expected).problems).toEqual([]);
    const csv = 'inventory\n"' + JSON.stringify(abc()).replace(/"/g, '""') + '"\n';
    expect(compareInventories(parseInventory(csv), expected).problems).toEqual([]);
  });
  it('negative controls: a changed column type, a changed seed value, a missing index, a missing function and a part d function are all named', () => {
    const bad = abc();
    bad.columns.find((r: unknown[]) => r[0] === 'ii_risk_free_series' && r[1] === 'max_staleness_days')[2] = 'bigint';
    bad.series_seed[0][3] = 22;
    bad.indexes = bad.indexes.filter((r: string[]) => r[1] !== 'idx_ii_risk_free_batches_recent');
    bad.functions = bad.functions.filter((r: string[]) => r[0] !== 'ii_risk_free_obs_guard');
    bad.functions.push(expected.functions.find((r: string[]) => r[0] === 'commit_risk_free_upload'));
    const text = compareInventories(bad, expected).problems.join('\n');
    expect(text).toMatch(/columns: DIFFERENT ii_risk_free_series.max_staleness_days/);
    expect(text).toMatch(/series_seed: DIFFERENT RBI_91D_TBILL_CUTOFF_YIELD/);
    expect(text).toMatch(/indexes: MISSING on production: .*idx_ii_risk_free_batches_recent/);
    expect(text).toMatch(/functions: MISSING on production: ii_risk_free_obs_guard/);
    expect(text).toMatch(/commit_risk_free_upload \(part d or e\) is ALREADY on production/);
  });
});
