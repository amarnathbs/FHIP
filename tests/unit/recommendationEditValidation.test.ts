// A0.2 Wave 1B — validateEditConditions() unit tests. Pure function, no
// database. Mirrors tests/unit/recommendationsConditionsImportValidation.test.ts's
// coverage style for the single-record create/update path.
import { describe, it, expect } from 'vitest';
import { validateEditConditions, checkActiveUnconditionalRisk } from '@/lib/services/recommendationEditValidation';

describe('validateEditConditions — conditions omitted entirely', () => {
  it('undefined means "leave untouched" — ok, no conditions array returned', () => {
    const res = validateEditConditions(undefined);
    expect(res).toEqual({ ok: true, errors: [] });
    expect(res.conditions).toBeUndefined();
  });
});

describe('validateEditConditions — successful validation', () => {
  it('accepts a single valid condition', () => {
    const res = validateEditConditions([{ field_name: 'forecast_category', operator: 'equals', comparison_value: 'debt' }]);
    expect(res.ok).toBe(true);
    expect(res.conditions).toHaveLength(1);
    expect(res.conditions?.[0]).toMatchObject({ field_name: 'forecast_category', operator: 'equals', comparison_value: 'debt' });
  });

  it('auto-assigns sequential evaluation_order across the array when blank', () => {
    const res = validateEditConditions([
      { field_name: 'a', operator: 'equals', comparison_value: '1' },
      { field_name: 'b', operator: 'equals', comparison_value: '2' },
    ]);
    expect(res.ok).toBe(true);
    expect(res.conditions?.map((c) => c.evaluation_order)).toEqual([1, 2]);
  });

  it('an empty array WITH clearConditions:true is accepted, returning an empty conditions array (not undefined)', () => {
    const res = validateEditConditions([], { clearConditions: true });
    expect(res).toEqual({ ok: true, errors: [], conditions: [] });
  });
});

describe('validateEditConditions — validation failures (zero mutation signalled via ok:false)', () => {
  it('rejects an empty array WITHOUT clearConditions:true', () => {
    const res = validateEditConditions([]);
    expect(res.ok).toBe(false);
    expect(res.conditions).toBeUndefined();
    expect(res.errors[0].code).toBe('CONFLICTING_CLEAR_ACTIVE_UNCONDITIONAL');
  });

  it('rejects a blank field_name', () => {
    const res = validateEditConditions([{ field_name: '', operator: 'equals', comparison_value: '1' }]);
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual(expect.objectContaining({ index: 1, code: 'BLANK_REQUIRED_VALUE' }));
  });

  it('rejects an invalid operator', () => {
    const res = validateEditConditions([{ field_name: 'x', operator: 'bogus', comparison_value: '1' }]);
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual(expect.objectContaining({ code: 'INVALID_OPERATOR' }));
  });

  it('rejects an invalid numeric value', () => {
    const res = validateEditConditions([{ field_name: 'x', operator: 'equals', comparison_value: 'nope', data_type: 'number' }]);
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual(expect.objectContaining({ code: 'INVALID_NUMBER_VALUE' }));
  });

  it('rejects a duplicate condition (same group/field/operator/value)', () => {
    const dup = { field_name: 'x', operator: 'equals', comparison_value: '1' };
    const res = validateEditConditions([dup, dup]);
    expect(res.ok).toBe(false);
    expect(res.errors).toContainEqual(expect.objectContaining({ index: 2, code: 'DUPLICATE_CONDITION' }));
  });

  it('is_null/is_not_null do not require comparison_value', () => {
    const res = validateEditConditions([{ field_name: 'x', operator: 'is_null' }]);
    expect(res.ok).toBe(true);
  });

  it('rejects more than the maximum conditions', () => {
    const many = Array.from({ length: 201 }, (_, i) => ({ field_name: `f${i}`, operator: 'equals', comparison_value: '1' }));
    const res = validateEditConditions(many);
    expect(res.ok).toBe(false);
    expect(res.errors[0].code).toBe('TOO_MANY_CONDITIONS_FOR_CODE');
  });
});

describe('checkActiveUnconditionalRisk — pre-emptive UX check (DB triggers remain authoritative)', () => {
  it('flags active + non-unconditional + zero final conditions', () => {
    const result = checkActiveUnconditionalRisk({ isActive: true, matchesUnconditionally: false, finalConditionCount: 0 });
    expect(result?.code).toBe('CONFLICTING_CLEAR_ACTIVE_UNCONDITIONAL');
  });

  it('does not flag when matches_unconditionally is true', () => {
    expect(checkActiveUnconditionalRisk({ isActive: true, matchesUnconditionally: true, finalConditionCount: 0 })).toBeNull();
  });

  it('does not flag when inactive', () => {
    expect(checkActiveUnconditionalRisk({ isActive: false, matchesUnconditionally: false, finalConditionCount: 0 })).toBeNull();
  });

  it('does not flag when the final condition count is unknown (conditions untouched by this request)', () => {
    expect(checkActiveUnconditionalRisk({ isActive: true, matchesUnconditionally: false, finalConditionCount: null })).toBeNull();
  });

  it('does not flag when there is at least one condition', () => {
    expect(checkActiveUnconditionalRisk({ isActive: true, matchesUnconditionally: false, finalConditionCount: 2 })).toBeNull();
  });
});
