import { createClient } from '@/lib/supabase/server';
import type { SupabaseServerClient } from './dashboardData';
import { loadDashboard } from './dashboardData';
import { type DashboardSummary, computeInsuranceAdequacy } from '@/lib/engines/dashboard';
import { loadHealthScore, type HealthScorePayload } from './healthScoreData';
import { loadResilience, type ResiliencePayload } from './resilienceData';
import { loadFinancialDna } from './financialDnaData';
import { computeGoalsPagePayload, type GoalsPagePayload } from './goalsData';
import type { DnaResult } from '@/lib/engines/financialDna';
import { ageFromDateOfBirth, ageToAgeBand, normalizeEmploymentType, normalizeHouseholdType, deriveLifeStage, annualGrossIncomeToIncomeBand } from '@/lib/engines/twin/taxonomy';
import type { AgeBand, EmploymentType, HouseholdTypeCode, IncomeBand, LifeStage } from '@/lib/engines/twin/taxonomy';
import { getUserFullExperienceHomeCountry } from '@/lib/services/jurisdiction';
import { buildCanonicalFinancialSnapshot, type CanonicalFinancialSnapshot } from '@/lib/read-models';
import { fetchAllRows } from '@/lib/read-models/core/paginate';
import { ReadModelUnavailableError, roundMoney } from '@/lib/read-models/core/types';

export interface TwinRetirementRow {
  current_balance: number;
  employer_contribution: number | null;
  personal_contribution: number | null;
  contribution_frequency: string | null;
  country_code: string | null;
  target_retirement_age: number | null;
  account_type: string;
}
export interface TwinInsuranceRow {
  cover_amount: number;
  premium: number;
  premium_frequency: string;
  cover_type: string;
  waiting_period_days: number | null;
}
// WP-05 (DC-13): every money field on the three rows below is the REPORTING-
// currency amount from the canonical selectors (lib/read-models), converted
// once at the snapshot's single FX rate. The Twin's metric derivation sums
// them (currency concentration, geographic diversification, LVR, unsecured /
// high-interest debt), so a raw AUD + INR sum is no longer possible. A row in
// an unsupported currency is left out of these arrays (fail closed) exactly as
// it is left out of the Dashboard totals the Twin is compared against.
export interface TwinInvestmentRow {
  current_value: number;
  investment_type: string;
  master_item_key?: string | null;
  country_code: string | null;
  currency_code: string | null;
}
export interface TwinLiabilityRow {
  balance: number;
  debt_type: string;
  master_item_key?: string | null;
  interest_rate: number | null;
  country_code: string | null;
  currency_code: string | null;
}
export interface TwinAssetRow {
  current_value: number;
  asset_class: string;
  master_item_key?: string | null;
  country_code: string | null;
  currency_code: string | null;
}

/** A monthly history point. null = the stored snapshot has no value (never a confirmed zero). */
export interface TwinSnapshotPoint {
  month: string;
  netWorth: number | null;
  monthlyIncome: number | null;
  monthlyExpenses: number | null;
  monthlySurplus: number | null;
}

export interface TwinHouseholdContext {
  countryOfResidence: 'AU' | 'IN';
  secondaryCountry: 'AU' | 'IN' | null;
  preferredCurrency: 'AUD' | 'INR';
  age: number | null;
  ageBand: AgeBand | null;
  dependantsCount: number;
  employmentType: EmploymentType;
  householdTypeCode: HouseholdTypeCode;
  housingTenure: string | null;
  residenceType: string | null;
  lifeStage: LifeStage;
  incomeBand: IncomeBand;
  isCrossBorder: boolean;
  dnaProfileCode: string | null;
}

