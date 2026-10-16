import { createClient } from '@/lib/supabase/server';
import { loadDashboardContext, type SupabaseServerClient } from '@/lib/services/dashboardData';
import { loadBusinessEntitiesForValuation } from '@/lib/services/businessEntityData';
import { loadNetWorthLevels } from '@/lib/services/netWorthLevelsData';
import { netWorthHeadline } from '@/components/dashboard/netWorthHeadline';
import { bucketAssetClass } from '@/lib/engines/dashboard';
import type { NetWorthRowInput } from '@/lib/engines/netWorthLevels';
import {
  buildNetWorthStatements,
  type AssetGroupKey,
  type NetWorthStatementSet,
  type StatementSourceRow,
} from '@/lib/engines/netWorthStatement';

/**
 * Loader for the Net Worth Statements (PO request 16-10-2026). It adds NO figure and NO query of its own for the
 * totals: it takes the Dashboard's own context (the same canonical snapshot and the same summary.netWorthLevels the
 * Dashboard and the Monthly Report read) and only ADDS the row detail needed to itemise them:
 *
 *   - the register lines, from the canonical snapshot (names, owner tag, native + reporting amounts);
 *   - which SMSF-linked loans are already inside a fund's balance, from the model's own rows (loadNetWorthLevels
 *     `collect`), so the itemised lines and the model can never classify a loan differently;
 *   - the holder's display name (user_profiles.full_name) and the registered entities whose value was never entered.
 *
 * It then re-derives the model once from those rows and compares it with the Dashboard's object. A difference is
 * reported through `parity`, never hidden and never "fixed" by editing a figure.
 */

export type NetWorthStatementData =
  | { status: 'ok'; set: NetWorthStatementSet }
  | { status: 'unavailable'; reason: string };

function assetGroupOf(assetClass: string | null, masterItemKey: string | null, name: string): AssetGroupKey {
  const bucket = bucketAssetClass(assetClass ?? 'other', masterItemKey, name);
  return bucket === 'property' ? 'property' : bucket === 'cash' ? 'cash' : 'other';
}

export async function loadNetWorthStatementData(userId: string, client?: SupabaseServerClient): Promise<NetWorthStatementData> {
  let ctx: Awaited<ReturnType<typeof loadDashboardContext>>;
  try {
    ctx = await loadDashboardContext(userId, client);
  } catch {
    // The Dashboard's own load failed (a register query error): say so, never show a statement with a hole in it.
    return { status: 'unavailable', reason: 'The registers could not be read.' };
  }
  const { snapshot, summary } = ctx;
  const levels = summary.netWorthLevels ?? null;
  if (snapshot.status !== 'ok') return { status: 'unavailable', reason: 'The financial snapshot could not be read.' };
  if (!levels) return { status: 'unavailable', reason: 'The net worth levels could not be built from the registers.' };
  if (snapshot.assets.status !== 'ok' || snapshot.investments.status !== 'ok' || snapshot.retirement.status !== 'ok' || snapshot.liabilities.status !== 'ok') {
    return { status: 'unavailable', reason: 'A register could not be read, so the statement is not shown rather than shown with a gap.' };
  }

  // The supabase client the Dashboard used: reuse the same server client for the supplementary reads.
  const supabase = client ?? (await createClient());

  const entitiesResult = await loadBusinessEntitiesForValuation(userId, supabase);
  const businessEntities = entitiesResult.error || !entitiesResult.data ? null : entitiesResult.data;
  const collect: { rows?: NetWorthRowInput[] } = {};
  const recomputed = await loadNetWorthLevels({ userId, supabase, snapshot, businessEntities, previouslyReported: summary.netWorth, collect });
  const modelRows = collect.rows ?? [];

  const lineById = new Map<string, { native: number; currency: string; group: AssetGroupKey | null }>();
  for (const l of snapshot.assets.lines) lineById.set(`assets:${l.id}`, { native: l.value.amountNative, currency: l.value.currency, group: assetGroupOf(l.assetClass, l.masterItemKey, l.name) });
  for (const l of snapshot.investments.lines) lineById.set(`investments:${l.id}`, { native: l.value.amountNative, currency: l.value.currency, group: 'investments' });
  for (const l of snapshot.retirement.lines) lineById.set(`retirement:${l.id}`, { native: l.balance.amountNative, currency: l.balance.currency, group: 'retirement' });
  for (const l of snapshot.liabilities.lines) lineById.set(`liabilities:${l.id}`, { native: l.balance.amountNative, currency: l.balance.currency, group: null });

  const rows: StatementSourceRow[] = modelRows.map((r) => {
    const line = lineById.get(`${r.register}:${r.id}`);
    return {
      id: `${r.register}:${r.id}`,
      register: r.register,
      name: r.name,
      owner: r.owner,
      amountReporting: r.amountReporting,
      nativeAmount: line && Number.isFinite(line.native) ? line.native : null,
      nativeCurrency: line?.currency ?? r.currencyCode ?? null,
      group: line?.group ?? null,
      smsfLinkedLoan: r.smsfLinkedLoan,
      nettedInFundBalance: r.nettedInFundBalance,
    };
  });

  let holderName: string | null = null;
  try {
    const { data } = await supabase.from('user_profiles').select('full_name').eq('user_id', userId).maybeSingle();
    holderName = (data as { full_name?: string | null } | null)?.full_name?.trim() || null;
  } catch {
    holderName = null;
  }

  const registryValueNotProvided = (businessEntities ?? [])
    .filter((e) => e.entity.is_active && e.entity.valuation_mode === 'summary' && (e.entity.summary_net_asset_value === null || e.entity.summary_net_asset_value === undefined))
    .map((e) => `entity:${e.entity.id}`);

  const unpublished = snapshot.investments.unpublished;
  const headline = netWorthHeadline(summary);
  const currency = snapshot.fx.reportingCurrency;

  const set = buildNetWorthStatements({
    levels,
    currency,
    asAt: snapshot.window.asOf,
    rows,
    holderName,
    fx: { fxRateAudInr: snapshot.fx.fxRateAudInr, rateSource: snapshot.fx.rateSource },
    importedNotInNetWorth: unpublished.count > 0 ? { count: unpublished.count, amount: unpublished.total } : null,
    registryValueNotProvided,
    dashboardHeadline: { label: headline.label, value: headline.value },
  });

  // The model was derived twice (the Dashboard's, and from the rows used to itemise). They must be identical.
  if (!recomputed || recomputed.family.net !== levels.family.net || recomputed.personal.total.net !== levels.personal.total.net) {
    set.parity.ok = false;
    set.parity.messages.push('The itemised rows do not reproduce the Dashboard’s net worth figures.');
  }
  return { status: 'ok', set };
}
