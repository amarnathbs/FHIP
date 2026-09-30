import { describe, it, expect } from 'vitest';
import { fmtDate, fmtDateTime } from '@/components/investment-intelligence/dateDisplay';

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

// Regression coverage for the 2026-09-30 fix: ResolutionHistoryClient.tsx (the
// Investment Intelligence "Resolutions" history/amendment view) was still
// calling `new Date(...).toLocaleDateString()`/`.toLocaleString()` directly on
// its `openedAt`/`resolvedAt` fields instead of going through this shared
// helper, so its dates rendered in the browser's default locale format,
// inconsistent with every other II component fixed alongside it. Unlike every
// other II caller, `openedAt`/`resolvedAt` are `timestamptz` columns (full ISO
// timestamps), not `date`-only columns -- fmtDate() was widened to also
// accept a timestamp (formatting its date part) and a companion
// fmtDateTime() was added for the one call site that also needs the time.
describe('fmtDate with a full ISO timestamp (timestamptz column, not a date-only column)', () => {
  it('formats just the date portion, AU vs India separator, immune to the runner timezone', () => {
    const iso = '2026-08-11T02:14:00.512Z';
    const d = new Date(iso);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    expect(fmtDate(iso, 'AUD')).toBe(`${day}/${month}/${year}`);
    expect(fmtDate(iso, 'INR')).toBe(`${day}-${month}-${year}`);
  });

  it('does not change behavior for the existing date-only call sites (the widened regex is additive)', () => {
    expect(fmtDate('2026-08-11', 'AUD')).toBe('11/08/2026');
    expect(fmtDate('2026-08-11', 'INR')).toBe('11-08-2026');
  });

  it('still passes through a non-date, non-timestamp string unchanged', () => {
    expect(fmtDate('Not available', 'AUD')).toBe('Not available');
    expect(fmtDate(null, 'AUD')).toBe('—');
    expect(fmtDate(undefined, 'AUD')).toBe('—');
  });
});

describe('fmtDateTime (Investment Intelligence shared date+time display)', () => {
  it('renders the AU/India-aware date plus a 12-hour time for an AUD-coded caller', () => {
    const iso = '2026-09-28T02:14:00.512Z';
    const datePart = fmtDate(iso, 'AUD');
    const rendered = fmtDateTime(iso, 'AUD');
    expect(rendered.startsWith(`${datePart}, `)).toBe(true);
    expect(rendered).toMatch(/\d{1,2}:\d{2}:\d{2}\s?[ap]m$/i);
  });

  it('uses the dash date separator for an INR-coded caller, same as fmtDate', () => {
    const iso = '2026-09-28T02:14:00.512Z';
    const datePart = fmtDate(iso, 'INR');
    const rendered = fmtDateTime(iso, 'INR');
    expect(rendered.startsWith(`${datePart}, `)).toBe(true);
  });

  it('falls back to AUD formatting when no currency code is supplied, matching fmtDate', () => {
    const iso = '2026-09-28T02:14:00.512Z';
    expect(fmtDateTime(iso, undefined).startsWith(fmtDate(iso, undefined))).toBe(true);
  });

  it('returns an em dash for null/undefined, matching fmtDate', () => {
    expect(fmtDateTime(null, 'AUD')).toBe('—');
    expect(fmtDateTime(undefined, 'INR')).toBe('—');
  });

  it('passes through a date-only (non-timestamp) string unchanged -- fmtDateTime is only for timestamptz values', () => {
    expect(fmtDateTime('2026-08-11', 'AUD')).toBe('2026-08-11');
  });
});
