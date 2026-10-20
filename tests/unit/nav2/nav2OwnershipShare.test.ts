// NAV2: the signed-in user's OWN SHARE of a jointly held fund (PO decision 06-10-2026: SHARE, never the whole holding).
//
// HAND-WRITTEN ORACLE (nothing here is computed by the code under test): a joint holding of 10,000 units at NAV 100 (value 1,000,000), money put in
// 800,000 on 05-01-2025 and nothing taken out, owned 60 / 40 by Self and Spouse.
//   Self   : units 6,000  value 600,000  put in 480,000  gain 120,000
//   Spouse : units 4,000  value 400,000  put in 320,000  gain  80,000
//   Both together 1,000,000, never 2,000,000; never the whole 1,000,000 for either.
//
// NAMED NEGATIVE CONTROLS
//   NC-O1  an implementation that leaks the FULL value (the old behaviour) fails the oracle, so the oracle can fail;
//   NC-O2  a missing, incomplete or unknown allocation is never guessed: "ownership share not set", investor figures withheld;
//   NC-O3  an entity (trust, HUF, company) folio is never counted in the personal figures; a joint folio the user does not own is not the user's;
//   NC-O4  a changed allocation changes the pinned manifest (the ownership block and the transaction version).
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import FundAnalyticsPrintDocument from '@/components/reports/FundAnalyticsPrintDocument';
import FundAnalyticsReportView from '@/components/reports/FundAnalyticsReportView';
import { NAV2_POLICY } from '@/lib/config/nav2/metricPolicy';
import { reportAnalysisSpec } from '@/lib/engines/nav2/analysisSpec';
import { buildFundAnalyticsReport, type FundAnalyticsInput, type HeldSchemeInput } from '@/lib/engines/nav2/fundAnalyticsReport';
import { computeInvestorExperience, type InvestorExperienceInput, type ValuationView } from '@/lib/engines/nav2/investorExperience';
import { combineInvestorInputs, decideAccount, ownershipSentence, percentLabel, shareOfInvestorInput, type ShareAllocationRef } from '@/lib/engines/nav2/ownershipShare';
import { loadOwnershipShares } from '@/lib/services/investment-intelligence/nav2/ownershipShareLoader';
import type { OwnerClassContext } from '@/lib/services/investment-intelligence/ownerClass';
import type { AccountOwnership } from '@/lib/services/investment-intelligence/ownerModel';
import { createInMemoryDb } from '../support/inMemorySupabase';
import { buildSeries, ctxInr, pathFromReturns, weekdays } from './support/fixtures';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const SELF = 'member-self';
const SPOUSE = 'member-spouse';
const AS_OF = '2026-10-01';

const valuation: ValuationView = { basis: 'market_nav', units: 10000, marketValue: 1_000_000, valuationDate: AS_OF, stale: false, nav: 100, navDate: AS_OF };
const whole: InvestorExperienceInput = { instrumentId: 'fund-1', flows: [{ date: utc('2025-01-05'), amount: -800_000 }], valuation, asOfDate: AS_OF };
const alloc = (memberId: string, bp: number, other: string): ShareAllocationRef => ({ accountId: 'acc-j', memberId, basisPoints: bp, allShares: [{ memberId: SELF, basisPoints: memberId === SELF ? bp : 10000 - bp }, { memberId: other, basisPoints: memberId === SELF ? 10000 - bp : bp }].filter((s, i, a) => a.findIndex((x) => x.memberId === s.memberId) === i) });
const selfAlloc = (bp: number): ShareAllocationRef => ({ accountId: 'acc-j', memberId: SELF, basisPoints: bp, allShares: [{ memberId: SELF, basisPoints: bp }, { memberId: SPOUSE, basisPoints: 10000 - bp }] });
const spouseAlloc = (bp: number): ShareAllocationRef => ({ accountId: 'acc-j', memberId: SPOUSE, basisPoints: 10000 - bp, allShares: [{ memberId: SELF, basisPoints: bp }, { memberId: SPOUSE, basisPoints: 10000 - bp }] });
void alloc;

const figures = (i: InvestorExperienceInput) => {
  const ie = computeInvestorExperience(i, ctxInr());
  return {
    units: i.valuation.units,
    value: ie.currentValue.state === 'available' ? ie.currentValue.value.value : null,
    invested: ie.investedAmount.state === 'available' ? ie.investedAmount.value.invested : null,
    received: ie.investedAmount.state === 'available' ? ie.investedAmount.value.received : null,
    gain: ie.gainLoss.state === 'available' ? ie.gainLoss.value.gainLoss : null,
    xirr: ie.xirr.state === 'available' ? ie.xirr.value.rate : null,
  };
};