export interface TwinSourceData {
  userId: string;
  household: TwinHouseholdContext;
  dashboard: DashboardSummary;
  insuranceAdequacy: ReturnType<typeof computeInsuranceAdequacy>;
  healthScore: HealthScorePayload;
  resilience: ResiliencePayload;
  dna: DnaResult | null;
  goals: GoalsPagePayload;
  rawRetirement: TwinRetirementRow[];
  // Retirement Member UI (spec s.29): the canonical Self target retirement
  // age from retirement_members, used instead of scanning target ages off
  // individual retirement_accounts rows (which could previously blend
  // Self's and Spouse's ages together into one Math.max — a genuine
  // cross-member data bug, since source.household.age below is always
  // Self's own current age). Null when Self hasn't confirmed an age yet —
  // callers fall back to the approved country default, same as before.
  selfTargetRetirementAge: number | null;
  rawInsurance: TwinInsuranceRow[];
  rawInvestments: TwinInvestmentRow[];
  rawLiabilities: TwinLiabilityRow[];
  rawAssets: TwinAssetRow[];
  expenseHousingMonthly: number;
  remittanceMonthly: number;
  /** The most recent (up to) 12 monthly snapshots, oldest first. */
  snapshots12m: TwinSnapshotPoint[];
  hasMinimumData: boolean;
}

// G0-JA-1 Wave 1 (JA-D1): a distinguishable, fail-closed contract for the
// case where the caller's home country cannot be resolved — never a
// silently-assumed AU (or IN) cohort, and never a fabricated zero. No
// certified, separately-tested global (country-agnostic) cohort exists in
// this codebase today (04-calculation-dependency-matrix.md §Defect
// Remediation Specifications, JA-D1 "Global-cohort conditions"), so the only
// honest response is "comparison unavailable" — not a computed benchmark.
export type TwinSourceDataOutcome = { status: 'ok'; data: TwinSourceData } | { status: 'country_unresolved' };

/**
 * Housing cost for the Twin's housing_cost_ratio (WP-05, DC-04 / EXP-G10).
 *
 * The canonical Expense read model's COMBINED housing group (rent, rates,
 * body corporate, maintenance... -- actual when the group has covered
 * imported activity, otherwise the plan; never both, PO D-02), PLUS the
 * household's owner-occupied home-loan debt service from the canonical
 * Liability read model (actual principal + interest + fee replaces the
 * contractual repayment when statement events exist, PO D-09).
 *
 * Why the loan term: a manual 'mortgage' expense row that duplicates a
 * liability's repayment is excluded from planned expenses (it is counted once,
 * in debt service), so the housing figure takes that one count from debt
 * service instead. A 'mortgage' expense row with NO liability repayment on
 * file is still a counted planned housing expense, and its loan contributes 0
 * -- so the same money is never counted twice and never dropped.
 * Investment-property loans are not the household's own housing cost.
 */
const OWNER_OCCUPIED_HOME_LOAN_KEYS = new Set(['home_loan', 'construction_loan']);

export function twinHousingMonthly(snapshot: Pick<CanonicalFinancialSnapshot, 'expenses' | 'liabilities'>): number {
  const expenses = requireSection(snapshot.expenses, 'expenses');
  const liabilities = requireSection(snapshot.liabilities, 'liabilities');
  const housingGroup = expenses.combined.byGroup.find((g) => g.group === 'housing')?.monthly ?? 0;
  const homeLoanService = liabilities.lines
    .filter((l) => l.household)
    .filter((l) => (l.masterItemKey ? OWNER_OCCUPIED_HOME_LOAN_KEYS.has(l.masterItemKey) : l.debtType === 'mortgage'))
    .reduce((s, l) => s + (l.debtServiceMonthly ?? 0), 0);
  return roundMoney(housingGroup + homeLoanService);
}

/**
 * Family-support remittance for the Twin's remittance_burden (WP-05).
 * Counted planned rows keyed 'family_support_remittance', in reporting
 * currency (superseded, SMSF-owned and unconverted rows excluded by the
 * selector). The imported side has no remittance category in the FDH-2
 * taxonomy (an overseas transfer is typed 'transfer', never spending), so
 * there is no actual figure to prefer here -- disclosed in
 * CANONICAL_EXPENSE_DATA_CONTRACT.md.
 */
