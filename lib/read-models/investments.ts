/**
 * selectInvestments -- the ONE portfolio total, plus the imported holdings that
 * have not reached it yet (DC-08 / INV-G1, PO D-05).
 *
 *  - PUBLISHED = active `investments` rows (manual and Investment-Intelligence
 *    published). This is what Net Worth counts.
 *  - IMPORTED, NOT YET IN NET WORTH = the latest ii_holding_snapshots position
 *    per (account, instrument) that no publication covers: an AU broker
 *    statement Applied into Investment Intelligence but not yet added to Net
 *    Worth. Its value and count are reported with that exact label and NEVER
 *    added to the published total (no double count once it is published, and
 *    no silent inclusion before the user confirms -- D-05).
 *
 * A position is "published" when an active investments row carries its
 * (ii_canonical_account_id, ii_canonical_instrument_id), or an
 * ii_fhip_publications row with status 'published' names one of its
 * snapshots (any target -- EPF/NPS publish into retirement_accounts).
 */
import '@/lib/serverOnly';
import { loadFxContext, toReporting, type FxContext, type ReportingCurrency } from './core/currency';
import { fetchAllRows, type ReadModelClient } from './core/paginate';
import { addUnconverted, emptyUnconverted, isHouseholdOwner, provenance, roundMoney, toUnavailable, type MoneyValue, type Provenance, type ReadModelResult, type UnconvertedTally } from './core/types';

export interface InvestmentRow {
  id: string;
  investment_name: string;
  investment_type: string | null;
  current_value: number;
  currency_code: string;
  owner: string | null;
  master_item_key: string | null;
  source_type: string | null;
  /** WP-04: goal funding-source allocation reads it through this selector (paged). */
  annual_contribution?: number | null;
  ii_canonical_account_id: string | null;
  ii_canonical_instrument_id: string | null;
}

export interface HoldingSnapshotRow {
  id: string;
  account_id: string;
  instrument_id: string;
  as_of_date: string;
  units: number;
  value: number;
  currency_code: string;
  created_at: string | null;
}

export interface PublicationRow {
  canonical_position_id: string;
  status: string;
}

export interface InvestmentLine {
  id: string;
  name: string;
  investmentType: string | null;
  masterItemKey: string | null;
  owner: string | null;
  household: boolean;
  value: MoneyValue;
  /** Native currency, per year; null when not recorded. */
  annualContribution: number | null;
  provenance: Provenance;
}

export interface UnpublishedHolding {
  accountId: string;
  instrumentId: string;
  snapshotId: string;
  asOfDate: string;
  units: number;
  value: MoneyValue;
}

export const UNPUBLISHED_BUCKET_LABEL = 'Imported, not yet in Net Worth';

export interface InvestmentsReadModelData {
  reportingCurrency: ReportingCurrency;
  lines: InvestmentLine[];
  /** All owners -- the Net Worth figure. */
  publishedTotal: number;
  householdPublishedTotal: number;
  unpublished: { label: string; count: number; total: number; holdings: UnpublishedHolding[] };
  unconverted: UnconvertedTally;
}

export type InvestmentsReadModel = ReadModelResult<InvestmentsReadModelData>;

const r = roundMoney;
const pairKey = (accountId: string, instrumentId: string) => `${accountId}|${instrumentId}`;

