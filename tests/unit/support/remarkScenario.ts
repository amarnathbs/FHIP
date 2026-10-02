// Shared fixtures for the Net Worth NAV re-mark tests: one published
// Investment Intelligence mutual-fund POSITION (register row + active
// publication + certified snapshot + instrument + optional NAVs / movements)
// expressed as the plain table rows the re-mark service reads.

import type { Row } from './remarkFakeDb';

export const USER = 'user-1';
export const OTHER_USER = 'user-2';
/** The valuation date every scenario uses ("today"). */
export const TODAY = '2026-10-01';

export interface NavSpec {
  date: string;
  price: number;
  currency?: string;
  quality?: string;
}
export interface MovementSpec {
  type: string;
  date: string;
  units: number;
  status?: string;
}
export interface PositionSpec {
  /** Short id; row ids derive from it (inv-<id>, pub-<id>, snap-<id>, acc-<id>, inst-<id>). */
  id: string;
  user?: string;
  /** Share an account / instrument between positions (multi-folio, same scheme). */
  account?: string;
  instrument?: string;
  units?: number;
  value?: number;
  stmtDate?: string;
  /** What `investments.current_value` holds right now (default: the statement value, as publication leaves it). */
  rowValue?: number;
  rowCurrency?: string;
  snapshotCurrency?: string;
  instrumentClass?: string;
  owner?: string;
  institution?: string;
  name?: string;
  navs?: NavSpec[];
  movements?: MovementSpec[];
  /** A LATER, unpublished certified snapshot for the same (account, instrument). */
  laterSnapshot?: { date: string; units: number; value: number };
  /** Active ownership allocation rows on the account. */
  allocations?: Array<{ member?: string; entity?: string; basisPoints: number }>;
  /** Register fields a previous re-mark would have stored. */
  stored?: Partial<Record<'ii_value_as_of' | 'ii_valuation_basis' | 'ii_valuation_units' | 'ii_valuation_nav' | 'ii_valuation_fingerprint', unknown>>;
}

export function emptyTables(): Record<string, Row[]> {
  return {
    investments: [],
    ii_fhip_publications: [],
    ii_holding_snapshots: [],
    ii_instruments: [],
    ii_ownership_allocation: [],
    ii_prices_nav: [],
    ii_transactions: [],
  };
}

/** Adds one published position's rows to `tables` (mutates and returns it). */
export function addPosition(tables: Record<string, Row[]>, spec: PositionSpec): Record<string, Row[]> {
  const user = spec.user ?? USER;
  const acc = spec.account ?? `acc-${spec.id}`;
  const inst = spec.instrument ?? `inst-${spec.id}`;
  const units = spec.units ?? 100;
  const value = spec.value ?? 10000;
  const stmtDate = spec.stmtDate ?? '2026-06-30';
  const currency = spec.rowCurrency ?? 'INR';

  tables.investments.push({
    id: `inv-${spec.id}`,
    user_id: user,
    is_active: true,
    source_type: 'investment_intelligence_published',
    investment_name: spec.name ?? `Fund ${spec.id}`,
    investment_type: 'managed_fund',
    master_item_key: 'managed_funds',
    institution: spec.institution ?? 'Alpha Mutual Fund',
    owner: spec.owner ?? 'self',
    current_value: spec.rowValue ?? value,
    currency_code: currency,
    ii_publication_id: `pub-${spec.id}`,
    updated_at: '2026-09-01T00:00:00.000Z',
    ii_canonical_account_id: acc,
    ii_canonical_instrument_id: inst,
    ii_value_as_of: null,
    ii_valuation_basis: null,
    ii_valuation_units: null,
    ii_valuation_nav: null,
    ii_valuation_fingerprint: null,
    ...(spec.stored ?? {}),
  });
  tables.ii_fhip_publications.push({
    id: `pub-${spec.id}`,
    user_id: user,
    published_row_id: `inv-${spec.id}`,
    canonical_position_id: `snap-${spec.id}`,
    account_id: acc,
    instrument_id: inst,
    status: 'published',
    publication_target: 'investments',
    published_value: value,
  });
  tables.ii_holding_snapshots.push({
    id: `snap-${spec.id}`,
    user_id: user,
    account_id: acc,
    instrument_id: inst,
    as_of_date: stmtDate,
    units,
    value,
    currency_code: spec.snapshotCurrency ?? 'INR',
    quality_status: 'certified',
  });
  if (spec.laterSnapshot) {
    tables.ii_holding_snapshots.push({
      id: `snap-later-${spec.id}`,
      user_id: user,
      account_id: acc,
      instrument_id: inst,
      as_of_date: spec.laterSnapshot.date,
      units: spec.laterSnapshot.units,
      value: spec.laterSnapshot.value,
      currency_code: 'INR',
      quality_status: 'certified',
    });
  }
  if (!tables.ii_instruments.some((i) => i.id === inst)) {
    tables.ii_instruments.push({ id: inst, instrument_class: spec.instrumentClass ?? 'mutual_fund' });
  }
  (spec.navs ?? []).forEach((n, i) => {
    tables.ii_prices_nav.push({
      id: `nav-${inst}-${i}-${tables.ii_prices_nav.length}`,
      instrument_id: inst,
      price_date: n.date,
      price: n.price,
      currency_code: n.currency ?? 'INR',
      quality_status: n.quality ?? 'ok',
    });
  });
  (spec.movements ?? []).forEach((m, i) => {
    tables.ii_transactions.push({
      id: `tx-${spec.id}-${i}`,
      user_id: user,
      account_id: acc,
      instrument_id: inst,
      transaction_type: m.type,
      transaction_date: m.date,
      units: m.units,
      status: m.status ?? 'parsed',
    });
  });
  for (const a of spec.allocations ?? []) {
    tables.ii_ownership_allocation.push({
      id: `alloc-${spec.id}-${tables.ii_ownership_allocation.length}`,
      user_id: user,
      ii_account_id: acc,
      owner_member_id: a.member ?? null,
      owner_business_entity_id: a.entity ?? null,
      allocation_basis_points: a.basisPoints,
      status: 'active',
    });
  }
  return tables;
}

/** The oracle position: 100 units, statement 10,000 at NAV 100 (2026-06-30), latest eligible NAV 112 on 2026-09-30. */
export function oracleTables(navs: NavSpec[] = [{ date: '2026-09-30', price: 112 }], extra: Partial<PositionSpec> = {}): Record<string, Row[]> {
  return addPosition(emptyTables(), { id: 'a', units: 100, value: 10000, stmtDate: '2026-06-30', navs, ...extra });
}

export const row = (tables: Record<string, Row[]>, id: string): Row => tables.investments.find((r) => r.id === id) as Row;
