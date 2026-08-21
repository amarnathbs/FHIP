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

## 5. The six new R5 tables — now proven

Migration 0044 was applied to DEV by the Product Owner and verified live
(`node scripts/ii_r5_schema_probe.mjs` → "MIGRATION 0044 FULLY APPLIED: YES",
all six tables present with every expected column).

`node scripts/ii_r5_live_dev_security_tests.mjs` → **24 PASS / 0 FAIL / 0 BLOCKED**

| ID | Check | Result | Evidence |
| --- | --- | --- | --- |
| SCHEMA-GATE-R5 | Migration 0044 applied | PASS | all six tables present |
| SEC-R5-001 | Ordinary user cannot forge an R5 analytics result for themselves | PASS | HTTP 403 `42501` |
| SEC-R5-002 | User B cannot forge a result attributed to user A | PASS | HTTP 403 `42501` |
| SEC-R5-003 | User B cannot READ user A's R5 analytics row | PASS | 0 rows visible to B |
| SEC-R5-004 | User A CAN read their own row | PASS | 1 row visible to A |
| SEC-R5-005 | User B cannot DELETE user A's row | PASS | row still present after the attempt |
| SEC-R5-006 | Owner cannot UPDATE (tamper with) their own row | PASS | `engine_version` unchanged |
| SEC-R5-007 | Ordinary user cannot declare a fake SIP series into existence | PASS | HTTP 403 `42501` on `ii_sip_series` |
| SEC-R5-008 | Ordinary user cannot insert a fund-holdings snapshot | PASS | HTTP 403 `42501` |
| SEC-R5-009 | Ordinary user cannot insert a security classification | PASS | HTTP 403 `42501` |
| SEC-R5-010 | Ordinary user cannot insert a controlled security alias | PASS | HTTP 403 `42501` |
| SEC-R5-011 | Ordinary user cannot insert a fund-holdings line | PASS | HTTP 403 `42501` |
| SEC-R5-012 | Unauthenticated anon-key requests return no user-owned rows | PASS | 0 rows across all 8 tables |
| SEC-R5-013 | Ordinary user cannot insert into `ii_fund_holdings` | PASS | HTTP 403 + ground truth |
| LIVE-R5-001 … 010 | End-to-end scenarios | PASS | delegated to the two scenario harnesses |

### An important detail in SEC-R5-005 and SEC-R5-006

Both the cross-user DELETE and the owner's UPDATE returned **HTTP 204**, which
looks like success. They are recorded PASS only because **service-role ground
truth** confirmed the row survived and `engine_version` was unchanged: RLS
filtered the statement to zero rows rather than rejecting the request.

This is exactly why every mutation check in this pack verifies against the
database rather than trusting a status code. A pack that inferred security from
the HTTP response alone would have recorded these two as FAIL — or, worse, a
naive implementation reading `204` as "deleted" would have reported a
vulnerability that does not exist.

### Scenario-harness delegation

`LIVE-R5-001 … 010` are not executed inside this DB-level pack, because they
need a running application server. They live in two dedicated harnesses, and
this pack now **reads each harness's own results file and reports what that
harness actually recorded** — reporting BLOCKED if a harness has not been run,
never PASS.

* `scripts/ii_r5_live_sip_e2e.mjs` — **26/26 PASS**
* `scripts/ii_r5_live_xray_e2e.mjs` — **32/32 PASS**

## 6. Live X-Ray adversarial results

From `scripts/ii_r5_live_xray_e2e.mjs`, against real seeded DEV holdings:

| ID | Check | Result | Evidence |
| --- | --- | --- | --- |
| LIVE-R5-010 | User B's X-Ray returns none of A's positions | PASS | `empty=true` |
| LIVE-R5-010b | A **fully-provisioned** B sees only their own holdings | PASS | B's look-through contains only `BONLY1`/`BONLY2`; zero of A's securities |
| LIVE-R5-010c | A fully-provisioned B cannot request overlap for A's fund ids | PASS | HTTP 404 "One or both of the requested funds are not held in this portfolio" |
| LIVE-R5-010d | B's own overlap request still works | PASS | HTTP 200 — proving 010c is ownership, not breakage |
| LIVE-R5-PERSIST | Result persisted with correct versioning/coverage/as-of | PASS | `engine=xray-engine-r5-v1 coverage=1 asOf=2024-06-30 snapshotIds=2` |
| LIVE-R5-NETWORTH | Look-through created NO investments/assets rows | PASS | `investments=0 assets=0` |

`LIVE-R5-010b` deliberately provisions user B with their own fund first.
Without that, the earlier `empty=true` result could have been an incidental
empty-dataset short circuit rather than a genuine isolation guarantee. `010d`
then proves the endpoint works for B's own data, so the 404 in `010c` is
specifically about ownership.

## 7. What this section does NOT claim

* It does **not** claim penetration testing beyond the RLS/API surface listed
  above — no session-fixation, CSRF, or JWT-forgery testing was performed.
* It **does** claim, with live evidence against a real database and a real
  running application: R4's forgery fix holds; all reference data (old and new)
  is write-protected against ordinary users; derived analytics cannot be
  forged, tampered with, deleted, or read across tenants; the R5 API refuses
  unauthenticated and cross-user access even for fully-provisioned attackers;
  no request parameter can widen visibility; and R5 writes nothing to any
  financial register.
