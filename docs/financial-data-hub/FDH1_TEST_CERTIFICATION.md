# FDH-1 — Test Certification

**Executed:** 2026-08-21, Windows 10, Node 24.18.0 (per `.nvmrc`), fresh
`npm install` in an isolated git worktree at
`D:\FHIP\.claude\worktrees\agent-a2080969a26f4215f`.

---

## 1. Regression against the FDH-0 baseline

FDH-0 established the pre-FDH contract (`FDH0_REGRESSION_BASELINE.md` §5). Each
number below was **reproduced independently at the start of FDH-1**, before any
code was written, and again at the end.

| Check | FDH-0 baseline | FDH-1 start | FDH-1 end | Verdict |
| --- | --- | --- | --- | --- |
| `npx tsc --noEmit` | exit 0 | **exit 0** | **exit 0** | unchanged |
| `npx vitest run` | 14 files, 124/124 | **14 files, 124/124** | **17 files, 244/244** | +3 files, +120 tests, 0 failures |
| `npx eslint .` | 6 errors, 6 warnings | **6 errors, 6 warnings** | **6 errors, 6 warnings** | unchanged |
| `npx next build` | exit 0 (with env vars) | **exit 0** | **exit 0** | unchanged |

**Every one of the 124 pre-existing tests still passes.** The 6 lint errors and
6 warnings are the same pre-existing React/Next presentational issues FDH-0
catalogued by file and line; none is in `lib/` and none was introduced or
repaired by FDH-1. Linting the FDH surface alone
(`npx eslint lib/financial-data-hub tests/unit/fdh1*.test.ts scripts/fdh1_live_dev_verification.mjs`)
exits **0 with no output**.

The build was run with placeholder Supabase env vars, matching FDH-0's method —
this worktree has no `.env.local`, and `createServerClient()` throws at
prerender without them. This is a worktree condition, not a code defect; FDH-0
root-caused and disproved it already.

## 2. New FDH-1 tests — 120 across 3 files

### `tests/unit/fdh1SchemaContract.test.ts` — 40 tests

The repeatable schema-verification suite. It reads the four migration files from
disk, strips `--` comments (so prose about a rule cannot satisfy a test for it),
and asserts structure.

| Group | Tests | Covers |
| --- | --- | --- |
| Migration files exist and are additive | 5 | all four present; numbers ≥ 45 and distinct; **no `alter table` on any non-FDH table, no `drop`, no `update`, no `delete from`**; creates exactly the 24 declared tables and nothing else; touches none of the seven protected Input Data registers |
| Row level security | 6 | RLS enabled on 24/24; the standard owner-only policy on 14/15 user-owned tables; the append-only exception on `fdh_classification_history` (2 policies, no update, no delete); explicit `user_id` on every user-owned table; master tables read-only with exactly one policy each; **no FDH policy references `admin_users`, `service_role`, or `using (true)` on user data** |
| Money and precision | 3 | no `float`/`double precision`/`real`/`money` anywhere; `numeric(20,4)` on 7 named money columns; `numeric(5,4)` + a `[0,1]` check on 8 named confidence columns; DATE for business dates, `timestamptz` for events |
| SQL ↔ TypeScript vocabulary | 13 | 12 named enums compared set-for-set against the TypeScript arrays; plus every enum value in the schema asserted lowercase snake_case |
| Critical constraints | 9 | no full-account-number column and the 7+-digit masked-identifier guard; `amount_original > 0`; **direction and economic meaning provably not tied by any constraint**; the reconciliation tolerance rule; the purge-reference rule; structured non-executable rule definitions; **explicit `ON DELETE` on all 85 foreign keys**; a `user_id` index on every user-owned table |
| Privacy | 4 | all four purgeable columns are nullable |

### `tests/unit/fdh1Domain.test.ts` — 58 tests

