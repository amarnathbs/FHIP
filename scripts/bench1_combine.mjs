#!/usr/bin/env node
// Offline (no network, no credentials): combine inventory_dev.json + inventory_prod.json into
// inventory_combined.csv and category_demand_summary.csv. Reads only the two JSON files.
import fs from 'node:fs';
const dev = JSON.parse(fs.readFileSync('inventory_dev.json', 'utf8')).rows.map((r) => ({ ...r, env: 'dev' }));
const prod = JSON.parse(fs.readFileSync('inventory_prod.json', 'utf8')).rows.map((r) => ({ ...r, env: 'prod' }));

const csv = (v) => { if (v === null || v === undefined) return ''; const s = Array.isArray(v) ? v.join(';') : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const min = (a) => a.filter(Boolean).sort()[0] ?? null;
const max = (a) => a.filter(Boolean).sort().slice(-1)[0] ?? null;

// Distinct scheme identity ACROSS environments: AMFI code (one AMFI code = one plan/option/ISIN variant),
// else first ISIN, else env-scoped instrument id (unresolved; never merged across envs). DEV and prod
// instrument UUIDs are independent, so instrument_id is never used to join environments.
const keyOf = (r) => (r.amfi_scheme_code && !/^TESTFIX-/i.test(r.amfi_scheme_code) ? `amfi:${r.amfi_scheme_code}` : r.isins[0] ? `isin:${r.isins[0]}` : `${r.env}-instrument:${r.instrument_id}`);
const groups = new Map();
for (const r of [...prod, ...dev]) { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }

const combined = [];
for (const [k, g] of groups) {
  const p = g.find((x) => x.env === 'prod'), d = g.find((x) => x.env === 'dev');
  const base = p || d; // prefer prod identity
  combined.push({
    distinct_scheme_key: k,
    in_prod: !!p, in_dev: !!d,
    scheme_family_key: base.scheme_family_key,
    prod_instrument_id: p?.instrument_id ?? null, dev_instrument_id: d?.instrument_id ?? null,
    amfi_scheme_code: base.amfi_scheme_code, isins: [...new Set(g.flatMap((x) => x.isins))].sort(),
    amc_name: base.amc_name, scheme_name: base.scheme_name,
    plan_type: base.plan_type, option_type: base.option_type, plan_raw: base.plan_raw, option_raw: base.option_raw,
    category_group: base.category_group, sub_category: base.sub_category, category_header_raw: base.category_header_raw,
    instrument_class: base.instrument_class, country_of_domicile: base.country_of_domicile, base_currency: base.base_currency,
    unresolved_identity: g.every((x) => x.unresolved_identity), likely_test_fixture: g.every((x) => x.likely_test_fixture),
    identity_notes: [...new Set(g.flatMap((x) => x.identity_notes))].sort(),
    prod_holder_count_users: p?.holder_count_ever ?? 0, dev_holder_count_users: d?.holder_count_ever ?? 0,
    prod_holder_count_current: p?.holder_count_current_positive_units ?? 0, dev_holder_count_current: d?.holder_count_current_positive_units ?? 0,
    first_transaction_date: min(g.map((x) => x.first_transaction_date)),
    latest_holding_date: max(g.map((x) => x.latest_holding_date)),
    earliest_nav_date_on_file: min(g.map((x) => x.earliest_nav_date_on_file)),
    required_series_from_tx_rule: min(g.map((x) => x.required_series_from_tx_rule)),
    required_series_from_nav_rule: min(g.map((x) => x.required_series_from_nav_rule)),
    required_from_date: min(g.map((x) => x.required_from_date)),
    required_basis: (g.find((x) => x.required_from_date === min(g.map((y) => y.required_from_date))) || base).required_basis,
    mapping_state: g.every((x) => x.mapping_state === 'unmapped') ? 'unmapped' : [...new Set(g.map((x) => x.mapping_state))].join(';'),
    current_benchmark_key: base.current_benchmark_key,
    availability_state: [...new Set(g.map((x) => x.availability_state))].join(';'),
    benchmark_series_min_date: min(g.map((x) => x.benchmark_series_min_date)),
    benchmark_series_max_date: max(g.map((x) => x.benchmark_series_max_date)),
  });
}
combined.sort((a, b) => (a.scheme_family_key + a.plan_type + a.option_type + a.distinct_scheme_key).localeCompare(b.scheme_family_key + b.plan_type + b.option_type + b.distinct_scheme_key));
const cols = Object.keys(combined[0]);
fs.writeFileSync('inventory_combined.csv', [cols.join(','), ...combined.map((r) => cols.map((c) => csv(r[c])).join(','))].join('\n') + '\n');

// ---- category demand summary (by AMFI sub_category) ------------------------------------
const cat = new Map();
for (const r of combined) {
  const key = r.sub_category || '(no scheme master: category unresolved)';
  if (!cat.has(key)) cat.set(key, []);
  cat.get(key).push(r);
}
const catRows = [...cat.entries()].map(([sub, g]) => {
  const real = g.filter((x) => !x.likely_test_fixture);
  return {
    sub_category: sub,
    category_groups: [...new Set(g.map((x) => x.category_group).filter(Boolean))].sort(),
    held_scheme_rows_distinct_all: g.length,
    held_families_distinct_all: new Set(g.map((x) => x.scheme_family_key)).size,
    held_scheme_rows_excluding_test_fixtures: real.length,
    held_families_excluding_test_fixtures: new Set(real.map((x) => x.scheme_family_key)).size,
    held_scheme_rows_in_prod: g.filter((x) => x.in_prod).length,
    held_families_in_prod: new Set(g.filter((x) => x.in_prod).map((x) => x.scheme_family_key)).size,
    held_scheme_rows_in_dev: g.filter((x) => x.in_dev).length,
    unresolved_identity_rows: g.filter((x) => x.unresolved_identity).length,
    earliest_required_from_date_all: min(g.map((x) => x.required_from_date)),
    earliest_required_from_date_excluding_test_fixtures: min(real.map((x) => x.required_from_date)),
    earliest_required_from_tx_rule_excluding_test_fixtures: min(real.map((x) => x.required_series_from_tx_rule)),
    earliest_nav_on_file_excluding_test_fixtures: min(real.map((x) => x.earliest_nav_date_on_file)),
    latest_holding_date: max(g.map((x) => x.latest_holding_date)),
    rows_with_current_mapping: g.filter((x) => x.mapping_state !== 'unmapped').length,
  };
}).sort((a, b) => b.held_scheme_rows_excluding_test_fixtures - a.held_scheme_rows_excluding_test_fixtures || a.sub_category.localeCompare(b.sub_category));
const cc = Object.keys(catRows[0]);
fs.writeFileSync('category_demand_summary.csv', [cc.join(','), ...catRows.map((r) => cc.map((c) => csv(r[c])).join(','))].join('\n') + '\n');

const summary = {
  combined_distinct_scheme_rows: combined.length,
  combined_distinct_families: new Set(combined.map((x) => x.scheme_family_key)).size,
  both_envs: combined.filter((x) => x.in_dev && x.in_prod).length,
  prod_only: combined.filter((x) => x.in_prod && !x.in_dev).length,
  dev_only: combined.filter((x) => x.in_dev && !x.in_prod).length,
  excluding_test_fixtures_rows: combined.filter((x) => !x.likely_test_fixture).length,
  excluding_test_fixtures_families: new Set(combined.filter((x) => !x.likely_test_fixture).map((x) => x.scheme_family_key)).size,
  categories: catRows.length,
};
console.log(JSON.stringify(summary, null, 1));