export function computeInvestments(input: {
  investments: readonly InvestmentRow[];
  snapshots: readonly HoldingSnapshotRow[];
  publications: readonly PublicationRow[];
  fx: FxContext;
}): InvestmentsReadModelData {
  const { fx } = input;
  const unconverted = emptyUnconverted();
  const lines: InvestmentLine[] = input.investments.map((row) => {
    const amountReporting = toReporting(Number(row.current_value), row.currency_code, fx);
    if (amountReporting === null) addUnconverted(unconverted, row.currency_code, Number(row.current_value));
    return {
      id: row.id, name: row.investment_name, investmentType: row.investment_type, masterItemKey: row.master_item_key,
      owner: row.owner, household: isHouseholdOwner(row.owner),
      value: { amountNative: Number(row.current_value), currency: row.currency_code, amountReporting },
      annualContribution: row.annual_contribution == null ? null : Number(row.annual_contribution),
      provenance: row.source_type === 'investment_intelligence_published' ? provenance('investment_intelligence') : provenance('manual'),
    };
  });

  const published = new Set<string>();
  for (const row of input.investments) {
    if (row.ii_canonical_account_id && row.ii_canonical_instrument_id) published.add(pairKey(row.ii_canonical_account_id, row.ii_canonical_instrument_id));
  }
  const snapshotById = new Map(input.snapshots.map((s) => [s.id, s] as const));
  for (const p of input.publications) {
    if (p.status !== 'published') continue;
    const s = snapshotById.get(p.canonical_position_id);
    if (s) published.add(pairKey(s.account_id, s.instrument_id));
  }
  const latest = new Map<string, HoldingSnapshotRow>();
  for (const s of input.snapshots) {
    const k = pairKey(s.account_id, s.instrument_id);
    const cur = latest.get(k);
    if (!cur || s.as_of_date > cur.as_of_date || (s.as_of_date === cur.as_of_date && (s.created_at ?? '') > (cur.created_at ?? ''))) latest.set(k, s);
  }
  const holdings: UnpublishedHolding[] = [];
  for (const [k, s] of latest) {
    if (published.has(k) || Number(s.units) <= 0) continue;
    const amountReporting = toReporting(Number(s.value), s.currency_code, fx);
    if (amountReporting === null) addUnconverted(unconverted, s.currency_code, Number(s.value));
    holdings.push({ accountId: s.account_id, instrumentId: s.instrument_id, snapshotId: s.id, asOfDate: s.as_of_date, units: Number(s.units), value: { amountNative: Number(s.value), currency: s.currency_code, amountReporting } });
  }
  holdings.sort((a, b) => (a.accountId + a.instrumentId < b.accountId + b.instrumentId ? -1 : 1));
  const sum = (vals: (number | null)[]) => r(vals.reduce<number>((s, v) => s + (v ?? 0), 0));
  return {
    reportingCurrency: fx.reportingCurrency,
    lines,
    publishedTotal: sum(lines.map((l) => l.value.amountReporting)),
    householdPublishedTotal: sum(lines.filter((l) => l.household).map((l) => l.value.amountReporting)),
    unpublished: { label: UNPUBLISHED_BUCKET_LABEL, count: holdings.length, total: sum(holdings.map((h) => h.value.amountReporting)), holdings },
    unconverted,
  };
}

export async function loadInvestmentInputs(userId: string, client: ReadModelClient) {
  const investments = await fetchAllRows<InvestmentRow>('investments', (from, to) =>
    client
      .from('investments')
      .select('id, investment_name, investment_type, current_value, currency_code, owner, master_item_key, source_type, annual_contribution, ii_canonical_account_id, ii_canonical_instrument_id')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(from, to));
  const snapshots = await fetchAllRows<HoldingSnapshotRow>('ii_holding_snapshots', (from, to) =>
    client
      .from('ii_holding_snapshots')
      .select('id, account_id, instrument_id, as_of_date, units, value, currency_code, created_at')
      .eq('user_id', userId)
      .order('id', { ascending: true })
      .range(from, to));
  const publications = await fetchAllRows<PublicationRow>('ii_fhip_publications', (from, to) =>
    client
      .from('ii_fhip_publications')
      .select('canonical_position_id, status')
      .eq('user_id', userId)
      .order('canonical_position_id', { ascending: true })
      .range(from, to));
  return { investments, snapshots, publications };
}

/** THE Investments selector. Any failed read -> { status: 'unavailable' }. */
export async function selectInvestments(userId: string, opts: { client: ReadModelClient; fx?: FxContext }): Promise<InvestmentsReadModel> {
  try {
    const fx = opts.fx ?? (await loadFxContext(userId, opts.client));
    const inputs = await loadInvestmentInputs(userId, opts.client);
    return { status: 'ok', ...computeInvestments({ ...inputs, fx }) };
  } catch (error) {
    return toUnavailable(error, 'selectInvestments');
  }
}
