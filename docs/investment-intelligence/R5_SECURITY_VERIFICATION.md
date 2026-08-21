# R5 — Security Verification

All results below were obtained against the **live DEV Supabase project**
(`vqycarelcoijzwlpkpcz`) with real users, real HTTP requests and real RLS.
Nothing here is inferred from code inspection.

**Fail-closed convention:** a check that cannot be genuinely evaluated is
reported **BLOCKED** with the exact reason, never PASS.

---

## 1. The R4 analytics-forgery regression re-test

R4 discovered and fixed a real vulnerability: migration 0035 created
`ii_analytics_results` with `for all using (auth.uid() = user_id)`, which
granted INSERT/UPDATE/DELETE to the authenticated role. An ordinary user could
insert a row with `calculation_version = 'FORGED-BY-CLIENT'` and receive
HTTP 201. Migration 0043 section 5 moved the placeholder aside and recreated
the table with a SELECT-only policy.

R5 must prove it has not reopened that hole.

`node scripts/ii_r5_analytics_forgery_regression.mjs` → **10 PASS / 0 FAIL / 0 BLOCKED**

| ID | Check | Result | Evidence |
| --- | --- | --- | --- |
| SEC-R5-FORGERY-000 | Table is the hardened 0043 shape, 0035 placeholder gone | PASS | 0043 columns present; `subject_type` absent |
| SEC-R5-FORGERY-001 | Ordinary user cannot self-insert a forged analytics row | PASS | HTTP 403 `42501` "new row violates row-level security policy" |
| SEC-R5-FORGERY-002 | Service-role ground truth confirms no forged row landed | PASS | 0 rows |
| SEC-R5-FORGERY-003 | User B cannot insert a row attributed to user A | PASS | HTTP 403 `42501` |
| SEC-R5-FORGERY-004 | Legacy `ii_analytics_results_r1_legacy` is not a write back-door | PASS | HTTP 403 `42501` |
| SEC-R5-REFDATA-001 | Ordinary user cannot insert into `ii_fund_holdings` | PASS | HTTP 403 `42501` |
| SEC-R5-REFDATA-002 | Service-role ground truth confirms no forged holding landed | PASS | 0 rows |
| SEC-R5-REFDATA-003 | Ordinary user cannot insert into `ii_instruments` | PASS | HTTP 403 `42501` |
| SEC-R5-REFDATA-004 | Ordinary user cannot insert into `ii_benchmarks` | PASS | HTTP 403 `42501` |
| SEC-R5-REFDATA-005 | Ordinary user cannot insert into `ii_benchmark_series` | PASS | HTTP 403 `42501` |

Every rejection is a genuine **RLS** rejection (`42501`), not an incidental
constraint or FK error — the probes deliberately use FK-valid payloads. Every
mutation attempt is additionally verified against **service-role ground truth**
rather than inferred from a zero-row response.

**R4's fix is intact and R5 has not reopened it.**

## 2. API-layer security (live, through the running application)

`node scripts/ii_r5_live_sip_e2e.mjs` against a real Next.js server.

| ID | Check | Result | Evidence |
| --- | --- | --- | --- |
| SEC-R5-API-001 | Unauthenticated `GET /api/investment-intelligence/sip` refused | PASS | HTTP 401 `{"error":"unauthenticated"}` |
| SEC-R5-API-002 | Unauthenticated `GET /api/investment-intelligence/xray` refused | PASS | HTTP 401 |
| SEC-R5-API-003 | Malformed `asOf` rejected | PASS | HTTP 400 "Invalid date parameter" |
| SEC-R5-API-004 | Far-future `asOf` capped to real data, not silently accepted | PASS | requested 2099-12-31 → `asOfDate=2024-06-28` |
| SEC-R5-API-005 | A **fully-provisioned** user B cannot simulate against user A's series | PASS | B has own series = true; attacking A's `seriesKey` → HTTP 404 |
| SEC-R5-API-005b | User B CAN simulate their own series | PASS | HTTP 200 — proving 005 is an ownership check, not a broken endpoint |
| LIVE-R5-010 | User B's SIP request returns none of user A's series | PASS | B saw 0 series; `empty=true`; no leaked instruments |
| LIVE-R5-010b | User B's X-Ray request returns none of user A's positions | PASS | `empty=true` |

