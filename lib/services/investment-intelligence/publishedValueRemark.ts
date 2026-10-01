// Investment Intelligence — Net Worth "current NAV" re-mark: the I/O half.
// PO decision 2026-10-01: Dashboard Net Worth uses the CURRENT (latest
// eligible) NAV for current mutual-fund holdings. The decision logic is pure
// and lives in lib/engines/investment-intelligence/valuation/publishedRowRemark.ts
// (which delegates the NAV rule itself to the shared currentHoldingValuation.ts).
// This file only reads the evidence, hands it to that planner, and applies the
// plan.
//
// MECHANISM (chosen over a read-time overlay and over a scheduled job; see
// docs/investment-intelligence/NETWORTH_NAV_REMARK_REPORT.md section 3):
//   * The canonical `investments` row a publication owns is the ONE place every
//     reader (Dashboard Net Worth, Goals, Reports, Forecast, the Investments
//     grid) already takes the value from, so its `current_value` is kept equal
//     to the shared rule's output. No reader needs to know about NAVs, so none
//     can forget to apply one.
//   * The publication row (ii_fhip_publications.published_value) is NEVER
//     touched: it stays the immutable record of the certified statement value.
//   * This function never inserts an `investments` row. It updates, in place,
//     the one row a published publication already names (published_row_id), so
//     the "exactly once" guarantee cannot be affected by a re-mark.
//   * Manual rows are never read here: the query is restricted to
//     source_type = 'investment_intelligence_published'.
//   * Entity-owned accounts (Trust / HUF / Company) are skipped, fail-closed: if
//     ownership cannot be read, nothing is written.
//   * Idempotent: unchanged inputs (same fingerprint and same stored value) do
//     no write and no revision row. Concurrent calls are safe: the write is
//     compare-and-set on the previous fingerprint, and only the call whose
//     update actually landed records the revision.
//   * Every landed change appends one row to ii_investment_value_revisions
//     (service-role insert, like ii_audit_events), so the history of what Net
//     Worth used, and why it moved, is queryable.
//
// Reads are batched per call: investments, publications, snapshots,
// instruments, entity allocations, NAV candidates -- a fixed number of queries,
// never one per holding.

import { createAdminClient } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { NavObservationRow } from '@/lib/engines/investment-intelligence/valuation/currentHoldingValuation';
import { planRowRemark, REMARK_RULE_VERSION, type RemarkRowInput, type RemarkSkipReason } from '@/lib/engines/investment-intelligence/valuation/publishedRowRemark';
import { fetchAllRows } from './pagination';
import { loadNavCandidatesSince, todayIsoDate } from './currentValuationLoader';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = { from(table: string): any };

export type RemarkTrigger = 'dashboard_read' | 'investments_read' | 'report_read' | 'publish' | 'refresh' | 'republish' | 'manual';

export interface RemarkRevisionRecord {
  user_id: string;
  investment_id: string;
  publication_id: string;
  instrument_id: string;
  reason: string;
  remark_trigger: RemarkTrigger;
  previous_value: number;
  new_value: number;
  previous_basis: string | null;
  new_basis: string;
  units: number;
  nav: number | null;
  value_as_of: string | null;
  statement_as_of: string | null;
  statement_value: number | null;
  fingerprint: string;
  rule_version: string;
}

/** Where revision rows go. Default: the service-role client (the table has no authenticated insert policy). */
export type RevisionWriter = (record: RemarkRevisionRecord) => Promise<{ error: string | null }>;

export const defaultRevisionWriter: RevisionWriter = async (record) => {
  const admin = createAdminClient();
  const { error } = await admin.from('ii_investment_value_revisions').insert(record);
  return { error: error?.message ?? null };
};

export interface RemarkSummary {
  considered: number;
  updated: number;
  unchanged: number;
  skipped: Partial<Record<RemarkSkipReason, number>>;
  /** Another call changed the row first (compare-and-set lost): nothing written by this call. */
  lostRace: number;
  /** The row was updated but its revision row could not be written (reported loudly, never swallowed). */
  revisionFailures: number;
  /** The write path is blocked for this client (read-only AI context): no write was attempted past the first. */
  readOnly: boolean;
  error: string | null;
}

function emptySummary(): RemarkSummary {
  return { considered: 0, updated: 0, unchanged: 0, skipped: {}, lostRace: 0, revisionFailures: 0, readOnly: false, error: null };
}

