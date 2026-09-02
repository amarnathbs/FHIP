import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { emitAuditEvent } from './audit';
import { computePortfolioAllocationSummary } from './portfolioAttribution';
import { computeGoalsPagePayload } from '@/lib/services/goalsData';
import { loadCurrentCapitalGainsComputations } from './taxRepository';
import {
  REVIEW_ENGINE_VERSION,
  detectUnallocatedInvestments,
  detectOverAllocation,
  detectGoalForecastGap,
  detectStaleValuation,
  detectOpenReconciliationCases,
  detectBenchmarkUnderperformance,
  detectSipInterruption,
  detectExitLoadExposure,
  detectTaxLotIncomplete,
  type ReviewItemCandidate,
  type RuleConfig,
} from '@/lib/engines/investment-intelligence/reviewCentre';
import type { IiReviewItem } from './types';

const PAGE_SIZE = 500;
async function fetchAllPages<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await build(from, to);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

async function loadActiveRules(db: SupabaseClient): Promise<Map<string, RuleConfig>> {
  const { data, error } = await db.from('ii_review_rule_registry').select('*').eq('is_active', true);
  if (error) throw new Error(error.message);
  const map = new Map<string, RuleConfig>();
  for (const r of data ?? []) {
    map.set(r.rule_key as string, {
      ruleKey: r.rule_key as string,
      ruleVersion: r.rule_version as string,
      reviewType: r.review_type as RuleConfig['reviewType'],
      category: r.category as string,
      defaultSeverity: r.default_severity as RuleConfig['defaultSeverity'],
      complianceClassification: r.compliance_classification as RuleConfig['complianceClassification'],
      thresholdConfig: (r.threshold_config as Record<string, unknown>) ?? {},
    });
  }
  return map;
}