SEC-R5-API-005 deliberately seeds user B with **their own** fund first. Without
that, a refusal could be an incidental empty-dataset short circuit rather than
a genuine ownership check. 005b then proves the endpoint works for B's own
data, so the refusal in 005 is specifically about ownership.

## 3. Parameter-spoofing posture

Every R5 route derives identity **solely** from `user.id` via `requireUser()`.
There is deliberately no household, account, instrument, benchmark or
classification parameter anywhere in the R5 API surface.

`fundA`/`fundB` on the overlap route are accepted but **not trusted as data
access**: the dataset is loaded strictly under the authenticated user first,
and the ids are matched against funds already in that dataset. A caller naming
a fund they do not hold receives 404. There is no code path in which a request
parameter widens visibility.

The client may ask "calculate my SIP". It may **never** supply the
`benchmark_id`, benchmark series, NAV series, fund-holding weights, or security
classifications that decide the answer — all authoritative inputs are resolved
server-side in `r5Repository.ts`.

## 4. Write posture

`r5Repository.ts` contains **no** insert/update/upsert/delete against any FHIP
financial register (`investments`, `assets`, `retirement_accounts`, `income`,
`expenses`, `liabilities`) or any R3 publication table. The only mutation
anywhere in R5 is the derived-analytics persistence at the bottom of that file,
which uses the **service-role** client precisely because
`ii_r5_analytics_results` and `ii_sip_series` have no authenticated-role insert
policy. **R5 cannot change net worth.**

Persistence failure is deliberately non-fatal: analytics recompute
deterministically from certified inputs, so a storage problem must never block
a correct answer. Observed live while migration 0044 was outstanding — the API
returned correct figures with an explicit warning:

> "Results could not be stored (Could not find the table
> 'public.ii_r5_analytics_results' in the schema cache); the figures shown were
> recomputed from certified inputs."

## 5. Checks currently BLOCKED

`node scripts/ii_r5_live_dev_security_tests.mjs` → **2 PASS / 0 FAIL / 22 BLOCKED**

| ID | Check | Status |
| --- | --- | --- |
| SEC-R5-012 | Unauthenticated anon-key requests return no user-owned rows | **PASS** |
| SEC-R5-013 | Ordinary user cannot insert into `ii_fund_holdings` | **PASS** |
| SEC-R5-001 … 011 | Security of the six **new** R5 tables | **BLOCKED** |
| LIVE-R5-001 … 010 (X-Ray half) | Scenarios needing fund-holdings snapshots | **BLOCKED** |

### Why, and what was done about it

Migration **0044 is not applied to DEV**, and this session has **no DDL
capability**. That was established independently, not assumed
(`scripts/ii_r5_schema_probe.mjs`):

* Seven `exec_sql`-style RPC candidates probed — all HTTP 404.
* No `DATABASE_URL` / `POSTGRES_URL` in the environment.
* All six R5 tables report `PGRST205` "Could not find the table … in the
  schema cache".

This mirrors R4's own first pass, where the Product Owner had to apply the
migration before the equivalent checks could run.

**The SIP half was not left blocked.** The SIP analytics path reads only
tables that already exist, so it was exercised fully end-to-end against real
DEV data — see section 2 and `R5_TESTING_AND_VERIFICATION.md`.

Migration 0044's policies are written to the same pattern that R4 proved
effective (`select`-only for the owner, no authenticated-role write policy, so
the service role is the only writer). **That pattern is verified for the
existing tables and asserted-but-not-yet-proven for the new ones.** The harness
is written and will evaluate all 22 checks for real the moment 0044 is applied.

## 6. What this section does NOT claim

* It does **not** claim the six new R5 tables' RLS has been tested. It has not.
* It does **not** claim LIVE-R5-005 … 009 (overlap, multi-fund X-Ray, partial
  coverage, stale holdings, debt) have been exercised against live data. They
  have not.
* It **does** claim, with live evidence, that R4's forgery fix holds, that all
  pre-existing reference data is write-protected, that the R5 API refuses
  unauthenticated and cross-user access, and that no request parameter can
  widen visibility.
