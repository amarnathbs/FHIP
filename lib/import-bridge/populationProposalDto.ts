/**
 * WP-15 -- the wire shapes of the two Input Population Proposal routes, shared
 * by route and component (one type, so the UI can never read a field the
 * route does not send). Client-safe: pure mappers, type-only imports.
 */
import type { BankBalanceProposalItem, BankBalanceState, ExpensePopulationResult } from './populationProposals';
import type { RecommendedApplyMode } from './types';
import { UNMATCHED_REASON_LABELS, type UnmatchedReason } from './expenseCategoryMapping';

export interface PlannedFromActualsItemDto {
  masterItemKey: string;
  label: string;
  groupLabel: string;
  actualMonthly: number;
  coveredLineCount: number;
  existing: { name: string; amount: number; frequency: string; currency: string; monthlyReporting: number | null; isActive: boolean; superseded: boolean } | null;
  recommended: RecommendedApplyMode;
  /** Set once the proposal is persisted (POST generate); null in a preview or for an item that already matches. */
  proposalId: string | null;
}

export interface PlannedFromActualsDto {
  status: 'ok';
  reportingCurrency: string;
  window: { from: string; to: string; months: string[]; coveredMonths: string[] };
  items: PlannedFromActualsItemDto[];
  unmatched: { key: string; label: string; groupLabel: string; actualMonthly: number; reason: string }[];
  partialOnly: { masterItemKey: string; label: string; lineCount: number }[];
}

export type PlannedFromActualsResponse = PlannedFromActualsDto | { status: 'unavailable'; reason: string };

const EXTRA_REASON_LABELS: Record<string, string> = {
  planned_item_smsf_owned: 'Your planned item for this is owned by your SMSF, so household spending is not applied to it',
  refund_of_purchase_outside_window: 'Refunds of purchases made before this period',
};

export function toPlannedFromActualsDto(result: ExpensePopulationResult, proposalIds: Record<string, string>): PlannedFromActualsDto {
  return {
    status: 'ok',
    reportingCurrency: result.reportingCurrency,
    window: result.window,
    items: result.items.map((i) => ({
      masterItemKey: i.masterItemKey,
      label: i.label,
      groupLabel: i.groupLabel,
      actualMonthly: i.actualMonthly,
      coveredLineCount: i.coveredLineCount,
      existing: i.existing ? { name: i.existing.name, amount: i.existing.amount, frequency: i.existing.frequency, currency: i.existing.currency, monthlyReporting: i.existing.monthlyReporting, isActive: i.existing.isActive, superseded: i.existing.superseded } : null,
      recommended: i.recommended,
      proposalId: proposalIds[i.masterItemKey] ?? null,
    })),
    unmatched: result.unmatched.map((u) => ({
      key: u.key,
      label: u.label,
      groupLabel: u.groupLabel,
      actualMonthly: u.actualMonthly,
      reason: UNMATCHED_REASON_LABELS[u.reason as UnmatchedReason] ?? EXTRA_REASON_LABELS[u.reason] ?? u.reason,
    })),
    partialOnly: result.partialOnly,
  };
}

export const BANK_BALANCE_STATE_LABELS: Record<BankBalanceState, string> = {
  proposed: 'Ready to add to your Assets',
  up_to_date: 'Already in your Assets at this balance',
  already_applied: 'Already added from this statement',
  kept_by_you: 'You chose not to add this statement’s balance',
  smsf_account: 'SMSF account — the fund’s money, not your household’s',
  overdrawn: 'Overdrawn — not an asset',
  unsupported_currency: 'Currency not supported for Assets yet',
};

export interface BankBalanceItemDto {
  accountId: string;
  accountName: string | null;
  asOf: string | null;
  closingBalance: number;
  currency: string;
  state: BankBalanceState;
  stateLabel: string;
  linkedAsset: { id: string; name: string; value: number; currency: string } | null;
  possibleDuplicates: { id: string; name: string; value: number; currency: string }[];
  recommended: RecommendedApplyMode | null;
  reviewReasons: string[];
  proposalId: string | null;
}

export type BankBalancesResponse = { status: 'ok'; reportingCurrency: string; items: BankBalanceItemDto[] } | { status: 'unavailable'; reason: string };

export function toBankBalanceItemDto(item: BankBalanceProposalItem, proposalId: string | null = null): BankBalanceItemDto {
  return {
    accountId: item.accountId,
    accountName: item.accountName,
    asOf: item.asOf,
    closingBalance: item.closingBalance,
    currency: item.currency,
    state: item.state,
    stateLabel: BANK_BALANCE_STATE_LABELS[item.state],
    linkedAsset: item.linkedAsset,
    possibleDuplicates: item.possibleDuplicates,
    recommended: item.recommended,
    reviewReasons: item.draft?.summary.reviewReasons ?? [],
    proposalId,
  };
}
