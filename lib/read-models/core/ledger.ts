/**
 * The approved ACTUAL ledger, loaded once per request and normalised into
 * lines that every read model (expenses, income, liabilities) shares.
 *
 * LOAD (loadApprovedLedger): approved fdh_transactions dated inside the window,
 * their allocations, the confirmed links touching them (and the counterpart /
 * refund-original rows those links name, even outside the window), the
 * accounts (owner_role / liability_id from 0207), the approved statements that
 * define coverage, the FDH-2 taxonomy, the corroborating evidence, and a count
 * of still-pending rows. Everything paged; any failure -> 'unavailable'.
 *
 * NORMALISE (normaliseLedger, pure): spendingRules applied line by line, with
 * each line's group, essential flag, month, coverage state, owner, currency
 * conversion and provenance resolved exactly once.
 */
import { buildCorroborationIndex, emptyCorroborationEvidence, loadCorroborationEvidence, type CorroborationRef, type RawCorroborationEvidence } from '../corroboration';
import { computeCoverage, isCovered, type CoverageIndex, type StatementPeriod } from './coverage';
import { groupForFdhCategory, isEssentialFdh, type CanonicalExpenseGroup } from './categoryGroups';
import { toReporting, type FxContext } from './currency';
import { fetchAllByIds, fetchAllRows, type ReadModelClient } from './paginate';
import {
  REFUND_LIKE_LINK_TYPES,
  effectiveBucket,
  expandTransaction,
  isFacilityAccount,
  type EconomicTransactionType,
  type LinkEvidence,
  type ReadModelBucket,
  type RuleAllocation,
} from './spendingRules';
import { ReadModelUnavailableError, addUnconverted, emptyUnconverted, isHouseholdOwner, provenance, type Provenance, type UnconvertedTally } from './types';
import { monthOf, type IsoDate, type MonthKey, type ReadWindow } from './window';

// ---------------------------------------------------------------------------
// Row shapes (snake_case, exactly as PostgREST returns them)
// ---------------------------------------------------------------------------

export interface LedgerAccountRow {
  id: string;
  account_type: string;
  display_name: string | null;
  currency_code: string;
  owner_role?: string | null;
  liability_id?: string | null;
}

export interface LedgerTransactionRow {
  id: string;
  financial_account_id: string;
  statement_upload_id: string | null;
  transaction_date: IsoDate;
  amount_original: number;
  currency_original: string;
  credit_debit: 'credit' | 'debit';
  economic_transaction_type: EconomicTransactionType;
  category_id: string | null;
  subcategory_id: string | null;
  description_clean: string | null;
  dedup_status: string;
  approval_status: string;
  user_override: boolean;
}

export type LedgerAllocationRow = RuleAllocation;

export interface LedgerLinkRow {
  id: string;
  transaction_id_from: string;
  transaction_id_to: string | null;
  link_type: string;
  status: string;
}

export interface LedgerStatementRow {
  id: string;
  financial_account_id: string | null;
  statement_period_start: IsoDate | null;
  statement_period_end: IsoDate | null;
  document_type: string | null;
}

/** An FDH-10 card/loan statement: its period is coverage for its facility account. */
export interface LedgerLiabilityStatementRow {
  id: string;
  statement_upload_id: string | null;
  financial_account_id: string | null;
  statement_period_start: IsoDate | null;
  statement_period_end: IsoDate | null;
  approval_status: string;
}

export interface LedgerCategoryRow {
  id: string;
  category_key: string;
  display_name: string | null;
  fhip_mapping_key: string | null;
  essential_discretionary: string | null;
}

export interface LedgerSubcategoryRow {
  id: string;
  category_id: string;
  display_name: string | null;
  fhip_mapping_key: string | null;
  essential_discretionary: string | null;
}

