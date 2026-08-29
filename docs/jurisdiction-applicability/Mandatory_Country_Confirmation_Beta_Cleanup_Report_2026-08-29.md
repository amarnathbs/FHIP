# Mandatory Country Confirmation and Controlled Beta-User Cleanup — Closure Report

**Date:** 2026-08-29
**Repository:** `D:\FHIP` (baseline analysis and Gate B production reads run from a fresh worktree at `D:\fhip-country-confirm`)
**Type:** Two-gate Product-Owner-authorised task — Gate A (build/certify), Gate B (read-only inventory)

---

## A. Executive outcome

**Gate A verdict:**
### `MANDATORY COUNTRY CONFIRMATION CONDITIONAL PASS — BOUNDED REMEDIATION REMAINS`

**Gate B verdict:**
### `BETA CLEANUP INVENTORY READY — EXACT DELETION MANIFEST AWAITS PRODUCT OWNER APPROVAL`

Deletion approval **can** be requested for the 2 `EMPTY_BETA_CANDIDATE` accounts identified below, on the exact manifest in section J, once the Product Owner has reviewed it. No account was deleted, suspended, or modified. No DEV or production write occurred. Nothing was pushed, merged, or deployed.

Gate A's remaining gaps (listed in full in sections E and O) are bounded and specific: they do not represent an open bypass of the compulsory-confirmation rule for the application's actual UI and primary API surface, but two real, disclosed residuals remain — admin API routes are not individually gated (only the admin UI pages are, via the structural layout gate), and the database-level write backstop covers the 8 foundational financial input tables named explicitly in the Product Owner's access list, not every table added across the 100+ migrations since.

---

## B. Repository baseline

| Item | Value |
|---|---|
| Date/time this task started | 2026-08-29 (repo clock; see section M for exact command timestamps) |
| Repository path analysed | `D:\FHIP` |
| `D:\FHIP` branch at task start | `feature/phase1-design-system` @ `c9e4041` — **323 commits behind `origin/main`**, confirmed via `docs/admin/FHIP_Admin_Module_Discovery_Report_2026-08-29.md`'s own methodology note and independently re-verified here (its `supabase/migrations/` only goes to `0036`, vs. `0102` on `origin/main`) |
| `origin/main` at task start | `0d9294b` — `fix(g0-wave2): make migration 0102's row-count assertions seed-state-aware` |
| Merge base (`D:\FHIP` HEAD vs `origin/main`) | `9bf45c6` |
| Working-tree status at start | Several untracked doc/report directories and 3 scratch scripts; none touched by this task |
| New branch created | `feature/mandatory-country-confirmation-beta-cleanup`, from `origin/main` at `0d9294b`, in a fresh worktree at `D:\fhip-country-confirm` (not developed in `D:\FHIP` directly, and not in the Wave 2 hotfix worktree `D:/fhip-g0-wave2`, per instructions) |
| Active worktrees found | 50 (git worktree list) — the Wave 2 hotfix worktree (`D:/fhip-g0-wave2`, branch `fix/g0-wave2-closure-hotfix` @ `2fa2090`) confirmed present but not touched |
| Migration head on `origin/main` | `0102_g0_wave2_catalogue_applicability.sql` |
| Is `0102` on `main`? | Yes, applied to `origin/main` |
| Local commit `2fa2090` status/lineage | `fix/g0-wave2-closure-hotfix` branch only, in worktree `D:/fhip-g0-wave2`; **not** on any remote branch, **not** merged, **not** pushed; confirmed unmerged/unauthoritative |
| Does `0103` exist anywhere on `main` or another active branch? | Checked every local branch and remote (`origin/*`) ref for a `supabase/migrations/010[3-9]*`/`011*` file: **only** `fix/g0-wave2-closure-hotfix` has one (`0103_g0_wave2_australian_shares_country_consistency.sql`). No collision on `origin/main` or any other branch. |
| New migration allocated | `0104_mandatory_country_confirmation.sql` — deliberately **skips** `0103` since that number is claimed (unmerged) by the hotfix branch; reusing it would create a future collision if that branch or a renumbered descendant ever merges |
| Local commits made | 7 (listed in section P; the 7th is this report itself) |
| Final local HEAD | `c8de9a8` (tip of `feature/mandatory-country-confirmation-beta-cleanup`; verify fresh with `git rev-parse HEAD`) |

---

## C. Product Owner decisions implemented

| Fixed rule (section 1.x) | Implementation |
|---|---|
| 1.1 Country compulsory, never inferred, never defaulted to AU or IN | `lib/services/countryGate.ts`'s `assertCountryConfirmedForUser()` reads only `user_profiles.country_of_residence`/`.country_confirmed_at`; the unmerged `2fa2090` hotfix's AU-default and AUD-as-eligibility-signal behaviours are explicitly **not** adopted anywhere in this change |
| 1.2 Access before confirmation | `app/(app)/layout.tsx` structurally blocks every page in that route group (all financial modules + admin) for a non-`CONFIRMED` onboarded user; sign-out/privacy/terms/confirmation-API remain reachable (section E) |
| 1.3 Existing records never deleted/hidden/rewritten by a country change | Proven live: PGlite certification changed a user's confirmed country and re-verified all 8 backstopped tables' rows were still present, unmodified (section G) |
| 1.4 Home country / cross-border / currency kept separate | No cross-border store built (explicitly out of scope); `preferred_currency` is never read by `countryGate.ts` or the confirm endpoint |
| 1.5 Beta cleanup — missing country alone is not sufficient proof | Gate B classified all 3 unresolved production accounts individually; only the 2 with zero dependent rows across every checked table are proposed for deletion, and even those await explicit Product Owner approval |

