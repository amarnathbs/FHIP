/**
 * II-PC1-D4 — manual-entry transaction/as-of date hardening.
 *
 * Original defect: iiManualDirectPositionSchema validated
 * `transactionDate: z.string().min(1)` / `asOfDate: z.string().min(1)` —
 * no calendar validity or format check at all, so a malformed/impossible
 * date could reach the DB write, where Postgres' own cast/constraint error
 * (raw SQLSTATE/relation/column text) could leak to the client.
 *
 * validateIsoDateStrict (dateNormalisation.ts) is the new gate — it must
 * run BEFORE any DB write in manualDirectPositionService.ts, and it must
 * reject every malformed shape while accepting genuine ISO dates
 * (including the leap-day edge case).
 */
import { describe, it, expect } from 'vitest';
import { validateIsoDateStrict } from '@/lib/services/investment-intelligence/dateNormalisation';
import { iiManualDirectPositionSchema } from '@/lib/validation/investment-intelligence';

describe('PC1-D4-RED — the prior schema accepted ANY non-empty string as a date', () => {
  it('demonstrates the vacuous prior contract: z.string().min(1) accepts an impossible date', () => {
    const vacuousSchema = { min1: (s: string) => s.length >= 1 };
    expect(vacuousSchema.min1('2026-02-31')).toBe(true); // this alone was "valid" before PC1-D4
  });
});

describe('PC1-D4-GREEN — validateIsoDateStrict: rejects malformed/impossible dates', () => {
  it('rejects an impossible calendar date (2026-02-31 — February never has 31 days)', () => {
    expect(validateIsoDateStrict('2026-02-31').ok).toBe(false);
  });
  it('rejects a malformed ISO date (wrong separators/shape)', () => {
    expect(validateIsoDateStrict('2026/02/15').ok).toBe(false);
    expect(validateIsoDateStrict('2026-2-15').ok).toBe(false);
    expect(validateIsoDateStrict('20260215').ok).toBe(false);
  });
  it('rejects a DD/MM-ambiguous date under the ISO-only contract', () => {
    expect(validateIsoDateStrict('15/02/2026').ok).toBe(false);
    expect(validateIsoDateStrict('31-01-2026').ok).toBe(false);
  });
  it('rejects an empty string', () => {
    expect(validateIsoDateStrict('').ok).toBe(false);
  });
  it('rejects a whitespace-only string', () => {
    expect(validateIsoDateStrict('   ').ok).toBe(false);
  });
  it('rejects an arbitrary string', () => {
    expect(validateIsoDateStrict('not-a-date').ok).toBe(false);
  });
  it('rejects an overlong payload without throwing', () => {
    expect(() => validateIsoDateStrict('2026-01-01' + 'x'.repeat(10000))).not.toThrow();
    expect(validateIsoDateStrict('2026-01-01' + 'x'.repeat(10000)).ok).toBe(false);
  });
  it('rejects SQL-like text safely (never reaches a DB call, and never throws)', () => {
    const hostile = "2026-01-01'; DROP TABLE ii_transactions;--";
    expect(() => validateIsoDateStrict(hostile)).not.toThrow();
    expect(validateIsoDateStrict(hostile).ok).toBe(false);
  });
  it('rejects non-string input without throwing', () => {
    expect(validateIsoDateStrict(20260101 as unknown as string).ok).toBe(false);
    expect(validateIsoDateStrict(null as unknown as string).ok).toBe(false);
    expect(validateIsoDateStrict(undefined as unknown as string).ok).toBe(false);
  });
});

describe('PC1-D4-GREEN — validateIsoDateStrict: accepts genuine valid dates', () => {
  it('accepts a valid leap-day date (2024-02-29)', () => {
    const result = validateIsoDateStrict('2024-02-29');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.iso).toBe('2024-02-29');
  });
  it('rejects the same day/month in a NON-leap year (2026-02-29 does not exist)', () => {
    expect(validateIsoDateStrict('2026-02-29').ok).toBe(false);
  });
  it('accepts an ordinary valid date', () => {
    const result = validateIsoDateStrict('2025-06-15');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.iso).toBe('2025-06-15');
  });
});

describe('PC1-D4 — schema still accepts the raw string shape (semantic validation happens service-side, before any DB write)', () => {
  it('a syntactically-string-but-impossible date still passes the Zod layer (proves the service-layer gate is the real enforcement point)', () => {
    const parsed = iiManualDirectPositionSchema.safeParse({
      action: 'buy',
      instrumentClass: 'equity',
      instrumentName: 'Test Co',
      isin: 'US0378331005',
      accountInstitutionName: 'Test Broker',
      transactionDate: '2026-02-31',
      units: 10,
      pricePerUnit: 100,
    });
    expect(parsed.success).toBe(true); // Zod shape-only; validateIsoDateStrict is the real gate
    if (parsed.success && parsed.data.action === 'buy') {
      expect(validateIsoDateStrict(parsed.data.transactionDate).ok).toBe(false);
    }
  });
});
