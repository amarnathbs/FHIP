// Net Worth follows the latest eligible NAV for published mutual funds (PO
// decision 2026-10-01). Drives the REAL re-mark service
// (lib/services/investment-intelligence/publishedValueRemark.ts) and the REAL
// planner (lib/engines/investment-intelligence/valuation/publishedRowRemark.ts,
// which delegates the NAV rule to the shared currentHoldingValuation.ts) against
// a filtering, call-counting in-memory Supabase double.
//
// NEGATIVE CONTROLS. Every rule is a `check` function. It is run against the real
// code (must pass) AND against one or more deliberately BROKEN variants (must throw
// that rule's own named message). A broken variant is either a wrapper around the
// real planner that models the specific bug (e.g. "ignores NAV", "uses the later
// statement's units") or a database double that drops the guard the code relies
// on (e.g. ignores the user_id / source_type / fingerprint filter). A green control
// would be indistinguishable from one that never applied, so each is required to
// fail with its named assertion.
//
// ORACLE (hand-computed): hold 100 units; statement 2026-06-30 value 10,000 (NAV
// 100); latest eligible NAV 112 on 2026-09-30 => Net Worth contribution 11,200 dated
// 2026-09-30; a later correction of that NAV to 111 => 11,100.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeFakeDb, type FakeDb, type Row } from './support/remarkFakeDb';
import { addPosition, emptyTables, oracleTables, row, TODAY, USER, OTHER_USER } from './support/remarkScenario';
import { computeDashboard, type DashboardInput } from '@/lib/engines/dashboard';
import { computeInvestments } from '@/lib/read-models/investments';
import { fxContext } from '@/lib/read-models/core/currency';

const PLANNER_PATH = '@/lib/engines/investment-intelligence/valuation/publishedRowRemark';
type Planner = typeof import('@/lib/engines/investment-intelligence/valuation/publishedRowRemark').planRowRemark;

const hoisted = vi.hoisted(() => ({ planner: null as null | ((...a: unknown[]) => unknown) }));
vi.mock('@/lib/engines/investment-intelligence/valuation/publishedRowRemark', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/engines/investment-intelligence/valuation/publishedRowRemark')>();
  return { ...actual, planRowRemark: (...a: Parameters<typeof actual.planRowRemark>) => (hoisted.planner ? hoisted.planner(...a) : actual.planRowRemark(...a)) };
});

import { remarkPublishedInvestments, type RemarkRevisionRecord, type RemarkSummary } from '@/lib/services/investment-intelligence/publishedValueRemark';

const real = await vi.importActual<typeof import('@/lib/engines/investment-intelligence/valuation/publishedRowRemark')>(PLANNER_PATH);
const realPlan: Planner = real.planRowRemark;

type RemarkInput = Parameters<Planner>[0];
type NavRows = Parameters<Planner>[1];

beforeEach(() => {
  hoisted.planner = null;
});
afterEach(() => {
  hoisted.planner = null;
});

// ---------------------------------------------------------------------------
// Broken planner variants (each models one specific bug).
// ---------------------------------------------------------------------------
type Variant =
  | 'real'
  | 'no_nav' // ignores every NAV: the old frozen statement value
  | 'no_eligibility' // lets future / wrong-currency / flagged / zero NAVs through
  | 'later_units' // takes units from the later, unpublished statement
  | 'resurrect_redeemed' // prices a 0-unit holding as if it still had units
  | 'entity_blind' // values entity-owned accounts into personal Net Worth
  | 'always_update' // never recognises an unchanged value
  | 'sticky' // never lets a NAV correction replace the first value
  | 'statement_as_market' // labels a statement value as a market NAV
  | 'equity_priced' // NAV-prices a non-mutual-fund
  | 'no_movements'; // ignores units transacted after the statement

