/**
 * PO rule 17-10-2026: "Essential expenses ... self-occupied / owner-occupied home loan instalment amount is also
 * essential, if there is no rent mentioned by the user."  (lib/engines/essentialHousing.ts, applied once in
 * computeDashboard().)
 *
 * Every expected number below is a HAND ORACLE computed from the PO household's stated figures, never read back
 * from the code under test:
 *
 *   essential before   = 2,804.67  (electricity 215.40, groceries 1,100.00, health insurance 310.00, home insurance
 *                        118.27, council rates 240.00, fuel 260.00, public transport 95.00, body corporate 150.00,
 *                        internet 89.00, medical 227.00  -> 2,804.67)
 *   discretionary      = 1,730.63  (restaurants 600.00, streaming 55.63, entertainment 400.00, holidays 675.00)
 *   home loan (self)   = 3,397.47 a month, balance 520,904
 *   essential after    = 2,804.67 + 3,397.47 = 6,202.14
 *   liquid cash        = 21,798   -> Emergency Fund 21,798 / 2,804.67 = 7.77 (shown 7.8)  ->  21,798 / 6,202.14 = 3.51 (shown 3.5)
 *   core survival      = electricity + groceries + health insurance + medical + fuel + public transport + council rates
 *                        = 215.40 + 1,100 + 310 + 227 + 260 + 95 + 240 = 2,447.40 before, + 3,397.47 = 5,844.87 after
 *   other debt (never part of the rule) = Investment Loan 2,924.59 + Construction Loan 1,924 + Construction loan 1 116
 *                        + Investment loan 1 0 = 4,964.59; total debt service = 3,397.47 + 4,964.59 = 8,362.06
 *   fixture net income = 10,000 a month (a test number; the PO's real income is not used)
 *   total expenses (excl. debt) = 2,804.67 + 1,730.63 = 4,535.30 ; surplus = 10,000 - 4,535.30 - 8,362.06 = -2,897.36
 *                        (UNCHANGED by the rule: that is the "no double count" assertion)
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { computeDashboard, type DashboardInput, type DashboardSummary, type ExpenseRow, type LiabilityRow } from '@/lib/engines/dashboard';
import {
  essentialHomeLoanNote,
  isOwnerOccupiedLoan,
  resolveEssentialHomeLoan,
  type HousingLoanInput,
} from '@/lib/engines/essentialHousing';
import { computeResilience, type ResilienceConfig } from '@/lib/engines/resilience';
import { computeDnaMetrics } from '@/lib/engines/financialDna';
import { computeHealthScore, type HealthScoreConfig } from '@/lib/engines/healthScore';
import { applyScenario, recomputeDerived } from '@/lib/engines/whatIf';
import { ALL_SECTIONS, effectiveSectionStatus, type FinancialSection, type FinancialSectionStatus } from '@/lib/engines/financialSectionStatus';
import { EssentialHomeLoanBlock } from '@/components/essential/EssentialHomeLoanNote';

const EMPTY: DashboardInput = { income: [], expenses: [], assets: [], liabilities: [], investments: [], retirement: [], insurance: [], goals: [], snapshots: [] };

const exp = (expense_name: string, amount: number, master_item_key: string | null, is_essential: boolean, frequency: ExpenseRow['frequency'] = 'monthly'): ExpenseRow => ({
  expense_name, amount, frequency, is_essential, master_item_key, owner: 'self',
});

const ESSENTIAL_ROWS: ExpenseRow[] = [
  exp('Electricity', 215.4, 'electricity', true),
  exp('Groceries', 1100, 'groceries', true),
  exp('Health insurance', 310, 'health_insurance', true),
  exp('Home insurance', 118.27, 'home_insurance', true),
  exp('Council rates', 240, 'council_rates', true),
  exp('Fuel', 260, 'fuel', true),
  exp('Public transport', 95, 'public_transport', true),
  exp('Body corporate', 150, 'body_corporate', true),
  exp('Internet', 89, 'internet', true),
  exp('Medical', 227, 'medical', true),
];
const DISCRETIONARY_ROWS: ExpenseRow[] = [
  exp('Restaurants', 600, 'restaurants', false),
  exp('Streaming', 55.63, 'streaming_services', false),
  exp('Entertainment', 400, 'entertainment', false),
  exp('Holidays', 675, 'holidays', false),
];

const loan = (extra: Partial<LiabilityRow>): LiabilityRow => ({
  balance: 100000, interest_rate: 6, monthly_repayment: 0, debt_type: 'mortgage', master_item_key: null, currency_code: 'AUD', owner: 'self', ...extra,
});
const HOME_LOAN = loan({ id: 'l-home', liability_name: 'Home Loan', balance: 520904, monthly_repayment: 3397.47, master_item_key: 'home_loan' });
const OTHER_LOANS: LiabilityRow[] = [
  loan({ id: 'l-inv', liability_name: 'Investment Loan', owner: 'joint', balance: 400000, monthly_repayment: 2924.59, master_item_key: 'investment_loan' }),
  loan({ id: 'l-con', liability_name: 'Construction Loan', owner: 'joint', balance: 300000, monthly_repayment: 1924, master_item_key: 'construction_loan' }),
  loan({ id: 'l-con1', liability_name: 'Construction loan 1', owner: 'joint', balance: 20000, monthly_repayment: 116 }),
  loan({ id: 'l-inv1', liability_name: 'Investment loan 1', owner: 'joint', balance: 0, monthly_repayment: 0 }),
];
const CASH = { current_value: 21798, asset_name: 'Savings', asset_class: 'cash', master_item_key: 'savings_account', currency_code: 'AUD', owner: 'self' };
const SALARY = { source_name: 'Salary', amount: 10000, net_amount: 10000, frequency: 'monthly' as const, master_item_key: 'salary_wages', owner: 'self' };

function poHousehold(over: Partial<DashboardInput> = {}): DashboardInput {
  return {
    ...EMPTY,
    income: [SALARY],
    expenses: [...ESSENTIAL_ROWS, ...DISCRETIONARY_ROWS],
    assets: [CASH],
    liabilities: [HOME_LOAN, ...OTHER_LOANS],
    ...over,
  };
}

const money = (n: number) => Math.round(n * 100) / 100;

describe('PO household (hand oracles)', () => {
  const d = computeDashboard(poHousehold(), 'AUD');

  it('essential 2,804.67 -> 6,202.14 (the Home Loan repayment of 3,397.47 is added, nothing else)', () => {
    expect(money(d.essentialMonthlyExpenses)).toBe(6202.14);
    expect(d.essentialHomeLoan?.status).toBe('counted');
    expect(d.essentialHomeLoan?.monthly).toBe(3397.47);
    expect(d.essentialHomeLoan?.lines.map((l) => l.name)).toEqual(['Home Loan']);
    expect(d.essentialHomeLoan?.lines[0].basis).toBe('home_loan_catalogue_item');
  });

  it('Emergency Fund 21,798 / 6,202.14 = 3.51 months (was 7.77)', () => {
    expect(d.liquidAssets).toBe(21798);
    expect(d.emergencyFundMonths).toBeCloseTo(21798 / 6202.14, 9);
    expect(d.emergencyFundMonths!.toFixed(2)).toBe('3.51');
    expect(d.emergencyFundMonths!.toFixed(1)).toBe('3.5');
    const control = computeDashboard(poHousehold({ liabilities: [{ ...HOME_LOAN, master_item_key: 'personal_loan' }, ...OTHER_LOANS] }), 'AUD');
    expect(money(control.essentialMonthlyExpenses)).toBe(2804.67);
    expect(control.emergencyFundMonths!.toFixed(1)).toBe('7.8');
  });

  it('the Emergency Fund ratio band moves from 7.8 months (6 or more: good) to 3.5 months (3 to 6: caution)', () => {
    const band = (s: DashboardSummary) => s.ratios.find((r) => r.key === 'emergency_fund_ratio')!.status;
    const control = computeDashboard(poHousehold({ liabilities: [{ ...HOME_LOAN, master_item_key: 'personal_loan' }, ...OTHER_LOANS] }), 'AUD');
    expect(band(control)).toBe('good');
    expect(band(d)).toBe('caution');
  });

  it('core survival 2,447.40 -> 5,844.87 (the repayment is a housing cost)', () => {
    expect(money(d.coreSurvivalMonthlyExpenses)).toBe(5844.87);
  });

  it('investment, construction and custom loans are never added: only the Home Loan is', () => {
    expect(money(d.debtMonthlyRepayments)).toBe(8362.06);
    expect(money(d.essentialMonthlyExpenses - 2804.67)).toBe(3397.47);
  });

  it('NO DOUBLE COUNT: total expenses (excl. debt), total outflow, surplus, savings rate, DSR, DTI, discretionary are exactly what they were', () => {
    const control = computeDashboard(poHousehold({ liabilities: [{ ...HOME_LOAN, master_item_key: 'personal_loan' }, ...OTHER_LOANS] }), 'AUD');
    expect(money(d.totalMonthlyExpenses)).toBe(4535.3);
    expect(money(d.lifestyleMonthlyExpenses)).toBe(1730.63);
    expect(money(d.monthlySurplus)).toBe(-2897.36);
    for (const k of ['totalMonthlyExpenses', 'lifestyleMonthlyExpenses', 'debtMonthlyRepayments', 'monthlySurplus', 'savingsRate', 'cashFlowRatio', 'debtServiceRatio', 'discretionaryRatio', 'disposableIncome'] as const) {
      expect(d[k], k).toBe(control[k]);
    }
    expect(d.debtServiceRatio).toBeCloseTo(8362.06 / 10000, 9);
    expect(d.discretionaryRatio).toBeCloseTo(1730.63 / 10000, 9);
  });

  it('operating cash flow is income less ALL essentials (10,000 - 6,202.14); disposable income unchanged (10,000 - 2,804.67 - 8,362.06)', () => {
    expect(money(d.operatingCashFlow)).toBe(3797.86);
    expect(money(d.disposableIncome)).toBe(money(10000 - 2804.67 - 8362.06));
  });

  it('Resilience: essential and core-survival months use the new totals (accessible / 6,202.14 and / 5,844.87)', () => {
    const r = computeResilience({
      dashboard: d, dependantsCount: 0, isSelfEmployed: false, commitments: [], isCurrentSnapshotRecent: true, hasPriorMonthHistory: true,
      config: RESILIENCE_CONFIG, sectionStatus: defaultSectionStatus(d),
    });
    const ef = r.components.find((c) => c.code === 'emergency_fund')!;
    const v = ef.currentValue as { accessibleResources: number; essentialMonths: number; coreSurvivalMonths: number; essentialHomeLoanMonthly: number };
    expect(v.essentialMonths).toBeCloseTo(v.accessibleResources / 6202.14, 9);
    expect(v.coreSurvivalMonths).toBeCloseTo(v.accessibleResources / 5844.87, 9);
    expect(v.essentialHomeLoanMonthly).toBe(3397.47);
  });

  it('Financial DNA: essential-expense ratio 6,202.14 / 10,000 = 0.620214 (was 0.280467); discretionary ratio 0.173063 unchanged', () => {
    const m = computeDnaMetrics({ dashboard: d, age: 40, dependantsCount: 0, isSelfEmployed: false, isRetired: false });
    expect(m.essentialExpenseRatio).toBeCloseTo(0.620214, 6);
    expect(m.discretionaryRatio).toBeCloseTo(0.173063, 6);
    expect(m.emergencyFundMonths).toBeCloseTo(21798 / 6202.14, 9);
  });

  it('What-if: recomputing keeps total expenses, surplus and disposable income; paying down debt shrinks the essential share in step', () => {
    const copy: DashboardSummary = JSON.parse(JSON.stringify(d));
    recomputeDerived(copy);
    expect(copy.totalMonthlyExpenses).toBeCloseTo(d.totalMonthlyExpenses, 9);
    expect(copy.monthlySurplus).toBeCloseTo(d.monthlySurplus, 9);
    expect(copy.disposableIncome).toBeCloseTo(d.disposableIncome, 9);
    expect(copy.operatingCashFlow).toBeCloseTo(d.operatingCashFlow, 9);
    const paid = applyScenario(d, 'pay_off_debt');
    expect(paid.essentialHomeLoan!.monthly).toBeLessThan(3397.47);
    // essential(after) - loan(after) is still the 2,804.67 of ordinary essentials
    expect(money(paid.essentialMonthlyExpenses - paid.essentialHomeLoan!.monthly)).toBe(2804.67);
    expect(paid.totalMonthlyExpenses).toBeCloseTo(d.totalMonthlyExpenses, 9);
    const buffer = applyScenario(d, 'build_emergency_fund');
    expect(buffer.emergencyFundMonths).toBeCloseTo((21798 + 3 * 6202.14) / 6202.14, 9);
  });

  it('the provenance note names the amount and the "no rent" reason', () => {
    expect(essentialHomeLoanNote(d.essentialHomeLoan, 'AUD')).toBe('Essential expenses include your home loan repayment of $3,397 a month (no rent recorded).');
  });
});

describe('which scores move (PO household, hand-calculated against the published brackets)', () => {
  const control = computeDashboard(poHousehold({ liabilities: [{ ...HOME_LOAN, master_item_key: 'personal_loan' }, ...OTHER_LOANS] }), 'AUD');
  const after = computeDashboard(poHousehold(), 'AUD');
  const healthEf = (d: DashboardSummary) => computeHealthScore({
    dashboard: d, age: 40, dependantsCount: 0, isSelfEmployed: false, checkIns: null, resilienceResult: null,
    config: HEALTH_CONFIG, sectionStatus: defaultSectionStatus(d),
  }).components.find((c) => c.code === 'emergency_fund')!;
  const resilienceEf = (d: DashboardSummary) => computeResilience({
    dashboard: d, dependantsCount: 0, isSelfEmployed: false, commitments: [], isCurrentSnapshotRecent: true, hasPriorMonthHistory: true,
    config: RESILIENCE_CONFIG, sectionStatus: defaultSectionStatus(d),
  }).components.find((c) => c.code === 'emergency_fund')!;

  it('Health Score Emergency Fund component: 7.77 months scores 90 (6 to 9 months); 3.51 months scores 60 (3 to 4 months)', () => {
    expect(healthEf(control).rawScore).toBe(90);
    expect(healthEf(after).rawScore).toBe(60);
  });

  it('Resilience Emergency Fund Adequacy: 7.77 months scores 90 (6 to 9); 3.51 months scores 58 (3 to 4)', () => {
    const before = resilienceEf(control);
    const now = resilienceEf(after);
    expect((before.currentValue as { accessibleResources: number }).accessibleResources).toBe(21798);
    expect(before.rawScore).toBe(90);
    expect(now.rawScore).toBe(58);
  });

  it('components that do NOT move: cash-flow surplus, savings rate, debt service, debt-to-income', () => {
    for (const k of ['monthlySurplus', 'savingsRate', 'debtServiceRatio', 'debtToIncome', 'netWorth', 'totalMonthlyExpenses'] as const) {
      expect(after[k], k).toBe(control[k]);
    }
  });
});

describe('rent recorded: rent is the housing cost, the loan is not added again', () => {
  const cases: [string, ExpenseRow][] = [
    ['monthly rent', exp('Rent', 2000, 'rent', true)],
    ['fortnightly rent', exp('Rent', 450, 'rent', true, 'fortnightly')],
    ['weekly rent', exp('Rent', 400, 'rent', false, 'weekly')],
    ['annual rent', exp('Rent', 24000, 'rent', true, 'annually')],
  ];
  for (const [label, rent] of cases) {
    it(label, () => {
      const d = computeDashboard(poHousehold({ expenses: [...ESSENTIAL_ROWS, ...DISCRETIONARY_ROWS, rent] }), 'AUD');
      expect(d.essentialHomeLoan?.status).toBe('rent_recorded');
      expect(d.essentialHomeLoan?.monthly).toBe(0);
      expect(d.essentialHomeLoan?.rentMonthly).toBeGreaterThan(0);
      const rentMonthlyEssential = rent.is_essential ? (rent.frequency === 'fortnightly' ? 450 * 26 / 12 : rent.frequency === 'annually' ? 2000 : 2000) : 0;
      expect(d.essentialMonthlyExpenses).toBeCloseTo(2804.67 + rentMonthlyEssential, 6);
    });
  }

  it('rent AND a home loan (rents one place, owns another): rent present, loan not added', () => {
    const d = computeDashboard(poHousehold({ expenses: [...ESSENTIAL_ROWS, exp('Rent', 1800, 'rent', true)] }), 'AUD');
    expect(d.essentialMonthlyExpenses).toBeCloseTo(2804.67 + 1800, 6);
    expect(essentialHomeLoanNote(d.essentialHomeLoan, 'AUD')).toBe('You recorded rent, so rent is your essential housing cost and a home loan repayment is not added.');
  });

  it('a rent row of zero is not "rent recorded"', () => {
    const d = computeDashboard(poHousehold({ expenses: [...ESSENTIAL_ROWS, exp('Rent', 0, 'rent', true)] }), 'AUD');
    expect(d.essentialHomeLoan?.status).toBe('counted');
  });

  it('removing the rent brings the loan back automatically', () => {
    const withRent = computeDashboard(poHousehold({ expenses: [...ESSENTIAL_ROWS, exp('Rent', 1800, 'rent', true)] }), 'AUD');
    const withoutRent = computeDashboard(poHousehold({ expenses: [...ESSENTIAL_ROWS] }), 'AUD');
    expect(withRent.essentialHomeLoan?.monthly).toBe(0);
    expect(money(withoutRent.essentialMonthlyExpenses)).toBe(money(2804.67 + 3397.47));
  });
});

describe('edge cases', () => {
  it('no home loan at all: nothing changes (negative control against the PO household)', () => {
    const d = computeDashboard(poHousehold({ liabilities: OTHER_LOANS }), 'AUD');
    expect(d.essentialHomeLoan?.status).toBe('no_home_loan');
    expect(money(d.essentialMonthlyExpenses)).toBe(2804.67);
    expect(d.emergencyFundMonths!.toFixed(1)).toBe('7.8');
  });

  it('only investment / construction / custom loans: never added', () => {
    const d = computeDashboard(poHousehold({ liabilities: OTHER_LOANS }), 'AUD');
    expect(d.essentialHomeLoan?.monthly).toBe(0);
    expect(d.essentialHomeLoan?.lines).toEqual([]);
  });

  it('inactive home loan: not counted', () => {
    const d = computeDashboard(poHousehold({ liabilities: [{ ...HOME_LOAN, is_active: false }, ...OTHER_LOANS] }), 'AUD');
    expect(money(d.essentialMonthlyExpenses)).toBe(2804.67);
    expect(d.essentialHomeLoan?.status).toBe('no_home_loan');
  });

  it('missing or zero repayment: not counted, and the note says the repayment is not recorded', () => {
    for (const monthly_repayment of [0, null as unknown as number]) {
      const d = computeDashboard(poHousehold({ liabilities: [{ ...HOME_LOAN, monthly_repayment }, ...OTHER_LOANS] }), 'AUD');
      expect(d.essentialHomeLoan?.status).toBe('repayment_not_recorded');
      expect(money(d.essentialMonthlyExpenses)).toBe(2804.67);
      expect(essentialHomeLoanNote(d.essentialHomeLoan, 'AUD')).toContain('repayment is not recorded');
    }
  });

  it('SMSF- / trust- / company-held home loan: not the household\'s housing cost', () => {
    for (const owner of ['smsf', 'family_trust', 'company']) {
      const d = computeDashboard(poHousehold({ liabilities: [{ ...HOME_LOAN, owner }, ...OTHER_LOANS] }), 'AUD');
      expect(money(d.essentialMonthlyExpenses), owner).toBe(2804.67);
    }
  });

  it('joint ownership: the household repayment is counted once, as recorded (no 50% share)', () => {
    const d = computeDashboard(poHousehold({ liabilities: [{ ...HOME_LOAN, owner: 'joint' }, ...OTHER_LOANS] }), 'AUD');
    expect(d.essentialHomeLoan?.monthly).toBe(3397.47);
  });

  it('two owner-occupied loans (a split loan linked to the residence): both counted once; an investment loan beside them is not', () => {
    const split = loan({ id: 'l-split', liability_name: 'Home loan split B', monthly_repayment: 1000, link_purposes: ['owner_occupied'] });
    const d = computeDashboard(poHousehold({ liabilities: [HOME_LOAN, split, ...OTHER_LOANS] }), 'AUD');
    expect(d.essentialHomeLoan?.lines.map((l) => l.name).sort()).toEqual(['Home Loan', 'Home loan split B']);
    expect(money(d.essentialHomeLoan!.monthly)).toBe(4397.47);
    expect(d.essentialHomeLoan?.lines.find((l) => l.name === 'Home loan split B')?.basis).toBe('principal_residence_link');
  });

  it('a home_loan row whose only property link is an INVESTMENT property is not owner-occupied; an explicit "self occupied" answer wins both ways', () => {
    const linkedToInvestment = computeDashboard(poHousehold({ liabilities: [{ ...HOME_LOAN, link_purposes: ['other'] }, ...OTHER_LOANS] }), 'AUD');
    expect(money(linkedToInvestment.essentialMonthlyExpenses)).toBe(2804.67);
    const holiday = computeDashboard(poHousehold({ liabilities: [{ ...HOME_LOAN, property_use: 'holiday' }, ...OTHER_LOANS] }), 'AUD');
    expect(money(holiday.essentialMonthlyExpenses)).toBe(2804.67);
    const selfOccupiedOverridesKey = computeDashboard(
      poHousehold({ liabilities: [HOME_LOAN, loan({ id: 'l-x', liability_name: 'My house', master_item_key: 'investment_loan', monthly_repayment: 500, property_use: 'self_occupied' }), ...OTHER_LOANS.slice(1)] }),
      'AUD'
    );
    expect(selfOccupiedOverridesKey.essentialHomeLoan?.lines.find((l) => l.name === 'My house')?.basis).toBe('explicit_property_use');
  });

  it('a household with no expenses on file at all is not given an "essential" figure made of the loan alone', () => {
    const d = computeDashboard(poHousehold({ expenses: [] }), 'AUD');
    expect(d.hasExpenses).toBe(false);
    expect(d.essentialMonthlyExpenses).toBe(0);
    expect(d.emergencyFundMonths).toBeNull();
  });

  it('a loan in another currency is converted once into the reporting currency', () => {
    const d = computeDashboard(poHousehold({ liabilities: [{ ...HOME_LOAN, currency_code: 'INR', monthly_repayment: 112000 }] }), 'AUD', 56);
    expect(d.essentialHomeLoan?.monthly).toBeCloseTo(2000, 6);
  });

  it('an unconvertible currency is left out (fail closed), never added raw', () => {
    const d = computeDashboard(poHousehold({ liabilities: [{ ...HOME_LOAN, currency_code: 'USD' }] }), 'AUD');
    expect(d.essentialHomeLoan?.status).toBe('repayment_not_recorded');
    expect(money(d.essentialMonthlyExpenses)).toBe(2804.67);
  });

  it('a legacy duplicate "mortgage" expense row is not counted and does not add to the loan (counted once)', () => {
    const d = computeDashboard(poHousehold({ expenses: [...ESSENTIAL_ROWS, exp('Mortgage', 3397.47, 'mortgage', true)] }), 'AUD');
    expect(money(d.essentialMonthlyExpenses)).toBe(6202.14);
    expect(money(d.totalMonthlyExpenses)).toBe(2804.67);
  });
});

describe('the pure selector', () => {
  const base: HousingLoanInput = { id: 'x', name: 'x', owner: 'self', monthly: 1000 };
  it('precedence: explicit property use > property link > the Home Loan catalogue item', () => {
    expect(isOwnerOccupiedLoan({ ...base, masterItemKey: 'home_loan' })).toEqual({ ownerOccupied: true, basis: 'home_loan_catalogue_item' });
    expect(isOwnerOccupiedLoan({ ...base, masterItemKey: 'investment_loan' }).ownerOccupied).toBe(false);
    expect(isOwnerOccupiedLoan({ ...base, masterItemKey: 'investment_loan', linkPurposes: ['owner_occupied'] })).toEqual({ ownerOccupied: true, basis: 'principal_residence_link' });
    expect(isOwnerOccupiedLoan({ ...base, masterItemKey: 'home_loan', linkPurposes: ['other'] }).ownerOccupied).toBe(false);
    expect(isOwnerOccupiedLoan({ ...base, masterItemKey: 'home_loan', linkPurposes: ['other'], propertyUse: 'self_occupied' }).basis).toBe('explicit_property_use');
    for (const propertyUse of ['investment', 'holiday', 'vacant', 'other'] as const) {
      expect(isOwnerOccupiedLoan({ ...base, masterItemKey: 'home_loan', linkPurposes: ['owner_occupied'], propertyUse }).ownerOccupied).toBe(false);
    }
  });
  it('a custom row with no key and no link, and the other property-loan keys, are not owner-occupied', () => {
    for (const masterItemKey of [null, 'construction_loan', 'commercial_loan', 'smsf_property_loan', 'personal_loan', 'car_loan', 'credit_card']) {
      expect(isOwnerOccupiedLoan({ ...base, masterItemKey }).ownerOccupied, String(masterItemKey)).toBe(false);
    }
  });
  it('resolveEssentialHomeLoan sums only recognised, active, household loans with a positive repayment', () => {
    const r = resolveEssentialHomeLoan({
      rentMonthly: 0,
      loans: [
        { ...base, id: 'a', masterItemKey: 'home_loan', monthly: 3000 },
        { ...base, id: 'b', masterItemKey: 'home_loan', monthly: 500, isActive: false },
        { ...base, id: 'c', masterItemKey: 'home_loan', monthly: 700, entityHeld: true },
        { ...base, id: 'd', masterItemKey: 'investment_loan', monthly: 900 },
        { ...base, id: 'e', masterItemKey: 'home_loan', monthly: null },
      ],
    });
    expect(r.status).toBe('counted');
    expect(r.monthly).toBe(3000);
    expect(r.recognisedLoanCount).toBe(2);
    expect(r.loansWithoutRepayment).toBe(1);
  });
});

describe('UI: read-only line on Expenses, "Essential housing cost" label on Liabilities', () => {
  const d = computeDashboard(poHousehold(), 'AUD');
  const view = { currency: 'AUD' as const, essentialMonthlyExpenses: d.essentialMonthlyExpenses, essentialHomeLoan: d.essentialHomeLoan };
  it('Expenses: the essential total reconciles with the lines shown (2,805 + 3,397 = 6,202)', () => {
    const html = renderToStaticMarkup(createElement(EssentialHomeLoanBlock, { view, variant: 'expenses' }));
    expect(html).toContain('Home loan repayment (counted as essential, no rent recorded)');
    expect(html).toContain('$2,805 a month');
    expect(html).toContain('$3,397 a month');
    expect(html).toContain('$6,202 a month');
    expect(html).toContain('Essential expenses include your home loan repayment of $3,397 a month (no rent recorded).');
  });
  it('Liabilities: Essential housing cost label with the loan line', () => {
    const html = renderToStaticMarkup(createElement(EssentialHomeLoanBlock, { view, variant: 'liabilities' }));
    expect(html).toContain('Essential housing cost');
    expect(html).toContain('Home Loan');
    expect(html).toContain('$3,397 a month');
  });
  it('renders nothing when the rule does not apply, and a plain note when rent is what stops it', () => {
    const none = computeDashboard(poHousehold({ liabilities: OTHER_LOANS }), 'AUD');
    expect(renderToStaticMarkup(createElement(EssentialHomeLoanBlock, { view: { currency: 'AUD', essentialMonthlyExpenses: none.essentialMonthlyExpenses, essentialHomeLoan: none.essentialHomeLoan }, variant: 'expenses' }))).toBe('');
    const rent = computeDashboard(poHousehold({ expenses: [...ESSENTIAL_ROWS, exp('Rent', 1800, 'rent', true)] }), 'AUD');
    const html = renderToStaticMarkup(createElement(EssentialHomeLoanBlock, { view: { currency: 'AUD', essentialMonthlyExpenses: rent.essentialMonthlyExpenses, essentialHomeLoan: rent.essentialHomeLoan }, variant: 'expenses' }));
    expect(html).toContain('You recorded rent');
  });
});

// ---------------------------------------------------------------------------
const HEALTH_CONFIG: HealthScoreConfig = {
  componentWeights: { cash_flow: 0.15, savings: 0.12, emergency_fund: 0.12, debt: 0.15, net_worth: 0.1, investment: 0.08, retirement: 0.1, insurance: 0.08, resilience: 0.05, behaviour: 0.05 },
  scoreBands: [
    { min: 85, band: 'excellent', label: 'Excellent' },
    { min: 70, band: 'good', label: 'Good' },
    { min: 55, band: 'fair', label: 'Fair' },
    { min: 40, band: 'needs_attention', label: 'Needs Attention' },
    { min: 0, band: 'critical', label: 'Critical' },
  ],
  riskOverride: { deficitMonthsThreshold: 2, emergencyMonthsThreshold: 1, scoreCap: 49 },
};

const RESILIENCE_CONFIG: ResilienceConfig = {
  componentWeights: { emergency_fund: 0.25, liquidity: 0.15, income_resilience: 0.15, insurance_protection: 0.2, debt_pressure: 0.15, concentration_risk: 0.1 },
  scoreBands: [
    { min: 85, band: 'highly_resilient', label: 'Highly Resilient' },
    { min: 70, band: 'resilient', label: 'Resilient' },
    { min: 55, band: 'moderately_vulnerable', label: 'Moderately Vulnerable' },
    { min: 40, band: 'vulnerable', label: 'Vulnerable' },
    { min: 0, band: 'fragile', label: 'Fragile' },
  ],
  confidenceWeights: { incomeCompleteness: 0.15, expenseCompleteness: 0.15, liquidAssetCompleteness: 0.2, liabilityCompleteness: 0.15, insuranceCompleteness: 0.2, dataRecency: 0.1, verificationHistory: 0.05 },
  riskOverride: { scoreCapPrimary: 49, scoreCapSecondary: 59, criticalLiquidityWeeks: 2, refinanceExposureMonths: 6 },
};

function defaultSectionStatus(dashboard: DashboardSummary): Record<FinancialSection, FinancialSectionStatus> {
  const hasRows: Record<FinancialSection, boolean> = {
    household: true, income: dashboard.hasIncome, expenses: dashboard.hasExpenses, assets: dashboard.hasAssets,
    liabilities: dashboard.hasLiabilities, investments: dashboard.hasInvestments, retirement: dashboard.hasRetirement, insurance: dashboard.hasInsurance,
  };
  const out = {} as Record<FinancialSection, FinancialSectionStatus>;
  for (const s of ALL_SECTIONS) out[s] = effectiveSectionStatus({ hasRows: hasRows[s], explicitConfirmation: null });
  return out;
}
