// A0.2 Wave 1 (D-01 remediation) — validateConditionsImport() unit tests.
// Pure function, no database/network — fast, deterministic coverage of
// spec sections 10.2 (successful import shaping) and 10.3 (validation
// failures). Transactional/rollback proof (10.1, 10.4) and security (10.5)
// live in scripts/admin_a02_wave1_certification.mjs (real PGlite Postgres),
// since those require an actual database engine to be meaningful.
import { describe, it, expect } from 'vitest';
import { validateConditionsImport, MAX_ROWS } from '@/lib/services/recommendationsConditionsImport';

const CODES = new Set(['REC_A', 'REC_B']);

function row(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    recommendation_code: 'REC_A',
    condition_group: '1',
    field_name: 'forecast_category',
    operator: 'equals',
    comparison_value: 'debt',
    comparison_value_2: '',
    data_type: 'text',
    logical_operator: 'AND',
    evaluation_order: '1',
    is_active: 'true',
    clear: '',
    ...overrides,
  };
}

describe('validateConditionsImport — successful imports (10.2)', () => {
  it('accepts one recommendation with one condition', () => {
    const res = validateConditionsImport([row()], CODES);
    expect(res.ok).toBe(true);
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({ recommendation_code: 'REC_A', clear: false });
    expect(res.groups[0].conditions).toHaveLength(1);
    expect(res.rowsValidated).toBe(1);
  });

  it('accepts multiple recommendations, each with multiple conditions, and groups them independently', () => {
    const rows = [
      row({ field_name: 'forecast_category', evaluation_order: '1' }),
      row({ field_name: 'forecast_status', comparison_value: 'at_risk', evaluation_order: '2' }),
      row({ recommendation_code: 'REC_B', field_name: 'variance_result', comparison_value: 'unfavourable', evaluation_order: '1' }),
    ];
    const res = validateConditionsImport(rows, CODES);
    expect(res.ok).toBe(true);
    expect(res.groups).toHaveLength(2);
    const a = res.groups.find((g) => g.recommendation_code === 'REC_A')!;
    const b = res.groups.find((g) => g.recommendation_code === 'REC_B')!;
    expect(a.conditions).toHaveLength(2);
    expect(b.conditions).toHaveLength(1);
  });

  it('auto-assigns sequential evaluation_order per code, in file order, when left blank', () => {
    const rows = [
      row({ field_name: 'field_one', evaluation_order: '' }),
      row({ field_name: 'field_two', evaluation_order: '' }),
      row({ field_name: 'field_three', evaluation_order: '' }),
    ];
    const res = validateConditionsImport(rows, CODES);
    expect(res.ok).toBe(true);
    expect(res.groups[0].conditions.map((c) => c.evaluation_order)).toEqual([1, 2, 3]);
  });

  it('a recommendation_code absent from the file produces no group at all (left unchanged)', () => {
    const res = validateConditionsImport([row({ recommendation_code: 'REC_A' })], CODES);
    expect(res.ok).toBe(true);
    expect(res.groups.map((g) => g.recommendation_code)).toEqual(['REC_A']);
    expect(res.groups.find((g) => g.recommendation_code === 'REC_B')).toBeUndefined();
  });

  it('supports an explicit clear=true row with no condition data', () => {
    const res = validateConditionsImport([row({ clear: 'true', field_name: '', operator: '', comparison_value: '', condition_group: '', evaluation_order: '' })], CODES);
    expect(res.ok).toBe(true);
    expect(res.groups).toEqual([{ recommendation_code: 'REC_A', clear: true, conditions: [] }]);
  });

  it('a valid repeated import produces the identical deterministic group shape both times', () => {
    const rows = [row({ field_name: 'forecast_category' }), row({ field_name: 'forecast_status', comparison_value: 'at_risk', evaluation_order: '2' })];
    const first = validateConditionsImport(rows, CODES);
    const second = validateConditionsImport(rows, CODES);
    expect(first.groups).toEqual(second.groups);
  });

  it('an empty file (zero rows) is a clean zero-group, zero-mutation success, never a delete-everything signal', () => {
    const res = validateConditionsImport([], CODES);
    expect(res).toEqual({ ok: true, errors: [], groups: [], rowsReceived: 0, rowsValidated: 0 });
  });
});

