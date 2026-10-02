// India Mutual Fund Investment Report — DB loader. Reads the household's own
// rows (every query is filtered by user_id — the report generator passes a
// service-role client, so this filter IS the tenancy boundary), shapes them
// into the pure module's input and calls buildIndiaMfReport(). Writes nothing.
//
// GATE. Returns null — "not applicable" — when the user has no INR
// mutual-fund account/holding at all. This is NOT a home-country check (PO
// decision 2026-10-01): an Australian-resident user with an Indian mutual-fund
// folio gets the section; a user with no Indian mutual-fund holding never does.
//
// FAIL CLOSED. Once a user is known to hold India mutual funds, any read
// failure surfaces as { status: 'error' } and the report shows an honest
// "could not be produced" section — never a partial or zero table.
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';
import {
  buildIndiaMfReport,
  hasIndiaMfHoldings,
  type IndiaMfReport,
  type IndiaMfReportInput,
  type MfAccount,
  type MfAllocation,
  type MfEntity,
  type MfInstrument,
  type MfMember,
  type MfNav,
  type MfSnapshot,
  type MfTransaction,
  type MfTruth,
} from '@/lib/engines/investment-intelligence/indiaMfReport';
import { loadIndexCloses } from './marketIndex/indexCloseReader';

export type ReportIndiaMfData =
  | { status: 'ok'; report: IndiaMfReport }
  | { status: 'error'; message: string };

const CHUNK = 150;
function chunk<T>(ids: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
  return out;
}

