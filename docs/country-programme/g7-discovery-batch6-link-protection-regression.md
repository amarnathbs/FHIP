# G7 Discovery Batch 6 — Link Protection/Regression/Privacy (G7.024–G7.028)

Repo: `D:\FHIP\.claude\worktrees\agent-a9fdb5d253f9b5fff` @ `cd7b201`.

## G7.024 — Broken-link protection

**Owner:** no dedicated "link health" module exists. Dead-link placeholders live directly in marketing/public page source: `components/marketing/LandingPage.tsx`, `app/(marketing)/{about,accessibility,disclaimer}/page.tsx`. LR-9's fix: commit `c878618`.

**LR-9's fix is real and live but incomplete.** LR-9 replaced the marketing footer's `href="#"` Disclaimer and Accessibility placeholders with real pages (`app/(marketing)/disclaimer/page.tsx:9`, `app/(marketing)/accessibility/page.tsx:10`, both with first-person code comments confirming the prior state and the fix). A third dead link (landing footer's "About") was separately fixed under a different initiative (Google Entity Remediation).

**However, two more live `href="#"` placeholders remain, unrelated to LR-9's scope:**
- `components/marketing/LandingPage.tsx:168` — `<a href="#">View assumptions</a>` inside the forecasting-demo widget.
- `components/marketing/LandingPage.tsx:194` — `<a href="#">Explore Premium forecasting</a>`.

`LandingPage.tsx` is confirmed live and connected — rendered at the public root route (`app/(marketing)/page.tsx:4,81`), promoted to `/` on 2026-08-10. These are genuine, currently-reachable dead links on the site's highest-traffic page, outside the specific area LR-9 touched. **Classification: live and connected (defect).**

**Resources/Reports footer/nav areas are clean.** `PublicResourcesNav.tsx`/`PublicResourcesFooter` use only real Next.js `<Link>` routes — no placeholders. Reports pages have no dedicated footer/nav (inherit the authenticated app shell). Repo-wide `href="#"` grep found only the 2 live occurrences above plus 3 backward-referencing code comments documenting already-fixed instances.

**CI/automation:** `.github/` contains only a PR template — **no `.github/workflows` directory exists at all**, no CI pipeline of any kind, no link-checking tooling in `package.json`. **Conclusion: LR-9's fix was a one-off manual catch with zero automated regression protection** — nothing would catch the 2 remaining instances or a future reintroduction.

**Classification:** stale/dead (2 remaining LandingPage placeholders — live defect); new requirement (automated link-checking doesn't exist in any form).

## G7.025 — Premium-report regression

**Owner:** `lib/engines/reportExport.ts`, `lib/engines/reportSectionsPremium.ts`, `lib/services/entitlements.ts` (`canExportReports`), export routes, `app/api/reports/[id]/publish/route.ts`.

**Test inventory:**
- `tests/unit/reports.test.ts` — Free/general-tier suite; only Premium-adjacent assertion is a 3-line entitlement-flag truth table. No actual Premium content/country/cross-border scenario exercised.
- `tests/unit/reportSectionsPremiumStressApplicability.test.ts` — **the real Premium country/cross-border coverage.** Drives real `buildStressTesting()` against real `computeDashboard()` fixtures: AU resident with only an IN-domiciled holding (positive), AU resident with no foreign holdings (negative), AU/IN currency-country mismatch in both directions, and an **unresolved-country negative control** (`countryOfResidence: 'somewhere-unrecognised'`) proving fail-closed rather than guessing from currency — the regression test for the exact currency-derived-country defect class fixed under G0-JA-1 Wave 1.
- `tests/unit/reportsIIChapters.test.ts` — covers the other four Premium chapters (Investment Performance, SIP, X-Ray, Tax & Cost, Priority Review) but with **no country/currency dimension** — data-presence/empty-state only.
- `tests/unit/forecastReportExportEntitlement.test.ts` — LR-8's suite: Free-plan 403, fail-closed on missing entitlement, Premium-success with cache-header assertions. Country-agnostic.
- `tests/unit/reportExportDownloadCacheHeader.test.ts` — cache-header regression only.

**Conclusion:** country/cross-border Premium regression coverage is real but narrow — confined to `stress_testing`'s `currency_shock` scenario. The other five Premium chapters have zero country/cross-border test coverage. **Classification: live and connected** (the AU/IN stress-testing suite is real) / **partially wired** (Premium country coverage exists for 1 of 6 Premium sections only).

## G7.026 — Privacy and redaction

**Owner:** `lib/services/investment-intelligence/parsers/textUtils.ts` (`maskPan()`, `redactPanFromLine()`). Fix commit `3bdaead`, test `tests/unit/iiR2PanRedaction.test.ts`.

**What the fix does:** `redactPanFromLine()` is called only inside `camsParser.ts`/`kfintechParser.ts`'s `parseAccounts()`, touching only `ParsedAccountRecord.raw` (the verbatim source-statement text these II parsers retain for provenance). Per the commit itself, this field was "not yet persisted or logged anywhere downstream" — proactive hardening against a future leak vector, not a fix to an active leak.

**Scope check — is it reused by Reports? No.** `maskPan`/`redactPanFromLine` are referenced only in the II parser files and their test — zero references under `lib/engines/report*.ts`, `lib/services/report*.ts`, or any Reports component. The report-side II loader (`investmentIntelligenceReportData.ts`) explicitly calls the same orchestrators each II module's own live route calls, consuming only pre-aggregated computed dataset rows — never `ParsedAccountRecord.raw`. No PAN/account-number/folio field appears anywhere in the Reports engines.

**Conclusion:** the PAN-redaction logic is genuinely and correctly scoped only to Investment Intelligence's own parsing/provenance output; Reports has no code path that could reach the field it protects — a boundary that happens to make cross-module reuse unnecessary, though no document explicitly states this as an intentional design decision. **Classification: backend-only** (redaction fix, confined to II parsers) / **cannot verify** whether the Reports/II data boundary was deliberate vs. incidental.

## G7.027 — Negative controls (meta-topic)

**Cross-tenant report access:** strong coverage exists in two places with different durability. `scripts/r10_reports_rls_certification.mjs` (PGlite) proves cross-tenant read/write denial across all six reports-family tables, reproduces 5 known forgery attacks, and includes a negative-control-of-the-negative-control (re-applying the old permissive RLS to prove the same forgery succeeds again — not vacuous). `scripts/r10_repro_cross_user.mjs`/`r10_repro_reports_forgery.mjs` are live-DEV scripts with two disposable real users, proving cross-tenant read denial. **These are standalone Node scripts, not wired into `package.json` or any CI** (no `.github/workflows` exists) — one-off manual certification artifacts, not automated regression tests. No equivalent exists inside `tests/unit/`.

**Unauthorized export:** covered and durable — `tests/unit/forecastReportExportEntitlement.test.ts` is a real `vitest` unit test running in `npm test`.

**GENERIC-country report generation:** no test explicitly names "GENERIC" in `tests/unit/report*.ts`, but the control exists one layer up — every Reports route is gated by `requireCountryConfirmedUser()`, refusing GENERIC users before any report code executes (confirmed via `appCapability.ts:486`). The closest direct in-module test is the stress-applicability suite's unresolved-country negative control, which tests an unresolved value, not the canonical GENERIC set.

**Resources negative controls (real, tested):** `resourcesEditorR1_3.test.ts:551` (cross-user draft-read denial), `resourcesAdminRoleCtaHotfixLiveDev.test.ts:125` (anonymous role-table read denial), `resourcesPublicR1_5.test.ts` (archived/draft/scheduled exclusion from public queries, sitemap, topic listings — verified against a real live-DEV fixture set).

**Overall classification:** live and connected for unauthorized-export and Resources' own-content isolation (real CI-runnable tests); implemented but unreachable from CI for reports cross-tenant RLS (real, thorough, but only manually-run standalone scripts); partially wired for GENERIC-country report generation (enforced at the auth-gate layer correctly, but no direct report-level test asserts it).

## G7.028 — Rollback and withdrawal

**Resources: clean withdrawal, well-documented, tested.** `lib/resources/public/visibility.ts` is the single canonical policy point. `PUBLIC_STATUSES = ['published', 'review_due']` deliberately excludes `'archived'` even though the underlying RLS would technically permit reading it — a deliberate product-level decision narrower than the DB backstop (spec §11: archived → 404, same as nonexistent). `isPubliclyVisible()` gives every consuming route a second defensive check. No ISR/static-cache layer exists (`[slug]/page.tsx` has no `revalidate`/`dynamic` export, renders per-request via a cookie-driven client) and no CDN cache config exists anywhere — so no stale-reachability window at all. Proven by `resourcesPublicR1_5.test.ts`: an archived article is confirmed excluded from `getPublicResourceBySlug`, topic listing, and sitemap. **Conclusion: genuinely clean, no gap found.**

**Reports: soft-delete exists but withdrawal is incomplete — a real, previously-undetected gap.** `DELETE /api/reports/[id]` calls `archiveReport()`, which only sets `status = 'archived'` (comment: "Deletion normally archives a report rather than permanently removing it"). `listReports()` correctly excludes archived reports from the Hub listing. **However, `getReport()` — backing both the GET route and the report detail page — has no status filter at all** (`.eq('id', reportId).eq('user_id', userId).single()`, no `.neq('status','archived')`). The detail page only special-cases `status === 'failed'` — no "removed" state, no redirect, no 404 for an archived report. **Net effect: after "deleting" a report, it disappears from the list, but the exact same direct URL still renders the full report content indefinitely** — a genuinely reproducible stale-content-via-direct-URL scenario, not hypothetical. `getReportByRenderToken()` (headless PDF/print) also has no status check, only token-expiry — lower severity since tokens are short-lived. **No test exercises `archiveReport()` + `getReport()` together** — untested, not merely unfixed.

**Classification:** stale/dead for the Reports direct-URL-after-archive path (genuine, currently-live, previously undetected defect); live and connected for Resources' withdrawal path (correctly implemented, tested); new requirement for any Reports-side "removed" state, since none exists even as a stub.
