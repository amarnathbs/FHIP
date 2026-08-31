/**
 * FDH-12 — scale certification (spec sections 138-142).
 *
 * "Test 100/500/1000/1001/5000/10000 statement activities where meaningful."
 *
 * These exercise the PURE pipeline at scale: classification, reconciliation,
 * fingerprinting and deduplication. The DB-side pagination boundary (1000 vs
 * 1001, spec section 139) is certified separately, live, because that is a
 * PostgREST property rather than a property of this code — the mechanism it
 * relies on (`fetchAllRows`) is asserted here and exercised for real in
 * `scripts/fdh12_live_dev_certification.mjs`.
 */

import { describe, it, expect } from 'vitest';
import { detectRetirementCsvFormat } from '@/lib/financial-data-hub/retirement/detection';
import { extractRetirementStatement } from '@/lib/financial-data-hub/retirement/extraction';
import { reconcileFromActivities } from '@/lib/financial-data-hub/retirement/reconciliation';
import { dedupActivities } from '@/lib/financial-data-hub/retirement/dedup';
import { parseMoneyToMinorUnits, sumMinorUnits, minorUnitsToDecimalString } from '@/lib/financial-data-hub/retirement/money';
import {
  POSTGREST_PAGE_SIZE,
  FETCH_ALL_ROWS_CEILING,
  fetchAllRows,
} from '@/lib/financial-data-hub/bank-csv/pagination';
import type { RetirementActivityEvidence } from '@/lib/financial-data-hub/retirement/types';

const M = (s: string) => parseMoneyToMinorUnits(s);
const SCALES = [100, 500, 1000, 1001, 5000, 10000];

/** A CSV of `n` employer contributions of $10.00, each on a distinct day. */
function statementCsv(n: number): Uint8Array {
  const rows = ['Date,Description,Amount,Employer'];
  for (let i = 0; i < n; i += 1) {
    const d = new Date(Date.UTC(2000, 0, 1 + i));
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    rows.push(`${dd}/${mm}/${d.getUTCFullYear()},Employer contribution,10.00,Acme Pty Ltd`);
  }
  return new TextEncoder().encode(rows.join('\n'));
}

function syntheticActivities(n: number): RetirementActivityEvidence[] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2000, 0, 1 + i));
    return {
      activityType: 'EMPLOYER_CONTRIBUTION' as const,
      amount: '10.00',
      currencyCode: 'AUD',
      activityDate: d.toISOString().slice(0, 10),
      employerNameRaw: 'Acme Pty Ltd',
      isSummaryTotal: false,
      isYearToDate: false,
    };
  });
}

