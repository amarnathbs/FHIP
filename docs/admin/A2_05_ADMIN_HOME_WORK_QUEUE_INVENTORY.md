# A2.3 — Admin Home and Work-Queue Inventory

Implements `docs/admin/A1_09_ADMIN_HOME_SPEC.md` (PO-3 approved as designed) exactly, via `lib/admin/homeQueues.ts` (data gathering) and `app/(app)/admin/home/page.tsx` (rendering). No new privileged data access was created — every source reuses an existing RLS-protected table already read by other certified Resources/Benchmarks/Recommendations code paths, through the caller's own request-scoped Supabase client (never a service-role client).

## 1. Queue sources implemented today (matches `A1_09` §2's "exists" rows exactly)

| Queue | Who sees it | Source | Completes at |
|---|---|---|---|
| Drafts awaiting your edit | Author, Editor, Resource Admin, Super Admin (own-authored only) | `resource_posts` count, `status in (idea,draft)`, `created_by = caller` | `/admin/resources/content/drafts` |
| Content awaiting review | Editor, Compliance Reviewer, Resource Admin, Super Admin | `getResourceDashboardSummary().counts.inReview` (shared fetch) | `/admin/resources/content/review` |
| Content past its review-due date | Editor, Compliance Reviewer, Resource Admin, Super Admin | `getResourceDashboardSummary().counts.reviewDue` (shared fetch) | `/admin/resources/content/review-due` |
| Recommendations pending activation | Super Admin | `action_recommendation_master` count, `is_active = false` | `/admin/recommendations` |
| Benchmark sources pending approval | Super Admin | `benchmark_sources` count, `status in (draft, under_review)` | `/admin/benchmarks` |
| Benchmark datasets pending validation | Super Admin | `benchmark_datasets` count, `data_status in (draft, under_review)` | `/admin/benchmarks` |
| Recently updated content (informational, never framed as "needs action") | Resources staff (own-drafts or review-queue roles) | `getResourceDashboardSummary().recent` (same shared fetch) | n/a |

Every source that a caller's role does not qualify for is **not requested at all** — not fetched-then-hidden, not shown as a fabricated zero. `tests/unit/adminA2CanonicalShell.test.ts`'s `gatherHomeQueues()` describe block proves this per role (Analyst-only receives zero items and the dashboard-summary function is never called; Author sees only own-drafts; Compliance Reviewer sees the two review-stage queues but not own-drafts, matching `A1_09` §2's exact "who sees it" column).

## 2. Every item's five required answers (dispatch §13)

Each `QueueItem` carries `title` (what), `byWhen`, `consequence` (of inaction), `completesHref`/`completesLabel` (where), and is only ever requested for a role that can act on it (who) — matching `A1_09` §1's five-question rule verbatim. An item that cannot answer all five is not modelled.

## 3. Independent failure behaviour (dispatch §14, §18)

Each source is wrapped in `safeCount()` or an isolated `try`/`catch` around the shared dashboard-summary fetch; a thrown error becomes that source's own `error` state (rendered as a plain-language message, never a raw Postgres error) and never takes down sibling tiles. Proven by test: a `action_recommendation_master` failure leaves the sibling `benchmark_sources` tile at `ok` with its real count, and a dashboard-summary rejection marks every summary-dependent tile (including "recent activity") as failed together, honestly, rather than degrading silently to a fabricated zero.

## 4. What Home explicitly does not show (dispatch §12, §21)

No vanity metrics (e.g. total published-article count), no individual user's financial information, no user counts or profile links, no fabricated "0" where the truth is "unavailable." The "System, security and privacy notices" section explicitly states no security/privacy alerting exists yet rather than fabricating an empty-looking widget for it.

## 5. Role-less and single-area states (dispatch §15)

A role-less authenticated caller never reaches Home at all — `requireResourceAdminAccess()` redirects to `/dashboard` before the page body renders (proven live-mocked in `tests/unit/adminA2HomeRoute.test.ts`, and confirmed once more in isolation: 5/5 passed after removing incidental CPU contention from a concurrent background `tsc` run — see `A2_09_TEST_AND_REGRESSION_REPORT.md`). Analyst — the one persona with exactly one available area (Home) and zero queue items — receives a real, honest empty state ("Nothing needs your attention right now" plus the standing Analytics-unavailable note) rather than either a fake dashboard or a bare Admin shell.

## 6. Data-access proof (dispatch §14)

No new endpoint, RPC, or table was created. `getResourceDashboardSummary` is the pre-existing, separately certified query already powering `admin/resources/page.tsx`'s own dashboard — reused, not duplicated. The four new count queries added by this module each read one existing table already governed by an open `for select using (true)` RLS policy for authenticated readers (`supabase/migrations/0011, 0017/0019, 0033`) — no RLS or migration change was required.
