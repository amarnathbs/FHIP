// A0.2 Wave 1B — pre-mutation validation for the single-recommendation
// create/update path (app/api/admin/recommendations/route.ts's POST and
// app/api/admin/recommendations/[id]/route.ts's PATCH).
//
// Deliberately pure (no Supabase, no I/O), same design principle as
// lib/services/recommendationsConditionsImport.ts (Wave 1's CSV validator),
// and DELIBERATELY REUSES that file's operator/data-type allow-lists and
// per-code condition limit rather than redefining them — those two modules
// must never silently disagree about what a valid condition looks like.
//
// The condition-row shape validated here is intentionally identical to Wave
// 1's (condition_group/field_name/operator/comparison_value/
// comparison_value_2/data_type/logical_operator/evaluation_order/is_active),
// because both validated shapes feed the SAME underlying
// action_recommendation_conditions row shape — see migration 0109's
// admin_upsert_recommendation_atomic(), whose conditions-array insert is
// written to stay structurally identical to migration 0107's
// admin_import_recommendation_conditions() insert for exactly this reason.
//
// Explicit-clear semantics mirror Wave 1's CSV mechanism exactly (spec
// section 6, carried into Wave 1B item 4): a recommendation is never left
// with zero conditions as a side effect of an edit — either the caller does
// not touch conditions at all (`conditions` omitted/undefined — existing
// conditions untouched), or supplies a non-empty array (replace), or
// explicitly passes `clearConditions: true` with an empty array (replace
// with genuinely zero, an intentional act). An empty array WITHOUT
// clearConditions=true is rejected outright.
//
// IMPORTANT — the invariant this whole module exists to protect:
// A recommendation record with `is_active=true`, zero conditions, and
// `matches_unconditionally=false` is what migration 0109's two deferred
// database triggers refuse to allow to ever commit. This module's job is to
// produce a GOOD error message for the common, avoidable ways of getting
// there (an explicit clear on an active, non-unconditional recommendation);
// the database triggers are the actual, unavoidable backstop — see
// migration 0109's header for the full write-up of
// "a recommendation with zero conditions matches every user unconditionally".

import { ALLOWED_OPERATORS, ALLOWED_DATA_TYPES, MAX_CONDITIONS_PER_CODE, type ConditionsImportErrorCode, type ValidatedConditionRow } from '@/lib/services/recommendationsConditionsImport';

export type { ConditionsImportErrorCode };

export interface EditRowError {
  /** 1-based index into the submitted conditions array (not a CSV row). */
  index: number;
  field: string | null;
  code: ConditionsImportErrorCode | 'CONFLICTING_CLEAR_ACTIVE_UNCONDITIONAL';
  message: string;
}

export interface RawEditConditionInput {
  condition_group?: number | string;
  field_name?: string;
  operator?: string;
  comparison_value?: string | null;
  comparison_value_2?: string | null;
  data_type?: string;
  logical_operator?: string;
  evaluation_order?: number | string;
  is_active?: boolean | string;
}

export interface ValidateEditConditionsResult {
  ok: boolean;
  errors: EditRowError[];
  /** undefined = conditions were not supplied at all (leave untouched). */
  conditions?: ValidatedConditionRow[];
}

function toStr(v: unknown): string {
  return v === undefined || v === null ? '' : String(v).trim();
}

function isPositiveIntLike(v: unknown): boolean {
  const s = toStr(v);
  if (s === '') return true;
  return /^\d+$/.test(s) && parseInt(s, 10) >= 1;
}

const FIELD_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/**
 * Validates one recommendation's condition array for the single-record edit
 * path. `rawConditions === undefined` means "the caller did not touch
 * conditions" — returns `{ok:true, conditions: undefined}`, a distinct state
 * from "replace with an explicit empty set".
 */
