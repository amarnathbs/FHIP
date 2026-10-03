// Pure check functions for the Planning Benchmarks first load. Each returns an array of failure strings
// (empty = pass) so the tests can run the SAME check against a deliberately mutated copy and assert that it
// goes red (named negative controls).
import { isRealIsoDate, registerKey } from './firstLoadLib.mjs';

export const DATASETS = {
  1: 'FHIP dependant-band household benchmark model',
  2: 'AU household asset composition',
  3: 'AU household wealth distribution',
  4: 'AU net worth and income by age band',
  5: 'AU high-DTI mortgage threshold',
  6: 'AU average superannuation balance',
  7: 'AU household debt context',
  8: 'India household consumption expenditure (rural/urban)',
  9: 'India household assets and debt (rural/urban)',
  10: 'India EPF/EPS contribution structure',
  11: 'FHIP Planning Benchmarks v1.0',
  12: 'AU ASFA retirement standard',
};
export const DATASET_NO_BY_NAME = Object.fromEntries(Object.entries(DATASETS).map(([k, v]) => [v, Number(k)]));

export const DTI_DATASET = DATASETS[5];
export const DTI_EFFECTIVE_FROM = '2026-02-01';

/** Published age-band wording -> the band code used on a cohort row. Edges are never changed. */
export function normaliseBand(published) {
  const s = String(published).trim().toLowerCase();
  let m = s.match(/^(\d{1,2})\s*(?:-|to|–)\s*(\d{1,2})(?:\s*years?)?$/);
  if (m) return `AGE_${m[1]}_${m[2]}`;
  m = s.match(/^(\d{1,2})\s*(?:\+|and over|and older|or over|plus|years and over)$/);
  if (m) return `AGE_${m[1]}_PLUS`;
  m = s.match(/^(?:under|less than)\s*(\d{1,2})$/);
  if (m) return `AGE_UNDER_${m[1]}`;
  return null;
}

const rowId = (r) => `${r.file}:${r.record.x_obs_id || '(no x_obs_id)'}`;

export function checkUnits(values, metricUnitByCode) {
  const fails = [];
  for (const r of values) {
    const expect = metricUnitByCode[r.record.metric_code];
    if (!expect) fails.push(`${rowId(r)} unknown metric_code ${r.record.metric_code}`);
    else if (r.record.unit !== expect) fails.push(`${rowId(r)} unit "${r.record.unit}" but metric ${r.record.metric_code} is defined in "${expect}"`);
    if (r.record.unit === 'currency' && !/^[A-Z]{3}$/.test(r.record.original_currency || '')) fails.push(`${rowId(r)} currency amount without a 3-letter original_currency`);
    if (r.record.unit !== 'currency' && r.record.original_currency && !/^[A-Z]{3}$/.test(r.record.original_currency)) fails.push(`${rowId(r)} bad original_currency`);
    const isIndia = /^India/.test(r.record.dataset_name);
    if (r.record.unit === 'currency' && r.record.original_currency && r.record.original_currency !== (isIndia ? 'INR' : 'AUD')) {
      fails.push(`${rowId(r)} currency ${r.record.original_currency} does not match the dataset country`);
    }
  }
  return fails;
}