// Runs every deterministic rule against freshly-fetched, already-certified
// data from each source module (spec sections 39, 60, 85 — cross-module
// certification) and upserts the results into ii_review_items with
// identity-key dedup (spec section 50). Never invents financial truth: each
// rule call site below reads exactly one canonical source
// (goals/publishing/R4/R5/R6/reconciliation) and passes it through, unedited,
// as the item's evidence (spec sections 129-131).
export async function runReviewCentreRefresh(userId: string): Promise<{ created: number; updated: number; superseded: number; error: string | null }> {
  const admin = createAdminClient();
  const asOfDate = new Date().toISOString().slice(0, 10);

  const rules = await loadActiveRules(admin);
  const candidates: ReviewItemCandidate[] = [];

  // 1 & 2 — allocation attribution (goals category), from investments + goal_funding_sources.
  const allocation = await computePortfolioAllocationSummary(userId, admin);
  const unallocatedRule = rules.get('unallocated_investment');
  if (unallocatedRule) candidates.push(...detectUnallocatedInvestments(userId, allocation.perInvestment, asOfDate, unallocatedRule));
  const overAllocRule = rules.get('goal_allocation_conflict') ?? rules.get('goal_allocation_incomplete');
  if (overAllocRule) candidates.push(...detectOverAllocation(userId, allocation.perInvestment, asOfDate, { ...overAllocRule, category: 'goal_allocation_conflict' }));

  // 3 — goal forecast gap: consumes the LIVE canonical Goals forecast
  // (lib/services/goalsData.ts computeGoalsPagePayload) — never recomputed here.
  const goalGapRule = rules.get('goal_forecast_gap');
  if (goalGapRule) {
    const { payload } = await computeGoalsPagePayload(userId, admin as unknown as Parameters<typeof computeGoalsPagePayload>[1]);
    const goalsWithFunding = payload.goals.map((g) => ({
      goalId: g.id,
      goalName: g.goalName,
      trackStatus: g.forecasts.base.trackStatus,
      fundingGapAtTargetDate: g.forecasts.base.fundingGapAtTargetDate,
      targetAmountFuture: g.forecasts.base.targetAmountFuture,
      projectedTargetDateValue: g.forecasts.base.projectedTargetDateValue,
      currencyCode: g.currencyCode,
      modelVersion: payload.modelVersion,
      forecastId: g.id,
      hasActiveFundingSource: (g.fundingSources ?? []).length > 0,
    }));
    candidates.push(...detectGoalForecastGap(userId, goalsWithFunding, asOfDate, goalGapRule));
  }

  // 4 — stale valuation, from investments' own ii_last_refreshed_at.
  const staleRule = rules.get('stale_valuation');
  if (staleRule) {
    const rows = await fetchAllPages<{ id: string; ii_last_refreshed_at: string | null; source_type: string }>((from, to) =>
      admin.from('investments').select('id, ii_last_refreshed_at, source_type').eq('user_id', userId).eq('is_active', true).order('id').range(from, to)
    );
    candidates.push(
      ...detectStaleValuation(
        userId,
        rows.map((r) => ({ investmentId: r.id, iiLastRefreshedAt: r.ii_last_refreshed_at, sourceType: r.source_type })),
        asOfDate,
        staleRule
      )
    );
  }

  // 5 — open reconciliation cases.
  const reconRule = rules.get('reconciliation_open');
  if (reconRule) {
    const rows = await fetchAllPages<{ id: string; subject_type: string; subject_id: string; discrepancy_type: string; opened_at: string }>((from, to) =>
      admin.from('ii_reconciliation_cases').select('id, subject_type, subject_id, discrepancy_type, opened_at').eq('user_id', userId).eq('status', 'open').order('id').range(from, to)
    );
    candidates.push(
      ...detectOpenReconciliationCases(
        userId,
        rows.map((r) => ({ id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, discrepancyType: r.discrepancy_type, openedAt: r.opened_at })),
        asOfDate,
        reconRule
      )
    );
  }

  // 6 — R4 benchmark underperformance (read-only consumption of the real R4
  // ii_analytics_results shape — migration 0043 — never the R1-legacy
  // placeholder columns).
  const perfRule = rules.get('benchmark_underperformance');
  if (perfRule) {
    const rows = await fetchAllPages<{ scope_id: string; metric_key: string; result_value: { value?: { activeReturn?: number } | null } | null; quality_status: string; engine_version: string }>((from, to) =>
      admin
        .from('ii_analytics_results')
        .select('scope_id, metric_key, result_value, quality_status, engine_version')
        .eq('user_id', userId)
        .eq('scope_type', 'scheme')
        .eq('metric_key', 'scheme_active_return')
        .order('scope_id')
        .range(from, to)
    );
    candidates.push(
      ...detectBenchmarkUnderperformance(
        userId,
        rows.map((r) => ({
          scopeId: r.scope_id,
          metricKey: r.metric_key,
          activeReturn: r.result_value?.value?.activeReturn ?? null,
          qualityStatus: r.quality_status,
          engineVersion: r.engine_version,
        })),
        asOfDate,
        perfRule
      )
    );
  }

  // 7 — R5 SIP interruption.
  const sipRule = rules.get('sip_interruption');
  if (sipRule) {
    const rows = await fetchAllPages<{ id: string; instrument_id: string; cadence: string; detection_confidence: string; latest_contribution_date: string | null; detection_method_version: string }>((from, to) =>
      admin
        .from('ii_sip_series')
        .select('id, instrument_id, cadence, detection_confidence, latest_contribution_date, detection_method_version')
        .eq('user_id', userId)
        .order('id')
        .range(from, to)
    );
    candidates.push(
      ...detectSipInterruption(
        userId,
        rows.map((r) => ({ id: r.id, instrumentId: r.instrument_id, cadence: r.cadence, detectionConfidence: r.detection_confidence, latestContributionDate: r.latest_contribution_date, detectionMethodVersion: r.detection_method_version })),
        asOfDate,
        sipRule
      )
    );
  }

  // 8 — R6 exit-load exposure + 9 — tax-lot classification incomplete.
  const exitLoadRule = rules.get('exit_load_exposure');
  const taxIncompleteRule = rules.get('tax_lot_incomplete');
  if (exitLoadRule || taxIncompleteRule) {
    // II-PC1-F2: this read previously took EVERY persisted capital-gains row
    // for the user, with no version, recency or status predicate. Because
    // `ii_capital_gains_computations` upserts on (disposal_transaction_id,
    // lot_id), a change in WHICH lot a disposal consumes — II-PC1-F1's FIFO
    // account-scoping fix, or simply a late-arriving backdated transaction —
    // orphans the old row instead of overwriting it, and nothing ever
    // deletes it. Review Centre is the ONLY reader of this table, so it was
    // the one place a superseded computation could reach a user: proven
    // live, a v2 row (ltcg, gain 30,000) raised a real open review item
    // while the correct current answer for the same disposal was stcg /
    // 22,000.
    //
    // Current-result selection is deliberately NOT re-implemented here. It
    // lives in taxRepository — the canonical R6 data-access layer — so the
    // rule has exactly one definition. See that function's header and
    // docs/investment-intelligence/II_PC1_F2_CURRENT_RESULT_SELECTION_DECISION.md.
    const { rows, supersededCount } = await loadCurrentCapitalGainsComputations(admin, userId);
    if (supersededCount > 0) {
      // Not an error: retained history is expected and healthy. Recorded so
      // the volume of superseded rows is observable rather than invisible.
      console.info(`[review-centre] user ${userId}: ${supersededCount} superseded R6 computation row(s) excluded from current-result selection.`);
    }
    if (exitLoadRule) {
      candidates.push(
        ...detectExitLoadExposure(
          userId,
          rows.map((r) => ({ lotId: r.lot_id, instrumentId: r.instrument_id, exitLoadPct: r.exit_load_pct, engineVersion: r.engine_version })),
          asOfDate,
          exitLoadRule
        )
      );
    }
    if (taxIncompleteRule) {
      candidates.push(
        ...detectTaxLotIncomplete(
          userId,
          rows.map((r) => ({ computationId: r.id, instrumentId: r.instrument_id, classification: r.classification, gainType: r.gain_type, engineVersion: r.engine_version })),
          asOfDate,
          taxIncompleteRule
        )
      );
    }
  }

  const result = await upsertReviewItems(admin, userId, candidates);

  await emitAuditEvent({
    userId,
    eventType: 'forecast_integration_run',
    subjectType: 'ii_review_items',
    subjectId: null,
    actorType: 'system',
    metadata: { candidateCount: candidates.length, created: result.created, updated: result.updated, superseded: result.superseded, engineVersion: REVIEW_ENGINE_VERSION },
  });

  return { ...result, error: null };
}

