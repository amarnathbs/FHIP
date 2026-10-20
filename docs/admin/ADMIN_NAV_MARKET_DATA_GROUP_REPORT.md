# Admin navigation: "Market Data" group

Date: 19-10-2026. Branch: `feat/admin-nav-market-data-group-20261019` (based on `origin/main` 44ff8d6). Not pushed, not merged.

## What changed

The Admin sidebar had two separate groups, "Market Index Data" (one item) and "Risk-free Rates" (one item). They are now ONE group titled **Market Data** with two items: **Market Index Data** and **Risk-free Rate Data**.

Navigation only. No route moved or renamed, no page renamed, no API, database, migration, secret or production access.

Canonical definition changed: `lib/admin/adminNav.ts` (`buildAdminNavGroups`, new `marketDataGroup()` and `MARKET_DATA_GROUP_LABEL`). `components/ui/AppShell.tsx` renders whatever that builder returns, so it needed no change and holds no second nav (a test asserts that).

Group position: where "Market Index Data" used to be (after Fund Look-Through, before Premium and Promo Codes). The old "Risk-free Rates" group sat last; it no longer exists.

## Visibility (unchanged per item, UX only)

| Item | Shown when (as before the change) |
|---|---|
| Market Index Data | any of `marketIndexDataUpload`, `benchmarkDataView`, `benchmarkDataPublish`, `benchmarkDataCorrect`, `benchmarkCatalogueManage`, `benchmarkEntitlementApprove` |
| Risk-free Rate Data | `riskFreeDataUpload` (`can_upload_risk_free_data`) OR `riskFreeSeriesSwitch` (`can_switch_risk_free_series`) |

- Group hidden when neither item is visible; one item visible shows the group with that one item; both shows both.
- NOTE for the PO: the request says Risk-free Rate Data is visible only with the upload permission. The code before this change also showed it to a holder of the separate "switch a series on/off" permission, and the page's own guard (`requireRiskFreePage('any')`) admits either. I preserved that exactly (instruction: do not change gating, do not widen). If the PO wants upload-only, that is a separate capability decision, not a grouping change.
- Nothing widened: Super Admin, Reference Data and every other capability still show neither item. Page, API and RPC capability checks are untouched (Standard s4).

## Admin Standard compliance

- Capabilities affected: none created or changed. Navigation visibility only for the eight fields above.
- Clauses: s2 (each item still gated by its own named capability, no shared boolean), s4 (nav is not authorisation; route/API checks unchanged), s13 (parser stays strict `=== true`, fail closed; malformed `/api/admin/me` body yields no group), s14 (unrelated groups, Reference Data, Premium/Promo untouched), s18 last bullet (related entries share one group, each gated separately).
- Exceptions requested: none.

## Tests (UNIT-TESTED)

New `tests/unit/adminNavMarketDataGroup.test.ts` (group exists exactly once; both items in it with unchanged routes; no old "Market Index Data" / "Risk-free Rates" group for any capability probe; each destination appears once; per-capability gating for all 8 fields; neither/index-only/risk-free-only/both combinations; no cross-reveal; not widened by isAdmin or other capabilities; group dropped when empty; malformed body fails closed; unrelated groups and order; AppShell renders from the builder with no hard-coded entry, keeps `role="group"`, `aria-label`, `aria-current` and Escape handling; exact-match active highlighting; negative control proving the old two-group shape fails the one-group rule).

Updated for the new group label (assertions only): `adminNavBenchmarkLabels`, `sidebarOrderAndGroups`, `marketIndexAdminRoute`, `benchmarkDataAdminRoutes`, `nav2/nav2RiskFreeAdminRoutes`.

Operator docs that told the PO to look for the "Risk-free Rates" group now say "Market Data": `docs/nav2/po_apply_production/README.md`, `docs/nav2/po_apply_production/POST_PUSH_STEPS.md`, `docs/nav2/po_apply_0260_0262/README.md`. Older historical docs (`docs/admin/A1_*`, `docs/nav2/NAV2_PRODUCTION_RELEASE_PLAN.md`) are records and were left as written.

## Verification

- Targeted nav / admin shell suites (11 files, 783 tests): PASS after the label updates (one stale assertion in `nav2RiskFreeAdminRoutes` was fixed first).
- `eslint` on all touched TypeScript files: clean.
- `tsc --noEmit`: one error, in `tests/unit/canonicalCertResidueAllSql.test.ts` (untouched file, unrelated, present on `origin/main`); zero errors in touched files. (Needs `NODE_OPTIONS=--max-old-space-size=8192`.)
- Full `tests/unit` suite: 16426 passed, 31 failed in 17 files (862 files). None of the 17 touch the navigation group: they are `/api/admin/me` mock-shape tests, migration/secret-boundary scans, live-DEV and repo-walking tests (timeouts under load, missing DEV env). Five of them (`adminAnalyticsPhaseAMeRoute`, `promoHardeningMigrations`, `m12cServerOnlySecretBoundary`, `iiNetWorthNavRemarkPublishFlow`, `countryGateAccessMatrix`) were re-run with `adminNav.ts` restored to `origin/main` and fail identically (21 failures), i.e. pre-existing and unrelated. The other 12 were not individually baselined. `git checkout -- scripts/` run afterwards.
- Visual check at desktop and phone width: NOT PERFORMED. The sidebar needs a signed-in administrator session, which needs DEV Supabase credentials that were not available. The rendering code is unchanged and generic, so the layout and the phone-width behaviour are inherited; this is unverified in a browser.
- Production: NOT VERIFIED (not in scope).
