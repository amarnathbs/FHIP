import { describe, it, expect } from 'vitest';
import {
  DATE_INPUT_PLACEHOLDER,
  DATE_INPUT_HINT,
  DATE_INPUT_MIN_YEAR,
  DATE_INPUT_MAX_YEAR,
  parseDateInput,
  isDateInput,
  formatDateInput,
} from '@/lib/engines/dateInput';
import { formatDateShort } from '@/lib/engines/date';

describe('parseDateInput', () => {
  it('reads DD-MM-YYYY into ISO', () => {
    expect(parseDateInput('01-10-2026')).toBe('2026-10-01');
    expect(parseDateInput('31-12-2025')).toBe('2025-12-31');
  });

  it('tolerates / and . as the separator', () => {
    expect(parseDateInput('01/10/2026')).toBe('2026-10-01');
    expect(parseDateInput('01.10.2026')).toBe('2026-10-01');
  });

  it('tolerates surrounding spaces and one-digit day or month', () => {
    expect(parseDateInput('  1-2-2026 ')).toBe('2026-02-01');
    expect(parseDateInput('9/9/2024')).toBe('2024-09-09');
  });

  it('treats the first number as the DAY: 03-04-2024 is 3 April, never 4 March', () => {
    expect(parseDateInput('03-04-2024')).toBe('2024-04-03');
    expect(parseDateInput('13-01-2024')).toBe('2024-01-13');
  });

  it('rejects month-first text rather than reinterpreting it', () => {
    expect(parseDateInput('10-13-2026')).toBeNull();
    expect(parseDateInput('12/31/2026')).toBeNull();
  });

  it('rejects ISO year-first text on a typed field', () => {
    expect(parseDateInput('2026-10-01')).toBeNull();
    expect(parseDateInput('2026/10/01')).toBeNull();
  });

  it('rejects impossible calendar dates', () => {
    expect(parseDateInput('31-02-2026')).toBeNull();
    expect(parseDateInput('30-02-2024')).toBeNull();
    expect(parseDateInput('31-04-2026')).toBeNull();
    expect(parseDateInput('00-10-2026')).toBeNull();
    expect(parseDateInput('10-00-2026')).toBeNull();
    expect(parseDateInput('32-01-2026')).toBeNull();
  });

  it('handles leap years correctly', () => {
    expect(parseDateInput('29-02-2024')).toBe('2024-02-29');
    expect(parseDateInput('29-02-2000')).toBe('2000-02-29');
    expect(parseDateInput('29-02-2023')).toBeNull();
    expect(parseDateInput('29-02-1900')).toBeNull();
    expect(parseDateInput('29-02-2100')).toBeNull();
  });

  it('enforces the boundary years', () => {
    expect(DATE_INPUT_MIN_YEAR).toBe(1900);
    expect(DATE_INPUT_MAX_YEAR).toBe(2100);
    expect(parseDateInput('01-01-1900')).toBe('1900-01-01');
    expect(parseDateInput('31-12-2100')).toBe('2100-12-31');
    expect(parseDateInput('31-12-1899')).toBeNull();
    expect(parseDateInput('01-01-2101')).toBeNull();
  });

  it('rejects two-digit years, mixed separators, words and empty text', () => {
    expect(parseDateInput('01-10-26')).toBeNull();
    expect(parseDateInput('01-10/2026')).toBeNull();
    expect(parseDateInput('1 Oct 2026')).toBeNull();
    expect(parseDateInput('01102026')).toBeNull();
    expect(parseDateInput('')).toBeNull();
    expect(parseDateInput('   ')).toBeNull();
    expect(parseDateInput(null)).toBeNull();
    expect(parseDateInput(undefined)).toBeNull();
  });

  it('isDateInput mirrors parseDateInput', () => {
    expect(isDateInput('01-10-2026')).toBe(true);
    expect(isDateInput('31-02-2026')).toBe(false);
  });
});

describe('formatDateInput', () => {
  it('turns an ISO date into DD-MM-YYYY', () => {
    expect(formatDateInput('2026-10-01')).toBe('01-10-2026');
  });

  it('returns an empty string for anything that is not an ISO date-only value', () => {
    expect(formatDateInput('')).toBe('');
    expect(formatDateInput(null)).toBe('');
    expect(formatDateInput(undefined)).toBe('');
    expect(formatDateInput('01-10-2026')).toBe('');
    expect(formatDateInput('2026-10-01T00:00:00Z')).toBe('');
  });

  it('round-trips with parseDateInput, including leap day and the boundary years', () => {
    for (const iso of ['2026-10-01', '2024-02-29', '1900-01-01', '2100-12-31', '2000-02-29']) {
      expect(parseDateInput(formatDateInput(iso))).toBe(iso);
    }
    for (const typed of ['01-10-2026', '29-02-2024', '01-01-1900', '31-12-2100']) {
      expect(formatDateInput(parseDateInput(typed))).toBe(typed);
    }
  });

  it('matches the India display format of the canonical formatter', () => {
    expect(formatDateInput('2026-10-01')).toBe(formatDateShort('2026-10-01', 'INR'));
  });
});

describe('placeholder and hint', () => {
  it('name the day-first format in words and never show an ISO or US order', () => {
    expect(DATE_INPUT_PLACEHOLDER).toBe('DD-MM-YYYY');
    expect(DATE_INPUT_HINT).toContain('day-month-year');
    expect(DATE_INPUT_HINT).toContain('01-10-2026');
    expect(DATE_INPUT_HINT).not.toMatch(/YYYY-MM-DD|MM-DD-YYYY|MM\/DD/);
  });
});