export interface RawLedger {
  accounts: LedgerAccountRow[];
  /** Approved transactions dated in the window (duplicates included, counted as excluded). */
  transactions: LedgerTransactionRow[];
  /** Rows named by links but outside the window / set (refund originals, counterparts). */
  linkedRows: LedgerTransactionRow[];
  allocations: LedgerAllocationRow[];
  links: LedgerLinkRow[];
  statements: LedgerStatementRow[];
  /** Approved FDH-10 statements linked to a facility account (set by WP-11). */
  liabilityStatements: LedgerLiabilityStatementRow[];
  categories: LedgerCategoryRow[];
  subcategories: LedgerSubcategoryRow[];
  corroboration: RawCorroborationEvidence;
  /** Transactions in the window still awaiting approval (never counted). */
  pendingApprovalCount: number;
  /** False when the database predates 0207 (owner_role / liability_id absent). */
  ownerAttributionAvailable: boolean;
}

export function emptyRawLedger(): RawLedger {
  return {
    accounts: [], transactions: [], linkedRows: [], allocations: [], links: [], statements: [], liabilityStatements: [],
    categories: [], subcategories: [], corroboration: emptyCorroborationEvidence(), pendingApprovalCount: 0, ownerAttributionAvailable: true,
  };
}

// ---------------------------------------------------------------------------
// Normalised lines
// ---------------------------------------------------------------------------

export type LineCoverage = 'covered' | 'partial';

export interface ActualLine {
  /** `${transactionId}` or `${transactionId}#${allocationSequence}`. */
  key: string;
  transactionId: string;
  allocationSequence: number | null;
  accountId: string;
  accountType: string | null;
  accountName: string | null;
  onFacility: boolean;
  liabilityId: string | null;
  ownerRole: string | null;
  household: boolean;
  statementUploadId: string | null;
  date: IsoDate;
  month: MonthKey;
  coverage: LineCoverage;
  type: EconomicTransactionType;
  bucket: ReadModelBucket;
  /** Why `bucket` differs from the row's own type (link / corroboration), if it does. */
  rebucketReason: string | null;
  creditDebit: 'credit' | 'debit';
  group: CanonicalExpenseGroup;
  groupUnmapped: boolean;
  essential: boolean;
  categoryId: string | null;
  /** fdh_subcategories.id of the part (WP-15 maps it to an expense_items key). */
  subcategoryId: string | null;
  /** The taxonomy mapping key, subcategory's first ('food.groceries'), else the category's ('expense.food'). */
  mappingKey: string | null;
  categoryLabel: string | null;
  description: string | null;
  amountNative: number;
  currency: string;
  amountReporting: number | null;
  provenance: Provenance;
  corroboratedBy: CorroborationRef[];
}

export interface RefundNetting {
  /** The refund line itself (bucket 'refund'). */
  refund: ActualLine;
  /** The original purchase it nets against, when confirmed. */
  originalTransactionId: string | null;
  /** Group / essential of the ORIGINAL purchase (what the netting reduces). */
  group: CanonicalExpenseGroup;
  essential: boolean;
}

export interface NormalisedLedger {
  window: ReadWindow;
  coverage: CoverageIndex;
  /** Every counted, approved, non-duplicate line in the window (all buckets except refunds). */
  lines: ActualLine[];
  /** Refunds netted against spending by the confirmed-link rule (PO D-01). */
  nettedRefunds: RefundNetting[];
  /** Refunds with no confirmed link: shown, never netted, never income. */
  unlinkedRefunds: ActualLine[];
  excludedDuplicates: number;
  invalidSplits: string[];
  /** 'unknown' parts (approved parents with unknown allocations) -- never counted. */
  unknownLineCount: number;
  pendingApprovalCount: number;
  unconverted: UnconvertedTally;
  ownerAttributionAvailable: boolean;
  accounts: Map<string, LedgerAccountRow>;
}