export function checkProvenance(values) {
  const fails = [];
  for (const r of values) {
    const x = r.record;
    for (const c of ['x_obs_id', 'x_release', 'x_source_file', 'x_source_locator', 'value_text']) {
      if (!String(x[c] ?? '').trim()) fails.push(`${rowId(r)} missing ${c}`);
    }
    for (const c of ['x_obs_period_start', 'x_retrieval_date']) {
      if (!isRealIsoDate(x[c] || '')) fails.push(`${rowId(r)} ${c} is not a real ISO date: "${x[c]}"`);
    }
    // an open-ended rule (e.g. the APRA DTI limit) has a start and no end; any end that IS given must be real
    if (x.x_obs_period_end && !isRealIsoDate(x.x_obs_period_end)) fails.push(`${rowId(r)} x_obs_period_end is not a real ISO date: "${x.x_obs_period_end}"`);
    if (x.x_reference_date && !isRealIsoDate(x.x_reference_date)) fails.push(`${rowId(r)} x_reference_date is not a real ISO date`);
    for (const c of ['base_date', 'effective_from', 'effective_to']) {
      if (x[c] && !isRealIsoDate(x[c])) fails.push(`${rowId(r)} ${c} is not a real ISO date: "${x[c]}"`);
    }
    if (x.x_obs_period_start && x.x_obs_period_end && x.x_obs_period_start > x.x_obs_period_end) fails.push(`${rowId(r)} observation period ends before it starts`);
    if (x.x_retrieval_date && x.x_retrieval_date > '2026-10-03') fails.push(`${rowId(r)} retrieval date is in the future`);
    if (String(x.is_derived).toLowerCase() === 'true' && !String(x.derivation_method ?? '').trim()) fails.push(`${rowId(r)} derived value without derivation_method`);
  }
  return fails;
}

/** Every observation period a data row claims must be a release that was actually downloaded (register row). */
export function checkObservationPeriods(values, register) {
  const fails = [];
  const byDataset = new Map();
  for (const reg of register) {
    const k = Number(reg.dataset_no);
    if (!byDataset.has(k)) byDataset.set(k, new Set());
    byDataset.get(k).add(registerKey(reg));
  }
  for (const r of values) {
    const no = DATASET_NO_BY_NAME[r.record.dataset_name];
    const key = [r.record.x_release, r.record.x_obs_period_start, r.record.x_obs_period_end].join('|');
    if (!no || !byDataset.get(no)?.has(key)) fails.push(`${rowId(r)} observation period "${key}" is not in the provenance register for dataset ${no ?? r.record.dataset_name}`);
  }
  return fails;
}

/** Every row must trace to published observation(s); a non-derived value must equal the published figure exactly. */
export function checkTraceability(values, extractsById) {
  const fails = [];
  for (const r of values) {
    const ids = String(r.record.x_obs_id || '')
      .split('+')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      fails.push(`${rowId(r)} no x_obs_id`);
      continue;
    }
    const obs = ids.map((i) => extractsById.get(i));
    const missing = ids.filter((_, i) => !obs[i]);
    if (missing.length) {
      fails.push(`${rowId(r)} x_obs_id not found in the extraction files: ${missing.join(',')}`);
      continue;
    }
    if (obs.some((o) => o.status !== 'OK')) fails.push(`${rowId(r)} traces to a ${obs.find((o) => o.status !== 'OK').status} observation`);
    const derived = String(r.record.is_derived).toLowerCase() === 'true';
    const mult = Number(r.record.x_unit_multiplier || 1);
    if (![1, 1000, 1e6].includes(mult)) fails.push(`${rowId(r)} x_unit_multiplier ${r.record.x_unit_multiplier} is not 1, 1000 or 1000000 (a pure unit conversion)`);
    if (!derived) {
      const expected = Number(obs[0].value) * mult;
      if (ids.length !== 1) fails.push(`${rowId(r)} a non-derived value must trace to exactly one published observation`);
      else if (!(Math.abs(Number(r.record.value_numeric) - expected) <= 1e-9 * Math.max(1, Math.abs(expected))))
        fails.push(`${rowId(r)} value ${r.record.value_numeric} differs from published ${obs[0].value} x ${mult} (${ids[0]}); if it is computed it must be marked derived`);
      if (obs[0] && r.record.x_obs_period_start && obs[0].obs_period_start && r.record.x_obs_period_start !== obs[0].obs_period_start) fails.push(`${rowId(r)} observation period start differs from the extraction`);
      if (obs[0] && r.record.x_obs_period_end && obs[0].obs_period_end && r.record.x_obs_period_end !== obs[0].obs_period_end) fails.push(`${rowId(r)} observation period end differs from the extraction`);
    }
  }
  return fails;
}