| Group | Tests | Covers |
| --- | --- | --- |
| Transaction validation | 10 | valid transaction; invalid currency; zero/negative amount; excess decimal precision; confidence outside `[0,1]`; reporting amount/currency pairing; **FX rate with no date**; posting date before transaction date; `user_id` never accepted from a caller; null raw description accepted |
| Direction ≠ meaning | 3 | **all 13 economic types accepted in both directions (26 combinations)**; signed-amount derivation; refusal to sign a non-positive magnitude |
| Financial precision | 6 | AUD cent round-trip (6 values); INR paise round-trip incl. crore scale (5 values); exact summation where float fails; tolerance comparison; `numeric(20,4)` bounds; large amount in both signs |
| Allocations | 10 | exact reconciliation; ten-way split; under-allocation; over-allocation; one-minor-unit percentage rounding absorbed and two rejected; currency mismatch; duplicate sequence; empty set; **draft may be incomplete but never invalid**; single-row schema |
| Document lifecycle | 7 | full happy path; arbitrary changes refused; failure retryable but never approvable; terminal states; edge-list consistency; schema-level transition validation requiring an error code; purge eligibility only after approval; purge machine independence |
| Privacy lifecycle | 5 | purge patch clears the storage reference; transaction patch clears only raw strings; refusal to purge before a clean description exists; null storage reference accepted; filename rejects path/traversal/control characters |
| Account contract | 4 | masked identifier accepted, full AU and Indian account numbers rejected; no full-identifier field exists at all; **AU and IN both supported, US rejected**; closed account needs a closing date |
| Links, review, reconciliation, provenance | 6 | transfer with an un-imported counterpart persists; confirmed link needs both sides; self-link refused; review context rejects raw narrative; review item must be about something; **failed reconciliation can never be recorded as successful**; provenance links document + parser version; parser version with no parser refused |
| Classification | 5 | structured user rule; rule type must agree with match kind; **regex/expression/SQL rule definitions rejected**; no-op action rejected; user correction stays attributable and cannot be blamed on the system |

### `tests/unit/fdh1Isolation.test.ts` — 22 tests

Reads the real source tree, with `//` and block comments stripped.

| Group | Tests | Covers |
| --- | --- | --- |
| Zero downstream side effects | 5 | module non-empty; **imports no `lib/engines/**`**; imports no `lib/services/**`; **imported by nothing outside itself** (scans all of `lib/`, `app/`, `components/`); adds no route, page or component |
| Never writes Input Data | 4 | an Input Data register is named in **exactly one** file — the guard list itself; never `.from()`-queried anywhere; no Input Population proposal structure; **never imports a service-role client** |
| Investment boundary | 6 | see `FDH1_INVESTMENT_BOUNDARY.md` §7 |
| Admin boundary | 6 | no admin/storage code path; allowlist and denylist disjoint; six identity/raw columns excluded; **projection tested against a row seeded with a real user id, household id, `jane-smith-…pdf`, a file hash and a `private/…` storage path — none appears in the output**; twelve tables marked no-standing-access; no storage bucket or policy |

## 3. Negative control — the tests can actually fail

A test suite that has never failed proves nothing. Ten mutations were applied
one at a time to the real migration and source files, the FDH suite was run, and
the file was restored. **10/10 were caught.**

| # | Mutation | Result |
| --- | --- | --- |
| 1 | Drop RLS on `fdh_transactions` | **CAUGHT** |
| 2 | Weaken an owner-only policy to `using (true)` | **CAUGHT** |
| 3 | Store money as `double precision` | **CAUGHT** |
| 4 | Make `description_raw` `NOT NULL` (blocks the purge) | **CAUGHT** |
| 5 | Add a `full_account_number` column | **CAUGHT** |
| 6 | Leak `raw_document_storage_reference` into the admin allowlist | **CAUGHT** |
| 7 | Import `lib/engines/dashboard` into an FDH service | **CAUGHT** |
| 8 | Add a competing `fdh_holding_snapshots` table | **CAUGHT** |
| 9 | Let a reconciliation pass outside its tolerance | **CAUGHT** |
| 10 | Infer economic meaning from direction | **CAUGHT** |

