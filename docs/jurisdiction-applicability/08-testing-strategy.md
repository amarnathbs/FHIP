# Testing Strategy — Jurisdiction Regression & Certification Design (spec s.50-52, s.55, s.64)

None of the test cases below were newly implemented in G0 beyond what already exists (`tests/unit/jurisdictionApplicability.test.ts`, re-run and confirmed 5/5 passing in this task). This document is the design/test-ID catalogue future waves must implement against, plus an honest statement of what is already proven vs. still open.

## GEO-01..10 — Home-jurisdiction change regression cases (spec s.50)

| ID | Scenario | Status today |
|---|---|---|
| GEO-01 | AU user → AU (no-op) | Trivially true (no code path fires) |
| GEO-02 | IN user → IN (no-op) | Trivially true |
| GEO-03 | AU user with IN holdings | **Live-data-confirmed** — `05-live-dev-usage-audit.md` §6 shows real `AU→IN` cross-border records across 4 tables today; no code path was found that would hide these (dashboard totals unconditional) |
| GEO-04 | IN user with AU holdings | **Live-data-confirmed** — same section, `IN→AU` pairs also present |
| GEO-05 | AU → IN with existing Super/SMSF | **Proven for SMSF specifically** — 73/73 PGlite + 8/8 live-DEV cert from the prior SMSF closure task, independently re-read (not re-run) in this task; **not proven for Industry/Retail Super** (currently unrestricted, so trivially "preserved" today, but untested against a *future* restriction) |
| GEO-06 | IN → AU with existing NPS/EPF | **Still cannot be tested today — the product still does not exist in the catalogue** (`02-module-matrix.md` Retirement section). **Decision PO-1 (approved 2026-08-27) resolves the product decision** (three new catalogue items authorised for Wave 3) but does not itself create the items — this test remains blocked until Wave 3 actually ships them. Not a closure blocker (spec §16 explicitly excludes "EPF/PPF/NPS not yet implemented"). |
| GEO-07 | Country missing | **Partially proven, two real defects found (unchanged status — neither fixed in this closure per hard rule).** `lib/services/jurisdiction.ts`'s own resolver fails closed correctly (unit-tested, 5/5, re-run 2026-08-27). `twinData.ts` (JA-D1) and `resilienceStress.ts` (JA-D2) do not — full bounded remediation specification, required tests, and objective exit criteria for both now defined in `04-calculation-dependency-matrix.md` §Defect Remediation Specifications (Decisions PO-4/PO-6, approved 2026-08-27). Not yet turned into an automated regression test — that is Wave 1's job (`06-implementation-waves.md`), not this closure's. |
| GEO-08 | Unsupported home jurisdiction | Cannot occur today — `country_of_residence` is a `z.enum(['AU','IN'])`, no third value is possible to write via the validated path. A raw DB write bypassing the app (e.g. direct SQL) could set a different value; `getUserHomeCountry()`'s `isKnownCountry()` guard would then correctly treat it as unresolved (fails to `null`, not to a guess) — this is the correct behaviour and was confirmed by reading `isKnownCountry()`'s implementation, not by a live test (no such row exists in DEV to test against; live query found `AU`/`IN`/`NULL` only, no unexpected third value) |
| GEO-09 | Multiple foreign holdings | Live DEV shows up to 12 cross-border investment records for the whole population, not concentrated on a single user in a way this audit's aggregate queries could isolate — a dedicated single-user test fixture would be needed to prove "one AU user owns one IN property" doesn't unlock unrelated IN retirement products; the code-level proof already exists structurally (`09-cross-border-model.md` §3 — no holdings-driven catalogue unlock logic exists anywhere), but this hasn't been exercised as a live end-to-end test |
| GEO-10 | Country change with Net Worth baseline | **Structurally proven for the modules traced** (`09-cross-border-model.md` §4 — no total-affecting code path found triggered by `country_of_residence` alone), **not yet turned into an automated before/after-snapshot regression test.** Recommend building this as a standing script (create a synthetic user, record full dashboard snapshot, change country, re-fetch, assert byte-identical except country-derived display fields) — did not build this in G0 per the "no synthetic data creation needed for this discovery task" instruction (rule 6), but strongly recommend it as the first artifact of whichever task executes Wave 1. |

## APP-01..10 — Applicability resolver certification (spec s.55)

