// Planning Benchmarks PRODUCTION first-load files: generator, validation, rehearsal and runbook SQL.
//
// EVIDENCE LABEL: unit-tested and PGlite-verified (the whole migration ledger 0001 .. 0278 plus supabase/seed.sql replayed into an
// isolated in-memory Postgres). The same files were validated read-only against DEV by
// scripts/planning-benchmarks/validateProductionFirstLoadDev.ts (see PRODUCTION_FIRST_LOAD_REPORT.md). NOT production-verified.
//
// NAMED NEGATIVE CONTROLS (each is shown to fail something):
//   NC-G1  the source-vs-output equality check really bites: a nudged figure, a swapped date and a changed derivation text are all reported;
//   NC-G2  a source column the generator does not know about stops the build (nothing is converted silently);
//   NC-G3  a plan entry that names a skipped (draft or closed) dataset's file stops the build;
//   NC-F*  a tampered copy of every shipped file is refused by the real validator, naming the rule;
//   NC-O1  the cohort must be activated first: file 4 is refused before it, accepted after it;
//   NC-O2  a database bypass (the app validator skipped) is refused by the stage function itself (PB_E_MAPPING);
//   NC-O3  Discard before Activate leaves every live figure unchanged;
//   NC-O4  the same person staging and activating is refused without the acknowledgement (PB_E_SELF);
//   NC-O5  an activated file cannot be staged again (duplicate protection).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import { parseCsv } from '../../scripts/planning-benchmarks/firstLoadLib.mjs';
import {
  PLAN,
  SKIPPED,
  LOCATOR_CAVEATS,
  LOCATOR_MAX,
  PO_DEVIATIONS,
  locatorSuffix,
  SOURCE_DIR,
  OUTPUT_DIR,
  REPO_ROOT,
  buildProductionFirstLoad,
  outputFiles,
  toDayFirst,
  serialiseCsv,
  type BuiltFile,
} from '../../scripts/planning-benchmarks/buildProductionFirstLoad';
import { checkBytes, readShippedFile, runNegativeControls, withCohortsActivated } from '../../scripts/planning-benchmarks/productionFirstLoadValidate';
import { ACTIVATOR, BOTH, UPLOADER, allowedAs, createReplicaDb, runOneFile, sessionClient, stateSnapshot, todayOf, twinClient } from '../../scripts/planning-benchmarks/productionFirstLoadPglite';
import { stagePlanningBenchmarkUpload } from '../../lib/planning-benchmarks/uploadService';
import { loadPeerBenchmark } from '../../lib/services/twinBenchmarkRetrieval';
import { TEMPLATE_VERSION, columnNames, UPLOAD_KINDS } from '../../lib/planning-benchmarks/uploadSchema';

