# LR-8 — Reports Hub & Navigation Consolidation: Phase Report

**As of:** 2026-09-08

## 1. LR-8 Terminal Verdict

**CONDITIONAL PASS — every built work package UNCONDITIONAL FULL PASS, live-DEV proven; not "production certified" pending only the standard post-push deployment confirmation every prior phase carries.** Discovery found the app's report surfaces genuinely more complete than the master spec's framing implied (Forecast Variance was already correctly in navigation, contrary to an LR-7 discovery finding traced to a stale checkout — see §4), so this phase's real work was narrower and more surgical than "build a hub from scratch": one real, live Free/Premium entitlement bypass (P1), one Cache-Control gap on private financial-PDF downloads (P2), one generic/collision-prone filename (P3), and a genuine "hub" gap — the Reports page never linked out to the three other generated-output surfaces that already exist. No migration.

## 2. Git / Deployment Lineage

- **Base:** `origin/main` at `5f469bc` (LR-7's commit — verified via fresh `git fetch origin main`; LR-7 confirmed in ancestry).
- **Branch:** `merge-napi-canvas-into-main` (continuous with LR-2–LR-7).
- **Feature commit:** this phase's commit (see below), including this report.
- **Merge/deploy:** pushed fast-forward to `main`; Amplify auto-deploys on push.

## 3. Production/Database/Configuration State

**No migration.** Every fix is either (a) a route-level entitlement check reusing an already-existing function (`canExportReports`), (b) an HTTP response header addition, (c) a filename-string change, or (d) new links on an existing page. No schema touched.

## 4. Discovery Truth Map

A dedicated Explore-agent discovery pass mapped every report/export surface against the actual repository — not against the master spec's framing. One important correction surfaced and was independently confirmed before acting on it: the discovery agent's first pass read the wrong checkout (`D:\FHIP` root, on a stale, divergent `feature/phase1-design-system` branch) and reported `/forecast/variance` as a nav orphan; re-run against the worktree/`origin/main`, it is confirmed live and listed in `AppShell.tsx`'s Forecasting dropdown alongside `/forecast/report` — not an orphan. This matches an LR-7 finding that turns out to have made the identical checkout mistake; both are corrected here.

| Area | Discovery verdict | This phase |
|---|---|---|
| WP-01 Report inventory | Real inventory taken: `/reports` (Monthly/Premium — only 1 of 4 advertised type codes is a real, differentiated report; the other 3 are dead/orphaned backend surface with **no live UI ever offering them**), `/forecast/report` (Consolidated Forecasting Report), `/forecast/variance` (Variance), `/financial-data-hub/activity` (Financial Activity analytics) | Documented; no code change for the inventory itself |
| WP-02 Reports Hub | `/reports` was already a real hub for the Monthly report specifically, but never linked to the other three generated-output surfaces | **Fixed** — see §5.4 |
| WP-03 Financial Activity | Confirmed: the GENERATED analytics output (`/financial-data-hub/activity/*`) and the OPERATIONAL transaction-review workspace (`/financial-data-hub/review`, `ReviewWorkspace.tsx`) are already two separate UIs; review is correctly reachable only via in-page CTAs (from Financial Activity and from Expenses' bank-statement import panel — LR-3), never a nav entry itself | Linked Financial Activity from Reports (§5.4); transaction review left exactly where it is |
| WP-04 Forecast reports | `/forecast/report` (generated) and interactive `/forecast/*` are already correctly separate; the generated report was linked from Forecasting only | Linked from Reports too (§5.4); interactive Forecasting untouched |
| WP-05 Monthly/Premium | **Confirmed already correct** — real backend content differentiation (`reportSnapshotResolver.ts`/`reportSections.ts` genuinely skip Premium-only sources/sections for a Free user, not just UI hiding) and real backend export-format gating (`[id]/exports/route.ts` calls `canExportReports()`) | No change — proven correct |
| WP-06 Variance | `/forecast/variance` already live and connected; needed only to prove it draws from the LR-FI-3-corrected baseline | **Proven, not changed** — see §5.5 |
| WP-07 Exports | Ownership enforcement on the Monthly report's export/download path is solid (verified: cannot download another user's export by id). Two real gaps found: no `Cache-Control` on either PDF-serving route; the Forecast report's filename is a static literal for every user/scenario/period | **Fixed** — see §5.2/§5.3 |
| WP-08 Navigation cleanup | No dead/duplicate report links found anywhere; nothing in this phase relocated or removed any existing route | **N/A — nothing to redirect**, see §7 |
| WP-09 Entitlement | The Monthly report's export path fails closed correctly at the API level. The Forecast report's export path had **no entitlement check at all** | **Fixed** — see §5.1, the phase's most severe finding |

## 5. Root Causes and Defects Fixed

### 5.1 Forecast report PDF export had no entitlement check at all (P1, WP-09, NEG-02)

`GET /api/forecast/report/export` called only `requireCountryConfirmedUser` — any authenticated, country-confirmed user, Free or Premium, could download the full Consolidated Forecasting Report PDF, while the sibling Monthly/Premium report's own export route has always required `canExportReports()`. **Severity: P1** (a live, real "premium feature accessible free" gap — directly the exact failure mode NEG-02 exists to catch). **Fixed:** added the identical `canExportReports(user.id, supabase)` check, returning 403 with a specific message on failure; the client (`ForecastReportActions.tsx`) now surfaces that real message instead of a generic one. **Live-verified** (§12) against the actual LRTest account, which is genuinely on the Free tier — confirmed the export was blocked with exactly the new message, proving this was a real, exploitable gap moments before the fix, not a theoretical one.

### 5.2 No `Cache-Control` header on either report-PDF-serving route (P2, WP-07, NEG-07)

Neither `app/api/report-exports/[exportId]/download/route.ts` (a 302 redirect to a signed Storage URL) nor `app/api/forecast/report/export/route.ts` (a direct PDF stream) set any `Cache-Control` header — relying entirely on framework/browser defaults for a per-user financial document. **Severity: P2** (a real, if narrow, privacy-hygiene gap — a shared/corporate proxy cache or browser back-forward cache could retain a response that should never be shared). **Fixed:** both routes now set `Cache-Control: private, no-store` explicitly. For the download route, this required replacing `Response.redirect()` (which only sets `Location`/status) with an equivalent manually-constructed `Response` carrying the same status/Location plus the new header — behaviourally identical otherwise.

### 5.3 Forecast report filename generic and collision-prone (P3, WP-07)

`"consolidated-forecasting-report.pdf"` was a static literal for every user, every scenario, every period — despite `scenario` being a real query parameter already threaded through the route. **Severity: P3** (a usability papercut, not a security or financial-integrity issue). **Fixed:** the filename is now `consolidated-forecast-report-<scenario>-<YYYY-MM-DD>.pdf`, built identically on both the server's `Content-Disposition` header and the client's blob-download `link.download` (the client uses a synthetic `<a>` + object URL, which ignores `Content-Disposition` entirely, so both sides needed the fix to actually agree). The date is today's date, not a saved period — this report has no persisted period of its own (always rendered live), so claiming a saved historical period would be dishonest; today's date is the accurate label.

### 5.4 The Reports Hub never linked to the other three generated-output surfaces (P2, WP-02/03/04)

`/reports` was a real, working hub — but only for the Monthly/Premium report. Financial Activity, the Consolidated Forecasting Report, and Forecast Variance are all real, live, generated outputs that existed nowhere in the Reports page at all, contradicting WP-02's own primary objective ("Build a clear hub grouping current/available reports"). **Severity: P2** (a discoverability/IA gap, not a broken or missing capability — every one of the three destinations was already independently reachable from its own module's nav). **Fixed:** added an "Other Reports & Outputs" section to `/reports` with three cards linking to `/financial-data-hub/activity`, `/forecast/report`, and `/forecast/variance` — pure additive links, no route moved, no duplicate calculation, matching the phase's own locks ("do not move interactive Forecasting into Reports," "do not move operational transaction review out of Expenses"). Deliberately did not add a card for the other 3 dead `reports/types` codes (`financial_health_score`, `goal_progress`, `net_worth`) — per WP-02's own explicit instruction, "do not show dead cards for nonexistent reports": no code branches on `reportType` today, so those codes would produce byte-identical retitled output, not a genuinely distinct report.

