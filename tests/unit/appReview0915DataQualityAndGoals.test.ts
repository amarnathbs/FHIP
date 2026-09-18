// App Review 2026-09-15, items 4 and 5.
//
// Item 4: with 8 assets, 4 liabilities, 2 investments and an SMSF entered, the
// report's "Data Quality and Completeness" section still showed all four of
// those sections as Status: Missing / Last updated: Not provided / Report
// treatment: Not included — not treated as zero, and 29% complete (= 2 of 7).
//
// Item 5: the Goals section said "No active goals were recorded for this
// period." while the Financial Goals page said "You have 1 active goal".
import { describe, it, expect } from 'vitest';
import { buildDataQuality, DATA_QUALITY_STATUS_LABELS, IN_PROGRESS_COMPLETENESS_WEIGHT } from '@/lib/engines/reportSections';

type DQRow = { area: string; status: string; lastUpdated: string | null; reportTreatment: string };

const RECENT = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

/** The reviewer's household: everything entered, nothing confirmed complete. */
function reviewerSource(overrides: Record<string, unknown> = {}) {
  return {
    dashboard: {
      hasIncome: true,
      hasExpenses: true,
      hasAssets: true,
      hasLiabilities: true,
      hasInvestments: true,
      hasRetirement: true,
      hasInsurance: false,
      ...(overrides.dashboard as object),
    },
    dataFreshness: {
      income: RECENT,
      expenses: RECENT,
      assets: RECENT,
      liabilities: RECENT,
      investments: RECENT,
      retirement: RECENT,
      insurance: null,
      ...(overrides.dataFreshness as object),
    },
    healthScore: (overrides.healthScore ?? { sectionStatus: {} }) as never,
  } as unknown as Parameters<typeof buildDataQuality>[0];
}

function rowsOf(section: ReturnType<typeof buildDataQuality>): Record<string, DQRow> {
  const out: Record<string, DQRow> = {};
  for (const r of section.sectionData.rows as DQRow[]) out[r.area] = r;
  return out;
}

describe('item 4 — entered-but-unconfirmed data is no longer reported as Missing', () => {
  it("does not report any of the reviewer's four populated sections as Missing", () => {
    const rows = rowsOf(buildDataQuality(reviewerSource()));
    for (const area of ['Assets', 'Liabilities', 'Investments', 'Retirement']) {
      expect(rows[area].status, `${area} must not be Missing`).not.toBe('missing');
      expect(DATA_QUALITY_STATUS_LABELS[rows[area].status as 'in_progress']).toBe('In progress');
    }
  });

  it('populates Last Updated from the real record timestamp, not "Not provided"', () => {
    const rows = rowsOf(buildDataQuality(reviewerSource()));
    for (const area of ['Assets', 'Liabilities', 'Investments', 'Retirement']) {
      expect(rows[area].lastUpdated).toBe(RECENT);
    }
  });

  it('includes that data in the report rather than excluding it', () => {
    const rows = rowsOf(buildDataQuality(reviewerSource()));
    expect(rows.Assets.reportTreatment).toContain('Included');
    expect(rows.Assets.reportTreatment).not.toContain('Not included');
  });

  it('raises the completion percentage above the reported 29%', () => {
    const before = 2 / 7; // what the reviewer saw: only Income + Expenses counted
    const pct = buildDataQuality(reviewerSource()).sectionData.dataCompletenessPct as number;
    expect(pct).toBeGreaterThan(before * 100);
    // 6 populated sections, insurance genuinely empty.
    expect(pct).toBeCloseTo(((6 * IN_PROGRESS_COMPLETENESS_WEIGHT) / 7) * 100, 6);
    expect(Math.round(pct)).toBe(86);
  });

  it('never LOWERS the percentage for a household that has entered data but confirmed nothing', () => {
    // Before this change a populated section counted as 'complete' whatever
    // its confirmation state. An income+expenses-only household read 29%; it
    // must still read 29%, not less, now that those rows read "In progress".
    const incomeExpensesOnly = buildDataQuality(
      reviewerSource({
        dashboard: { hasIncome: true, hasExpenses: true, hasAssets: false, hasLiabilities: false, hasInvestments: false, hasRetirement: false, hasInsurance: false },
        dataFreshness: { income: RECENT, expenses: RECENT, assets: null, liabilities: null, investments: null, retirement: null, insurance: null },
      })
    );
    expect(Math.round(incomeExpensesOnly.sectionData.dataCompletenessPct as number)).toBe(29);
  });

  it('still tells the household something is outstanding while sections are unconfirmed', () => {
    expect(buildDataQuality(reviewerSource()).narrativeText).toContain('partial');
  });

  it('reaches full marks once the household confirms each section is complete', () => {
    const confirmed = reviewerSource({
      healthScore: {
        sectionStatus: {
          income: 'reviewed_with_data',
          expenses: 'reviewed_with_data',
          assets: 'reviewed_with_data',
          liabilities: 'reviewed_with_data',
          investments: 'reviewed_with_data',
          retirement: 'reviewed_with_data',
          insurance: 'reviewed_zero',
        },
      },
    });
    const section = buildDataQuality(confirmed);
    expect(section.sectionData.dataCompletenessPct).toBe(100);
    expect(rowsOf(section).Assets.status).toBe('complete');
  });

  it('still reports a genuinely empty register as Missing — the reserved meaning', () => {
    const rows = rowsOf(buildDataQuality(reviewerSource()));
    expect(rows.Insurance.status).toBe('missing');
    expect(rows.Insurance.lastUpdated).toBeNull();
    expect(rows.Insurance.reportTreatment).toBe('Not included — not treated as zero');
  });

  it('closes the Assets "Complete / Not provided" contradiction', () => {
    // dashboard.hasAssets is deliberately true when investments OR retirement
    // rows exist, so it used to claim Assets was Complete for a household with
    // no assets register at all — beside a blank Last Updated.
    const rows = rowsOf(
      buildDataQuality(
        reviewerSource({
          dataFreshness: { income: RECENT, expenses: RECENT, assets: null, liabilities: RECENT, investments: RECENT, retirement: RECENT, insurance: null },
        })
      )
    );
    expect(rows.Assets.status).toBe('missing');
    expect(rows.Assets.lastUpdated).toBeNull();
  });

  it('a confirmed-zero section is still counted, and still not called Missing', () => {
    const rows = rowsOf(buildDataQuality(reviewerSource({ healthScore: { sectionStatus: { insurance: 'reviewed_zero' } } })));
    expect(rows.Insurance.status).toBe('confirmed_zero');
  });

  it('flags a register whose rows are all SMSF-owned rather than claiming they are in the household figures', () => {
    const rows = rowsOf(
      buildDataQuality(reviewerSource({ dashboard: { hasIncome: false, hasExpenses: true, hasAssets: true, hasLiabilities: true, hasInvestments: true, hasRetirement: true, hasInsurance: false } }))
    );
    expect(rows.Income.status).toBe('in_progress');
    expect(rows.Income.reportTreatment).toContain('SMSF-owned');
  });

  it('stale data still overrides everything else', () => {
    const old = '2019-01-01T00:00:00.000Z';
    const rows = rowsOf(
      buildDataQuality(
        reviewerSource({ dataFreshness: { income: old, expenses: RECENT, assets: RECENT, liabilities: RECENT, investments: RECENT, retirement: RECENT, insurance: null } })
      )
    );
    expect(rows.Income.status).toBe('stale');
  });
});
