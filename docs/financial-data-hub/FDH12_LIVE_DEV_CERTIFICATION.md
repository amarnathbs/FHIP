# FDH-12 — Live DEV Certification

Spec sections 119-134, 137, 139, 166-167, 171.

## STATUS: CONDITIONAL PASS — TWO REAL DEFECTS FOUND LIVE; MIGRATIONS `0113` AND `0114` PENDING ON DEV

Migration `0112_fdh12_retirement_statement_intelligence.sql` was applied to DEV
by the Product Owner. Every live section below was then executed for real
against hosted DEV Postgres (`vqycarelcoijzwlpkpcz.supabase.co`) plus a real
`next dev` instance started from this worktree.

**Live result: 213 PASS, 5 FAIL.** All five failures are the two genuinely new
defects this round found, and both are fixed forward in migrations that have
**not** been applied to DEV. Nothing else failed.

| Run | Harness | Result |
| --- | --- | --- |
| Live DEV | `scripts/fdh12_live_dev_certification.mjs` | **213 PASS / 5 FAIL** |
| PGlite (real Postgres, clean rebuild) | `scripts/fdh12_certification.mjs` | **62 PASS / 0 FAIL** (was 53; +9 new regressions for the two defects) |

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

## FDH12-LD-1 — BLOCKING — `fdh12_approve_retirement_statement()` can never succeed

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

## FDH12-LD-2 — HIGH — canonical retirement apply provenance shipped unguarded

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

| Spec | Section | Live result |
| --- | --- | --- |
| 119 | Australia live DEV journey | 18 PASS / 1 FAIL (the Approve step — FDH12-LD-1) |
| 120 | Employer contribution $1,000 + $1,000 = $1,000 | **16 / 0** |
| 121 | Personal contribution, ordinary expense $0 | **8 / 0** |
| 122 | Rollover: income $0, expense $0, net worth +$0 | **10 / 0** |
| 123 | Fee $100 reduces retirement value, no cash expense | **5 / 0** |
| 124 | Insurance premium $75, no duplicated expense | **3 / 0** |
| 125 | Retained earnings +$5,000, no bank income event | **5 / 0** |
| 126 | Withdrawal matched as one economic event | **6 / 0** |
| 127 | Balance reconciliation → RECONCILED | **3 / 0** |
| 128 | $0.01 negative control → VARIANCE | **2 / 0** |
| 129 | Canonical unchanged until Apply | **8 / 0** |
| 130 | Duplicate statement | 9 PASS / 1 FAIL (Approve step only) |
| 131 | Overlapping statements | **4 / 0** |
| 132 | Wrong Self/Spouse account | 8 PASS / 1 FAIL (Approve step only) |
| 133 | Cross-tenant A/B | **13 / 0** |
| 134 | Same-tenant forgery | 23 PASS / 2 FAIL (both FDH12-LD-2) |
| 137 | SMSF routing | **13 / 0** |
| 139 | PostgREST 1000/1001 boundary | **6 / 0** |
| 167 | Live schema verification | **29 / 0** |
| — | Architecture: evidence, not a second ledger | **10 / 0** |
| 171 | DEV cleanup | **13 / 0** |

Where a section shows a FAIL only for the Approve step, the rest of that
section's chain was still exercised end-to-end live, with the approval step
stubbed via the service role — the same stub the PGlite harness uses — and
every downstream check is labelled in the harness output
`[approval step stubbed via service role — pending migration 0113 on DEV]`.
Nothing is claimed as fully live that was not.

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

## §119 — Australia live DEV journey

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
* **Approve: FAILED — FDH12-LD-1**
* Apply (after the stub): `outcome: applied`; canonical `current_balance`
  105,675.00; `last_import_application_id` and `last_imported_at` stamped; the
  `fhip_import_applications` row names this statement as its source and this
  account as its target.

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

## §130 / §131 — Duplicates and overlaps (13 / 2 Approve-step only)

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

## §132 — Wrong account (8 / 1 Approve-step only)

Same fund name, two members, two masked identifiers, similar balances.

* the `****1234` statement resolved to **SELF's** account, not the spouse's
* after Apply, the **spouse's row is byte-unchanged**; only SELF's balance moved
  (to 105,675.00); the spouse balance is still exactly its seeded 100,100.00
* symmetric control: the `****9876` statement resolved to the **SPOUSE's**
  account

## §133 — Cross-tenant, real Tenant A vs real Tenant B (13 / 0)

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

## §134 — Same-tenant forgery (23 / 2)

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

**FAILED (FDH12-LD-2):** canonical apply provenance can be erased, and
`source_type` can be rewritten, by direct REST. See the defect section above.

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
| Live DEV | **213 PASS / 5 FAIL** |

---

# DEV cleanup (spec 171)

Every synthetic artefact this round created was deleted and the deletion was
independently re-verified by re-query — first per user id, then by a whole-table
sweep that does not depend on the id list at all:

```
TOTAL ROWS IN FDH-12 TABLES ON DEV (whole table, every tenant):
   fdh_retirement_statements            => 0
   fdh_retirement_statement_activities  => 0
   fdh_retirement_statement_positions   => 0

Retirement-domain bridge rows:
   fhip_import_proposals (retirement)                      => 0
   fhip_import_applications (retirement)                   => 0
   retirement_accounts source_type=retirement_statement_import => 0
   retirement_accounts with last_import_application_id      => 0

Documents of the two FDH-12 document types:
   fdh_statement_uploads document_type=super_statement => 0
   fdh_statement_uploads document_type=epf_statement   => 0

auth users total: 375 | fdh12-livedev-* remaining: 0
```

**Zero synthetic residue.** No pre-existing DEV data was read or written at any
point.

### Disclosure — residue from EARLIER rounds, not this one

The independent sweep also found four synthetic users left on DEV by previous
certification rounds. None was created by this run (every one predates it by
days and carries another phase's tag), and none was removed by this run, because
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

**FDH-12 — CONDITIONAL PASS — LIVE DEV CERTIFICATION EXECUTED IN FULL; TWO REAL
DEFECTS FOUND, FIXED FORWARD, AND AWAITING MIGRATIONS `0113` AND `0114` ON DEV.**

Not a FULL PASS, and deliberately not rounded up to one. Eighteen of the twenty
live sections closed completely. The two that did not are blocked by defects this
round itself found, and one of them (FDH12-LD-1) is severe enough that the
feature could not have shipped: no user could have approved a retirement
statement at all.

## To reach DEV CERTIFIED FULL PASS

1. Product Owner applies, to **DEV only**, via the Supabase SQL Editor:
   * `supabase/migrations/0113_fdh12_approve_rpc_authoritative_write_fix.sql`
   * `supabase/migrations/0114_fdh12_retirement_provenance_guards.sql`
2. Re-run `node scripts/fdh12_live_dev_certification.mjs` (with a `next dev` on
   port 3212 from this worktree). The five failing checks become the live
   Approve step and the two live provenance refusals; expected result 218 / 0.

Nothing has been merged, pushed, applied to DEV, or applied to production by
this round. FDH-13 has not been started.