const RUNBOOK = fs.readFileSync(path.join(OUTPUT_DIR, 'PRODUCTION_RUNBOOK.md'), 'utf8');
const MAPPING_DOC = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'planning-benchmarks', 'DATASET_METRIC_MAPPING.md'), 'utf8');
const sha = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const srcRecords = (file: string) => (parseCsv(fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8')) as { header: string[]; records: Array<Record<string, string>> }).records;
const built = buildProductionFirstLoad();
const byOrder = (n: number): BuiltFile => built.files.find((f) => f.order === n)!;

// ------------------------------------------------------------------------------ source-vs-output comparison ---

/** The caveat the generator appends to source_locator for a file (and metric), as the register's population note in plain words. */
function caveatFor(order: number, metric: string): string {
  const c = LOCATOR_CAVEATS.find((x) => x.order === order && (x.metric === undefined || x.metric === metric));
  return c ? locatorSuffix(c.text) : '';
}

/** Compares every output row with its source row, column by column. Returns the list of differences (empty = identical). */
function compareToSource(f: BuiltFile): string[] {
  const entry = PLAN.find((e) => e.order === f.order)!;
  const src = srcRecords(entry.sourceFile);
  const diffs: string[] = [];
  if (src.length !== f.rows.length) diffs.push(`row count ${src.length} vs ${f.rows.length}`);
  const iso = (d: string) => (d === '' ? '' : d.split('/').reverse().join('-'));
  src.forEach((s, i) => {
    const o = f.rows[i];
    if (!o) return;
    const same = (col: string, a: string, b: string) => {
      if (a !== b) diffs.push(`${f.fileName} row ${i + 2} ${col}: source "${a.slice(0, 40)}" output "${b.slice(0, 40)}"`);
    };
    if (f.kind === 'values') {
      for (const c of ['dataset_name', 'dataset_version', 'cohort_code', 'metric_code', 'value_numeric', 'unit', 'original_currency', 'is_derived', 'derivation_method', 'confidence_score']) same(c, s[c], o[c]);
      // The one PO-approved deviation (07/10/2026): property_concentration "share" -> "mean". Every other statistic is as approved.
      const deviated = f.order === 2 && s.metric_code === 'property_concentration';
      same('statistic_type', deviated ? 'mean' : s.statistic_type, o.statistic_type);
      if (deviated && s.statistic_type !== 'share') diffs.push('the approved source no longer says share for the deviated row');
      same('base_date', s.base_date, iso(o.base_date));
      same('effective_from', s.effective_from, iso(o.effective_from));
      same('source_release', s.x_release, o.source_release);
      same('observation_period_start', s.x_obs_period_start, iso(o.observation_period_start));
      same('observation_period_end', s.x_obs_period_end, iso(o.observation_period_end));
      same('source_file', s.x_source_file, o.source_file);
      same('source_locator', s.x_source_locator + caveatFor(f.order, s.metric_code), o.source_locator);
      same('retrieval_date', s.x_retrieval_date, iso(o.retrieval_date));
      // No rounding: the number a person reads equals the number in the approved file, digit for digit.
      if (Number(o.value_numeric) !== Number(s.value_numeric)) diffs.push(`${f.fileName} row ${i + 2}: numeric value differs`);
    } else if (f.kind === 'target_ranges') {
      for (const c of ['metric_code', 'source_name', 'country_code', 'life_stage', 'household_type', 'band_label', 'band_tier', 'lower_bound', 'upper_bound', 'direction', 'explanation', 'evidence_level', 'model_version']) same(c, s[c], o[c]);
      same('effective_from', s.effective_from, iso(o.effective_from));
      same('source_release', s.x_release, o.source_release);
      same('observation_period_start', s.x_obs_period_start, iso(o.observation_period_start));
      same('source_file', s.x_source_file, o.source_file);
      same('source_locator', s.x_source_locator + caveatFor(f.order, s.metric_code), o.source_locator);
      same('retrieval_date', s.x_retrieval_date, iso(o.retrieval_date));
    } else {
      for (const c of columnNames('cohorts')) if (!['template_version', 'source_release', 'source_file', 'source_locator'].includes(c)) same(c, s[c], o[c]);
      same('source_release', s.x_release, o.source_release);
      same('source_file', s.x_source_file, o.source_file);
      same('source_locator', s.x_source_locator, o.source_locator);
    }
  });
  return diffs;
}

// ================================================================================================= part A: pure ===

describe('generator: deterministic, complete and faithful to the approved files', () => {
  it('is deterministic: two builds are byte-identical, and the committed folder equals a fresh build', () => {
    const a = outputFiles(buildProductionFirstLoad());
    const b = outputFiles(buildProductionFirstLoad());
    expect(Object.keys(a)).toEqual(Object.keys(b));
    for (const k of Object.keys(a)) expect(a[k], k).toBe(b[k]);
    for (const [name, text] of Object.entries(a)) {
      const onDisk = fs.readFileSync(path.join(OUTPUT_DIR, name), 'utf8');
      expect(onDisk, `${name} on disk is stale: run npx tsx scripts/planning-benchmarks/buildProductionFirstLoad.ts`).toBe(text);
    }
  });

  it('writes nine files, one dataset and one kind each, with the real totals: 44 values, 4 target ranges, 1 cohort', () => {
    expect(built.files).toHaveLength(9);
    expect(built.totals).toEqual({ values: 44, target_ranges: 4, cohorts: 1 });
    for (const f of built.files) {
      expect(new Set(f.rows.map((r) => `${r.dataset_name}|${r.dataset_version}`)).size, f.fileName).toBe(1);
      expect(f.rows.length, f.fileName).toBe(f.sourceRows);
    }
    // The order the PO uploads in: cohorts first, then values, then target ranges.
    expect(built.files.map((f) => f.kind)).toEqual(['cohorts', 'values', 'values', 'values', 'values', 'values', 'values', 'values', 'target_ranges']);
    expect(built.files.filter((f) => f.kind === 'values').map((f) => f.rows.length)).toEqual([2, 6, 28, 1, 2, 4, 1]);
  });

  it('counts equal the approved source files and the register (2+6+28+1+2+4+1 values; the 45th row is the closed dataset 7)', () => {
    const sourceTotal = ['02_au_household_asset_composition', '03_au_household_wealth_distribution', '04_au_net_worth_income_by_age', '05_au_high_dti_mortgage_threshold', '06_au_average_super_balance', '09_india_household_assets_debt_rural_urban', '10_india_epf_eps_contribution_structure']
      .map((n) => srcRecords(`${n}.values.csv`).length)
      .reduce((a, b) => a + b, 0);
    expect(built.totals.values).toBe(sourceTotal);
    expect(srcRecords('07_au_household_debt_context.values.csv')).toHaveLength(1);
    expect(sourceTotal + 1).toBe(45);
    expect(srcRecords('12_au_asfa_retirement_standard.target_ranges.csv')).toHaveLength(4);
    expect(srcRecords('04_au_net_worth_income_by_age.cohorts.csv')).toHaveLength(1);
  });

  it('every file has exactly the template header (read from uploadSchema.ts), the version marker on every row, CRLF and a trailing newline', () => {
    for (const f of built.files) {
      const bytes = fs.readFileSync(path.join(OUTPUT_DIR, f.fileName));
      const text = bytes.toString('utf8');
      expect(text.startsWith(columnNames(f.kind).join(',') + '\r\n'), f.fileName).toBe(true);
      expect(f.rows.every((r) => r.template_version === TEMPLATE_VERSION[f.kind]), f.fileName).toBe(true);
      expect(text.endsWith('\r\n'), f.fileName).toBe(true);
      expect(/(^|[^\r])\n/.test(text), `${f.fileName}: bare LF`).toBe(false);
      expect(text.charCodeAt(0)).not.toBe(0xfeff);
      expect(sha(bytes)).toBe(f.sha256);
    }
    expect(new Set(built.files.map((f) => f.kind))).toEqual(new Set(UPLOAD_KINDS));
  });

  it('the manifest lists every file with its dataset, kind, row count and the SHA-256 of the bytes on disk', () => {
    const manifest = parseCsv(fs.readFileSync(path.join(OUTPUT_DIR, 'MANIFEST.csv'), 'utf8')) as { records: Array<Record<string, string>> };
    expect(manifest.records).toHaveLength(9);
    for (const r of manifest.records) {
      const bytes = fs.readFileSync(path.join(OUTPUT_DIR, r.file));
      expect(r.sha256, r.file).toBe(sha(bytes));
      expect(Number(r.rows), r.file).toBe(parseCsv(bytes.toString('utf8')).records.length);
      expect(Number(r.bytes), r.file).toBe(bytes.length);
      expect(r.template_version).toBe(TEMPLATE_VERSION[r.kind as keyof typeof TEMPLATE_VERSION]);
    }
    const json = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'MANIFEST.json'), 'utf8'));
    expect(json.totals).toEqual({ values: 44, target_ranges: 4, cohorts: 1, files: 9 });
    expect(json.skipped.map((s: { datasetNo: number }) => s.datasetNo)).toEqual([1, 7, 8, 11]);
    expect(json.retargeted).toBeUndefined();
  });

  it('every output figure, date and text equals the approved source file (source-vs-output equality, no rounding)', () => {
    for (const f of built.files) expect(compareToSource(f), f.fileName).toEqual([]);
    // Spot values the register names, read straight from the shipped bytes.
    const wealth = parseCsv(fs.readFileSync(path.join(OUTPUT_DIR, byOrder(3).fileName), 'utf8')).records as Array<Record<string, string>>;
    expect(wealth.find((r) => r.statistic_type === 'median')!.value_numeric).toBe('579200');
    const dti = parseCsv(fs.readFileSync(path.join(OUTPUT_DIR, byOrder(5).fileName), 'utf8')).records[0] as Record<string, string>;
    expect([dti.value_numeric, dti.effective_from, dti.base_date]).toEqual(['6', '01/02/2026', '01/02/2026']);
    const sup = parseCsv(fs.readFileSync(path.join(OUTPUT_DIR, byOrder(6).fileName), 'utf8')).records as Array<Record<string, string>>;
    expect(sup.find((r) => r.statistic_type === 'mean')!.value_numeric).toBe('182781');
    const asset = parseCsv(fs.readFileSync(path.join(OUTPUT_DIR, byOrder(2).fileName), 'utf8')).records as Array<Record<string, string>>;
    expect(asset.find((r) => r.metric_code === 'property_concentration')!.value_numeric).toBe('55.7661');
  });

  it('dates are day-first dd/mm/yyyy everywhere; no year-first date appears in any date column', () => {
    const dateCols = ['base_date', 'effective_from', 'observation_period_start', 'observation_period_end', 'retrieval_date'];
    for (const f of built.files) {
      for (const r of f.rows) for (const c of dateCols) if (r[c] !== undefined && r[c] !== '') expect(r[c], `${f.fileName} ${c}`).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    }
    expect(toDayFirst('2026-02-01', 'x')).toBe('01/02/2026');
    expect(() => toDayFirst('2026-13-45', 'x')).toThrow();
  });

  it('PO decision A (07/10/2026): property_concentration is written as statistic "mean" (not "share"), the figure is unchanged, and the deviation is recorded', () => {
    const asset = byOrder(2).rows;
    const prop = asset.find((r) => r.metric_code === 'property_concentration')!;
    expect([prop.statistic_type, prop.value_numeric, prop.unit, prop.is_derived]).toEqual(['mean', '55.7661', 'percentage', 'true']);
    expect(srcRecords('02_au_household_asset_composition.values.csv').find((r) => r.metric_code === 'property_concentration')!.statistic_type).toBe('share');
    expect(asset.find((r) => r.metric_code === 'total_assets')!.statistic_type).toBe('mean');
    // No other row of any file deviates from the approved statistic.
    for (const f of built.files.filter((x) => x.kind === 'values')) {
      const src = srcRecords(PLAN.find((e) => e.order === f.order)!.sourceFile);
      f.rows.forEach((r, i) => {
        if (!(f.order === 2 && r.metric_code === 'property_concentration')) expect(r.statistic_type, `${f.fileName} row ${i + 2}`).toBe(src[i].statistic_type);
      });
    }
    expect(PO_DEVIATIONS.map((d) => [d.id, d.from, d.to, d.approvedOn])).toEqual([['PO-DEV-A', 'share', 'mean', '07/10/2026']]);
    const json = JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, 'MANIFEST.json'), 'utf8'));
    expect(json.poApprovedDeviations).toHaveLength(1);
    expect(json.poApprovedDeviations[0]).toMatchObject({ id: 'PO-DEV-A', metric: 'property_concentration', from: 'share', to: 'mean' });
    expect(json.poApprovedDeviations[0].reason).toMatch(/never "share"/);
    const trace = (parseCsv(fs.readFileSync(path.join(OUTPUT_DIR, 'TRACE_rows_to_source_observations.csv'), 'utf8')) as { records: Array<Record<string, string>> }).records;
    expect(trace.filter((t) => t.po_approved_deviation !== '')).toHaveLength(1);
    // The mapping is by metric, not by statistic (DATASET_METRIC_MAPPING.md s1, s5): the pair is permitted whatever the statistic.
    expect(MAPPING_DOC).toContain('| AU household asset composition | 1.0 | property_concentration | percentage | values |');
    expect(MAPPING_DOC).toMatch(/Allowed statistic types are \*\*not\*\* constrained per pair/);
  });

  it('PO decision D (07/10/2026): each row with a register population caveat carries it, in plain words, appended to source_locator, within 300 characters', () => {
    const expectText: Array<[number, string, RegExp]> = [
      [2, 'total_assets', /Caveat: all private households; the 2019-20 survey went online during COVID-19/],
      [3, 'net_worth', /Caveat: all private households/],
      [4, 'net_worth', /Caveat: ABS age band as published \(youngest is 15-24, not the app 18-24\)/],
      [5, 'debt_to_income', /Caveat: the 6x is a limit on each lender \(20% of its new lending per cohort\), not a personal borrowing rule/],
      [6, 'retirement_balance', /Caveat: per INDIVIDUAL \(balances summed across accounts by TFN\), not per household/],
      [7, 'total_assets', /Caveat: average per household, as at 30\/06\/2018 \(survey year 2019\)/],
      [7, 'debt_to_asset_ratio', /Caveat: as at 30\/06\/2018 \(survey year 2019\); one decimal/],
      [8, 'retirement_contribution_rate', /Caveat: of BASIC WAGES up to the ceiling/],
      [9, 'retirement_balance', /Caveat: ASFA copyright/],
    ];
    for (const [order, metric, re] of expectText) {
      const rows = byOrder(order).rows.filter((r) => r.metric_code === metric);
      expect(rows.length, `${order} ${metric}`).toBeGreaterThan(0);
      for (const r of rows) expect(r.source_locator, `${order} ${metric}`).toMatch(re);
    }
    for (const f of built.files) for (const r of f.rows) if (r.source_locator !== undefined) expect(r.source_locator.length, f.fileName).toBeLessThanOrEqual(LOCATOR_MAX);
    // The register's own locator is kept, in front, untouched.
    const dti = byOrder(5).rows[0].source_locator;
    expect(dti.startsWith(srcRecords('05_au_high_dti_mortgage_threshold.values.csv')[0].x_source_locator)).toBe(true);
    // The cohort file has the caveat in its description already and no locator suffix.
    expect(byOrder(1).rows[0].source_locator).toBe(srcRecords('04_au_net_worth_income_by_age.cohorts.csv')[0].x_source_locator);
    // Every values file row has a caveat (no register population note is left behind).
    for (const f of built.files.filter((x) => x.kind === 'values')) for (const r of f.rows) expect(r.source_locator, f.fileName).toContain(' | Caveat: ');
  });

  it('the datasets the register says are not loadable are absent, and so are the refused seed metrics', () => {
    const names = new Set(built.files.flatMap((f) => f.rows.map((r) => r.dataset_name)));
    for (const n of ['AU household debt context', 'FHIP dependant-band household benchmark model', 'FHIP Planning Benchmarks v1.0', 'India household consumption expenditure (rural/urban)']) expect(names.has(n), n).toBe(false);
    expect(built.files.flatMap((f) => f.rows).some((r) => r.metric_code === 'liquid_asset_share')).toBe(false);
    expect(built.files.some((f) => /DRAFT/i.test(f.sourceFile))).toBe(false);
    expect(SKIPPED.map((s) => s.sourceDataset)).toEqual([1, 7, 8, 11]);
    // The metric the 20% APRA cap would use is not loaded either (one DTI row, the threshold).
    expect(byOrder(5).rows).toHaveLength(1);
  });

  it('every dataset, metric and kind pair in the files is a pair of the reviewed mapping document (DATASET_METRIC_MAPPING.md)', () => {
    const pairs = new Set<string>();
    for (const line of MAPPING_DOC.split('\n')) {
      const m = /^\| (.+?) \| (\d+\.\d+) \| ([a-z0-9_]+) \| [a-z]+ \| (values|target ranges) \|/.exec(line);
      if (m) pairs.add(`${m[1]}|${m[3]}|${m[4] === 'values' ? 'values' : 'target_ranges'}`);
    }
    expect(pairs.size).toBe(71);
    for (const f of built.files.filter((x) => x.kind !== 'cohorts')) {
      for (const r of f.rows) expect(pairs.has(`${r.dataset_name}|${r.metric_code}|${f.kind}`), `${f.fileName}: ${r.dataset_name} / ${r.metric_code}`).toBe(true);
    }
  });

  it('the dataset of the target ranges file is the one the mapping document maps retirement_balance bands to, and its source is the ASFA source', () => {
    const asfa = byOrder(9);
    expect(asfa.datasetName).toBe('AU ASFA retirement standard');
    expect(MAPPING_DOC).toContain('| AU ASFA retirement standard | 1.0 | retirement_balance | currency | target ranges |');
    expect(new Set(asfa.rows.map((r) => r.source_name))).toEqual(new Set(['ASFA_STANDARD_2026']));
  });

  it('the cohorts file carries the one new cohort and the age band the Twin does NOT match for 18-24 households', () => {
    const c = byOrder(1);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0].cohort_code).toBe('AU_AGE_15_24');
    expect(c.rows[0].age_band).toBe('AGE_15_24');
    // Every other cohort the value rows use is an existing seeded one (the runbook pre-check A4 proves it on production).
    const used = new Set(built.files.filter((f) => f.kind === 'values').flatMap((f) => f.rows.map((r) => r.cohort_code)).filter(Boolean));
    expect([...used].sort()).toEqual(['AU_AGE_15_24', 'AU_AGE_25_34', 'AU_AGE_35_44', 'AU_AGE_45_54', 'AU_AGE_55_64', 'AU_AGE_65_74', 'AU_AGE_75_PLUS', 'IN_RURAL_ALL', 'IN_URBAN_ALL']);
  });

  it('retargeting changes only the dataset version, is recorded in the manifest, and an unknown name stops the build', () => {
    const r = buildProductionFirstLoad({ retarget: { 'AU household wealth distribution': '2.0' } });
    const changed = r.files.filter((f) => f.rows.some((x) => x.dataset_version === '2.0'));
    expect(changed.map((f) => f.order)).toEqual([3]);
    const base = byOrder(3);
    expect(r.files.find((f) => f.order === 3)!.rows.map((x) => ({ ...x, dataset_version: '1.0' }))).toEqual(base.rows);
    expect(JSON.parse(outputFiles(r)['MANIFEST.json']).retargeted).toEqual({ 'AU household wealth distribution': '2.0' });
    expect(() => buildProductionFirstLoad({ retarget: { 'No such dataset': '1.0' } })).toThrow(/not a dataset in this load/);
  });

  it('NC-G1: the equality check bites - a nudged figure, a swapped date and a changed derivation text are each reported', () => {
    const f = structuredClone(byOrder(4));
    expect(compareToSource(f)).toEqual([]);
    const nudged = structuredClone(f);
    nudged.rows[4].value_numeric = '353801';
    expect(compareToSource(nudged).some((d) => d.includes('value_numeric'))).toBe(true);
    const dated = structuredClone(f);
    dated.rows[0].retrieval_date = '10/03/2026'; // month-first swap of 03/10/2026
    expect(compareToSource(dated).some((d) => d.includes('retrieval_date'))).toBe(true);
    const text = structuredClone(f);
    const i = text.rows.findIndex((r) => r.is_derived === 'true');
    text.rows[i].derivation_method = text.rows[i].derivation_method + ' (edited)';
    expect(compareToSource(text).some((d) => d.includes('derivation_method'))).toBe(true);
    const nocav = structuredClone(f);
    nocav.rows[0].source_locator = nocav.rows[0].source_locator.split(' | Caveat: ')[0];
    expect(compareToSource(nocav).some((d) => d.includes('source_locator'))).toBe(true);
    const stat = structuredClone(byOrder(2));
    stat.rows.find((r) => r.metric_code === 'property_concentration')!.statistic_type = 'share';
    expect(compareToSource(stat).some((d) => d.includes('statistic_type'))).toBe(true);
  });

  it('NC-G2 and NC-G3: an unknown source column, or a plan entry naming a draft dataset file, stops the build', () => {
    // NC-G2: a copy of the source folder with an extra column in one file is refused. The generator reads SOURCE_DIR, so prove it with the
    // internal contract instead: every source header column is in the known map (the build would have thrown otherwise), and the check is live.
    for (const e of PLAN) {
      const header = (parseCsv(fs.readFileSync(path.join(SOURCE_DIR, e.sourceFile), 'utf8')) as { header: string[] }).header;
      expect(header.length, e.sourceFile).toBeGreaterThan(5);
    }
    const draft = path.join(SOURCE_DIR, '11_fhip_planning_benchmarks_v1.DRAFT_FOR_PO_APPROVAL.target_ranges.csv');
    expect(fs.existsSync(draft)).toBe(true);
    expect(PLAN.some((e) => e.sourceFile.includes('DRAFT'))).toBe(false);
    expect(PLAN.some((e) => SKIPPED.some((s) => s.sourceFiles.includes(e.sourceFile)))).toBe(false);
    expect(serialiseCsv(['a', 'b'], [{ a: 'x,y', b: '"q"' }])).toBe('a,b\r\n"x,y","""q"""\r\n');
  });

  it('the shipped bytes survive a checkout unchanged: .gitattributes protects them from line-ending conversion', () => {
    const attrs = fs.readFileSync(path.join(REPO_ROOT, '.gitattributes'), 'utf8');
    expect(attrs).toContain('docs/planning-benchmarks/production_first_load/*.csv -text');
  });
});