`git status` after the run confirmed every file restored byte-for-byte.

## 4. Real defect found and fixed during this phase

The `ON DELETE` test failed on first run: **16 foreign keys to `countries`,
`currencies` and `fdh_source_types` had no explicit `ON DELETE` clause**,
inheriting Postgres's implicit `NO ACTION`. The FDH-1 specification requires
explicitly chosen deletion semantics. All 16 were changed to `on delete
restrict` — reference data in use must not be deletable from under a financial
record. This is a strict improvement on migrations `0001`–`0030`, where such
foreign keys leave the behaviour implicit.

Two test-design errors were also corrected rather than papered over:

* The Input-Data-register scan flagged `constants/tables.ts`, which legitimately
  *declares* the protected list. Rather than exempting the file, the test now
  asserts the registers are named in **exactly one** file and adds a second test
  that no file — including that one — ever `.from()`-queries a register.
* A naive `ii_x → fdh_x` name mapping flagged `fdh_transactions` against
  `ii_transactions`. Renaming would have been the wrong fix, since the two are
  genuinely different entities. The name check was narrowed to the five
  unambiguous canonical entities and **replaced** for this case by a structural
  test proving `fdh_transactions` carries no units/NAV/ISIN/folio/instrument/
  scheme and is a cash ledger. That is a stronger guarantee, not a weaker one.

## 5. What was NOT tested, and why — read this

### 5.1 Live database RLS: NOT EXECUTED

**The FDH migrations have not been applied to the DEV database.** A read-only
probe of project `vqycarelcoijzwlpkpcz` on 2026-08-21 returned **0 of 24 FDH
tables present** (HTTP 404 / `PGRST205` for every one).

This environment has **no `psql`, no Docker, no local Postgres, and no
SQL-execution RPC** on the Supabase project (`exec_sql`, `execute_sql`, `sql`
and `run_sql` were all probed and all returned `PGRST202`). DDL therefore cannot
be applied programmatically from here. Migrations `0045`–`0048` must be applied
through the Supabase SQL editor by someone with console access.

**Therefore no live cross-household RLS exploitation attempt was run, and none
is claimed.** Every RLS statement in this phase is a statement about the
migration SQL as written, verified by parsing the real files.

`scripts/fdh1_live_dev_verification.mjs` closes the gap the moment the
migrations land:

```
node scripts/fdh1_live_dev_verification.mjs        # schema probe
node scripts/fdh1_live_dev_verification.mjs --rls  # + live attack suite
```

It signs up two throwaway users and runs 27 real checks: own-household
create/read; cross-household read, update and delete denial; **tenant spoofing
by forging another user's `user_id` on insert**; master-data read allowed and
four master-data writes refused; append-only enforcement on classification
history; and anonymous read denial on all 15 user-owned tables. It cleans up its
probe row and applies no DDL. Run with no FDH table present it exits 2 and
refuses to pretend.

### 5.2 Playwright E2E: NOT EXECUTED

Same reason FDH-0 gave: `playwright.config.ts:7` loads `.env.local`, absent in
this worktree, and the specs create real Supabase users and write real rows.
FDH-1 adds no user-facing surface, so there is nothing new for them to cover.
**A deliberate omission, not a hidden failure.**

### 5.3 Migration application: NOT PERFORMED

Per §5.1. The migrations have not been executed against any Postgres instance,
so "applies cleanly" is **not** claimed. What *is* verified: they are additive
only, create exactly the declared tables, alter nothing pre-existing, drop
nothing, mutate no existing row, and are internally consistent with the
TypeScript contracts. **No database state was manually edited to make any test
pass** — no database was touched at all.

## 6. Reproduction

```bash
npm install
npx tsc --noEmit                                    # exit 0
npx vitest run                                      # 17 files, 244 tests
npx eslint .                                        # 6 errors, 6 warnings (pre-existing)
npx eslint lib/financial-data-hub tests/unit/fdh1*.test.ts   # clean
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder \
  npx next build                                    # exit 0
node scripts/fdh1_live_dev_verification.mjs         # 0/24 tables present today
```

