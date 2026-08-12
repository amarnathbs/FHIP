import { describe, it, expect } from 'vitest';
import { formatDateShort } from '@/lib/engines/date';

describe('formatDateShort', () => {
  it('uses slash separator for AUD (dd/mm/yyyy)', () => {
    expect(formatDateShort('2026-08-11', 'AUD')).toBe('11/08/2026');
  });

  it('uses dash separator for INR (dd-mm-yyyy)', () => {
    expect(formatDateShort('2026-08-11', 'INR')).toBe('11-08-2026');
  });

  it('zero-pads single-digit day and month for both currencies', () => {
    expect(formatDateShort('2026-01-05', 'AUD')).toBe('05/01/2026');
    expect(formatDateShort('2026-01-05', 'INR')).toBe('05-01-2026');
  });

  it('accepts a Date object as well as a string', () => {
    expect(formatDateShort(new Date(2026, 7, 11), 'AUD')).toBe('11/08/2026');
  });

  it('parses a date-only string directly, immune to server timezone offset', () => {
    // Regression guard: new Date('2026-08-11') is UTC midnight; reading it
    // back with local getters on a negative-UTC-offset server would show
    // 10/08/2026 instead. formatDateShort must not go through that path for
    // plain "YYYY-MM-DD" strings.
    expect(formatDateShort('2026-08-11', 'AUD')).toBe('11/08/2026');
    expect(formatDateShort('2026-08-11', 'INR')).toBe('11-08-2026');
  });
});