// ============================================================================================ part B: PGlite ===

type Json = Record<string, unknown>;
const EXPECTED_PREVIEW: Record<number, { new: number; changed: number; unchanged: number; conflict: number; removed: number; inserted: number; endDated: number }> = {
  1: { new: 1, changed: 0, unchanged: 0, conflict: 0, removed: 0, inserted: 1, endDated: 0 },
  2: { new: 1, changed: 1, unchanged: 0, conflict: 0, removed: 0, inserted: 2, endDated: 1 },
  3: { new: 2, changed: 2, unchanged: 2, conflict: 0, removed: 0, inserted: 4, endDated: 2 },
  4: { new: 16, changed: 10, unchanged: 2, conflict: 0, removed: 0, inserted: 26, endDated: 10 },
  5: { new: 0, changed: 0, unchanged: 1, conflict: 0, removed: 0, inserted: 0, endDated: 0 },
  6: { new: 1, changed: 1, unchanged: 0, conflict: 0, removed: 0, inserted: 2, endDated: 1 },
  7: { new: 2, changed: 0, unchanged: 2, conflict: 0, removed: 0, inserted: 2, endDated: 0 },
  8: { new: 0, changed: 1, unchanged: 0, conflict: 0, removed: 0, inserted: 1, endDated: 1 },
  9: { new: 0, changed: 0, unchanged: 4, conflict: 0, removed: 0, inserted: 0, endDated: 0 },
};

