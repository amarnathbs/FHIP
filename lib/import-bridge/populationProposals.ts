/**
 * WP-15 -- the Input Population Proposal (original FDH scope p.428-457; PO
 * D-02, D-04). Pure builders; the service loads rows and persists drafts.
 *
 *   (a) "Update your planned expenses from your actual spending": for each
 *       planned item (expense_items.master_item_key) the trailing-3-complete-
 *       month average of the approved imported spending mapped to it
 *       (expenseCategoryMapping.ts), averaged over COVERED months only --
 *       exactly the read model's own averaging (coveredMonthlyAverage), so
 *       the proposal can never disagree with the Expenses tab. Each item is
 *       proposed as add / update / keep; the user applies what they tick.
 *   (b) "Add your bank balance to Assets": the latest approved statement's
 *       reported closing balance per ordinary bank account, proposed as ONE
 *       cash asset per account (add, or update the asset that account
 *       already feeds). Until applied it stays evidence only ("Bank balance
 *       per statement -- not in Net Worth").
 *
 * NEVER COPIES TRANSACTIONS. A proposal carries one monthly figure per planned
 * item or one balance per account. Downstream cannot double count because
 *   - planned and actual are compared per canonical group and never added
 *     (PO D-02), and every mapping lands in the SAME group
 *     (expenseCategoryMapping.ts invariant, unit-tested);
 *   - the bank-balance evidence bucket is never added to any total, and an
 *     account whose balance is applied is linked to its asset
 *     (assets.source_financial_account_id, unique per account) so it can
 *     only ever be one asset.
 */
import { coveredMonthlyAverage, type ActualLine, type NormalisedLedger } from '@/lib/read-models/core/ledger';
import { toReporting, type FxContext } from '@/lib/read-models/core/currency';
import { EXPENSE_GROUP_LABELS, groupForExpenseItem, type CanonicalExpenseGroup } from '@/lib/read-models/core/categoryGroups';
import { toMonthly, type Frequency } from '@/lib/engines/money';
import type { BankBalanceEvidence } from '@/lib/read-models/assets';
import { expenseItemForMappingKey, type UnmatchedReason } from './expenseCategoryMapping';
import type { ImportProposalDraft, ProposedField, RecommendedApplyMode } from './types';

const round2 = (n: number) => Math.round(n * 100) / 100;
const money2 = (n: number) => round2(n).toFixed(2);

// ---------------------------------------------------------------------------
// (a) Planned expenses from actual averages
// ---------------------------------------------------------------------------

/** expense_items row as the builder needs it (active AND inactive: the
 * (user_id, master_item_key) unique constraint covers both). */
export interface PlannedItemRow {
  id: string;
  expense_name: string;
  master_item_key: string | null;
  amount: number;
  frequency: string;
  currency_code: string;
  is_active: boolean | null;
  is_essential: boolean | null;
  owner: string | null;
  superseded_by_bank_import: boolean | null;
  updated_at: string | null;
}

/** Legacy expense_items.expense_category (0003 enum, NOT NULL) for a new row. */
const GROUP_TO_LEGACY_CATEGORY: Partial<Record<CanonicalExpenseGroup, string>> = {
  housing: 'housing', transport: 'transport', food: 'food', utilities: 'utilities', insurance: 'insurance',
};

export const EXPENSE_PROPOSAL_FIELDS = ['expense_name', 'master_item_key', 'expense_category', 'amount', 'frequency', 'currency_code', 'is_essential', 'is_active', 'superseded_by_bank_import'] as const;

export interface ExpenseProposalItem {
  masterItemKey: string;
  label: string;
  group: CanonicalExpenseGroup;
  groupLabel: string;
  /** Monthly average, reporting currency, over covered months. */
  actualMonthly: number;
  coveredLineCount: number;
  essentialShare: number;
  existing: {
    id: string;
    name: string;
    amount: number;
    frequency: string;
    currency: string;
    /** null = not convertible to the reporting currency. */
    monthlyReporting: number | null;
    isActive: boolean;
    superseded: boolean;
  } | null;
  recommended: RecommendedApplyMode;
  draft: ImportProposalDraft;
}

export interface UnmatchedSpending {
  key: string;
  label: string;
  group: CanonicalExpenseGroup;
  groupLabel: string;
  actualMonthly: number;
  reason: UnmatchedReason | 'planned_item_smsf_owned' | 'refund_of_purchase_outside_window';
}

