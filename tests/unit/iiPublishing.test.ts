import { describe, it, expect } from 'vitest';
import { computePublicationTarget } from '@/lib/services/investment-intelligence/publishing';

// R0_NET_WORTH_DEDUP_CONTRACT.md section 1 point 2 — the single-target-per-
// position routing rule, exercised against every scenario the design-test
// document (R0_TESTING_AND_VERIFICATION.md section C) enumerates.
describe('computePublicationTarget (net-worth dedup routing)', () => {
  it('routes a mutual fund in a standard mf_folio account to investments', () => {
    expect(computePublicationTarget('mutual_fund', 'mf_folio')).toBe('investments');
  });

  it('routes an equity share to investments', () => {
    expect(computePublicationTarget('equity', 'demat')).toBe('investments');
  });

  it('routes an ETF to investments', () => {
    expect(computePublicationTarget('etf', 'demat')).toBe('investments');
  });

  it('routes ANY instrument held in a retirement-type account to retirement_accounts (scenario 6 — NPS)', () => {
    // NPS itself uses instrument_class='other' (see migration 0038's
    // comment — no distinct retirement value exists in the frozen enum);
    // routing is decided from the ACCOUNT's type instead.
    expect(computePublicationTarget('other', 'retirement')).toBe('retirement_accounts');
    expect(computePublicationTarget('mutual_fund', 'retirement')).toBe('retirement_accounts');
  });

  it('routes a fixed/term deposit to assets, never split across registers (scenario 7)', () => {
    expect(computePublicationTarget('fixed_deposit', 'bank_linked')).toBe('assets');
    expect(computePublicationTarget('fixed_deposit', 'other')).toBe('assets');
  });

  it('routes cash to assets', () => {
    expect(computePublicationTarget('cash', 'bank_linked')).toBe('assets');
  });

  it('is a pure function of (instrumentClass, accountType) — same inputs always produce the same single target', () => {
    const a = computePublicationTarget('mutual_fund', 'mf_folio');
    const b = computePublicationTarget('mutual_fund', 'mf_folio');
    expect(a).toBe(b);
  });
});
