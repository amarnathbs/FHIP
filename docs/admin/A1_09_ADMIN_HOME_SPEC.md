# A1.2 — Admin Home Specification

**Status:** Design only. No route, page, or query exists yet.

## 1. Principle

Admin Home is a **role-aware work queue**, not a dashboard of "interesting" numbers. Every item shown must answer all five: **who** it's for, **what** needs doing, **by when** (if time-bound), **the consequence of inaction**, and **which page completes it**. An item that cannot answer all five is not shown, even if it would be an interesting metric.

## 2. Queue sources, by canonical area (only sources that exist or are concretely planned)

| Queue | Who sees it | What | By when | Consequence of inaction | Completes at |
|---|---|---|---|---|---|
| Drafts awaiting your edit | Author, Editor, Resource Admin, Super Admin (own-authored/assigned only) | N drafts you started | None (no deadline model exists) | Content stays unpublished indefinitely | `/admin/resources/content/drafts` (ADM-08) |
| Content awaiting review | Editor, Compliance Reviewer, Resource Admin, Super Admin | N items in the review queue | None today (`review-due` exists as a distinct queue for a different signal — see below) | Publishing pipeline stalls | `/admin/resources/content/review` (ADM-09/21) |
| Content past its review-due date | Editor, Compliance Reviewer, Resource Admin, Super Admin | N items whose `review_due` has passed | Overdue, by N days | Stale/potentially inaccurate content stays live | `/admin/resources/content/review-due` (ADM-21) |
| Recommendations pending activation | Super Admin | N drafted-but-inactive recommendations | None | Users don't receive them | `/admin/recommendations` (ADM-04) |
| Benchmark sources pending approval | Super Admin | N sources awaiting Approve/Suspend/Reinstate | None | Reference data stays stale/unapproved | `/admin/benchmarks` (ADM-01) |
| Benchmark datasets pending validation | Super Admin | N datasets not yet validated/activated | None | Platform-wide benchmark figures stay on the prior dataset | `/admin/benchmarks` (ADM-02) |
| **Future** — FDH master-data proposals pending review/approval | Data Governance Contributor/Approver (or Super Admin interim) | N proposals in `admin_review` | None defined yet | Master data stays stale/uncorrected | `/admin/data-governance` (ADM-32/33), once Wave B ships |
| **Future** — Failed FDH parser/ingestion runs | Super Admin, Data Governance Contributor | N failed runs in the last 24h | Real-time | Bank statement ingestion silently degrades for affected institutions | `/admin/data-governance/operations` (ADM-36), once Wave D ships |
| **Future** — Stale reference data | Super Admin | Benchmarks/master-data not refreshed in N days | Configurable threshold | Users see outdated comparisons | Reference Data & Benchmarks / Financial Data Governance areas |
| **Future** — Security/privacy alerts | Super Admin | N unresolved high/critical security events | Real-time for `critical` | Undetected privilege escalation or repeated-denial pattern | `/admin/security` (ADM-42), once A1.3/A4 ships |
| **Future** — Active support-access grants nearing expiry | Super Admin, active grant holder | N grants expiring in the next hour | Time-boxed | Grantee loses access mid-task, or (worse) a grant silently over-runs if expiry fails | `/admin/security` (ADM-43), once A4 ships |

## 3. What Home explicitly does NOT show

- Any figure that is "interesting" but does not name a required action (e.g. total published-article count) — that belongs in Analytics, not Home.
- Any queue for a task the caller lacks the capability to act on (Standard §4 — a queue item the viewer cannot resolve is itself a form of misleading UI).
- Any fabricated "0" where the truth is `unavailable` (Standard §8/§12) — an empty queue renders as "Nothing needs your attention right now," never a bare `0` presented ambiguously.
- Any personal/financial data belonging to an end user — every queue item above is content-, dataset-, proposal-, or event-level, never an individual user's figures (this is why Recommendations Gap Review, which would have been the one candidate queue item shaped like "N users have a coverage gap," stays withdrawn rather than resurrected here).

## 4. Role-awareness

Home renders only the queues the caller's capabilities allow them to act on (union across multiple roles, Standard §3). A role-less user sees no Home content at all (no Admin entry point exists for them — `A1_07`). An Analyst sees **zero mutation-oriented queue items** — Analyst's Home, once Analytics is real, would show read-only aggregate summaries at most (e.g. "Analytics as of {timestamp}"), never a "N items need action" queue, since Analyst cannot act on anything.

## 5. Failure and empty-state behaviour (Standard §8/§13)

Every queue source must distinguish `ok` (a real count, including zero), `unavailable` (the underlying feature doesn't exist yet or its data source is down), and an outright fetch failure (shown as an explicit error, never folded into a `0`). A queue source that errors must not take down the rest of Home — each queue tile fails independently.

## 6. Open questions flagged for the Product Owner

See `A1_19` PO-3: exact queue thresholds (e.g. what counts as "stale"), whether Home replaces or supplements each domain's own existing dashboard-style landing page (`admin/resources/page.tsx`, `admin/benchmarks/page.tsx`), and alerting/paging behaviour for `critical` security events are all genuinely open, not resolved here.
