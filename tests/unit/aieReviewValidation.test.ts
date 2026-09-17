import { describe, it, expect } from 'vitest';
import { validateCorrection, findCorrectableFieldSpec } from '@/lib/aie/review/validation';
import type { AieCorrectableFieldSpec } from '@/lib/aie/review/types';

describe('AIE-1.5 validation.ts — typed correction validation (VALID-01/05/06, ACT-09)', () => {
  it('rejects an empty value for every field type', () => {
    const spec: AieCorrectableFieldSpec = { fieldName: 'policyName', label: 'Policy name', type: 'string' };
    expect(validateCorrection(spec, '   ')).toEqual({ ok: false, reason: 'malformed_value' });
  });

  describe('string', () => {
    it('accepts a plain trimmed string', () => {
      expect(validateCorrection({ fieldName: 'x', label: 'X', type: 'string' }, '  Acme Life Policy  ')).toEqual({ ok: true, normalized: 'Acme Life Policy' });
    });
    it('rejects a value over 200 characters (VALID-05 bound)', () => {
      expect(validateCorrection({ fieldName: 'x', label: 'X', type: 'string' }, 'a'.repeat(201))).toEqual({ ok: false, reason: 'out_of_range' });
    });
  });

  describe('enum', () => {
    const spec: AieCorrectableFieldSpec = { fieldName: 'currencyCode', label: 'Currency', type: 'enum', enumValues: ['AUD', 'INR'] };
    it('accepts a matching value case-insensitively, normalized to the canonical case', () => {
      expect(validateCorrection(spec, 'aud')).toEqual({ ok: true, normalized: 'AUD' });
    });
    it('rejects an unsupported enum value (VALID-05: "unsupported currency")', () => {
      expect(validateCorrection(spec, 'USD')).toEqual({ ok: false, reason: 'unsupported_enum_value' });
    });
  });

  describe('number', () => {
    const spec: AieCorrectableFieldSpec = { fieldName: 'premium', label: 'Premium', type: 'number', min: 0 };
    it('accepts a plain decimal', () => {
      expect(validateCorrection(spec, '1234.56')).toEqual({ ok: true, normalized: '1234.56' });
    });
    it('rejects scientific notation (VALID-05)', () => {
      expect(validateCorrection(spec, '1.2e3')).toEqual({ ok: false, reason: 'malformed_value' });
    });
    it('rejects NaN/non-numeric input', () => {
      expect(validateCorrection(spec, 'not-a-number')).toEqual({ ok: false, reason: 'malformed_value' });
    });
    it('rejects a value below the declared minimum (VALID-05: overflow/bounds)', () => {
      expect(validateCorrection(spec, '-50')).toEqual({ ok: false, reason: 'out_of_range' });
    });
    it('rejects a value above a declared maximum when one is set', () => {
      expect(validateCorrection({ ...spec, max: 100 }, '150')).toEqual({ ok: false, reason: 'out_of_range' });
    });
  });

  describe('date', () => {
    const spec: AieCorrectableFieldSpec = { fieldName: 'renewalDate', label: 'Renewal date', type: 'date' };
    it('accepts a valid ISO date', () => {
      expect(validateCorrection(spec, '2027-03-15')).toEqual({ ok: true, normalized: '2027-03-15' });
    });
    it('rejects a malformed date (VALID-05: "malformed dates")', () => {
      expect(validateCorrection(spec, '15/03/2027')).toEqual({ ok: false, reason: 'malformed_value' });
    });
    it('rejects a calendar-invalid date (e.g. 30 February) even though it matches the YYYY-MM-DD shape', () => {
      expect(validateCorrection(spec, '2027-02-30')).toEqual({ ok: false, reason: 'malformed_value' });
    });
  });

  describe('findCorrectableFieldSpec (ACT-09 — no arbitrary field/value mass assignment)', () => {
    const fields: AieCorrectableFieldSpec[] = [
      { fieldName: 'premium', label: 'Premium', type: 'number' },
      { fieldName: 'premiumFrequency', label: 'Frequency', type: 'enum', enumValues: ['monthly', 'annually'] },
    ];
    it('finds a declared field by name', () => {
      expect(findCorrectableFieldSpec(fields, 'premium')?.fieldName).toBe('premium');
    });
    it('returns null for a field NOT in the allowlist — the mass-assignment guard', () => {
      expect(findCorrectableFieldSpec(fields, 'owner')).toBeNull();
      expect(findCorrectableFieldSpec(fields, '__proto__')).toBeNull();
    });
    it('returns null when no fields are declared at all', () => {
      expect(findCorrectableFieldSpec(undefined, 'premium')).toBeNull();
    });
  });
});
