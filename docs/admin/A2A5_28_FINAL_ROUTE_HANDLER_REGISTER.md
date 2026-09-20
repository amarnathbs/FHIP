# Final Route/Handler Register (Post-Dispatch)

`A1_08_MIGRATION_MAP.md` remains the authoritative full inventory (110 route artifacts: 36 pages + 74 API route files, every one dispositioned). This document records exactly what changed in that inventory as a result of this dispatch — nothing more, to avoid duplicating an already-complete register.

## 1. Routes whose gate function changed (34 files, capability rename only)

| Domain | Files | Old gate | New gate |
|---|--:|---|---|
| `app/api/admin/benchmarks/**` | 10 | `requireAdmin` | `requireBenchmarksAdmin` |
| `app/api/admin/recommendations/**` | 4 | `requireAdmin` | `requireRecommendationsAdmin` |
| `app/api/admin/ai/**` | 20 | `requireAdmin` | `requireAIPlatformAdmin` |

No URL changed for any of these 34. No handler method (GET/POST/PUT/DELETE) was added or removed. No request/response contract changed. Full detail: `A2A5_02A_A3_CAPABILITY_SPLIT_EXECUTION.md`.

## 2. Routes newly discoverable via canonical-shell navigation (0 new routes — 2 existing routes newly linked)

| Route | Existed before this dispatch? | New in this dispatch |
|---|---|---|
| `/admin/investment-intelligence/reference-data-quality` | Yes (PC6) | Nav entry point only — `lib/admin/adminAreas.ts` sub-group + `lib/admin/navigationRegistry.ts` metadata entry |
| `/admin/investment-intelligence/lookthrough-data-quality` | Yes (PC7) | Same |

Zero new route files were created by this dispatch (confirmed: `git diff --stat` for the code commit shows no new file under `app/`).

## 3. New files created (non-route)

| File | Purpose |
|---|---|
| `lib/admin/investmentIntelligenceAdminCapabilities.ts` | Shared capability-check module (extracted from `app/api/admin/me/route.ts`) |
| `supabase/migrations/0165_admin_a4_canonical_audit_and_security_event_sink.sql` | A4.1/4.2 schema (unapplied) |
| `tests/unit/adminCapabilitySplit.test.ts` | New test file |

## 4. Handler-level authorization summary (mission §12.7's "direct-route enforcement" requirement)

Every one of the 34 renamed routes retains exactly the same 4-layer enforcement `A1_08`/Standard §4 already required: database (unchanged RLS/service-role pattern), API (the renamed-but-behaviourally-identical gate function), route/page (N/A — these are API routes, not pages, so this layer doesn't apply to them directly), UI/nav (now correctly reflecting the same gate, unchanged for these 34 since they were already correctly hidden/shown before this dispatch — only their internal name changed).

## 5. Reconciliation

110 pre-existing route artifacts (`A1_08` §11) + 3 new non-route files (§3 above) = complete accounting. Zero routes retired. Zero routes added. Zero routes' URLs changed. 34 routes' internal gate function renamed (behaviourally inert). 2 pre-existing routes gained a nav entry point they lacked before. This matches, exactly, every other document in this set's own description of this dispatch's scope — no discrepancy found by this final cross-check.
