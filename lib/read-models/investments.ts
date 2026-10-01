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
 * ENTITY SEPARATION (PO ruling 2026-09-21, wired 2026-10-01): an account whose
 * active ownership allocation includes a business-entity share (Family Trust /
 * HUF / Company) is NOT personal Net Worth and is never offered to it, so its
 * snapshots are excluded from the "Imported, not yet in Net Worth" bucket too
 * (only counted in `entityHeldExcludedCount`, never added to any total).
 *
 * A position is "published" when an active investments row carries its
 * (ii_canonical_account_id, ii_canonical_instrument_id), or an
 * ii_fhip_publications row with status 'published' names one of its
 * snapshots (any target -- EPF/NPS publish into retirement_accounts).
 */
import '@/lib/serverOnly';
import { loadFxContext, toReporting, type FxContext, type ReportingCurrency } from './core/currency';
import { fetchAllRows, type ReadModelClient } from './core/paginate';
import { attributeByBasisPoints } from '@/lib/services/investment-intelligence/ownerAttribution';
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
  ii_canonical_account_id: string | null;
  ii_canonical_instrument_id: string | null;
  /** WP-05: Twin geographic diversification and the forecast contribution leg. */
  country_code?: string | null;
  /** WP-04: goal funding-source allocation; WP-05: the forecast contribution leg (paged). */
  annual_contribution?: number | null;
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

/** One owner's share of a position published ONCE for a joint split (2026-10-01). Amounts add back to the line's value exactly. */
export interface InvestmentOwnerShare {
  ownerMemberId: string;
  basisPoints: number;
  amountNative: number;
  /** null when the line's currency is not convertible (same rule as the line itself). */
  amountReporting: number | null;
}