---

## D. Country-state architecture

- **Canonical field:** `user_profiles.country_of_residence` (unchanged, `char(2)` FK to `countries.country_code` — this FK already meant a malformed value could never be stored server-side; it only ever holds a value present in the `countries` reference table or `NULL`).
- **Confirmation evidence (new, migration `0104`):** `country_confirmed_at` (timestamptz, null until explicitly confirmed), `country_source` (`USER_CONFIRMED` | `ADMIN_CORRECTED`, CHECK-constrained), `country_updated_at`.
- **States, exactly as required (5.2):**

  | State | How it's produced |
  |---|---|
  | `CONFIRMED` | `country_of_residence` is a well-formed 2-letter code, present in `countries` with `is_supported=true`, **and** `country_confirmed_at` is set |
  | `COUNTRY_UNCONFIRMED` | Same value shape as above, but `country_confirmed_at` is null — this is exactly the "pre-filled AU, wizard finished, never actually confirmed" case |
  | `COUNTRY_MISSING` | `country_of_residence` is null or blank/whitespace |
  | `COUNTRY_UNSUPPORTED` | A well-formed 2-letter code not in `countries`, or present with `is_supported=false` (proven live against a real `NZ` row in the PGlite certification) |
  | `COUNTRY_INVALID` | Not a 2-letter alphabetic shape at all (only reachable pre-DB, at the API layer, before the `countries` FK would reject it anyway) |
  | `PROFILE_INCOMPLETE` | No `user_profiles` row at all (structurally rare — the signup trigger creates one synchronously — but handled distinctly, never conflated with `COUNTRY_MISSING`) |
  | `DB_ERROR` | The classification query itself failed — never silently treated as confirmed or missing |

- **Supported-country list — repository evidence, not assumption:** `supabase/seed.sql`/`combined_setup.sql`/`production_bootstrap_part09.sql` all seed **only** `('AU', true)` and `('IN', true)`; `lib/validation/profile.ts` and `lib/constants.ts` independently confirm the same two-country enum. There is currently no seeded "recognised but not yet supported" row — `COUNTRY_UNSUPPORTED` is a real, structurally-supported state (verified against a synthetic `NZ` row with `is_supported=false`) but has zero real members in production today (Gate B found 0).
- **Country source / audit:** `USER_CONFIRMED` set only by `POST /api/user/country/confirm` (dedicated, closed one-field schema — the general profile PUT cannot set either evidence field, since `profileSchema` never defines them and zod drops unrecognised keys). `ADMIN_CORRECTED` is a permitted value in the CHECK constraint but **no admin UI/API to set it was built** in this task (out of scope) — see section O, issue MCC-1. Every confirmation and every country change goes through `lib/services/countryAudit.ts` into the existing `audit_events` table (previous value, new value, actor, timestamp).
- **Currency separation:** `countryGate.ts` never reads `preferred_currency`; the confirm-country screen states explicitly that display currency does not determine country; a dedicated unit test (`countryGate.test.ts`) proves a profile carrying `preferred_currency: 'AUD'` alongside a null country still classifies as `COUNTRY_MISSING`.
- **Cross-border separation:** not built, as instructed; no schema, no UI, no store.

---

## E. Access-control architecture

