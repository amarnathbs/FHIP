// A0.2 Wave 1 (D-01 remediation) — pre-mutation validation and payload
// building for the Recommendations "conditions" CSV upload.
//
// This module is deliberately pure (no Supabase, no network, no I/O) so the
// full validation surface can be exercised in fast, deterministic unit tests
// without a database. The API route (app/api/admin/recommendations/upload/
// route.ts) is the only caller: it reads the raw CSV, fetches the set of
// recommendation_codes that currently exist (one cheap SELECT), calls
// validateConditionsImport(), and — only if validation is clean — calls the
// admin_import_recommendation_conditions() database function (migration
// 0107) with the built payload. Zero database writes happen from this file.
//
// Canonical replacement semantics (spec section 6), decided here because
// this is where they are enforced:
//   - The upload replaces conditions ONLY for recommendation codes that
//     appear, validly, in the uploaded file. Codes absent from the file are
//     left completely unchanged.
//   - A code may appear more than once across rows (each row is one
//     condition); all of a code's rows are grouped together and replace
//     that code's entire condition set as one unit.
//   - An empty or header-only file (rows.length === 0, guarded upstream in
//     route.ts before this module is even called) never deletes anything —
//     zero groups means zero mutations, never "clear the whole table".
//   - Making a recommendation's condition list explicitly empty (a
//     legitimate "this recommendation always fires" state) requires an
//     explicit `clear` column set to "true" on a row for that code carrying
//     no other condition data — never an implicit consequence of blank
//     fields or a code simply having no ordinary condition rows in the file
//     (that's just "absent", which means unchanged, not "clear it").

import type { ConditionOperator } from '@/lib/engines/recommendations/types';

