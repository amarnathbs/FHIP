/**
 * FDH-11 bridge — "Add to Net Worth" for an applied AU broker statement
 * (canonical-upload WP-12, INV-G1 / DC-08, PO D-05).
 *
 * THE GAP. Apply wrote ii_holding_snapshots / ii_transactions and stopped:
 * nothing certified the positions and nothing published them into
 * `investments` -- the one table the Investments tab, Dashboard, Net Worth,
 * Forecast, Twin and Report read. The panel's "Review and publish" link went to
 * a page that cannot list FDH-11 positions.
 *
 * THE DESIGN. No parallel portfolio and no second publisher. This module only
 * decides WHICH positions a statement produced and hands each one to
 * Investment Intelligence's own `buildPreview` / `publishPosition` /
 * `refreshPosition` (investmentPublicationService.ts) -- the same service, the
 * same eligibility gate, the same duplicate-review gate and the same
 * compensating writes the India CAS path uses. The user confirms each holding
 * explicitly inside the AU import panel (D-05); until then the canonical
 * Investments read model reports it in the "Imported, not yet in Net Worth"
 * bucket and never in the Net Worth total.
 *
 * Every read is user-scoped; every snapshot a request names must belong to the
 * statement the request names (a client cannot publish an arbitrary snapshot
 * through this door).
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { buildPreview, publishPosition, refreshPosition } from '@/lib/services/investment-intelligence/investmentPublicationService';
import type { IiDuplicateCandidate, IiEligibilityResult } from '@/lib/services/investment-intelligence/types';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';
import { certifyAuPosition } from './certifyAuPosition';

export interface AuPublishCandidate {
  snapshotId: string;
  accountId: string;
  instrumentId: string;
  instrumentName: string;
  asOfDate: string;
  value: number;
  currencyCode: string;
  certificationStatus: string | null;
  eligibility: IiEligibilityResult | null;
  duplicateCandidates: IiDuplicateCandidate[];
  /** This exact snapshot already counts in Net Worth. */
  published: boolean;
  /** An older snapshot of the same holding is published; confirming refreshes it. */
  refreshesExisting: boolean;
  error: string | null;
}

interface SnapshotRow {
  id: string;
  account_id: string;
  instrument_id: string;
  as_of_date: string;
  value: number;
  currency_code: string;
  created_at: string | null;
}