describe('validateConditionsImport — validation failures (10.3): zero mutation, row identified', () => {
  it('rejects a file with a missing required header', () => {
    const res = validateConditionsImport([{ recommendation_code: 'REC_A' /* no field_name header at all */ }], CODES);
    expect(res.ok).toBe(false);
    expect(res.groups).toEqual([]);
    expect(res.errors[0].code).toBe('MISSING_HEADER');
  });

  it('rejects an unknown recommendation_code and identifies the row', () => {
    const res = validateConditionsImport([row({ recommendation_code: 'NOT_A_REAL_CODE' })], CODES);
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual(expect.objectContaining({ row: 2, code: 'UNKNOWN_RECOMMENDATION_CODE', recommendation_code: 'NOT_A_REAL_CODE' }));
    expect(res.groups).toEqual([]);
  });

  it('rejects an invalid operator', () => {
    const res = validateConditionsImport([row({ operator: 'not_a_real_operator' })], CODES);
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual(expect.objectContaining({ code: 'INVALID_OPERATOR', field: 'operator' }));
  });

  it('rejects an invalid value type (non-numeric value for data_type=number)', () => {
    const res = validateConditionsImport([row({ data_type: 'number', comparison_value: 'not-a-number' })], CODES);
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual(expect.objectContaining({ code: 'INVALID_NUMBER_VALUE' }));
  });

  it('rejects an invalid boolean value for data_type=boolean', () => {
    const res = validateConditionsImport([row({ data_type: 'boolean', comparison_value: 'maybe' })], CODES);
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual(expect.objectContaining({ code: 'INVALID_BOOLEAN_VALUE' }));
  });

  it('rejects an invalid date value for data_type=date', () => {
    const res = validateConditionsImport([row({ data_type: 'date', comparison_value: 'not-a-date' })], CODES);
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual(expect.objectContaining({ code: 'INVALID_DATE_VALUE' }));
  });

  it('rejects a blank required value (field_name)', () => {
    const res = validateConditionsImport([row({ field_name: '' })], CODES);
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual(expect.objectContaining({ code: 'BLANK_REQUIRED_VALUE', field: 'field_name' }));
  });

  it('rejects a duplicate logical condition (same code+group+field+operator+value repeated)', () => {
    const res = validateConditionsImport([row(), row()], CODES);
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual(expect.objectContaining({ row: 3, code: 'DUPLICATE_CONDITION' }));
  });

  it('rejects a malformed row (missing trailing columns collapse to a blank required field)', () => {
    // Simulates a short CSV row: parseCsv() still assigns every header key,
    // but trailing ones the row didn't supply come through as ''.
    const res = validateConditionsImport([row({ field_name: '', operator: '', comparison_value: '' })], CODES);
    expect(res.ok).toBe(false);
    expect(res.groups).toEqual([]);
  });

  it('rejects an excessively large file', () => {
    const rows = Array.from({ length: MAX_ROWS + 1 }, () => row());
    const res = validateConditionsImport(rows, CODES);
    expect(res.ok).toBe(false);
    expect(res.errors[0].code).toBe('TOO_MANY_ROWS');
  });

  it('rejects mixed valid and invalid rows, keeping the valid row identified separately from the invalid one', () => {
    const rows = [row({ field_name: 'good_field' }), row({ field_name: '', operator: 'still_bad' })];
    const res = validateConditionsImport(rows, CODES);
    expect(res.ok).toBe(false);
    expect(res.groups).toEqual([]); // zero mutation — the whole file is rejected, not just the bad row
    expect(res.errors.some((e) => e.row === 3)).toBe(true);
  });

  it('rejects a clear=true row that also supplies field_name (conflicting instruction)', () => {
    const res = validateConditionsImport([row({ clear: 'true' })], CODES); // row() already sets field_name
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual(expect.objectContaining({ code: 'CONFLICTING_CLEAR_ROW' }));
  });

  it('rejects a code with both a clear=true row and ordinary condition rows', () => {
    const rows = [row({ clear: 'true', field_name: '', operator: '', comparison_value: '' }), row({ field_name: 'other_field', evaluation_order: '2' })];
    const res = validateConditionsImport(rows, CODES);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'CONFLICTING_CLEAR_AND_CONDITIONS')).toBe(true);
  });

  it('never returns a nonzero group count when validation fails, for any failure case', () => {
    const cases = [
      [row({ operator: 'bogus' })],
      [row({ recommendation_code: 'UNKNOWN' })],
      [row({ field_name: '' })],
      [row(), row()],
    ];
    for (const rows of cases) {
      const res = validateConditionsImport(rows, CODES);
      expect(res.ok).toBe(false);
      expect(res.groups).toHaveLength(0);
    }
  });
});
