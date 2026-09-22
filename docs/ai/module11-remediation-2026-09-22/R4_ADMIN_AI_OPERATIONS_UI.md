# R4 — Admin AI Operations UI

**Programme:** Module 11 AI Remediation, 2026-09-22 · **Brief:** §§34–39 · **Standard:** `docs/admin/FHIP_ADMIN_ARCHITECTURE_STANDARD.md` v1.0 (read in full before this work, per `AGENTS.md`)
**Verdict:** **CONDITIONAL PASS** — built on the existing data/API layer, Standard-compliant by construction and by test; **live-DEV rendering is blocked on applying migration 0177 (DDL) to DEV and granting the capability to an admin**, so the screen is verified by type-check, lint and unit/PGlite tests, not by a browser session.

## Admin Architecture Standard compliance statement (AGENTS.md requirement)

**Capabilities affected (introduced):**

| Capability | Backing column (0177) | Roles | UI visibility | Route enforcement | API enforcement | DB enforcement | Denial | Tests |
|---|---|---|---|---|---|---|---|---|
| `aiOperations` (read-only screen + aggregate read API) | `admin_users.can_view_ai_operations` | any admin_users row explicitly granted it (nobody by default) | nav group "AI" (`lib/admin/adminNav.ts`) | `requireAiOperationsViewerPage()` → redirect `/login` / `/dashboard` | `requireAiOperationsViewer()` → 401 / 403 | every governance table RLS-enabled, zero policies (service-role only); `is_ai_operations_viewer()` predicate | explicit 401/403, never 200-empty | `aiR4AdminAiOperations.test.ts` A, B, D |
| `aiOperationsManage` (guarded controls) | `admin_users.can_manage_ai_operations` | explicitly granted; **plus** Super Admin because every write route is the pre-existing `requireAdmin()` route | controls rendered only with manage **and** isAdmin | n/a (same page) | `requireAiOperationsManager()` **and** `requireAdmin()` on the one new write route; existing write routes unchanged | as above; `is_ai_operations_manager()`; scheduler RPCs `EXECUTE` revoked from anon/authenticated | 401/403 | A, B, D |

**Clauses applied and how:** §2 (two separately named capabilities, neither implied by `isAdmin`, by each other, or by any Resources role — tested); §3 (union semantics preserved: adding the AI group changes no other group — nav tests extended, 267/267); §4 (four layers, direct-API test, direct-URL test, database-bypass test in real Postgres: an `authenticated` session with a plain admin_users row reads 0 rows from all nine governance tables and gets `permission denied` on the lease RPC); §5 (viewer is read-only; manage is a separate grant); §7/§8 (per-subject spend is a suppressed distribution: min 10 distinct subjects, min cell 5, small cells merged, no per-subject maximum; every panel is `ok`/`unavailable`/`suppressed` with the fixed label); §9 (no `user_id`, admission id, metadata, financial record or context payload leaves the overview — asserted by regex over the serialised payload; safety events are projected to type/severity/task/provider/detail); §12 (each metric is the existing certified data function's definition — `buildUsageDashboard()`, pack/scheduler counts — and the cost projection is labelled "linear extrapolation … not a forecast"); §13 (a failed source, including an unapplied 0176/0177, renders `unavailable` with the reason; capability reads fail closed on any error); §14 (only its own nav entry, capabilities, one read route, one manage route, tests and docs; the 19 existing AI routes are not rebuilt — their `requireAdmin()` gating is a recorded §1.2 conflict deferred to the PO, see below); §15 (this document + operating notes in the ADR runbook).

**Exceptions requested (§16):** none. **Recorded conflict, not an exception:** the pre-existing `/api/admin/ai/*` write routes are gated on bare `requireAdmin()` (Standard §2 prohibits that for *new* surfaces; §1.2 records a conflict in existing code for PO scheduling rather than a rebuild). The UI compensates by requiring both grants; a `can_manage_ai_operations` holder who is not Super Admin sees controls disabled with an explanation, not a silent 403.

## What was built (CODE)

- Migration `0177`: two columns + two predicates, default false — applying it grants nothing.
- `lib/services/aiOperationsAdmin.ts` (guards), `lib/ai/admin/aiOperationsOverview.ts` (one aggregate read over the existing data layer — no backend service rebuilt), `GET /api/admin/ai/operations`, `POST /api/admin/ai/insight-packs/scheduler/run` (admin manual trigger, reason required for a real submit), `app/(app)/admin/ai-operations/page.tsx`, `components/admin/AiOperationsClient.tsx`, nav group + `/api/admin/me` fields.
- Kill-switch route: closed list extended with `AI_CONTEXTUAL_EXPLANATIONS_ENABLED`, `AI_SCHEDULER_ENABLED`, `AI_NEXT_BEST_ACTION_ENABLED` (brief §36's named switches); `effective_state` echoes them.

## Required sections (brief §36) → source of each value

| Section | Values | Source (all real) |
|---|---|---|
| Overview | provider, model, batch transport, credential-configured, all 8 switches | `describeModule11AiConfig()` (secret-free), `ai_platform_controls` read fresh |
| Usage | runs, tokens, live vs cached/zero-cost, entitled subjects, quota exhaustion, rate-limit events | `buildUsageDashboard()` (ledger, admission events, runs) — `denials_by_reason.rate_limited` |
| Cost | period spend, actual (null until reconciled), avg/subject, projection (labelled), provider/model price table, per-subject distribution (suppressed), soft/hard thresholds, task limits | dashboard, registry, `summariseUsageForPeriod()` → distribution, controls |
| Insight Packs | queued/generating, ready, partial, failed, stale, grounding failures, safety failures | `ai_insight_packs` |
| Scheduler | switch, open batches, jobs by status, last 10 runs | `0176` tables (unavailable-with-reason until applied) |
| Safety | events by severity, HIGH/CRITICAL list (no ids), provider failures by status | `ai_operational_events`, `ai_runs` |
| Configuration | kill switches, provider enable/disable, model enable/disable, prompt activate/retire, scheduler dry-run/submit/reconcile — each with impact text, typed reason, confirmation; audited by the 0115 trigger / scheduler runs ledger | existing routes |

## Evidence

- TEST: `tests/unit/aiR4AdminAiOperations.test.ts` **10/10** (guards A, direct-API B, overview states/privacy C, PGlite database-bypass D). `tests/unit/adminAnalyticsPhaseA.test.ts` extended, **267/267**.
- CODE: `tsc --noEmit` exit 0; `eslint` clean on the new files (one React `set-state-in-effect` finding fixed by following the PC6 client's cancellation pattern).
- DEV: **not rendered live** — needs 0177 on DEV (DDL, no path) and a grant to an admin; the two read routes were not exercised against DEV for the same reason. Recorded as the R6 gap.

## Known limitations

- Controls call existing routes; there is no bulk edit and no cost-limit editing form (the `PUT /api/admin/ai/controls` route exists; a form was out of scope — flagged, not built).
- No CSV/PDF export (Standard §11) — none requested; none built.
