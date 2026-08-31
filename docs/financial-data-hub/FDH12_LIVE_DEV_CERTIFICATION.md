# FDH-12 — Live DEV Certification

Spec sections 119-134, 137, 139, 166-167, 171.

## STATUS: **DEV CERTIFIED FULL PASS** — 262 / 262 LIVE CHECKS, 0 FAIL. `0113` AND `0114` CONFIRMED IN EFFECT ON DEV.

### Round 3 — 2026-08-31 (closure)

The Product Owner re-applied `0113` and `0114` to DEV, this time pasting each
migration file in full rather than a partial selection — the suspected cause of
the round-2 non-effect. The complete live suite was then re-run from scratch,
unchanged from round 2, against real hosted DEV
(`vqycarelcoijzwlpkpcz.supabase.co`) with a real `next dev` started from this
worktree on port 3212.

```
=== RESULT: 262 PASS, 0 FAIL ===
```

**Every one of round 2's 17 failures now passes individually** — verified
label-by-label against the round-2 failure list, not merely by comparing
aggregate totals:

| Round-2 failing check | Round 3 |
| --- | --- |
| §119 FDH12-LD-1 — `approval_status` transitioned `pending -> approved` through the real RPC as the row's own owner | **PASS** — `pending -> approved (route status=200)` |
| §119 FDH12-LD-1 — approval attributed to the owning end user, not hand-set by a service role | **PASS** — `approved_by=0e4b4768-…5c4f approved_at=2026-08-30T21:55:19.630005+00:00` |
| §119 — evidence approved through the real route | **PASS** — `status=200` |
| §119 FDH12-LD-2 — the import-bridge GUC does not survive the Apply RPC | **PASS** — next owner PATCH refused `400 P0001` |
| §130 FDH12-LD-1 — approval transition / attribution / real route (3 checks) | **PASS** — `approved_by=da753732-…93db` |
| §132 FDH12-LD-1 — approval transition / attribution / real route (3 checks) | **PASS** — `approved_by=ca9561a2-…70e3` |
| §133 FDH12-LD-2 — B points B's OWN retirement account at A's import application | **BLOCKED** — `400 P0001 "retirement_accounts: cross-tenant reference — import application … belongs to a different user"`, column re-read as `null` |
| §134 — canonical apply provenance cannot be ERASED by direct REST | **BLOCKED** — `400`, value still `c8a6e158-…47e3` |
| §134 — canonical `source_type` cannot be rewritten by direct REST | **BLOCKED** — `400`, value still `retirement_statement_import` |
| §134 FDH12-LD-2 — owner forges `source_type` `manual -> retirement_statement_import` | **BLOCKED** — `400 P0001`, value still `manual` |
| §134 FDH12-LD-2 — owner forges `last_import_application_id` to their OWN real application | **BLOCKED** — `400 P0001`, value still `null` |
| §134 FDH12-LD-2 — owner forges `last_imported_at` | **BLOCKED** — `400 P0001`, value still `null` |
| §134 FDH12-LD-2 — owner forges all three provenance columns in ONE request | **BLOCKED** — `400 P0001`, value still `manual` |

17 of 17. The round-3 result file
(`scripts/fdh12-live-dev-results.json`) records `"fail": 0` with an empty
`failures` array; the full run log is `scripts/fdh12-live-dev-run.log`.

#### The strongest single indicator: the stubs are gone

Round 2's log carried **16** occurrences of
`[approval step stubbed via service role — pending migration 0113 on DEV]`,
marking every downstream check that had only been reachable through a
service-role approval stub. Round 3's log contains **zero**. Every §119 / §130 /
§132 downstream check — proposal, compare, Apply, canonical write — now runs on
top of a genuine owner-authenticated approval.

#### Independent confirmation that the migrations are the ones in the database

Behaviour alone could in principle be explained by something other than these
two files, so the guard error strings observed live were matched against the
migration source:

* `retirement_accounts: cross-tenant reference — import application % belongs to a different user` — `0114` line 105, observed verbatim live.
* `retirement_accounts: source_type/last_import_application_id/last_imported_at are import-bridge provenance and may not be written directly by the authenticated role` — `0114` line 133, observed verbatim live.
* `0113` is proven by outcome rather than by string: an owner-authenticated call
  to `fdh12_approve_retirement_statement` **succeeded and persisted**, which is
  impossible under `0112`'s body (round 1 and round 2 both proved it returns
  `400 P0001` for every possible caller).

| Run | Harness | Result |
| --- | --- | --- |
| **Live DEV — round 3** | `scripts/fdh12_live_dev_certification.mjs` | **262 PASS / 0 FAIL** |
| Live DEV — round 2 | same harness, 262 checks | 245 PASS / 17 FAIL (`0113`/`0114` not in effect) |
| Live DEV — round 1 | same harness, 218 checks | 213 PASS / 5 FAIL (defects found) |
| PGlite (real Postgres, clean rebuild) | `scripts/fdh12_certification.mjs` | **62 PASS / 0 FAIL** |
| Shared-CSV blast radius (R7 + FDH-5 + FDH-11 + FDH-12) | `vitest` | **702 PASS / 0 FAIL** (30 files) |

#### Round 3 cleanup — zero residue, independently swept

Verified exactly as round 2 was, by two methods neither of which trusts this
run's own list of ids (full output in `scripts/fdh12-live-dev-run.log`):

* **Whole-table exact cardinality** across all 15 writable tables, captured
  before the first synthetic row existed and re-checked after cleanup. All 15
  returned to baseline exactly, including the non-empty ones:
  `retirement_accounts` 367→367, `retirement_members` 287→287,
  `fdh_document_audit_events` 1811→1811, `user_profiles` 370→370.
* **Whole-table content-marker sweep** (`ilike`) for every fixture literal the
  run writes — `LiveCert`, `Tenant B Super`, `LIVECERT`, `FDH12 Live` — across
  8 table/column pairs. All 8 returned 0 rows.