### 5.5 Variance baseline correctness — proven, not changed (WP-06)

Traced `getForecastVariance()`'s "Original forecast" retrieval (`forecastData.ts`) to confirm it reads the earliest completed `forecast_runs`/`forecast_results` row for the category+scenario — the exact table LR-7's WP-11 fix corrected for the `'goal'` category (adding live linked-investment/asset/retirement funding value to a goal's `currentAmount` before it's persisted). Since variance reads the SAME persisted table rather than a second, independent calculation, WP-06's "prove they use the corrected LR-FI-3 forecast baseline" requirement is satisfied by construction — no new code needed. Live-verified end to end (§12): `/forecast/report` and `/forecast/variance` show byte-identical `START VALUE`/`FORECAST TILL DATE`/`ACTUAL TILL DATE` figures for the Goals row, and the `ACTUAL TILL DATE` figure correctly tracked a real underlying data change (dropping from $7,000 to $2,000 once a test funding link was removed) while the frozen `START VALUE`/`FORECAST TILL DATE` baseline correctly stayed put — independently confirming both LR-7's fix and NEG-08 ("historical snapshot overwritten") hold.

## 6. Implementation

- `app/api/forecast/report/export/route.ts` — entitlement check, labelled filename, `Cache-Control` header.
- `app/api/report-exports/[exportId]/download/route.ts` — `Cache-Control` header (302 rebuilt as an equivalent explicit `Response`).
- `components/forecast/ForecastReportActions.tsx` — matching client-side filename; surfaces the real 403 message on export failure instead of a generic one.
- `app/(app)/reports/page.tsx` — new "Other Reports & Outputs" section with three cards.
- `tests/unit/fdh1Isolation.test.ts` — added `app/(app)/reports/page.tsx` to the established `FDH_APPROVED_CONSUMER_FILES` allowlist (see §11).