/** The oracle, written by hand. Throws when a figure is wrong. */
function assertSelfOracle(i: InvestorExperienceInput | null) {
  expect(i).not.toBeNull();
  const f = figures(i as InvestorExperienceInput);
  expect(f.units).toBe(6000);
  expect(f.value).toBe(600_000);
  expect(f.invested).toBe(480_000);
  expect(f.received).toBe(0);
  expect(f.gain).toBe(120_000);
}

describe('the oracle: 1,000,000 at 60/40', () => {
  it('Self sees 600,000 and Spouse 400,000; together 1,000,000, never 2,000,000, never 1,000,000 each', () => {
    const self = shareOfInvestorInput(whole, selfAlloc(6000));
    const spouse = shareOfInvestorInput(whole, spouseAlloc(6000));
    assertSelfOracle(self);
    const s = figures(spouse as InvestorExperienceInput);
    expect(s).toMatchObject({ units: 4000, value: 400_000, invested: 320_000, received: 0, gain: 80_000 });
    expect(figures(self as InvestorExperienceInput).value! + s.value!).toBe(1_000_000);
    expect(figures(self as InvestorExperienceInput).value).not.toBe(1_000_000);
    expect(figures(self as InvestorExperienceInput).value! + s.value!).not.toBe(2_000_000);
  });

  it('a 50/50 holding shows half, and 33.33% shows as such', () => {
    expect(figures(shareOfInvestorInput(whole, selfAlloc(5000)) as InvestorExperienceInput).value).toBe(500_000);
    expect(percentLabel(5000)).toBe('50%');
    expect(percentLabel(6000)).toBe('60%');
    expect(percentLabel(3333)).toBe('33.33%');
  });

  it('NC-O1: an implementation that leaks the FULL value fails the oracle (so the oracle can fail)', () => {
    const leaky = (i: InvestorExperienceInput) => i; // the old behaviour: the whole holding
    expect(() => assertSelfOracle(leaky(whole))).toThrow();
    expect(figures(leaky(whole)).value).toBe(1_000_000);
  });

  it('XIRR is worked out on the user\'s share of every cash flow and of the terminal value, and equals the whole-holding XIRR when the flows are strictly proportional', () => {
    const flows = [
      { date: utc('2023-01-05'), amount: -300_000 },
      { date: utc('2024-01-05'), amount: -300_000 },
      { date: utc('2024-09-05'), amount: 100_000 },
      { date: utc('2025-01-05'), amount: -300_000 },
    ];
    const w: InvestorExperienceInput = { ...whole, flows };
    const wholeX = figures(w).xirr;
    const selfX = figures(shareOfInvestorInput(w, selfAlloc(6000)) as InvestorExperienceInput).xirr;
    const spouseX = figures(shareOfInvestorInput(w, spouseAlloc(6000)) as InvestorExperienceInput).xirr;
    expect(wholeX).not.toBeNull();
    expect(selfX).toBeCloseTo(wholeX as number, 10);
    expect(spouseX).toBeCloseTo(wholeX as number, 10);
    // the flows really were scaled (not just the rate copied): 60% of each
    const scaled = shareOfInvestorInput(w, selfAlloc(6000))!;
    expect(scaled.flows.map((f) => f.amount)).toEqual([-180_000, -180_000, 60_000, -180_000]);
  });

  it('the shares add back to the whole exactly even when the split does not divide evenly (largest remainder, existing attributeByBasisPoints)', () => {
    const odd: InvestorExperienceInput = { ...whole, flows: [{ date: utc('2025-01-05'), amount: -100.01 }] };
    const a = shareOfInvestorInput(odd, selfAlloc(3333))!.flows[0].amount;
    const b = shareOfInvestorInput(odd, spouseAlloc(3333))!.flows[0].amount;
    expect(Math.round((a + b) * 10000) / 10000).toBe(-100.01);
  });

  it('an invalid split is never trusted: no figure, not a guess', () => {
    const bad: ShareAllocationRef = { accountId: 'x', memberId: SELF, basisPoints: 6000, allShares: [{ memberId: SELF, basisPoints: 6000 }, { memberId: SPOUSE, basisPoints: 3000 }] };
    expect(shareOfInvestorInput(whole, bad)).toBeNull();
  });
});