/** An importable value row must carry a real number; a worksheet row with a blank value is not importable. */
export function checkValuesComplete(values) {
  const fails = [];
  for (const r of values) {
    const v = String(r.record.value_numeric ?? '').trim();
    if (v === '' || !Number.isFinite(Number(v))) fails.push(`${rowId(r)} has no numeric value_numeric ("${v}")`);
  }
  return fails;
}

/** The consumer (twinBenchmarkRetrieval.loadPeerBenchmark) keys on (metric, cohort, statistic) and keeps the last row: duplicates silently overwrite. */
export function checkNoDuplicateKeys(values) {
  const seen = new Map();
  const fails = [];
  for (const r of values) {
    const k = `${r.record.metric_code}|${(r.record.cohort_code || '').trim() || '(country-wide)'}|${r.record.statistic_type}`;
    if (seen.has(k)) fails.push(`${rowId(r)} duplicates key ${k} (also ${seen.get(k)}); the live Twin keeps only one row per key`);
    else seen.set(k, rowId(r));
  }
  return fails;
}

export function checkDtiNotBackfilled(values) {
  const fails = [];
  for (const r of values.filter((v) => v.record.dataset_name === DTI_DATASET)) {
    const x = r.record;
    if (!x.effective_from || x.effective_from < DTI_EFFECTIVE_FROM) fails.push(`${rowId(r)} DTI effective_from "${x.effective_from}" is before ${DTI_EFFECTIVE_FROM} (backfill)`);
    if (x.base_date && x.base_date < DTI_EFFECTIVE_FROM) fails.push(`${rowId(r)} DTI base_date "${x.base_date}" is before ${DTI_EFFECTIVE_FROM} (backfill)`);
    if (x.x_obs_period_start && x.x_obs_period_start < DTI_EFFECTIVE_FROM) fails.push(`${rowId(r)} DTI observation period starts before ${DTI_EFFECTIVE_FROM} (backfill)`);
    if (x.effective_to) fails.push(`${rowId(r)} DTI row carries an effective_to; the current limit has no end date in the notice`);
  }
  return fails;
}

/** Cohort bands must be the source's own band, normalised by shape only (no edge changes). */
export function checkBandsPreserved(cohorts, extractsById) {
  const fails = [];
  for (const c of cohorts) {
    const band = c.record.age_band;
    if (!band) continue;
    const ids = String(c.record.x_obs_id || '').split('+').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) {
      fails.push(`${c.file}:${c.record.cohort_code} age_band without x_obs_id`);
      continue;
    }
    const published = ids.map((i) => extractsById.get(i)?.dim_age_band).filter(Boolean);
    if (!published.length) {
      fails.push(`${c.file}:${c.record.cohort_code} no published dim_age_band found for ${ids.join(',')}`);
      continue;
    }
    if (!published.some((p) => normaliseBand(p) === band)) fails.push(`${c.file}:${c.record.cohort_code} age_band ${band} is not the published band ${published.join(' / ')}`);
  }
  return fails;
}

/** Derived values must be exactly reproducible from the published observations they cite (rule per metric). */
export function checkDerivedRecompute(values, extractsById) {
  const fails = [];
  for (const r of values.filter((v) => String(v.record.is_derived).toLowerCase() === 'true')) {
    const ids = String(r.record.x_obs_id || '').split('+').map((x) => x.trim()).filter(Boolean);
    const v = ids.map((i) => Number(extractsById.get(i)?.value));
    if (v.some((n) => !Number.isFinite(n))) {
      fails.push(`${rowId(r)} cannot recompute: an input observation is missing`);
      continue;
    }
    const m = r.record.metric_code;
    let expected;
    if (m === 'property_concentration' && v.length === 2) expected = (v[0] / v[1]) * 100;
    else if (m === 'gross_household_income' && v.length === 1) expected = v[0] * 52;
    else if (m === 'debt_to_asset_ratio' && v.length === 1) expected = v[0] * 100;
    else if (m === 'retirement_contribution_rate' && v.length === 2) expected = v[0] + v[1];
    else {
      fails.push(`${rowId(r)} derived metric ${m} with ${v.length} inputs has no recompute rule`);
      continue;
    }
    if (!(Math.abs(Number(r.record.value_numeric) - expected) <= 5e-5 + 1e-9 * Math.abs(expected))) fails.push(`${rowId(r)} derived value ${r.record.value_numeric} != recomputed ${expected}`);
  }
  return fails;
}