/** The (account, instrument) holdings a statement's APPLIED positions produced, each at its latest snapshot. */
async function statementHoldings(userId: string, statementId: string): Promise<SnapshotRow[]> {
  const admin = createAdminClient();
  const { data: statement } = await admin.from('fdh_investment_statements').select('id').eq('id', statementId).eq('user_id', userId).maybeSingle();
  if (!statement) return [];
  const applied = await fetchAllRows<{ id: string; canonical_holding_snapshot_id: string | null }>(() =>
    admin
      .from('fdh_investment_statement_positions')
      .select('id, canonical_holding_snapshot_id')
      .eq('user_id', userId)
      .eq('statement_id', statementId)
      .eq('apply_status', 'applied')
      .order('id', { ascending: true }),
  );
  const snapshotIds = [...new Set(applied.map((p) => p.canonical_holding_snapshot_id).filter((v): v is string => Boolean(v)))];
  if (snapshotIds.length === 0) return [];
  const own: SnapshotRow[] = [];
  for (let i = 0; i < snapshotIds.length; i += 200) {
    const { data, error } = await admin
      .from('ii_holding_snapshots')
      .select('id, account_id, instrument_id, as_of_date, value, currency_code, created_at')
      .eq('user_id', userId)
      .in('id', snapshotIds.slice(i, i + 200));
    if (error) throw new Error(error.message);
    own.push(...((data ?? []) as SnapshotRow[]));
  }
  // The holding is published at its LATEST snapshot (a later statement may
  // already have superseded this one's).
  const out: SnapshotRow[] = [];
  const seen = new Set<string>();
  for (const s of own) {
    const key = `${s.account_id}|${s.instrument_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { data: latest } = await admin
      .from('ii_holding_snapshots')
      .select('id, account_id, instrument_id, as_of_date, value, currency_code, created_at')
      .eq('user_id', userId)
      .eq('account_id', s.account_id)
      .eq('instrument_id', s.instrument_id)
      .order('as_of_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    out.push((latest as SnapshotRow | null) ?? s);
  }
  return out.sort((a, b) => (a.account_id + a.instrument_id < b.account_id + b.instrument_id ? -1 : 1));
}

async function instrumentNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const admin = createAdminClient();
  const { data } = await admin.from('ii_instruments').select('id, instrument_name').in('id', ids);
  return new Map(((data ?? []) as { id: string; instrument_name: string }[]).map((r) => [r.id, r.instrument_name]));
}

/**
 * Certifies (re-evaluates) and previews every holding the statement produced.
 * Certification runs first so an owner the user just recorded is taken into
 * account; it is idempotent and writes only Portfolio Truth status.
 */
export async function previewAuStatementPublication(userId: string, statementId: string): Promise<AuPublishCandidate[]> {
  const holdings = await statementHoldings(userId, statementId);
  const names = await instrumentNames([...new Set(holdings.map((h) => h.instrument_id))]);
  const out: AuPublishCandidate[] = [];
  for (const h of holdings) {
    const cert = await certifyAuPosition(userId, h.account_id, h.instrument_id);
    const { preview, error } = await buildPreview(userId, h.id);
    const covers = await publicationCoversSnapshot(userId, preview?.alreadyPublished?.publicationId ?? null, h.id);
    out.push({
      snapshotId: h.id,
      accountId: h.account_id,
      instrumentId: h.instrument_id,
      instrumentName: names.get(h.instrument_id) ?? 'Holding',
      asOfDate: h.as_of_date,
      value: Number(h.value),
      currencyCode: h.currency_code,
      certificationStatus: cert.status,
      eligibility: preview?.eligibility ?? null,
      duplicateCandidates: preview?.duplicateCandidates ?? [],
      published: Boolean(preview?.alreadyPublished) && covers,
      refreshesExisting: Boolean(preview?.alreadyPublished) && !covers,
      error: error ?? cert.error,
    });
  }
  return out;
}

async function publicationCoversSnapshot(userId: string, publicationId: string | null, snapshotId: string): Promise<boolean> {
  if (!publicationId) return false;
  const admin = createAdminClient();
  const { data } = await admin.from('ii_fhip_publications').select('canonical_position_id').eq('id', publicationId).eq('user_id', userId).maybeSingle();
  return data?.canonical_position_id === snapshotId;
}

export interface AuPublishDecision {
  snapshotId: string;
  /** The user confirmed this holding IS this manual investments row (replace + link). */
  linkToExistingInvestmentId?: string | null;
  /** The user reviewed the possible duplicates and says none of them is this holding. */
  acknowledgedNoDuplicate?: boolean;
}

export interface AuPublishOutcome {
  snapshotId: string;
  ok: boolean;
  action: string | null;
  errorCode: string | null;
  error: string | null;
}

/**
 * Publishes the holdings the user confirmed. Only snapshots that belong to this
 * statement are accepted; anything else is refused per row, never published.
 */
export async function publishAuStatementPositions(userId: string, statementId: string, decisions: readonly AuPublishDecision[]): Promise<AuPublishOutcome[]> {
  const holdings = await statementHoldings(userId, statementId);
  const allowed = new Map(holdings.map((h) => [h.id, h] as const));
  const out: AuPublishOutcome[] = [];
  for (const d of decisions) {
    const h = allowed.get(d.snapshotId);
    if (!h) {
      out.push({ snapshotId: d.snapshotId, ok: false, action: null, errorCode: 'NOT_ON_THIS_STATEMENT', error: 'This holding does not belong to this statement.' });
      continue;
    }
    await certifyAuPosition(userId, h.account_id, h.instrument_id);
    const { preview } = await buildPreview(userId, h.id);
    if (preview?.alreadyPublished && !(await publicationCoversSnapshot(userId, preview.alreadyPublished.publicationId, h.id))) {
      const refreshed = await refreshPosition(userId, h.id);
      out.push({ snapshotId: h.id, ok: !refreshed.error, action: refreshed.decision ?? 'REFRESH', errorCode: refreshed.error ? 'REFRESH_FAILED' : null, error: refreshed.error });
      continue;
    }
    const result = await publishPosition(userId, h.id, {
      linkToExistingInvestmentId: d.linkToExistingInvestmentId ?? null,
      acknowledgedNoDuplicate: d.acknowledgedNoDuplicate ?? false,
      correlationId: `fdh11:${statementId}`,
    });
    out.push({ snapshotId: h.id, ok: !result.error, action: result.action, errorCode: result.errorCode ?? null, error: result.error });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Investments-tab "Imported statements" history (INV-G9, PO D-05).
// ---------------------------------------------------------------------------

export interface ImportedAuStatementSummary {
  statementId: string;
  documentId: string | null;
  institutionName: string | null;
  statementType: string;
  statementDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  importedAt: string;
  approvalStatus: string;
  reconciliationStatus: string;
  cashBalance: number | null;
  closingPortfolioValue: number | null;
  warnings: { code: string; count: number; rowsDropped: boolean }[];
  counts: { holdings: number; transactions: number; applied: number; skipped: number; waiting: number };
  skipped: { line: string; reason: string }[];
  holdings: { name: string; asOfDate: string | null; value: number | null; currencyCode: string; applyStatus: string; inNetWorth: boolean }[];
}

/** Every AU statement the user imported, newest first, with its outcome per line. */
export async function listImportedAuStatements(userId: string, limit = 25): Promise<ImportedAuStatementSummary[]> {
  const admin = createAdminClient();
  const { data: statements, error } = await admin
    .from('fdh_investment_statements')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (statements ?? []) as Record<string, unknown>[];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id as string);

  const positions = await fetchAllRows<Record<string, unknown>>(() =>
    admin
      .from('fdh_investment_statement_positions')
      .select('id, statement_id, security_name_raw, ticker_raw, valuation_date, market_value, currency_code, apply_status, apply_rejected_reason, canonical_holding_snapshot_id, matched_instrument_id')
      .eq('user_id', userId)
      .in('statement_id', ids)
      .order('id', { ascending: true }),
  );
  const activities = await fetchAllRows<Record<string, unknown>>(() =>
    admin
      .from('fdh_investment_statement_activities')
      .select('id, statement_id, activity_type, trade_date, amount, apply_status, apply_rejected_reason')
      .eq('user_id', userId)
      .in('statement_id', ids)
      .order('id', { ascending: true }),
  );

  // Which applied holdings count in Net Worth: an active investments row for
  // the (account, instrument) pair -- the same test the Investments read model
  // uses for its "Imported, not yet in Net Worth" bucket.
  const { data: published } = await admin
    .from('investments')
    .select('ii_canonical_account_id, ii_canonical_instrument_id')
    .eq('user_id', userId)
    .eq('is_active', true)
    .not('ii_canonical_account_id', 'is', null);
  const publishedPairs = new Set(((published ?? []) as { ii_canonical_account_id: string; ii_canonical_instrument_id: string }[]).map((p) => `${p.ii_canonical_account_id}|${p.ii_canonical_instrument_id}`));

  return rows.map((s) => {
    const sid = s.id as string;
    const pos = positions.filter((p) => p.statement_id === sid);
    const act = activities.filter((a) => a.statement_id === sid);
    const all = [...pos, ...act];
    const accountId = (s.canonical_account_id as string | null) ?? null;
    const warnings = Array.isArray(s.extraction_warnings) ? (s.extraction_warnings as { code: string; count: number; rowsDropped?: boolean }[]) : [];
    return {
      statementId: sid,
      documentId: (s.statement_upload_id as string | null) ?? null,
      institutionName: (s.institution_name as string | null) ?? null,
      statementType: s.statement_type as string,
      statementDate: (s.statement_date as string | null) ?? null,
      periodStart: (s.statement_start_date as string | null) ?? null,
      periodEnd: (s.statement_end_date as string | null) ?? null,
      importedAt: s.created_at as string,
      approvalStatus: s.approval_status as string,
      reconciliationStatus: s.reconciliation_status as string,
      cashBalance: s.cash_balance === null || s.cash_balance === undefined ? null : Number(s.cash_balance),
      closingPortfolioValue: s.closing_portfolio_value === null || s.closing_portfolio_value === undefined ? null : Number(s.closing_portfolio_value),
      warnings: warnings.map((w) => ({ code: w.code, count: Number(w.count ?? 0), rowsDropped: Boolean(w.rowsDropped) })),
      counts: {
        holdings: pos.length,
        transactions: act.length,
        applied: all.filter((r) => r.apply_status === 'applied').length,
        skipped: all.filter((r) => r.apply_status === 'skipped').length,
        waiting: all.filter((r) => r.apply_status === 'pending' || r.apply_status === 'not_applicable').length,
      },
      skipped: [
        ...pos.filter((p) => p.apply_status === 'skipped').map((p) => ({ line: String(p.security_name_raw ?? 'Holding'), reason: String(p.apply_rejected_reason ?? 'Not added.') })),
        ...act.filter((a) => a.apply_status === 'skipped').map((a) => ({ line: `${a.trade_date ?? ''} ${a.activity_type} ${a.amount}`.trim(), reason: String(a.apply_rejected_reason ?? 'Not added.') })),
      ],
      holdings: pos.map((p) => ({
        name: String(p.security_name_raw ?? 'Holding'),
        asOfDate: (p.valuation_date as string | null) ?? null,
        value: p.market_value === null || p.market_value === undefined ? null : Number(p.market_value),
        currencyCode: String(p.currency_code ?? 'AUD'),
        applyStatus: String(p.apply_status),
        inNetWorth: Boolean(accountId && p.matched_instrument_id && p.apply_status === 'applied' && publishedPairs.has(`${accountId}|${p.matched_instrument_id as string}`)),
      })),
    };
  });
}