export function validateEditConditions(rawConditions: RawEditConditionInput[] | undefined, options: { clearConditions?: boolean } = {}): ValidateEditConditionsResult {
  if (rawConditions === undefined) {
    return { ok: true, errors: [] };
  }
  if (!Array.isArray(rawConditions)) {
    return { ok: false, errors: [{ index: 0, field: null, code: 'MISSING_COMPARISON_VALUE', message: 'conditions must be an array.' }] };
  }

  if (rawConditions.length === 0) {
    if (!options.clearConditions) {
      return {
        ok: false,
        errors: [
          {
            index: 0,
            field: null,
            code: 'CONFLICTING_CLEAR_ACTIVE_UNCONDITIONAL',
            message: 'Saving with zero conditions requires explicitly confirming "leave this recommendation with no conditions" — refusing to guess.',
          },
        ],
      };
    }
    return { ok: true, errors: [], conditions: [] };
  }

  if (rawConditions.length > MAX_CONDITIONS_PER_CODE) {
    return {
      ok: false,
      errors: [{ index: 0, field: null, code: 'TOO_MANY_CONDITIONS_FOR_CODE', message: `${rawConditions.length} conditions exceeds the maximum of ${MAX_CONDITIONS_PER_CODE}.` }],
    };
  }

  const errors: EditRowError[] = [];
  const seen = new Set<string>();
  let autoOrder = 1;
  const conditions: ValidatedConditionRow[] = [];

  rawConditions.forEach((raw, i) => {
    const index = i + 1;
    let rowOk = true;

    const fieldName = toStr(raw.field_name);
    if (fieldName === '') {
      errors.push({ index, field: 'field_name', code: 'BLANK_REQUIRED_VALUE', message: 'field_name is required.' });
      rowOk = false;
    } else if (!FIELD_NAME_PATTERN.test(fieldName)) {
      errors.push({ index, field: 'field_name', code: 'INVALID_FIELD_NAME', message: `field_name "${fieldName}" is not a valid identifier.` });
      rowOk = false;
    }

    const operator = toStr(raw.operator) || 'equals';
    if (!(ALLOWED_OPERATORS as readonly string[]).includes(operator)) {
      errors.push({ index, field: 'operator', code: 'INVALID_OPERATOR', message: `operator "${operator}" is not supported. Allowed: ${ALLOWED_OPERATORS.join(', ')}.` });
      rowOk = false;
    }

    const dataType = toStr(raw.data_type) || 'text';
    if (!(ALLOWED_DATA_TYPES as readonly string[]).includes(dataType)) {
      errors.push({ index, field: 'data_type', code: 'INVALID_DATA_TYPE', message: `data_type "${dataType}" is not supported. Allowed: ${ALLOWED_DATA_TYPES.join(', ')}.` });
      rowOk = false;
    }

    const logicalOperator = toStr(raw.logical_operator) || 'AND';
    if (!['AND', 'OR'].includes(logicalOperator.toUpperCase())) {
      errors.push({ index, field: 'logical_operator', code: 'INVALID_LOGICAL_OPERATOR', message: `logical_operator "${logicalOperator}" must be AND or OR.` });
      rowOk = false;
    }

    if (!isPositiveIntLike(raw.condition_group)) {
      errors.push({ index, field: 'condition_group', code: 'INVALID_CONDITION_GROUP', message: 'condition_group must be a positive whole number.' });
      rowOk = false;
    }
    if (!isPositiveIntLike(raw.evaluation_order)) {
      errors.push({ index, field: 'evaluation_order', code: 'INVALID_EVALUATION_ORDER', message: 'evaluation_order must be a positive whole number.' });
      rowOk = false;
    }

    const requiresValue = operator !== 'is_null' && operator !== 'is_not_null';
    const comparisonValue = toStr(raw.comparison_value);
    if (requiresValue && comparisonValue === '') {
      errors.push({ index, field: 'comparison_value', code: 'MISSING_COMPARISON_VALUE', message: `comparison_value is required for operator "${operator}".` });
      rowOk = false;
    } else if (requiresValue && comparisonValue !== '') {
      if (dataType === 'number' && !Number.isFinite(Number(comparisonValue))) {
        errors.push({ index, field: 'comparison_value', code: 'INVALID_NUMBER_VALUE', message: `"${comparisonValue}" is not a valid number for data_type=number.` });
        rowOk = false;
      } else if (dataType === 'boolean' && !['true', 'false'].includes(comparisonValue.toLowerCase())) {
        errors.push({ index, field: 'comparison_value', code: 'INVALID_BOOLEAN_VALUE', message: `"${comparisonValue}" must be true or false for data_type=boolean.` });
        rowOk = false;
      } else if (dataType === 'date' && Number.isNaN(Date.parse(comparisonValue))) {
        errors.push({ index, field: 'comparison_value', code: 'INVALID_DATE_VALUE', message: `"${comparisonValue}" is not a valid date for data_type=date.` });
        rowOk = false;
      }
    }

    const conditionGroup = toStr(raw.condition_group) === '' ? 1 : parseInt(toStr(raw.condition_group), 10);
    const dupKey = [conditionGroup, fieldName, operator, comparisonValue, toStr(raw.comparison_value_2)].join('');
    if (seen.has(dupKey)) {
      errors.push({ index, field: null, code: 'DUPLICATE_CONDITION', message: 'This condition (same field, operator, value and group) is already present earlier in this list.' });
      rowOk = false;
    }
    seen.add(dupKey);

    if (rowOk) {
      const evaluationOrder = toStr(raw.evaluation_order) === '' ? autoOrder++ : parseInt(toStr(raw.evaluation_order), 10);
      conditions.push({
        condition_group: conditionGroup,
        field_name: fieldName,
        operator,
        comparison_value: comparisonValue === '' ? null : comparisonValue,
        comparison_value_2: toStr(raw.comparison_value_2) === '' ? null : toStr(raw.comparison_value_2),
        data_type: dataType,
        logical_operator: logicalOperator.toUpperCase(),
        evaluation_order: evaluationOrder,
        is_active: raw.is_active === undefined || raw.is_active === '' ? true : raw.is_active === true || toStr(raw.is_active).toLowerCase() === 'true',
      });
    }
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, errors: [], conditions };
}

// A pre-emptive, friendlier check ahead of the database triggers (migration
// 0109) — same invariant, better error message when it's cheaply detectable
// from the request alone. The triggers remain the actual, unavoidable
// authority (see this module's header) — this is purely a UX nicety, never
// the only thing standing between a bad request and the invariant.
export function checkActiveUnconditionalRisk(args: { isActive: boolean; matchesUnconditionally: boolean; finalConditionCount: number | null }): EditRowError | null {
  if (args.finalConditionCount === null) return null; // conditions untouched — can't tell from this request alone; trigger is authoritative
  if (args.isActive && !args.matchesUnconditionally && args.finalConditionCount === 0) {
    return {
      index: 0,
      field: 'matches_unconditionally',
      code: 'CONFLICTING_CLEAR_ACTIVE_UNCONDITIONAL',
      message: 'This would leave an ACTIVE recommendation with zero conditions, which matches every user unconditionally. Set "matches unconditionally" explicitly if that is intended, add at least one condition, or leave it inactive.',
    };
  }
  return null;
}