- **Public routes:** marketing pages, `/login`, `/signup`, `/privacy`, `/terms` — untouched, still reachable regardless of auth or country state.
- **Confirmation routes:** `/confirm-country` (page, under the `(onboarding)` route group — no `AppShell`, avoiding the exact redirect loop a placement under `(app)` would cause), `GET /api/user/country/state`, `POST /api/user/country/confirm` — all reachable pre-confirmation by design (auth-only, via the unmodified `requireUser()`).
- **Protected pages:** every page under `app/(app)/**` — dashboard, all financial modules, admin — is now gated by one server component, `app/(app)/layout.tsx`, which independently re-derives the caller's country state (not merely trusting `proxy.ts`) and redirects to `/confirm-country` when not `CONFIRMED` (and the user has completed onboarding).
- **API guard:** `lib/api.ts`'s new `requireCountryConfirmedUser()`, applied via a single-line import alias to **187 of 188** `app/api/**/route.ts` files that previously called the plain `requireUser()` (the 188th, `reports/cron/monthly-generate`, was a false-positive match — it authenticates via a cron secret, not `requireUser`, and was correctly left untouched). Returns stable codes: `COUNTRY_CONFIRMATION_REQUIRED` (missing or unconfirmed), `COUNTRY_UNSUPPORTED`, `COUNTRY_INVALID` (422), `PROFILE_INCOMPLETE`, `OPERATIONAL_ERROR` (500 on a genuine DB error) — never flattened into a false success, never an AU/IN default.
- **Direct database writes:** migration `0104` adds a `BEFORE INSERT` trigger (`enforce_country_confirmed()`, backed by `is_country_confirmed()`) to the 8 foundational tables named in the Product Owner's own module list: `income_sources`, `expense_items`, `assets`, `liabilities`, `investments`, `retirement_accounts`, `insurance_policies`, `user_goals`. Proven live (real Postgres, via PGlite) to reject an unconfirmed user's direct INSERT on every one of the 8 tables and accept it once confirmed; `service_role` (background jobs, admin remediation) is explicitly exempted.
- **Admin handling:** admin pages (`app/(app)/admin/**`) share the exact same layout and route group as every other page — confirmed via `docs/admin/FHIP_Admin_Module_Discovery_Report_2026-08-29.md` (no `layout.tsx` of its own, no separate middleware) — so they are covered by the layout gate with **no exemption**, since the repository does not prove a separately controlled administrator path exists for remediation. **However**, the 55 `app/api/admin/**` routes are gated by a distinct function, `requireAdmin()` (`admin_users` table check), which this task did **not** modify — an admin user who is themselves country-unconfirmed would be blocked from the admin *pages* but a direct call to an admin *API* route would not independently re-check country. Disclosed as issue MCC-2 (section O) — the correct, deliberate choice given modifying `requireAdmin()` risked destabilising the one path that might genuinely need to stay open for admin remediation, and doing so safely was judged to need its own scoped review rather than a same-task bolt-on.
- **Redirect-loop prevention:** `/confirm-country` lives outside the `(app)` layout it redirects *to* from other pages avoid a self-redirect; the page's own server component redirects an already-`CONFIRMED` caller straight to `/dashboard` and a `PROFILE_INCOMPLETE`/`DB_ERROR` caller to `/onboarding`, so neither state can loop back to itself.
- **Pre-existing, disclosed, unrelated finding:** `proxy.ts`'s `isAppRoute` regex (used for its own onboarding-completion redirect) was found to already be missing `financial-data-hub`, `investment-intelligence`, `forecast` and `profile` — a defect that predates this task. It was **not** fixed (out of scope — "do not fix unrelated defects"), and does not weaken this task's own guarantee because `app/(app)/layout.tsx` covers those exact routes structurally regardless of `proxy.ts`'s regex. One line was added to that regex — `confirm-country` itself — since registering a brand-new route into an existing mechanism is a direct, in-scope consequence of adding that route, not a fix to the pre-existing gap.

---

## F. Existing-user transition

Provenance could not be established purely from application code for historical AU/IN values — direct evidence:

- `app/(onboarding)/onboarding/OnboardingWizard.tsx`'s country selector defaults to `'AU'` (`INITIAL.country_of_residence = 'AU'`) with **no blank option**, meaning a user who does not deliberately change the dropdown ends up with `country_of_residence='AU'` regardless of whether they ever looked at that field.
- The general profile PUT (`app/api/user/profile/route.ts`) lets a signed-in user silently change `country_of_residence` today with no distinct confirmation step (fixed in this task — see section E; before this change, that silent-change path existed).

Given this, migration `0104` adds `country_confirmed_at`/`country_source` as **new, empty** columns — it does **not** backfill or stamp any existing row as confirmed. Every existing profile, AU/IN or otherwise, transitions to `COUNTRY_UNCONFIRMED` (if its value is a supported code) or `COUNTRY_MISSING` (if null) under the new gate, and must go through `/confirm-country` once. This was verified against real production data (Gate B, section I): the 2 production profiles with a populated, supported country (`AU`) will both require a one-time reconfirmation click before they regain application access — their underlying financial data is completely unaffected (see section G).

| Existing profile state (Gate B production reality) | Count | Transition under 0104 |
|---|---:|---|
| Non-null, supported country (`AU`) | 2 | `COUNTRY_UNCONFIRMED` — requires one-time reconfirmation |
| Null country | 3 | `COUNTRY_MISSING` — requires confirmation (as today, but now enforced) |
| Invalid/unsupported/blank | 0 | n/a — none exist in production today |

No backfill was applied to DEV or production in this task, consistent with instructions.

---

## G. Existing-data preservation

Proven live against a real Postgres engine (PGlite, not a mock), not merely asserted:

1. A confirmed test user's `assets` row (`current_value=1000`) was inserted, then the same user's `country_of_residence` was changed (simulating the section 5.7 reconfirmation-reset flow) from `AU` to `IN`, resetting `country_confirmed_at`/`country_source` to null.
2. The exact same row was re-read afterwards: **`asset_name`, `current_value` both unchanged**, row still present, still owned by the same user.
3. All 8 backstopped tables were re-counted for that user after the country change: **every one still showed exactly 1 row** (`[1,1,1,1,1,1,1,1]`) — nothing deleted, hidden, or reclassified.
4. No numeric reconciliation drift is possible by construction: this task's gate never touches, recalculates, or re-derives any financial value — it only reads two new, additive columns to decide access. **Maximum financial-preservation variance: 0** (exact, not approximate — no calculation path exists that could introduce variance).

---

## H. User experience

`/confirm-country` (screenshots not applicable — this is a server-rendered Next.js page reviewed by source and by full production build, not a live browser session, given the environment constraints of this task):