* No `fdh12-livedev-*` auth user remains. The same four synthetic users from
  *earlier* phases (R9, R11, SMSF) are still on DEV; they were not created or
  removed by this run and are reported below rather than absorbed.

---

### Round 2 — 2026-08-30 (closure re-run — superseded by round 3)

The Product Owner reported that `0113` and `0114` had both been applied to DEV
with no error, and asked for the complete live suite to be re-run rather than a
narrow re-test of the two fixes. That was done. **Neither migration is in
effect in that database.** The full evidence, an independent read-only
verification script and the re-apply instructions are in
`docs/dev-apply/fdh12-0113-0114-activation/`.

**Live result: 245 PASS, 17 FAIL.** Every one of the 17 failures is one of the
two already-identified defects, still live because the fixes never reached the
database. **No new defect was found, and nothing regressed.** The suite grew
from 218 to 262 checks this round: +26 new negative controls demanded for the
two fixes, +18 for a genuine whole-table cleanup sweep.

| Run | Harness | Result |
| --- | --- | --- |
| Live DEV — round 2 | `scripts/fdh12_live_dev_certification.mjs` | **245 PASS / 17 FAIL** (262 checks) |
| Live DEV — round 1 | same harness, 218 checks | 213 PASS / 5 FAIL |
| PGlite (real Postgres, clean rebuild) | `scripts/fdh12_certification.mjs` | **62 PASS / 0 FAIL** |
| Shared-CSV blast radius (R7 + FDH-5 + FDH-11 + FDH-12) | `vitest` | **702 PASS / 0 FAIL** (30 files) |

#### Why "applied with no error" was not enough

`0113` adds no object — it **replaces** two existing functions. `0114` creates
two functions and two triggers. Checking that
`fdh12_approve_retirement_statement` merely *exists*, or calling it as the
service role and seeing `"authentication required"`, cannot distinguish the
0113 body from the 0112 body: **0112's version returns that same message.** Only
an authenticated-owner call, or reading `pg_get_functiondef`, tells them apart.
`docs/dev-apply/fdh12-0113-0114-activation/02_dev_verification.sql` does both
and prints a one-line verdict per migration.

#### The two proofs the Product Owner asked for, and what they returned

Both were run for real. Both currently FAIL, and both fail for exactly one
reason: the fixes are not in the database.

**FDH12-LD-1 — the real end-to-end journey** (`upload → parse → review →
APPROVE → compare → Apply`), driven as a real synthetic user through the actual
API/RPC chain:

```
approval_status before the real RPC call : pending
POST /rest/v1/rpc/fdh12_approve_retirement_statement  (as the row's OWN owner)
  -> 400 P0001 "fdh_retirement_statements: this field is system-authoritative
                and may not be written directly by the authenticated role"
approval_status after  : pending      approved_at: null   approved_by: null
```

Upload, parse, account/member match and evidence matching all PASS. The journey
still terminates at Approve. Everything downstream (`/proposal`, Apply, the
canonical `retirement_accounts` write) is exercised and PASSES, but only via
the harness's service-role approval stub, and every such check is labelled
`[approval step stubbed via service role — pending migration 0113 on DEV]` in
the run log so a stubbed pass can never be read as a genuine one.

**FDH12-LD-2 — the security fix.** Required outcome vs. actual:

| Sequence | Required | Actual on DEV |
| --- | --- | --- |
| Owner forges `source_type` on a hand-typed account | BLOCKED | **200 SUCCEEDED** |
| Owner forges `last_import_application_id` to their own real application | BLOCKED | **200 SUCCEEDED** |
| Owner forges `last_imported_at` to a chosen timestamp | BLOCKED | **200 SUCCEEDED** |
| Owner forges all three in one request | BLOCKED | **200 SUCCEEDED** |
| Owner erases provenance (all to null) | BLOCKED | **200 SUCCEEDED** |
| Tenant B points B's own account at Tenant A's import application | BLOCKED | **200 SUCCEEDED** |
| Authoritative Apply via `fdh12_apply_retirement_proposal` under the GUC | PASS | **PASS** |

The last row is the one that does pass, and it matters: the Apply RPC writes
all three provenance columns successfully, so `0114` — when it is finally
applied — has a working writer to let through and is not at risk of breaking
the legitimate path.

One nuance, disclosed rather than glossed: the check
*"the import-bridge GUC does not survive the Apply RPC"* also fails. That is
**not** a third defect and not a GUC leak. With no guard present at all, the
follow-up PATCH succeeds for the same reason every other PATCH in the table
above succeeds. Once `0114` is applied this check becomes a genuine GUC-leak
test; today it is simply another face of FDH12-LD-2.

#### Cleanup — zero residue

Verified two ways, neither of which trusts this run's own list of ids:

* **Whole-table exact cardinality**, captured before the first synthetic row
  existed and re-checked after cleanup, across all 15 tables this run can
  write to. All 15 returned to baseline exactly — including the non-empty
  ones: `retirement_accounts` 367→367, `retirement_members` 287→287,
  `fdh_document_audit_events` 1811→1811, `user_profiles` 370→370.
* **Whole-table content-marker sweep** (`ilike`) for every fixture literal this
  run writes — `LiveCert`, `Tenant B Super`, `LIVECERT`, `FDH12 Live` — across
  8 table/column pairs. All returned 0 rows.
* No `fdh12-livedev-*` auth user remains. Four synthetic users from *earlier*
  rounds (R9, R11, SMSF) remain on DEV; they were not created or removed by
  this run and are reported rather than silently absorbed.

---

### Round 1 — 2026-08-30 (the round that found the defects)

Migration `0112_fdh12_retirement_statement_intelligence.sql` was applied to DEV
by the Product Owner. Every live section below was then executed for real
against hosted DEV Postgres (`vqycarelcoijzwlpkpcz.supabase.co`) plus a real
`next dev` instance started from this worktree.

**Live result: 213 PASS, 5 FAIL.** All five failures are the two genuinely new
defects this round found, and both are fixed forward in migrations that have
**not** been applied to DEV. Nothing else failed.