function plannerFor(v: Variant): ((...a: unknown[]) => unknown) | null {
  switch (v) {
    case 'real':
      return null;
    case 'no_nav':
      return (row, _navs, asOf) => realPlan(row as RemarkInput, [], asOf as string);
    case 'no_eligibility':
      return (row, navs, asOf) => {
        const r = row as RemarkInput;
        const clamped = (navs as NavRows).map((n) => ({ ...n, date: n.date > (asOf as string) ? (asOf as string) : n.date, qualityStatus: 'ok', currencyCode: r.rowCurrency, price: n.price > 0 ? n.price : 1 }));
        return realPlan(r, clamped, asOf as string);
      };
    case 'later_units':
      return (row, navs, asOf) => {
        const r = row as RemarkInput;
        return realPlan({ ...r, certified: r.certified ? { ...r.certified, units: 150 } : r.certified }, navs as NavRows, asOf as string);
      };
    case 'resurrect_redeemed':
      return (row, navs, asOf) => {
        const r = row as RemarkInput;
        return realPlan({ ...r, certified: r.certified && r.certified.units === 0 ? { ...r.certified, units: 100 } : r.certified }, navs as NavRows, asOf as string);
      };
    case 'entity_blind':
      return (row, navs, asOf) => realPlan({ ...(row as RemarkInput), entityOwned: false }, navs as NavRows, asOf as string);
    case 'always_update':
      return (row, navs, asOf) => realPlan({ ...(row as RemarkInput), previous: { ...(row as RemarkInput).previous, fingerprint: `forced-${Math.random()}` } }, navs as NavRows, asOf as string);
    case 'sticky':
      return (row, navs, asOf) => {
        const r = row as RemarkInput;
        if (r.previous.fingerprint !== null) return { action: 'unchanged', fingerprint: r.previous.fingerprint };
        return realPlan(r, navs as NavRows, asOf as string);
      };
    case 'statement_as_market':
      return (row, navs, asOf) => {
        const p = realPlan(row as RemarkInput, navs as NavRows, asOf as string);
        return p.action === 'update' ? { ...p, columns: { ...p.columns, ii_valuation_basis: 'market_nav' as const } } : p;
      };
    case 'equity_priced':
      return (row, navs, asOf) => realPlan({ ...(row as RemarkInput), instrumentClass: 'mutual_fund' }, navs as NavRows, asOf as string);
    case 'no_movements':
      return (row, navs, asOf) => realPlan({ ...(row as RemarkInput), unitMovements: [] }, navs as NavRows, asOf as string);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
interface Run {
  db: FakeDb;
  revisions: RemarkRevisionRecord[];
  summary: RemarkSummary;
}

async function remark(tables: Record<string, Row[]>, variant: Variant = 'real', dbOpts: Parameters<typeof makeFakeDb>[1] = {}, user = USER): Promise<Run> {
  hoisted.planner = plannerFor(variant);
  const db = makeFakeDb(tables, dbOpts);
  const revisions: RemarkRevisionRecord[] = [];
  const summary = await remarkPublishedInvestments(user, {
    client: db.client,
    trigger: 'manual',
    asOfDate: TODAY,
    revisionWriter: async (r) => {
      revisions.push(r);
      return { error: null };
    },
  });
  return { db, revisions, summary };
}

/** Net Worth as the engine computes it from the register rows (INR household). */
function netWorthOf(tables: Record<string, Row[]>, user = USER): number {
  const investments = tables.investments
    .filter((r) => r.user_id === user && r.is_active === true)
    .map((r) => ({ current_value: Number(r.current_value), cost_base: null, investment_type: 'managed_fund', master_item_key: 'managed_funds', country_code: 'IN', annual_contribution: null, institution: r.institution as string, currency_code: r.currency_code as string }));
  const input: DashboardInput = { income: [], expenses: [], assets: [], liabilities: [], investments, retirement: [], insurance: [], goals: [], snapshots: [] };
  return computeDashboard(input, 'INR', 56).netWorth;
}

const fail = (rule: string, msg: string): never => {
  throw new Error(`${rule}: ${msg}`);
};

interface Rule {
  name: string;
  /** Regexp the broken variant's failure must match (the rule's own named message). */
  message: RegExp;
  controls: Array<{ variant: Variant; dbOpts?: Parameters<typeof makeFakeDb>[1] }>;
  check: (variant: Variant, dbOpts?: Parameters<typeof makeFakeDb>[1]) => Promise<void>;
}

const RULES: Rule[] = [
  // -------------------------------------------------------------------------
  {
    name: 'RULE-1 Net Worth = units x latest eligible NAV (oracle 100 x 112 = 11,200, dated 2026-09-30); the publication keeps the certified statement value',
    message: /RULE-1:/,
    controls: [{ variant: 'no_nav' }, { variant: 'later_units' }],
    async check(variant) {
      const t = oracleTables([{ date: '2026-09-30', price: 112 }]);
      t.ii_holding_snapshots.push({ id: 'snap-later-a', user_id: USER, account_id: 'acc-a', instrument_id: 'inst-a', as_of_date: '2026-09-15', units: 150, value: 17000, currency_code: 'INR' });
      await remark(t, variant);
      const r = row(t, 'inv-a');
      if (r.current_value !== 11200) fail('RULE-1', `Net Worth must be units x latest NAV (expected 11200, got ${String(r.current_value)})`);
      if (r.ii_valuation_basis !== 'market_nav' || r.ii_value_as_of !== '2026-09-30' || r.ii_valuation_nav !== 112 || r.ii_valuation_units !== 100) {
        fail('RULE-1', `the NAV, its date and the units must be recorded (got ${JSON.stringify([r.ii_valuation_basis, r.ii_value_as_of, r.ii_valuation_nav, r.ii_valuation_units])})`);
      }
      if (netWorthOf(t) !== 11200) fail('RULE-1', `the Dashboard engine must read 11200 (got ${netWorthOf(t)})`);
      const pub = t.ii_fhip_publications[0];
      if (pub.published_value !== 10000) fail('RULE-1', `the publication must keep the certified statement value 10000 as evidence (got ${String(pub.published_value)})`);
    },
  },
  // -------------------------------------------------------------------------
  {
    name: 'RULE-2 a NAV correction supersedes (112 -> 111 on the same date): 11,200 -> 11,100, with revision history',
    message: /RULE-2:/,
    controls: [{ variant: 'sticky' }],
    async check(variant) {
      const t = oracleTables([{ date: '2026-09-30', price: 112 }]);
      const first = await remark(t, 'real');
      if (first.revisions.length !== 1 || first.revisions[0].reason !== 'baseline' || first.revisions[0].previous_value !== 10000 || first.revisions[0].new_value !== 11200) {
        fail('RULE-2', `first re-mark must record one baseline revision 10000 -> 11200 (got ${JSON.stringify(first.revisions)})`);
      }
      // The source corrects the 2026-09-30 NAV in place (ii_prices_nav is unique on instrument+date).
      t.ii_prices_nav[0].price = 111;
      const second = await remark(t, variant);
      const r = row(t, 'inv-a');
      if (r.current_value !== 11100) fail('RULE-2', `a corrected NAV must supersede the prior one (expected 11100, got ${String(r.current_value)})`);
      const rev = second.revisions[0];
      if (!rev || rev.reason !== 'nav_correction' || rev.previous_value !== 11200 || rev.new_value !== 11100 || rev.nav !== 111) {
        fail('RULE-2', `the correction must be recorded as a revision 11200 -> 11100 (got ${JSON.stringify(second.revisions)})`);
      }
    },
  },
  // -------------------------------------------------------------------------
  {
    name: 'RULE-3 a future-dated, wrong-currency, quality-flagged or zero-price NAV never changes Net Worth; the statement value stays, labelled',
    message: /RULE-3:/,
    controls: [{ variant: 'no_eligibility' }],
    async check(variant) {
      const cases: Array<[string, { date: string; price: number; currency?: string; quality?: string }]> = [
        ['future-dated', { date: '2026-10-05', price: 999 }],
        ['wrong-currency', { date: '2026-09-30', price: 50, currency: 'AUD' }],
        ['quality-flagged', { date: '2026-09-30', price: 135, quality: 'stale' }],
        ['zero-price', { date: '2026-09-30', price: 0 }],
      ];
      for (const [label, nav] of cases) {
        const t = oracleTables([nav]);
        await remark(t, variant);
        const r = row(t, 'inv-a');
        if (r.current_value !== 10000 || r.ii_valuation_basis !== 'statement') {
          fail('RULE-3', `a ${label} NAV changed Net Worth (expected 10000 / statement, got ${String(r.current_value)} / ${String(r.ii_valuation_basis)})`);
        }
      }
    },
  },
  // -------------------------------------------------------------------------
  {
    name: 'RULE-4 units come from the position\'s own certified snapshot, never from a later unpublished statement',
    message: /RULE-4:/,
    controls: [{ variant: 'later_units' }],
    async check(variant) {
      const t = oracleTables([{ date: '2026-09-30', price: 112 }]);
      t.ii_holding_snapshots.push({ id: 'snap-later-a', user_id: USER, account_id: 'acc-a', instrument_id: 'inst-a', as_of_date: '2026-09-15', units: 150, value: 17000, currency_code: 'INR' });
      await remark(t, variant);
      const v = row(t, 'inv-a').current_value;
      if (v !== 11200) fail('RULE-4', `Net Worth used units from a later, unpublished statement (expected 100 x 112 = 11200, got ${String(v)})`);
    },
  },
  // -------------------------------------------------------------------------
  {
    name: 'RULE-5 with no newer eligible NAV the certified statement value is used and LABELLED as a statement value',
    message: /RULE-5:/,
    controls: [{ variant: 'statement_as_market' }],
    async check(variant) {
      for (const navs of [[], [{ date: '2026-06-01', price: 90 }], [{ date: '2026-06-30', price: 120 }]]) {
        const t = oracleTables(navs);
        await remark(t, variant);
        const r = row(t, 'inv-a');
        if (r.current_value !== 10000) fail('RULE-5', `the statement value must stand (expected 10000, got ${String(r.current_value)})`);
        if (r.ii_valuation_basis !== 'statement') fail('RULE-5', `a statement value must be labelled as a statement value (got ${String(r.ii_valuation_basis)})`);
        if (r.ii_value_as_of !== '2026-06-30') fail('RULE-5', `the as-of date must be the statement date (got ${String(r.ii_value_as_of)})`);
      }
    },
  },
  // -------------------------------------------------------------------------
  {
    name: 'RULE-6 a redeemed (0 units) holding is worth exactly 0, whatever NAV exists',
    message: /RULE-6:/,
    controls: [{ variant: 'resurrect_redeemed' }],
    async check(variant) {
      const t = oracleTables([{ date: '2026-09-30', price: 112 }], { units: 0, value: 0, rowValue: 10000 });
      await remark(t, variant);
      const r = row(t, 'inv-a');
      if (r.current_value !== 0 || r.ii_valuation_basis !== 'redeemed') fail('RULE-6', `a redeemed holding must be exactly 0 and labelled redeemed (got ${String(r.current_value)} / ${String(r.ii_valuation_basis)})`);
    },
  },
  // -------------------------------------------------------------------------
  {
    name: 'RULE-7 a manual investment is never touched by the re-mark',
    message: /RULE-7:/,
    controls: [{ variant: 'real', dbOpts: { ignoreFilters: ['source_type'] } }],
    async check(variant, dbOpts) {
      const t = oracleTables([{ date: '2026-09-30', price: 112 }]);
      // A MANUAL row (and, to defeat the second guard, an inconsistent active publication pointing at it).
      t.investments.push({ id: 'inv-manual', user_id: USER, is_active: true, source_type: 'manual', investment_name: 'My own fund', current_value: 7777, currency_code: 'INR', ii_valuation_fingerprint: null });
      t.ii_fhip_publications.push({ id: 'pub-manual', user_id: USER, published_row_id: 'inv-manual', canonical_position_id: 'snap-a', account_id: 'acc-a', instrument_id: 'inst-a', status: 'published', publication_target: 'investments', published_value: 10000 });
      const run = await remark(t, variant, dbOpts);
      const m = row(t, 'inv-manual');
      if (m.current_value !== 7777 || m.ii_valuation_basis !== undefined || run.revisions.some((r) => r.investment_id === 'inv-manual')) {
        fail('RULE-7', `a manual investment was changed by the re-mark (value ${String(m.current_value)}, revisions ${run.revisions.filter((r) => r.investment_id === 'inv-manual').length})`);
      }
    },
  },
  // -------------------------------------------------------------------------
  {
    name: 'RULE-8 an entity-owned account (Trust / HUF / Company) is never valued into personal Net Worth',
    message: /RULE-8:/,
    controls: [{ variant: 'entity_blind' }],
    async check(variant) {
      const t = oracleTables([{ date: '2026-09-30', price: 112 }], { allocations: [{ entity: 'entity-trust-1', basisPoints: 10000 }] });
      const run = await remark(t, variant);
      const r = row(t, 'inv-a');
      if (r.current_value !== 10000 || run.summary.skipped.entity_owned !== 1) fail('RULE-8', `an entity-owned account was re-marked into personal Net Worth (value ${String(r.current_value)}, skipped ${JSON.stringify(run.summary.skipped)})`);
    },
  },
  {
    name: 'RULE-8b fail closed: when ownership cannot be read nothing is written',
    message: /RULE-8b:/,
    // The control SWALLOWS the failed read: the entity allocation silently disappears instead of failing the call.
    controls: [{ variant: 'real', dbOpts: { failRead: {} } }],
    async check(variant, dbOpts) {
      const swallowed = dbOpts && 'failRead' in dbOpts;
      const t = oracleTables([{ date: '2026-09-30', price: 112 }], { allocations: swallowed ? [] : [{ entity: 'entity-trust-1', basisPoints: 10000 }] });
      const run = await remark(t, variant, swallowed ? {} : { failRead: { ii_ownership_allocation: { message: 'permission denied' } } });
      if (run.db.updates.length !== 0 || row(t, 'inv-a').current_value !== 10000) fail('RULE-8b', `ownership could not be read, yet ${run.db.updates.length} write(s) happened`);
      if (!swallowed && !run.summary.error) fail('RULE-8b', 'the unreadable-ownership failure must be reported');
    },
  },
  // -------------------------------------------------------------------------
  {
    name: 'RULE-9 idempotent: re-running with unchanged inputs writes nothing and records no new revision',
    message: /RULE-9:/,
    controls: [{ variant: 'always_update' }],
    async check(variant) {
      const t = oracleTables([{ date: '2026-09-30', price: 112 }]);
      await remark(t, 'real');
      const writesBefore = t.investments.length; // register rows must not multiply either
      const again = await remark(t, variant);
      const third = await remark(t, variant);
      if (again.db.updates.length !== 0 || third.db.updates.length !== 0 || again.revisions.length + third.revisions.length !== 0) {
        fail('RULE-9', `re-running the re-mark must not write again (updates ${again.db.updates.length + third.db.updates.length}, revisions ${again.revisions.length + third.revisions.length})`);
      }
      if (t.investments.length !== writesBefore || row(t, 'inv-a').current_value !== 11200) fail('RULE-9', 'the value must stay 11200 and no row may be added');
    },
  },
  // -------------------------------------------------------------------------
  {
    name: 'RULE-10 cross-user isolation: re-marking one user never changes another user\'s register',
    message: /RULE-10:/,
    controls: [{ variant: 'real', dbOpts: { ignoreFilters: ['user_id'] } }],
    async check(variant, dbOpts) {
      const t = oracleTables([{ date: '2026-09-30', price: 112 }]);
      addPosition(t, { id: 'b', user: OTHER_USER, units: 50, value: 5000, instrument: 'inst-a', navs: [] });
      await remark(t, variant, dbOpts);
      const other = row(t, 'inv-b');
      if (other.current_value !== 5000 || other.ii_valuation_basis !== null) fail('RULE-10', `another user's investment was changed (value ${String(other.current_value)}, basis ${String(other.ii_valuation_basis)})`);
      if (row(t, 'inv-a').current_value !== 11200) fail('RULE-10', 'the calling user\'s own row must be re-marked');
    },
  },
  // -------------------------------------------------------------------------
  {
    name: 'RULE-12 only mutual funds are NAV-priced: an equity / ETF keeps its certified value',
    message: /RULE-12:/,
    controls: [{ variant: 'equity_priced' }],
    async check(variant) {
      const t = oracleTables([{ date: '2026-09-30', price: 112 }], { instrumentClass: 'equity' });
      const run = await remark(t, variant);
      if (row(t, 'inv-a').current_value !== 10000 || run.summary.skipped.not_mutual_fund !== 1) fail('RULE-12', `an equity was NAV-priced (value ${String(row(t, 'inv-a').current_value)})`);
    },
  },
  // -------------------------------------------------------------------------
  {
    name: 'RULE-13 units transacted after the certified statement are counted (100 + 20 units at NAV 140 = 16,800)',
    message: /RULE-13:/,
    controls: [{ variant: 'no_movements' }],
    async check(variant) {
      const t = oracleTables([{ date: '2026-09-25', price: 140 }], { movements: [{ type: 'purchase', date: '2026-09-10', units: 20 }] });
      await remark(t, variant);
      const r = row(t, 'inv-a');
      if (r.current_value !== 16800 || r.ii_valuation_units !== 120) fail('RULE-13', `Net Worth must include units added after the statement (expected 120 units / 16800, got ${String(r.ii_valuation_units)} / ${String(r.current_value)})`);
    },
  },
];

describe('Net Worth current-NAV re-mark: every rule passes on the real code and FAILS (by name) on its broken variant', () => {
  for (const rule of RULES) {
    describe(rule.name, () => {
      it('real code satisfies the rule', async () => {
        await expect(rule.check('real')).resolves.toBeUndefined();
      });
      for (const c of rule.controls) {
        it(`NEGATIVE CONTROL (${c.variant}${c.dbOpts ? ' + db guard removed' : ''}) fails with the rule's own message`, async () => {
          await expect(rule.check(c.variant, c.dbOpts)).rejects.toThrow(rule.message);
        });
      }
    });
  }
});

// ===========================================================================
// RULE-11 no N+1: the number of queries does not depend on the number of holdings.
// ===========================================================================
describe('RULE-11 no N+1: queries per re-mark are constant in the number of published holdings', () => {
  /** A naive implementation: one query round trip per holding. */
  async function naive(tables: Record<string, Row[]>): Promise<number> {
    const db = makeFakeDb(tables);
    const rows = (await (db.client.from('investments') as unknown as { select: () => { eq: () => { order: () => { range: (a: number, b: number) => Promise<{ data: Row[] }> } } } }).select().eq().order().range(0, 999)).data;
    for (let i = 0; i < rows.length; i++) {
      await db.client.from('ii_fhip_publications');
      await db.client.from('ii_holding_snapshots');
      await db.client.from('ii_prices_nav');
    }
    return db.reads.length;
  }
  const many = (n: number): Record<string, Row[]> => {
    const t = emptyTables();
    for (let i = 0; i < n; i++) addPosition(t, { id: `p${i}`, navs: [{ date: '2026-09-30', price: 112 }] });
    return t;
  };
  const check = (readsFor: (n: number) => Promise<number>) => async () => {
    const one = await readsFor(1);
    const thirty = await readsFor(30);
    if (thirty !== one) fail('RULE-11', `query count grows with the number of holdings (1 holding: ${one} reads, 30 holdings: ${thirty} reads)`);
  };
  // Reads of the SECOND (steady-state) run, so the first run's per-row UPDATEs do not count.
  const steady = async (n: number) => {
    const t = many(n);
    await remark(t);
    const second = await remark(t);
    return second.db.reads.length;
  };

  it('real code: the steady-state read count is identical for 1 and 30 holdings, and small', async () => {
    await expect(check(steady)()).resolves.toBeUndefined();
    expect(await steady(30)).toBeLessThanOrEqual(10);
  });
  it('NEGATIVE CONTROL: a per-holding implementation scales with the holdings and fails the same check', async () => {
    await expect(check((n) => naive(many(n)))()).rejects.toThrow(/RULE-11: query count grows with the number of holdings/);
  });
  it('the first run writes exactly one register UPDATE per changed row and never an INSERT into investments', async () => {
    const t = many(5);
    const run = await remark(t);
    expect(run.db.updates.filter((u) => u.table === 'investments')).toHaveLength(5);
    expect(run.db.inserts.filter((i) => i.table === 'investments')).toHaveLength(0);
    expect(t.investments).toHaveLength(5);
  });
});

// ===========================================================================
// Concurrency, read-only clients, currency, missing NAV, stale disclosure.
// ===========================================================================
describe('RULE-14 concurrent writers: compare-and-set on the previous fingerprint', () => {
  const check = async (dbOpts?: Parameters<typeof makeFakeDb>[1]) => {
    const t = oracleTables([{ date: '2026-09-30', price: 112 }]);
    // Another request lands its own re-mark between this call's read and its write.
    const run = await remark(t, 'real', {
      ...dbOpts,
      onBeforeUpdate: (table, rows) => {
        if (table === 'investments') for (const r of rows) r.ii_valuation_fingerprint = 'written-by-another-request';
      },
    });
    if (run.summary.lostRace !== 1 || run.revisions.length !== 0 || run.db.updates.length !== 0) {
      fail('RULE-14', `a lost race must write nothing and record no revision (lostRace ${run.summary.lostRace}, revisions ${run.revisions.length}, updates ${run.db.updates.length})`);
    }
  };
  it('real code: the losing call writes nothing and records no revision', async () => {
    await expect(check()).resolves.toBeUndefined();
  });
  it('NEGATIVE CONTROL: without the fingerprint guard the losing call overwrites and records a revision', async () => {
    await expect(check({ ignoreFilters: ['ii_valuation_fingerprint'] })).rejects.toThrow(/RULE-14: a lost race must write nothing/);
  });
});

describe('read-only clients, currency, missing NAV, stale disclosure', () => {
  it('a read-only client (the AI context) is reported, never throws, and writes no revision; Net Worth keeps the last labelled value', async () => {
    const t = oracleTables([{ date: '2026-09-30', price: 112 }]);
    const run = await remark(t, 'real', { failUpdate: { message: 'writes blocked', code: 'M11_READONLY' } });
    expect(run.summary.readOnly).toBe(true);
    expect(run.summary.error).toBeNull();
    expect(run.revisions).toHaveLength(0);
    expect(row(t, 'inv-a').current_value).toBe(10000);
  });

  it('a register row whose currency differs from its certified snapshot is skipped, never guessed', async () => {
    const t = oracleTables([{ date: '2026-09-30', price: 112 }], { rowCurrency: 'AUD', snapshotCurrency: 'INR' });
    const run = await remark(t);
    expect(run.summary.skipped.currency_mismatch).toBe(1);
    expect(row(t, 'inv-a').current_value).toBe(10000);
  });

  it('a read failure anywhere is reported and nothing is written (fail soft for reads, fail closed for writes)', async () => {
    const t = oracleTables([{ date: '2026-09-30', price: 112 }]);
    const run = await remark(t, 'real', { failRead: { ii_prices_nav: { message: 'boom' } } });
    expect(run.summary.error).toBeTruthy();
    expect(run.db.updates).toHaveLength(0);
    expect(row(t, 'inv-a').current_value).toBe(10000);
  });

  it('a household with no published rows costs exactly one query', async () => {
    const t = emptyTables();
    t.investments.push({ id: 'manual-1', user_id: USER, is_active: true, source_type: 'manual', current_value: 5, currency_code: 'INR' });
    const run = await remark(t);
    expect(run.db.reads).toEqual(['investments']);
    expect(run.summary.considered).toBe(0);
  });

  it('stale disclosure: a NAV 21 days old is shown with its date and tagged Stale NAV; the number is not altered', async () => {
    const t = oracleTables([{ date: '2026-09-10', price: 112 }]);
    await remark(t);
    const r = row(t, 'inv-a');
    expect(r.current_value).toBe(11200);
    expect(r.ii_value_as_of).toBe('2026-09-10');
    const described = real.describeStoredValuation({ basis: r.ii_valuation_basis as string, asOf: r.ii_value_as_of as string, units: 100, nav: 112 }, TODAY);
    expect(described).toMatchObject({ tag: 'stale_nav', label: 'Stale NAV', stale: true, ageDays: 21 });
  });

  it('tag boundaries: 7 days is Latest NAV, 8 days is Stale NAV; a statement value is never called a NAV; redeemed is its own tag; a never-evaluated row has no tag', () => {
    const d = (basis: string, asOf: string) => real.describeStoredValuation({ basis, asOf, units: 1, nav: 1 }, TODAY);
    expect(d('market_nav', '2026-09-24')?.tag).toBe('latest_nav');
    expect(d('market_nav', '2026-09-23')?.tag).toBe('stale_nav');
    expect(d('statement', '2026-09-30')).toMatchObject({ tag: 'statement_value', label: 'Statement value' });
    expect(d('statement', '2026-06-30')).toMatchObject({ tag: 'statement_value', stale: true });
    expect(d('redeemed', '2026-06-30')?.tag).toBe('redeemed');
    expect(real.describeStoredValuation({ basis: null, asOf: null, units: null, nav: null }, TODAY)).toBeNull();
  });
});

// ===========================================================================
// Net Worth through the real Investments read model (labels + totals).
// ===========================================================================
describe('Investments read model: published funds carry their NAV label, date and units; totals are unchanged in kind', () => {
  const fx = fxContext('INR', 56, 'IN');
  const lineFor = async (navs: Array<{ date: string; price: number }>) => {
    const t = oracleTables(navs);
    await remark(t);
    const r = row(t, 'inv-a');
    return computeInvestments({
      investments: [{ id: 'inv-a', investment_name: 'Fund a', investment_type: 'managed_fund', current_value: Number(r.current_value), currency_code: 'INR', owner: 'self', master_item_key: 'managed_funds', source_type: 'investment_intelligence_published', ii_canonical_account_id: 'acc-a', ii_canonical_instrument_id: 'inst-a', ii_value_as_of: r.ii_value_as_of as string, ii_valuation_basis: r.ii_valuation_basis as string, ii_valuation_units: r.ii_valuation_units as number, ii_valuation_nav: r.ii_valuation_nav as number }],
      snapshots: [],
      publications: [],
      fx,
      today: TODAY,
    });
  };

  it('oracle: published total 11,200; the line says Latest NAV, NAV 112, 100 units, dated 2026-09-30; summary counts one market-NAV fund', async () => {
    const m = await lineFor([{ date: '2026-09-30', price: 112 }]);
    expect(m.publishedTotal).toBe(11200);
    expect(m.lines[0].valuation).toMatchObject({ basis: 'market_nav', tag: 'latest_nav', label: 'Latest NAV', asOf: '2026-09-30', units: 100, nav: 112, stale: false });
    expect(m.valuationSummary).toMatchObject({ count: 1, marketNavCount: 1, statementCount: 0, redeemedCount: 0, staleCount: 0, oldestAsOf: '2026-09-30', latestAsOf: '2026-09-30' });
  });

  it('no newer NAV: 10,000 labelled Statement value (stale, 93 days) with the statement date; never "Latest NAV"', async () => {
    const m = await lineFor([]);
    expect(m.publishedTotal).toBe(10000);
    expect(m.lines[0].valuation).toMatchObject({ basis: 'statement', tag: 'statement_value', label: 'Statement value (stale)', stale: true, asOf: '2026-06-30' });
    expect(m.valuationSummary).toMatchObject({ marketNavCount: 0, statementCount: 1, staleCount: 1 });
  });

  it('a manual row has no valuation block and a never-evaluated published row has none either (no invented label)', () => {
    const m = computeInvestments({
      investments: [
        { id: 'manual', investment_name: 'Manual', investment_type: 'shares', current_value: 100, currency_code: 'INR', owner: 'self', master_item_key: null, source_type: 'manual', ii_canonical_account_id: null, ii_canonical_instrument_id: null },
        { id: 'pub', investment_name: 'Pub', investment_type: 'managed_fund', current_value: 200, currency_code: 'INR', owner: 'self', master_item_key: null, source_type: 'investment_intelligence_published', ii_canonical_account_id: 'a', ii_canonical_instrument_id: 'i' },
      ],
      snapshots: [], publications: [], fx, today: TODAY,
    });
    expect(m.lines.every((l) => l.valuation === undefined)).toBe(true);
    expect(m.valuationSummary.count).toBe(0);
    expect(m.publishedTotal).toBe(300);
  });
});

// ===========================================================================
// Joint and entity ownership.
// ===========================================================================
describe('ownership: a joint position is ONE row and ONE value; entity-owned accounts are not valued into personal Net Worth', () => {
  it('joint 1,000,000 (10,000 units x NAV 100) at 60/40 members: re-marked ONCE; household total 1,000,000, never 2,000,000', async () => {
    const t = addPosition(emptyTables(), {
      id: 'j', owner: 'joint', units: 10000, value: 900000, stmtDate: '2026-06-30', navs: [{ date: '2026-09-30', price: 100 }],
      allocations: [{ member: 'member-1', basisPoints: 6000 }, { member: 'member-2', basisPoints: 4000 }],
    });
    const run = await remark(t);
    expect(t.investments).toHaveLength(1);
    expect(run.db.inserts.filter((i) => i.table === 'investments')).toHaveLength(0);
    expect(row(t, 'inv-j').current_value).toBe(1000000);
    expect(netWorthOf(t)).toBe(1000000);
    const m = computeInvestments({
      investments: [{ id: 'inv-j', investment_name: 'Joint fund', investment_type: 'managed_fund', current_value: 1000000, currency_code: 'INR', owner: 'joint', master_item_key: 'managed_funds', source_type: 'investment_intelligence_published', ii_canonical_account_id: 'acc-j', ii_canonical_instrument_id: 'inst-j' }],
      snapshots: [], publications: [], fx: fxContext('INR', 56, 'IN'), today: TODAY,
    });
    expect(m.publishedTotal).toBe(1000000);
    expect(m.householdPublishedTotal).toBe(1000000);
    // The 60/40 attribution is a pure division of that single number (basis points; the sum is exact).
    expect([1000000 * 6000 / 10000, 1000000 * 4000 / 10000]).toEqual([600000, 400000]);
    expect(600000 + 400000).toBe(1000000);
  });

  it('NEGATIVE CONTROL: a re-mark that added one register row per joint owner would show 2,000,000 and is caught by the same check', async () => {
    const t = addPosition(emptyTables(), { id: 'j', owner: 'joint', units: 10000, value: 900000, navs: [{ date: '2026-09-30', price: 100 }], allocations: [{ member: 'member-1', basisPoints: 6000 }, { member: 'member-2', basisPoints: 4000 }] });
    await remark(t);
    // The modelled bug: one full-value row per owner.
    t.investments.push({ ...row(t, 'inv-j'), id: 'inv-j-second-owner' });
    const check = () => {
      const nw = netWorthOf(t);
      if (nw !== 1000000) fail('RULE-15', `a joint position must count once (expected 1000000, got ${nw})`);
    };
    expect(check).toThrow(/RULE-15: a joint position must count once \(expected 1000000, got 2000000\)/);
  });

  describe('joint split through the REAL owner-edit read model (ownerShares): 600,000 + 400,000 of the SAME re-marked 1,000,000', () => {
    const check = async (variant: Variant) => {
      const t = addPosition(emptyTables(), { id: 'j', owner: 'joint', units: 10000, value: 900000, navs: [{ date: '2026-09-30', price: 100 }] });
      await remark(t, variant);
      const r = row(t, 'inv-j');
      const m = computeInvestments({
        investments: [{ id: 'inv-j', investment_name: 'Joint fund', investment_type: 'managed_fund', current_value: Number(r.current_value), currency_code: 'INR', owner: 'joint', master_item_key: 'managed_funds', source_type: 'investment_intelligence_published', ii_canonical_account_id: 'acc-j', ii_canonical_instrument_id: 'inst-j', ii_value_as_of: r.ii_value_as_of as string, ii_valuation_basis: r.ii_valuation_basis as string, ii_valuation_units: r.ii_valuation_units as number, ii_valuation_nav: r.ii_valuation_nav as number }],
        snapshots: [], publications: [], fx: fxContext('INR', 56, 'IN'), today: TODAY,
        jointSharesByAccount: new Map([['acc-j', [{ ownerMemberId: 'member-1', basisPoints: 6000 }, { ownerMemberId: 'member-2', basisPoints: 4000 }]]]),
      });
      const shares = m.lines[0].ownerShares?.map((s) => s.amountNative) ?? [];
      if (shares[0] !== 600000 || shares[1] !== 400000) fail('RULE-16', `the joint split must divide the NAV-valued 1000000 as 600000 / 400000 (got ${JSON.stringify(shares)})`);
      if (m.publishedTotal !== 1000000 || m.householdPublishedTotal !== 1000000) fail('RULE-16', `the household total must stay 1000000, never 2000000 (got ${m.publishedTotal} / ${m.householdPublishedTotal})`);
      if (shares[0] + shares[1] !== m.publishedTotal) fail('RULE-16', 'the shares must add back to the single counted value');
    };
    it('real code', async () => {
      await expect(check('real')).resolves.toBeUndefined();
    });
    it('NEGATIVE CONTROL: a NAV-blind re-mark divides 900,000 (540,000 / 360,000) and fails by name', async () => {
      await expect(check('no_nav')).rejects.toThrow(/RULE-16: the joint split must divide the NAV-valued 1000000 as 600000 \/ 400000/);
    });
  });

  it('entity-owned: the account is skipped (value unchanged, counted in skipped.entity_owned) while a personal position beside it is re-marked; personal Net Worth carries only the personal one', async () => {
    const t = oracleTables([{ date: '2026-09-30', price: 112 }]);
    addPosition(t, { id: 'trust', units: 1000, value: 100000, navs: [{ date: '2026-09-30', price: 120 }], allocations: [{ entity: 'family-trust-1', basisPoints: 10000 }] });
    const run = await remark(t);
    expect(run.summary.skipped.entity_owned).toBe(1);
    expect(row(t, 'inv-a').current_value).toBe(11200);
    expect(row(t, 'inv-trust').current_value).toBe(100000); // untouched: not NAV-valued, not an input to personal Net Worth by this mechanism
    expect(row(t, 'inv-trust').ii_valuation_fingerprint).toBeNull();
  });
});

// ===========================================================================
// Revision history.
// ===========================================================================
describe('revision history: one row per landed change, with its inputs, reason and rule version', () => {
  it('oracle then correction: two revisions in order, each carrying value, NAV, NAV date, statement evidence and the rule version', async () => {
    const t = oracleTables([{ date: '2026-09-30', price: 112 }]);
    const a = await remark(t);
    t.ii_prices_nav[0].price = 111;
    const b = await remark(t);
    const all = [...a.revisions, ...b.revisions];
    expect(all.map((r) => [r.reason, r.previous_value, r.new_value, r.new_basis, r.nav, r.units])).toEqual([
      ['baseline', 10000, 11200, 'market_nav', 112, 100],
      ['nav_correction', 11200, 11100, 'market_nav', 111, 100],
    ]);
    expect(all[0]).toMatchObject({ user_id: USER, investment_id: 'inv-a', publication_id: 'pub-a', instrument_id: 'inst-a', value_as_of: '2026-09-30', statement_as_of: '2026-06-30', statement_value: 10000, remark_trigger: 'manual', rule_version: real.REMARK_RULE_VERSION });
    expect(new Set(all.map((r) => r.fingerprint)).size).toBe(2);
  });

  it('a newer NAV on a later day is a nav_update; a new NAV never rewrites the earlier revisions', async () => {
    const t = oracleTables([{ date: '2026-09-30', price: 112 }]);
    const a = await remark(t);
    t.ii_prices_nav.push({ id: 'nav-late', instrument_id: 'inst-a', price_date: '2026-10-01', price: 115, currency_code: 'INR', quality_status: 'ok' });
    const b = await remark(t);
    expect(row(t, 'inv-a').current_value).toBe(11500);
    expect(b.revisions.map((r) => [r.reason, r.previous_value, r.new_value])).toEqual([['nav_update', 11200, 11500]]);
    expect(a.revisions).toHaveLength(1);
  });
});

// ===========================================================================
// RULE-17 (PO decision 2026-10-02): a pure NAV re-mark must NOT bump
// investments.updated_at (it would flag every stored monthly report stale daily).
// ===========================================================================
describe('RULE-17 a NAV re-mark stamps its own column and leaves updated_at alone', () => {
  const check = async (mutateUpdatedAt: boolean) => {
    const t = oracleTables([{ date: '2026-09-30', price: 112 }]);
    const run = await remark(t);
    if (mutateUpdatedAt) {
      // The modelled bug: the payload also carries updated_at.
      for (const u of run.db.updates) u.payload.updated_at = '2026-10-02T00:00:00.000Z';
    }
    const payloads = run.db.updates.filter((u) => u.table === 'investments').map((u) => u.payload);
    if (payloads.length !== 1 || 'updated_at' in payloads[0]) fail('RULE-17', 'the re-mark must not write updated_at');
    if (row(t, 'inv-a').updated_at !== '2026-09-01T00:00:00.000Z') fail('RULE-17', `updated_at moved (${String(row(t, 'inv-a').updated_at)})`);
    if (typeof payloads[0].ii_valuation_remarked_at !== 'string') fail('RULE-17', 'the re-mark must stamp ii_valuation_remarked_at');
  };
  it('real code: one UPDATE, ii_valuation_remarked_at stamped, updated_at unchanged', async () => {
    await expect(check(false)).resolves.toBeUndefined();
  });
  it('NEGATIVE CONTROL: a payload that carries updated_at fails by name', async () => {
    await expect(check(true)).rejects.toThrow(/RULE-17: the re-mark must not write updated_at/);
  });
});