const ID_CHUNK = 100;
function chunk<T>(items: readonly T[], size = ID_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface InvestmentRowDb {
  id: string;
  current_value: number | string;
  currency_code: string;
  ii_publication_id: string | null;
  ii_value_as_of: string | null;
  ii_valuation_basis: string | null;
  ii_valuation_units: number | string | null;
  ii_valuation_nav: number | string | null;
  ii_valuation_fingerprint: string | null;
}
interface PublicationDb {
  id: string;
  published_row_id: string | null;
  canonical_position_id: string;
  account_id: string;
  instrument_id: string;
}
interface SnapshotDb {
  id: string;
  as_of_date: string;
  units: number | string;
  value: number | string;
  currency_code: string;
}

const numOrNull = (v: number | string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

function isReadOnlyBlock(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'M11_READONLY';
}

/**
 * Brings the canonical value of every published mutual-fund row of ONE user in
 * line with the shared latest-eligible-NAV rule. Never throws for data reasons:
 * a failed read is reported in `error` and nothing is written.
 */
export async function remarkPublishedInvestments(
  userId: string,
  opts: { client: Client; trigger: RemarkTrigger; asOfDate?: string; investmentIds?: readonly string[]; revisionWriter?: RevisionWriter }
): Promise<RemarkSummary> {
  const summary = emptySummary();
  const client = opts.client;
  const asOfDate = (opts.asOfDate ?? todayIsoDate()).slice(0, 10);
  const writeRevision = opts.revisionWriter ?? defaultRevisionWriter;

  try {
    // 1. The published register rows. One query; for a household with no II
    //    positions this is the only query that runs.
    const rows = await fetchAllRows<InvestmentRowDb>(() => {
      let q = client
        .from('investments')
        .select('id, current_value, currency_code, ii_publication_id, ii_value_as_of, ii_valuation_basis, ii_valuation_units, ii_valuation_nav, ii_valuation_fingerprint')
        .eq('user_id', userId)
        .eq('is_active', true)
        .eq('source_type', 'investment_intelligence_published');
      if (opts.investmentIds && opts.investmentIds.length > 0) q = q.in('id', [...opts.investmentIds]);
      return q.order('id', { ascending: true });
    });
    summary.considered = rows.length;
    if (rows.length === 0) return summary;

    // 2. Their ACTIVE publications (the single source of "which certified position is this row").
    const rowIds = rows.map((r) => r.id);
    const publications: PublicationDb[] = [];
    for (const ids of chunk(rowIds)) {
      publications.push(
        ...(await fetchAllRows<PublicationDb>(() =>
          client
            .from('ii_fhip_publications')
            .select('id, published_row_id, canonical_position_id, account_id, instrument_id')
            .eq('user_id', userId)
            .eq('status', 'published')
            .eq('publication_target', 'investments')
            .in('published_row_id', ids)
            .order('id', { ascending: true })
        ))
      );
    }
    const publicationByRow = new Map<string, PublicationDb>();
    for (const p of publications) if (p.published_row_id) publicationByRow.set(p.published_row_id, p);

    const snapshotIds = [...new Set(publications.map((p) => p.canonical_position_id))];
    const instrumentIds = [...new Set(publications.map((p) => p.instrument_id))];
    const accountIds = [...new Set(publications.map((p) => p.account_id))];

    // 3. Certified snapshots, instrument classes and entity ownership, in parallel.
    const [snapshots, instruments, entityAccountIds] = await Promise.all([
      (async () => {
        const out: SnapshotDb[] = [];
        for (const ids of chunk(snapshotIds)) {
          out.push(
            ...(await fetchAllRows<SnapshotDb>(() =>
              client.from('ii_holding_snapshots').select('id, as_of_date, units, value, currency_code').eq('user_id', userId).in('id', ids).order('id', { ascending: true })
            ))
          );
        }
        return out;
      })(),
      (async () => {
        const out: { id: string; instrument_class: string }[] = [];
        for (const ids of chunk(instrumentIds)) {
          out.push(...(await fetchAllRows<{ id: string; instrument_class: string }>(() => client.from('ii_instruments').select('id, instrument_class').in('id', ids).order('id', { ascending: true }))));
        }
        return out;
      })(),
      // FAIL CLOSED: if entity ownership cannot be read, this throws and nothing is written.
      (async () => {
        const entity = new Set<string>();
        for (const ids of chunk(accountIds)) {
          const allocs = await fetchAllRows<{ ii_account_id: string; owner_business_entity_id: string | null }>(() =>
            client
              .from('ii_ownership_allocation')
              .select('id, ii_account_id, owner_business_entity_id')
              .eq('user_id', userId)
              .eq('status', 'active')
              .not('owner_business_entity_id', 'is', null)
              .in('ii_account_id', ids)
              .order('id', { ascending: true })
          );
          for (const a of allocs) entity.add(a.ii_account_id);
        }
        return entity;
      })(),
    ]);
    const snapshotById = new Map(snapshots.map((s) => [s.id, s] as const));
    const classById = new Map(instruments.map((i) => [i.id, i.instrument_class] as const));

    // 4. NAV candidates for all instruments at once. A NAV older than the oldest
    //    certified statement can never supersede one.
    let since: string | null = null;
    const inputs: { row: InvestmentRowDb; input: RemarkRowInput }[] = [];
    for (const row of rows) {
      const pub = publicationByRow.get(row.id);
      if (!pub) {
        // An active, II-sourced row with no active publication: not ours to re-mark.
        summary.skipped.no_certified_position = (summary.skipped.no_certified_position ?? 0) + 1;
        continue;
      }
      const snap = snapshotById.get(pub.canonical_position_id);
      const certified = snap ? { asOfDate: String(snap.as_of_date).slice(0, 10), units: Number(snap.units), value: Number(snap.value), currencyCode: snap.currency_code } : null;
      // The lower bound is the CERTIFIED statement date (not the last valuation
      // date): if the newest NAV later becomes ineligible, the next-best NAV
      // between the statement and then must still be among the candidates.
      if (certified && (since === null || certified.asOfDate < since)) since = certified.asOfDate;
      inputs.push({
        row,
        input: {
          investmentId: row.id,
          publicationId: pub.id,
          instrumentId: pub.instrument_id,
          accountId: pub.account_id,
          instrumentClass: classById.get(pub.instrument_id) ?? null,
          rowCurrency: row.currency_code,
          rowCurrentValue: Number(row.current_value),
          previous: {
            fingerprint: row.ii_valuation_fingerprint,
            basis: row.ii_valuation_basis,
            units: numOrNull(row.ii_valuation_units),
            nav: numOrNull(row.ii_valuation_nav),
            asOf: row.ii_value_as_of ? String(row.ii_value_as_of).slice(0, 10) : null,
          },
          entityOwned: entityAccountIds.has(pub.account_id),
          certified,
        },
      });
    }
    if (inputs.length === 0) return summary;

    const navInstrumentIds = [...new Set(inputs.filter((i) => i.input.instrumentClass === 'mutual_fund' && !i.input.entityOwned).map((i) => i.input.instrumentId))];
    const navsByInstrument = new Map<string, NavObservationRow[]>();
    for (const ids of chunk(navInstrumentIds)) {
      const part = await loadNavCandidatesSince(client as unknown as SupabaseClient, ids, since);
      for (const [k, v] of part) navsByInstrument.set(k, v);
    }

    // 5. Plan and apply. Each landed change is compare-and-set on the previous fingerprint.
    for (const { row, input } of inputs) {
      const plan = planRowRemark(input, navsByInstrument.get(input.instrumentId) ?? [], asOfDate);
      if (plan.action === 'skip') {
        summary.skipped[plan.reason] = (summary.skipped[plan.reason] ?? 0) + 1;
        continue;
      }
      if (plan.action === 'unchanged') {
        summary.unchanged += 1;
        continue;
      }
      if (summary.readOnly) continue;

      let update = client
        .from('investments')
        .update({ ...plan.columns, ii_valuation_remarked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', row.id)
        .eq('user_id', userId)
        .eq('source_type', 'investment_intelligence_published')
        .eq('is_active', true);
      update = row.ii_valuation_fingerprint === null ? update.is('ii_valuation_fingerprint', null) : update.eq('ii_valuation_fingerprint', row.ii_valuation_fingerprint);
      const { data: landed, error: updateError } = await update.select('id');
      if (updateError) {
        if (isReadOnlyBlock(updateError)) {
          summary.readOnly = true;
          continue;
        }
        summary.error = updateError.message ?? 'update failed';
        continue;
      }
      if (!landed || landed.length === 0) {
        summary.lostRace += 1;
        continue;
      }
      summary.updated += 1;

      const v = plan.valuation;
      const { error: revError } = await writeRevision({
        user_id: userId,
        investment_id: row.id,
        publication_id: input.publicationId,
        instrument_id: input.instrumentId,
        reason: plan.reason,
        remark_trigger: opts.trigger,
        previous_value: plan.previousValue,
        new_value: plan.newValue,
        previous_basis: input.previous.basis,
        new_basis: plan.columns.ii_valuation_basis,
        units: plan.columns.ii_valuation_units,
        nav: plan.columns.ii_valuation_nav,
        value_as_of: plan.columns.ii_value_as_of,
        statement_as_of: v.statementAsOfDate,
        statement_value: v.statementValue,
        fingerprint: plan.fingerprint,
        rule_version: REMARK_RULE_VERSION,
      });
      if (revError) {
        summary.revisionFailures += 1;
        console.error('[nav-remark] value updated but its revision row could not be written', { investmentId: row.id, message: revError });
      }
    }
    return summary;
  } catch (error) {
    summary.error = error instanceof Error ? error.message : 'remark failed';
    return summary;
  }
}

/**
 * Fail-soft entry for READ paths (Dashboard, Investments, reports). A re-mark
 * problem must never take a read offline: the row then simply keeps its last
 * labelled valuation, which carries its own as-of date. Never throws.
 */
export async function ensurePublishedValuesCurrent(userId: string, client: Client, trigger: RemarkTrigger, investmentIds?: readonly string[]): Promise<RemarkSummary> {
  try {
    const summary = await remarkPublishedInvestments(userId, { client, trigger, investmentIds });
    if (summary.error) console.error('[nav-remark] re-mark skipped for this read', { trigger, message: summary.error });
    return summary;
  } catch (error) {
    console.error('[nav-remark] unexpected failure', { trigger, message: error instanceof Error ? error.message : String(error) });
    return { ...emptySummary(), error: 'unexpected_failure' };
  }
}