### How the live run was grounded

* **DEV project:** `vqycarelcoijzwlpkpcz.supabase.co`, service-role for
  fixtures and inspection, real password-grant sessions for every user-facing
  call.
* **App server:** a real `next dev` from `D:/fhip-fdh12` on port 3212, proven
  to be serving THIS branch by probing
  `POST /api/financial-data-hub/retirement-statement/upload` — a route that
  exists only here — and receiving `401` (auth reached) rather than `404`.
* **Synthetic data only.** Every user is `fdh12-livedev-<tag>-<stamp>@fhip-test.invalid`.
  No pre-existing DEV data was read or written.
* **Environment note (not a product defect):** the first attempt returned `404`
  for every route nested under `[documentId]`, including FDH-11's
  already-certified `investment-statement/[documentId]/*`. A stale Turbopack
  `.next/dev` cache; removing `.next` and restarting resolved it completely.
  Recorded so a future run does not mistake it for a routing bug.
* **MCC-14 interaction:** DEV also carries the sibling branch's country-
  confirmation gate (migration `0111_mandatory_country_confirmation_delete_cascade_fix.sql`),
  which is NOT in this branch. Every synthetic user therefore confirms a country
  (`country_confirmed_at` + `country_source='USER_CONFIRMED'`) exactly as a real
  user would. FDH-12 needs no change for it.

---

# DEFECTS FOUND LIVE

Neither was reachable in PGlite, unit tests, `tsc`, the build, or the prior
round's review. Both were found by driving the real hosted chain.

> **BOTH ARE NOW CLOSED.** `0113` and `0114` are applied to DEV and confirmed in
> effect by round 3 (2026-08-31): 262 / 0, with all 17 of round 2's failing
> checks passing individually. The reproductions below are retained as the
> historical record of what was found and why the fixes exist — they describe
> DEV **before** the fixes were activated, not DEV today.

## FDH12-LD-1 — BLOCKING — RESOLVED — `fdh12_approve_retirement_statement()` could never succeed

**Nobody can approve a retirement statement, so nothing can ever be applied to
canonical Retirement.** The entire FDH-12 user journey terminates at Approve.

### Reproduction (real hosted DEV, verbatim)

A service-role-seeded statement in a clean approvable state
(`extraction_status='extracted'`, `smsf_classification='not_smsf'`,
`approval_status='pending'`, no review items), then the row's **own owner**
calls the RPC exactly as the app does:

```
seeded statement: f78b487e-f0cd-4784-a58b-484b2ff855a1 approval_status = pending
RPC status: 400
RPC body  : {"code":"P0001","message":"fdh_retirement_statements: this field is
             system-authoritative and may not be written directly by the
             authenticated role"}
after     : [{"approval_status":"pending","approved_at":null}]
service-role RPC status: 400 {"message":"fdh12_approve_retirement_statement:
             authentication required"}
```

Note the last line: the service role is refused by the function's own
`auth.uid() is null` check. **There is no caller at all that can approve.**

Through the app's own route the same failure surfaces as:

```
POST /api/financial-data-hub/retirement-statement/{id}/approve
  -> 400 {"error":"fdh_retirement_statements: this field is system-authoritative
          and may not be written directly by the authenticated role"}
POST .../proposal
  -> 409 {"error":"Approve the statement evidence before comparing it with your
          retirement accounts."}
```

### Root cause

Migration 0112 PART F guards `fdh_retirement_statements`' authoritative columns
with the FDH-11 mechanism, `if auth.role() <> 'authenticated' then return new`.
That is correct when the legitimate writer is a service-role client — which is
how the processing service writes every other authoritative column on that
table.

But one legitimate writer is not a service-role client: it is
`fdh12_approve_retirement_statement()`, a `security definer` function the **end
user** invokes. `security definer` changes the executing role; it does **not**
change `auth.role()`, which reads the request's JWT claims and still reports
`'authenticated'`. So the guard fires on the RPC's own `UPDATE` of
`approval_status` / `approved_at` / `approved_by`.

0112's own header states the correct rule and then does not follow it for this
one writer:

> * FDH-11 (0106) gates on `auth.role() <> 'authenticated'`, correct when the
>   legitimate writer is a service-role client …
> * FDH-9/FDH-10 (0091/0096) gate on
>   `current_setting('fhip.import_bridge_internal_write')`, correct when the
>   legitimate writer is a SECURITY DEFINER function that can set the GUC.

### Why the previous round missed it

`scripts/fdh12_certification.mjs` verified only that the function existed in
`pg_proc`, and then set `approval_status='approved'` **by hand as the service
role** (lines 381-382). The RPC's own write path had never been executed.

### Fix — `supabase/migrations/0113_fdh12_approve_rpc_authoritative_write_fix.sql`

The project's own established mechanism, applied where 0112's header already
said it belonged: the statements guard now also honours
`fhip.import_bridge_internal_write`, and the approve RPC sets that
transaction-local GUC around its single `UPDATE` (identical in shape to
`fdh9_approve_payroll_event` and `fdh10_approve_liability_statement`). Every
pre-existing refusal — SMSF routed, SMSF review required, not extracted,
unresolved review items, cross-tenant, unauthenticated — is unchanged and still
evaluated **before** the GUC is ever set.

`create or replace` only. No schema change, no data change, idempotent.

## FDH12-LD-2 — HIGH — RESOLVED — canonical retirement apply provenance shipped unguarded

Migration 0112 PART A widened `retirement_accounts.source_type` to accept
`'retirement_statement_import'`, and PART G added
`last_import_application_id` / `last_imported_at`, with the comment that these
"mirror income_sources (0091 Part C) and liabilities (0096) exactly".

The **columns** were mirrored. The **two guards those migrations pair with the
very same columns** were not.

### Reproduction (real hosted DEV, ordinary authenticated user over PostgREST, own row)