function provenanceKindForAccount(accountType: string | null): 'bank_statement' | 'card_statement' | 'loan_statement' {
  if (accountType === 'credit_card') return 'card_statement';
  if (accountType && accountType !== 'line_of_credit' && accountType !== 'overdraft' && isFacilityAccount({ account_type: accountType })) return 'loan_statement';
  return 'bank_statement';
}

export interface NormaliseOptions {
  /** 'unavailable' (default, WP-02 plan) or 'exclude_and_flag'. */
  invalidSplit?: 'unavailable' | 'exclude_and_flag';
}

/**
 * Pure. Applies spendingRules to a raw ledger. Throws
 * ReadModelUnavailableError('invalid_split') for an unreconciled split unless
 * options.invalidSplit = 'exclude_and_flag'.
 */
export function normaliseLedger(raw: RawLedger, fx: FxContext, window: ReadWindow, options: NormaliseOptions = {}): NormalisedLedger {
  const accounts = new Map(raw.accounts.map((a) => [a.id, a] as const));
  const categories = new Map(raw.categories.map((c) => [c.id, c] as const));
  const subcategories = new Map(raw.subcategories.map((s) => [s.id, s] as const));
  const allRows = new Map<string, LedgerTransactionRow>();
  for (const r of raw.linkedRows) allRows.set(r.id, r);
  for (const r of raw.transactions) allRows.set(r.id, r);
  const allocationsByTxn = new Map<string, LedgerAllocationRow[]>();
  for (const a of raw.allocations) {
    if (!allocationsByTxn.has(a.transaction_id)) allocationsByTxn.set(a.transaction_id, []);
    allocationsByTxn.get(a.transaction_id)!.push(a);
  }

  // Coverage from approved statements (declared period, else min/max approved txn date).
  const txnDatesByStatement = new Map<string, { min: IsoDate; max: IsoDate }>();
  for (const t of raw.transactions) {
    if (!t.statement_upload_id) continue;
    const cur = txnDatesByStatement.get(t.statement_upload_id);
    if (!cur) txnDatesByStatement.set(t.statement_upload_id, { min: t.transaction_date, max: t.transaction_date });
    else {
      if (t.transaction_date < cur.min) cur.min = t.transaction_date;
      if (t.transaction_date > cur.max) cur.max = t.transaction_date;
    }
  }
  // An upload with no financial_account_id takes the account of its own
  // approved lines (all lines of one statement share one account).
  const accountByStatement = new Map<string, string>();
  for (const t of raw.transactions) if (t.statement_upload_id && !accountByStatement.has(t.statement_upload_id)) accountByStatement.set(t.statement_upload_id, t.financial_account_id);
  const periods: StatementPeriod[] = raw.statements
    .map((s) => ({ s, accountId: s.financial_account_id ?? accountByStatement.get(s.id) ?? null }))
    .filter((x): x is { s: LedgerStatementRow; accountId: string } => x.accountId !== null)
    .map(({ s, accountId }) => ({
      statementUploadId: s.id,
      accountId,
      periodStart: s.statement_period_start,
      periodEnd: s.statement_period_end,
      fallbackStart: txnDatesByStatement.get(s.id)?.min ?? null,
      fallbackEnd: txnDatesByStatement.get(s.id)?.max ?? null,
    }));
  // Approved card/loan statements define coverage for their facility account
  // (the WP-11 ledger rows live there), whatever the upload row's status.
  for (const ls of raw.liabilityStatements) {
    if (!ls.financial_account_id || ls.approval_status !== 'approved') continue;
    periods.push({
      statementUploadId: ls.statement_upload_id ?? ls.id,
      accountId: ls.financial_account_id,
      periodStart: ls.statement_period_start,
      periodEnd: ls.statement_period_end,
      fallbackStart: ls.statement_upload_id ? txnDatesByStatement.get(ls.statement_upload_id)?.min ?? null : null,
      fallbackEnd: ls.statement_upload_id ? txnDatesByStatement.get(ls.statement_upload_id)?.max ?? null : null,
    });
  }
  const coverage = computeCoverage(periods, window);

  const linksByTxn = new Map<string, LedgerLinkRow[]>();
  for (const l of raw.links) {
    for (const id of [l.transaction_id_from, l.transaction_id_to]) {
      if (!id) continue;
      if (!linksByTxn.has(id)) linksByTxn.set(id, []);
      linksByTxn.get(id)!.push(l);
    }
  }
  const corroboration = buildCorroborationIndex(raw.corroboration, raw.transactions.map((t) => ({ id: t.id, credit_debit: t.credit_debit, currency_original: t.currency_original, amount_original: t.amount_original })));

  const unconverted = emptyUnconverted();
  const lines: ActualLine[] = [];
  const refunds: ActualLine[] = [];
  const invalidSplits: string[] = [];
  let excludedDuplicates = 0;
  let unknownLineCount = 0;

  for (const txn of raw.transactions) {
    const expanded = expandTransaction(txn, allocationsByTxn.get(txn.id) ?? []);
    if (expanded.kind === 'not_approved') continue;
    if (expanded.kind === 'duplicate') { excludedDuplicates += 1; continue; }
    if (expanded.kind === 'invalid_split') {
      if ((options.invalidSplit ?? 'unavailable') === 'unavailable') throw new ReadModelUnavailableError('invalid_split', 'fdh_transaction_allocations');
      invalidSplits.push(txn.id);
      continue;
    }
    const account = accounts.get(txn.financial_account_id) ?? null;
    const onFacility = isFacilityAccount(account);
    const isSplit = expanded.parts.length > 1 || expanded.parts[0].allocationSequence !== null;
    const linkEvidence: LinkEvidence[] = (linksByTxn.get(txn.id) ?? []).map((l) => {
      const otherId = l.transaction_id_from === txn.id ? l.transaction_id_to : l.transaction_id_from;
      const other = otherId ? allRows.get(otherId) : undefined;
      return { linkType: l.link_type, status: l.status, counterpartOnFacility: other ? isFacilityAccount(accounts.get(other.financial_account_id)) : false };
    });
    const corroboratedBy = corroboration.get(txn.id) ?? [];
    const month = monthOf(txn.transaction_date);
    const lineCoverage: LineCoverage = isCovered(coverage, txn.financial_account_id, month) ? 'covered' : 'partial';
    const ownerRole = account?.owner_role ?? null;
    for (const part of expanded.parts) {
      const cat = part.categoryId ? categories.get(part.categoryId) : undefined;
      const sub = part.subcategoryId ? subcategories.get(part.subcategoryId) : undefined;
      const g = groupForFdhCategory({ categoryKey: cat?.category_key ?? null, categoryMappingKey: cat?.fhip_mapping_key ?? null, subcategoryMappingKey: sub?.fhip_mapping_key ?? null });
      const { bucket, reason } = effectiveBucket({ type: part.type, onFacility, isSplit, userOverride: txn.user_override, links: linkEvidence, corroborations: corroboratedBy });
      const amountReporting = toReporting(part.amount, part.currency, fx);
      const line: ActualLine = {
        key: part.allocationSequence === null ? txn.id : `${txn.id}#${part.allocationSequence}`,
        transactionId: txn.id,
        allocationSequence: part.allocationSequence,
        accountId: txn.financial_account_id,
        accountType: account?.account_type ?? null,
        accountName: account?.display_name ?? null,
        onFacility,
        liabilityId: account?.liability_id ?? null,
        ownerRole,
        household: isHouseholdOwner(ownerRole),
        statementUploadId: txn.statement_upload_id,
        date: txn.transaction_date,
        month,
        coverage: lineCoverage,
        type: part.type,
        bucket,
        rebucketReason: reason,
        creditDebit: txn.credit_debit,
        group: g.group,
        groupUnmapped: g.unmapped,
        essential: isEssentialFdh(cat?.essential_discretionary, sub?.essential_discretionary),
        categoryId: part.categoryId,
        subcategoryId: part.subcategoryId,
        mappingKey: sub?.fhip_mapping_key ?? cat?.fhip_mapping_key ?? null,
        categoryLabel: sub?.display_name ?? cat?.display_name ?? null,
        description: txn.description_clean,
        amountNative: part.amount,
        currency: part.currency,
        amountReporting,
        provenance: provenance(provenanceKindForAccount(account?.account_type ?? null), txn.statement_upload_id, txn.financial_account_id),
        corroboratedBy,
      };
      if (amountReporting === null) addUnconverted(unconverted, part.currency, part.amount);
      if (bucket === 'unknown') { unknownLineCount += 1; continue; }
      if (bucket === 'refund') { refunds.push(line); continue; }
      lines.push(line);
    }
  }

  // Refund netting (rule 8, PO D-01): confirmed refund-like link, refund -> original.
  const counted = new Map<string, ActualLine[]>();
  for (const l of lines) {
    if (!counted.has(l.transactionId)) counted.set(l.transactionId, []);
    counted.get(l.transactionId)!.push(l);
  }
  const nettedRefunds: RefundNetting[] = [];
  const unlinkedRefunds: ActualLine[] = [];
  for (const refund of refunds) {
    const link = (linksByTxn.get(refund.transactionId) ?? []).find((l) =>
      REFUND_LIKE_LINK_TYPES.has(l.link_type) && l.status === 'confirmed' && l.transaction_id_from === refund.transactionId && l.transaction_id_to);
    const original = link?.transaction_id_to ? resolveOriginalSpending(link.transaction_id_to, counted, allRows, allocationsByTxn, accounts, categories, subcategories) : null;
    if (link && original) {
      nettedRefunds.push({ refund, originalTransactionId: link.transaction_id_to, group: original.group, essential: original.essential });
    } else {
      unlinkedRefunds.push(refund);
    }
  }

  return {
    window, coverage, lines, nettedRefunds, unlinkedRefunds, excludedDuplicates, invalidSplits, unknownLineCount,
    pendingApprovalCount: raw.pendingApprovalCount, unconverted, ownerAttributionAvailable: raw.ownerAttributionAvailable, accounts,
  };
}