- Explains, in the Product-Owner-suggested wording (lightly adapted to the existing tone), that country of residence drives financial rules/terminology/products — explicitly not citizenship, not preferred currency, not investment location.
- States cross-border assets can be added separately once available, and that display currency never determines country.
- Uses a native `<select>` (full keyboard operability, screen-reader label via `<label htmlFor>`), `aria-required`, `aria-invalid`, `aria-describedby` wiring an inline error message, and `role="alert"` on both the field error and the top-level submission error.
- Blocks blank submission (disabled until a value is chosen, plus an explicit touched/blur check) and double submission (`disabled={submitting || done}` on the button, guarded again inside the submit handler).
- Distinct rendered copy for the `COUNTRY_UNSUPPORTED` and `COUNTRY_INVALID` states (a labelled `role="alert"` banner above the form).
- Sign out, Privacy, and Terms links remain visible on the screen itself, not just reachable by URL.
- Server-side pre-classification avoids a hydration mismatch (the initial state and current-country props are computed server-side, not guessed client-side) and avoids a redirect loop (section E).

**Verified:** production build succeeds and lists `/confirm-country` as a real, server-rendered (`ƒ`) route alongside every other protected page (section M). **Not verified in this task** (environment constraint — no live browser session was available for this backend/architecture task): actual device/viewport rendering, live screen-reader behaviour, and an end-to-end OAuth-return/expired-session click-through. Disclosed as issue MCC-3 (section O) rather than claimed.

---

## I. Production cleanup inventory