describe('which folios count for the user (NC-O2, NC-O3)', () => {
  const own = (kind: 'member' | 'joint' | 'entity', shares: Array<{ memberId?: string; businessEntityId?: string; basisPoints: number }>, hasEntity = false): AccountOwnership => ({ kind, shares, hasEntity });
  it('a sole member folio counts in full; a joint folio at the user\'s share', () => {
    expect(decideAccount('a', own('member', [{ memberId: SELF, basisPoints: 10000 }]), SELF)).toEqual({ kind: 'sole' });
    const d = decideAccount('b', own('joint', [{ memberId: SELF, basisPoints: 6000 }, { memberId: SPOUSE, basisPoints: 4000 }]), SELF);
    expect(d).toMatchObject({ kind: 'joint', allocation: { memberId: SELF, basisPoints: 6000 } });
  });
  it('NC-O2: no owner, an incomplete split or an unknown own member are NOT guessed: ownership share not set', () => {
    expect(decideAccount('a', { kind: 'unassigned' }, SELF)).toEqual({ kind: 'not_set' });
    expect(decideAccount('b', own('joint', [{ memberId: SELF, basisPoints: 6000 }, { memberId: SPOUSE, basisPoints: 4000 }]), null)).toEqual({ kind: 'not_set' });
  });
  it('NC-O3: a trust / HUF / company folio, and a joint folio that includes an entity, are not personal; a joint folio the user does not own is not the user\'s', () => {
    expect(decideAccount('a', own('entity', [{ businessEntityId: 'trust-1', basisPoints: 10000 }], true), SELF)).toEqual({ kind: 'entity' });
    expect(decideAccount('b', own('joint', [{ memberId: SELF, basisPoints: 5000 }, { businessEntityId: 'co-1', basisPoints: 5000 }], true), SELF)).toEqual({ kind: 'entity' });
    expect(decideAccount('c', own('joint', [{ memberId: SPOUSE, basisPoints: 5000 }, { memberId: 'member-child', basisPoints: 5000 }]), SELF)).toEqual({ kind: 'not_yours' });
  });
});

describe('the wording', () => {
  it('"Your share: 50% of a joint holding." and the not-set sentence', () => {
    const base = { jointBasisPoints: 5000, selfMemberId: SELF, jointFolios: [], soleFolios: 0, notSetFolios: 0, notYoursFolios: 0 };
    expect(ownershipSentence({ ...base, mode: 'share' })).toBe('Your share: 50% of a joint holding.');
    expect(ownershipSentence({ ...base, mode: 'share', jointBasisPoints: 6000 })).toBe('Your share: 60% of a joint holding.');
    expect(ownershipSentence({ ...base, mode: 'not_set', jointBasisPoints: null })).toMatch(/^Ownership share not set/);
    expect(ownershipSentence({ ...base, mode: 'sole', jointBasisPoints: null })).toBeNull();
  });
});

// ---- through the report builder and the two renderings ---------------------------------------------------------------------------
const DATES = weekdays('2024-10-01', 520);
const navs = pathFromReturns(100, DATES.slice(1).map((_, i) => 0.0004 + 0.01 * Math.sin(i * 0.37)));
function held(over: Partial<HeldSchemeInput>): HeldSchemeInput {
  return {
    instrumentId: 'fund-1', schemeName: 'Alpha Fund', planType: 'direct', optionType: 'growth', category: 'flexi_cap', categoryLabel: 'Flexi Cap',
    series: buildSeries(DATES, navs, { identity: { instrumentId: 'fund-1', schemeName: 'Alpha Fund' }, asOf: AS_OF }),
    benchmarks: [], investor: whole, firstHeldDate: '2025-01-05', ...over,
  };
}
const input = (h: HeldSchemeInput): FundAnalyticsInput => ({
  asOfDate: AS_OF, displayCurrency: 'INR', policy: NAV2_POLICY, spec: reportAnalysisSpec(AS_OF, NAV2_POLICY, 'since_first_held'), periodChoice: 'since_first_held', riskFree: null, schemes: [h],
  scope: { entityHeldSchemesExcluded: 0, otherInstrumentsExcluded: 0, statementLinesAwaitingReview: 0, priceHistoryUnavailable: [] },
});
const shareOwnership = (bp: number) => ({ mode: 'share' as const, jointBasisPoints: bp, selfMemberId: SELF, jointFolios: [{ memberId: SELF, basisPoints: bp, allocationGroup: 'group-1' }], soleFolios: 0, notSetFolios: 0, notYoursFolios: 0 });

