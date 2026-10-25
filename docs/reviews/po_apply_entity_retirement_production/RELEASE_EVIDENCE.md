# Release R3 evidence (entity + retirement), 26-10-2026

Branch `release/entity-retirement-20261026` = origin/main `46e79d5` plus a normal merge of `cert/dev-browser-20261022` (`6bec7ff`, the DEV-browser-certified entity and retirement work). The merge had no conflicts. The branch adds exactly the migrations 0289, 0290, 0295, 0296, 0297, 0298, 0299 and 0304 on top of main. 0294 is already on main and applied on production.

Labels: UNIT-TESTED, PGLITE-VERIFIED (real ledger replay), DEV-verified (the DEV browser certification A to G on the DEV build of this work, report `docs/reviews/DOCUMENT2_4_DEV_BROWSER_CERT_2026-10-26.md`), PRODUCTION-VERIFIED (nothing yet).

- Migration checkers: `check-migration-versions.mjs` OK (256 migrations, one file per version); `check-migration-versions-against-branch.mjs --against=origin/main` OK, no collision. Siblings scanned across every local and remote branch: 0292 and 0293 (property use), 0310 to 0313 (bank and statement jobs) are not on this branch and are not touched; 0294 is on main.
- tsc: only the two known errors. eslint on the 113 touched source files: one error, `no-explicit-any` in `BankStatementImportPanel.tsx` line 226, which is already in origin/main.
- Suites: WP-C, WP-D, WP-I, entity phase 1, SMSF, retirement, contributions, payslip, forecast, grid, liabilities, net worth, nav2, print, fund analytics, the Monthly Report entity table and the new pack suite. The only failures are on origin/main as well: `iiNetWorthNavRemarkPublishFlow`, `smsfHouseholdIsolation`, `promoHardeningMigrations` NC-M4 and `resourcesBulkImportMigration` NC-MG4 (both stop at main's already applied `0285_income_sources_tax_amount.sql`), and `nav2ReleaseCandidateSchemeKeying` NC-K6 (a source count in `documentProcessing.ts`, a file this release does not touch).
- Production style `next build` (placeholder Supabase values, not a deploy): exit 0, all routes compiled.
- The pack suite `tests/unit/entityRetirementProductionPackPglite.test.ts` (51 tests): paste files editor safe and at most 15 KB, parts exact, the schema built by the paste files equals the schema built by the migrations, A, B, V1 to V3 and the cutover on a database shaped like production before the release, including "no personal liability tagged SMSF is created" and P9 rollback.
- NOT PERFORMED: any production access, applying any SQL, a deploy.
