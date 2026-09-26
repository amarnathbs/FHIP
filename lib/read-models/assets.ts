/**
 * selectAssets -- the assets register, converted once, plus the bank
 * closing-balance EVIDENCE bucket (DC-16, PO D-04).
 *
 * A bank statement's closing balance is NOT an asset until the user Applies it
 * as a cash asset (WP-08/WP-15 proposal, target_domain 'asset'). Until then it
 * is shown as "Bank balance per statement -- not in Net Worth": the latest
 * approved statement's reported closing balance per ordinary bank account
 * (never a card/loan facility), and it is never added to any total.
 */
import '@/lib/serverOnly';
import { loadFxContext, toReporting, type FxContext, type ReportingCurrency } from './core/currency';
import type { NormalisedLedger } from './core/ledger';
import { fetchAllByIds, fetchAllRows, type ReadModelClient } from './core/paginate';
import { isFacilityAccount } from './core/spendingRules';
import { ReadModelUnavailableError, addUnconverted, emptyUnconverted, isHouseholdOwner, provenance, roundMoney, toUnavailable, type MoneyValue, type Provenance, type ReadModelResult, type UnconvertedTally } from './core/types';

export interface AssetRow {
  id: string;
  asset_name: string;
  asset_class: string | null;
  current_value: number;
  currency_code: string;
  owner: string | null;
  master_item_key: string | null;
  source_type: string | null;
  linked_liability_id: string | null;
  /** WP-15 (0214): the bank account whose statement balance this cash asset carries. Absent before 0214. */
  source_financial_account_id?: string | null;
}

export interface BankAccountRow {
  id: string;
  account_type: string;
  display_name: string | null;
  currency_code: string;
  owner_role?: string | null;
  liability_id?: string | null;
}

export interface ApprovedStatementRow {
  id: string;
  financial_account_id: string | null;
  statement_period_end: string | null;
  approved_at: string | null;
}

export interface ReconciliationRow {
  statement_upload_id: string;
  reported_closing_balance: number | null;
  currency_code: string | null;
  created_at: string | null;
}

export interface AssetLine {
  id: string;
  name: string;
  assetClass: string | null;
  masterItemKey: string | null;
  owner: string | null;
  household: boolean;
  linkedLiabilityId: string | null;
  value: MoneyValue;
  provenance: Provenance;
}

export interface BankBalanceEvidence {
  accountId: string;
  accountName: string | null;
  ownerRole: string | null;
  statementUploadId: string;
  asOf: string | null;
  closingBalance: MoneyValue;
  label: string;
  /** WP-15: the asset this balance was applied as (it is then in Net Worth once, through that asset -- never through this bucket). */
  inNetWorthAs: { assetId: string; assetName: string } | null;
}

export const BANK_BALANCE_EVIDENCE_LABEL = 'Bank balance per statement — not in Net Worth';

export interface AssetsReadModelData {
  reportingCurrency: ReportingCurrency;
  lines: AssetLine[];
  total: number;
  householdTotal: number;
  bankBalanceEvidence: { label: string; accounts: BankBalanceEvidence[]; total: number };
  unconverted: UnconvertedTally;
}

export type AssetsReadModel = ReadModelResult<AssetsReadModelData>;

const r = roundMoney;

export function computeAssets(input: {
  assets: readonly AssetRow[];
  bankAccounts: readonly BankAccountRow[];
  statements: readonly ApprovedStatementRow[];
  reconciliations: readonly ReconciliationRow[];
  fx: FxContext;
}): AssetsReadModelData {
  const { fx } = input;
  const unconverted = emptyUnconverted();
  const lines: AssetLine[] = input.assets.map((row) => {
    const amountReporting = toReporting(Number(row.current_value), row.currency_code, fx);
    if (amountReporting === null) addUnconverted(unconverted, row.currency_code, Number(row.current_value));
    return {
      id: row.id, name: row.asset_name, assetClass: row.asset_class, masterItemKey: row.master_item_key, owner: row.owner,
      household: isHouseholdOwner(row.owner), linkedLiabilityId: row.linked_liability_id,
      value: { amountNative: Number(row.current_value), currency: row.currency_code, amountReporting },
      provenance: row.source_type === 'investment_intelligence_published'
        ? provenance('investment_intelligence')
        : row.source_type === 'bank_statement_import'
          ? provenance('bank_statement', null, row.source_financial_account_id ?? null)
          : provenance('manual'),
    };
  });

  const recon = new Map<string, ReconciliationRow>();
  for (const rc of input.reconciliations) {
    if (rc.reported_closing_balance == null) continue;
    const cur = recon.get(rc.statement_upload_id);
    if (!cur || (rc.created_at ?? '') > (cur.created_at ?? '')) recon.set(rc.statement_upload_id, rc);
  }
  const evidence: BankBalanceEvidence[] = [];
  for (const account of input.bankAccounts) {
    if (isFacilityAccount(account)) continue;
    const latest = input.statements
      .filter((s) => s.financial_account_id === account.id && recon.has(s.id))
      .sort((a, b) => ((a.statement_period_end ?? a.approved_at ?? '') < (b.statement_period_end ?? b.approved_at ?? '') ? 1 : -1))[0];
    if (!latest) continue;
    const rc = recon.get(latest.id)!;
    const currency = rc.currency_code ?? account.currency_code;
    const applied = input.assets.find((a) => a.source_financial_account_id === account.id) ?? null;
    evidence.push({
      accountId: account.id,
      accountName: account.display_name,
      ownerRole: account.owner_role ?? null,
      statementUploadId: latest.id,
      asOf: latest.statement_period_end,
      closingBalance: { amountNative: Number(rc.reported_closing_balance), currency, amountReporting: toReporting(Number(rc.reported_closing_balance), currency, fx) },
      label: BANK_BALANCE_EVIDENCE_LABEL,
      inNetWorthAs: applied ? { assetId: applied.id, assetName: applied.asset_name } : null,
    });
  }
  const sum = (vals: (number | null)[]) => r(vals.reduce<number>((s, v) => s + (v ?? 0), 0));
  return {
    reportingCurrency: fx.reportingCurrency,
    lines,
    total: sum(lines.map((l) => l.value.amountReporting)),
    householdTotal: sum(lines.filter((l) => l.household).map((l) => l.value.amountReporting)),
    bankBalanceEvidence: { label: BANK_BALANCE_EVIDENCE_LABEL, accounts: evidence, total: sum(evidence.map((e) => e.closingBalance.amountReporting)) },
    unconverted,
  };
}

