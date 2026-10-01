/**
 * Investment Intelligence -- OWNER CLASSES (2026-10-01, PO decision).
 *
 * "Show everything, but in a SEPARATE breakup per owner class; a consolidated view
 * only as an explicit macro summary; entity-owned data is never silently summed
 * into personal totals."
 *
 * An account belongs to exactly ONE owner class, derived from its effective
 * ownership (ownerModel.deriveAccountOwnership):
 *
 *   member:<id>      personal  -- a sole household member (one section per member)
 *   joint            joint     -- a split between household members only
 *   entity:<id>      entity    -- a sole Trust / HUF / Company (one section per entity)
 *   entity_shared    entity    -- a split that includes an entity (PO: "goes in the
 *                                 separate entity tables"; never in personal totals)
 *   unallocated      --        -- no owner set, or an incomplete / unknown owner
 *
 * The key prefixes (`member:`, `entity:`, `unallocated`) deliberately match the
 * India MF report's owner keys (feat/india-mf-investment-report-20261001,
 * `resolveOwners`), so the two groupings agree: same classification of
 * "incomplete split -> unallocated" and "unknown id -> unallocated". The India
 * report shows a joint folio inside EACH owner's section at that owner's share;
 * this module additionally gives joint its own class and, inside it, the
 * per-owner attribution at the same shares (ownerAttribution.ts).
 *
 * THE CLASSES PARTITION THE ACCOUNTS, so every position is in exactly one class and
 * the consolidated macro line equals the sum of the classes (asserted). Nothing
 * here changes a financial formula: the certified R4/R5/R6 engines are run on a
 * per-class input scope (scopeClientToAccounts) or not at all.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchAllRows } from './pagination';
import { attributeByBasisPoints } from './ownerAttribution';
import { deriveAccountOwnership, memberRelationshipLabel, entityTypeDetail, type AccountOwnership, type ActiveAllocationRow, type OwnerShare } from './ownerModel';

export type OwnerClassKind = 'personal' | 'joint' | 'entity' | 'entity_shared' | 'unallocated';

export interface OwnerClassInfo {
  key: string;
  kind: OwnerClassKind;
  label: string;
  /** "You", "Spouse", "Family trust", ... */
  detail: string | null;
}

export interface OwnerLabels {
  member: (id: string) => { name: string; relationship: string } | undefined;
  entity: (id: string) => { name: string; entityType: string } | undefined;
}

export const UNALLOCATED_LABEL = 'Unallocated / owner not set';
export const JOINT_LABEL = 'Jointly owned (household members)';
export const ENTITY_SHARED_LABEL = 'Shared with a trust, HUF or company';
export const CONSOLIDATED_LABEL = 'Consolidated (macro view only)';
export const CONSOLIDATED_NOTE = 'A macro summary of every owner class above, each position counted once. It is not your personal total: entity-owned holdings are kept in their own tables.';

const UNALLOCATED: OwnerClassInfo = { key: 'unallocated', kind: 'unallocated', label: UNALLOCATED_LABEL, detail: null };

/** The owner class of one account's effective ownership. Unknown / incomplete owners fall to Unallocated, never dropped. */
export function classifyOwnership(o: AccountOwnership, labels: OwnerLabels): OwnerClassInfo {
  if (o.kind === 'unassigned') return UNALLOCATED;
  for (const s of o.shares) {
    if (s.memberId ? !labels.member(s.memberId) : !labels.entity(s.businessEntityId as string)) return UNALLOCATED;
  }
  if (o.kind === 'member') {
    const m = labels.member(o.shares[0].memberId as string)!;
    return { key: `member:${o.shares[0].memberId}`, kind: 'personal', label: m.name || '(unnamed household member)', detail: memberRelationshipLabel(m.relationship) };
  }
  if (o.kind === 'entity') {
    const e = labels.entity(o.shares[0].businessEntityId as string)!;
    return { key: `entity:${o.shares[0].businessEntityId}`, kind: 'entity', label: e.name, detail: entityTypeDetail(e.entityType) };
  }
  return o.hasEntity ? { key: 'entity_shared', kind: 'entity_shared', label: ENTITY_SHARED_LABEL, detail: null } : { key: 'joint', kind: 'joint', label: JOINT_LABEL, detail: null };
}

