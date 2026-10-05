// Planning Benchmarks first-load tooling (offline, no database, no network).
//
// What this module is: pure helpers shared by
//   - tests/unit/planningBenchmarksFirstLoad.test.ts   (offline validation)
//   - scripts/planning-benchmarks/build_payloads.mjs   (turns the natural-key CSVs into the exact JSON
//                                                      bodies the existing Admin API routes accept)
//
// Why natural keys: the existing Admin routes (app/api/admin/benchmarks/{sources,datasets,cohorts,values,
// target-ranges}) take UUID foreign keys (benchmark_source_id, dataset_id, cohort_id, metric_definition_id).
// A file prepared before the target database is read cannot contain those UUIDs, so the import files use
// natural keys (dataset_name + dataset_version, cohort_code, metric_code, source_name) and the builder
// resolves them from an id-map the PO exports with the READ-ONLY query in the runbook.
//
// Columns whose name starts with `x_` are provenance carried in the file only. They are NEVER sent to the
// API (PostgREST would reject an unknown column) - the builder strips them.
import fs from 'node:fs';

// ---------------------------------------------------------------------------------------------------
// CSV (RFC 4180, UTF-8, header row required)
// ---------------------------------------------------------------------------------------------------
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
  }
  if (rows.length === 0) return { header: [], records: [] };
  const header = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r, idx) => {
    if (r.length !== header.length) {
      throw new Error(`CSV row ${idx + 2} has ${r.length} fields, header has ${header.length}`);
    }
    const o = {};
    header.forEach((h, k) => (o[h] = r[k]));
    return o;
  });
  return { header, records };
}

export function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header, records) {
  const lines = [header.map(csvEscape).join(',')];
  for (const r of records) lines.push(header.map((h) => csvEscape(r[h])).join(','));
  return lines.join('\n') + '\n';
}

