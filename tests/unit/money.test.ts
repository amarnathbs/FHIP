import { describe, it, expect } from 'vitest';
import { toMonthly, formatMoney } from '@/lib/engines/money';

describe('toMonthly', () => {
  it('annualises correctly', () => {
    expect(toMonthly(1200, 'annually')).toBeCloseTo(100);
  });

  it('treats one-off as non-recurring', () => {
    expect(toMonthly(5000, 'one_off')).toBe(0);
  });

  it('converts weekly to monthly', () => {
    expect(toMonthly(500, 'weekly')).toBeCloseTo(2166.67, 1);
  });

  it('leaves monthly unchanged', () => {
    expect(toMonthly(1000, 'monthly')).toBe(1000);
  });
});

describe('formatMoney', () => {
  it('formats AUD', () => {
    expect(formatMoney(1234.5, 'AUD')).toContain('1,234.50');
  });

  it('formats INR', () => {
    expect(formatMoney(1234, 'INR')).toContain('1,234');
  });
});