// Dedup/supersede (spec sections 49, 50): for each candidate, look up any
// existing open/acknowledged row with the same identity_key.
//   - none exists -> insert a new 'open' row (created_at is the audit trail).
//   - exists, evidence is byte-identical (JSON-stable-stringify match) ->
//     leave it untouched (no spam, no churn).
//   - exists, evidence differs (the underlying condition changed) -> mark
//     the old row 'superseded' (superseded_by_id set once the new row's id
//     is known) and insert a fresh 'open' row.
// A candidate that no longer appears at all (condition resolved) causes its
// still-open row to be marked 'resolved' — see resolveVanishedItems below.
// R9-LIVE-CERT FIX (found via live-DEV certification, LIVE-R9-010): evidence
// for rules that consume a LIVE canonical engine (goal_forecast_gap consumes
// computeGoalsPagePayload's forecast on every refresh, spec section 27 --
// R9 must never cache/duplicate that engine) is not guaranteed byte-stable
// between two calls a few seconds apart -- the underlying forecast math is
// continuous-time-sensitive, so a monetary figure like fundingGapAtTargetDate
// -- observed 932040.2164891011 on one call -- can legitimately differ in a
// trailing decimal on the next call with literally nothing else changed.
// A raw JSON.stringify equality check treats that float wobble as "the
// evidence changed", superseding and recreating the row on every single
// refresh even when the underlying observation (e.g. trackStatus, already
// part of identity_key) is identical -- exactly the "no duplicate review
// spam" failure spec section 50 forbids. Round every numeric leaf to money
// precision (2dp) before comparing, so a real change (a materially
// different figure) is still caught, but sub-cent recomputation noise from
// the live-consumed engine is not mistaken for a changed observation.
function normalizeForComparison(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
  if (Array.isArray(value)) return value.map(normalizeForComparison);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeForComparison((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
function evidenceEquivalent(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeForComparison(a)) === JSON.stringify(normalizeForComparison(b));
}

async function upsertReviewItems(admin: SupabaseClient, userId: string, candidates: ReviewItemCandidate[]): Promise<{ created: number; updated: number; superseded: number }> {
  let created = 0;
  let updated = 0;
  let superseded = 0;
  const seenIdentityKeys = new Set<string>();

  for (const c of candidates) {
    seenIdentityKeys.add(c.identityKey);
    const { data: existingRows, error: fetchErr } = await admin
      .from('ii_review_items')
      .select('id, evidence, status')
      .eq('user_id', userId)
      .eq('identity_key', c.identityKey)
      .in('status', ['open', 'acknowledged']);
    if (fetchErr) throw new Error(fetchErr.message);
    const existing = (existingRows ?? [])[0];

    if (!existing) {
      const { error: insertErr } = await admin.from('ii_review_items').insert({
        user_id: userId,
        review_type: c.reviewType,
        category: c.category,
        severity: c.severity,
        compliance_classification: c.complianceClassification,
        title: c.title,
        description: c.description,
        evidence: c.evidence,
        source_module: c.sourceModule,
        source_record_id: c.sourceRecordId,
        source_record_version: c.sourceRecordVersion,
        review_engine_version: REVIEW_ENGINE_VERSION,
        rule_key: c.ruleKey,
        rule_version: c.ruleVersion,
        identity_key: c.identityKey,
        as_of_date: c.asOfDate,
        status: 'open',
      });
      if (insertErr) throw new Error(insertErr.message);
      created += 1;
      continue;
    }

    const evidenceUnchanged = evidenceEquivalent(existing.evidence, c.evidence);
    if (evidenceUnchanged) {
      // Refresh as_of_date only — same evidence, no need to supersede.
      await admin.from('ii_review_items').update({ as_of_date: c.asOfDate, updated_at: new Date().toISOString() }).eq('id', existing.id as string);
      updated += 1;
      continue;
    }

    // R9-LIVE-CERT FIX (found via live-DEV certification, LIVE-R9-009/010):
    // the OLD open/acknowledged row MUST be superseded BEFORE the new 'open'
    // row is inserted — uidx_ii_review_items_open_identity (migration 0067)
    // allows at most one open/acknowledged row per (user_id, identity_key),
    // so inserting the new 'open' row first while the old row is still
    // open/acknowledged unconditionally violates that unique index (a real,
    // 100%-reproducible bug: every evidence change on a re-run 500'd the
    // whole refresh). This is exactly the order migration 0067's own header
    // comment already documents as required ("the superseded row is no
    // longer open/acknowledged when the new one is inserted") — the
    // implementation just had the two statements swapped. superseded_by_id
    // is filled in with a second small update once the new row's id is
    // known (it cannot be known before the insert).
    const { error: supersedeOldErr } = await admin.from('ii_review_items').update({ status: 'superseded', updated_at: new Date().toISOString() }).eq('id', existing.id as string);
    if (supersedeOldErr) throw new Error(supersedeOldErr.message);
    const { data: fresh, error: insertErr } = await admin
      .from('ii_review_items')
      .insert({
        user_id: userId,
        review_type: c.reviewType,
        category: c.category,
        severity: c.severity,
        compliance_classification: c.complianceClassification,
        title: c.title,
        description: c.description,
        evidence: c.evidence,
        source_module: c.sourceModule,
        source_record_id: c.sourceRecordId,
        source_record_version: c.sourceRecordVersion,
        review_engine_version: REVIEW_ENGINE_VERSION,
        rule_key: c.ruleKey,
        rule_version: c.ruleVersion,
        identity_key: c.identityKey,
        as_of_date: c.asOfDate,
        status: 'open',
      })
      .select('id')
      .single();
    if (insertErr || !fresh) throw new Error(insertErr?.message ?? 'Failed to insert superseding review item');
    await admin.from('ii_review_items').update({ superseded_by_id: fresh.id as string, updated_at: new Date().toISOString() }).eq('id', existing.id as string);
    superseded += 1;
    created += 1;
  }

  await resolveVanishedItems(admin, userId, seenIdentityKeys);
  return { created, updated, superseded };
}

// A review item whose triggering condition no longer holds (e.g. the
// investment got allocated, the goal became on-track) is marked 'resolved',
// never silently deleted (spec section 49) — this run's candidate set is the
// full, authoritative set of currently-true conditions per rule_key, so any
// previously-open item for a rule_key that ran this refresh but did NOT
// reproduce that item's identity_key has had its condition resolved.
async function resolveVanishedItems(admin: SupabaseClient, userId: string, seenIdentityKeys: Set<string>): Promise<void> {
  const ranRuleKeys = ['unallocated_investment', 'goal_allocation_conflict', 'goal_forecast_gap', 'stale_valuation', 'reconciliation_open', 'benchmark_underperformance', 'sip_interruption', 'exit_load_exposure', 'tax_lot_incomplete'];
  const { data: openRows, error } = await admin.from('ii_review_items').select('id, identity_key, rule_key').eq('user_id', userId).in('status', ['open', 'acknowledged']).in('rule_key', ranRuleKeys);
  if (error) throw new Error(error.message);
  const toResolve = (openRows ?? []).filter((r) => !seenIdentityKeys.has(r.identity_key as string));
  if (toResolve.length === 0) return;
  await admin
    .from('ii_review_items')
    .update({ status: 'resolved', resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .in(
      'id',
      toResolve.map((r) => r.id as string)
    );
}

export async function listReviewItems(userId: string, opts: { status?: string; reviewType?: string; limit?: number; cursor?: string }): Promise<{ items: IiReviewItem[]; nextCursor: string | null }> {
  const supabase = await createClient();
  const limit = Math.min(opts.limit ?? 50, 200);
  let query = supabase.from('ii_review_items').select('*').eq('user_id', userId).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1);
  if (opts.status) query = query.eq('status', opts.status);
  if (opts.reviewType) query = query.eq('review_type', opts.reviewType);
  if (opts.cursor) query = query.lt('created_at', opts.cursor);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as IiReviewItem[];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].created_at : null };
}

export async function acknowledgeReviewItem(userId: string, id: string, note: string | null): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { data: existing } = await supabase.from('ii_review_items').select('id, status').eq('id', id).eq('user_id', userId).maybeSingle();
  if (!existing) return { error: 'Review item not found' };
  if (existing.status !== 'open') return { error: `Cannot acknowledge a review item with status '${existing.status}'` };
  const { error } = await supabase.from('ii_review_items').update({ status: 'acknowledged', acknowledged_at: new Date().toISOString(), user_note: note, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId);
  if (error) return { error: error.message };
  await emitAuditEvent({ userId, eventType: 'review_acknowledged', subjectType: 'ii_review_items', subjectId: id, actorType: 'user', metadata: { note } });
  return { error: null };
}

export async function dismissReviewItem(userId: string, id: string, note: string | null): Promise<{ error: string | null }> {
  const supabase = await createClient();
  const { data: existing } = await supabase.from('ii_review_items').select('id, status').eq('id', id).eq('user_id', userId).maybeSingle();
  if (!existing) return { error: 'Review item not found' };
  if (existing.status === 'resolved' || existing.status === 'superseded') return { error: `Cannot dismiss a review item with status '${existing.status}'` };
  const { error } = await supabase.from('ii_review_items').update({ status: 'dismissed', dismissed_at: new Date().toISOString(), user_note: note, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId);
  if (error) return { error: error.message };
  await emitAuditEvent({ userId, eventType: 'review_dismissed', subjectType: 'ii_review_items', subjectId: id, actorType: 'user', metadata: { note } });
  return { error: null };
}
