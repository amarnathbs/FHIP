// Admin A2 — Admin Home work-queue data gathering.
//
// Implements docs/admin/A1_09_ADMIN_HOME_SPEC.md's role-aware operational
// work-queue model (PO-3 APPROVED as designed): every item answers who it's
// for (enforced by which queues are even requested — see
// app/(app)/admin/home/page.tsx), what needs doing, by when, the
// consequence of inaction, and which page completes it. Only queue sources
// A1_09 §2 lists as existing TODAY are implemented — every "Future" row in
// that table (FDH master-data proposals, failed parser runs, stale
// reference data, security/privacy alerts, support-access grants) is
// deliberately absent, not stubbed, because A1_09 §3 forbids a fabricated
// "0" where the truth is "this doesn't exist yet", and none of those
// sources has a real table or RPC behind it in this repository.
//
// Every source below:
//  - reads through the caller's own request-scoped, RLS-authenticated
//    Supabase client (never the service-role client) — the same discipline
//    lib/resources/admin/queries.ts already establishes, and one this
//    module can honour because every table it reads
//    (resource_posts/action_recommendation_master/benchmark_sources/
//    benchmark_datasets) already has an open `for select using (true)` RLS
//    policy for authenticated readers (supabase/migrations/0011, 0017/0019,
//    0033) — no RLS or migration change was needed to build Home;
//  - fails independently (A1_09 §5): a thrown error from one source
//    becomes that source's own `error` state and never takes down the
//    other tiles on the page;
//  - never shows a bare `0` where the real state is `unavailable` — a
//    source that is not applicable to the caller is simply not requested
//    at all (see the gating in app/(app)/admin/home/page.tsx), which is
//    the "not shown" half of A1_09 §3's "any queue for a task the caller
//    lacks the capability to act on" rule.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CurrentResourceRoles } from '@/lib/resources/permissions';
import { hasResourceRole } from '@/lib/resources/permissions';
import type { ResourceRole } from '@/lib/resources/types';
import { getResourceDashboardSummary, type DashboardSummary } from '@/lib/resources/admin/queries';

export type QueueResultState = 'ok' | 'error';

export interface QueueItem {
  id: string;
  title: string;
  state: QueueResultState;
  /** Non-null exactly when state === 'ok' (Standard §8's nullable-numeric contract). */
  count: number | null;
  byWhen: string;
  consequence: string;
  completesHref: string;
  completesLabel: string;
  /** Shown when state === 'ok' and count === 0. */
  emptyMessage: string;
  /** Shown when state === 'error'. Never a raw database error string (adminAuth.ts's safeDbError discipline, restated here). */
  errorMessage?: string;
}

async function safeCount(fn: () => Promise<number>, errorMessage: string): Promise<{ state: QueueResultState; count: number | null; errorMessage?: string }> {
  try {
    const count = await fn();
    return { state: 'ok', count };
  } catch (err) {
    console.error('Admin Home queue source failed:', err);
    return { state: 'error', count: null, errorMessage };
  }
}

async function countOwnDrafts(supabase: SupabaseClient, userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('resource_posts')
    .select('id', { count: 'exact', head: true })
    .in('status', ['idea', 'draft'])
    .eq('created_by', userId);
  if (error) throw error;
  return count ?? 0;
}

async function countRecommendationsPendingActivation(supabase: SupabaseClient): Promise<number> {
  const { count, error } = await supabase
    .from('action_recommendation_master')
    .select('id', { count: 'exact', head: true })
    .eq('is_active', false);
  if (error) throw error;
  return count ?? 0;
}

async function countBenchmarkSourcesPendingApproval(supabase: SupabaseClient): Promise<number> {
  const { count, error } = await supabase
    .from('benchmark_sources')
    .select('id', { count: 'exact', head: true })
    .in('status', ['draft', 'under_review']);
  if (error) throw error;
  return count ?? 0;
}

async function countBenchmarkDatasetsPendingValidation(supabase: SupabaseClient): Promise<number> {
  const { count, error } = await supabase
    .from('benchmark_datasets')
    .select('id', { count: 'exact', head: true })
    .in('data_status', ['draft', 'under_review']);
  if (error) throw error;
  return count ?? 0;
}

// Content-workflow roles that see "Drafts awaiting your edit" per A1_09 §2's
// exact role list (Author, Editor, Resource Admin, Super Admin — Compliance
// Reviewer and Publisher are deliberately excluded, matching the spec row).
const OWN_DRAFTS_ROLES: ResourceRole[] = ['author', 'editor'];

// Roles that see the two review-stage queues (Content awaiting review /
// Content past its review-due date) per A1_09 §2 (Editor, Compliance
// Reviewer, Resource Admin, Super Admin).
const REVIEW_QUEUE_ROLES: ResourceRole[] = ['editor', 'compliance_reviewer'];

export interface HomeQueues {
  items: QueueItem[];
  /** Recently updated content, informational only — never framed as "needs action". */
  recentActivity: DashboardSummary['recent'] | null;
  recentActivityError: string | null;
}

/**
 * Gathers every queue item the caller (per their resolved role snapshot) may
 * act on. Each source is requested only when a role in A1_09 §2's own "who
 * sees it" column applies — a caller without a listed role never receives
 * that queue's item at all, matching A1_09 §3's "no queue for a task the
 * caller lacks the capability to act on" rule.
 */
