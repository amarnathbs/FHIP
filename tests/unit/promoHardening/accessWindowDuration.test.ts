// Item 2: ONE definition of an access window whose two ends are both inclusive.
//
// effective_to is INCLUSIVE (migration 0115, entitlementWindow.ts) and effective_from is inclusive, so a window of N days that
// starts on R ends on R + N - 1. The earlier promo rule ended it on R + N, which gave N + 1 calendar days of Premium.
//
// NAMED NEGATIVE CONTROL
//   NC-D1  the OLD rule (end = R + N) is run through the same assertions: "day grant gives exactly" goes red.

import { describe, it, expect } from 'vitest';
import {
  ENTITLEMENT_GRANT_MAX_DAYS,
  accessEndDate,
  accessWindowDays,
  addDaysIso,
  effectivePlanTier,
  isEntitlementWindowCurrent,
  maxGrantEndDate,
} from '@/lib/services/entitlementWindow';
import { computeEntitlementReminder } from '@/lib/services/entitlementReminder';
import { expectNamedFailure } from '../support/promoTestHelpers';

/** How many calendar days (starting at R) the window is current. Walks day by day, so it does not trust the formulas under test. */
function premiumDays(start: string, end: string, horizon = 800): number {
  let n = 0;
  for (let i = 0; i < horizon; i += 1) {
    const day = addDaysIso(start, i);
    if (effectivePlanTier({ plan_tier: 'premium', effective_from: start, effective_to: end }, day) === 'premium') n += 1;
  }
  return n;
}

function assertExactDays(endFor: (start: string, days: number) => string) {
  for (const [start, days] of [
    ['2026-10-05', 1],
    ['2026-10-05', 30],
    ['2026-10-05', 365],
    ['2024-02-28', 1],
    ['2024-02-28', 30],
    ['2024-02-28', 365],
    ['2024-02-29', 30],
    ['2023-12-31', 30],
  ] as const) {
    expect(premiumDays(start, endFor(start, days)), `a ${days} day grant gives exactly ${days} days of Premium (from ${start})`).toBe(days);
  }
}

describe('accessEndDate: both ends inclusive', () => {
  it('1 day ends on the day it starts', () => {
    expect(accessEndDate('2026-10-05', 1)).toBe('2026-10-05');
  });

  it('30 days from 5 October 2026 end on 3 November 2026 (not the 4th)', () => {
    expect(accessEndDate('2026-10-05', 30)).toBe('2026-11-03');
  });

  it('365 days from 5 October 2026 end on 4 October 2027', () => {
    expect(accessEndDate('2026-10-05', 365)).toBe('2027-10-04');
  });

  it('LEAP YEAR: redeemed 28-02-2024, 30 days end on 28-03-2024, and 365 days end on 26-02-2025 (the 29th of February is one of the days)', () => {
    expect(accessEndDate('2024-02-28', 30)).toBe('2024-03-28');
    expect(accessEndDate('2024-02-28', 365)).toBe('2025-02-26');
    expect(accessEndDate('2024-02-28', 2)).toBe('2024-02-29');
    expect(accessEndDate('2023-02-28', 2)).toBe('2023-03-01');
  });

  it('every length gives exactly that many days of Premium when walked day by day (1, 30, 365, leap year)', () => {
    assertExactDays(accessEndDate);
  });

  it('NC-D1: the OLD rule (start + days) gives one day too many', async () => {
    assertExactDays(accessEndDate);
    await expectNamedFailure(() => assertExactDays((s, d) => addDaysIso(s, d)), 'day grant gives exactly');
  });

  it('accessWindowDays is the inverse: end minus start plus one', () => {
    expect(accessWindowDays('2026-10-05', '2026-10-05')).toBe(1);
    expect(accessWindowDays('2026-10-05', '2026-11-03')).toBe(30);
    expect(accessWindowDays('2024-02-28', '2025-02-26')).toBe(365);
    for (const days of [1, 7, 30, 31, 365]) expect(accessWindowDays('2024-02-28', accessEndDate('2024-02-28', days))).toBe(days);
  });
});

describe('the other consumers agree with it', () => {
  it('the admin grant ceiling is a 365 day inclusive window: today + 364 is allowed, today + 365 is not', () => {
    expect(ENTITLEMENT_GRANT_MAX_DAYS).toBe(365);
    expect(maxGrantEndDate('2026-10-05')).toBe('2027-10-04');
    expect(maxGrantEndDate('2024-02-28')).toBe('2025-02-26');
  });

  it('the window is current on its last day and not on the day after (banners, entitlement checks)', () => {
    const row = { plan_tier: 'premium' as const, effective_from: '2026-10-05', effective_to: '2026-11-03' };
    expect(isEntitlementWindowCurrent(row, '2026-11-03')).toBe(true);
    expect(isEntitlementWindowCurrent(row, '2026-11-04')).toBe(false);
    expect(isEntitlementWindowCurrent(row, '2026-10-05')).toBe(true);
    expect(isEntitlementWindowCurrent(row, '2026-10-04')).toBe(false);
  });

  it('the banner counts days to the last day: on the last day it says today, the day before it says 1 day', () => {
    const row = { plan_tier: 'premium', entitlement_source: 'promo_code', effective_from: '2026-10-05', effective_to: '2026-11-03' };
    expect(computeEntitlementReminder(row, '2026-11-03').days).toBe(0);
    expect(computeEntitlementReminder(row, '2026-11-02').days).toBe(1);
    expect(computeEntitlementReminder(row, '2026-11-03').title).toMatch(/ends today/);
  });
});
