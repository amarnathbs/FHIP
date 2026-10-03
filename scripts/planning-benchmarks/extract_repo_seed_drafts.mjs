// Generates the two DRAFT-only files for the datasets that have NO external download:
//   dataset 1  FHIP dependant-band household benchmark model  -> blank worksheet of the parameters the app expects
//   dataset 11 FHIP Planning Benchmarks v1.0                  -> the repo's own authored v1.0 bands, as a DRAFT
// Both are transcribed from the repository's own seed migrations (0012, 0023). Nothing is invented here.
// Offline: reads migration text, writes CSV. No database, no network.
//
//   node scripts/planning-benchmarks/extract_repo_seed_drafts.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitSqlStatements, parseValuesTuples, toCsv, TARGET_RANGE_HEADER } from './firstLoadLib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const outDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'docs', 'planning-benchmarks', 'first_load');

const m0012 = fs.readFileSync(path.join(MIG, '0012_module8_benchmark_seed.sql'), 'utf8');
const m0023 = fs.readFileSync(path.join(MIG, '0023_module8_dependant_band.sql'), 'utf8');

// ---- dataset 11: FHIP Planning Benchmarks v1.0 ------------------------------------------------------
const stmts0012 = splitSqlStatements(m0012);
const ranges = [];
for (const s of stmts0012) {
  if (!/^insert into benchmark_target_ranges/i.test(s)) continue;
  if (/ASFA_STANDARD_2026/.test(s)) continue; // dataset 12 (ASFA) is built from the ASFA download, not from the seed
  const hasCountryInTuple = /as v\(metric_code, band_label/.test(s) ? false : /as v\(metric_code, country_code/.test(s);
  for (const t of parseValuesTuples(s)) {
    const [metric_code, ...rest] = t;
    let country_code = '';
    let band_label, band_tier, lower, upper, explanation;
    if (hasCountryInTuple) [country_code, band_label, band_tier, lower, upper, explanation] = rest;
    else [band_label, band_tier, lower, upper, explanation] = rest;
    ranges.push({
      metric_code,
      source_name: 'FHIP_PLANNING_V1',
      country_code: country_code ?? '',
      life_stage: '',
      household_type: '',
      band_label,
      band_tier,
      lower_bound: lower ?? '',
      upper_bound: upper ?? '',
      direction: 'target_range',
      explanation,
      evidence_level: 'research_informed',
      model_version: 'fhip-planning-1.0.0',
      effective_from: '',
      effective_to: '',
      x_obs_id: `FHIP11-${String(ranges.length + 1).padStart(4, '0')}`,
      x_release: 'FHIP Planning Benchmarks v1.0 (repo seed 0012, spec sections 8.1-8.9)',
      x_obs_period_start: '',
      x_obs_period_end: '',
      x_source_file: 'supabase/migrations/0012_module8_benchmark_seed.sql',
      x_source_locator: hasCountryInTuple ? 'section 8.6 retirement target ranges' : 'section 7 FHIP Planning Benchmark v1.0 target ranges',
      x_retrieval_date: '',
    });
  }
}

// ---- dataset 1: dependant-band model worksheet ------------------------------------------------------
const stmts0023 = splitSqlStatements(m0023);
const depStmt = stmts0023.find((s) => /^insert into benchmark_values/i.test(s) && /FHIP dependant-band household benchmark model/.test(s));
if (!depStmt) throw new Error('dependant-band value insert not found in 0023');
const depRows = parseValuesTuples(depStmt).map(([cohort_code, metric_code, value, unit, currency], i) => ({
  dataset_name: 'FHIP dependant-band household benchmark model',
  dataset_version: '1.0',
  cohort_code,
  metric_code,
  statistic_type: 'mean',
  value_numeric: '',
  unit,
  original_currency: currency,
  is_derived: 'true',
  derivation_method: '',
  REFERENCE_ONLY_repo_seed_0023_value: value,
  approval_status: 'NEEDS PO APPROVAL - methodology not defined',
  evidence_candidates:
    currency === 'AUD'
      ? 'ABS Household Expenditure Survey (expenditure by household composition); not downloaded or used'
      : 'MoSPI HCES (per-capita MPCE; no by-dependant-count cross-tab published); not downloaded or used',
  x_obs_id: `FHIP01-${String(i + 1).padStart(4, '0')}`,
}));

const depHeader = [
  'dataset_name',
  'dataset_version',
  'cohort_code',
  'metric_code',
  'statistic_type',
  'value_numeric',
  'unit',
  'original_currency',
  'is_derived',
  'derivation_method',
  'REFERENCE_ONLY_repo_seed_0023_value',
  'approval_status',
  'evidence_candidates',
  'x_obs_id',
];

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, '01_fhip_dependant_band_model.DRAFT_WORKSHEET.csv'), toCsv(depHeader, depRows));
fs.writeFileSync(path.join(outDir, '11_fhip_planning_benchmarks_v1.DRAFT_FOR_PO_APPROVAL.target_ranges.csv'), toCsv(TARGET_RANGE_HEADER, ranges));
console.log(JSON.stringify({ dependantBandParameters: depRows.length, planningTargetRanges: ranges.length, outDir }));