const ASSET_COLUMNS = 'id, asset_name, asset_class, current_value, currency_code, owner, master_item_key, source_type, linked_liability_id';

async function loadAssetRows(userId: string, client: ReadModelClient): Promise<AssetRow[]> {
  const read = (columns: string) => (from: number, to: number) =>
    client.from('assets').select(columns).eq('user_id', userId).eq('is_active', true).order('id', { ascending: true }).range(from, to);
  // WP-15's account link (0214). On a database without 0214, read without it
  // (every asset is then unlinked) -- never fail the whole Assets model on an
  // additive column that is not deployed yet. Any other error fails closed.
  const probe: { error: unknown } = await client.from('assets').select(`${ASSET_COLUMNS}, source_financial_account_id`).eq('user_id', userId).range(0, 0);
  const code = (probe.error as { code?: string } | null)?.code;
  if (probe.error && (code === '42703' || code === 'PGRST204')) {
    return (await fetchAllRows<AssetRow>('assets', read(ASSET_COLUMNS))).map((r) => ({ ...r, source_financial_account_id: null }));
  }
  if (probe.error) throw new ReadModelUnavailableError('query_failed', 'assets');
  return fetchAllRows<AssetRow>('assets', read(`${ASSET_COLUMNS}, source_financial_account_id`));
}

export async function loadAssetInputs(userId: string, client: ReadModelClient, bankAccounts: readonly BankAccountRow[]) {
  const assets = await loadAssetRows(userId, client);
  const statements = await fetchAllRows<ApprovedStatementRow>('fdh_statement_uploads', (from, to) =>
    client
      .from('fdh_statement_uploads')
      .select('id, financial_account_id, statement_period_end, approved_at')
      .eq('user_id', userId)
      .eq('processing_status', 'approved')
      .order('id', { ascending: true })
      .range(from, to));
  const reconciliations = await fetchAllByIds<ReconciliationRow>('fdh_reconciliation_results', statements.map((s) => s.id), (chunk, from, to) =>
    client
      .from('fdh_reconciliation_results')
      .select('statement_upload_id, reported_closing_balance, currency_code, created_at')
      .eq('user_id', userId)
      .in('statement_upload_id', chunk)
      .range(from, to));
  return { assets, bankAccounts, statements, reconciliations };
}

/** THE Assets selector (register + bank-balance evidence). Any failed read -> 'unavailable'. */
export async function selectAssets(userId: string, opts: { client: ReadModelClient; fx?: FxContext; ledger?: NormalisedLedger }): Promise<AssetsReadModel> {
  try {
    const fx = opts.fx ?? (await loadFxContext(userId, opts.client));
    const bankAccounts: BankAccountRow[] = opts.ledger
      ? [...opts.ledger.accounts.values()]
      : await fetchAllRows<BankAccountRow>('fdh_financial_accounts', (from, to) =>
        opts.client.from('fdh_financial_accounts').select('id, account_type, display_name, currency_code').eq('user_id', userId).order('id', { ascending: true }).range(from, to));
    const inputs = await loadAssetInputs(userId, opts.client, bankAccounts);
    return { status: 'ok', ...computeAssets({ ...inputs, fx }) };
  } catch (error) {
    return toUnavailable(error, 'selectAssets');
  }
}