```
PATCH retirement_accounts source_type='retirement_statement_import'   -> 200 SUCCEEDED
PATCH retirement_accounts last_import_application_id=<own app id>     -> 200 SUCCEEDED
PATCH retirement_accounts last_import_application_id=null,
                          last_imported_at=null                       -> 200 SUCCEEDED

CROSS-TENANT:
Tenant B PATCHes B's OWN retirement account to
  last_import_application_id = <Tenant A's fhip_import_applications.id>
                                                                      -> 200 SUCCEEDED
  B's row then reads last_import_application_id = A's application id.

POSITIVE CONTROL — same user, same request shape, same column name, on the
FDH-9 canonical register that DOES carry the guard:
PATCH income_sources last_import_application_id=<app id>
  -> 400 P0001 "income_sources: source_type/last_import_application_id/
                last_imported_at are import-bridge provenance and may not be
                written directly by the authenticated role"
```

So this is not a missing capability. It is one canonical register left out of an
existing, working, already-certified pattern.

### Impact

* A hand-typed retirement account can be stamped
  `source_type='retirement_statement_import'` — claiming a certified statement
  import that never happened (spec §96: "owning the row must not let the user
  forge … applied canonical state via direct REST").
* Real apply provenance can be erased, breaking the audit chain the architecture
  triple below depends on.
* A tenant's canonical row can be made to point at **another tenant's** import
  application record (spec §98/§102's cross-tenant reference rule; `income_sources`
  has `fdh9_assert_income_import_link_owner` precisely to prevent this).

**Not** an escalation to another tenant's *data*: RLS still scopes reads and
writes to the owner's own rows, and re-applying an already-applied proposal
remains impossible (proposal `status='applied'` plus the unique index on
`fhip_import_applications.proposal_id` — both re-verified live).

### Fix — `supabase/migrations/0114_fdh12_retirement_provenance_guards.sql`

The two 0091 functions transposed to `retirement_accounts` with no other change:
an import-link ownership trigger (`before insert or update of user_id,
last_import_application_id`) and a provenance-write trigger (`before update`,
firing only on those three columns). Manual retirement entry, renaming,
correcting a balance, changing owner and deactivation are all untouched —
`lib/validation/retirement.ts` never accepts `source_type` from a client, and
the PGlite harness carries an explicit positive control for ordinary editing.

`fdh12_apply_retirement_proposal()` already brackets every provenance write with
the GUC, so it is unaffected. No other code path in the repository writes
`retirement_accounts.source_type` (Investment Intelligence publishing writes only
`investments`; the FDH-12 processing service is forbidden from naming
`retirement_accounts` at all).

### Both fixes are proven necessary AND sufficient

`scripts/fdh12_certification.mjs` gained 9 checks covering both defects and now
reports **62 PASS / 0 FAIL**. With the fix migrations removed from the chain,
those exact checks fail — the anti-vacuity control:

```
without 0113: FAIL spec 56: an authenticated user CAN approve their own statement through the RPC
              FAIL spec 56: the approval actually persisted, with who and when
without 0114: FAIL spec 96: a user cannot forge canonical retirement provenance source_type
              FAIL spec 96: a user cannot forge canonical retirement provenance last_imported_at
              FAIL spec 98/102: Tenant B's retirement account cannot point at Tenant A's import application
```

---

# LIVE SECTION RESULTS

Round 3 (2026-08-31), the certifying run. Counts are taken from
`scripts/fdh12-live-dev-run.log` and sum to exactly 262.

| Spec | Section | Round 3 | Round-2 failures now cleared |
| --- | --- | --- | --- |
| 119 | Australia live DEV journey | **25 / 0** | 4 |
| 120 | Employer contribution $1,000 + $1,000 = $1,000 | **16 / 0** | — |
| 121 | Personal contribution, ordinary expense $0 | **8 / 0** | — |
| 122 | Rollover: income $0, expense $0, net worth +$0 | **10 / 0** | — |
| 123 | Fee $100 reduces retirement value, no cash expense | **5 / 0** | — |
| 124 | Insurance premium $75, no duplicated expense | **3 / 0** | — |
| 125 | Retained earnings +$5,000, no bank income event | **5 / 0** | — |
| 126 | Withdrawal matched as one economic event | **6 / 0** | — |
| 127 | Balance reconciliation → RECONCILED | **3 / 0** | — |
| 128 | $0.01 negative control → VARIANCE | **2 / 0** | — |
| 129 | Canonical unchanged until Apply | **8 / 0** | — |
| 130 | Duplicate statement | **13 / 0** | 3 |
| 131 | Overlapping statements | **4 / 0** | — |
| 132 | Wrong Self/Spouse account | **12 / 0** | 3 |
| 133 | Cross-tenant A/B | **16 / 0** | 1 |
| 134 | Same-tenant forgery | **31 / 0** | 6 |
| 137 | SMSF routing | **13 / 0** | — |
| 139 | PostgREST 1000/1001 boundary | **6 / 0** | — |
| 167 | Live schema verification | **29 / 0** | — |
| — | Server-identity probe + Architecture: evidence, not a second ledger | **11 / 0** | — |
| 171 | DEV cleanup (incl. the whole-table sweep) | **36 / 0** | — |
| | **TOTAL** | **262 / 0** | **17** |

No check in round 3 is stubbed. The round-2 log carried 16 checks labelled
`[approval step stubbed via service role — pending migration 0113 on DEV]`;
round 3 carries none, because the real owner-authenticated approve now
succeeds and every downstream check runs on top of it.

## §167 — Live schema verification (29 / 0)

* All three tables present; all 51 / 28 / 14 migration-declared columns present,
  with **no** live column the migration did not declare.
* Both RPCs registered; the three provenance columns present on
  `retirement_accounts`, `fhip_import_proposals` and `fhip_import_applications`.
* No floating-point money column on any of the three tables (spec 142).
* **RLS proven behaviourally, not by inspection**, with a positive control on
  every negative: for each of the three tables the service role SEES a real
  seeded row while ANON returns `200 []`; ANON INSERT is refused `401 / 42501`;
  the approve RPC refuses the ANON role.

## §119 — Australia live DEV journey (25 / 0)

Real chain, real routes, no mock DB: Retirement → Import Retirement Statement →
AU Super → Upload → Parse → Match member → Match account → Reconcile → Review →
Approve → Compare → USER APPLY → canonical Retirement updated.

Statement: opening 100,000 + employer 1,000 + earnings 5,000 − fee 100 −
insurance 75 − tax 150 = closing 105,675.

* upload `200`, `pipeline_status: ok`, `extraction_status: extracted`
* `reconciliation_status: reconciled`, variance exactly `0`
* auto account match resolved the canonical account **and** the household member
* proposal: `recommended_apply_mode: update_existing`, target = the matched
  account, `current_balance = 105675.00`, `employer_contribution = 1000.00`
* **Approve: PASS (round 3).** Pre-state `approval_status = pending`; the row's
  own owner calls the real RPC through the real route → `200`; the row
  genuinely transitions `pending -> approved`, with
  `approved_by = 0e4b4768-2100-4319-9457-7e5c135b5c4f` (the owning end user, not
  a service-role hand-set) and
  `approved_at = 2026-08-30T21:55:19.630005+00:00`. `/proposal` then returns
  `200` rather than the previous `409`.
* Apply: `outcome: applied`; canonical `current_balance`
  105,675.00; `last_import_application_id` and `last_imported_at` stamped; the
  `fhip_import_applications` row names this statement as its source and this
  account as its target. No stub anywhere in the chain.
* GUC containment: immediately after the authoritative Apply writes all three
  provenance columns under `fhip.import_bridge_internal_write`, the very next
  owner PATCH of provenance is refused `400 P0001` — the bridge GUC does not
  survive the RPC.

## §120 — Employer contribution: $1,000 + $1,000 = $1,000, never $2,000 (16 / 0)

The single most important negative control in the spec, now proven against real
hosted DEV rather than only in PGlite.

* Payslip evidence: `fdh_payroll_events.employer_retirement_contribution = 1000.0000`
* Fund statement line `Employer Superannuation Guarantee 1000.00` →
  classified `EMPLOYER_CONTRIBUTION`, amount `1000`
* `payslip.matched = 1`, activity `payslip_match_status = matched`,
  `matched_payroll_event_id` = the real payslip, variance `0`
* **Canonical `retirement_accounts.employer_contribution = 1000` — not 2000**
* The payslip row was **not** modified by FDH-12 (still `1000.0000`)
* `income_sources = 0` — neither evidence source posted an income row
* exactly ONE canonical retirement account exists (no second contribution posting)
* structural control: a SECOND activity claiming the same payslip is rejected by
  the live unique index — `409 / 23505`

## §121 — Personal contribution (8 / 0)

Bank −$5,000 (debit, `LIVECERT HORIZON SUPER CONTRIBUTION`) and super +$5,000
(`PERSONAL_CONTRIBUTION`).

* `bank.matched = 1`; the activity links the real `fdh_transactions` row
* **`expense_items = 0`** — required ordinary expense is $0
* the bank transaction row is byte-identical before and after: it was **not**
  reclassified as household consumption
* `fdh_transactions = 1` — no second cash record for the same movement
* canonical retirement byte-unchanged (no Apply was pressed)

## §122 — Rollover (10 / 0)

Fund A `Rollover to another fund 100,000` → `ROLLOVER_OUT`;
Fund B `Rollover received from LiveCert Alpha 100,000` → `ROLLOVER_IN`.

* `rollover.matched = 1`; the IN leg names the OUT leg as its counterpart
* **income $0** (`income_sources = 0`)
* **expense $0** (`expense_items = 0`, `fdh_transactions = 0`)
* **net-worth increase $0** — sum of `retirement_accounts.current_balance`
  before = 100000, after = 100000
* no third retirement account was invented for the movement

## §123 / §124 / §125 — Fee, insurance premium, retained earnings (13 / 0)

Each proven by an isolated live negative control: the same statement with
exactly one term removed from the closing balance. The resulting variance IS
that term's economic effect, measured by the live engine on real Postgres.

| Control | Live `reconciliation_status` | Live `reconciliation_variance` |
| --- | --- | --- |
| admin fee not deducted | `variance` | `-100` |
| insurance premium not deducted | `variance` | `-75` |
| investment earnings not added | `variance` | `5000` |

* `expense_items = 0` — internal fees and premiums created **zero** ordinary
  cash expense rows
* `fdh_transactions = 0` — and zero bank transactions
* `income_sources = 0` — retained earnings created **no** household bank income
  event; `assets = 0` — and no canonical asset row
* uploading these three further statements changed canonical Retirement **not at
  all** (an additional §129 instance)

## §126 — Withdrawal (6 / 0)

Super `Lump sum withdrawal 20,000` (`WITHDRAWAL`) + bank +$20,000 credit.

* `bank.matched = 1`; exactly one activity, linked to exactly one transaction —
  a single matched economic event, not two
* **`income_sources = 0`** — the withdrawal was NOT automatically treated as
  ordinary taxable income
* the bank credit row is byte-identical before and after — the match assigned no
  tax treatment and no economic class
* `fdh_transactions = 1` — no second cash record

## §127 / §128 — Reconciliation and the one-cent control (5 / 0)

* Balancing statement → `reconciled`, variance exactly `0` (proven twice, on two
  independent tenants)
* The same statement with the closing balance off by exactly one cent
  (`105675.01`) → `variance`, `reconciliation_variance = -0.01`. Exactly one
  cent survives on real Postgres — no float absorption.

## §129 — Canonical unchanged before Apply (8 / 0)

The full `retirement_accounts` row was snapshotted as a stable serialisation of
every column, and compared after **each** step:

| After | Canonical row |
| --- | --- |
| upload + parse | byte-unchanged |
| account + member match | byte-unchanged |
| evidence matching | byte-unchanged |
| approve-evidence | byte-unchanged |
| compare / proposal generation | byte-unchanged |
| reading the comparison | byte-unchanged |

`fhip_import_applications = 0` before Apply. Only the USER APPLY call — through
`fdh12_apply_retirement_proposal()` — changed it.

## §130 / §131 — Duplicates and overlaps (17 / 0)

Both sections now include a genuine owner-authenticated approve: §130's
statement transitioned `pending -> approved` through the real RPC with
`approved_by = da753732-55a0-4567-853c-b8c6f3ba93db` /
`approved_at = 2026-08-30T21:57:09.654013+00:00`.


* Identical re-upload → `pipeline_status: duplicate_statement`, resolving to the
  **same** statement id
* statements = 1, **duplicate proposals 0** (proposals = 1), **duplicate
  canonical contributions 0** (applications = 1), canonical balance unchanged by
  the second upload
* Identical *activity* statement re-uploaded: **duplicate activities 0** — three
  lines uploaded twice produced three activity rows
* Overlapping quarterly + annual statements (different bytes, real
  fingerprinting after account match): **overlap activity duplicates 0** — no
  two counted activities share an economic identity; the repeated July line is
  flagged `duplicate_of_activity_id` rather than counted; exactly two distinct
  economic contributions survive

## §132 — Wrong account (12 / 0)

Same fund name, two members, two masked identifiers, similar balances.

* the approve step is genuine: `pending -> approved` through the real RPC,
  `approved_by = ca9561a2-d645-4c5d-bae3-0fd7f88470e3` /
  `approved_at = 2026-08-30T21:58:11.333101+00:00`
* the `****1234` statement resolved to **SELF's** account, not the spouse's
* after Apply, the **spouse's row is byte-unchanged**; only SELF's balance moved
  (to 105,675.00); the spouse balance is still exactly its seeded 100,100.00
* symmetric control: the `****9876` statement resolved to the **SPOUSE's**
  account

## §133 — Cross-tenant, real Tenant A vs real Tenant B (16 / 0)

| Probe | Required | Live |
| --- | --- | --- |
| A's statement visible to B | 0 rows | **0 rows** |
| A's statement activities visible to B | 0 rows | **0 rows** |
| A's statement positions visible to B | 0 rows | **0 rows** |
| A's retirement account targetable by B | NO | **`400` cross-tenant reference — retirement account …** |
| A's household member targetable by B | NO | **`400` cross-tenant reference — retirement member …** |
| A's payslip matchable by B | NO | **`400` cross-tenant reference — payslip …** |
| A's bank transaction matchable by B | NO | **`400` cross-tenant reference — bank transaction …** |
| B drives A's document via the app API | refused | **`404`** |
| B approves A's statement via the RPC | refused | **`NOT_FOUND`** |
| B applies A's proposal via the RPC | refused | **`PROPOSAL_NOT_FOUND`** |

Two positive controls prove none of the above is vacuous: **B CAN see B's own
statement** (1 row) and **B CAN write an activity on B's own statement**
(`201`). A's canonical account is untouched by every Tenant B attempt.

Round 3 adds the FDH12-LD-2 cross-tenant probe that previously succeeded:

```
setup   : B's own retirement account holds last_import_application_id = null
          (so the attempt is a real change, not a no-op)
PATCH   : B sets B's OWN retirement account's last_import_application_id
          = A's fhip_import_applications.id
result  : 400 P0001 "retirement_accounts: cross-tenant reference — import
                     application c8a6e158-… belongs to a different user"
re-read : last_import_application_id = null   (unchanged)
control : A's import application is not even readable by B, so the link could
          not have been researched in the first place
```

## §134 — Same-tenant forgery (31 / 0)

Every attempt uses a value **different** from what the row already holds — a
forgery to the current value is a no-op that `is distinct from` correctly
ignores, and would make the check vacuous. A setup assertion confirms the row is
genuinely in the authoritative state being attacked before any attempt is made.

BLOCKED (`400 P0001 … system-authoritative …`), all live:
`reconciliation_status` reconciled→variance · `account_match_status`
matched→no_match · `approval_status` approved→pending · `canonical_account_id`
→null · `closing_balance` →999999 · `employer_contributions` →999999 ·
`extraction_status` extracted→manual_mapping_required · `smsf_classification`
not_smsf→routed_to_smsf · activity `payslip_match_status` matched→no_match ·
activity `matched_payroll_event_id` →null · activity `amount` 1000→999999.

Also blocked: the canonical apply record cannot be rewritten by its own owner,
and an APPLIED proposal cannot be reset to `ready` and re-applied.

**Round 3 — the six FDH12-LD-2 forgeries that previously returned `200` are now
all BLOCKED**, each verified by re-reading the column afterwards rather than by
trusting the status code:

| Attempt (owner, own row, direct REST) | Status | Column after |
| --- | --- | --- |
| erase canonical apply provenance | `400` | still `c8a6e158-350c-4493-8529-f47238747d3e` |
| rewrite canonical `source_type` | `400` | still `retirement_statement_import` |
| forge `source_type` `manual -> retirement_statement_import` on a hand-typed account | `400 P0001` | still `manual` |
| forge `last_import_application_id` to the owner's OWN real application | `400 P0001` | still `null` |
| forge `last_imported_at` to a chosen timestamp | `400 P0001` | still `null` |
| forge all three provenance columns in ONE request | `400 P0001` | still `manual` |

Setup assertion first: the fresh account is genuinely `manual / null / null`, so
each of these is a real change rather than a no-op. Refusal message, verbatim
live and matching `0114` line 133 exactly:
`retirement_accounts: source_type/last_import_application_id/last_imported_at
are import-bridge provenance and may not be written directly by the
authenticated role`.

Guard-scope positive control: the rest of that same row stays fully
user-editable (`account_name`, balance, `is_active` → `200`), so `0114` did not
lock the table.

POSITIVE CONTROLS, all still editable by the owner: `fund_name`, `nickname`,
`masked_account_identifier`, `statement_date`, `statement_start_date` /
`statement_end_date`, `review_status`, `source_provenance`,
`supersedes_statement_id`.

## §137 — SMSF routing (13 / 0)

* A statement whose fund name says "Self-Managed Super Fund" →
  `pipeline_status: routed_to_smsf`, `smsf_classification: routed_to_smsf`, with
  the matched phrase recorded as evidence
* **ordinary super import — NO:** account matching `409`, approve `409`,
  proposal `409`
* **SMSF route/review PASS:** the statement is retained with
  `review_status = pending` for the SMSF section
* **no duplicate SMSF canonical account** (2 → 2), **no `smsf_funds` row**
  created by FDH-12 (0 → 0), zero proposals and zero canonical applies
* an AMBIGUOUS name ("Corporate Trustee ATF Trust Deed") is held as
  `possible_smsf` and also cannot be approved without confirmation — ambiguity
  resolves to REVIEW, never to "probably ordinary super"
* an SMSF canonical account cannot be selected as an import target (`409`)

## §139 — Live PostgREST pagination boundary (6 / 0)

| Rows | Extracted | Stored in hosted DEV | Seen by the application's own read path |
| --- | --- | --- | --- |
| 1000 (at the cap) | 1000 | 1000 | **1000** |
| 1001 (one past the cap) | 1001 | 1001 | **1001** |

"Seen by the application's own read path" is the sum of every bank-match outcome
returned by `/evidence-matches`, which reads through `fetchAllRows`. A silent
truncation at `db-max-rows` would have produced 1000 for the 1001-row case. It
did not.

---

# ARCHITECTURE — evidence, not a second canonical ledger

Proven live, with real queries, in the same run:

```
Statement activities: stored as evidence
Canonical Retirement: summary state updated only through approved apply
Second canonical activity ledger created: 0
```

* **Statement activities: stored as evidence.** Activity rows exist and are
  matched, deduplicated, fingerprinted and reconciled while canonical
  `retirement_accounts` sits byte-unchanged (the §129 chain above). Their
  lifecycle is entirely independent of any canonical write.
* **Canonical Retirement: summary state updated only through approved apply.**
  Exactly one `fhip_import_applications` row exists for the journey tenant, and
  `retirement_accounts.last_import_application_id` equals it. The account row
  holds only summary fields — `current_balance`, `employer_contribution`,
  `personal_contribution`, `contribution_frequency` — and carries no column
  matching `activity|transaction|movement|ledger|posting`.
* **Second canonical activity ledger created: 0.** Live PostgREST enumeration of
  every table finds no non-`fdh_`, non-`ii_` table matching
  `retirement.*(activit|transaction|movement|ledger|posting|contribution_event)`.
  Migration 0112 creates exactly three tables, all `fdh_retirement_statement*`,
  and adds to canonical Retirement only
  `last_import_application_id` and `last_imported_at`.
* Across all four live tenants that ran a full chain,
  `income_sources = 0` and `expense_items = 0`.

`fdh_retirement_statement_activities` is therefore evidence about what a fund
reported, not a ledger anything sums.

---

# Australia coverage

> Certified Release-1 AU coverage: four generic retirement CSV layouts. Named
> Australian super-fund statement formats are not yet certified and route to
> MANUAL_MAPPING_REQUIRED or the applicable unsupported state.

Verified against the product, not just asserted:

* `RETIREMENT_CSV_ADAPTER_REGISTRY` contains exactly four fund-neutral adapters
  (`institutionCode: null`): transaction, member-statement summary, holdings, and
  the India EPF passbook.
* `docs/financial-data-hub/FDH12_AU_SUPER_STATEMENTS.md`'s coverage matrix marks
  AustralianSuper, Australian Retirement Trust, Hostplus, Aware Super, UniSuper,
  REST, HESTA, CBUS, Colonial First State and AMP all `MANUAL_MAPPING_REQUIRED`.
* No UI copy claims named-fund support. `RetirementStatementImportPanel.tsx`
  says only *"CSV exports only in this release. PDF statements and scanned
  documents cannot be read"*, with a source comment stating that it deliberately
  does not say "all Australian super funds supported", "because that is not
  true".
* The only place named funds appear in shipped data is FDH-2's institution
  master (`0054`), where their capability is literally `master_only` — an
  institution directory entry, not a parsing claim.

Named adapters are an explicitly deferred future coverage expansion.

---

# India

```
India shadow retirement engine created: 0
India canonical gaps discovered: 6
Gaps documented against canonical owner: 6/6
Gaps improperly implemented inside FDH-12: 0
```

Confirmed against `docs/financial-data-hub/FDH12_INDIA_RETIREMENT_GAP_REGISTER.md`:
IN-R1 (NPS Tier I/II), IN-R2 (EPF interest accrual), IN-R3 (PPF lock-in and
maturity), IN-R4 (employer PF vs EPS split), IN-R5 (no India layouts beyond
EPF), IN-R6 (India retirement tax treatment). Six gaps, each with a named
canonical owner, each `Status: OPEN`, each recorded only. FDH-12 added no India
retirement calculation engine, no EPF interest model, no NPS tier model, no PPF
maturity model and no India-specific projection.

---

# Shared CSV header-detection fix — affected-module regressions

The prior round fixed a real defect in the **shared** intake helper
(`lib/financial-data-hub/bank-csv/csv.ts`): `findHeaderRowIndex` indexes the raw
line array while `parseCsvSafe` filtered blank rows out first and then indexed
the filtered array, so a file with leading blank lines had its **second data
row** read as the header and every column silently mis-mapped. That helper is
shared with R7, FDH-5 and FDH-11.

Re-run this round, on the fixed tree:

| Suite | Result |
| --- | --- |
| R7 bank CSV (intake, detection, adversarial, large file, normalisation, reconciliation, dedup, account identity, pagination) | **183 / 183 PASS** (9 files) |
| FDH-5 (adapters, classification/password, financial integrity, R8 cross-format equivalence, scale, schema contract) + FDH-11 (AU investment intelligence, isolation, schema contract) | **122 / 122 PASS** (9 files) |
| FDH-12 own targeted suites | **382 / 382 PASS** (11 files) |

---

# Gates re-run this round

| Gate | Result |
| --- | --- |
| PGlite DB certification (clean rebuild, real Postgres) | **62 / 62 PASS**, including the anti-vacuity self-check and 9 new regressions for FDH12-LD-1/LD-2 |
| Anti-vacuity: same harness with 0113 removed | 2 checks FAIL (as designed) |
| Anti-vacuity: same harness with 0114 removed | 3 checks FAIL (as designed) |
| FDH-12 targeted unit tests | **382 / 382 PASS** |
| R7 + FDH-5 + FDH-11 CSV-affected regressions | **305 / 305 PASS** |
| `tsc --noEmit` | **0 errors** |
| `npm run build` | **PASS**, all 7 FDH-12 routes present |
| Migration version guard (`check:migrations`) | OK, 103 active, one file per version, next is `0115` |
| Cross-branch collision guard vs `origin/main` | OK, no collisions; `0113`/`0114` unused on **every** branch in the repository |
| Live DEV — round 3 (certifying) | **262 PASS / 0 FAIL** |

---

# DEV cleanup (spec 171) — round 3, 36 / 0

Every synthetic artefact round 3 created was deleted and the deletion was
independently re-verified three ways, only the first of which depends on this
run's own list of ids. Verbatim from `scripts/fdh12-live-dev-run.log`.

**1. Per-user re-query** — 12 tables, all `rows=0`:
`fdh_retirement_statements`, `fdh_retirement_statement_activities`,
`fdh_retirement_statement_positions`, `fdh_statement_uploads`,
`fdh_transactions`, `fdh_payroll_events`, `fdh_financial_accounts`,
`retirement_accounts`, `retirement_members`, `fhip_import_proposals`,
`fhip_import_applications`, `user_profiles`.

**2. Whole-table exact cardinality** — captured before the first synthetic row
existed, re-checked after cleanup, across all 15 tables this run can write to.
Every one returned to baseline exactly:

```
fdh_retirement_statements              0 -> 0
fdh_retirement_statement_activities    0 -> 0
fdh_retirement_statement_positions     0 -> 0
fdh_statement_uploads                  0 -> 0
fdh_transactions                       0 -> 0
fdh_payroll_events                     0 -> 0
fdh_financial_accounts                 0 -> 0
retirement_accounts                  367 -> 367
retirement_members                   287 -> 287
fhip_import_proposals                  0 -> 0
fhip_import_applications               0 -> 0
fhip_import_proposal_fields            0 -> 0
fdh_document_audit_events           1811 -> 1811
fdh_upload_sessions                    0 -> 0
user_profiles                        370 -> 370
```

The four non-zero baselines are the ones that matter: they are pre-existing DEV
data, and residue would show as an increase rather than as a non-zero count.

**3. Whole-table content-marker sweep** (`ilike`, every fixture literal this run
writes) — 8 table/column pairs, all `rows=0`:
`retirement_accounts.account_name` (`LiveCert`, `Tenant B Super`),
`fdh_retirement_statements.fund_name`, `fdh_financial_accounts.display_name`,
`fdh_payroll_events.employer_name`, `fdh_transactions.description_raw`
(`LIVECERT`), `income_sources.source_name`, `user_profiles.full_name`
(`FDH12 Live`).

**4. Auth** — no `fdh12-livedev-*` user remains.

**Zero synthetic residue.** No pre-existing DEV data was read or written at any
point.

### Disclosure — residue from EARLIER rounds, not this one

The independent sweep also found four synthetic users left on DEV by previous
FDH/II certification phases — still present in round 3, reported again rather
than quietly dropped. None was created by any FDH-12 run (every one predates
FDH-12 by days and carries another phase's tag), and none was removed, because
deleting another phase's fixtures is not this round's call:

| Email | Created |
| --- | --- |
| `r11-0088-client-1787665076470@fhip-test.invalid` | 2026-08-25T13:37:57Z |
| `smsf-ui-live-in-1787657311562@test.fhip.internal` | 2026-08-25T11:28:33Z |
| `smsf-ui-live-au-1787657311562@test.fhip.internal` | 2026-08-25T11:28:31Z |
| `r9-live-cert-main-a-1787521743216@test.fhip.internal` | 2026-08-23T21:49:04Z |

Reported so it is visible rather than absorbed into an "all clean" statement.

---

# VERDICT

**FDH-12 — DEV CERTIFIED FULL PASS — READY FOR PRODUCT OWNER MERGE
AUTHORISATION.**

Round 3, 2026-08-31: **262 live checks against real hosted DEV, 262 PASS, 0
FAIL.** All twenty live sections closed completely. Both defects this
certification found (FDH12-LD-1 BLOCKING, FDH12-LD-2 HIGH) are fixed in `0113`
and `0114`, both now confirmed genuinely in effect on DEV by behaviour, not by
a report of application — with all 17 of round 2's failing checks verified
passing individually, zero service-role approval stubs remaining in the run
log, and the `0114` guard messages matched verbatim against the migration
source.

Cleanup is zero-residue, verified by a whole-table cardinality sweep and a
content-marker sweep that do not depend on this run's own list of ids.

## Scope of this verdict, stated precisely

This certifies **DEV**. It is not a production certification and does not
authorise one.

* `0112`, `0113`, `0114` are applied to **DEV only**. Production has no FDH-12
  migration and no FDH-12 code.
* Nothing has been merged. The branch
  `feature/fdh12-retirement-statement-intelligence` is pushed to `origin`, and
  no further.
* The residuals in `FDH12_COMPLETION_REPORT.md` §9 stand unchanged and are not
  cancelled by this pass — no named AU super fund adapter, no PDF/OCR, India
  ingestion is EPF-CSV only, no Playwright e2e, breakpoints certified by
  construction rather than by screenshots, no malware scanning.
* FDH-13 has not been started.

## Next action

STOP. Await explicit Product Owner authorisation to merge.