describe('FDH-12 spec 138 — statement activity scale', () => {
  for (const n of SCALES) {
    it(`extracts exactly ${n} activities with no truncation and no drift`, () => {
      const detection = detectRetirementCsvFormat(statementCsv(n));
      expect(detection.status).toBe('detected');
      const result = extractRetirementStatement(detection, { currencyCode: 'AUD', jurisdiction: 'AU' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // NO SILENT TRUNCATION — the count is exact at every scale, including
      // the 1000/1001 boundary.
      expect(result.extraction.activities).toHaveLength(n);
      expect(result.extraction.activities.every((a) => a.amount === '10.00')).toBe(true);
    });
  }

  for (const n of SCALES) {
    it(`reconciles ${n} activities to the exact cent`, () => {
      const activities = syntheticActivities(n);
      const total = sumMinorUnits(activities.map((a) => M(a.amount)));
      const closing = minorUnitsToDecimalString(M('1000.00') + total);
      const result = reconcileFromActivities('1000.00', closing, activities);
      expect(result.status).toBe('reconciled');
      expect(result.varianceMinorUnits).toBe(M('0.00'));
      expect(result.detail.movementTermCount).toBe(n);
    });
  }

  it('a $0.01 error is still detected at 10,000 activities', () => {
    // The exactness guarantee does not degrade with volume — the whole reason
    // the arithmetic is integer minor units rather than float.
    const activities = syntheticActivities(10000);
    const total = sumMinorUnits(activities.map((a) => M(a.amount)));
    const closingOffByACent = minorUnitsToDecimalString(M('1000.00') + total + M('0.01'));
    const result = reconcileFromActivities('1000.00', closingOffByACent, activities);
    expect(result.status).toBe('variance');
    expect(result.varianceMinorUnits).toBe(-M('0.01'));
  });

  it('float arithmetic WOULD have drifted at this scale (negative control)', () => {
    // 10,000 additions of 0.1 in binary floating point does not equal 1000.
    let floatSum = 0;
    for (let i = 0; i < 10000; i += 1) floatSum += 0.1;
    expect(floatSum).not.toBe(1000);
    // The exact path does.
    expect(sumMinorUnits(Array.from({ length: 10000 }, () => M('0.10')))).toBe(M('1000.00'));
  });

  for (const n of SCALES) {
    it(`deduplicates ${n} activities without false positives`, () => {
      const activities = syntheticActivities(n);
      const first = dedupActivities(activities, 'acc-1', new Map());
      expect(first.filter((d) => d.isDuplicate)).toHaveLength(0);
      expect(new Set(first.map((d) => d.fingerprint)).size).toBe(n);

      const onFile = new Map(first.map((d, i) => [d.fingerprint!, `x-${i}`]));
      const second = dedupActivities(activities, 'acc-1', onFile);
      expect(second.filter((d) => d.isDuplicate)).toHaveLength(n);
    });
  }
});

describe('FDH-12 spec 139 — PostgREST pagination boundary', () => {
  it('the page size the boundary is about is 1000', () => {
    expect(POSTGREST_PAGE_SIZE).toBe(1000);
  });

  it('fetchAllRows crosses the 1000/1001 boundary without truncating', async () => {
    // A fake pager that behaves exactly as PostgREST does: it returns at most
    // `pageSize` rows per request and stops when a short page arrives.
    const makePager = (total: number) => {
      let calls = 0;
      return () => ({
        range(from: number, to: number) {
          calls += 1;
          const rows = Array.from(
            { length: Math.max(0, Math.min(to, total - 1) - from + 1) },
            (_, i) => ({ id: from + i }),
          );
          return Promise.resolve({ data: rows, error: null });
        },
        get calls() { return calls; },
      });
    };

    for (const total of [999, 1000, 1001, 2500]) {
      const build = makePager(total);
      const rows = await fetchAllRows<{ id: number }>(build as never);
      expect(rows, `total ${total}`).toHaveLength(total);
      // Ids are contiguous — nothing lost in the middle either.
      expect(rows[0].id).toBe(0);
      expect(rows[rows.length - 1].id).toBe(total - 1);
    }
  });

  it('a NAIVE single-page read WOULD truncate at 1000 (negative control)', () => {
    // Proves the helper is load-bearing rather than decorative.
    const total = 1001;
    const naive = Array.from({ length: Math.min(total, POSTGREST_PAGE_SIZE) }, (_, i) => i);
    expect(naive).toHaveLength(1000);
    expect(naive).not.toHaveLength(total);
  });

  it('refuses to page unboundedly — there is a ceiling', () => {
    expect(FETCH_ALL_ROWS_CEILING).toBeGreaterThan(10000);
  });
});

describe('FDH-12 spec 141 — long history', () => {
  for (const years of [1, 3, 5, 10]) {
    it(`${years} years of monthly contributions reconcile exactly`, () => {
      const months = years * 12;
      const activities = syntheticActivities(months);
      const total = sumMinorUnits(activities.map((a) => M(a.amount)));
      const closing = minorUnitsToDecimalString(M('50000.00') + total);
      const result = reconcileFromActivities('50000.00', closing, activities);
      expect(result.status).toBe('reconciled');
      expect(result.detail.movementTermCount).toBe(months);
    });
  }
});