export async function gatherHomeQueues(supabase: SupabaseClient, current: CurrentResourceRoles): Promise<HomeQueues> {
  const items: QueueItem[] = [];

  const sees = (roles: ResourceRole[]) => current.isSuperAdmin || roles.some((r) => hasResourceRole(current, r));
  const seesOwnDrafts = sees(OWN_DRAFTS_ROLES) || hasResourceRole(current, 'resource_admin');
  const seesReviewQueues = sees(REVIEW_QUEUE_ROLES) || hasResourceRole(current, 'resource_admin');

  // "Drafts awaiting your edit" — own-authored only, per A1_09 §2.
  if (seesOwnDrafts && current.userId) {
    const result = await safeCount(
      () => countOwnDrafts(supabase, current.userId as string),
      'Could not load your drafts right now.'
    );
    items.push({
      id: 'own-drafts',
      title: 'Drafts awaiting your edit',
      state: result.state,
      count: result.count,
      byWhen: 'None',
      consequence: 'Content stays unpublished indefinitely.',
      completesHref: '/admin/resources/content/drafts',
      completesLabel: 'Drafts',
      emptyMessage: 'You have no drafts in progress.',
      errorMessage: result.errorMessage,
    });
  }

  // "Content awaiting review", "Content past its review-due date" and the
  // "recently updated content" informational feed below all share ONE
  // dashboard-summary fetch (all three read from the same, already
  // -certified query — lib/resources/admin/queries.ts's
  // getResourceDashboardSummary) rather than querying it up to three times
  // per page load. A failure here marks every tile that depends on it as
  // `error` together, honestly, rather than silently degrading one to a
  // fabricated zero while another succeeds from a stale value.
  let summary: DashboardSummary | null = null;
  let summaryError: string | null = null;
  if (seesReviewQueues || seesOwnDrafts) {
    try {
      summary = await getResourceDashboardSummary(supabase);
    } catch (err) {
      console.error('Admin Home dashboard-summary source failed:', err);
      summaryError = 'Could not load the content review queues right now.';
    }
  }

  if (seesReviewQueues) {
    items.push({
      id: 'content-awaiting-review',
      title: 'Content awaiting review',
      state: summary ? 'ok' : 'error',
      count: summary ? summary.counts.inReview : null,
      byWhen: 'None',
      consequence: 'Publishing pipeline stalls.',
      completesHref: '/admin/resources/content/review',
      completesLabel: 'Review Queue',
      emptyMessage: 'Nothing is waiting in editorial or compliance review.',
      errorMessage: summaryError ?? undefined,
    });

    items.push({
      id: 'content-review-due',
      title: 'Content past its review-due date',
      state: summary ? 'ok' : 'error',
      count: summary ? summary.counts.reviewDue : null,
      byWhen: 'Overdue',
      consequence: 'Stale or potentially inaccurate content stays live.',
      completesHref: '/admin/resources/content/review-due',
      completesLabel: 'Review Due',
      emptyMessage: 'No published content is past its review-due date.',
      errorMessage: summaryError ?? undefined,
    });
  }

  // Super-Admin-only sources — Recommendations, Benchmark sources, Benchmark
  // datasets, per A1_09 §2's exact "who sees it" column.
  if (current.isSuperAdmin) {
    const recs = await safeCount(() => countRecommendationsPendingActivation(supabase), 'Could not load pending recommendations right now.');
    items.push({
      id: 'recommendations-pending-activation',
      title: 'Recommendations pending activation',
      state: recs.state,
      count: recs.count,
      byWhen: 'None',
      consequence: "Users don't receive them.",
      completesHref: '/admin/recommendations',
      completesLabel: 'Recommendations',
      emptyMessage: 'No drafted-but-inactive recommendations.',
      errorMessage: recs.errorMessage,
    });

    const sources = await safeCount(() => countBenchmarkSourcesPendingApproval(supabase), 'Could not load benchmark sources right now.');
    items.push({
      id: 'benchmark-sources-pending-approval',
      title: 'Benchmark sources pending approval',
      state: sources.state,
      count: sources.count,
      byWhen: 'None',
      consequence: 'Reference data stays stale or unapproved.',
      completesHref: '/admin/benchmarks',
      completesLabel: 'Benchmarks',
      emptyMessage: 'No sources are awaiting Approve, Suspend or Reinstate.',
      errorMessage: sources.errorMessage,
    });

    const datasets = await safeCount(() => countBenchmarkDatasetsPendingValidation(supabase), 'Could not load benchmark datasets right now.');
    items.push({
      id: 'benchmark-datasets-pending-validation',
      title: 'Benchmark datasets pending validation',
      state: datasets.state,
      count: datasets.count,
      byWhen: 'None',
      consequence: 'Platform-wide benchmark figures stay on the prior dataset.',
      completesHref: '/admin/benchmarks',
      completesLabel: 'Benchmarks',
      emptyMessage: 'No datasets are awaiting validation or activation.',
      errorMessage: datasets.errorMessage,
    });
  }

  // Recently updated content — informational only (A1_09 §3: never framed
  // as a "needs action" queue; this is the "recent relevant activity"
  // category), reusing the same dashboard summary's `.recent` list computed
  // above rather than a second query, for Resources staff only.
  const recentActivity = summary ? summary.recent : null;
  const recentActivityError = !summary && (seesReviewQueues || seesOwnDrafts) ? (summaryError ?? 'Could not load recent activity right now.') : null;

  return { items, recentActivity, recentActivityError };
}