---

# 7. Live DEV Certification — 2026-08-21

**This section supersedes §5.1, §5.2 and §5.3 above**, which recorded that live
verification had not been possible. It has now been performed. The statements in
§5 remain as an accurate record of the state at the time they were written and
have not been edited.

## 7.1 Environment

| Field | Value |
| --- | --- |
| Supabase project ref | `vqycarelcoijzwlpkpcz` |
| Host | `vqycarelcoijzwlpkpcz.supabase.co` |
| Classification | **DEV** |
| Credentials source | `D:\FHIP\.env.local` (`NEXT_PUBLIC_SUPABASE_URL`) |
| Production database | **NOT TOUCHED** — no production credential was loaded, resolved or used at any point |
| Branch / commit | `feature/financial-data-hub-fdh-1-foundation` @ `315749d` |

## 7.2 Migration application

Migrations `0045`–`0048` were **already applied** to DEV by the Product Owner
through the Supabase SQL editor — this project's only DDL mechanism. Closure
therefore **verified** rather than re-applied, which is the correct action:
re-running the DDL would have failed on existing objects.

The applied state was confirmed by schema effect, not by any "migration
succeeded" message:

* **24 / 24 FDH tables resolve live** (HTTP 200, service role).
* `fdh_source_types` holds its **9 migration-seeded rows** — proving the
  migration *body* executed, not merely that tables exist.
* Every other FDH table is empty, exactly as FDH-1 intends (master data is
  FDH-2 scope).