const shareOwnerKey = (s: OwnerShare) => (s.memberId ? `member:${s.memberId}` : `entity:${s.businessEntityId}`);
function shareOwnerLabel(s: OwnerShare, labels: OwnerLabels): string {
  return s.memberId ? (labels.member(s.memberId)?.name ?? '(unknown member)') : (labels.entity(s.businessEntityId as string)?.name ?? '(unknown entity)');
}

// ---------------------------------------------------------------------------
// Breakup (pure)
// ---------------------------------------------------------------------------

export interface BreakupAccount {
  id: string;
  ownership: AccountOwnership;
}
export interface BreakupPosition {
  accountId: string;
  currencyCode: string;
  value: number;
}
export interface CurrencyTotal {
  currencyCode: string;
  totalValue: number;
  positionCount: number;
}
export interface OwnerAttributionRow {
  ownerKey: string;
  ownerLabel: string;
  valueByCurrency: { currencyCode: string; totalValue: number }[];
}
export interface OwnerClassRow {
  info: OwnerClassInfo;
  accountCount: number;
  positionCount: number;
  valueByCurrency: CurrencyTotal[];
  /** Joint and entity-shared classes: each owner's attributed part (split by basis points). Adds back to valueByCurrency exactly. */
  ownerAttribution: OwnerAttributionRow[] | null;
}
export interface OwnerBreakup {
  classes: OwnerClassRow[];
  consolidated: { label: string; note: string; accountCount: number; positionCount: number; valueByCurrency: CurrencyTotal[] };
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const KIND_ORDER: Record<OwnerClassKind, number> = { personal: 0, joint: 1, entity: 2, entity_shared: 3, unallocated: 4 };

function addCurrency(map: Map<string, CurrencyTotal>, currencyCode: string, value: number) {
  const e = map.get(currencyCode) ?? { currencyCode, totalValue: 0, positionCount: 0 };
  e.totalValue = round4(e.totalValue + value);
  e.positionCount += 1;
  map.set(currencyCode, e);
}
const sortedCurrencies = (m: Map<string, CurrencyTotal>) => [...m.values()].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));

/**
 * Groups positions by their account's owner class and adds the explicit
 * consolidated macro line. PURE and arithmetic-free beyond summing and the
 * basis-point attribution: no engine formula is touched.
 */
export function buildOwnerBreakup(accounts: readonly BreakupAccount[], positions: readonly BreakupPosition[], labels: OwnerLabels): OwnerBreakup {
  const ownershipByAccount = new Map(accounts.map((a) => [a.id, a.ownership] as const));
  interface Acc {
    info: OwnerClassInfo;
    accountIds: Set<string>;
    currencies: Map<string, CurrencyTotal>;
    attribution: Map<string, { label: string; byCurrency: Map<string, number> }>;
  }
  const byClass = new Map<string, Acc>();
  const consolidatedCurrencies = new Map<string, CurrencyTotal>();
  const consolidatedAccounts = new Set<string>();

  const ensure = (info: OwnerClassInfo): Acc => {
    let a = byClass.get(info.key);
    if (!a) {
      a = { info, accountIds: new Set(), currencies: new Map(), attribution: new Map() };
      byClass.set(info.key, a);
    }
    return a;
  };

  for (const a of accounts) {
    // an account with no position still appears in its class's account count
    const info = classifyOwnership(a.ownership, labels);
    ensure(info).accountIds.add(a.id);
  }
  for (const p of positions) {
    const ownership = ownershipByAccount.get(p.accountId) ?? ({ kind: 'unassigned' } as AccountOwnership);
    const info = classifyOwnership(ownership, labels);
    const acc = ensure(info);
    acc.accountIds.add(p.accountId);
    addCurrency(acc.currencies, p.currencyCode, p.value);
    addCurrency(consolidatedCurrencies, p.currencyCode, p.value);
    consolidatedAccounts.add(p.accountId);
    if ((info.kind === 'joint' || info.kind === 'entity_shared') && ownership.kind !== 'unassigned') {
      const split = attributeByBasisPoints(p.value, ownership.shares.map((s) => ({ key: shareOwnerKey(s), basisPoints: s.basisPoints })));
      if (split) {
        for (const part of split) {
          const share = ownership.shares.find((s) => shareOwnerKey(s) === part.key)!;
          const row = acc.attribution.get(part.key) ?? { label: shareOwnerLabel(share, labels), byCurrency: new Map<string, number>() };
          row.byCurrency.set(p.currencyCode, round4((row.byCurrency.get(p.currencyCode) ?? 0) + part.amount));
          acc.attribution.set(part.key, row);
        }
      }
    }
  }

  const classes: OwnerClassRow[] = [...byClass.values()]
    .map<OwnerClassRow>((a) => ({
      info: a.info,
      accountCount: a.accountIds.size,
      positionCount: [...a.currencies.values()].reduce((s, c) => s + c.positionCount, 0),
      valueByCurrency: sortedCurrencies(a.currencies),
      ownerAttribution: a.attribution.size
        ? [...a.attribution.entries()]
            .map(([ownerKey, v]) => ({ ownerKey, ownerLabel: v.label, valueByCurrency: [...v.byCurrency.entries()].map(([currencyCode, totalValue]) => ({ currencyCode, totalValue })).sort((x, y) => x.currencyCode.localeCompare(y.currencyCode)) }))
            .sort((x, y) => x.ownerLabel.localeCompare(y.ownerLabel))
        : null,
    }))
    .sort((x, y) => KIND_ORDER[x.info.kind] - KIND_ORDER[y.info.kind] || x.info.label.localeCompare(y.info.label));

  return {
    classes,
    consolidated: {
      label: CONSOLIDATED_LABEL,
      note: CONSOLIDATED_NOTE,
      accountCount: consolidatedAccounts.size,
      positionCount: [...consolidatedCurrencies.values()].reduce((s, c) => s + c.positionCount, 0),
      valueByCurrency: sortedCurrencies(consolidatedCurrencies),
    },
  };
}

