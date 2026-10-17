import type { SupabaseClient } from '@supabase/supabase-js';
import type { CanonicalFinancialSnapshotResult } from '@/lib/read-models/snapshot';
import type { BusinessEntityWithLineItems } from '@/lib/engines/businessEntityValuation';
import { loadSmsfBalanceSheets } from '@/lib/services/entityBalanceSheetData';
import {
  computeNetWorthLevels,
  toNetWorthEntityInput,
  type NetWorthEntityInput,
  type NetWorthJointShare,
  type NetWorthLevels,
  type NetWorthRole,
  type NetWorthRowInput,
} from '@/lib/engines/netWorthLevels';

/**
 * Loader for the two-level Net Worth model (PO decision 16-10-2026). It adds NO new figure of its own:
 * every amount is a canonical read-model line (already converted once at the household's single rate;
 * a row that cannot be converted arrives with amountReporting = null and is counted, never zeroed).
 *
 * Three small, fail-soft reads supplement the snapshot:
 *  - household_members: maps a stored joint split (by member) to Self / Spouse;
 *  - property_liability_links + smsf_funds: tells which SMSF-linked loans are already inside a fund's
 *    net balance (0084: the balance is a NET figure in both Summary and Detailed mode), so the loan is
 *    not deducted a second time.
 * A failed supplementary read never zeroes anything: the member map falls back to the default equal
 * split, and the loan netting falls back to "not netted" (the previously reported behaviour); both are
 * reported in dataStatus.unavailable.
 */

type Client = SupabaseClient;

const roleOfRelationship = (relationship: string | null | undefined): NetWorthRole =>
  relationship === 'self' ? 'self' : relationship === 'spouse' || relationship === 'partner' ? 'spouse' : 'other';

async function readAll<T>(factory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<{ data: T[]; failed: boolean }> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await factory(from, from + PAGE - 1);
    if (error) return { data: [], failed: true };
    const page = data ?? [];
    all.push(...page);
    if (page.length < PAGE) break;
  }
  return { data: all, failed: false };
}

