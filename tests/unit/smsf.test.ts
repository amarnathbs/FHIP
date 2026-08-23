import { describe, it, expect } from 'vitest';
import { computeSmsfTotal, isDoubleCounted } from '@/lib/engines/smsf';

// Chunk 3a items 2-3 (Spec 2 §38-42): SMSF Summary-vs-Detailed mode
// aggregation, exercised against Spec 2's exact worked example.

describe('computeSmsfTotal — Spec 2 §41 Summary/Detailed mode switching discipline', () => {
  it('detailed mode sums the holdings (cash 50,000 + shares 150,000 + property 500,000 = 700,000)', () => {
    const account = { smsf_mode: 'detailed' as const, current_balance: 0 };
    const holdings = [{ value: 50000 }, { value: 150000 }, { value: 500000 }];
    expect(computeSmsfTotal(account, holdings)).toBe(700000);
  });

  it('detailed mode never adds a stale summary balance on top of the holdings total', () => {
    // A stale current_balance left over from before the account switched
    // into Detailed mode — must never be summed with the holdings.
    const account = { smsf_mode: 'detailed' as const, current_balance: 700000 };
    const holdings = [{ value: 50000 }, { value: 150000 }, { value: 500000 }];
    const total = computeSmsfTotal(account, holdings);
    expect(total).toBe(700000);
    expect(total).not.toBe(1400000);
    expect(isDoubleCounted(account, holdings, total)).toBe(false);
  });

  it('summary mode uses only the account balance, ignoring any holdings rows present', () => {
    const account = { smsf_mode: 'summary' as const, current_balance: 700000 };
    const holdings = [{ value: 999999 }];
    expect(computeSmsfTotal(account, holdings)).toBe(700000);
  });

  it('defaults to summary behaviour when mode is unset (every account predating this migration)', () => {
    const account = { smsf_mode: undefined, current_balance: 250000 };
    expect(computeSmsfTotal(account, [])).toBe(250000);
  });

  it('detailed mode excludes archived (is_active=false) holdings from the sum', () => {
    const account = { smsf_mode: 'detailed' as const, current_balance: 0 };
    const holdings = [
      { value: 50000 },
      { value: 999999, is_active: false },
    ];
    expect(computeSmsfTotal(account, holdings)).toBe(50000);
  });

  it('isDoubleCounted flags a reported total that is literally the sum of both sources', () => {
    const account = { smsf_mode: 'detailed' as const, current_balance: 700000 };
    const holdings = [{ value: 50000 }, { value: 150000 }, { value: 500000 }];
    // A hypothetical buggy caller that summed both sources anyway.
    const buggyTotal = account.current_balance + holdings.reduce((s, h) => s + h.value, 0);
    expect(buggyTotal).toBe(1400000);
    expect(isDoubleCounted(account, holdings, buggyTotal)).toBe(true);
  });
});
