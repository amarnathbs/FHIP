/**
 * selectIncome -- the canonical Income read model (WP-02).
 *
 *  - PLANNED = active income_sources (manual rows and Applied payslips), with
 *    their currency, owner and source_type. superseded_by_bank_import rows and
 *    SMSF-owned rows are left out, and say why.
 *  - ACTUAL  = approved bank income credits (allocation- and dedup-aware, via
 *    the shared ledger), averaged over covered months.
 *  - ONE EVENT PER FACT (GAP-01): a bank credit that an approved payslip is
 *    matched to (fdh_payroll_events.bank_match_transaction_id), where that
 *    payslip was Applied to an income_sources row (fhip_import_applications.
 *    source_payroll_event_id -> target_entity_id) that is still counted, is the
 *    SAME money as that planned row: it is shown as corroborating evidence and
 *    NOT added again. Payslip 5,000 net + bank 5,000 credit = 5,000.
 *  - PO D-06: variable pay (bonus / overtime / commission / other earnings) of
 *    an Applied payslip is a dated one-off ACTUAL income event (gross), since
 *    the recurring income row excludes it and the matched bank credit is not
 *    counted separately.
 *  - PO D-07: an approved bank income credit with NO payslip link is counted as
 *    actual income; when it resembles a planned source it carries a "possible
 *    duplicate of <source>" prompt for the user to resolve. A household with
 *    only bank income has net known and gross unknown: gross uses net as a
 *    floor and says so (grossIncludesNetFloor).
 *  - GAP-09: a null net_amount is UNKNOWN, never the gross.
 *  - Broker dividends in ii_* are never read here: the bank credit is the
 *    single household-income leg (INV-G4).
 */
import '@/lib/serverOnly';
import { toMonthly, type Frequency } from '@/lib/engines/money';
import { resolveContext, type ReadModelOptions } from './core/context';
import { toReporting, type FxContext, type ReportingCurrency } from './core/currency';
import { coveredMonthlyAverage, type ActualLine, type NormalisedLedger } from './core/ledger';
import { fetchAllRows, type ReadModelClient } from './core/paginate';
import { toMinor } from './core/spendingRules';
import { addUnconverted, emptyUnconverted, isHouseholdOwner, provenance, roundMoney, toUnavailable, type Provenance, type ReadModelResult, type UnconvertedTally } from './core/types';
import { isDateInWindow, type ReadWindow } from './core/window';

export interface IncomeSourceRow {
  id: string;
  source_name: string;
  income_type: string | null;
  amount: number;
  net_amount: number | null;
  frequency: string;
  currency_code: string;
  owner: string | null;
  master_item_key: string | null;
  employer_name: string | null;
  source_type: string | null;
  superseded_by_bank_import: boolean | null;
}

export interface PayrollEventRow {
  id: string;
  employer_name: string | null;
  currency_code: string;
  payment_date: string | null;
  pay_period_end: string | null;
  gross_pay: number | null;
  net_pay: number | null;
  bonus_pay: number | null;
  overtime_pay: number | null;
  commission_pay: number | null;
  other_earnings: number | null;
  approval_status: string;
  superseded_by_payroll_event_id: string | null;
}

export interface IncomeApplicationRow {
  source_payroll_event_id: string | null;
  target_entity_id: string;
}

export type PlannedIncomeExclusion = 'superseded_by_bank_import' | 'smsf_owned' | 'unconverted';

export interface PlannedIncomeLine {
  id: string;
  name: string;
  incomeType: string | null;
  masterItemKey: string | null;
  employerName: string | null;
  owner: string | null;
  frequency: string;
  currency: string;
  grossNative: number;
  netNative: number | null;
  grossMonthly: number | null;
  /** null = net unknown (GAP-09) or unconverted. */
  netMonthly: number | null;
  excludedReason: PlannedIncomeExclusion | null;
  provenance: Provenance;
}

