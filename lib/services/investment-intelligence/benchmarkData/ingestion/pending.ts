// BENCH-1 Phase 2 - governed MANUAL-IMPORT mode and the pending-import task.
//
// Where a source cannot be automated permissibly (today: every Indian index
// owner - see SOURCE_DECISION.md), the benchmark stays in manual_import mode.
// This module turns the stored watermarks into an HONEST operator task list:
//
//   * how recent the latest stored level is,
//   * whether a manual upload is DUE or OVERDUE against the expected session,
//   * whether required history is still MISSING at the start (demand),
//
// and it never describes a manual upload as an automatic update: the wording
// says "upload", the status vocabulary says manual_import, and a benchmark with
// no data at all is `never_imported`, not "up to date".
import { formatDateShort } from '@/lib/engines/date';
import { addDaysIso, assessCompleteness, expectedLatestSession, weekdaysAfter } from './calendar';

/** A date inside the operator-facing action sentence: day-first dd-mm-yyyy (India format), never ISO year-first (PO rule, Document2 findings #8/#19). */
function fd(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? formatDateShort(iso, 'INR') : iso;
}

export type PendingImportStatus = 'current' | 'due' | 'overdue' | 'never_imported' | 'not_manual';

/** Weekdays behind the expected session before a manual import is OVERDUE (default). */
export const OVERDUE_AFTER_WEEKDAYS = 3;

export interface PendingImportInput {
  benchmarkKey: string;
  benchmarkLabel: string;
  ingestionMode: 'disabled' | 'manual_import' | 'automated';
  publicationLagDays: number;
  latestValidDataDate: string | null;
  /** From ii_benchmark_history_demand; null when no held scheme needs this benchmark yet. */
  requiredFrom: string | null;
  /** Stored level dates, only for history-gap detection (optional; keep small - first N years). */
  storedDates?: ReadonlySet<string>;
}

export interface PendingImportTask {
  benchmarkKey: string;
  benchmarkLabel: string;
  status: PendingImportStatus;
  latestValidDataDate: string | null;
  expectedLatestSession: string;
  weekdaysBehind: number | null;
  historyMissingFrom: string | null;
  severity: 'info' | 'warning' | 'critical';
  /** What the operator should do, in plain words. Always "upload", never "update automatically". */
  action: string;
}

export function assessPendingImport(input: PendingImportInput, nowIso: string, opts?: { overdueAfterWeekdays?: number; holidays?: ReadonlySet<string> }): PendingImportTask {
  const expected = expectedLatestSession(nowIso, input.publicationLagDays, opts?.holidays);
  const overdueAfter = opts?.overdueAfterWeekdays ?? OVERDUE_AFTER_WEEKDAYS;
  const base = { benchmarkKey: input.benchmarkKey, benchmarkLabel: input.benchmarkLabel, expectedLatestSession: expected };

  if (input.ingestionMode !== 'manual_import') {
    return { ...base, status: 'not_manual', latestValidDataDate: input.latestValidDataDate, weekdaysBehind: null, historyMissingFrom: null, severity: 'info', action: input.ingestionMode === 'automated' ? 'Automated mode: monitored by the ingestion runs, not by manual imports.' : 'Ingestion is disabled for this benchmark.' };
  }
  if (input.latestValidDataDate === null) {
    return {
      ...base,
      status: 'never_imported',
      latestValidDataDate: null,
      weekdaysBehind: null,
      historyMissingFrom: input.requiredFrom,
      severity: input.requiredFrom ? 'critical' : 'warning',
      action: `No ${input.benchmarkLabel} levels have been imported. Upload a history file (Admin > Market Index Data > Upload). This is a manual import, not an automatic update.`,
    };
  }
  const behind = Math.max(0, weekdaysAfter(input.latestValidDataDate, expected, opts?.holidays));
  let status: PendingImportStatus = behind === 0 ? 'current' : behind > overdueAfter ? 'overdue' : 'due';
  let historyMissingFrom: string | null = null;
  if (input.requiredFrom && input.storedDates) {
    const a = assessCompleteness(input.storedDates, input.requiredFrom, input.latestValidDataDate, { holidays: opts?.holidays });
    if (a.watermark === null || (a.firstIntolerableGap && a.firstIntolerableGap.from <= addDaysIso(input.requiredFrom, 7))) historyMissingFrom = input.requiredFrom;
  }
  if (status === 'current' && historyMissingFrom) status = 'due';
  const severity: PendingImportTask['severity'] = status === 'overdue' ? 'critical' : status === 'due' ? 'warning' : 'info';
  const action =
    status === 'current'
      ? `Up to date through ${fd(input.latestValidDataDate)} (manual imports).`
      : historyMissingFrom && behind === 0
        ? `History is missing from ${fd(historyMissingFrom)}: upload the historical file for ${input.benchmarkLabel} (manual import).`
        : `Latest imported level is ${fd(input.latestValidDataDate)}; the expected latest session is ${fd(expected)} (${behind} weekday${behind === 1 ? '' : 's'} behind). Upload the latest file for ${input.benchmarkLabel} (manual import; nothing updates automatically).`;
  return { ...base, status, latestValidDataDate: input.latestValidDataDate, weekdaysBehind: behind, historyMissingFrom, severity, action };
}