export function twinRemittanceMonthly(snapshot: Pick<CanonicalFinancialSnapshot, 'expenses'>): number {
  const expenses = requireSection(snapshot.expenses, 'expenses');
  return roundMoney(
    expenses.planned.lines
      .filter((l) => l.excludedReason === null && l.masterItemKey === 'family_support_remittance')
      .reduce((s, l) => s + (l.monthlyReporting ?? 0), 0),
  );
}

/** The Twin's balance-sheet rows, all owners (as Net Worth), reporting currency, unconverted rows left out. */
export function twinBalanceSheetRows(snapshot: Pick<CanonicalFinancialSnapshot, 'assets' | 'investments' | 'liabilities'>): {
  rawAssets: TwinAssetRow[];
  rawInvestments: TwinInvestmentRow[];
  rawLiabilities: TwinLiabilityRow[];
} {
  const assets = requireSection(snapshot.assets, 'assets');
  const investments = requireSection(snapshot.investments, 'investments');
  const liabilities = requireSection(snapshot.liabilities, 'liabilities');
  return {
    rawAssets: assets.lines
      .filter((l) => l.value.amountReporting !== null)
      .map((l) => ({ current_value: l.value.amountReporting as number, asset_class: l.assetClass ?? 'other', master_item_key: l.masterItemKey, country_code: l.countryCode, currency_code: l.value.currency })),
    rawInvestments: investments.lines
      .filter((l) => l.value.amountReporting !== null)
      .map((l) => ({ current_value: l.value.amountReporting as number, investment_type: l.investmentType ?? 'other', master_item_key: l.masterItemKey, country_code: l.countryCode, currency_code: l.value.currency })),
    rawLiabilities: liabilities.lines
      .filter((l) => l.balance.amountReporting !== null)
      .map((l) => ({ balance: l.balance.amountReporting as number, debt_type: l.debtType, master_item_key: l.masterItemKey, interest_rate: l.interestRate, country_code: l.countryCode, currency_code: l.balance.currency })),
  };
}

function requireSection<T extends { status: string }>(section: T | { status: 'unavailable'; reason: string; source: string }, name: string): Extract<T, { status: 'ok' }> {
  if (section.status !== 'ok') {
    // DC-14: a failed read is never benchmarked as a zero. The Twin run fails
    // closed (no financial_twin_runs row is written from partial data).
    const u = section as { reason?: string; source?: string };
    throw new ReadModelUnavailableError(u.reason ?? 'unavailable', `twin:${name}:${u.source ?? name}`);
  }
  return section as Extract<T, { status: 'ok' }>;
}