/** The group/essential of a refund's original purchase, if that purchase is a
 * counted (approved, non-duplicate) SPENDING line -- in the window or not. */
function resolveOriginalSpending(
  originalId: string,
  counted: Map<string, ActualLine[]>,
  allRows: Map<string, LedgerTransactionRow>,
  allocationsByTxn: Map<string, LedgerAllocationRow[]>,
  accounts: Map<string, LedgerAccountRow>,
  categories: Map<string, LedgerCategoryRow>,
  subcategories: Map<string, LedgerSubcategoryRow>,
): { group: CanonicalExpenseGroup; essential: boolean } | null {
  const inWindow = counted.get(originalId);
  if (inWindow) {
    const spend = inWindow.filter((l) => l.bucket === 'spending').sort((a, b) => b.amountNative - a.amountNative)[0];
    return spend ? { group: spend.group, essential: spend.essential } : null;
  }
  const row = allRows.get(originalId);
  if (!row) return null;
  const expanded = expandTransaction(row, allocationsByTxn.get(row.id) ?? []);
  if (expanded.kind !== 'parts') return null;
  const onFacility = isFacilityAccount(accounts.get(row.financial_account_id));
  const spendParts = expanded.parts.filter((p) => effectiveBucket({ type: p.type, onFacility, isSplit: true, userOverride: true, links: [], corroborations: [] }).bucket === 'spending');
  const biggest = spendParts.sort((a, b) => b.amount - a.amount)[0];
  if (!biggest) return null;
  const cat = biggest.categoryId ? categories.get(biggest.categoryId) : undefined;
  const sub = biggest.subcategoryId ? subcategories.get(biggest.subcategoryId) : undefined;
  return {
    group: groupForFdhCategory({ categoryKey: cat?.category_key ?? null, categoryMappingKey: cat?.fhip_mapping_key ?? null, subcategoryMappingKey: sub?.fhip_mapping_key ?? null }).group,
    essential: isEssentialFdh(cat?.essential_discretionary, sub?.essential_discretionary),
  };
}

