import { describe, it, expect } from 'vitest';
import { fmtDate } from '@/components/investment-intelligence/dateDisplay';

// Regression coverage for the 2026-09-29 fix: fmtDate() (the shared date
// formatter every Investment Intelligence client component renders through)
// previously hardcoded 'INR' unconditionally, so every date rendered
// anywhere in Investment Intelligence used India's dd-mm-yyyy format even
// for an AU-domiciled account. It must now render differently depending on
// the caller's own currency code, exactly like formatDateShort() does for
// money-adjacent AUD/INR callers elsewhere in the app (tests/unit/date.test.ts).
describe('fmtDate (Investment Intelligence shared date display)', () => {
  it('renders dd/mm/yyyy (slash separator) for an AUD-coded caller', () => {
    expect(fmtDate('2026-08-11', 'AUD')).toBe('11/08/2026');
  });

  it('renders dd-mm-yyyy (dash separator) for an INR-coded caller', () => {
    expect(fmtDate('2026-08-11', 'INR')).toBe('11-08-2026');
  });

  it('is lowercase/whitespace tolerant on the currency code (accepts "inr" as well as "INR")', () => {
    expect(fmtDate('2026-08-11', 'inr')).toBe('11-08-2026');
  });

  it('falls back to AUD formatting when no currency code is supplied at all', () => {
    // Matches formatMoneyCode()'s own `currencyCode ?? 'AUD'` fallback
    // (lib/engines/money.ts) and financialContextObject.ts's
    // `preferred_currency ?? 'AUD'` convention -- not 'INR', which would
    // silently reproduce the exact defect this fix closes for every caller
    // that has no currency context yet.
    expect(fmtDate('2026-08-11', undefined)).toBe('11/08/2026');
    expect(fmtDate('2026-08-11', null)).toBe('11/08/2026');
  });

  it('falls back to AUD formatting for any currency code that is not INR (forward-compatible with other future codes)', () => {
    expect(fmtDate('2026-08-11', 'USD')).toBe('11/08/2026');
  });

  it('still passes through null/undefined/non-date-only values untouched, regardless of currency', () => {
    expect(fmtDate(null, 'INR')).toBe('—');
    expect(fmtDate(undefined, 'AUD')).toBe('—');
    expect(fmtDate('Not available', 'INR')).toBe('Not available');
  });

  it('demonstrates the exact before/after: the same ISO date renders differently under AU vs India context', () => {
    const isoDate = '2009-08-10';
    const auRendering = fmtDate(isoDate, 'AUD');
    const indiaRendering = fmtDate(isoDate, 'INR');
    expect(auRendering).toBe('10/08/2009');
    expect(indiaRendering).toBe('10-08-2009');
    expect(auRendering).not.toBe(indiaRendering);
  });
});