describe('the report, the manifest and the two renderings', () => {
  const at = (bp: number) => buildFundAnalyticsReport(input(held({ investor: shareOfInvestorInput(whole, selfAlloc(bp)), ownership: shareOwnership(bp) })));

  it('the report carries the share: the investor figures are the user\'s, the fund\'s own figures are unchanged', () => {
    const six = at(6000);
    const full = buildFundAnalyticsReport(input(held({})));
    const inv = six.report.schemes[0].analytics.investor!;
    expect(inv.currentValue.state === 'available' && inv.currentValue.value.value).toBe(600_000);
    expect(six.report.schemes[0].ownership?.jointBasisPoints).toBe(6000);
    // fund-level performance does not depend on who owns how much of it
    expect(JSON.stringify(six.report.schemes[0].analytics.scheme)).toBe(JSON.stringify(full.report.schemes[0].analytics.scheme));
  });

  it('NC-O4: the allocation (member, basis points, allocation group) is pinned in the manifest, and a changed allocation changes the manifest and its transaction version', () => {
    const a = at(6000).manifest.schemes[0];
    const b = at(5000).manifest.schemes[0];
    expect(a.ownership).toMatchObject({ mode: 'share', jointBasisPoints: 6000, selfMemberId: SELF, jointFolios: [{ memberId: SELF, basisPoints: 6000, allocationGroup: 'group-1' }] });
    expect(b.ownership?.jointBasisPoints).toBe(5000);
    expect(a.transactionVersion).not.toBe(b.transactionVersion);
  });

  it('a fund held only in the user\'s own name has no ownership block (nothing changes for the usual case)', () => {
    const plain = buildFundAnalyticsReport(input(held({})));
    expect(plain.report.schemes[0].ownership).toBeUndefined();
    expect(plain.manifest.schemes[0].ownership).toBeNull();
  });

  it('the page and the PDF both say "Your share: 60% of a joint holding." and the cover names the share beside the fund', () => {
    const { report } = at(6000);
    const page = renderToStaticMarkup(createElement(FundAnalyticsReportView, { report }));
    const doc = renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report, version: { versionNumber: 1, createdAt: '2026-10-06T03:00:00.000Z' } }));
    expect(page).toContain('Your share: 60% of a joint holding.');
    expect(doc).toContain('Your share: 60% of a joint holding.');
    expect(doc).toContain('Alpha Fund (your share 60%)');
  });

  it('NC-O2 rendered: a holding whose share is not set is shown with "Ownership share not set", without the user\'s figures, never the full value', () => {
    const { report } = buildFundAnalyticsReport(input(held({ investor: null, ownership: { mode: 'not_set', jointBasisPoints: null, selfMemberId: SELF, jointFolios: [], soleFolios: 0, notSetFolios: 1, notYoursFolios: 0 } })));
    const page = renderToStaticMarkup(createElement(FundAnalyticsReportView, { report }));
    const doc = renderToStaticMarkup(createElement(FundAnalyticsPrintDocument, { report, version: { versionNumber: 1, createdAt: '2026-10-06T03:00:00.000Z' } }));
    for (const html of [page, doc]) {
      expect(html).toContain('Ownership share not set');
      expect(html).not.toContain('10,00,000');
    }
    expect(doc).toContain('Alpha Fund (ownership share not set)');
    expect(report.schemes[0].analytics.investor).toBeNull();
  });
});

describe('combining the folios of one fund', () => {
  it('a sole folio (100%) plus a joint folio (60%) add up; flows and units are summed', () => {
    const sole: InvestorExperienceInput = { instrumentId: 'fund-1', flows: [{ date: utc('2024-01-05'), amount: -50_000 }], valuation: { ...valuation, units: 500, marketValue: 50_000 }, asOfDate: AS_OF };
    const joint = shareOfInvestorInput(whole, selfAlloc(6000))!;
    const c = combineInvestorInputs([sole, joint])!;
    expect(c.valuation.units).toBe(6500);
    expect(c.valuation.marketValue).toBe(650_000);
    expect(c.flows.map((f) => f.amount).sort((a, b) => a - b)).toEqual([-480_000, -50_000]);
  });
});