// Single source of truth is lib/engines/recommendations/matcher.ts's
// ConditionOperator union. This local const is checked against that type at
// compile time via `satisfies` so the two can never silently drift — if the
// engine ever adds/removes an operator, this list fails to compile until
// updated, without this file importing/mutating the engine module itself.
export const ALLOWED_OPERATORS = ['equals', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_null', 'is_not_null'] as const satisfies readonly ConditionOperator[];

export const ALLOWED_DATA_TYPES = ['text', 'number', 'boolean', 'date'] as const;
export type AllowedDataType = (typeof ALLOWED_DATA_TYPES)[number];

const REQUIRED_HEADERS = ['recommendation_code', 'field_name'] as const;

// Safety limits (spec 5.1 "Maximum safe row/file limits"). Generous relative
// to the current library's real scale (2,143 conditions across ~700 codes
// at time of writing) while still bounding a single request.
export const MAX_ROWS = 5000;
export const MAX_CONDITIONS_PER_CODE = 200;
export const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MiB

export type ConditionsImportErrorCode =
  | 'FILE_TOO_LARGE'
  | 'TOO_MANY_ROWS'
  | 'MISSING_HEADER'
  | 'BLANK_REQUIRED_VALUE'
  | 'UNKNOWN_RECOMMENDATION_CODE'
  | 'INVALID_FIELD_NAME'
  | 'INVALID_OPERATOR'
  | 'INVALID_DATA_TYPE'
  | 'INVALID_LOGICAL_OPERATOR'
  | 'INVALID_CONDITION_GROUP'
  | 'INVALID_EVALUATION_ORDER'
  | 'MISSING_COMPARISON_VALUE'
  | 'INVALID_NUMBER_VALUE'
  | 'INVALID_DATE_VALUE'
  | 'INVALID_BOOLEAN_VALUE'
  | 'DUPLICATE_CONDITION'
  | 'CONFLICTING_CLEAR_ROW'
  | 'CONFLICTING_CLEAR_AND_CONDITIONS'
  | 'TOO_MANY_CONDITIONS_FOR_CODE';

export interface RowError {
  /** 1-based CSV row number, header counted as row 1 (first data row = 2). */
  row: number;
  recommendation_code: string | null;
  field: string | null;
  code: ConditionsImportErrorCode;
  message: string;
}

export interface ValidatedConditionRow {
  condition_group: number;
  field_name: string;
  operator: string;
  comparison_value: string | null;
  comparison_value_2: string | null;
  data_type: string;
  logical_operator: string;
  evaluation_order: number;
  is_active: boolean;
}

export interface ConditionsImportGroup {
  recommendation_code: string;
  /** Explicit "replace with zero conditions" instruction — see module header. */
  clear: boolean;
  conditions: ValidatedConditionRow[];
}

export interface ValidateConditionsImportResult {
  ok: boolean;
  errors: RowError[];
  groups: ConditionsImportGroup[];
  rowsReceived: number;
  rowsValidated: number;
}

function isBoolLike(v: string | undefined): boolean {
  if (v === undefined || v.trim() === '') return true; // blank is fine, defaults apply
  const t = v.trim().toLowerCase();
  return t === 'true' || t === 'false';
}

function isPositiveIntLike(v: string | undefined): boolean {
  if (v === undefined || v.trim() === '') return true; // blank is fine, default applies
  return /^\d+$/.test(v.trim()) && parseInt(v.trim(), 10) >= 1;
}

const FIELD_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

export function validateConditionsImport(rawRows: Record<string, string>[], existingCodes: ReadonlySet<string>): ValidateConditionsImportResult {
  const errors: RowError[] = [];
  const rowsReceived = rawRows.length;

  if (rowsReceived > MAX_ROWS) {
    errors.push({
      row: 1,
      recommendation_code: null,
      field: null,
      code: 'TOO_MANY_ROWS',
      message: `The file has ${rowsReceived} data rows, exceeding the maximum of ${MAX_ROWS} per upload. Split it into smaller files.`,
    });
    return { ok: false, errors, groups: [], rowsReceived, rowsValidated: 0 };
  }

  if (rowsReceived === 0) {
    // Callers should already short-circuit before this point (route.ts's
    // existing "No data rows found" guard runs first for every file type),
    // but treat it as a clean zero-group, zero-mutation result rather than
    // an error if reached directly — per section 6, empty/header-only never
    // means "delete everything".
    return { ok: true, errors: [], groups: [], rowsReceived: 0, rowsValidated: 0 };
  }

  const headerKeys = new Set(Object.keys(rawRows[0]));
  const missingHeaders = REQUIRED_HEADERS.filter((h) => !headerKeys.has(h));
  if (missingHeaders.length > 0) {
    errors.push({
      row: 1,
      recommendation_code: null,
      field: missingHeaders.join(', '),
      code: 'MISSING_HEADER',
      message: `Missing required column header(s): ${missingHeaders.join(', ')}.`,
    });
    return { ok: false, errors, groups: [], rowsReceived, rowsValidated: 0 };
  }

  // recommendation_code -> ordered rows (file order preserved for stable
  // auto-assigned evaluation_order).
  const byCode = new Map<string, { csvRow: number; raw: Record<string, string> }[]>();
  // Seen-logical-condition keys per code, for duplicate detection.
  const seenConditionKeys = new Map<string, Set<string>>();
  const rowHasError = new Set<number>();

  rawRows.forEach((r, idx) => {
    const csvRow = idx + 2; // header is physical row 1
    const code = (r.recommendation_code ?? '').trim();
    const isClear = (r.clear ?? '').trim().toLowerCase() === 'true';

    if (code === '') {
      errors.push({ row: csvRow, recommendation_code: null, field: 'recommendation_code', code: 'BLANK_REQUIRED_VALUE', message: 'recommendation_code is required and cannot be blank.' });
      rowHasError.add(csvRow);
      return;
    }
    if (!existingCodes.has(code)) {
      errors.push({ row: csvRow, recommendation_code: code, field: 'recommendation_code', code: 'UNKNOWN_RECOMMENDATION_CODE', message: `recommendation_code "${code}" does not exist in the recommendation library. Upload the Master CSV first.` });
      rowHasError.add(csvRow);
      // Still fall through to collect further errors on this row for a
      // fuller report, but this row can never become part of a group.
    }

    if (isClear) {
      if ((r.field_name ?? '').trim() !== '') {
        errors.push({
          row: csvRow,
          recommendation_code: code,
          field: 'field_name',
          code: 'CONFLICTING_CLEAR_ROW',
          message: `Row marks clear=true but also supplies field_name "${r.field_name}". A clear row must carry no condition data.`,
        });
        rowHasError.add(csvRow);
      }
    } else {
      const fieldName = (r.field_name ?? '').trim();
      if (fieldName === '') {
        errors.push({ row: csvRow, recommendation_code: code, field: 'field_name', code: 'BLANK_REQUIRED_VALUE', message: 'field_name is required for every non-clear condition row.' });
        rowHasError.add(csvRow);
      } else if (!FIELD_NAME_PATTERN.test(fieldName)) {
        errors.push({ row: csvRow, recommendation_code: code, field: 'field_name', code: 'INVALID_FIELD_NAME', message: `field_name "${fieldName}" is not a valid identifier (letters, numbers, underscore; must start with a letter).` });
        rowHasError.add(csvRow);
      }

      const operator = (r.operator ?? '').trim() || 'equals';
      if (!(ALLOWED_OPERATORS as readonly string[]).includes(operator)) {
        errors.push({ row: csvRow, recommendation_code: code, field: 'operator', code: 'INVALID_OPERATOR', message: `operator "${operator}" is not supported. Allowed: ${ALLOWED_OPERATORS.join(', ')}.` });
        rowHasError.add(csvRow);
      }

      const dataType = (r.data_type ?? '').trim() || 'text';
      if (!(ALLOWED_DATA_TYPES as readonly string[]).includes(dataType)) {
        errors.push({ row: csvRow, recommendation_code: code, field: 'data_type', code: 'INVALID_DATA_TYPE', message: `data_type "${dataType}" is not supported. Allowed: ${ALLOWED_DATA_TYPES.join(', ')}.` });
        rowHasError.add(csvRow);
      }

      const logicalOperator = (r.logical_operator ?? '').trim() || 'AND';
      if (!['AND', 'OR'].includes(logicalOperator.toUpperCase())) {
        errors.push({ row: csvRow, recommendation_code: code, field: 'logical_operator', code: 'INVALID_LOGICAL_OPERATOR', message: `logical_operator "${logicalOperator}" must be AND or OR.` });
        rowHasError.add(csvRow);
      }

      if (!isPositiveIntLike(r.condition_group)) {
        errors.push({ row: csvRow, recommendation_code: code, field: 'condition_group', code: 'INVALID_CONDITION_GROUP', message: `condition_group "${r.condition_group}" must be a positive whole number.` });
        rowHasError.add(csvRow);
      }
      if (!isPositiveIntLike(r.evaluation_order)) {
        errors.push({ row: csvRow, recommendation_code: code, field: 'evaluation_order', code: 'INVALID_EVALUATION_ORDER', message: `evaluation_order "${r.evaluation_order}" must be a positive whole number.` });
        rowHasError.add(csvRow);
      }
      if (!isBoolLike(r.is_active)) {
        errors.push({ row: csvRow, recommendation_code: code, field: 'is_active', code: 'INVALID_BOOLEAN_VALUE', message: `is_active "${r.is_active}" must be true or false.` });
        rowHasError.add(csvRow);
      }

      const requiresValue = operator !== 'is_null' && operator !== 'is_not_null';
      const comparisonValue = (r.comparison_value ?? '').trim();
      if (requiresValue && comparisonValue === '') {
        errors.push({ row: csvRow, recommendation_code: code, field: 'comparison_value', code: 'MISSING_COMPARISON_VALUE', message: `comparison_value is required for operator "${operator}".` });
        rowHasError.add(csvRow);
      } else if (requiresValue && comparisonValue !== '') {
        if (dataType === 'number' && !Number.isFinite(Number(comparisonValue))) {
          errors.push({ row: csvRow, recommendation_code: code, field: 'comparison_value', code: 'INVALID_NUMBER_VALUE', message: `comparison_value "${comparisonValue}" is not a valid number for data_type=number.` });
          rowHasError.add(csvRow);
        } else if (dataType === 'boolean' && !['true', 'false'].includes(comparisonValue.toLowerCase())) {
          errors.push({ row: csvRow, recommendation_code: code, field: 'comparison_value', code: 'INVALID_BOOLEAN_VALUE', message: `comparison_value "${comparisonValue}" must be true or false for data_type=boolean.` });
          rowHasError.add(csvRow);
        } else if (dataType === 'date' && Number.isNaN(Date.parse(comparisonValue))) {
          errors.push({ row: csvRow, recommendation_code: code, field: 'comparison_value', code: 'INVALID_DATE_VALUE', message: `comparison_value "${comparisonValue}" is not a valid date for data_type=date.` });
          rowHasError.add(csvRow);
        }
      }

      // Duplicate logical condition: same code+group+field+operator+value(s).
      const dupKey = [code, r.condition_group ?? '1', fieldName, operator, comparisonValue, (r.comparison_value_2 ?? '').trim()].join('');
      const seen = seenConditionKeys.get(code) ?? new Set<string>();
      if (seen.has(dupKey)) {
        errors.push({ row: csvRow, recommendation_code: code, field: null, code: 'DUPLICATE_CONDITION', message: 'This condition (same field, operator and value, in the same group) is already present earlier in the file for this recommendation.' });
        rowHasError.add(csvRow);
      }
      seen.add(dupKey);
      seenConditionKeys.set(code, seen);
    }

    const list = byCode.get(code) ?? [];
    list.push({ csvRow, raw: r });
    byCode.set(code, list);
  });

  // Per-code cross-row checks: clear+conditions conflict, too-many-conditions.
  for (const [code, rows] of byCode) {
    const clearRows = rows.filter((x) => (x.raw.clear ?? '').trim().toLowerCase() === 'true');
    const conditionRows = rows.filter((x) => (x.raw.clear ?? '').trim().toLowerCase() !== 'true');
    if (clearRows.length > 0 && conditionRows.length > 0) {
      for (const x of rows) {
        errors.push({ row: x.csvRow, recommendation_code: code, field: null, code: 'CONFLICTING_CLEAR_AND_CONDITIONS', message: `Recommendation "${code}" has both a clear=true row and ordinary condition row(s) — ambiguous. Use one or the other, not both, in the same upload.` });
        rowHasError.add(x.csvRow);
      }
    }
    if (conditionRows.length > MAX_CONDITIONS_PER_CODE) {
      errors.push({ row: rows[0].csvRow, recommendation_code: code, field: null, code: 'TOO_MANY_CONDITIONS_FOR_CODE', message: `Recommendation "${code}" has ${conditionRows.length} condition rows, exceeding the maximum of ${MAX_CONDITIONS_PER_CODE}.` });
    }
  }

  const rowsValidated = rowsReceived - rowHasError.size;

  if (errors.length > 0) {
    return { ok: false, errors, groups: [], rowsReceived, rowsValidated };
  }

  // Build groups, auto-assigning evaluation_order sequentially per code
  // (in file order) whenever the CSV left it blank — the matcher sorts
  // globally by evaluation_order per recommendation_code, so a stable,
  // deterministic default must span the whole code, not just one group.
  const groups: ConditionsImportGroup[] = [];
  for (const [code, rows] of byCode) {
    const isClear = rows.length === 1 && (rows[0].raw.clear ?? '').trim().toLowerCase() === 'true';
    if (isClear) {
      groups.push({ recommendation_code: code, clear: true, conditions: [] });
      continue;
    }
    let autoOrder = 1;
    const conditions: ValidatedConditionRow[] = rows.map(({ raw: r }) => {
      const evaluationOrder = (r.evaluation_order ?? '').trim() === '' ? autoOrder++ : parseInt(r.evaluation_order.trim(), 10);
      return {
        condition_group: (r.condition_group ?? '').trim() === '' ? 1 : parseInt(r.condition_group.trim(), 10),
        field_name: r.field_name.trim(),
        operator: (r.operator ?? '').trim() || 'equals',
        comparison_value: (r.comparison_value ?? '').trim() === '' ? null : r.comparison_value.trim(),
        comparison_value_2: (r.comparison_value_2 ?? '').trim() === '' ? null : r.comparison_value_2.trim(),
        data_type: (r.data_type ?? '').trim() || 'text',
        logical_operator: ((r.logical_operator ?? '').trim() || 'AND').toUpperCase(),
        evaluation_order: evaluationOrder,
        is_active: (r.is_active ?? '').trim() === '' ? true : (r.is_active ?? '').trim().toLowerCase() === 'true',
      };
    });
    groups.push({ recommendation_code: code, clear: false, conditions });
  }

  return { ok: true, errors: [], groups, rowsReceived, rowsValidated };
}

// Small helper the API route uses so the request payload shape sent to the
// database function (migration 0107) is built in exactly one place.
export function buildImportPayload(groups: ConditionsImportGroup[]): { groups: ConditionsImportGroup[] } {
  return { groups };
}
