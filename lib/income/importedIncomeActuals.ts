/**
 * WP-09 (GAP-06 income section) -- the Income tab's "Actual income from bank
 * statements" contract.
 *
 * ONE shape shared by the route (app/api/income/actuals/route.ts) and the
 * component (components/income/ImportedIncomeActuals.tsx), so the UI can
 * never read a field the route does not send (the snake_case / camelCase
 * blank-render trap -- tests/unit/incomeActualsRoute.test.ts pins it).
 *
 * The figures are the canonical Income read model's (selectIncome) and nothing
 * else:
 *   planned  = income_sources (manual rows and Applied payslips);
 *   actual   = approved bank income credits -- a credit that IS a payslip's
 *              pay (matched, Applied) is shown as "counted once with payslip"
 *              and never added again (GAP-01);
 *   variable = bonus / overtime / commission of Applied payslips, as dated
 *              one-off actual income (PO D-06).
 * Nothing here writes anything, and an imported credit is never copied into
 * income_sources.
 *
 * Client-safe: type-only imports from the read models, plus pure builders.
 */
import type { IncomeReadModelData, PlannedIncomeExclusion } from '@/lib/read-models/income';
import type { ProvenanceKind } from '@/lib/read-models/core/types';
import { fdhPages } from '@/lib/import-bridge/fdhRoutes';

export const PLANNED_EXCLUSION_LABELS: Record<PlannedIncomeExclusion, string> = {
  superseded_by_bank_import: 'Not counted: you marked it as tracked by your bank statements',
  smsf_owned: 'Not counted: belongs to your SMSF, not your household',
  unconverted: 'Not counted: its currency cannot be converted yet',
};

export const COUNTED_ONCE_LABEL = 'Counted once with payslip';

export interface PlannedIncomeLineDto {
  id: string;
  name: string;
  owner: string | null;
  frequency: string;
  currency: string;
  grossNative: number;
  /** null = net unknown (never the gross). */
  netNative: number | null;
  grossMonthly: number | null;
  netMonthly: number | null;
  counted: boolean;
  excludedLabel: string | null;
  sourceKind: ProvenanceKind;
  sourceLabel: string;
  /** True for a row Applied from a payslip: its payslip can be opened. */
  hasPayslipDetails: boolean;
}

export interface ActualIncomeLineDto {
  key: string;
  transactionId: string;
  date: string;
  month: string;
  description: string | null;
  amount: number;
  currency: string;
  /** null = currency could not be converted; shown, never totalled. */
  amountReporting: number | null;
  coverage: 'covered' | 'partial';
  treatment: 'counted' | 'represented_by_planned_source';
  /** 'Counted' / 'Counted once with payslip'. */
  treatmentLabel: string;
  /** The Income row this credit is the same money as (GAP-01). */
  representedByName: string | null;
  /** PO D-07: an unlinked credit that looks like a planned source. */
  possibleDuplicateOf: { sourceId: string; name: string }[];
  sourceLabel: string;
  statementHref: string | null;
  accountName: string | null;
}

export interface VariablePayLineDto {
  payrollEventId: string;
  sourceId: string;
  sourceName: string | null;
  date: string;
  employerName: string | null;
  grossNative: number;
  currency: string;
  grossReporting: number | null;
}

export interface IncomeActualsOk {
  status: 'ok';
  reportingCurrency: string;
  window: { from: string; to: string; months: string[] };
  planned: {
    lines: PlannedIncomeLineDto[];
    grossMonthly: number;
    netKnownMonthly: number;
    netUnknownCount: number;
    unconverted: { count: number; byCurrency: Record<string, number> };
  };
  actual: {
    lines: ActualIncomeLineDto[];
    countedMonthly: number;
    countedCount: number;
    representedCount: number;
    possibleDuplicateCount: number;
    unconverted: { count: number; byCurrency: Record<string, number> };
  };
  variablePay: { lines: VariablePayLineDto[]; grossMonthly: number };
  combined: {
    grossMonthly: number;
    /** null when some counted component's net is unknown -- never guessed. */
    netMonthly: number | null;
    netKnownMonthly: number;
    grossIncludesNetFloor: boolean;
  };
  hasPlanned: boolean;
  hasActual: boolean;
}