// ---- the loader, with the ownership read model's context and a stand-in for the certified dataset loader ---------------------------
describe('loadOwnershipShares (NC-O2, NC-O3 end to end)', () => {
  const soleOwn: AccountOwnership = { kind: 'member', shares: [{ memberId: SELF, basisPoints: 10000 }], hasEntity: false };
  const jointOwn: AccountOwnership = { kind: 'joint', shares: [{ memberId: SELF, basisPoints: 6000 }, { memberId: SPOUSE, basisPoints: 4000 }], hasEntity: false };
  const unset: AccountOwnership = { kind: 'unassigned' };
  const ctxOf = (accounts: Array<{ id: string; ownership: AccountOwnership }>): OwnerClassContext => ({ accounts, labels: { member: () => undefined, entity: () => undefined }, accountIdsByClass: new Map(), classes: [], allocationGroupByAccount: new Map([['acc-j', 'group-7']]) });

  async function run(accounts: Array<{ id: string; ownership: AccountOwnership }>, holdings: Array<{ account_id: string; instrument_id: string }>) {
    const db = createInMemoryDb({});
    db.reset({ household_members: [{ id: SELF, user_id: 'u', relationship: 'self' }], ii_holding_snapshots: holdings.map((h) => ({ ...h, user_id: 'u' })), ii_transactions: [], ii_accounts: accounts.map((a) => ({ id: a.id, user_id: 'u' })) });
    return loadOwnershipShares(
      { sessionClient: db.client as unknown as SupabaseClient, userId: 'u', ctx: ctxOf(accounts) },
      {
        // the certified loader, replaced by a stand-in that returns the WHOLE holding of whatever accounts it is scoped to
        loadDataset: async (c) => {
          const ids = ((await (c as unknown as { from: (t: string) => { select: (s: string) => Promise<{ data: Array<{ id: string }> }> } }).from('ii_accounts').select('id')).data ?? []).map((r) => r.id);
          return { schemes: ids.map((id) => ({ instrumentId: 'fund-1', accountId: id })) as never };
        },
        investorInputFor: () => whole,
      }
    );
  }

  it('sole + joint(60%): the user\'s figures are the sole folio in full plus 60% of the joint folio', async () => {
    const r = await run([{ id: 'acc-s', ownership: soleOwn }, { id: 'acc-j', ownership: jointOwn }], [{ account_id: 'acc-s', instrument_id: 'fund-1' }, { account_id: 'acc-j', instrument_id: 'fund-1' }]);
    const got = r.byInstrument.get('fund-1')!;
    expect(r.special).toBe(true);
    expect(got.investor!.valuation.marketValue).toBe(1_000_000 + 600_000);
    expect(got.ownership).toMatchObject({ mode: 'share', jointBasisPoints: 6000, soleFolios: 1, jointFolios: [{ allocationGroup: 'group-7', basisPoints: 6000 }] });
  });

  it('only the joint folio: exactly 600,000, never 1,000,000', async () => {
    const r = await run([{ id: 'acc-j', ownership: jointOwn }], [{ account_id: 'acc-j', instrument_id: 'fund-1' }]);
    expect(r.byInstrument.get('fund-1')!.investor!.valuation.marketValue).toBe(600_000);
  });

  it('NC-O2: an unassigned folio only: investor figures withheld (null) and the state is not_set, never the full value', async () => {
    const r = await run([{ id: 'acc-u', ownership: unset }], [{ account_id: 'acc-u', instrument_id: 'fund-1' }]);
    const got = r.byInstrument.get('fund-1')!;
    expect(got.investor).toBeNull();
    expect(got.ownership).toMatchObject({ mode: 'not_set', notSetFolios: 1 });
  });

  it('a sole folio plus an unassigned folio: the sole folio is counted, the unassigned one is left out and said so', async () => {
    const r = await run([{ id: 'acc-s', ownership: soleOwn }, { id: 'acc-u', ownership: unset }], [{ account_id: 'acc-s', instrument_id: 'fund-1' }, { account_id: 'acc-u', instrument_id: 'fund-1' }]);
    const got = r.byInstrument.get('fund-1')!;
    expect(got.investor!.valuation.marketValue).toBe(1_000_000);
    expect(got.ownership).toMatchObject({ mode: 'sole', notSetFolios: 1 });
    expect(ownershipSentence(got.ownership)).toMatch(/no owner share set|owner share is not set|not set/);
  });

  it('when every folio is held by a sole member nothing special happens (no second load)', async () => {
    const r = await run([{ id: 'acc-s', ownership: soleOwn }], [{ account_id: 'acc-s', instrument_id: 'fund-1' }]);
    expect(r.special).toBe(false);
  });
});