export async function loadNetWorthLevels(args: {
  userId: string;
  supabase: Client;
  snapshot: CanonicalFinancialSnapshotResult;
  businessEntities: readonly BusinessEntityWithLineItems[] | null;
  /** Optional out-parameter: receives the exact rows the model was computed from (used by the Net Worth Statement to itemise). */
  collect?: { rows?: NetWorthRowInput[] };
  /** The Dashboard's history-basis net worth (all entities included), to prove the bridge. */
  previouslyReported: number;
  /** The Dashboard summary's personal-basis net worth (summary.netWorth), to prove personal parity. */
  personalSummaryNet?: number;
}): Promise<NetWorthLevels | null> {
  const { userId, supabase, snapshot } = args;
  if (snapshot.status !== 'ok') return null;
  const { assets, investments, retirement, liabilities } = snapshot;
  // A balance-sheet section the snapshot could not read means the levels cannot be proven: say nothing
  // rather than a figure with a hole in it. The Dashboard already reports the unavailable section.
  if (assets.status !== 'ok' || investments.status !== 'ok' || retirement.status !== 'ok' || liabilities.status !== 'ok') return null;

  const unavailable: { section: string; reason: string }[] = [];
  const currency = snapshot.fx.reportingCurrency;
  const fxRateAudInr = snapshot.fx.fxRateAudInr;

  // ---- members -> role (joint splits recorded per member) ----
  const members = await readAll<{ id: string; relationship: string | null }>((from, to) =>
    supabase.from('household_members').select('id, relationship').eq('user_id', userId).eq('is_active', true).range(from, to),
  );
  if (members.failed) unavailable.push({ section: 'household_members', reason: 'query_failed' });
  const roleByMember = new Map(members.data.map((m) => [m.id, roleOfRelationship(m.relationship)] as const));

  // ---- SMSF-linked loans already inside a fund's net balance ----
  const linkedIds = new Set(liabilities.lines.filter((l) => l.smsfPropertyLoanLinked).map((l) => l.id));
  const nettedLiabilityIds = new Set<string>();
  if (linkedIds.size > 0) {
    const [links, funds] = await Promise.all([
      readAll<{ liability_id: string; linked_retirement_id: string | null }>((from, to) =>
        supabase
          .from('property_liability_links')
          .select('liability_id, linked_retirement_id')
          .eq('user_id', userId)
          .eq('link_type', 'smsf_property_loan')
          .eq('is_active', true)
          .range(from, to),
      ),
      readAll<{ retirement_account_id: string }>((from, to) => supabase.from('smsf_funds').select('retirement_account_id').eq('user_id', userId).range(from, to)),
    ]);
    if (links.failed || funds.failed) {
      unavailable.push({ section: 'smsf_loan_links', reason: 'query_failed' });
    } else {
      const fundRetirementIds = new Set(funds.data.map((f) => f.retirement_account_id));
      const activeRetirementIds = new Set(retirement.lines.map((l) => l.id));
      for (const link of links.data) {
        if (link.linked_retirement_id && fundRetirementIds.has(link.linked_retirement_id) && activeRetirementIds.has(link.linked_retirement_id)) {
          nettedLiabilityIds.add(link.liability_id);
        }
      }
    }
  }

  const rows: NetWorthRowInput[] = [];
  for (const l of assets.lines) {
    rows.push({ id: l.id, register: 'assets', name: l.name, owner: l.owner, masterItemKey: l.masterItemKey, amountReporting: l.value.amountReporting, currencyCode: l.value.currency });
  }
  for (const l of investments.lines) {
    const shares: NetWorthJointShare[] | null =
      l.ownerShares && l.ownerShares.length > 0
        ? l.ownerShares.map((s) => ({ role: roleByMember.get(s.ownerMemberId) ?? ('other' as NetWorthRole), basisPoints: s.basisPoints }))
        : null;
    // A stored split that cannot be mapped to people (unknown member) is not guessed at: default split applies.
    const usable = shares && !members.failed && l.ownerShares!.every((s) => roleByMember.has(s.ownerMemberId)) ? shares : null;
    rows.push({ id: l.id, register: 'investments', name: l.name, owner: l.owner, amountReporting: l.value.amountReporting, currencyCode: l.value.currency, jointShares: usable });
  }
  for (const l of retirement.lines) {
    rows.push({ id: l.id, register: 'retirement', name: l.name, owner: l.owner, masterItemKey: l.masterItemKey, amountReporting: l.balance.amountReporting, currencyCode: l.balance.currency });
  }
  for (const l of liabilities.lines) {
    rows.push({
      id: l.id,
      register: 'liabilities',
      name: l.name,
      owner: l.owner,
      amountReporting: l.balance.amountReporting,
      currencyCode: l.balance.currency,
      smsfLinkedLoan: l.smsfPropertyLoanLinked,
      nettedInFundBalance: nettedLiabilityIds.has(l.id),
    });
  }

  if (args.collect) args.collect.rows = rows;

  const entities: NetWorthEntityInput[] = [];
  if (args.businessEntities === null) {
    unavailable.push({ section: 'business_entities', reason: 'query_failed' });
  } else {
    for (const e of args.businessEntities) {
      const input = toNetWorthEntityInput(e, currency, fxRateAudInr);
      if (input) entities.push(input);
    }
  }

  // An SMSF that records its own assets and liabilities (or a typed net) is read from that record; a failed read falls back to the register-row path and says so.
  const sheetResult = await loadSmsfBalanceSheets({ userId, supabase, snapshot });
  if (sheetResult.sheets === null) unavailable.push({ section: 'smsf_balance_sheet', reason: 'query_failed' });

  return computeNetWorthLevels({ currency, rows, entities, entitySheets: sheetResult.sheets ?? [], previouslyReported: args.previouslyReported, personalSummaryNet: args.personalSummaryNet, unavailable });
}