export function readCsvFile(file) {
  return parseCsv(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------------------------------
// SQL helpers (used to read the REAL migration text, so the offline checks cannot drift from the schema)
// ---------------------------------------------------------------------------------------------------
/** Split SQL into statements on `;` outside single-quoted strings and `--` comments. */
export function splitSqlStatements(sql) {
  const out = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inStr) {
      cur += c;
      if (c === "'") {
        if (sql[i + 1] === "'") {
          cur += "'";
          i++;
        } else inStr = false;
      }
      continue;
    }
    if (c === "'") {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      cur += '\n';
      continue;
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Parse the rows of a `values (...), (...)` list from an INSERT statement into arrays of raw SQL
 * literals (strings are unquoted, `null` -> null, numbers -> Number, true/false -> boolean).
 * Casts like `null::int` / `0::numeric` are accepted. Sub-selects are NOT supported (the caller
 * handles those statements itself).
 */
export function parseValuesTuples(stmt) {
  const idx = stmt.search(/\bvalues\b/i);
  if (idx < 0) throw new Error('no values list');
  const body = stmt.slice(idx + 6);
  const tuples = [];
  let i = 0;
  const n = body.length;
  const skipWs = () => {
    while (i < n && /\s/.test(body[i])) i++;
  };
  const readLiteral = () => {
    skipWs();
    if (body[i] === "'") {
      let s = '';
      i++;
      while (i < n) {
        if (body[i] === "'") {
          if (body[i + 1] === "'") {
            s += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += body[i++];
      }
      skipCast();
      return s;
    }
    let tok = '';
    while (i < n && !/[,)]/.test(body[i])) tok += body[i++];
    tok = tok.trim().replace(/::\w+(\(\d+(,\d+)?\))?$/, '').trim();
    if (/^null$/i.test(tok)) return null;
    if (/^true$/i.test(tok)) return true;
    if (/^false$/i.test(tok)) return false;
    if (/^-?\d+(\.\d+)?$/.test(tok)) return Number(tok);
    return tok;
  };
  const skipCast = () => {
    if (body[i] === ':' && body[i + 1] === ':') {
      while (i < n && !/[,)]/.test(body[i])) i++;
    }
  };
  for (;;) {
    // skip comments / whitespace / commas between tuples
    while (i < n && (/\s/.test(body[i]) || body[i] === ',')) i++;
    if (body[i] === '-' && body[i + 1] === '-') {
      while (i < n && body[i] !== '\n') i++;
      continue;
    }
    if (body[i] !== '(') break;
    i++;
    const vals = [];
    for (;;) {
      vals.push(readLiteral());
      skipWs();
      if (body[i] === ',') {
        i++;
        continue;
      }
      if (body[i] === ')') {
        i++;
        break;
      }
      throw new Error(`unexpected char ${body[i]} at ${i}`);
    }
    tuples.push(vals);
  }
  return tuples;
}

// ---------------------------------------------------------------------------------------------------
// Dates: machine columns are ISO yyyy-mm-dd (database format). Anything user-visible is day-first.
// ---------------------------------------------------------------------------------------------------
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isRealIsoDate(s) {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** dd/mm/yyyy for text meant to be read by people (docs, runbook output). */
export function dayFirst(iso) {
  if (!isRealIsoDate(iso)) return iso;
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ---------------------------------------------------------------------------------------------------
// Column contracts - EXACTLY the database columns the existing routes insert, plus natural keys.
// ---------------------------------------------------------------------------------------------------
export const VALUES_DB_COLUMNS = [
  'statistic_type',
  'value_numeric',
  'value_text',
  'unit',
  'original_currency',
  'base_date',
  'is_derived',
  'derivation_method',
  'confidence_score',
  'effective_from',
  'effective_to',
  'version',
];
export const VALUES_KEY_COLUMNS = ['dataset_name', 'dataset_version', 'cohort_code', 'metric_code'];
export const VALUES_PROVENANCE_COLUMNS = [
  'x_obs_id',
  'x_release',
  'x_obs_period_start',
  'x_obs_period_end',
  'x_reference_date',
  'x_source_file',
  'x_source_locator',
  'x_retrieval_date',
  'x_unit_multiplier',
];
export const VALUES_HEADER = [...VALUES_KEY_COLUMNS, ...VALUES_DB_COLUMNS, ...VALUES_PROVENANCE_COLUMNS];

export const COHORT_DB_COLUMNS = [
  'cohort_code',
  'country_code',
  'region_code',
  'urban_rural',
  'age_band',
  'income_band',
  'household_type',
  'life_stage',
  'housing_tenure',
  'employment_type',
  'dependant_band',
  'financial_dna_code',
  'cross_border_flag',
  'cohort_tier',
  'sample_size',
  'cohort_description',
];
export const COHORT_HEADER = ['dataset_name', 'dataset_version', ...COHORT_DB_COLUMNS, 'x_obs_id', 'x_release', 'x_source_file', 'x_source_locator'];

export const TARGET_RANGE_DB_COLUMNS = [
  'country_code',
  'life_stage',
  'household_type',
  'band_label',
  'band_tier',
  'lower_bound',
  'upper_bound',
  'direction',
  'explanation',
  'evidence_level',
  'model_version',
  'effective_from',
  'effective_to',
];
export const TARGET_RANGE_HEADER = [
  'metric_code',
  'source_name',
  ...TARGET_RANGE_DB_COLUMNS,
  'x_obs_id',
  'x_release',
  'x_obs_period_start',
  'x_obs_period_end',
  'x_source_file',
  'x_source_locator',
  'x_retrieval_date',
];

export const SOURCE_DB_COLUMNS = [
  'source_name',
  'source_type',
  'publisher',
  'source_title',
  'country_code',
  'publication_date',
  'reference_period_start',
  'reference_period_end',
  'source_location',
  'licence_type',
  'citation_text',
  'methodology_notes',
  'quality_rating',
];
export const SOURCE_HEADER = [...SOURCE_DB_COLUMNS, 'x_retrieval_date'];

// ---------------------------------------------------------------------------------------------------
// Row -> API body. Empty string means "omit / null". Numbers are sent as numbers, booleans as booleans.
// ---------------------------------------------------------------------------------------------------
const NUMERIC_COLS = new Set(['value_numeric', 'confidence_score', 'version', 'cohort_tier', 'sample_size', 'band_tier', 'lower_bound', 'upper_bound']);
const BOOLEAN_COLS = new Set(['is_derived', 'cross_border_flag']);

export function coerceCell(col, raw) {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  if (s === '') return undefined;
  if (NUMERIC_COLS.has(col)) {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`column ${col}: "${raw}" is not a finite number`);
    return n;
  }
  if (BOOLEAN_COLS.has(col)) {
    if (/^(true|t|1|yes)$/i.test(s)) return true;
    if (/^(false|f|0|no)$/i.test(s)) return false;
    throw new Error(`column ${col}: "${raw}" is not a boolean`);
  }
  return s;
}

function pickDb(record, cols) {
  const body = {};
  for (const c of cols) {
    const v = coerceCell(c, record[c]);
    if (v !== undefined) body[c] = v;
  }
  return body;
}

/**
 * idMaps = { metricByCode, datasetByKey ('name||version'), cohortByCode, sourceByName } -> uuid strings.
 * Throws with an explicit message when a natural key cannot be resolved (never guesses).
 */
export function buildValueBody(record, idMaps) {
  const dsKey = `${record.dataset_name}||${record.dataset_version}`;
  const dataset_id = idMaps.datasetByKey[dsKey];
  if (!dataset_id) throw new Error(`unknown dataset "${record.dataset_name}" version "${record.dataset_version}"`);
  const metric_definition_id = idMaps.metricByCode[record.metric_code];
  if (!metric_definition_id) throw new Error(`unknown metric_code "${record.metric_code}"`);
  const body = { dataset_id, metric_definition_id, ...pickDb(record, VALUES_DB_COLUMNS) };
  if ((record.cohort_code ?? '').trim() !== '') {
    const cohort_id = idMaps.cohortByCode[record.cohort_code.trim()];
    if (!cohort_id) throw new Error(`unknown cohort_code "${record.cohort_code}"`);
    body.cohort_id = cohort_id;
  }
  return body;
}

export function buildCohortBody(record, idMaps) {
  const dsKey = `${record.dataset_name}||${record.dataset_version}`;
  const dataset_id = idMaps.datasetByKey[dsKey];
  if (!dataset_id) throw new Error(`unknown dataset "${record.dataset_name}" version "${record.dataset_version}"`);
  return { dataset_id, ...pickDb(record, COHORT_DB_COLUMNS) };
}

export function buildTargetRangeBody(record, idMaps) {
  const metric_definition_id = idMaps.metricByCode[record.metric_code];
  if (!metric_definition_id) throw new Error(`unknown metric_code "${record.metric_code}"`);
  const body = { metric_definition_id, ...pickDb(record, TARGET_RANGE_DB_COLUMNS) };
  if ((record.source_name ?? '').trim() !== '') {
    const benchmark_source_id = idMaps.sourceByName[record.source_name.trim()];
    if (!benchmark_source_id) throw new Error(`unknown source_name "${record.source_name}"`);
    body.benchmark_source_id = benchmark_source_id;
  }
  return body;
}

export function buildSourceBody(record) {
  return pickDb(record, SOURCE_DB_COLUMNS);
}

// ---------------------------------------------------------------------------------------------------
// Provenance register (machine-readable twin of PROVENANCE_REGISTER.md)
// ---------------------------------------------------------------------------------------------------
export const REGISTER_HEADER = [
  'dataset_no',
  'release_name',
  'release_date',
  'obs_period_start',
  'obs_period_end',
  'reference_date',
  'source_file',
  'source_url',
  'bytes',
  'sha256',
  'retrieval_date',
  'licence_statement',
  'notes',
];

/** Key a release is looked up by when a data row claims it. */
export function registerKey(r) {
  return [r.release_name, r.obs_period_start, r.obs_period_end].join('|');
}
