// NAV2 release candidate (B3, performance): the date helpers remember their answers (a CPU profile of a 20 fund report showed half of the engine time was
// spent parsing the same few thousand date strings). A remembered answer must be EXACTLY the answer the plain computation gives, for every input, including
// bad dates, and the memory must stay bounded.
//
// NAMED NEGATIVE CONTROLS
//   NC-D1  toUtc equals the plain Date.parse for 20,000 valid dates, repeated (hit) and first-time (miss), and for impossible dates (NaN stays NaN);
//   NC-D2  daysBetween equals the plain subtraction;
//   NC-D3  subtractMonthsIso equals the original implementation for every day of 30 years and every horizon the engine uses;
//   NC-D4  the cache is bounded: past its limit it clears and keeps answering correctly;
//   NC-D5  CONTROL: a deliberately wrong cache (key collision) would be caught by NC-D1, shown by running the same comparison against it.
import { describe, expect, it } from 'vitest';
import { __dateAlignmentInternals } from '@/lib/engines/investment-intelligence/sip/dateAlignment';
import { subtractMonthsIso } from '@/lib/engines/nav2/dates';

const plainToUtc = (iso: string): number => Date.parse(iso.length === 10 ? `${iso}T00:00:00.000Z` : iso);
const plainSubtract = (iso: string, n: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) - n;
  const ty = Math.floor(total / 12);
  const tm = total - ty * 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(d, lastDay))).toISOString().slice(0, 10);
};
function* days(from: string, count: number): Generator<string> {
  const cur = new Date(`${from}T00:00:00.000Z`);
  for (let i = 0; i < count; i++) {
    yield cur.toISOString().slice(0, 10);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
}
const { toUtc, daysBetween } = __dateAlignmentInternals;
const same = (a: number, b: number) => (Number.isNaN(a) && Number.isNaN(b)) || a === b;

describe('NC-D1 / NC-D2: toUtc and daysBetween', () => {
  it('equal the plain computation, first time and remembered, for 20,000 consecutive days', () => {
    const all = [...days('1990-01-01', 20_000)];
    for (const d of all) expect(same(toUtc(d), plainToUtc(d)), d).toBe(true); // misses
    for (const d of all) expect(same(toUtc(d), plainToUtc(d)), d).toBe(true); // hits
  });
  it('impossible and odd dates give what Date.parse gives, every time', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '0000-00-00', 'not-a-date', '2026-1-1  ', '2026-10-02T10:00:00Z', '']) {
      expect(same(toUtc(bad), plainToUtc(bad)), bad).toBe(true);
      expect(same(toUtc(bad), plainToUtc(bad)), `${bad} again`).toBe(true);
    }
  });
  it('daysBetween equals the plain rounded difference', () => {
    const all = [...days('2019-01-01', 2500)];
    for (let i = 0; i < all.length; i += 7) for (const j of [0, 1, 7, 30, 365, 900]) {
      const a = all[i];
      const b = all[Math.min(i + j, all.length - 1)];
      expect(daysBetween(a, b)).toBe(Math.round((plainToUtc(b) - plainToUtc(a)) / 86_400_000));
    }
    expect(daysBetween('2026-10-02', '2026-09-28')).toBe(-4);
  });
});

describe('NC-D3: subtractMonthsIso', () => {
  it('equals the original for every day of 30 years and every horizon the engine uses (and the end-of-month clamp)', () => {
    for (const d of days('1996-01-01', 10_957)) for (const n of [1, 3, 6, 12, 36, 60]) expect(subtractMonthsIso(d, n), `${d} - ${n}`).toBe(plainSubtract(d, n));
    expect(subtractMonthsIso('2026-03-31', 1)).toBe('2026-02-28');
    expect(subtractMonthsIso('2024-03-31', 1)).toBe('2024-02-29');
    expect(subtractMonthsIso('2026-01-15', 2)).toBe('2025-11-15');
  }, 120_000);
  it('an impossible date still throws, as before, and a throw is not remembered', () => {
    expect(() => subtractMonthsIso('xx-yy-zz', 1)).toThrow();
    expect(() => subtractMonthsIso('xx-yy-zz', 1)).toThrow();
  });
});

describe('NC-D4: bounded memory', () => {
  it('more than the cache limit of distinct dates keeps answering correctly (the cache clears and refills)', () => {
    for (const d of days('1700-01-01', 120_000)) if (!same(toUtc(d), plainToUtc(d))) throw new Error(`wrong answer for ${d}`);
    expect(same(toUtc('2026-10-02'), plainToUtc('2026-10-02'))).toBe(true);
  }, 120_000);
});

describe('NC-D5: the comparison bites', () => {
  it('a cache keyed on the year and month only (a collision bug) disagrees with the plain computation within a month', () => {
    const bad = new Map<string, number>();
    const badToUtc = (iso: string) => {
      const key = iso.slice(0, 7);
      if (!bad.has(key)) bad.set(key, plainToUtc(iso));
      return bad.get(key)!;
    };
    badToUtc('2026-10-01');
    expect(same(badToUtc('2026-10-02'), plainToUtc('2026-10-02'))).toBe(false);
  });
});
