import { describe, it, expect } from 'vitest';
import { ageFromDob, isPlausibleDob, MIN_PLAUSIBLE_AGE, MAX_PLAUSIBLE_AGE, MIN_PLAUSIBLE_DEPENDANT_AGE, MAX_PLAUSIBLE_DEPENDANT_AGE } from '@/lib/engines/age';

const ASOF = new Date('2026-08-06T00:00:00Z');

describe('ageFromDob', () => {
  it('returns null for a missing DOB', () => {
    expect(ageFromDob(null, ASOF)).toBeNull();
  });

  it('computes age correctly when the birthday has already passed this year', () => {
    expect(ageFromDob('1990-01-01', ASOF)).toBe(36);
  });

  it('computes age correctly when the birthday has not yet occurred this year', () => {
    expect(ageFromDob('1990-12-31', ASOF)).toBe(35);
  });

  it('computes age correctly on the exact birthday', () => {
    expect(ageFromDob('1990-08-06', ASOF)).toBe(36);
  });
});

describe('isPlausibleDob', () => {
  it('accepts a null DOB (nothing to reject)', () => {
    expect(isPlausibleDob(null, ASOF)).toBe(true);
  });

  it('rejects an unparseable date string', () => {
    expect(isPlausibleDob('not-a-date', ASOF)).toBe(false);
  });

  it('rejects a DOB implying an age below the adult minimum', () => {
    expect(isPlausibleDob('2024-01-01', ASOF)).toBe(false); // ~2 years old
  });

  it('rejects a DOB implying an age above the adult maximum', () => {
    expect(isPlausibleDob('1900-01-01', ASOF)).toBe(false); // ~126 years old
  });

  it('accepts a DOB at the adult minimum boundary', () => {
    const dob = new Date(ASOF);
    dob.setFullYear(dob.getFullYear() - MIN_PLAUSIBLE_AGE);
    expect(isPlausibleDob(dob.toISOString().slice(0, 10), ASOF)).toBe(true);
  });

  it('accepts a DOB at the adult maximum boundary', () => {
    const dob = new Date(ASOF);
    dob.setFullYear(dob.getFullYear() - MAX_PLAUSIBLE_AGE);
    expect(isPlausibleDob(dob.toISOString().slice(0, 10), ASOF)).toBe(true);
  });

  it('accepts a very young age for a household member/dependant using wider bounds', () => {
    expect(isPlausibleDob('2025-06-01', ASOF, MIN_PLAUSIBLE_DEPENDANT_AGE, MAX_PLAUSIBLE_DEPENDANT_AGE)).toBe(true);
  });

  it('still rejects an implausibly old dependant DOB (data-entry error) under wider bounds', () => {
    expect(isPlausibleDob('1850-01-01', ASOF, MIN_PLAUSIBLE_DEPENDANT_AGE, MAX_PLAUSIBLE_DEPENDANT_AGE)).toBe(false);
  });
});