export async function loadIndiaMfReportForReport(
  userId: string,
  supabase: SupabaseClient,
  valuationDate: string,
  reportDate: string = valuationDate
): Promise<ReportIndiaMfData | null> {
  // ---- Stage 1: is there any India mutual-fund holding at all? --------------
  let accounts: MfAccount[];
  try {
    const rows = await fetchAllRows<{ id: string; folio_number: string | null; owner_member_id: string | null; currency_code: string; country_code: string | null; institution_name: string | null }>(() =>
      supabase.from('ii_accounts').select('id, folio_number, owner_member_id, currency_code, country_code, institution_name').eq('user_id', userId).order('id', { ascending: true })
    );
    accounts = rows
      .filter((r) => r.currency_code === 'INR')
      .map((r) => ({ id: r.id, folioNumber: r.folio_number, ownerMemberId: r.owner_member_id, currencyCode: r.currency_code, countryCode: r.country_code, institutionName: r.institution_name }));
  } catch {
    // Cannot tell whether the user holds India funds: do not show a section we cannot stand behind.
    return null;
  }
  if (accounts.length === 0) return null;

  try {
    const accountIds = accounts.map((a) => a.id);
    const transactions = await fetchAllRows<{
      id: string;
      account_id: string;
      instrument_id: string;
      transaction_type: string;
      transaction_date: string;
      units: number | string | null;
      price_per_unit: number | string | null;
      gross_amount: number | string;
      status: string;
      source_reference: string | null;
    }>(() =>
      supabase
        .from('ii_transactions')
        .select('id, account_id, instrument_id, transaction_type, transaction_date, units, price_per_unit, gross_amount, status, source_reference')
        .eq('user_id', userId)
        .lte('transaction_date', valuationDate)
        .order('transaction_date', { ascending: true })
        .order('id', { ascending: true })
    );
    const snapshots = await fetchAllRows<{ account_id: string; instrument_id: string; as_of_date: string; units: number | string; value: number | string }>(() =>
      supabase
        .from('ii_holding_snapshots')
        .select('account_id, instrument_id, as_of_date, units, value')
        .eq('user_id', userId)
        .lte('as_of_date', valuationDate)
        .order('as_of_date', { ascending: true })
        .order('id', { ascending: true })
    );

    const inrAccountSet = new Set(accountIds);
    const instrumentIds = [...new Set([...transactions, ...snapshots].filter((r) => inrAccountSet.has(r.account_id)).map((r) => r.instrument_id))];
    const instrumentRows: Array<{ id: string; instrument_name: string; isin: string | null; instrument_class: string }> = [];
    for (const ids of chunk(instrumentIds)) {
      const { data, error } = await supabase.from('ii_instruments').select('id, instrument_name, isin, instrument_class').in('id', ids);
      if (error) throw new Error(`ii_instruments: ${error.message}`);
      instrumentRows.push(...((data ?? []) as typeof instrumentRows));
    }
    const mutualFundIds = instrumentRows.filter((i) => i.instrument_class === 'mutual_fund').map((i) => i.id);

    // Canonical scheme names (AMFI's own), same preference the Holdings table uses.
    const canonicalName = new Map<string, string>();
    for (const ids of chunk(mutualFundIds)) {
      const { data } = await supabase.from('ii_scheme_master').select('instrument_id, scheme_name').in('instrument_id', ids).is('effective_to', null);
      for (const r of (data ?? []) as Array<{ instrument_id: string; scheme_name: string }>) canonicalName.set(r.instrument_id, r.scheme_name);
    }
    const instruments: MfInstrument[] = instrumentRows.map((i) => ({ id: i.id, name: canonicalName.get(i.id) ?? i.instrument_name, isin: i.isin, instrumentClass: i.instrument_class }));

    // Latest published NAV on or before the valuation date, one row per fund.
    const navs: MfNav[] = [];
    for (const ids of chunk(mutualFundIds)) {
      const results = await Promise.all(
        ids.map(async (instrumentId) => {
          const { data, error } = await supabase
            .from('ii_prices_nav')
            .select('instrument_id, price_date, price')
            .eq('instrument_id', instrumentId)
            .lte('price_date', valuationDate)
            .neq('quality_status', 'superseded')
            .order('price_date', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (error) throw new Error(`ii_prices_nav: ${error.message}`);
          return data as { instrument_id: string; price_date: string; price: number | string } | null;
        })
      );
      for (const r of results) if (r) navs.push({ instrumentId: r.instrument_id, date: r.price_date, price: Number(r.price) });
    }

    const truthRows = await fetchAllRows<{ account_id: string; instrument_id: string; status: string; history_completeness: MfTruth['historyCompleteness']; unit_variance_within_tolerance: boolean | null }>(() =>
      supabase.from('ii_portfolio_truth_status').select('account_id, instrument_id, status, history_completeness, unit_variance_within_tolerance').eq('user_id', userId).order('id', { ascending: true })
    );
    const allocationRows = await fetchAllRows<{
      ii_account_id: string;
      ii_instrument_id: string | null;
      owner_member_id: string | null;
      owner_business_entity_id: string | null;
      allocation_basis_points: number;
      allocation_group_id: string;
      status: string;
      effective_from: string | null;
      effective_to: string | null;
    }>(() =>
      supabase
        .from('ii_ownership_allocation')
        .select('ii_account_id, ii_instrument_id, owner_member_id, owner_business_entity_id, allocation_basis_points, allocation_group_id, status, effective_from, effective_to')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('id', { ascending: true })
    );
    const memberRows = await fetchAllRows<{ id: string; full_name: string; relationship: string }>(() =>
      supabase.from('household_members').select('id, full_name, relationship').eq('user_id', userId).order('id', { ascending: true })
    );
    const entityRows = await fetchAllRows<{ id: string; name: string; entity_type: string }>(() =>
      supabase.from('business_entities').select('id, name, entity_type').eq('user_id', userId).order('id', { ascending: true })
    );
    const closes = await loadIndexCloses(supabase, valuationDate);

    const input: IndiaMfReportInput = {
      valuationDate,
      reportDate,
      accounts,
      instruments,
      transactions: transactions
        .filter((t) => inrAccountSet.has(t.account_id))
        .map<MfTransaction>((t) => ({
          id: t.id,
          accountId: t.account_id,
          instrumentId: t.instrument_id,
          type: t.transaction_type,
          date: t.transaction_date,
          units: t.units === null ? null : Number(t.units),
          amount: Number(t.gross_amount),
          pricePerUnit: t.price_per_unit === null ? null : Number(t.price_per_unit),
          status: t.status,
          sourceReference: t.source_reference,
        })),
      snapshots: snapshots
        .filter((s) => inrAccountSet.has(s.account_id))
        .map<MfSnapshot>((s) => ({ accountId: s.account_id, instrumentId: s.instrument_id, asOfDate: s.as_of_date, units: Number(s.units), value: Number(s.value) })),
      navs,
      truth: truthRows.map<MfTruth>((t) => ({ accountId: t.account_id, instrumentId: t.instrument_id, status: t.status, historyCompleteness: t.history_completeness, unitVarianceWithinTolerance: t.unit_variance_within_tolerance })),
      allocations: allocationRows.map<MfAllocation>((a) => ({
        accountId: a.ii_account_id,
        instrumentId: a.ii_instrument_id,
        ownerMemberId: a.owner_member_id,
        ownerEntityId: a.owner_business_entity_id,
        basisPoints: a.allocation_basis_points,
        groupId: a.allocation_group_id,
        status: a.status,
        effectiveFrom: a.effective_from,
        effectiveTo: a.effective_to,
      })),
      members: memberRows.map<MfMember>((m) => ({ id: m.id, fullName: m.full_name, relationship: m.relationship })),
      entities: entityRows.map<MfEntity>((e) => ({ id: e.id, name: e.name, entityType: e.entity_type })),
      sensex: closes.sensex,
      nifty: closes.nifty,
    };

    if (!hasIndiaMfHoldings(input)) return null;
    const report = buildIndiaMfReport(input);
    if (!report) return null;
    return { status: 'ok', report };
  } catch (e) {
    // A database that has not got the market-index / benchmark-governance migrations (0232, 0239) or another
    // newer table or column yet must NOT break report generation: a missing relation/column means the section
    // cannot be stood behind, so it is HIDDEN (null), exactly like "no India MF holding" - never an error section.
    if (isMissingSchemaError(e)) return null;
    return { status: 'error', message: e instanceof Error ? e.message : 'Unknown error' };
  }
}

/** Postgres/PostgREST "relation/column/function does not exist" or schema-cache miss. */
export function isMissingSchemaError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const code = (e as { code?: string } | null)?.code;
  return code === '42P01' || code === '42703' || code === '42883' || code === 'PGRST205' || code === 'PGRST202' || /does not exist|schema cache|could not find the (table|function|column)/i.test(msg);
}