| ID | Scenario | Status today |
|---|---|---|
| APP-01 | AU user + GLOBAL product → available | Covered by `tests/unit/jurisdictionApplicability.test.ts` ("null country_applicability = globally applicable for any resolved country") |
| APP-02 | IN user + GLOBAL product → available | Same test, symmetric case |
| APP-03 | AU user + AU HOME product → available | Covered ("AU-restricted item is available to AU, not to IN") |
| APP-04 | IN user + AU HOME product → not offered for new creation | Covered, same test |
| APP-05 | IN user + existing AU record → existing record retained | **Proven live for SMSF** (§GEO-05 above); not a pure-function unit test (inherently a DB/live-data question) |
| APP-06 | AU user + IN record → retained as cross-border | **Live-data-confirmed**, `05-live-dev-usage-audit.md` §6 |
| APP-07 | Country change → existing records retained | **Structurally proven** (`09-cross-border-model.md` §4), not yet an automated live test — same recommendation as GEO-10 |
| APP-08 | Missing home country → approved fallback policy | **Decision PO-3 (approved 2026-08-27) resolves the policy** — see `02-module-matrix.md` §Missing-country architecture for the full future flow. The resolver's own existing fail-closed behaviour (treat unresolved as "not eligible for restricted items") is confirmed correct and consistent with the approved policy; what remains unbuilt is the confirmation UI/audit-trail infrastructure (Wave 4), not the underlying resolver logic. Not a closure blocker — the 98 users remaining unconfirmed is explicitly excluded from the blocker list (spec §16). |
| APP-09 | Unsupported country → no all-country catalogue dump | Cannot occur today (§GEO-08) — structurally impossible given the enum constraint, re-confirmed live (no non-AU/IN/null value found in DEV) |
| APP-10 | Existing foreign holding remains in financial totals | **Live-data-confirmed and code-confirmed** — `lib/engines/dashboard.ts` totals are unconditional (§`04-calculation-dependency-matrix.md` Net Worth row), and live DEV shows cross-border records exist and (by the same code path) are counted |

## Negative controls (spec s.51-52) — forgery/bypass tests

| Test | Status |
|---|---|
| Hiding an AU-only new-product option for an IN user does not remove an existing AU asset from calculations | **Proven** for SMSF specifically (dashboard.ts reads `retirement_accounts.current_balance` unconditionally; the SMSF trigger never fires on read/update-of-other-fields) |
| Hiding an IN-only new-product option for an AU user does not remove an existing IN cross-border holding | **Cannot be proven yet — no IN-only restricted product exists** (blocked on the same India-retirement-catalogue gap, PO Decision #1). This is a genuine symmetry gap in what can currently be certified, disclosed rather than hidden. |
| IN user forged creation of AU-only product (SMSF) rejected | **Proven** — prior SMSF closure report's negative controls (2 of 6 attacks personally reproduced per project memory, real `42501` rejections, not FK errors) |
| A future second jurisdiction-restricted item, forged creation | Not yet applicable — no second item is restricted today. The `07-jurisdiction-standard.md` checklist requires this test be added at the moment any future item gains a restriction, using SMSF's exact test shape as the template. |

## PGlite vs. live-DEV testing standard (spec s.64) — reaffirmed, not re-derived

Reused directly from the SMSF `0090` precedent (project memory): PGlite is sufficient for schema, function, and migration-rebuild verification. Anything depending on hosted-role privileges, RLS, Auth claims, custom GUC/session behaviour, or Supabase-specific PostgREST behaviour (e.g. `assertItemCreationAllowedForUser()`'s reliance on the invoking role's own RLS-scoped read of `user_profiles`, or any future DB trigger reading `auth.uid()`) **requires live DEV verification** — a PGlite-only cert of a future gate is not sufficient to claim it is forge-proof. Every future wave's test pack must include both.

## What this task actually re-ran (not just cited)

- `npx vitest run tests/unit/jurisdictionApplicability.test.ts` → 5/5 passed, executed fresh in this task's own worktree (`D:/FHIP/.claude/worktrees/g0-jurisdiction-discovery`), not copied from the SMSF closure report.
- The live DEV usage queries in `05-live-dev-usage-audit.md` — every number there was produced by a script this task wrote and ran against the real DEV Supabase project in this session, not sourced from memory or the prior closure report.
- Everything else citing "73/73" / "8/8" / "34/34" SMSF-era cert numbers is **cited from the prior SMSF closure report's own record, re-read in this task, not independently re-executed** — this task did not re-run the SMSF cert suite itself (out of scope per rule 3: "do not let this task block on its remaining production behavioural verification", and re-running an already-certified, already-merged-to-main suite would not have added new information relevant to G0's own discovery mandate).