/**
 * A value row that uses a cohort with an age band must use a cohort whose band is the band the source published for
 * that figure (this catches reusing the app's 18-24 cohort for the ABS 15-24 figure).
 */
export function checkValueCohortBands(values, cohortAgeBandByCode, extractsById) {
  const fails = [];
  for (const r of values) {
    const code = (r.record.cohort_code || '').trim();
    if (!code) continue;
    const band = cohortAgeBandByCode[code];
    if (band === undefined) {
      fails.push(`${rowId(r)} cohort ${code} is neither registered nor defined in a cohorts file`);
      continue;
    }
    if (!band) continue; // cohort without an age band (e.g. India urban/rural cohorts): nothing to compare
    const published = String(r.record.x_obs_id || '').split('+').map((i) => extractsById.get(i.trim())?.dim_age_band).filter(Boolean);
    if (!published.some((p) => normaliseBand(p) === band)) fails.push(`${rowId(r)} cohort ${code} has age_band ${band} but the published band is "${published.join(' / ') || 'none'}"`);
  }
  return fails;
}

/** Target-range rows: provenance, a real period in the register, and the published figure equals the one non-structural bound. */
export function checkTargetRanges(rows, extractsById, register) {
  const fails = [];
  const keys = new Set(register.map((x) => `${x.dataset_no}|${x.release_name}|${x.obs_period_start}|${x.obs_period_end}`));
  for (const r of rows) {
    const x = r.record;
    const id = `${r.file}:${x.x_obs_id || '(no x_obs_id)'}`;
    for (const c of ['x_obs_id', 'x_release', 'x_source_file', 'x_source_locator', 'explanation']) if (!String(x[c] ?? '').trim()) fails.push(`${id} missing ${c}`);
    if (!isRealIsoDate(x.x_obs_period_start || '')) fails.push(`${id} x_obs_period_start is not a real ISO date`);
    if (!isRealIsoDate(x.x_retrieval_date || '')) fails.push(`${id} x_retrieval_date is not a real ISO date`);
    if (!keys.has(`12|${x.x_release}|${x.x_obs_period_start}|${x.x_obs_period_end}`)) fails.push(`${id} release/period "${x.x_release}|${x.x_obs_period_start}|${x.x_obs_period_end}" is not in the provenance register`);
    const o = extractsById.get(x.x_obs_id);
    if (!o) {
      fails.push(`${id} x_obs_id not found in the extraction`);
      continue;
    }
    if (o.status !== 'OK') fails.push(`${id} traces to a ${o.status} observation`);
    const lo = x.lower_bound === '' ? null : Number(x.lower_bound);
    const hi = x.upper_bound === '' ? null : Number(x.upper_bound);
    const pub = Number(o.value);
    const published = [lo, hi].filter((b) => b !== null && b === pub);
    if (published.length !== 1) fails.push(`${id} exactly one bound must equal the published figure ${pub} (lower ${lo}, upper ${hi})`);
    const other = lo === pub ? hi : lo;
    if (other !== null && other !== 0) fails.push(`${id} the other bound ${other} is neither empty nor the structural 0`);
    if (x.effective_from && !isRealIsoDate(x.effective_from)) fails.push(`${id} effective_from is not a real ISO date`);
  }
  return fails;
}