export interface ActualIncomeLine extends ActualLine {
  /** 'counted' or why not. */
  treatment: 'counted' | 'represented_by_planned_source';
  /** The income_sources row this credit is the same money as, when represented. */
  representedBySourceId: string | null;
  /** D-07 review prompt: planned sources this unlinked credit may duplicate. */
  possibleDuplicateOf: { sourceId: string; name: string }[];
}

export interface VariablePayLine {
  payrollEventId: string;
  sourceId: string;
  date: string;
  employerName: string | null;
  grossNative: number;
  currency: string;
  grossReporting: number | null;
  provenance: Provenance;
}

export interface IncomeReadModelData {
  window: ReadWindow;
  reportingCurrency: ReportingCurrency;
  planned: {
    lines: PlannedIncomeLine[];
    grossMonthly: number;
    netKnownMonthly: number;
    /** Counted planned lines whose net is unknown. */
    netUnknownCount: number;
    unconverted: UnconvertedTally;
  };
  actual: {
    lines: ActualIncomeLine[];
    /** Monthly average of COUNTED credits over covered months (net figures). */
    countedMonthly: number;
    representedCount: number;
    possibleDuplicateCount: number;
    variablePay: { lines: VariablePayLine[]; grossMonthly: number };
    unconverted: UnconvertedTally;
  };
  combined: {
    grossMonthly: number;
    /** null when any counted component's net is unknown -- see netKnownMonthly. */
    netMonthly: number | null;
    netKnownMonthly: number;
    netUnknownComponents: number;
    /** True when bank credits (net-only) are inside grossMonthly as a floor (D-07). */
    grossIncludesNetFloor: boolean;
  };
  flags: { hasPlanned: boolean; hasActual: boolean; hasAny: boolean };
}

export type IncomeReadModel = ReadModelResult<IncomeReadModelData>;

const r = roundMoney;

export interface ComputeIncomeInput {
  sources: readonly IncomeSourceRow[];
  payrollEvents: readonly PayrollEventRow[];
  applications: readonly IncomeApplicationRow[];
  ledger: NormalisedLedger;
  fx: FxContext;
}

/** Per-occurrence amount of a planned source (what one deposit would be). */
function perOccurrence(row: IncomeSourceRow): number {
  return Number(row.net_amount ?? row.amount);
}

/**
 * ISO-8601 week key ('GGGG-Www', Mon-Sun) for a plain YYYY-MM-DD date. Used
 * only to group same-week D-07 split-salary candidates -- see the comment at
 * its call site in computeIncome for why a fixed calendar week (not a rolling
 * 7-day window) is used.
 */