**Capability limits, established by test rather than assumption.** This agent
confirmed it has no DDL path of its own: `exec_sql`, `execute_sql`, `run_sql`
and `admin_exec` all return `PGRST202`; `information_schema`, `pg_catalog` and
the `supabase_migrations` ledger all return `PGRST106` ("Only the following
schemas are exposed: public, graphql_public"). Live schema facts below were
therefore established from the **PostgREST OpenAPI definition** plus **real
database behaviour**, never from a catalog query.

## 7.3 Live schema verification (expected vs actual)

Expected values are derived by parsing migrations `0045`–`0048`; actual values
are read from live DEV. Reproduce with
`node scripts/fdh1_closure_fk_reconcile.mjs`.

| Property | Expected (from migrations) | Live DEV | Result |
| --- | --- | --- | --- |
| FDH tables | 24 | 24 | match (0 missing, 0 extra) |
| Primary keys | 1 per table | 1 per table | match |
| Foreign keys, total | 85 | 85 (reconciled, §7.4) | match |
| FKs without explicit `ON DELETE` | 0 | 0 | match |
| Tables with RLS enabled | 24 / 24 | 24 / 24 (behaviourally confirmed) | match |
| Per-table FK counts | 24 tables | all 24 match exactly | match |

## 7.4 Foreign key count — the 85 vs 68 reconciliation

A naive live count returns **68**, not the 85 previously reported. This is fully
explained and is **not** drift:

| Source | Count |
| --- | --- |
| FKs defined in migrations `0045`–`0048` | **85** |
| — targeting `public.*` (PostgREST annotates these) | 68 |
| — targeting `auth.users` (cross-schema; `auth` is not an exposed schema, so PostgREST cannot annotate them) | 17 |
| FKs observed live via OpenAPI | **68** |
| 68 + 17 | **85 — reconciles exactly** |

The 17 are the 15 `user_id` columns plus
`fdh_classification_history.changed_by_user` and `fdh_review_items.resolved_by`.
Set comparison shows **defined-but-not-live: NONE** and **live-but-not-defined:
NONE**. Delete actions break down as 32 `cascade`, 30 `set null`, 23 `restrict`.

All three delete actions were additionally confirmed **behaviourally** on live
DEV: cascade (deleting an account removed its transactions), restrict (an
in-use institution could not be deleted, HTTP 409) and set null (deleting a
merchant nulled `fdh_transactions.merchant_id`).

## 7.5 The 27-check RLS suite — and why the first run was not yet evidence

`scripts/fdh1_live_dev_verification.mjs --rls` reports **27/27 passed**. Run
against DEV as found, **16 of those 27 checks were vacuous**:

* the 15 "anon cannot read `<table>`" checks assert *0 rows returned* — but
  every one of those tables held **0 rows**, so the assertion passes identically
  with RLS switched off;
* the append-only check `PATCH`ed
  `fdh_classification_history?id=eq.00000000-…-000000000000`, a row that does
  not exist, so "0 rows changed" was guaranteed regardless of policy.

Only 11 checks (the 6 account-isolation checks, which had a real row, and the 5
master-data `403`s, which are true policy denials) were genuine on that run.

`scripts/fdh1_closure_certification.mjs` was written to close this. It runs the
**same 27 checks**, unchanged in meaning and count, but only after seeding a
real synthetic object graph owned by user A across **all 15 user-owned tables**,
and it carries a **negative control**: the service role must *see* every row
that anon and user B cannot. If the control fails the run aborts rather than
reporting a meaningless pass.

**Result: 27/27 with the negative control passing and every table non-empty.**
The full enumerated table is in the closure report. Wider run: **105 / 106
checks pass**, the single non-pass being finding **FDH1-F1** (§7.6), which is
recorded deliberately rather than suppressed.

Additional live coverage beyond the mandated 27: per-table cross-user isolation
across all 15 tables (read and delete), household-id spoofing, user-rule
isolation, global-rule governance (an ordinary user cannot approve a global
rule — status stayed `proposed`), master-data delete protection, and a
confirmation that isolation is not *over*-blocking (user B can still create its
own rule).

## 7.6 Finding FDH1-F1 — cross-tenant foreign key reference

**Severity: LOW. Not a confidentiality breach. Not fixed here (out of scope).**

Postgres does not apply RLS to foreign-key validation. A user B can therefore
`INSERT` a row **that B itself owns** (`user_id = B`) whose
`financial_account_id` points at an account owned by A. The insert returns 201.

This is **not** ownership spoofing — check 06 confirms B cannot write a row
carrying A's `user_id` (HTTP 403). It is a referential-hygiene gap. Its
confidentiality impact was tested directly and is nil:

| Probe | Result |
| --- | --- |
| B reads A's account via PostgREST embed on the reference | `"fdh_financial_accounts": null` — RLS holds on the join |
| B reads A's account directly | 0 rows |
| A's own view of transactions on A's account | 7 rows, **all owned by A** — B's row is invisible to A |
| B enumerates account ids through any FDH read path | 0 rows — the UUID must leak out-of-band to be usable at all |

So no data crosses the tenant boundary in either direction, and exploitation
requires an unguessable UUID that FDH exposes nowhere. The forward risk is that
a *future* service-role aggregate could sum a foreign tenant's row into an
account total; no such calculation exists in FDH-1. Standard remedies are a
composite FK on `(id, user_id)` or a validation trigger. **Recorded for Product
Owner decision; deliberately not fixed during closure.**

## 7.7 Financial data integrity (live)

All 34 integrity checks pass. Selected evidence:

| Property | Live result |
| --- | --- |
| Raw account identifier | `062000123456789` **rejected**; `XXXX-4321` accepted; boundary exact — 6 digits accepted, 7 rejected |
| Country | `ZZ` rejected; AU and IN both representable |
| Currency | INR original vs AUD reporting stored separately; FX metadata nullable; reporting amount without reporting currency rejected |
| Monetary precision | `1234.5600`, `987654.2100`, `999999999999.9900`, `0.0001` all return **byte-exact on the wire**; `8191.1230` shows no float drift; `numeric(20,4)` rounds a 5-dp input to `1.0001` |
| Negative amount | rejected (magnitude-only design) |
| Confidence | 0, 0.5, 1 accepted; −0.01 and 1.01 rejected |
| Direction vs meaning | `credit+transfer`, `debit+investment`, `credit+refund`, `debit+debt_principal` **all accepted** — no CREDIT⇒INCOME / DEBIT⇒EXPENSE coupling |
| Allocations | 650 = 450 + 150 + 50 persists exactly; duplicate sequence rejected (409); draft under-allocation permitted by design |
| Reconciliation | `reconciled` with variance 25 beyond tolerance 0 **rejected**; `failed` and `not_available` representable |
| Purge | claiming `purged` while holding a storage reference **rejected**; PENDING→PURGED→FAILED all transition; `description_raw` / `merchant_raw` null out cleanly |
| Provenance | `parser_id` **and** `parser_version_id` both retained |
| Review persistence | `missing_counterpart_account` stays `open`, independent of any job |
| Transaction link | `internal_transfer` persists with a NULL counterpart |
| Classification history | `unknown → expense` via `user_manual` recorded with both sides |

> A note on method: three monetary checks reported FAIL on the first run. The
> cause was the harness comparing `JSON.parse`d values, which normalise
> `1234.5600` to `1234.56`. The database was correct throughout. The harness now
> compares the **raw wire text**, which is also the stronger assertion — it
> proves the column is `numeric`, not `float8`. A test bug was fixed; no
> acceptance criterion was weakened.

## 7.8 Boundaries and blast radius

| Check | Result |
| --- | --- |
| DDL in `0045`–`0048` touching a non-FDH object | **NONE** — every statement targets an `fdh_` object |
| `ii_*` / Input Data references in the migrations | comment text only; zero DDL, zero FK |
| FDH table defining an instrument/holding/units/NAV/folio/valuation column | **NONE** — no competing canonical investment entity |
| Service-role client in `lib/financial-data-hub/**` | **NONE** — repositories import `@/lib/supabase/server` (RLS-scoped) only |
| Client component importing `lib/supabase/admin` | **NONE**; the key is non-`NEXT_PUBLIC_` and cannot reach the browser bundle |
| Existing FHIP / II / Resources row counts | unchanged (e.g. `households` 242 before and after; `expense_items` 2104; `forecast_results` 209875; `ii_instruments` 8; `resource_posts` 306) |

## 7.9 Synthetic data cleanup

All synthetic certification data was removed and the removal **verified by
re-query**, not assumed.

One real cleanup defect was found and fixed mid-closure: PostgREST's `like`
wildcard is `*`, not SQL's `%`, so the first cleanup pass silently matched
nothing and left 1 institution and 2 categories behind. Corrected, re-run, and
confirmed.

**Final state: 0 synthetic rows across all 24 FDH tables.** `fdh_source_types`
correctly retains its 9 migration-seeded rows — legitimate data, deliberately
preserved. Both throwaway auth users were deleted. `households` re-counted at
242, unchanged.

## 7.10 Regression rerun (post-live-testing)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | **exit 0** |
| `npx vitest run` | **17 files, 244 passed, 0 failed, 0 skipped** |
| `npx eslint .` | 6 errors, 6 warnings — **all pre-existing**; all 6 error files confirmed untouched by this branch (`git diff --name-only main...HEAD` returns nothing for each) |
| Existing FHIP calculation data | unchanged; no expected output was regenerated |

## 7.11 Scripts added for this closure

| Script | Purpose |
| --- | --- |
| `fdh1_closure_capability_probe.mjs` | establishes DDL / catalog access limits by test |
| `fdh1_closure_schema_inventory.mjs` | live FDH inventory from the OpenAPI definition |
| `fdh1_closure_fk_reconcile.mjs` | migration-defined vs live schema/FK/RLS diff |
| `fdh1_closure_preflight.mjs` | row counts and dependency reference data |
| `fdh1_closure_certification.mjs` | the 27 checks against real data + integrity suite + cleanup |
| `fdh1_closure_followup.mjs` | failure triage and residue cleanup |
| `fdh1_closure_preservation.mjs` | existing FHIP / II / Resources preservation check |