Read-only, live, run 2026-08-29 against `https://twwpnltizhtjxhamyoxt.supabase.co` via `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` from `.env.local` (confirmed correct by the Product Owner in an earlier session, per this task's own operational note). **Every request was a GET** — PostgREST reads and the GoTrue admin user-list endpoint. No write of any kind was made. The committed script `scripts/mcc_production_readonly_audit.mjs` reproduces this exactly; it was run for real and its output is what populates this section (also independently cross-checked by hand against the raw PostgREST responses before the script existed).

**Important note on scale:** the Product Owner's background context cited "98 missing-country profiles" as a 2026-08-26 snapshot. A **fresh** read today found only **5 total profiles in this production project**, of which 3 are missing country — a large, genuine discrepancy from the cited figure. This was independently reproduced twice (once ad hoc, once via the committed script) with identical results both times, and cross-checked 1:1 against the GoTrue admin user list (also 5). This report states the number actually measured today, per this task's explicit instruction to treat the 98 figure as superseded, rather than reconciling or explaining the gap (that would require information outside this task's evidence — possibly a different project/environment, a database reset, or the original count having included DEV — none of which this task's read-only production credentials can confirm).

| Metric | Value |
|---|---:|
| Total authenticated (auth) users | 5 |
| Total profiles | 5 |
| Profiles with supported country (AU/IN) | 2 (both AU) |
| Profiles with null country | 3 |
| Profiles with blank/whitespace country | 0 |
| Profiles with invalid country | 0 |
| Profiles with recognised-but-unsupported country | 0 |
| Auth users without a profile | 0 |
| Orphan profiles without an auth user | 0 |
| Country distribution | `{AU: 2, missing: 3}` |
| Creation-date distribution | 2026-08 (all 5 — 2026-08-04, 08-06 ×2, 08-10 ×2) |
| Last-sign-in distribution | 1 never signed in; 4 signed in between 2026-08-06 and 2026-08-27 |
| Subscription/payment linkage | 0 — all 5 accounts are on `user_entitlements.plan_tier = 'free'`; no billing/Stripe table found anywhere in the schema (corroborates `docs/admin/...`'s independent finding of "no admin visibility [into subscriptions] ... no Stripe integration") |
| Financial-record linkage | 2 of 5 accounts hold real financial data (one substantially: 5 income, 24 expenses, 11 assets, 5 liabilities, 3 investments, 3 retirement accounts, 3 goals, 1 household; one minimally: 1 goal, 1 household). The other 3 hold zero rows across every checked table. |

---

## J. Proposed deletion manifest summary

Masked — no raw email or complete UUID. Restricted exact identifiers are in the local-only manifest (section L).

| Candidate | Classification | Financial rows | Other dependencies | Proposed action | Evidence | Risk |
|---|---|---:|---:|---|---|---|
| MCC-C1 | UNCERTAIN | 0 | 0 | MANUAL_REVIEW | Null country, email unconfirmed, never signed in — but the email domain is a real, identifiable Australian company, not a disposable-looking pattern. Spec 7.2: "email naming patterns alone are not sufficient proof" cuts both ways — it is also not sufficient proof of disposability. | Could be a genuine prospective user who never verified; preserve pending explicit review. |
| MCC-C2 | EMPTY_BETA_CANDIDATE | 0 | 0 | PROPOSE_DELETE | Signed in once (Google OAuth) the same day as account creation, completed zero onboarding, holds zero rows in every one of the 8 financial tables and every other checked dependency table (households, consents, audit_events, financial_records_audit, reports, report_generation_runs, user_entitlements). | Low — genuinely empty by every measure checked; still requires explicit Product Owner sign-off before any deletion occurs. |
| MCC-C3 | EMPTY_BETA_CANDIDATE | 0 | 0 | PROPOSE_DELETE | Identical profile to MCC-C2 (signed in once via Google the same day as creation, zero rows everywhere). | Low — same basis as MCC-C2. |

Two additional production accounts (not "unresolved" — both carry a populated, supported `AU` value) are **not** part of this cleanup inventory but are flagged for the Gate A transition (section F): one holds substantial real financial data and signed in as recently as 2026-08-27 (very likely the Product Owner's own or a real active tester's account); the other holds minimal but real data (a goal and a household). Both are explicitly preserved and out of scope for any deletion consideration.

**Total dependent rows proposed for deletion (MCC-C2 + MCC-C3 combined, across every checked table): 0.**

---

## K. Preservation and manual-review register

- **MCC-C1** — preserved, `MANUAL_REVIEW`. Real corporate email domain, unconfirmed email, zero data. Not conclusively classifiable as disposable from data alone; a Product Owner with organisational context (e.g. recognising the domain, or checking for an out-of-band signup request) is better placed to decide.
- **The 2 populated `AU` production accounts** — preserved unconditionally. One holds substantial real financial data across 8 tables and signed in yesterday relative to this task; the other holds a goal and household. Neither is a cleanup candidate under any classification in this task; both simply need to go through the new one-time reconfirmation screen once `0104` and this branch are deployed.
- **All shared/reference data** (`countries`, `currencies`, `master_financial_items`, `resource_posts`, `benchmark_datasets`, `user_entitlements`) — never a deletion target under any account's cleanup, and explicitly hard-coded as never-touched in `scripts/mcc_cleanup_dry_run.mjs`.

---

## L. Cleanup tooling

`scripts/mcc_cleanup_dry_run.mjs` (committed, never executed against production in `--execute` mode in this task):

- **Dry-run by default**; `--execute` is a separate, explicit flag.
- **Immutable allowlist only**: requires `--approval-file=<path>` pointing at a JSON artifact with a literal `approved_auth_user_ids` array of UUIDs — verified by hand to refuse an empty array, a non-UUID entry, and any invocation with no approval file at all.
- **No pattern-based targeting is possible** — the script has no query, filter, or classification logic of its own; it only ever iterates the literal ids supplied.
- **Live pre-deletion counts**: recomputes exact dependent-row counts per approved id, per table, at run time (not trusting a stale manifest) — verified by hand against the 2 real `EMPTY_BETA_CANDIDATE` ids (both `0` across every table, matching section I/J exactly).
- **Drift detection**: if the approval file also carries `approved_dependency_counts`, the script refuses to proceed on any mismatch against the fresh live counts.
- **`--execute` additionally requires** `--environment=production` (never inferred) and a `product_owner_signoff.approved_at` field in the approval file — verified by hand to refuse without either.
- **Deletion itself is deliberately not implemented.** Even with every safeguard above satisfied, the script fails closed with an explicit `NOT_IMPLEMENTED` message at the one point a real delete would begin — verified by hand. This task is not authorised to implement or apply the cleanup manifest (spec section 3), so no code path in this repository can currently delete a production account.
- **Secure manifest location**: `scripts/mcc_production_readonly_audit.mjs` writes its restricted detailed JSON manifest to `%TEMP%\fhip-mcc-restricted-manifests\` (outside the repository entirely) by default; `.gitignore` additionally now excludes `mcc_restricted_manifest*.json` and `.mcc-restricted/` as defense-in-depth in case that default is ever overridden to an in-repo path. **The restricted manifest was not committed to git** (confirmed: `git status` in the worktree shows a clean tree with no such file tracked).

---

## M. Verification evidence

| Gate | Command | Result | Exit code | Evidence |
|---|---|---|---:|---|
| Git baseline | `git fetch origin --prune && git rev-parse origin/main` | `0d9294b` | 0 | Section B |
| Migration-collision scan | Scanned every local/remote branch ref + all disposable worktrees for `supabase/migrations/010[3-9]*` | Only `fix/g0-wave2-closure-hotfix` has `0103`; no collision anywhere else | n/a (read-only scan) | Section B |
| Schema/country-field discovery | `grep`/`Read` of `0001_foundation.sql`, `0003_module2.sql`, `lib/constants.ts`, `lib/validation/profile.ts` | Confirmed AU/IN-only, `char(2)` FK to `countries`, no NOT NULL | n/a | Section D |
| `country_of_residence` consumer search | Repo-wide grep, 22 files | Reviewed; `lib/services/jurisdiction.ts` already fails closed (never defaults) | n/a | Section D, E |
| AU/IN default search | `grep "?? 'AU'"` across `lib/**/*.ts` | 10 pre-existing files use a display-only `?? 'AU'` fallback, unrelated to this gate and now unreachable pre-confirmation via the layout gate | n/a | Section O, MCC-4 |
| Currency-as-country-evidence search | Manual trace of `countryGate.ts`/confirm route | Neither reads `preferred_currency` | n/a | Section D |
| Protected-route/API-not-using-canonical-gate search | `grep -rl requireUser app/api` (188 files) vs. patched (187) | 1 false positive (cron route, correctly unpatched); 55 admin API routes use a separate `requireAdmin()`, not patched (disclosed gap) | n/a | Section E, O |
| Direct-Supabase-write search | Reviewed migration RLS patterns; confirmed owner-write policies exist on all 8 backstopped tables | DB trigger added as backstop | n/a | Section E |
| Duplicate-country-resolver search | Confirmed `lib/services/jurisdiction.ts` (JA/catalogue concern) and `lib/services/countryGate.ts` (confirmation-gate concern) are deliberately separate, non-overlapping modules | No duplication | n/a | Section D |
| TypeScript | `npx tsc --noEmit` | Clean, zero errors | 0 | Run twice, before and after final commit |
| ESLint (touched files) | `npx eslint <every file this task changed>` | Clean after fixing 2 unescaped-apostrophe errors in the new form component | 0 | Repo-wide `npx eslint .` also run to confirm the pre-existing errors found (profile page, AppShell, AdminBenchmarksClient, etc.) are **not** in this task's changed-file set |
| Focused unit tests | `npx vitest run tests/unit/countryGate.test.ts` | 15/15 passed | 0 | New file |
| Routing/API tests | `npx vitest run tests/unit/fdh9IncomeTabUx.test.ts tests/unit/iiR12PositionsProductionCompat.test.ts` | 46/46 passed after fixing 2 regressions this change caused | 0 | Section O |
| Full unit suite | `npx vitest run` (final run) | **3515/3521 passed, 5 skipped, 1 failed** | 0 (vitest itself exits 0 even with a failed test in this config) | The 1 failure (`resourcesR1_1.test.ts`) is pre-existing and unrelated — reproduced independently on a `git stash`ed clean tree with zero diff, confirmed live-DEV-dependent (fails with a schema/JWT error off-diff, times out under load on-diff) |
| Database enforcement tests | `node scripts/mcc_pglite_certification.mjs` | **26/26 passed** against a real Postgres engine (PGlite) | 0 | Full transcript in section G/E |
| Existing-record preservation | Same script, preservation section | 3 checks, all passed, 0 variance | 0 | Section G |
| Migration replay from empty | Same script, replay section | **99/99 migrations (0001→0104) applied cleanly** | 0 | First line of script output |
| Migration idempotency | Reviewed `0104`'s own statements | `ADD COLUMN IF NOT EXISTS`, `DROP TRIGGER IF EXISTS`/`CREATE TRIGGER`, `CREATE OR REPLACE FUNCTION` are all safely re-runnable; the two `ADD CONSTRAINT` statements are single-apply, consistent with every other migration in this repository's tracked-migration model | n/a | Migration file itself |
| Wave 1/Wave 2 regression | Full vitest suite includes `jurisdictionApplicability.test.ts`, `wave2CatalogueApplicability.test.ts` | Both pass | 0 | Full suite run |
| SMSF/jurisdiction DB cert cross-check | `node scripts/db-rebuild-check/smsf_jurisdiction_cert.mjs` | Fails at its first tenant-setup INSERT, because that pre-existing script's own fixture sets `country_of_residence` via a bare UPDATE without the new `country_confirmed_at` — this is an **expected, disclosed consequence** (that script will need one added field once `0104` is applied to DEV), not a regression in this task's own logic (which independently, correctly, rejected the now-genuinely-unconfirmed fixture) | 1 (expected) | Section O, MCC-5 |
| Production build | `npm run build` | Compiled successfully, TypeScript passed inside the build, full static/dynamic route table generated including `/confirm-country`, zero errors/warnings | 0 | Full log reviewed |
| Conflict-marker scan | `grep -E "^(<<<<<<<|=======|>>>>>>>)"` across every changed/new file | Zero matches | n/a | — |
| Secret scan | `grep` for service-role-key patterns, JWT prefixes, Stripe key prefixes across the diff and every new file | Zero matches | n/a | — |
| Restricted-manifest git exclusion | `git status` in the worktree; `.gitignore` review | Manifest written outside the repo; not tracked; new `.gitignore` patterns added as defense-in-depth | n/a | Section L |
| Diff-scope audit | `git diff --name-only 0d9294b..HEAD` | 205 files (197 source, 3 test, 1 migration, 3 tooling scripts, 1 `.gitignore`, and 2 accidental test-artifact timestamp bumps were found and reverted before the final commit) | n/a | Section N |
| Read-only production audit proof | `scripts/mcc_production_readonly_audit.mjs` run transcript | Every request logged was a `GET`; script contains no POST/PATCH/PUT/DELETE call | 0 | Section I |
| Zero-production-write proof | Same run; no write endpoint was ever called | 0 rows changed | — | Section I, N |
| Zero-deletion proof | `mcc_cleanup_dry_run.mjs` run in dry-run and in every `--execute` variant | Every path either refused or hit the deliberate `NOT_IMPLEMENTED` guard | 0 (dry-run) / 1 (refused/not-implemented, by design) | Section L |

---

## N. Scope and security audit

- **Source files changed:** 197 (190 under `app/api/**`, 7 elsewhere: `app/(app)/layout.tsx`, `proxy.ts`, `lib/api.ts`, `lib/services/countryGate.ts`, `lib/services/countryAudit.ts`, `app/(onboarding)/confirm-country/page.tsx`, `app/(onboarding)/confirm-country/ConfirmCountryForm.tsx`)
- **Test files changed:** 3 (`tests/unit/countryGate.test.ts` new; `tests/unit/fdh9IncomeTabUx.test.ts` and `tests/unit/iiR12PositionsProductionCompat.test.ts` fixed for a regression this change caused)
- **Migration files changed:** 1 created (`0104_mandatory_country_confirmation.sql`); 0 modified (0102 untouched, as instructed)
- **Documentation/tooling files changed:** `.gitignore` (1), 3 new scripts (`mcc_production_readonly_audit.mjs`, `mcc_cleanup_dry_run.mjs`, `mcc_pglite_certification.mjs`), this report
- **Country values changed in DEV:** 0
- **Country values changed in production:** 0
- **DEV writes:** 0 (this task never connected to a DEV Supabase project at all — DEV migration application was explicitly out of scope)
- **Production reads:** yes — `user_profiles` (all rows, no filter), GoTrue admin user list, `income_sources`/`expense_items`/`assets`/`liabilities`/`investments`/`retirement_accounts`/`insurance_policies`/`user_goals`/`households`/`consents`/`audit_events`/`financial_records_audit`/`reports`/`report_generation_runs`/`user_entitlements` (all filtered to the 3-5 real user ids involved, `select`/count only)
- **Production writes:** 0
- **Users deleted:** 0
- **Financial rows deleted:** 0
- **Emails sent:** 0
- **Push status:** not pushed
- **Merge status:** not merged
- **Deployment status:** not deployed
- **Secrets/conflict markers:** none found in any changed or new file
- **Restricted-manifest git status:** not committed; written outside the repository; `.gitignore` updated as defense-in-depth

---

## O. Remaining issue register

| ID | Issue | Severity | Blocks Gate A | Blocks cleanup approval | Owner | Required action |
|---|---|---|---:|---:|---|---|
| MCC-1 | No admin UI/API was built to set `country_source='ADMIN_CORRECTED'` — the value is a valid, permitted enum member but nothing in this codebase can currently produce it | Low | No | No | Product Owner / future phase | Decide whether admin country-correction is needed; if so, scope a small follow-up (an admin route + audit entry) |
| MCC-2 | The 55 `app/api/admin/**` routes (gated by `requireAdmin()`, not `requireUser()`) are not individually wired to the country guard — only the admin *pages* are blocked (via the layout gate) for an unconfirmed user | Medium | **Yes** | No | Engineering | Add the same guard call to `requireAdmin()` or to each admin route, in a follow-up that specifically considers whether an admin needs to act while their own country is unconfirmed |
| MCC-3 | UX/accessibility verification for `/confirm-country` is source-review + production-build-only — no live browser session (desktop/tablet/mobile viewport, real screen reader, OAuth-return click-through) was run in this task | Low | No (bounded — the same standard applied to every other page in this codebase per the admin discovery report) | No | QA | A dedicated UX pass, same as other modules received historically |
| MCC-4 | 10 pre-existing files across the codebase use a display-only `?? 'AU'` fallback (found via repo-wide search, unrelated to this task's own logic) — now unreachable pre-confirmation via the layout gate, but worth a future audit | Informational | No | No | Engineering | Optional follow-up code-health review |
| MCC-5 | Pre-existing DB-level certification scripts elsewhere in the repo (e.g. `scripts/db-rebuild-check/smsf_jurisdiction_cert.mjs`) create "confirmed" test tenants via a bare `UPDATE ... SET country_of_residence` — once migration `0104` is applied to DEV, those fixtures will need one added field (`country_confirmed_at`) to keep passing | Low | No | No | Engineering (whoever applies `0104` to DEV) | One-line fixture update per affected script, at DEV-application time |
| MCC-6 | `proxy.ts`'s pre-existing `isAppRoute` regex is missing `financial-data-hub`, `investment-intelligence`, `forecast`, `profile` — discovered during this task, confirmed pre-existing and unrelated | Low (mitigated by the structural layout gate) | No | No | Engineering | Separate, small, unrelated-defect fix — out of this task's authorised scope |
| MCC-7 | `app/api/household/route.ts` uses its own inline auth check (not `requireUser()`) and was not individually wired to the country guard | Low (no dedicated UI page found to reach it outside onboarding, where the guard is deliberately exempt anyway) | No | No | Engineering | Wire it in the same follow-up as MCC-2 |
| MCC-8 | Production population is far smaller (5 total profiles) than the cited 98-missing-country snapshot from 2026-08-26 — a real, unexplained discrepancy this task's read-only access cannot resolve | Informational | No | **Yes — must be reconciled or acknowledged before any deletion approval proceeds** | Product Owner | Confirm which project/snapshot the 98 figure referred to before approving the manifest, even though the manifest itself (2 candidates, 0 dependent rows) is independently sound |

---

## P. Local handoff

- **Branch/worktree:** `feature/mandatory-country-confirmation-beta-cleanup`, at `D:\fhip-country-confirm` (a disposable worktree off the canonical `D:\FHIP` repository; not the Wave 2 hotfix worktree)
- **Base SHA:** `0d9294b498f183353f2b586dc30e1e02f6ebac42`
- **Local commit SHAs (in order):**
  1. `70dea64` — schema + audit support (migration 0104)
  2. `3bb12db` — canonical application/API/database gate
  3. `3bc8331` — compulsory country-confirmation screen
  4. `635231a` — classification + transition unit tests
  5. `eab2ef2` — read-only audit + dry-run cleanup tooling
  6. `150d7ba` — fix 2 pre-existing fixtures broken by the new guard
  7. (this report's own commit — verify with `git log -1 --oneline` on the branch; content-hashing a commit inside its own message cannot be exact)
- **Final HEAD:** `c8de9a8` at the time this report was written (re-verify with `git rev-parse HEAD` — amending this same commit to fix a typo, as happened once already during this task, changes its hash)
- **Migration number created:** `0104` (`supabase/migrations/0104_mandatory_country_confirmation.sql`)
- **Exact diff commands:**
  - `git -C D:\fhip-country-confirm diff 0d9294b..HEAD --stat`
  - `git -C D:\fhip-country-confirm log --oneline 0d9294b..HEAD`
- **Exact test commands:**
  - `npx tsc --noEmit`
  - `npx eslint .`
  - `npx vitest run`
  - `node scripts/mcc_pglite_certification.mjs`
  - `npm run build`
- **Secure cleanup-manifest location:** `%TEMP%\fhip-mcc-restricted-manifests\mcc_restricted_manifest_<timestamp>.json` on the machine this task ran on — regenerate fresh with `node scripts/mcc_production_readonly_audit.mjs` rather than relying on that specific file, since it will be stale the moment production changes.
- **Exact next Product Owner decision required:** (1) reconcile or explicitly waive the 98-vs-5 discrepancy (issue MCC-8); (2) approve or reject the 2-account `PROPOSE_DELETE` manifest (section J) — deletion itself still requires a further, separate approval artifact per this task's own hard rule, even after this decision; (3) decide whether MCC-2 (admin API gating) should be scoped as an immediate follow-up before this branch is ever merged, given it is the one Gate A gap rated above "Low" severity.

---

# Final numerical summary

- **Gate A verdict:** `MANDATORY COUNTRY CONFIRMATION CONDITIONAL PASS — BOUNDED REMEDIATION REMAINS`
- **Gate B verdict:** `BETA CLEANUP INVENTORY READY — EXACT DELETION MANIFEST AWAITS PRODUCT OWNER APPROVAL`
- **Current `origin/main`:** `0d9294b`
- **Branch base:** `0d9294b`
- **Final local SHA:** `c8de9a8` (see note above)
- **Local commits:** 7
- **Supported countries:** 2 (AU, IN)
- **Production auth users:** 5
- **Production profiles:** 5
- **Confirmed-country profiles (post-0104 semantics — none, since 0104 is not applied to production):** 0
- **Missing-country profiles:** 3
- **Unconfirmed non-null profiles:** 2 (both AU — populated but not yet run through the new confirmation flow)
- **Unsupported-country profiles:** 0
- **Invalid-country profiles:** 0
- **Auth users without profiles:** 0
- **Proposed deletion candidates:** 2
- **Preserve-and-confirm accounts:** 2 (the populated-AU accounts)
- **Manual-review accounts:** 1
- **Accounts with financial data:** 2
- **Accounts with subscription/payment linkage:** 0
- **Total dependent rows proposed for deletion:** 0
- **Users deleted:** 0
- **Financial rows deleted:** 0
- **Production country values changed:** 0
- **Production writes:** 0
- **DEV writes:** 0
- **Source files changed:** 197
- **Test files changed:** 3
- **Migration files created/changed:** 1 created, 0 modified
- **TypeScript result:** clean (0 errors)
- **ESLint result:** clean on every touched file (0 errors, 0 warnings); pre-existing unrelated repo lint debt found and left untouched
- **Focused tests passed/total:** 61/61 (`countryGate.test.ts` 15 + `fdh9IncomeTabUx.test.ts`/`iiR12PositionsProductionCompat.test.ts` 46)
- **Security tests passed/total (DB enforcement):** 26/26 (real Postgres via PGlite)
- **Migration replay result:** 99/99 migrations applied cleanly from empty (0001→0104)
- **Build result:** success (production `next build`, zero errors)
- **Full unit suite:** 3515/3521 passed, 5 skipped, 1 failed (pre-existing, unrelated, live-DEV-dependent — independently reproduced on a clean tree)
- **Maximum financial-preservation variance:** 0
- **Production read-only audit performed:** Yes
- **Restricted manifest committed to Git:** No
- **Push status:** not pushed
- **Merge status:** not merged
- **Deployment status:** not deployed
- **Remaining Gate A blockers:** MCC-2 (admin API routes not individually gated) is the only issue rated above Low severity; MCC-1/MCC-3/MCC-4/MCC-5/MCC-6/MCC-7 are disclosed, bounded, non-blocking
- **Remaining cleanup-approval blockers:** MCC-8 (98-vs-5 discrepancy must be reconciled or explicitly waived) before final deletion approval, even though the manifest itself is otherwise sound
- **Whether the exact deletion list is ready for Product Owner approval:** Yes, for the 2 `EMPTY_BETA_CANDIDATE` accounts specifically — subject to MCC-8 being addressed first
- **Exact recommended next action:** Product Owner to (1) resolve MCC-8, (2) approve or reject the manifest in section J, (3) decide whether MCC-2 must be closed before this branch merges. No further code change, migration application, push, merge, or deployment should occur until then.

Stop after this report. No user was deleted. DEV and production were not modified. Nothing was pushed, merged, or deployed. Awaiting explicit Product Owner approval of the exact deletion manifest.