// ---------------------------------------------------------------------------
// Averages over covered months (the per-account rule, see coverage.ts)
// ---------------------------------------------------------------------------

/**
 * Monthly average of `value(line)` over COVERED months only: each account's
 * covered total divided by that account's covered-month count, summed across
 * accounts. Lines in partial months, non-household lines (unless
 * includeNonHousehold) and unconverted lines never contribute.
 */
export function coveredMonthlyAverage(
  ledger: Pick<NormalisedLedger, 'coverage'>,
  lines: readonly { accountId: string; coverage: LineCoverage; household: boolean; amountReporting: number | null }[],
  sign: (line: { amountReporting: number | null }) => number = (l) => l.amountReporting ?? 0,
  includeNonHousehold = false,
): number {
  const byAccount = new Map<string, number>();
  for (const l of lines) {
    if (l.coverage !== 'covered' || l.amountReporting === null) continue;
    if (!includeNonHousehold && !l.household) continue;
    byAccount.set(l.accountId, (byAccount.get(l.accountId) ?? 0) + sign(l));
  }
  let total = 0;
  for (const [accountId, sum] of byAccount) {
    const n = ledger.coverage.covered.get(accountId)?.size ?? 0;
    if (n > 0) total += sum / n;
  }
  return Math.round(total * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const TXN_COLUMNS = 'id, financial_account_id, statement_upload_id, transaction_date, amount_original, currency_original, credit_debit, economic_transaction_type, category_id, subcategory_id, description_clean, dedup_status, approval_status, user_override';
const ALLOCATION_COLUMNS = 'transaction_id, allocation_sequence, economic_transaction_type, category_id, subcategory_id, amount, currency_code';

function isUndefinedColumn(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === '42703' || code === 'PGRST204';
}

async function loadAccounts(userId: string, client: ReadModelClient): Promise<{ rows: LedgerAccountRow[]; ownerAttributionAvailable: boolean }> {
  // Try with the 0207 columns; on a database that predates 0207 (undefined
  // column), fall back WITHOUT them and say so -- never fail every read model
  // because an additive column is not deployed yet. Any other error fails closed.
  const first: { data: LedgerAccountRow[] | null; error: unknown } = await client
    .from('fdh_financial_accounts')
    .select('id, account_type, display_name, currency_code, owner_role, liability_id')
    .eq('user_id', userId)
    .range(0, 0);
  if (first.error && isUndefinedColumn(first.error)) {
    const rows = await fetchAllRows<LedgerAccountRow>('fdh_financial_accounts', (from, to) =>
      client.from('fdh_financial_accounts').select('id, account_type, display_name, currency_code').eq('user_id', userId).range(from, to));
    return { rows: rows.map((r) => ({ ...r, owner_role: null, liability_id: null })), ownerAttributionAvailable: false };
  }
  if (first.error) throw new ReadModelUnavailableError('query_failed', 'fdh_financial_accounts');
  const rows = await fetchAllRows<LedgerAccountRow>('fdh_financial_accounts', (from, to) =>
    client.from('fdh_financial_accounts').select('id, account_type, display_name, currency_code, owner_role, liability_id').eq('user_id', userId).range(from, to));
  return { rows, ownerAttributionAvailable: true };
}

export async function loadApprovedLedger(userId: string, client: ReadModelClient, window: ReadWindow): Promise<RawLedger> {
  const { rows: accounts, ownerAttributionAvailable } = await loadAccounts(userId, client);
  const transactions = await fetchAllRows<LedgerTransactionRow>('fdh_transactions', (from, to) =>
    client
      .from('fdh_transactions')
      .select(TXN_COLUMNS)
      .eq('user_id', userId)
      .eq('approval_status', 'approved')
      .gte('transaction_date', window.from)
      .lte('transaction_date', window.to)
      .order('id', { ascending: true })
      .range(from, to));
  const ids = transactions.map((t) => t.id);
  const linksFrom = await fetchAllByIds<LedgerLinkRow>('fdh_transaction_links', ids, (chunk, from, to) =>
    client.from('fdh_transaction_links').select('id, transaction_id_from, transaction_id_to, link_type, status').eq('user_id', userId).eq('status', 'confirmed').in('transaction_id_from', chunk).range(from, to));
  const linksTo = await fetchAllByIds<LedgerLinkRow>('fdh_transaction_links', ids, (chunk, from, to) =>
    client.from('fdh_transaction_links').select('id, transaction_id_from, transaction_id_to, link_type, status').eq('user_id', userId).eq('status', 'confirmed').in('transaction_id_to', chunk).range(from, to));
  const links = [...new Map([...linksFrom, ...linksTo].map((l) => [l.id, l] as const)).values()];
  const known = new Set(ids);
  const linkedIds = [...new Set(links.flatMap((l) => [l.transaction_id_from, l.transaction_id_to]).filter((id): id is string => Boolean(id) && !known.has(id as string)))];
  const linkedRows = await fetchAllByIds<LedgerTransactionRow>('fdh_transactions', linkedIds, (chunk, from, to) =>
    client.from('fdh_transactions').select(TXN_COLUMNS).eq('user_id', userId).in('id', chunk).range(from, to));
  const allocations = await fetchAllByIds<LedgerAllocationRow>('fdh_transaction_allocations', [...ids, ...linkedRows.map((r) => r.id)], (chunk, from, to) =>
    client.from('fdh_transaction_allocations').select(ALLOCATION_COLUMNS).eq('user_id', userId).in('transaction_id', chunk).range(from, to));
  const statements = await fetchAllRows<LedgerStatementRow>('fdh_statement_uploads', (from, to) =>
    client
      .from('fdh_statement_uploads')
      .select('id, financial_account_id, statement_period_start, statement_period_end, document_type')
      .eq('user_id', userId)
      .eq('processing_status', 'approved')
      .order('id', { ascending: true })
      .range(from, to));
  const liabilityStatements = await fetchAllRows<LedgerLiabilityStatementRow>('fdh_liability_statements', (from, to) =>
    client
      .from('fdh_liability_statements')
      .select('id, statement_upload_id, financial_account_id, statement_period_start, statement_period_end, approval_status')
      .eq('user_id', userId)
      .eq('approval_status', 'approved')
      .not('financial_account_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, to));
  const categories = await fetchAllRows<LedgerCategoryRow>('fdh_categories', (from, to) =>
    client.from('fdh_categories').select('id, category_key, display_name, fhip_mapping_key, essential_discretionary').order('id', { ascending: true }).range(from, to));
  const subcategories = await fetchAllRows<LedgerSubcategoryRow>('fdh_subcategories', (from, to) =>
    client.from('fdh_subcategories').select('id, category_id, display_name, fhip_mapping_key, essential_discretionary').order('id', { ascending: true }).range(from, to));
  const pending = await fetchAllRows<{ id: string }>('fdh_transactions', (from, to) =>
    client
      .from('fdh_transactions')
      .select('id')
      .eq('user_id', userId)
      .eq('approval_status', 'pending')
      .gte('transaction_date', window.from)
      .lte('transaction_date', window.to)
      .order('id', { ascending: true })
      .range(from, to));
  const corroboration = await loadCorroborationEvidence(userId, client, ids);
  return {
    accounts, transactions, linkedRows, allocations, links, statements, liabilityStatements, categories, subcategories, corroboration,
    pendingApprovalCount: pending.length, ownerAttributionAvailable,
  };
}