function isoWeekKey(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  // Shift to the Thursday of this ISO week (ISO weeks belong to the year of their Thursday).
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const isoYear = t.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function computeIncome(input: ComputeIncomeInput): IncomeReadModelData {
  const { fx, ledger } = input;
  const plannedUnconverted = emptyUnconverted();
  const planned: PlannedIncomeLine[] = input.sources.map((row) => {
    const grossNative = Number(row.amount);
    const netNative = row.net_amount == null ? null : Number(row.net_amount);
    const grossMonthly = toReporting(r(toMonthly(grossNative, row.frequency as Frequency) || 0), row.currency_code, fx);
    const netMonthly = netNative == null ? null : toReporting(r(toMonthly(netNative, row.frequency as Frequency) || 0), row.currency_code, fx);
    let excludedReason: PlannedIncomeExclusion | null = null;
    if (row.superseded_by_bank_import) excludedReason = 'superseded_by_bank_import';
    else if (!isHouseholdOwner(row.owner)) excludedReason = 'smsf_owned';
    else if (grossMonthly === null) excludedReason = 'unconverted';
    if (excludedReason === 'unconverted') addUnconverted(plannedUnconverted, row.currency_code, grossNative);
    return {
      id: row.id, name: row.source_name, incomeType: row.income_type, masterItemKey: row.master_item_key, employerName: row.employer_name,
      owner: row.owner, frequency: row.frequency, currency: row.currency_code, grossNative, netNative, grossMonthly, netMonthly, excludedReason,
      provenance: row.source_type === 'payslip_import' ? provenance('payslip_import') : provenance('manual'),
    };
  });
  const countedPlanned = planned.filter((p) => p.excludedReason === null);
  const countedSourceIds = new Set(countedPlanned.map((p) => p.id));
  const sourceById = new Map(input.sources.map((s) => [s.id, s] as const));

  // payroll event -> the counted income source it was Applied to.
  const appliedEventToSource = new Map<string, string>();
  for (const a of input.applications) {
    if (a.source_payroll_event_id && countedSourceIds.has(a.target_entity_id)) appliedEventToSource.set(a.source_payroll_event_id, a.target_entity_id);
  }

  const actualUnconverted = emptyUnconverted();

  interface BaseLine {
    l: ActualLine;
    treatment: 'counted' | 'represented_by_planned_source';
    representedBySourceId: string | null;
    /** ANY payroll_event corroboration (not just an Applied one) rules out a D-07 prompt entirely. */
    isPayrollCorroborated: boolean;
  }
  const baseLines: BaseLine[] = ledger.lines
    .filter((l) => l.bucket === 'income' && l.household)
    .map((l) => {
      const payroll = l.corroboratedBy.find((c) => c.kind === 'payroll_event' && appliedEventToSource.has(c.sourceId));
      if (payroll) {
        return { l, treatment: 'represented_by_planned_source', representedBySourceId: appliedEventToSource.get(payroll.sourceId)!, isPayrollCorroborated: true };
      }
      if (l.amountReporting === null) addUnconverted(actualUnconverted, l.currency, l.amountNative);
      return { l, treatment: 'counted', representedBySourceId: null, isPayrollCorroborated: l.corroboratedBy.some((c) => c.kind === 'payroll_event') };
    });

  // D-07 single-line match: one actual line within 5% of one planned occurrence (unchanged).
  const singleMatch = new Map<string, { sourceId: string; name: string }[]>();
  for (const b of baseLines) {
    if (b.treatment !== 'counted' || b.isPayrollCorroborated) continue;
    const matches = countedPlanned
      .filter((p) => p.currency === b.l.currency)
      .filter((p) => {
        const occ = perOccurrence(sourceById.get(p.id)!);
        return occ > 0 && Math.abs(toMinor(occ) - toMinor(b.l.amountNative)) <= toMinor(occ) * 0.05;
      })
      .map((p) => ({ sourceId: p.id, name: p.name }));
    if (matches.length > 0) singleMatch.set(b.l.key, matches);
  }

  // D-07 split-salary match: a genuinely split salary (e.g. 3,000 + 2,000 bank
  // deposits for a 5,000 planned wage) has neither deposit alone matching the
  // single-line 5% check, so both were silently counted as EXTRA income on top
  // of the planned source (double-counting). Up to 2 same-currency lines that
  // neither matched alone are grouped by same ISO-8601 week (Mon-Sun) of their
  // transaction date -- NOT a rolling 7-day window, which would need an
  // arbitrary choice of which line's date anchors it, and NOT by
  // description/employer text, since a genuinely split payment can legitimately
  // carry different bank descriptions per leg -- and accepted if their SUM is
  // within 10% (wider than the single-line 5%, since two independent deposit
  // amounts compound more rounding/timing slack) of a planned occurrence.
  const pairMatch = new Map<string, { sourceId: string; name: string }[]>();
  const pairEligible = baseLines.filter((b) => b.treatment === 'counted' && !b.isPayrollCorroborated && !singleMatch.has(b.l.key));
  const byWeek = new Map<string, BaseLine[]>();
  for (const b of pairEligible) {
    const wk = `${b.l.currency}|${isoWeekKey(b.l.date)}`;
    if (!byWeek.has(wk)) byWeek.set(wk, []);
    byWeek.get(wk)!.push(b);
  }
  for (const group of byWeek.values()) {
    if (group.length < 2) continue;
    // Deterministic order within the group before any combinatorics: by date, then key.
    const sorted = [...group].sort((a, c) => (a.l.date === c.l.date ? a.l.key.localeCompare(c.l.key) : a.l.date < c.l.date ? -1 : 1));
    interface PairCandidate { i: number; j: number; matches: { sourceId: string; name: string }[]; closeness: number; earliestDate: string }
    const pairCandidates: PairCandidate[] = [];
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const sumMinor = toMinor(sorted[i].l.amountNative + sorted[j].l.amountNative);
        const scored = countedPlanned
          .filter((p) => p.currency === sorted[i].l.currency)
          .map((p) => {
            const occ = perOccurrence(sourceById.get(p.id)!);
            return { p, occ, diff: occ > 0 ? Math.abs(toMinor(occ) - sumMinor) : Infinity, occMinor: toMinor(occ) };
          })
          .filter((s) => s.occ > 0 && s.diff <= s.occMinor * 0.1);
        if (scored.length === 0) continue;
        pairCandidates.push({
          i, j,
          matches: scored.map((s) => ({ sourceId: s.p.id, name: s.p.name })),
          closeness: Math.min(...scored.map((s) => s.diff)),
          earliestDate: sorted[i].l.date < sorted[j].l.date ? sorted[i].l.date : sorted[j].l.date,
        });
      }
    }
    // Tie-break when 3+ candidates in one week could each pair up more than one
    // way: closest-to-target-sum first (there is no single objectively-correct
    // rule here -- this favours the best-fitting pair over an arbitrary one),
    // then earliest-dated pair, then key order, for full determinism.
    pairCandidates.sort((a, c) => a.closeness - c.closeness || (a.earliestDate !== c.earliestDate ? (a.earliestDate < c.earliestDate ? -1 : 1) : sorted[a.i].l.key.localeCompare(sorted[c.i].l.key)));
    const claimed = new Set<number>();
    for (const cand of pairCandidates) {
      if (claimed.has(cand.i) || claimed.has(cand.j)) continue;
      claimed.add(cand.i);
      claimed.add(cand.j);
      pairMatch.set(sorted[cand.i].l.key, cand.matches);
      pairMatch.set(sorted[cand.j].l.key, cand.matches);
    }
  }

  const actualLines: ActualIncomeLine[] = baseLines.map((b) => {
    if (b.treatment === 'represented_by_planned_source') {
      return { ...b.l, treatment: b.treatment, representedBySourceId: b.representedBySourceId!, possibleDuplicateOf: [] };
    }
    const possibleDuplicateOf = singleMatch.get(b.l.key) ?? pairMatch.get(b.l.key) ?? [];
    return { ...b.l, treatment: 'counted' as const, representedBySourceId: null, possibleDuplicateOf };
  });
  const counted = actualLines.filter((l) => l.treatment === 'counted');
  const countedMonthly = coveredMonthlyAverage(ledger, counted);

  // D-06 variable pay of Applied, approved, current payslips dated in the window.
  const variablePay: VariablePayLine[] = [];
  for (const e of input.payrollEvents) {
    const sourceId = appliedEventToSource.get(e.id);
    if (!sourceId || e.approval_status !== 'approved' || e.superseded_by_payroll_event_id) continue;
    const date = e.payment_date ?? e.pay_period_end;
    if (!date || !isDateInWindow(date, ledger.window)) continue;
    const parts = [e.bonus_pay, e.overtime_pay, e.commission_pay, e.other_earnings].filter((v): v is number => v != null).map(Number);
    const gross = r(parts.reduce((s, v) => s + v, 0));
    if (gross <= 0) continue;
    variablePay.push({
      payrollEventId: e.id, sourceId, date, employerName: e.employer_name, grossNative: gross, currency: e.currency_code,
      grossReporting: toReporting(gross, e.currency_code, fx), provenance: provenance('payslip_import'),
    });
  }
  const windowMonths = Math.max(ledger.window.months.length, 1);
  const variableGrossMonthly = r(variablePay.reduce((s, v) => s + (v.grossReporting ?? 0), 0) / windowMonths);

  const plannedGross = r(countedPlanned.reduce((s, p) => s + (p.grossMonthly ?? 0), 0));
  const plannedNetKnown = r(countedPlanned.reduce((s, p) => s + (p.netMonthly ?? 0), 0));
  const plannedNetUnknown = countedPlanned.filter((p) => p.netMonthly === null).length;
  const netUnknownComponents = plannedNetUnknown + (variableGrossMonthly > 0 ? 1 : 0);
  const netKnownMonthly = r(plannedNetKnown + countedMonthly);

  return {
    window: ledger.window,
    reportingCurrency: fx.reportingCurrency,
    planned: { lines: planned, grossMonthly: plannedGross, netKnownMonthly: plannedNetKnown, netUnknownCount: plannedNetUnknown, unconverted: plannedUnconverted },
    actual: {
      lines: actualLines,
      countedMonthly,
      representedCount: actualLines.length - counted.length,
      possibleDuplicateCount: counted.filter((l) => l.possibleDuplicateOf.length > 0).length,
      variablePay: { lines: variablePay, grossMonthly: variableGrossMonthly },
      unconverted: actualUnconverted,
    },
    combined: {
      grossMonthly: r(plannedGross + countedMonthly + variableGrossMonthly),
      netMonthly: netUnknownComponents > 0 ? null : netKnownMonthly,
      netKnownMonthly,
      netUnknownComponents,
      grossIncludesNetFloor: countedMonthly > 0,
    },
    flags: { hasPlanned: countedPlanned.length > 0, hasActual: counted.length > 0 || variablePay.length > 0, hasAny: countedPlanned.length > 0 || counted.length > 0 || variablePay.length > 0 },
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export async function loadIncomeInputs(userId: string, client: ReadModelClient): Promise<Pick<ComputeIncomeInput, 'sources' | 'payrollEvents' | 'applications'>> {
  const sources = await fetchAllRows<IncomeSourceRow>('income_sources', (from, to) =>
    client
      .from('income_sources')
      .select('id, source_name, income_type, amount, net_amount, frequency, currency_code, owner, master_item_key, employer_name, source_type, superseded_by_bank_import')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(from, to));
  const payrollEvents = await fetchAllRows<PayrollEventRow>('fdh_payroll_events', (from, to) =>
    client
      .from('fdh_payroll_events')
      .select('id, employer_name, currency_code, payment_date, pay_period_end, gross_pay, net_pay, bonus_pay, overtime_pay, commission_pay, other_earnings, approval_status, superseded_by_payroll_event_id')
      .eq('user_id', userId)
      .eq('approval_status', 'approved')
      .order('id', { ascending: true })
      .range(from, to));
  const applications = await fetchAllRows<IncomeApplicationRow>('fhip_import_applications', (from, to) =>
    client
      .from('fhip_import_applications')
      .select('source_payroll_event_id, target_entity_id')
      .eq('user_id', userId)
      .eq('target_domain', 'income')
      .order('target_entity_id', { ascending: true })
      .range(from, to));
  return { sources, payrollEvents, applications };
}

/** THE Income selector. Any failed read -> { status: 'unavailable' }. */
export async function selectIncome(userId: string, opts: ReadModelOptions): Promise<IncomeReadModel> {
  try {
    const ctx = await resolveContext(userId, opts);
    const [inputs, ledger] = await Promise.all([loadIncomeInputs(userId, ctx.client), ctx.ledger()]);
    return { status: 'ok', ...computeIncome({ ...inputs, ledger, fx: ctx.fx }) };
  } catch (error) {
    return toUnavailable(error, 'selectIncome');
  }
}
