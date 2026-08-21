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
