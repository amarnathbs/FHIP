/**
 * What a destination account's contribution rate is, from the ledger -- counted EXACTLY ONCE.
 *
 * The rest of the app reads two figures per retirement account (employer_contribution, personal_contribution + one
 * contribution_frequency). This module derives those two figures from the ledger so every consumer (Dashboard, Health Score,
 * Twin, Forecast, SMSF reports) keeps reading one place and nothing is added twice.
 *
 * THE RULES (each has a named test):
 *  1. Only 'active' rows with a destination count. needs_destination, superseded and removed rows never count.
 *  2. A one-off (a dated payment, no recurring frequency) is history. It is a flow that happened; it is NOT projected as a monthly rate.
 *  3. A row with no known frequency is UNKNOWN and is left out of the rate (never assumed monthly).
 *  4. A SERIES is one economic contribution: the same account, type, person and employer. Within a series ONLY the latest
 *     record counts (a payslip every fortnight is the same contribution, not 26 of them).
 *  5. A manual record that names no employer is the same flow as a payslip series of the same account, type and person
 *     when there is exactly one such series: the later record is used, the other is excluded and reported (no payslip + manual duplicate).
 *  6. The rate is the sum of the counted series, as a monthly amount.
 */
import { toMonthly, type Frequency } from '@/lib/engines/money';
import { BUCKET_OF_TYPE, type ContributionBucket, type LedgerRow } from './types';

export type ExclusionReason =
  | 'not_active'
  | 'one_off_history'
  | 'unknown_frequency'
  | 'older_in_series'
  | 'same_flow_as_payslip'
  | 'same_flow_as_manual';

export interface SeriesOutcome {
  accountId: string;
  bucket: ContributionBucket;
  key: string;
  counted: LedgerRow;
  monthly: number;
}

export interface ExcludedRow {
  row: LedgerRow;
  reason: ExclusionReason;
}

export interface AccountRate {
  accountId: string;
  employerMonthly: number;
  personalMonthly: number;
  series: SeriesOutcome[];
  excluded: ExcludedRow[];
}

function effectiveDate(row: LedgerRow): string {
  // An adopted legacy figure always loses to a real record for the same flow.
  if (row.isAdoptedLegacy) return '0000-00-00';
  return row.contributionDate ?? row.createdAt.slice(0, 10);
}

function isNewer(a: LedgerRow, b: LedgerRow): boolean {
  const da = effectiveDate(a);
  const db = effectiveDate(b);
  if (da !== db) return da > db;
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.id > b.id;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function resolveAccountRates(rows: readonly LedgerRow[]): Map<string, AccountRate> {
  const out = new Map<string, AccountRate>();
  const recurringByAccount = new Map<string, LedgerRow[]>();
  const excludedByAccount = new Map<string, ExcludedRow[]>();
  const exclude = (accountId: string | null, row: LedgerRow, reason: ExclusionReason) => {
    if (!accountId) return;
    const list = excludedByAccount.get(accountId) ?? [];
    list.push({ row, reason });
    excludedByAccount.set(accountId, list);
  };

  for (const row of rows) {
    if (row.status !== 'active') { exclude(row.retirementAccountId, row, 'not_active'); continue; }
    if (!row.retirementAccountId) continue;
    if (row.frequency === null) { exclude(row.retirementAccountId, row, 'unknown_frequency'); continue; }
    if (row.frequency === 'one_off') { exclude(row.retirementAccountId, row, 'one_off_history'); continue; }
    const list = recurringByAccount.get(row.retirementAccountId) ?? [];
    list.push(row);
    recurringByAccount.set(row.retirementAccountId, list);
  }

  const accountIds = new Set<string>([...recurringByAccount.keys(), ...excludedByAccount.keys()]);
  for (const accountId of accountIds) {
    const rate: AccountRate = { accountId, employerMonthly: 0, personalMonthly: 0, series: [], excluded: [...(excludedByAccount.get(accountId) ?? [])] };
    const list = recurringByAccount.get(accountId) ?? [];

    // Series = type + person + employer ('' when none is named).
    const groups = new Map<string, LedgerRow[]>();
    for (const row of list) {
      const key = `${row.type}|${row.memberId ?? ''}|${row.employerNormalised ?? ''}`;
      const g = groups.get(key) ?? [];
      g.push(row);
      groups.set(key, g);
    }

    // Rule 5: an employer-less manual group merges into the ONE payslip group of the same type and person.
    for (const [key, g] of [...groups.entries()]) {
      const [type, member, employer] = key.split('|');
      if (employer !== '' || !g.every((r) => r.sourceType === 'manual')) continue;
      const payslipGroups = [...groups.entries()].filter(([k, grp]) => {
        const [t, m, e] = k.split('|');
        return t === type && m === member && e !== '' && grp.some((r) => r.sourceType === 'payslip');
      });
      if (payslipGroups.length === 1) {
        groups.delete(key);
        payslipGroups[0][1].push(...g);
      }
    }

    for (const [key, g] of groups) {
      const sorted = [...g].sort((a, b) => (isNewer(a, b) ? -1 : 1));
      const winner = sorted[0];
      for (const loser of sorted.slice(1)) {
        const reason: ExclusionReason =
          loser.sourceType !== winner.sourceType ? (winner.sourceType === 'payslip' ? 'same_flow_as_payslip' : 'same_flow_as_manual') : 'older_in_series';
        rate.excluded.push({ row: loser, reason });
      }
      const monthly = round2(toMonthly(winner.amount, winner.frequency as Frequency));
      const bucket = BUCKET_OF_TYPE[winner.type];
      rate.series.push({ accountId, bucket, key, counted: winner, monthly });
      if (bucket === 'employer') rate.employerMonthly = round2(rate.employerMonthly + monthly);
      else rate.personalMonthly = round2(rate.personalMonthly + monthly);
    }
    out.set(accountId, rate);
  }
  return out;
}

/**
 * A bucket of an account is GOVERNED by the ledger once the ledger holds an active row for that account and bucket (a recurring
 * one or a one-off: either way the person has recorded contributions for it, so the account column must not keep a second,
 * separate figure). A governed bucket's account column is derived from the ledger; an ungoverned bucket keeps whatever the
 * account already holds, untouched.
 */
export function governedBuckets(rows: readonly LedgerRow[], accountId: string): Set<ContributionBucket> {
  const set = new Set<ContributionBucket>();
  for (const r of rows) {
    if (r.retirementAccountId === accountId && r.status === 'active') set.add(BUCKET_OF_TYPE[r.type]);
  }
  return set;
}