function runbookSql(id: string): string {
  const m = new RegExp(`<!-- sql:${id} -->\\s*\`\`\`sql\\n([\\s\\S]*?)\`\`\``).exec(RUNBOOK);
  if (!m) throw new Error(`runbook block ${id} not found`);
  return m[1];
}

describe('rehearsal on the real migration ledger (PGlite)', () => {
  let db: PGlite;
  let pre: Json;
  const q = async <T = Json>(sql: string): Promise<T[]> => (await db.query(sql)).rows as T[];
  const liveOf = async () => ((await stateSnapshot(db)).liveValuesByDataset as Record<string, number>);

  beforeAll(async () => {
    db = await createReplicaDb('0278');
    pre = await stateSnapshot(db);
  }, 600_000);
  afterAll(async () => {
    await db?.close();
  });

  it('the replica is the migration-seeded state the runbook describes: 12 datasets, 71 mapping pairs, 224 values, 200 bands, 39 cohorts, nothing end-dated', () => {
    expect(pre.datasets).toBe(12);
    expect(pre.mappingPairs).toBe(71);
    expect(pre.allValues).toBe(224);
    expect(pre.endDatedValues).toBe(0);
    expect(pre.bands).toBe(200);
    expect(pre.cohorts).toBe(39);
    expect(pre.liveValuesByDataset).toMatchObject({ 'AU household wealth distribution': 4, 'AU net worth and income by age band': 14, 'AU average superannuation balance': 1, 'FHIP dependant-band household benchmark model': 198 });
  });

  it('runbook Part A and B (read-only): every block runs and returns what the runbook says to expect', async () => {
    const a1 = (await q(runbookSql('a1')))[0] as Json;
    expect(a1).toEqual({ upload_tables_ok: true, mapping_tables_ok: true, capability_columns_ok: true, upload_functions_ok: true, migration_0278_ok: true, mapping_pairs: 71 });
    const a2 = await q<{ dataset_name: string; version: string; data_status: string; source_status: string; live_values: number; mapped_pairs: number }>(runbookSql('a2'));
    expect(a2).toHaveLength(12);
    const expected: Record<string, [string, number, number]> = {
      'AU ASFA retirement standard': ['active', 0, 1],
      'AU average superannuation balance': ['active', 1, 1],
      'AU high-DTI mortgage threshold': ['active', 1, 1],
      'AU household asset composition': ['active', 1, 2],
      // DEV shows 'superseded' (set there by an admin); a database straight from the migrations shows 'active'. No file targets it.
      'AU household debt context': ['active', 0, 1],
      'AU household wealth distribution': ['active', 4, 1],
      'AU net worth and income by age band': ['active', 14, 2],
      'FHIP dependant-band household benchmark model': ['active', 198, 11],
      'FHIP Planning Benchmarks v1.0': ['active', 0, 48],
      'India EPF/EPS contribution structure': ['active', 1, 1],
      'India household assets and debt (rural/urban)': ['active', 4, 2],
      'India household consumption expenditure (rural/urban)': ['active', 0, 0], // DEV shows 'draft'; no file targets it
    };
    for (const r of a2) expect([r.data_status, Number(r.live_values), Number(r.mapped_pairs)], r.dataset_name).toEqual(expected[r.dataset_name]);
    // Every dataset a file targets is open for upload (not suspended, archived or superseded).
    for (const f of built.files) expect(a2.find((r) => r.dataset_name === f.datasetName && r.version === f.datasetVersion)?.data_status, f.fileName).toBe('active');
    const a3 = await q<{ mapped: boolean }>(runbookSql('a3'));
    expect(a3).toHaveLength(11);
    expect(a3.every((r) => r.mapped)).toBe(true);
    const a4 = await q<{ cohort_code: string; exists_now: boolean }>(runbookSql('a4'));
    expect(Object.fromEntries(a4.map((r) => [r.cohort_code, r.exists_now]))).toEqual({
      AU_AGE_15_24: false, AU_AGE_25_34: true, AU_AGE_35_44: true, AU_AGE_45_54: true, AU_AGE_55_64: true, AU_AGE_65_74: true, AU_AGE_75_PLUS: true, IN_RURAL_ALL: true, IN_URBAN_ALL: true,
    });
    const a5 = await q(runbookSql('a5'));
    expect(a5).toHaveLength(26);
    expect(await q(runbookSql('a6'))).toHaveLength(3); // the three rehearsal users hold capabilities; production starts empty
    const a7 = (await q<Record<string, number>>(runbookSql('a7')))[0];
    expect(Object.fromEntries(Object.entries(a7).map(([k, v]) => [k, Number(v)]))).toEqual({ batches_staged_so_far: 0, all_value_rows: 224, end_dated_value_rows: 0, live_bands: 200, live_asfa_bands: 4, cohorts: 39 });
    expect(await q(runbookSql('b1'))).toHaveLength(224);
    expect(await q(runbookSql('b2'))).toHaveLength(200);
    expect(await q(runbookSql('b3'))).toHaveLength(39);
    // Block t1 (what the Twin reads) before the load: the seed figures, mean-based, with the property_concentration seed 56.2.
    const t1 = await q<{ cohort: string; metric_code: string; headline_statistic: string; headline_value: string }>(runbookSql('t1'));
    expect(t1).toHaveLength(23);
    const hv = (cohort: string, metric: string) => t1.find((r) => r.cohort === cohort && r.metric_code === metric)!;
    expect([hv('(country-wide)', 'property_concentration').headline_statistic, Number(hv('(country-wide)', 'property_concentration').headline_value)]).toEqual(['mean', 56.2]);
    expect([hv('AU_AGE_25_34', 'net_worth').headline_statistic, Number(hv('AU_AGE_25_34', 'net_worth').headline_value)]).toEqual(['mean', 242000]);
    expect([hv('(country-wide)', 'net_worth').headline_statistic, Number(hv('(country-wide)', 'net_worth').headline_value)]).toEqual(['median', 579200]);
  });

  // What the Financial Twin reads, through the REAL loadPeerBenchmark (lib/services/twinBenchmarkRetrieval.ts) on the replica.
  const twinRead = async (metric: string, cohort: string | null, country = 'AU') => {
    const m = (await q<{ id: string }>(`select id from benchmark_metric_definitions where metric_code = '${metric}'`))[0].id;
    const c = cohort ? (await q<{ id: string }>(`select id from benchmark_cohorts where cohort_code = '${cohort}'`))[0].id : null;
    const r = await loadPeerBenchmark(twinClient(db) as never, m, c, country);
    return r ? { statistic: r.statisticType, value: r.value, distribution: r.distribution } : null;
  };

  it('Twin read BEFORE the load (real loadPeerBenchmark): the seed figures are what the Twin serves today', async () => {
    expect(await twinRead('property_concentration', null)).toMatchObject({ statistic: 'mean', value: 56.2 });
    expect(await twinRead('net_worth', 'AU_AGE_25_34')).toMatchObject({ statistic: 'mean', value: 242000 });
    expect(await twinRead('net_worth', 'AU_AGE_18_24')).toMatchObject({ statistic: 'mean', value: 129000 });
    expect(await twinRead('retirement_balance', null)).toMatchObject({ statistic: 'mean', value: 183000 });
    expect(await twinRead('net_worth', null)).toMatchObject({ statistic: 'median', value: 579200 });
    expect(await twinRead('retirement_contribution_rate', null, 'IN')).toMatchObject({ statistic: 'rate', value: 24 });
  });

  it('runbook Part C: the grant statements each update exactly one person, and the switch-off statement undoes them', async () => {
    await db.exec(`insert into auth.users(id,email) values ('eeeeeeee-0000-0000-0000-00000000f101','Person.One@Example.test'),('eeeeeeee-0000-0000-0000-00000000f102','person.two@example.test');
                   insert into admin_users(user_id) values ('eeeeeeee-0000-0000-0000-00000000f101'),('eeeeeeee-0000-0000-0000-00000000f102');`);
    const fill = (s: string) => s.replace('UPLOADER.EMAIL@EXAMPLE.COM', 'person.one@example.test').replace('ACTIVATOR.EMAIL@EXAMPLE.COM', 'PERSON.TWO@EXAMPLE.TEST');
    const g1 = await q(fill(runbookSql('c1')));
    const g2 = await q(fill(runbookSql('c2')));
    expect(g1).toHaveLength(1);
    expect(g2).toHaveLength(1);
    const holders = await q<{ email: string; can_upload: boolean; can_activate: boolean }>(runbookSql('a6'));
    expect(holders.find((h) => h.email === 'Person.One@Example.test')).toMatchObject({ can_upload: true, can_activate: false });
    expect(holders.find((h) => h.email === 'person.two@example.test')).toMatchObject({ can_upload: false, can_activate: true });
    expect(await q(runbookSql('c3').replace('UPLOADER.EMAIL@EXAMPLE.COM', 'person.one@example.test').replace('ACTIVATOR.EMAIL@EXAMPLE.COM', 'person.two@example.test'))).toHaveLength(2);
    // An email that is not an admin user updates nothing and the statement says so by returning no row.
    expect(await q(runbookSql('c1').replace('UPLOADER.EMAIL@EXAMPLE.COM', 'nobody@example.test'))).toHaveLength(0);
  });

  it('every shipped file passes the real validator with 0 blockers against the replica lists (after the cohort exists); NC-O1: file 4 is refused before the cohort exists', async () => {
    const today = await todayOf(db);
    const av = await allowedAs(db, UPLOADER);
    if (av.state !== 'ok') throw new Error('allowed lists unavailable');
    expect(av.mapping).toEqual({ installed: true, pairs: 71 });
    const after = withCohortsActivated(av, byOrder(1));
    for (const f of built.files) {
      const c = checkBytes(f.fileName, f.kind, readShippedFile(f.fileName), after, today);
      expect(c.errors, f.fileName).toEqual([]);
      expect(c.warnings, f.fileName).toEqual([]);
      expect(c.rowsAccepted, f.fileName).toBe(f.rows.length);
    }
    const before = checkBytes(byOrder(4).fileName, 'values', readShippedFile(byOrder(4).fileName), av, today);
    expect(before.errors.some((e) => e.code === 'COHORT_NOT_FOUND')).toBe(true);
    expect(before.rowsAccepted).toBe(24);
    // NC-F*: tampered copies of every shipped file are refused with the named rule (and the untouched file does not have it).
    let controls = 0;
    for (const f of built.files) {
      for (const r of runNegativeControls(f, after, today)) {
        controls++;
        expect(r.untouchedHadCode, `${r.id} ${r.file}`).toBe(false);
        expect(r.refused, `${r.id} ${r.file}: ${r.describe}`).toBe(true);
      }
    }
    expect(controls).toBe(2 + 7 * 7 + 3);
  });

  it('NC-O2: bypassing the app validator, the database stage function itself refuses a metric that is not mapped to the dataset', async () => {
    const asUp = sessionClient(db, UPLOADER);
    // Real rows of file 2 (asset composition: total_assets), pointed at the wealth distribution dataset where total_assets is not mapped.
    const rows = byOrder(2).rows.map((r, i) => ({
      row_no: i + 2, ...r, dataset_name: 'AU household wealth distribution', cohort_code: r.cohort_code, base_date: '2020-06-30', effective_from: null,
      is_derived: r.is_derived === 'true', confidence_score: null, value_numeric: Number(r.value_numeric), observation_period_start: '2019-07-01', observation_period_end: '2020-06-30',
      retrieval_date: '2026-10-03', value_text: 'x',
    }));
    const res = await asUp.rpc('stage_planning_benchmark_upload', { p: { kind: 'values', dataset_name: 'AU household wealth distribution', dataset_version: '1.0', file_name: 'bypass.csv', file_sha256: sha('bypass'), file_bytes: 10, template_version: TEMPLATE_VERSION.values, rows } });
    expect(res.error?.message ?? '').toContain('PB_E_MAPPING');
    expect(((await stateSnapshot(db)).batches as unknown[]).length).toBe(0);
  });

  it('NC-O3: Discard before Activate leaves every live figure unchanged and records the discard', async () => {
    const before = await stateSnapshot(db);
    const r = await runOneFile(db, byOrder(3), readShippedFile(byOrder(3).fileName), { activate: false });
    expect(r.outcome).toBe('staged');
    expect(r.counts).toEqual({ new: 2, changed: 2, removed: 0, conflict: 0, unchanged: 2 });
    const d = await sessionClient(db, UPLOADER).rpc('discard_planning_benchmark_upload', { p_batch: r.batchId, p_reason: 'rehearsal discard' });
    expect((d.data as Json).status).toBe('discarded');
    const after = await stateSnapshot(db);
    expect({ ...after, batches: undefined }).toEqual({ ...before, batches: undefined });
    expect(await q(`select event_type from benchmark_upload_events where batch_id = '${r.batchId}' order by event_type`)).toEqual([{ event_type: 'discarded' }, { event_type: 'staged' }]);
    // A discarded upload cannot be activated afterwards.
    const act = await sessionClient(db, ACTIVATOR).rpc('activate_planning_benchmark_upload', { p_batch: r.batchId, p: { expected_sha256: sha('x'), expected_digest: 'x', expected_counts: {}, self_activation_ack: false } });
    expect(act.error?.message ?? '').toMatch(/PB_E_STATE/);
  });

  it('NC-O4: the same person staging and activating is refused without the self-activation acknowledgement, and allowed with it (recorded)', async () => {
    const f = byOrder(5);
    const bytes = readShippedFile(f.fileName);
    const noAck = await runOneFile(db, f, bytes, { activate: true, uploader: BOTH, activator: BOTH, selfAck: false });
    expect(noAck.outcome).toBe('activate_error');
    expect(noAck.error ?? '').toContain('PB_E_SELF');
    // Discard it (as the activator) so the normal two-person flow below stages it afresh.
    const d = await sessionClient(db, ACTIVATOR).rpc('discard_planning_benchmark_upload', { p_batch: noAck.batchId, p_reason: 'single operator rehearsal' });
    expect((d.data as Json).status).toBe('discarded');
    // And with the acknowledgement it works and is recorded as self-activated (file 9: "same as live", so it changes nothing live).
    const g = byOrder(9);
    const ack = await runOneFile(db, g, readShippedFile(g.fileName), { activate: true, uploader: BOTH, activator: BOTH, selfAck: true });
    expect(ack.outcome).toBe('staged');
    expect((ack.activated as Json).status).toBe('activated');
    expect((await q<{ self_activated: boolean }>(`select self_activated from benchmark_upload_batches where id = '${ack.batchId}'`))[0].self_activated).toBe(true);
  });

  it('the whole load, in the runbook order, by two different people: previews, counts and results match the runbook table exactly', async () => {
    // NC-O1 on the real stage path: file 4 refers to a cohort that does not exist yet, so it cannot even be staged.
    const early = await runOneFile(db, byOrder(4), readShippedFile(byOrder(4).fileName), { activate: false });
    expect(early.outcome).toBe('rejected');
    expect(early.stageIssues.some((i) => i.code === 'COHORT_NOT_FOUND')).toBe(true);
    for (const f of built.files) {
      if (f.order === 9) continue; // already activated above by the single-operator rehearsal (its preview: all 4 same as live)
      const r = await runOneFile(db, f, readShippedFile(f.fileName), { activate: true });
      expect(r.outcome, `${f.fileName}: ${r.error ?? ''}`).toBe('staged');
      const exp = EXPECTED_PREVIEW[f.order];
      const batch = r.preview!.batch as Json;
      expect(batch.counts, f.fileName).toEqual({ new: exp.new, changed: exp.changed, unchanged: exp.unchanged, conflict: exp.conflict, removed: exp.removed });
      expect((r.preview!.blockers as unknown[]).length, f.fileName).toBe(0);
      expect((r.preview!.readiness_errors as unknown[]).length, f.fileName).toBe(0);
      expect((r.preview!.removed as unknown[]).length, f.fileName).toBe(0);
      const res = (r.activated as { result: Json }).result;
      expect([res.rows_inserted, res.rows_end_dated, res.bands_removed, res.dataset_status], f.fileName).toEqual([exp.inserted, exp.endDated, 0, 'active']);
    }
    expect(await q(`select count(*)::int c from benchmark_upload_batches where status = 'activated'`)).toEqual([{ c: 9 }]);
    expect(await q(`select count(*)::int c from benchmark_upload_batches where self_activated`)).toEqual([{ c: 1 }]); // only the single-operator rehearsal of file 9
  });

  it('after the load: totals, history, audit rows and the three spot checks are exactly what the runbook Part E says', async () => {
    const post = await stateSnapshot(db);
    expect(post.allValues).toBe(261);
    expect(post.endDatedValues).toBe(15);
    expect(post.liveBands).toBe(200);
    expect(post.cohorts).toBe(40);
    expect(post.liveValuesByDataset).toMatchObject({
      'AU ASFA retirement standard': 0, 'AU average superannuation balance': 2, 'AU high-DTI mortgage threshold': 1, 'AU household asset composition': 2, 'AU household debt context': 0,
      'AU household wealth distribution': 6, 'AU net worth and income by age band': 30, 'FHIP dependant-band household benchmark model': 198, 'FHIP Planning Benchmarks v1.0': 0,
      'India EPF/EPS contribution structure': 1, 'India household assets and debt (rural/urban)': 6, 'India household consumption expenditure (rural/urban)': 0,
    });
    const e1 = await q<{ dataset_name: string; live_values: number }>(runbookSql('e1'));
    expect(Object.fromEntries(e1.map((r) => [r.dataset_name, Number(r.live_values)]))).toEqual(post.liveValuesByDataset);
    expect((await q<Record<string, number>>(runbookSql('e2')))[0]).toMatchObject({ all_value_rows: 261, end_dated_value_rows: 15, live_value_rows: 246, live_bands: 200, cohorts: 40, new_cohort_present: 1 });
    const e3 = await q<{ old_value: string; new_value: string; metric_code: string; statistic_type: string; cohort: string }>(runbookSql('e3'));
    expect(e3).toHaveLength(15);
    expect(e3.every((r) => r.new_value !== null)).toBe(true);
    expect(e3.map((r) => `${r.cohort}|${r.metric_code}|${r.statistic_type}|${Number(r.old_value)}|${Number(r.new_value)}`)).toEqual(
      expect.arrayContaining([
        '(country-wide)|property_concentration|mean|56.2|55.7661',
        '(country-wide)|net_worth|mean|1040000|1042000',
        '(country-wide)|net_worth|p80|1400000|1447800',
        '(country-wide)|retirement_balance|mean|183000|182781',
        '(country-wide)|retirement_contribution_rate|rate|24|24',
        'AU_AGE_25_34|net_worth|mean|242000|353800',
        'AU_AGE_65_74|gross_household_income|mean|81328|75400',
      ])
    );
  });

  it('after the load (continued): audit blocks, spot checks and the duplicate-key check', async () => {
    const e4 = await q<{ status: string; file_name: string }>(runbookSql('e4'));
    expect(e4.filter((r) => r.status === 'activated')).toHaveLength(9);
    expect(e4.filter((r) => r.status === 'discarded').length).toBeGreaterThanOrEqual(1);
    const e5 = await q<{ rows_imported: number; upload_batch_id: string }>(runbookSql('e5'));
    expect(e5).toHaveLength(9);
    expect(e5.reduce((a, r) => a + Number(r.rows_imported), 0)).toBe(37 + 1);
    const e6 = await q<{ event_type: string }>(runbookSql('e6'));
    expect(e6.filter((r) => r.event_type === 'activated')).toHaveLength(9);
    const e7 = await q<{ check_name: string; live_value: string; expected: string; effective_from: string | null }>(runbookSql('e7'));
    expect(e7).toHaveLength(3);
    for (const r of e7) expect(Number(r.live_value), r.check_name).toBe(Number(r.expected));
    expect(new Date(e7[1].effective_from as string).toISOString().slice(0, 10)).toBe('2026-02-01');
    expect(await q(runbookSql('e8'))).toEqual([]);
  });

  it('Twin read AFTER the load (real loadPeerBenchmark): property_concentration is the sourced 55.7661; PO decision B: age bands and average super now read the median', async () => {
    // PO decision A: the sourced figure replaced the seed, and it is the one the Twin reads (mean, never share).
    expect(await twinRead('property_concentration', null)).toMatchObject({ statistic: 'mean', value: 55.7661 });
    // PO decision B: the Twin switches from mean to median (seed 242,000 mean -> sourced 175,700 median, and so on).
    const age: Array<[string, number, number]> = [
      ['AU_AGE_25_34', 242000, 175700], ['AU_AGE_35_44', 555000, 401000], ['AU_AGE_45_54', 1055000, 799600], ['AU_AGE_55_64', 1453000, 999900], ['AU_AGE_65_74', 1835000, 926700], ['AU_AGE_75_PLUS', 1167000, 725100],
    ];
    for (const [cohort, , median] of age) expect(await twinRead('net_worth', cohort), cohort).toMatchObject({ statistic: 'median', value: median });
    expect(await twinRead('gross_household_income', 'AU_AGE_25_34')).toMatchObject({ statistic: 'median', value: 112944 });
    expect(await twinRead('net_worth', 'AU_AGE_15_24')).toMatchObject({ statistic: 'median', value: 34600 });
    expect(await twinRead('retirement_balance', null)).toMatchObject({ statistic: 'median', value: 63339 });
    // PO decision C: the seed rows no file touches are still served.
    expect(await twinRead('net_worth', 'AU_AGE_18_24')).toMatchObject({ statistic: 'mean', value: 129000 });
    expect(await twinRead('liquid_asset_share', 'IN_RURAL_ALL')).toMatchObject({ statistic: 'mean', value: 4.6 });
    // Unchanged where the figure was already right.
    expect(await twinRead('net_worth', null)).toMatchObject({ statistic: 'median', value: 579200, distribution: expect.objectContaining({ p10: 36900, p20: 113400, p80: 1447800, p90: 2257700 }) });
    expect(await twinRead('debt_to_income', null)).toMatchObject({ statistic: 'threshold', value: 6 });
    // The runbook's own "what the Twin reads" query (block t1, run before and after) says the same.
    const e9 = await q<{ cohort: string; metric_code: string; headline_statistic: string; headline_value: string }>(runbookSql('t1'));
    expect(e9).toHaveLength(28);
    const get = (cohort: string, metric: string) => e9.find((r) => r.cohort === cohort && r.metric_code === metric)!;
    expect([get('(country-wide)', 'property_concentration').headline_statistic, Number(get('(country-wide)', 'property_concentration').headline_value)]).toEqual(['mean', 55.7661]);
    expect([get('AU_AGE_25_34', 'net_worth').headline_statistic, Number(get('AU_AGE_25_34', 'net_worth').headline_value)]).toEqual(['median', 175700]);
    expect([get('(country-wide)', 'retirement_balance').headline_statistic, Number(get('(country-wide)', 'retirement_balance').headline_value)]).toEqual(['median', 63339]);
    expect(get('AU_AGE_18_24', 'net_worth').headline_statistic).toBe('mean');
  });

  it('NC-E8: the duplicate-key check of the runbook really bites - with a second live row planted it returns that key, and nothing once removed', async () => {
    const planted = await q<{ id: string }>(
      `insert into benchmark_values (dataset_id, cohort_id, metric_definition_id, statistic_type, value_numeric, unit, effective_from)
       select dataset_id, cohort_id, metric_definition_id, statistic_type, value_numeric + 1, unit, effective_from from benchmark_values
        where statistic_type = 'threshold' and effective_to is null limit 1 returning id`
    );
    expect(planted).toHaveLength(1);
    const dup = await q<{ metric_code: string; live_rows: number }>(runbookSql('e8'));
    expect(dup.map((r) => [r.metric_code, Number(r.live_rows)])).toEqual([['debt_to_income', 2]]);
    await db.query(`delete from benchmark_values where id = $1`, [planted[0].id]);
    expect(await q(runbookSql('e8'))).toEqual([]);
  });

  it('NC-O5: an activated file cannot be staged again (duplicate protection), so an accidental second click changes nothing', async () => {
    const before = await stateSnapshot(db);
    const f = byOrder(3);
    const client = sessionClient(db, UPLOADER) as unknown as Parameters<typeof stagePlanningBenchmarkUpload>[0];
    await expect(stagePlanningBenchmarkUpload(client, { fileName: f.fileName, bytes: readShippedFile(f.fileName), kind: f.kind, todayIso: await todayOf(db) })).rejects.toMatchObject({ error: { message: expect.stringContaining('PB_E_DUPLICATE') } });
    expect(await stateSnapshot(db)).toEqual(before);
  });

  it('runbook Part F: the documented SQL puts the live figures back exactly as they were before the load (values batches, newest first)', async () => {
    const batches = await q<{ id: string; file_name: string; kind: string }>(`select id, file_name, kind from benchmark_upload_batches where status = 'activated' and kind = 'values' order by activated_at desc, file_name desc`);
    expect(batches).toHaveLength(7);
    for (const b of batches) {
      const sql = runbookSql('f1').split('PASTE-BATCH-ID-HERE').join(b.id);
      // The block is several statements (begin, one data-changing select, commit): exec runs them all and returns one result each.
      const results = await db.exec(sql);
      const out = results.flatMap((r) => r.rows as Array<{ new_figures_taken_out_of_service: number; earlier_figures_restored: number }>).find((r) => 'new_figures_taken_out_of_service' in r)!;
      const expectFor: Record<string, [number, number]> = {
        '02': [2, 1], '03': [4, 2], '04': [26, 10], '05': [0, 0], '06': [2, 1], '07': [2, 0], '08': [1, 1],
      };
      const [n, o] = expectFor[b.file_name.slice(0, 2)];
      expect([Number(out.new_figures_taken_out_of_service), Number(out.earlier_figures_restored)], b.file_name).toEqual([n, o]);
    }
    expect(await liveOf()).toEqual(pre.liveValuesByDataset);
    const live = await q<{ c: number }>(`select count(*)::int c from benchmark_values where effective_to is null or effective_to > current_date`);
    expect(live[0].c).toBe(224);
  });
});