## 7. What Was Explicitly NOT Done, and Why

- **WP-08 (navigation cleanup/redirects): nothing was done, deliberately.** Discovery found no dead or duplicate report links anywhere, and this phase's own fix (§5.4) is purely additive — no route was moved, renamed, or removed, so there is no old route to preserve compatibility for. Building redirect infrastructure with nothing to redirect would be exactly the "work for its own sake" this programme's own instructions warn against.
- **The 3 dead report-type codes (`financial_health_score`, `goal_progress`, `net_worth`) were not built out, and `app/api/reports/types/route.ts` was not removed.** Building three genuinely distinct report types is far outside this phase's navigation-consolidation mandate; removing the orphaned route is a harmless, unrelated cleanup this phase's own "keep the branch narrow" instruction doesn't call for. Disclosed as a deferred finding (§13).
- **`canViewPremiumReport()` (confirmed dead, zero call sites) was left in place** — same reasoning: harmless, unrelated cleanup outside this phase's scope.
- **No canonical `requirePremium()` helper was introduced.** Only 3 call sites exist for Free/Premium entitlement checks across the whole codebase (now 4, with this phase's fix); introducing a shared abstraction for 4 call sites that already call the same 2-line `canExportReports()` function directly would be exactly the kind of new abstraction this pack's own instruction says to avoid when reuse already works.
- **The other 6 registers' identical latent gaps were not touched** — not applicable to this phase; see LR-7's own disclosed finding for the analogous SMSF-owner-option case, unrelated to Reports.

## 8. Financial/Data Contract

- **Current vs. future / staging vs. canonical:** unaffected — every fix this phase is either an authorization check, an HTTP header, a filename string, or a navigation link. No calculation, no canonical write path, no report-content logic was touched.
- **Reports must not create a second financial-calculation source of truth (this phase's own lock):** confirmed respected — the new Reports Hub cards are plain links to already-existing pages; nothing recomputes or re-renders report content inside `/reports` itself.

## 9. Security/Privacy/Accessibility

- **Entitlement:** the Forecast report export now fails closed at the API level exactly like the Monthly report's export, independently of any UI state (§5.1) — verified live against a real Free-tier account.
- **Privacy:** both PDF-serving routes now explicitly refuse caching of a per-user financial document (§5.2).
- **Accessibility:** the new Reports Hub cards are plain `<Link>` elements with visible text (title + description), no icon-only or color-only affordance, keyboard-operable by default (no custom click handlers).

## 10. Dedicated Tests

- `tests/unit/forecastReportExportEntitlement.test.ts` (new) — **3 tests** exercising the real route handler: a Free-plan user is refused with 403 and the PDF renderer is never even invoked (proving fail-closed-before-expensive-work, not just a late check); a user with no `user_entitlements` row at all defaults to free and is still refused (fail-closed on ambiguity, not fail-open); a Premium user succeeds and receives the labelled filename plus the `private, no-store` cache header.
- `tests/unit/reportExportDownloadCacheHeader.test.ts` (new) — **1 test** confirming the download route's 302 redirect carries the new `Cache-Control` header while still redirecting to the correct signed URL.

All 4 pass. One existing test file was modified for a correctness reason, not a behaviour change: `tests/unit/fdh1Isolation.test.ts` needed `app/(app)/reports/page.tsx` added to its established naive-substring allowlist (see §11) — the identical, already-repeated pattern from LR-3/LR-4/G4 (a plain route-string `href`, never an actual `import`/`require` of Hub module code).

## 11. Regression / Typecheck / Lint / Build

- `tsc --noEmit`: clean throughout.
- ESLint on every touched/new file: clean.
- Targeted regression: `forecastReportExportEntitlement`, `reportExportDownloadCacheHeader`, `reports`, `reportSectionsPremiumStressApplicability`, `reportsIIChapters`, `smsfHouseholdIsolation` — **74/74 pass**.
- **A genuine, self-caused test trip found and fixed before this report was written**: the first full-suite run after adding the Reports Hub cards failed `fdh1Isolation.test.ts` — the new `<Link href="/financial-data-hub/activity">` tripped the FDH isolation test's naive-substring scan for the literal string `financial-data-hub`, the exact same false-positive class documented and fixed identically in LR-3, LR-4, and the G4 closure. Fixed by adding `app/(app)/reports/page.tsx` to the test's own `FDH_APPROVED_CONSUMER_FILES` allowlist, following the file's established convention exactly (a multi-line comment naming the precedent and confirming no actual import exists) — re-run confirmed 25/25 passing.
- Full suite (post-fix): 269 passed | 2 skipped, 10 "failed" files — every one reproduced and independently confirmed pre-existing/unrelated: the same 9 `resources*` files requiring live-DEV Supabase credentials absent from this sandboxed run (disclosed since LR-6), and `aiResidualClosureFailClosed.test.ts` (the same pre-existing failure disclosed in every phase report since LR-4).
- Production build (`npm run build`): succeeds cleanly.

## 12. Live DEV

All of the following was exercised against the real hosted DEV Supabase project, through the actual API routes and rendered pages, using the existing synthetic "LRTest" account (confirmed genuinely on the Free plan tier for this test):

| Step | Action | Independently expected result | Actual result |
|---|---|---|---|
| 1 | `GET /api/forecast/report/export` as the (Free-tier) LRTest account | 403, with the new specific entitlement message | Confirmed exactly: `{"error":"Exporting the Consolidated Forecasting Report requires a premium plan. You can still view it in Forecasting."}` |
| 2 | Load `/reports` | New "Other Reports & Outputs" section renders with 3 cards, correct hrefs | Confirmed — `/financial-data-hub/activity`, `/forecast/report`, `/forecast/variance` |
| 3 | Navigate to each of the 3 linked pages directly | Each renders real content, no 404/crash | Confirmed for all 3 |
| 4 | Load `/forecast/report` and `/forecast/variance` side by side | Goals row shows identical `START VALUE`/`FORECAST TILL DATE` on both (frozen historical baseline from LR-7's own live testing, $7,000) and identical `ACTUAL TILL DATE` (correctly recomputed live, $2,000, after LR-7's test funding link was cleaned up) | Confirmed byte-identical on both pages — proves WP-06 (§5.5) and re-confirms LR-7's WP-11 fix and NEG-08 hold together |

**Zero-residue:** this phase's live-DEV verification performed only reads (the 403 export attempt renders no PDF and writes nothing) and page navigations — no synthetic data was created, so no cleanup was required.

## 13. Deferred Findings

| Finding | Owner/Phase | Severity | Why not blocking |
|---|---|---|---|
| `app/api/reports/types/route.ts` (4 report-type codes, 3 dead/never-branched-on) remains orphaned backend surface | Future phase, only if the Product Owner wants genuinely distinct report types built | P3 | No live UI ever offers the 3 dead codes, so "do not show dead cards" is not currently violated; removing the orphan route is unrelated cleanup outside this phase's mandate |
| `canViewPremiumReport()` (`lib/services/entitlements.ts`) remains dead code, zero call sites | Future phase | P3 | Harmless, kept deliberately per its own comment "for later divergence"; not this phase's concern |
| The identical `OWNER_OPTIONS`/SMSF-country gap LR-7 disclosed for the other 6 registers | LR-7's own deferred finding | Low | Unrelated to Reports; carried forward only for completeness, not newly found here |
| No live keyboard/screen-reader walkthrough of the new Reports Hub cards was performed | LR-8 follow-up or a later phase | Real coverage gap, not a known defect | Same class of gap disclosed in LR-6/LR-7's own reports |

## 14. Definition-of-Done Table

| Gate | Status |
|---|---|
| AC-01 Repository lineage | PASS — fetched `origin/main`, LR-7 confirmed in ancestry |
| AC-02 Route reachability | PASS — all 3 new hub links live-verified reachable |
| AC-03 API contract | PASS — live-verified the new 403 entitlement response shape |
| AC-04 Database truth | N/A — no schema change |
| AC-05 RLS/ownership | PASS — no new tables; existing ownership checks on the download/export routes unchanged and re-confirmed by discovery |
| AC-06 Exactly-once writes | N/A — this phase performs no new canonical writes |
| AC-07 Reload durability | PASS — the Reports Hub links and headers were verified via fresh page loads |
| AC-08 Current-vs-future flow | N/A — no calculation touched |
| AC-09 Entity consistency | N/A — no calculation touched |
| AC-10 Mobile/accessibility | PARTIAL — semantic markup correct (plain links, real text); no live keyboard/screen-reader walkthrough (deferred, §13) |
| AC-11 Error handling | PASS — the new 403 carries a specific, actionable message; no raw stack traces |
| AC-12 Observability | N/A — no background job introduced |
| AC-13 Performance | PASS — the entitlement check is one existing, already-indexed lookup; no new queries added to the Reports Hub page beyond what it already fetched |
| AC-14 Feature gating | PASS — entitlement gating live-verified fail-closed (§12 step 1) |
| AC-15 Production deployment | PASS — pushed; Amplify auto-deploys on push (not independently re-confirmed live post-deploy in this report) |
| AC-16 Production oracle | N/A this phase — no schema/canonical-write change exists to exercise separately in production; §12's live-DEV journey is the applicable oracle |
| AC-17 Cleanup | PASS — no synthetic data created this phase (read-only verification) |
| AC-18 Deferred findings | PASS — see §13, all named with owner/severity |

## 15. Next-Phase Readiness

**Yes, LR-9 (Privacy, Terms, Disclaimer, Accessibility & Account Closure) may proceed.** This phase introduced no migration, no calculation change, and no cross-phase dependency — only a real entitlement-bypass fix, response-header hygiene, and additive navigation, all live-verified.