export type IncomeActualsDto = IncomeActualsOk | { status: 'unavailable'; reason: string };

/** Pure: read model -> the Income-tab DTO. */
export function toIncomeActualsDto(data: IncomeReadModelData): IncomeActualsOk {
  const nameById = new Map(data.planned.lines.map((p) => [p.id, p.name] as const));
  const actualLines = [...data.actual.lines].sort((a, b) => (a.date === b.date ? a.key.localeCompare(b.key) : a.date < b.date ? 1 : -1));
  const counted = actualLines.filter((l) => l.treatment === 'counted');
  return {
    status: 'ok',
    reportingCurrency: data.reportingCurrency,
    window: { from: data.window.from, to: data.window.to, months: [...data.window.months] },
    planned: {
      lines: data.planned.lines.map((p) => ({
        id: p.id,
        name: p.name,
        owner: p.owner,
        frequency: p.frequency,
        currency: p.currency,
        grossNative: p.grossNative,
        netNative: p.netNative,
        grossMonthly: p.grossMonthly,
        netMonthly: p.netMonthly,
        counted: p.excludedReason === null,
        excludedLabel: p.excludedReason ? PLANNED_EXCLUSION_LABELS[p.excludedReason] : null,
        sourceKind: p.provenance.kind,
        sourceLabel: p.provenance.label,
        hasPayslipDetails: p.provenance.kind === 'payslip_import',
      })),
      grossMonthly: data.planned.grossMonthly,
      netKnownMonthly: data.planned.netKnownMonthly,
      netUnknownCount: data.planned.netUnknownCount,
      unconverted: { count: data.planned.unconverted.count, byCurrency: { ...data.planned.unconverted.byCurrency } },
    },
    actual: {
      lines: actualLines.map((l) => ({
        key: l.key,
        transactionId: l.transactionId,
        date: l.date,
        month: l.month,
        description: l.description,
        amount: l.amountNative,
        currency: l.currency,
        amountReporting: l.amountReporting,
        coverage: l.coverage,
        treatment: l.treatment,
        treatmentLabel: l.treatment === 'represented_by_planned_source' ? COUNTED_ONCE_LABEL : 'Counted',
        representedByName: l.representedBySourceId ? nameById.get(l.representedBySourceId) ?? null : null,
        possibleDuplicateOf: l.possibleDuplicateOf.map((d) => ({ sourceId: d.sourceId, name: d.name })),
        sourceLabel: l.provenance.label,
        statementHref: l.provenance.statementUploadId ? fdhPages.statementReview(l.provenance.statementUploadId, 'income') : null,
        accountName: l.accountName,
      })),
      countedMonthly: data.actual.countedMonthly,
      countedCount: counted.length,
      representedCount: data.actual.representedCount,
      possibleDuplicateCount: data.actual.possibleDuplicateCount,
      unconverted: { count: data.actual.unconverted.count, byCurrency: { ...data.actual.unconverted.byCurrency } },
    },
    variablePay: {
      lines: data.actual.variablePay.lines.map((v) => ({
        payrollEventId: v.payrollEventId,
        sourceId: v.sourceId,
        sourceName: nameById.get(v.sourceId) ?? null,
        date: v.date,
        employerName: v.employerName,
        grossNative: v.grossNative,
        currency: v.currency,
        grossReporting: v.grossReporting,
      })),
      grossMonthly: data.actual.variablePay.grossMonthly,
    },
    combined: {
      grossMonthly: data.combined.grossMonthly,
      netMonthly: data.combined.netMonthly,
      netKnownMonthly: data.combined.netKnownMonthly,
      grossIncludesNetFloor: data.combined.grossIncludesNetFloor,
    },
    hasPlanned: data.flags.hasPlanned,
    hasActual: data.flags.hasActual,
  };
}