function nullableNumber(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export async function loadTwinSourceData(userId: string, client?: SupabaseServerClient): Promise<TwinSourceDataOutcome> {
  const supabase = client ?? (await createClient());

  const [homeCountry, profileRes, householdRes, retirementMembersRes, snapshotsRes, crossBorderRes] =
    await Promise.all([
      // Canonical resolver (lib/services/jurisdiction.ts) — the single
      // source of truth every other correctly-behaving module uses. Fails
      // closed to null; never re-derived inline from profile?.country_of_residence
      // with a `?? 'AU'`-shaped fallback operator (the JA-D1 defect this
      // replaces).
      //
      // G3: narrowed to the FULL-experience variant. The Financial Twin
      // compares a user against a country cohort, and cohorts exist for AU
      // and IN only — annualGrossIncomeToIncomeBand() below still requires a
      // genuine 'AU'|'IN'. A GENERIC-experience country (GB/US/SG/AE)
      // therefore resolves to null and takes the SAME honest
      // 'country_unresolved' exit an unset country takes, rather than being
      // silently bucketed into the AU cohort. This is a narrowing only —
      // behaviour for AU and IN users is byte-identical to before.
      getUserFullExperienceHomeCountry(userId, supabase),
      supabase.from('user_profiles').select('date_of_birth, employment_status, country_of_residence, secondary_country, preferred_currency').eq('user_id', userId).single(),
      supabase.from('households').select('household_type, marital_status, dependants_count, housing_tenure, residence_type, primary_country').eq('user_id', userId).maybeSingle(),
      supabase.from('retirement_members').select('member_type, target_retirement_age').eq('user_id', userId).eq('is_active', true).eq('member_type', 'self').maybeSingle(),
      // WP-05: the MOST RECENT 12 monthly snapshots (newest first, reversed
      // below). The old read ordered ascending with limit(12) and so took the
      // household's OLDEST twelve months once it had more than a year of
      // history -- every trend metric compared stale months. A failed read
      // fails the run closed instead of reading as "no history".
      supabase
        .from('financial_snapshots')
        .select('snapshot_month, net_worth, monthly_income, monthly_expenses, monthly_surplus')
        .eq('user_id', userId)
        .order('snapshot_month', { ascending: false })
        .limit(12),
      // G6 Contract 10 (docs/country-programme/g6-data-contracts.md) — the
      // real cross-border signal, replacing the legacy Boolean(secondary_country)
      // read below (secondary_country in {'AU','IN'} only — this widens
      // correctness to any active declared relationship, in any country).
      supabase.from('cross_border_relationships').select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('status', 'ACTIVE'),
    ]);

  // Fail closed BEFORE running the expensive downstream engines (dashboard,
  // health score, resilience, DNA, goals) — an unresolved country can never
  // reach annualGrossIncomeToIncomeBand() (which requires a real 'AU'|'IN'),
  // so there is nothing valid to compute a Twin comparison from. This is the
  // single early-exit point; nothing past it ever runs with a null country.
  if (!homeCountry) {
    return { status: 'country_unresolved' };
  }

  // WP-05 (DC-04 / GAP-02 / EXP-G10): the Twin no longer computes its own
  // DashboardSummary. The private loader it used to call read income_sources
  // and expense_items raw -- no approved bank income or expenses, no
  // superseded_by_bank_import flag, no SMSF property-loan override, no
  // business entities, no paging, and errors coerced to [] -- so the Twin's
  // income band, surplus and Net Worth diverged from the very Dashboard it is
  // shown beside. It now takes the ONE shared loadDashboard() figure, and the
  // Twin-only inputs (housing, remittance, balance-sheet rows) come from the
  // canonical read-model snapshot.
  const [dashboard, snapshot, retirementRows, insuranceRows, healthScore, resilience, dna, goalsResult] = await Promise.all([
    loadDashboard(userId, supabase),
    buildCanonicalFinancialSnapshot(userId, { client: supabase }),
    // WP-05 (DC-18): paged -- a >1000-row register is never truncated; a
    // failed read fails the run closed instead of reading as "none".
    fetchAllRows<TwinRetirementRow>('retirement_accounts', (from, to) =>
      supabase
        .from('retirement_accounts')
        .select('current_balance, employer_contribution, personal_contribution, contribution_frequency, country_code, target_retirement_age, account_type')
        .eq('user_id', userId)
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, to)),
    fetchAllRows<TwinInsuranceRow>('insurance_policies', (from, to) =>
      supabase
        .from('insurance_policies')
        .select('cover_amount, premium, premium_frequency, cover_type, waiting_period_days')
        .eq('user_id', userId)
        .eq('is_active', true)
        .order('id', { ascending: true })
        .range(from, to)),
    loadHealthScore(userId, supabase),
    loadResilience(userId, supabase),
    loadFinancialDna(userId, supabase),
    computeGoalsPagePayload(userId, supabase),
  ]);
  if (snapshot.status !== 'ok') {
    throw new ReadModelUnavailableError(snapshot.reason, `twin:snapshot:${snapshot.source}`);
  }
  const goals = goalsResult.payload;

  const profile = profileRes.data;
  const household = householdRes.data;
  const countryOfResidence = homeCountry;
  const secondaryCountry = (profile?.secondary_country as 'AU' | 'IN' | null) ?? null;
  // G6 Contract 10 — secondaryCountry itself is untouched (still displayed
  // via TwinHouseholdContext.secondaryCountry below; the column is not
  // dropped, per the contract's own note), but the cross-border SIGNAL used
  // for isCrossBorder is now the real cross_border_relationships count.
  const age = profile?.date_of_birth ? ageFromDateOfBirth(profile.date_of_birth) : null;
  const ageBand = age !== null ? ageToAgeBand(age) : null;
  const dependantsCount = household?.dependants_count ?? 0;
  const employmentType = normalizeEmploymentType(profile?.employment_status ?? null);
  const householdTypeCode = normalizeHouseholdType(household?.household_type ?? null, dependantsCount);
  const lifeStage = deriveLifeStage({ ageBand, dependantsCount, employmentType });
  const annualGrossIncome = dashboard.grossMonthlyIncome * 12;
  const incomeBand = annualGrossIncomeToIncomeBand(countryOfResidence, annualGrossIncome);
  const isCrossBorder = (crossBorderRes.count ?? 0) > 0 || dashboard.countriesInUse.length > 1;

  const expenseHousingMonthly = twinHousingMonthly(snapshot);
  const remittanceMonthly = twinRemittanceMonthly(snapshot);
  const { rawAssets, rawInvestments, rawLiabilities } = twinBalanceSheetRows(snapshot);

  const insuranceAdequacy = computeInsuranceAdequacy(dashboard, dependantsCount);

  if (snapshotsRes.error) throw new ReadModelUnavailableError('query_failed', 'twin:financial_snapshots');
  if (retirementMembersRes.error) throw new ReadModelUnavailableError('query_failed', 'twin:retirement_members');
  const snapshotRows = (snapshotsRes.data ?? []) as { snapshot_month: string; net_worth: number | null; monthly_income: number | null; monthly_expenses: number | null; monthly_surplus: number | null }[];
  const snapshots12m: TwinSnapshotPoint[] = [...snapshotRows].reverse().map((s) => ({
    month: s.snapshot_month,
    netWorth: nullableNumber(s.net_worth),
    monthlyIncome: nullableNumber(s.monthly_income),
    monthlyExpenses: nullableNumber(s.monthly_expenses),
    monthlySurplus: nullableNumber(s.monthly_surplus),
  }));

  const hasMinimumData =
    Boolean(profile?.country_of_residence) &&
    age !== null &&
    dashboard.hasIncome &&
    dashboard.hasExpenses &&
    (dashboard.hasAssets || dashboard.hasLiabilities);

  const selfMember = retirementMembersRes.data as { target_retirement_age: number | null } | null;

  return {
    status: 'ok',
    data: {
      userId,
      household: {
        countryOfResidence,
        secondaryCountry,
        preferredCurrency: (profile?.preferred_currency as 'AUD' | 'INR') ?? 'AUD',
        age,
        ageBand,
        dependantsCount,
        employmentType,
        householdTypeCode,
        housingTenure: household?.housing_tenure ?? null,
        residenceType: household?.residence_type ?? null,
        lifeStage,
        incomeBand,
        isCrossBorder,
        dnaProfileCode: dna?.primaryProfileCode ?? null,
      },
      dashboard,
      insuranceAdequacy,
      healthScore,
      resilience,
      dna,
      goals,
      rawRetirement: retirementRows,
      selfTargetRetirementAge: selfMember?.target_retirement_age ?? null,
      rawInsurance: insuranceRows,
      rawInvestments,
      rawLiabilities,
      rawAssets,
      expenseHousingMonthly,
      remittanceMonthly,
      snapshots12m,
      hasMinimumData,
    },
  };
}