// ---------------------------------------------------------------------------
// Loader (I/O)
// ---------------------------------------------------------------------------

export interface OwnerClassContext {
  accounts: BreakupAccount[];
  labels: OwnerLabels;
  /** class key -> account ids, for every class that has at least one account. */
  accountIdsByClass: Map<string, string[]>;
  classes: OwnerClassInfo[];
}

/** The owner classes of every account this user has. Every query is filtered by user_id. */
export async function loadOwnerClassContext(supabase: SupabaseClient, userId: string): Promise<OwnerClassContext> {
  const accountRows = await fetchAllRows<{ id: string; owner_member_id: string | null }>(() => supabase.from('ii_accounts').select('id, owner_member_id').eq('user_id', userId).order('id', { ascending: true }));
  // `ii_ownership_allocation` may not exist in every environment: then there are simply no entity / joint owners.
  let allocRows: (ActiveAllocationRow & { ii_account_id: string })[] = [];
  try {
    allocRows = await fetchAllRows<ActiveAllocationRow & { ii_account_id: string }>(() =>
      supabase.from('ii_ownership_allocation').select('ii_account_id, owner_member_id, owner_business_entity_id, allocation_basis_points, ii_instrument_id, status').eq('user_id', userId).eq('status', 'active').order('id', { ascending: true })
    );
  } catch {
    allocRows = [];
  }
  const memberRows = await fetchAllRows<{ id: string; full_name: string; relationship: string }>(() => supabase.from('household_members').select('id, full_name, relationship').eq('user_id', userId).order('id', { ascending: true }));
  const entityRows = await fetchAllRows<{ id: string; name: string; entity_type: string }>(() => supabase.from('business_entities').select('id, name, entity_type').eq('user_id', userId).order('id', { ascending: true }));

  const members = new Map(memberRows.map((m) => [m.id, { name: m.full_name, relationship: m.relationship }] as const));
  const entities = new Map(entityRows.map((e) => [e.id, { name: e.name, entityType: e.entity_type }] as const));
  const labels: OwnerLabels = { member: (id) => members.get(id), entity: (id) => entities.get(id) };

  const allocByAccount = new Map<string, ActiveAllocationRow[]>();
  for (const r of allocRows) allocByAccount.set(r.ii_account_id, [...(allocByAccount.get(r.ii_account_id) ?? []), r]);

  const accounts: BreakupAccount[] = accountRows.map((a) => ({ id: a.id, ownership: deriveAccountOwnership(a.owner_member_id, allocByAccount.get(a.id) ?? []) }));
  const accountIdsByClass = new Map<string, string[]>();
  const classInfo = new Map<string, OwnerClassInfo>();
  for (const a of accounts) {
    const info = classifyOwnership(a.ownership, labels);
    classInfo.set(info.key, info);
    accountIdsByClass.set(info.key, [...(accountIdsByClass.get(info.key) ?? []), a.id]);
  }
  const classes = [...classInfo.values()].sort((x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || x.label.localeCompare(y.label));
  return { accounts, labels, accountIdsByClass, classes };
}

/** Accounts that are NOT owned (even partly) by a trust / HUF / company: the scope of the personal report chapters. Unallocated accounts stay in (never hidden). */
export function nonEntityScopeAccountIds(ctx: OwnerClassContext): string[] {
  const out: string[] = [];
  for (const info of ctx.classes) if (info.kind !== 'entity' && info.kind !== 'entity_shared') out.push(...(ctx.accountIdsByClass.get(info.key) ?? []));
  return out;
}

/** The set of account ids behind the personal reporting scope: sole members and members-only joint splits. Entity-involved accounts are excluded. */
export function personalScopeAccountIds(ctx: OwnerClassContext): string[] {
  const out: string[] = [];
  for (const info of ctx.classes) if (info.kind === 'personal' || info.kind === 'joint') out.push(...(ctx.accountIdsByClass.get(info.key) ?? []));
  return out;
}

// ---------------------------------------------------------------------------
// Scoped (read-only) client
// ---------------------------------------------------------------------------

/** Tables whose rows belong to ONE account, and the column that says which. Other tables pass through untouched. */
export const ACCOUNT_SCOPED_TABLES: Readonly<Record<string, string>> = {
  ii_transactions: 'account_id',
  ii_holding_snapshots: 'account_id',
  ii_portfolio_truth_status: 'account_id',
  ii_fhip_publications: 'account_id',
  ii_tax_lots: 'account_id',
  ii_accounts: 'id',
};

const NEVER_MATCHES = '00000000-0000-0000-0000-000000000000';

/**
 * A READ-ONLY view of a Supabase client in which every account-scoped table is
 * narrowed to `accountIds`. The certified engines and their loaders run on it
 * UNCHANGED: they simply receive fewer rows (the owner class's own), so no formula
 * is altered. Writes throw: a scoped run must never persist a per-class result over
 * the consolidated one.
 */
export function scopeClientToAccounts<C extends { from: (table: string) => unknown }>(client: C, accountIds: readonly string[]): C {
  const ids = accountIds.length > 0 ? [...accountIds] : [NEVER_MATCHES];
  const scoped = {
    from(table: string) {
      const column = ACCOUNT_SCOPED_TABLES[table];
      const builder = client.from(table) as Record<string, unknown>;
      return new Proxy(builder, {
        get(target, prop, receiver) {
          if (prop === 'select') {
            return (...args: unknown[]) => {
              const q = (target.select as (...a: unknown[]) => Record<string, unknown>).apply(target, args);
              return column ? (q.in as (c: string, v: unknown[]) => unknown).call(q, column, ids) : q;
            };
          }
          if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') {
            return () => {
              throw new Error('Owner-class scoped client is read-only');
            };
          }
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
    },
  };
  return scoped as unknown as C;
}

// ---------------------------------------------------------------------------
// Breakup loader (positions = latest snapshot per (account, instrument), the SAME definition the Overview uses)
// ---------------------------------------------------------------------------

export async function loadOwnerBreakup(supabase: SupabaseClient, userId: string): Promise<OwnerBreakup> {
  const ctx = await loadOwnerClassContext(supabase, userId);
  const snapshots = await fetchAllRows<{ account_id: string; instrument_id: string; as_of_date: string; value: number | string | null; currency_code: string }>(() =>
    supabase.from('ii_holding_snapshots').select('account_id, instrument_id, as_of_date, value, currency_code').eq('user_id', userId).order('as_of_date', { ascending: false }).order('id', { ascending: true })
  );
  const latest = new Map<string, (typeof snapshots)[number]>();
  for (const row of snapshots) {
    const key = `${row.account_id}:${row.instrument_id}`;
    const cur = latest.get(key);
    // newest as_of_date wins; on a tie the first row (the query's own deterministic order) is kept
    if (!cur || row.as_of_date > cur.as_of_date) latest.set(key, row);
  }
  const positions: BreakupPosition[] = [...latest.values()].map((s) => ({ accountId: s.account_id, currencyCode: s.currency_code, value: Number(s.value ?? 0) }));
  return buildOwnerBreakup(ctx.accounts, positions, ctx.labels);
}