export interface InvestmentLine {
  id: string;
  name: string;
  investmentType: string | null;
  masterItemKey: string | null;
  owner: string | null;
  household: boolean;
  value: MoneyValue;
  /** WP-05: as recorded; null when not captured. */
  countryCode: string | null;
  /** WP-05: native currency, per year; null when not captured. */
  annualContribution: number | null;
  provenance: Provenance;
  /**
   * Present only for a position published from an account jointly owned by
   * household members: the SAME single value divided by the ownership split
   * (1,000,000 at 60/40 -> 600,000 / 400,000). Never an extra contribution: the
   * line is still counted once in `publishedTotal` / `householdPublishedTotal`.
   */
  ownerShares?: InvestmentOwnerShare[];
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
  /** Positions left out of the personal "not yet in Net Worth" bucket because an entity owns (a share of) their account. Never added to a total. */
  entityHeldExcludedCount: number;
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
  /** Accounts with an active entity ownership share. Optional: absent = none (the pre-2026-10-01 behaviour). */
  entityOwnedAccountIds?: ReadonlySet<string>;
  /** Accounts jointly owned by household members only: active split per account (shares total 10000). Optional. */
  jointSharesByAccount?: ReadonlyMap<string, readonly { ownerMemberId: string; basisPoints: number }[]>;
  fx: FxContext;
}): InvestmentsReadModelData {
  const { fx } = input;
  const unconverted = emptyUnconverted();
  const lines: InvestmentLine[] = input.investments.map((row) => {
    const amountReporting = toReporting(Number(row.current_value), row.currency_code, fx);
    if (amountReporting === null) addUnconverted(unconverted, row.currency_code, Number(row.current_value));
    const jointShares = row.ii_canonical_account_id ? input.jointSharesByAccount?.get(row.ii_canonical_account_id) : undefined;
    const nativeSplit = jointShares ? attributeByBasisPoints(Number(row.current_value), jointShares.map((s) => ({ key: s.ownerMemberId, basisPoints: s.basisPoints }))) : null;
    const reportingSplit = jointShares && amountReporting !== null ? attributeByBasisPoints(amountReporting, jointShares.map((s) => ({ key: s.ownerMemberId, basisPoints: s.basisPoints }))) : null;
    const ownerShares: InvestmentOwnerShare[] | undefined = nativeSplit
      ? nativeSplit.map((s, i) => ({ ownerMemberId: s.key, basisPoints: s.basisPoints, amountNative: s.amount, amountReporting: reportingSplit ? reportingSplit[i].amount : null }))
      : undefined;
    return {
      id: row.id, name: row.investment_name, investmentType: row.investment_type, masterItemKey: row.master_item_key,
      owner: row.owner, household: isHouseholdOwner(row.owner),
      value: { amountNative: Number(row.current_value), currency: row.currency_code, amountReporting },
      countryCode: row.country_code ?? null,
      annualContribution: row.annual_contribution == null ? null : Number(row.annual_contribution),
      provenance: row.source_type === 'investment_intelligence_published' ? provenance('investment_intelligence') : provenance('manual'),
      ...(ownerShares ? { ownerShares } : {}),
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
  let entityHeldExcludedCount = 0;
  for (const [k, s] of latest) {
    if (published.has(k) || Number(s.units) <= 0) continue;
    if (input.entityOwnedAccountIds?.has(s.account_id)) {
      entityHeldExcludedCount += 1;
      continue;
    }
    const amountReporting = toReporting(Number(s.value), s.currency_code, fx);
    if (amountReporting === null) addUnconverted(unconverted, s.currency_code, Number(s.value));
    holdings.push({ accountId: s.account_id, instrumentId: s.instrument_id, snapshotId: s.id, asOfDate: s.as_of_date, units: Number(s.units), value: { amountNative: Number(s.value), currency: s.currency_code, amountReporting } });
  }
  holdings.sort((a, b) => (a.accountId + a.instrumentId < b.accountId + b.instrumentId ? -1 : 1));
  const sum = (vals: (number | null)[]) => r(vals.reduce<number>((s, v) => s + (v ?? 0), 0));
  return {
    entityHeldExcludedCount,
    reportingCurrency: fx.reportingCurrency,
    lines,
    publishedTotal: sum(lines.map((l) => l.value.amountReporting)),
    householdPublishedTotal: sum(lines.filter((l) => l.household).map((l) => l.value.amountReporting)),
    unpublished: { label: UNPUBLISHED_BUCKET_LABEL, count: holdings.length, total: sum(holdings.map((h) => h.value.amountReporting)), holdings },
    unconverted,
  };
}

/** The active `investments` register, paged (WP-05: also used alone by register-only consumers). */
export async function loadInvestmentRows(userId: string, client: ReadModelClient): Promise<InvestmentRow[]> {
  return fetchAllRows<InvestmentRow>('investments', (from, to) =>
    client
      .from('investments')
      .select('id, investment_name, investment_type, current_value, currency_code, owner, master_item_key, source_type, ii_canonical_account_id, ii_canonical_instrument_id, country_code, annual_contribution')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('id', { ascending: true })
      .range(from, to));
}

export async function loadInvestmentInputs(userId: string, client: ReadModelClient) {
  const investments = await loadInvestmentRows(userId, client);
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
  // Accounts owned (even partly) by a business entity: kept out of the personal
  // "imported, not yet in Net Worth" bucket. Account-grain active rows only.
  //
  // DELIBERATELY NOT FAIL-CLOSED, unlike every other read here: this feeds only
  // the INFORMATIONAL unpublished bucket (never publishedTotal / any total), and
  // an entity owner can only exist if `ii_ownership_allocation` (migration 0153)
  // does -- so "table unreadable" correctly degrades to "no entity-owned
  // accounts" (the exact pre-2026-10-01 behaviour) rather than taking the whole
  // Investments read model, and every Net Worth figure built on it, offline.
  type AllocRow = { ii_account_id: string; owner_member_id: string | null; owner_business_entity_id: string | null; allocation_basis_points: number; ii_instrument_id: string | null };
  let allocRows: AllocRow[] = [];
  try {
    allocRows = await fetchAllRows<AllocRow>('ii_ownership_allocation', (from, to) =>
      client
        .from('ii_ownership_allocation')
        .select('id, ii_account_id, owner_member_id, owner_business_entity_id, allocation_basis_points, ii_instrument_id')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('id', { ascending: true })
        .range(from, to));
  } catch {
    allocRows = [];
  }
  const accountGrain = allocRows.filter((r) => (r.ii_instrument_id ?? null) === null);
  const entityOwnedAccountIds = new Set(accountGrain.filter((r) => r.owner_business_entity_id).map((r) => r.ii_account_id));
  // Joint splits between household members only, and only when the group is a complete 100%
  // (a malformed split is never used to divide a value).
  const byAccount = new Map<string, AllocRow[]>();
  for (const r of accountGrain) byAccount.set(r.ii_account_id, [...(byAccount.get(r.ii_account_id) ?? []), r]);
  const jointSharesByAccount = new Map<string, { ownerMemberId: string; basisPoints: number }[]>();
  for (const [accountId, group] of byAccount) {
    if (group.length < 2 || group.some((r) => !r.owner_member_id || r.owner_business_entity_id)) continue;
    if (group.reduce((s, r) => s + r.allocation_basis_points, 0) !== 10000) continue;
    jointSharesByAccount.set(accountId, group.map((r) => ({ ownerMemberId: r.owner_member_id as string, basisPoints: r.allocation_basis_points })));
  }
  return { investments, snapshots, publications, entityOwnedAccountIds, jointSharesByAccount };
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
