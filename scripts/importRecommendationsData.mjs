// One-off direct import: loads the 4 recommendation CSVs straight into
// Supabase via the service-role key, in small batches — used because the
// combined dataset (2893 rows) is too large for the Supabase SQL editor's
// paste limit, and there is no browser file-picker automation available to
// drive the admin upload UI's <input type="file"> from here. Batched
// upsert-by-code, same semantics as /api/admin/recommendations/upload.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const envText = fs.readFileSync('D:\\FHIP\\.env.local', 'utf8');
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const SRC_DIR = 'D:\\FHIP\\User tests\\forecasting test';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // no-op
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  const header = nonEmpty[0];
  return nonEmpty.slice(1).map((cells) => {
    const obj = {};
    header.forEach((h, i) => (obj[h.trim()] = cells[i] ?? ''));
    return obj;
  });
}

function toBool(v, fallback = false) {
  if (v === undefined || v.trim() === '') return fallback;
  return v.trim().toLowerCase() === 'true';
}
function toInt(v, fallback) {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}
function toNullable(v) {
  return v && v.trim() !== '' ? v.trim() : null;
}
function splitList(v) {
  if (!v || v.trim() === '') return [];
  return v
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean);
}

async function upsertBatched(table, rows, onConflict, batchSize = 200) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) throw new Error(`${table} batch ${i}-${i + batch.length}: ${error.message}`);
    console.log(`  ${table}: upserted ${i + batch.length}/${rows.length}`);
  }
}

async function insertBatched(table, rows, batchSize = 200) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from(table).insert(batch);
    if (error) throw new Error(`${table} batch ${i}-${i + batch.length}: ${error.message}`);
    console.log(`  ${table}: inserted ${i + batch.length}/${rows.length}`);
  }
}

async function main() {
  const placeholders = parseCsv(fs.readFileSync(path.join(SRC_DIR, 'FHIP_Recommendation_Placeholders_120.csv'), 'utf8'));
  const calcMethods = parseCsv(fs.readFileSync(path.join(SRC_DIR, 'FHIP_Recommendation_Calculation_Methods_88.csv'), 'utf8'));
  const master = parseCsv(fs.readFileSync(path.join(SRC_DIR, 'FHIP_Recommendation_Master_542.csv'), 'utf8'));
  const conditions = parseCsv(fs.readFileSync(path.join(SRC_DIR, 'FHIP_Recommendation_Conditions_2143.csv'), 'utf8'));

  console.log('Importing placeholders...');
  await upsertBatched(
    'recommendation_template_placeholders',
    placeholders.map((p) => ({
      placeholder: p.placeholder,
      data_type: p.placeholder === 'country_code' ? 'text' : p.data_type, // fixes the source file's copy-paste error for this one row
      description: toNullable(p.description),
      source: toNullable(p.source),
      availability: toNullable(p.availability),
      display_format: p.placeholder === 'country_code' ? 'Text' : toNullable(p.display_format),
      is_active: toBool(p.is_active, true),
      validation_note: toNullable(p.validation_note),
    })),
    'placeholder'
  );

  console.log('Importing calculation methods...');
  await upsertBatched(
    'recommendation_calculation_methods',
    calcMethods.map((m) => ({
      calculation_method_code: m.calculation_method_code,
      method_name: m.method_name,
      forecast_categories: splitList(m.forecast_categories),
      description: toNullable(m.description),
      calculation_service: toNullable(m.calculation_service),
      required_inputs: splitList(m.required_inputs),
      outputs: splitList(m.outputs),
      rounding_method: toNullable(m.rounding_method),
      supported_scenarios: splitList(m.supported_scenarios),
      is_active: toBool(m.is_active, true),
      version_number: toInt(m.version_number, 1),
      admin_notes: toNullable(m.admin_notes),
    })),
    'calculation_method_code'
  );

  console.log('Importing master recommendations...');
  await upsertBatched(
    'action_recommendation_master',
    master.map((m) => {
      const isDataQuality = m.forecast_category === 'data_quality';
      return {
        recommendation_code: m.recommendation_code,
        forecast_category: m.forecast_category,
        sub_category: m.sub_category,
        scenario_name: m.scenario_name,
        scenario_description: toNullable(m.scenario_description),
        variance_result: toNullable(m.variance_result),
        forecast_status: m.forecast_status,
        severity: m.severity,
        action_type: m.action_type,
        action_title_template: m.action_title_template,
        action_content_template: m.action_content_template,
        financial_impact_template: toNullable(m.financial_impact_template),
        calculation_method_code: toNullable(m.calculation_method_code),
        required_input_fields: splitList(m.required_input_fields),
        supported_placeholders: splitList(m.supported_placeholders),
        priority_score: toInt(m.priority_score, 0),
        country_code: toNullable(m.country_code),
        currency_code: toNullable(m.currency_code),
        customer_segment: m.customer_segment || 'base',
        effective_from: toNullable(m.effective_from),
        effective_to: toNullable(m.effective_to),
        is_active: toBool(m.is_active, true),
        requires_ai: toBool(m.requires_ai, false),
        version_number: toInt(m.version_number, 1),
        admin_notes: toNullable(m.admin_notes),
        include_in_forecasting: !isDataQuality,
        include_in_monthly_report: isDataQuality,
      };
    }),
    'recommendation_code'
  );

  console.log('Importing conditions...');
  await insertBatched(
    'action_recommendation_conditions',
    conditions.map((c) => ({
      recommendation_code: c.recommendation_code,
      condition_group: toInt(c.condition_group, 1),
      field_name: c.field_name,
      operator: c.operator || 'equals',
      comparison_value: toNullable(c.comparison_value),
      comparison_value_2: toNullable(c.comparison_value_2),
      data_type: c.data_type || 'text',
      logical_operator: c.logical_operator || 'AND',
      evaluation_order: toInt(c.evaluation_order, 1),
      is_active: toBool(c.is_active, true),
    }))
  );

  console.log('Done.');
  console.log(`Totals: placeholders=${placeholders.length}, calcMethods=${calcMethods.length}, master=${master.length}, conditions=${conditions.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
