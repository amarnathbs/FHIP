import { describe, it, expect } from 'vitest';
import { parseExactDecimal, scaledToDecimalString, addScaled, subScaled, absScaled, compareScaled, isZeroScaled } from '@/lib/services/investment-intelligence/decimal';

describe('parseExactDecimal (spec section 13 — exact numeric parsing)', () => {
  it('parses a plain Western-formatted amount', () => {
    const r = parseExactDecimal('125000.50');
    expect(r.ok).toBe(true);
    if (r.ok) expect(scaledToDecimalString(r.scaled, 2)).toBe('125000.50');
  });

  it('parses Indian comma-grouped formatting (2-3-3) to the exact same value as unformatted', () => {
    const r = parseExactDecimal('1,25,000.50');
    expect(r.ok).toBe(true);
    if (r.ok) expect(scaledToDecimalString(r.scaled, 2)).toBe('125000.50');
  });

  it('parses Western comma-grouped formatting (3-3-3) to the exact same value', () => {
    const r = parseExactDecimal('125,000.50');
    expect(r.ok).toBe(true);
    if (r.ok) expect(scaledToDecimalString(r.scaled, 2)).toBe('125000.50');
  });

  it('parses a rupee-symbol-prefixed value', () => {
    const r = parseExactDecimal('₹1,25,000.50');
    expect(r.ok).toBe(true);
    if (r.ok) expect(scaledToDecimalString(r.scaled, 2)).toBe('125000.50');
  });

  it('parses an "Rs." prefixed value', () => {
    const r = parseExactDecimal('Rs. 500.00');
    expect(r.ok).toBe(true);
    if (r.ok) expect(scaledToDecimalString(r.scaled, 2)).toBe('500.00');
  });

  it('parses a negative value with a leading minus sign', () => {
    const r = parseExactDecimal('-2,000.00');
    expect(r.ok).toBe(true);
    if (r.ok) expect(scaledToDecimalString(r.scaled, 2)).toBe('-2000.00');
  });

  it('parses a parenthesised negative value (accounting convention)', () => {
    const r = parseExactDecimal('(1,234.56)');
    expect(r.ok).toBe(true);
    if (r.ok) expect(scaledToDecimalString(r.scaled, 2)).toBe('-1234.56');
  });

  it('parses zero exactly, with no spurious negative sign', () => {
    const r = parseExactDecimal('0.00');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(scaledToDecimalString(r.scaled, 2)).toBe('0.00');
      expect(isZeroScaled(r.scaled)).toBe(true);
    }
  });

  it('rejects "NA" / "N/A" / "Nil" / bare "-" rather than guessing zero', () => {
    for (const bad of ['NA', 'N/A', 'Nil', '-', '--', '']) {
      const r = parseExactDecimal(bad);
      expect(r.ok, `expected "${bad}" to be rejected`).toBe(false);
    }
  });

  it('rejects a malformed numeric string (e.g. two decimal points)', () => {
    const r = parseExactDecimal('12.34.56');
    expect(r.ok).toBe(false);
  });

  it('rejects a string with embedded letters', () => {
    const r = parseExactDecimal('12a.34');
    expect(r.ok).toBe(false);
  });

  it('handles variable NAV precision (4 decimals) exactly', () => {
    const r = parseExactDecimal('119.7605');
    expect(r.ok).toBe(true);
    if (r.ok) expect(scaledToDecimalString(r.scaled, 4)).toBe('119.7605');
  });

  it('handles fractional units (3 decimals) exactly', () => {
    const r = parseExactDecimal('8734.567');
    expect(r.ok).toBe(true);
    if (r.ok) expect(scaledToDecimalString(r.scaled, 3)).toBe('8734.567');
  });

  it('does not lose precision to floating-point error across many additions (the whole reason this module exists instead of plain `number`)', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754 double; the scaled-BigInt representation
    // must not exhibit this.
    const a = parseExactDecimal('0.10');
    const b = parseExactDecimal('0.20');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      const sum = addScaled(a.scaled, b.scaled);
      expect(scaledToDecimalString(sum, 2)).toBe('0.30');
    }
    // Sanity check that ordinary JS floats DO exhibit the bug we're avoiding.
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('rounds half-up when more than 6 fractional digits are supplied, and flags it', () => {
    const r = parseExactDecimal('1.1234567');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.roundedFromHigherPrecision).toBe(true);
      expect(scaledToDecimalString(r.scaled, 6)).toBe('1.123457');
    }
  });
});

describe('scaled decimal arithmetic helpers', () => {
  it('subScaled/absScaled/compareScaled behave exactly', () => {
    const a = parseExactDecimal('100.00');
    const b = parseExactDecimal('30.50');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      const diff = subScaled(a.scaled, b.scaled);
      expect(scaledToDecimalString(diff, 2)).toBe('69.50');
      expect(scaledToDecimalString(absScaled(subScaled(b.scaled, a.scaled)), 2)).toBe('69.50');
      expect(compareScaled(a.scaled, b.scaled)).toBe(1);
      expect(compareScaled(b.scaled, a.scaled)).toBe(-1);
      expect(compareScaled(a.scaled, a.scaled)).toBe(0);
    }
  });
});
