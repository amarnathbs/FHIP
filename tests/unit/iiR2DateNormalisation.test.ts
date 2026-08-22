import { describe, it, expect } from 'vitest';
import { parseStatementDate, isoDateDaysBetween } from '@/lib/services/investment-intelligence/dateNormalisation';

describe('parseStatementDate (spec section 14 — CAS date normalisation)', () => {
  it('parses CAMS-style DD-MMM-YYYY', () => {
    const r = parseStatementDate('01-Feb-2025');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2025-02-01');
  });

  it('parses CAMS-style DD-MMM-YY (2-digit year)', () => {
    const r = parseStatementDate('01-Feb-25');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2025-02-01');
  });

  it('parses KFintech-style DD/MM/YYYY as DD-first, never MM/DD', () => {
    const r = parseStatementDate('03/02/2025'); // 3rd February — NOT March 2nd
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2025-02-03');
  });

  it('parses DD-MM-YYYY', () => {
    const r = parseStatementDate('15-06-2025');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2025-06-15');
  });

  it('passes through an already-ISO date, still validated', () => {
    const r = parseStatementDate('2025-06-30');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2025-06-30');
  });

  it('rejects an invalid calendar date (Feb 30)', () => {
    const r = parseStatementDate('30-Feb-2025');
    expect(r.ok).toBe(false);
  });

  it('rejects 31/04/2025 (April has 30 days) — proves DD/MM is genuinely validated, not just pattern-matched', () => {
    const r = parseStatementDate('31/04/2025');
    expect(r.ok).toBe(false);
  });

  it('rejects an unrecognised month name', () => {
    const r = parseStatementDate('01-Xyz-2025');
    expect(r.ok).toBe(false);
  });

  it('rejects an empty string', () => {
    const r = parseStatementDate('');
    expect(r.ok).toBe(false);
  });

  it('handles a leap-year date correctly (29 Feb 2024)', () => {
    const r = parseStatementDate('29-Feb-2024');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.iso).toBe('2024-02-29');
  });

  it('rejects 29 Feb on a non-leap year', () => {
    const r = parseStatementDate('29-Feb-2025');
    expect(r.ok).toBe(false);
  });
});

describe('isoDateDaysBetween', () => {
  it('computes an exact day count', () => {
    expect(isoDateDaysBetween('2025-01-01', '2025-01-31')).toBe(30);
    expect(isoDateDaysBetween('2025-06-30', '2025-06-30')).toBe(0);
  });
});