export interface ExpensePopulationResult {
  reportingCurrency: string;
  window: { from: string; to: string; months: string[]; coveredMonths: string[] };
  items: ExpenseProposalItem[];
  unmatched: UnmatchedSpending[];
  /** Items with spending only in part-covered months (shown, never averaged). */
  partialOnly: { masterItemKey: string; label: string; lineCount: number }[];
}

interface Entry {
  accountId: string;
  coverage: ActualLine['coverage'];
  household: boolean;
  amountReporting: number | null;
  essential: boolean;
}

/**
 * Pure. `masterLabels` maps master_item_key -> catalogue label. Only
 * household spending lines count (SMSF accounts never reach a household plan),
 * refunds net only through the confirmed-link rule the read model applied.
 */
export function buildExpensePopulation(input: {
  ledger: NormalisedLedger;
  plannedRows: readonly PlannedItemRow[];
  fx: FxContext;
  masterLabels: ReadonlyMap<string, string>;
}): ExpensePopulationResult {
  const { ledger, fx } = input;
  const spending = ledger.lines.filter((l) => l.household && l.bucket === 'spending');
  const byKey = new Map<string, { entries: Entry[]; group: CanonicalExpenseGroup; lines: number; covered: number }>();
  const unmatchedByKey = new Map<string, { entries: Entry[]; label: string; group: CanonicalExpenseGroup; reason: UnmatchedSpending['reason'] }>();

  const addUnmatched = (key: string, label: string, group: CanonicalExpenseGroup, reason: UnmatchedSpending['reason'], e: Entry) => {
    const u = unmatchedByKey.get(key) ?? { entries: [], label, group, reason };
    u.entries.push(e);
    unmatchedByKey.set(key, u);
  };
  const entryOf = (l: ActualLine, sign = 1): Entry => ({
    accountId: l.accountId, coverage: l.coverage, household: l.household,
    amountReporting: l.amountReporting === null ? null : sign * l.amountReporting, essential: l.essential,
  });

  for (const l of spending) {
    const match = expenseItemForMappingKey(l.mappingKey);
    if (match.masterItemKey === null) {
      addUnmatched(l.mappingKey ?? `group:${l.group}`, l.categoryLabel ?? EXPENSE_GROUP_LABELS[l.group], l.group, match.reason, entryOf(l));
      continue;
    }
    const cur = byKey.get(match.masterItemKey) ?? { entries: [], group: l.group, lines: 0, covered: 0 };
    cur.entries.push(entryOf(l));
    cur.lines += 1;
    if (l.coverage === 'covered') cur.covered += 1;
    byKey.set(match.masterItemKey, cur);
  }

  // A confirmed refund reduces the planned item its ORIGINAL purchase fed.
  const linesByTxn = new Map<string, ActualLine[]>();
  for (const l of spending) linesByTxn.set(l.transactionId, [...(linesByTxn.get(l.transactionId) ?? []), l]);
  for (const n of ledger.nettedRefunds) {
    if (!n.refund.household) continue;
    const original = (n.originalTransactionId ? linesByTxn.get(n.originalTransactionId) ?? [] : []).sort((a, b) => b.amountNative - a.amountNative)[0];
    const match = original ? expenseItemForMappingKey(original.mappingKey) : null;
    if (original && match && match.masterItemKey !== null && byKey.has(match.masterItemKey)) {
      byKey.get(match.masterItemKey)!.entries.push(entryOf(n.refund, -1));
    } else {
      addUnmatched(`refund:${n.group}`, `Refunds — ${EXPENSE_GROUP_LABELS[n.group]}`, n.group, 'refund_of_purchase_outside_window', entryOf(n.refund, -1));
    }
  }

  const plannedByKey = new Map<string, PlannedItemRow>();
  for (const row of input.plannedRows) if (row.master_item_key) plannedByKey.set(row.master_item_key, row);

  const items: ExpenseProposalItem[] = [];
  const partialOnly: ExpensePopulationResult['partialOnly'] = [];
  for (const [masterItemKey, agg] of [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const label = input.masterLabels.get(masterItemKey) ?? masterItemKey;
    if (agg.covered === 0) {
      partialOnly.push({ masterItemKey, label, lineCount: agg.lines });
      continue;
    }
    const actualMonthly = round2(coveredMonthlyAverage(ledger, agg.entries));
    const essentialMonthly = coveredMonthlyAverage(ledger, agg.entries.filter((e) => e.essential));
    const essentialShare = actualMonthly > 0 ? round2(essentialMonthly / actualMonthly) : 0;
    const row = plannedByKey.get(masterItemKey) ?? null;
    if (row && row.owner === 'smsf') {
      for (const e of agg.entries) addUnmatched(`smsf:${masterItemKey}`, label, agg.group, 'planned_item_smsf_owned', e);
      continue;
    }
    // A negative net (refunds exceeding purchases) is not a plan: never propose it.
    if (actualMonthly <= 0) continue;
    const existing = row
      ? {
          id: row.id,
          name: row.expense_name,
          amount: Number(row.amount),
          frequency: row.frequency,
          currency: row.currency_code,
          monthlyReporting: toReporting(round2(toMonthly(Number(row.amount), row.frequency as Frequency) || 0), row.currency_code, fx),
          isActive: row.is_active !== false,
          superseded: Boolean(row.superseded_by_bank_import),
        }
      : null;
    const upToDate = Boolean(existing && existing.isActive && !existing.superseded && existing.monthlyReporting !== null && round2(existing.monthlyReporting) === actualMonthly);
    const recommended: RecommendedApplyMode = !existing ? 'add_new' : upToDate ? 'keep_existing' : 'update_existing';
    const group = agg.group;
    items.push({
      masterItemKey, label, group, groupLabel: EXPENSE_GROUP_LABELS[group], actualMonthly, coveredLineCount: agg.covered, essentialShare, existing, recommended,
      draft: expenseDraft({ masterItemKey, label, group, actualMonthly, essential: essentialShare >= 0.5, row, recommended, currency: fx.reportingCurrency, coveredMonths: ledger.coverage.coveredMonths.length }),
    });
  }

  const unmatched: UnmatchedSpending[] = [...unmatchedByKey.entries()]
    .map(([key, u]) => ({ key, label: u.label, group: u.group, groupLabel: EXPENSE_GROUP_LABELS[u.group], actualMonthly: round2(coveredMonthlyAverage(ledger, u.entries)), reason: u.reason }))
    .filter((u) => u.actualMonthly !== 0)
    .sort((a, b) => b.actualMonthly - a.actualMonthly);

  return {
    reportingCurrency: fx.reportingCurrency,
    window: { from: ledger.window.from, to: ledger.window.to, months: ledger.window.months, coveredMonths: ledger.coverage.coveredMonths },
    items,
    unmatched,
    partialOnly,
  };
}

function field(fieldName: string, valueKind: ProposedField['valueKind'], proposedValue: string | null, existingValue: string | null, reasonCode: string, isRecommended = true): ProposedField {
  return { fieldName, valueKind, proposedValue, existingValue, isRecommended, requiresConfirmation: false, reasonCode };
}

/** Serialised live values, exactly as the apply RPC re-serialises them for the staleness check. */
export function serialisePlannedRow(row: PlannedItemRow) {
  return {
    amount: money2(Number(row.amount)),
    frequency: row.frequency,
    currency_code: row.currency_code,
    is_active: row.is_active === false ? 'false' : 'true',
    superseded_by_bank_import: row.superseded_by_bank_import ? 'true' : 'false',
  };
}

function expenseDraft(p: {
  masterItemKey: string;
  label: string;
  group: CanonicalExpenseGroup;
  actualMonthly: number;
  essential: boolean;
  row: PlannedItemRow | null;
  recommended: RecommendedApplyMode;
  currency: string;
  coveredMonths: number;
}): ImportProposalDraft {
  const avg = money2(p.actualMonthly);
  const reason = 'actual_average_trailing_3_complete_months';
  let fields: ProposedField[];
  if (!p.row) {
    fields = [
      field('expense_name', 'text', p.label, null, 'catalogue_label'),
      field('master_item_key', 'text', p.masterItemKey, null, 'fdh_mapping_key_to_master_item'),
      field('expense_category', 'enum', GROUP_TO_LEGACY_CATEGORY[p.group] ?? 'other', null, 'canonical_group'),
      field('amount', 'money', avg, null, reason),
      field('frequency', 'enum', 'monthly', null, reason),
      field('currency_code', 'enum', p.currency, null, 'reporting_currency'),
      field('is_essential', 'bool', p.essential ? 'true' : 'false', null, 'taxonomy_essential_discretionary'),
    ];
  } else {
    const live = serialisePlannedRow(p.row);
    fields = [
      field('amount', 'money', avg, live.amount, reason),
      field('frequency', 'enum', 'monthly', live.frequency, reason),
      field('currency_code', 'enum', p.currency, live.currency_code, 'reporting_currency'),
    ];
    if (live.is_active === 'false') fields.push(field('is_active', 'bool', 'true', 'false', 'reactivate_planned_item'));
    if (live.superseded_by_bank_import === 'true') fields.push(field('superseded_by_bank_import', 'bool', 'false', 'true', 'plan_now_matches_actual'));
  }
  const monthsText = `${p.coveredMonths} complete month${p.coveredMonths === 1 ? '' : 's'}`;
  return {
    targetDomain: 'expense',
    sourceKind: 'bank_statement',
    currencyCode: p.currency,
    targetEntityId: p.row?.id ?? null,
    targetEntityUpdatedAt: p.row?.updated_at ?? null,
    recommendedApplyMode: p.recommended,
    duplicateOfEntityId: null,
    fields,
    summary: {
      title: p.label,
      lines: [
        { label: 'Average actual spending', value: `${avg} ${p.currency} / month`, note: `over ${monthsText} of approved statements` },
        ...(p.row ? [{ label: 'Your plan today', value: `${money2(Number(p.row.amount))} ${p.row.currency_code} ${p.row.frequency}` }] : []),
      ],
      reviewReasons: p.row && p.row.is_active === false ? ['This planned item was removed earlier; applying adds it back.'] : [],
    },
  };
}

// ---------------------------------------------------------------------------
// (b) Bank balance -> cash asset
// ---------------------------------------------------------------------------

export interface AssetRowForProposal {
  id: string;
  asset_name: string;
  asset_class: string | null;
  master_item_key: string | null;
  current_value: number;
  currency_code: string;
  valuation_date: string | null;
  owner: string | null;
  is_active: boolean | null;
  source_type: string | null;
  source_financial_account_id: string | null;
  updated_at: string | null;
}

/** Existing asset proposals for a statement (so an applied / kept one is not re-offered). */
export interface PriorAssetProposal {
  source_statement_upload_id: string | null;
  status: string;
}

const CASH_MASTER_KEYS = new Set(['wallet_cash', 'savings_account', 'cheque_account', 'offset_account', 'term_deposits', 'foreign_currency']);
const HOUSEHOLD_OWNERS = new Set(['self', 'spouse', 'joint']);

export const ASSET_PROPOSAL_FIELDS = ['asset_name', 'asset_class', 'current_value', 'currency_code', 'valuation_date', 'owner'] as const;

export type BankBalanceState =
  | 'proposed'
  | 'up_to_date'
  | 'already_applied'
  | 'kept_by_you'
  | 'smsf_account'
  | 'overdrawn'
  | 'unsupported_currency';

export interface BankBalanceProposalItem {
  accountId: string;
  accountName: string | null;
  statementUploadId: string;
  asOf: string | null;
  closingBalance: number;
  currency: string;
  state: BankBalanceState;
  /** The asset this account already feeds, if any. */
  linkedAsset: { id: string; name: string; value: number; currency: string } | null;
  /** Manual cash assets that might already be this account (to update instead of adding a second one). */
  possibleDuplicates: { id: string; name: string; value: number; currency: string }[];
  recommended: RecommendedApplyMode | null;
  draft: ImportProposalDraft | null;
}

export function serialiseAssetRow(row: AssetRowForProposal) {
  return {
    asset_name: row.asset_name?.trim() || null,
    asset_class: row.asset_class ?? null,
    current_value: money2(Number(row.current_value)),
    currency_code: row.currency_code,
    valuation_date: row.valuation_date ?? null,
    owner: row.owner ?? null,
  };
}

/**
 * Pure. One entry per ordinary bank account with a reported closing balance on
 * its latest approved statement (the assets read model's evidence bucket).
 * `targetAssetId` (optional, per account) = the user said "this is my
 * existing <asset>": the proposal then updates that asset instead of adding.
 */
export function buildBankBalanceProposals(input: {
  evidence: readonly BankBalanceEvidence[];
  assets: readonly AssetRowForProposal[];
  prior: readonly PriorAssetProposal[];
  targetAssetIdByAccount?: ReadonlyMap<string, string>;
}): BankBalanceProposalItem[] {
  const active = input.assets.filter((a) => a.is_active !== false);
  const out: BankBalanceProposalItem[] = [];
  for (const ev of input.evidence) {
    const amount = round2(ev.closingBalance.amountNative);
    const currency = ev.closingBalance.currency;
    const linked = active.find((a) => a.source_financial_account_id === ev.accountId) ?? null;
    const linkedView = linked ? { id: linked.id, name: linked.asset_name, value: Number(linked.current_value), currency: linked.currency_code } : null;
    const possibleDuplicates = linked
      ? []
      : active
          .filter((a) => !a.source_financial_account_id && (a.asset_class === 'cash' || (a.master_item_key !== null && CASH_MASTER_KEYS.has(a.master_item_key))))
          .map((a) => ({ id: a.id, name: a.asset_name, value: Number(a.current_value), currency: a.currency_code }));
    const base = { accountId: ev.accountId, accountName: ev.accountName, statementUploadId: ev.statementUploadId, asOf: ev.asOf, closingBalance: amount, currency, linkedAsset: linkedView, possibleDuplicates };
    const none = (state: BankBalanceState): BankBalanceProposalItem => ({ ...base, state, recommended: null, draft: null });

    if (ev.ownerRole === 'smsf') { out.push(none('smsf_account')); continue; }
    if (amount < 0) { out.push(none('overdrawn')); continue; }
    if (currency !== 'AUD' && currency !== 'INR') { out.push(none('unsupported_currency')); continue; }
    const priorForStatement = input.prior.filter((p) => p.source_statement_upload_id === ev.statementUploadId);
    const chosenTargetId = input.targetAssetIdByAccount?.get(ev.accountId) ?? null;
    if (!chosenTargetId && priorForStatement.some((p) => p.status === 'applied') && linked) { out.push(none('already_applied')); continue; }
    if (!chosenTargetId && priorForStatement.some((p) => p.status === 'dismissed')) { out.push(none('kept_by_you')); continue; }

    const target = chosenTargetId ? active.find((a) => a.id === chosenTargetId && (!a.source_financial_account_id || a.source_financial_account_id === ev.accountId)) ?? null : linked;
    if (target && target === linked && round2(Number(linked.current_value)) === amount && linked.currency_code === currency && linked.valuation_date === ev.asOf) {
      out.push(none('up_to_date'));
      continue;
    }
    const owner = ev.ownerRole && HOUSEHOLD_OWNERS.has(ev.ownerRole) ? ev.ownerRole : 'self';
    const reason = 'latest_approved_statement_closing_balance';
    const name = ev.accountName?.trim() || 'Bank account';
    let fields: ProposedField[];
    let recommended: RecommendedApplyMode;
    if (!target) {
      recommended = 'add_new';
      fields = [
        field('asset_name', 'text', name, null, 'statement_account_name'),
        field('asset_class', 'enum', 'cash', null, 'bank_account_is_cash'),
        field('current_value', 'money', money2(amount), null, reason),
        field('currency_code', 'enum', currency, null, 'statement_currency'),
        field('valuation_date', 'text', ev.asOf, null, 'statement_period_end'),
        field('owner', 'enum', owner, null, 'account_owner_role'),
      ];
    } else {
      recommended = 'update_existing';
      const live = serialiseAssetRow(target);
      fields = [
        field('current_value', 'money', money2(amount), live.current_value, reason),
        field('currency_code', 'enum', currency, live.currency_code, 'statement_currency'),
        field('valuation_date', 'text', ev.asOf, live.valuation_date, 'statement_period_end'),
      ];
    }
    out.push({
      ...base,
      state: 'proposed',
      recommended,
      draft: {
        targetDomain: 'asset',
        sourceKind: 'bank_statement',
        currencyCode: currency,
        targetEntityId: target?.id ?? null,
        targetEntityUpdatedAt: target?.updated_at ?? null,
        recommendedApplyMode: recommended,
        duplicateOfEntityId: !target && possibleDuplicates.length === 1 ? possibleDuplicates[0].id : null,
        fields,
        summary: {
          title: name,
          lines: [{ label: 'Closing balance', value: `${money2(amount)} ${currency}`, note: ev.asOf ? `per statement ending ${ev.asOf}` : undefined }],
          reviewReasons: !target && possibleDuplicates.length > 0
            ? [`You already have ${possibleDuplicates.length === 1 ? `a cash asset "${possibleDuplicates[0].name}"` : `${possibleDuplicates.length} cash assets`}. If one of them is this account, update it instead so the balance is not counted twice.`]
            : [],
        },
      },
    });
  }
  return out;
}

/** For the registry / tests: the groups each planned key lands in (import only). */
export function plannedGroupOf(masterItemKey: string): CanonicalExpenseGroup {
  return groupForExpenseItem(masterItemKey).group;
}
