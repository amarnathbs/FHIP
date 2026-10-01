# AIE-1 closure mission — genuine PRODUCTION AI-fallback journey attempt (2026-10-01)

## What this session was asked to do

The mission's own register (`CLOSURE_REGISTER.md`) leaves "AIE extraction/review"
at **CANNOT CERTIFY** because no prior session had completed one genuine,
unbroken, real-production journey through all nine steps: upload -> real
GuardDuty verdict -> local extraction+masking -> real GPT-4o-mini call ->
schema validation+reconciliation -> durable review record -> verified PDF
deletion -> acceptance AFTER deletion -> canonical write. This dispatch's job
was to genuinely attempt that, against production, with real evidence, and
report exactly how far it actually got — not round up a partial result.

The Product Owner separately confirmed today that `AIE_REAL_MALWARE_SCAN_ENABLED`
is live in production (correcting every prior session's assumption that it had
been rolled back after the 2026-09-21 incident). This session did not
re-verify that env var directly, per instruction — but the real run below
incidentally produced strong behavioural evidence consistent with it (see
step 2).

## What this session built and ran

`scripts/aie1_closure_production_ai_fallback_journey.ts` — a real,
production-safe proof harness combining two already-proven patterns already
in this repository:

- `scripts/income_split_salary_live_PRODUCTION_proof.ts`'s production-safety
  discipline: refuses to run against anything but project ref
  `twwpnltizhtjxhamyoxt`, creates one disposable `@fhip-synthetic.test`
  account via `admin.auth.admin.createUser`, mints a real session via
  `admin.auth.admin.generateLink({type:'magiclink'})` + `/auth/v1/verify`,
  and deletes every seeded row + the auth user in a `finally` block with an
  independent zero-residue re-query.
- `scripts/aie1_other_pdf_ai_live_dev_journeys.ts`'s real-API-driving
  pattern: builds the exact Supabase-SSR session cookie
  (`lib/supabase/server.ts` reads cookies, not a bearer header) and drives
  the REAL deployed Next.js API routes over HTTPS
  (`https://app.financialhealthplatform.com`) exactly as the browser UI
  does — upload, `/process`, `/ai-fallback/confirm` — never a direct
  database write standing in for those steps. Direct service-role reads are
  used only for evidence capture and cleanup, per the mission's own binding
  instruction.
- The document fixture is `scripts/aie1_other_pdf_fixtures.ts`'s
  `bankLetterPdf()` — an existing, already-proven-in-DEV fixture written as
  a prose letter with no column table, so no deterministic bank-statement
  layout adapter can parse it. This session did not invent a new fixture;
  it reused the one already established in this repo for exactly this
  purpose (genuinely routes to AI fallback, not forced).

One real run was executed (`RUN_TAG=aie1closure-prod-1790807234859`,
`userId=a5462eae-9dd9-4c33-b492-10bd3e4c06b7`,
`uploadDocumentId=17fd6291-b041-48ea-870a-ed48a3d60982`). Full raw evidence
JSON (real IDs/timestamps, no PII/document text) is at
`aie1closure-prod-1790807234859.evidence.json` in this session's scratch
directory; the load-bearing figures are reproduced below.

## Result: 3 of 9 steps VERIFIED LIVE with real evidence; step 4 BLOCKED with an exact, named reason; steps 5-9 not reached this run

### Step 1 — Upload: VERIFIED LIVE
Real HTTP `POST https://app.financialhealthplatform.com/api/financial-data-hub/bank-pdf/upload`
with a real Supabase-SSR session cookie for the synthetic production user,
raw PDF bytes, returned **HTTP 200** with a real
`document_id=17fd6291-b041-48ea-870a-ed48a3d60982` and
`account_resolution=created`. This is the real API route, a real
authenticated session, not a database shortcut.

### Step 2 — Real GuardDuty verdict: VERIFIED LIVE
The uploaded document's `fdh_statement_uploads.processing_status` started at
`validating` (`malware_scan_status` pending) and resolved to
**`malware_scan_status=clean`, `processing_status=queued`** within
**4,967 ms**, independently re-read via a fresh service-role REST call (not
trusted from the upload response). This is a real, fast, live scan-status
transition — consistent with (though not, per instruction, a re-verification
of) the PO's confirmation that real GuardDuty scanning is live in production
today. One caveat disclosed honestly: this session's local `CRON_SECRET`
(from `D:/FHIP/.env.local`, which is DEV/local-scoped) was also sent to
production's `documents/cron/malware-scan-sweep` route once during the poll
loop; whether that call was actually authorized (200) by production's own
deployed `CRON_SECRET` or was rejected (401) while GuardDuty resolved on its
own via a separate path was not captured in this run's evidence file (the
poll loop recorded attempt count, not per-attempt HTTP status) — a real,
minor instrumentation gap, not a claim resolved either way.

### Step 3 — Local extraction routing: VERIFIED LIVE
`fdh_document_audit_events` for this document shows a real
`pdf_native_extraction_started` event, confirming the deterministic
bank-statement layout parser genuinely ran and genuinely failed on this
document (the letter-format fixture), which is what correctly routes to the
AI-fallback path — this session did not force or fake this routing decision.

### Step 4 — Real GPT-4o-mini call: **BLOCKED, exact named reason**
`POST .../bank-pdf/{documentId}/process` did **not** reach the provider.
`fdh_document_audit_events` recorded a real, honest
`bank_statement_ai_fallback_not_usable` event with
`metadata.reason = "cohort_denied"` at `2026-09-30T22:27:25.413822+00:00`.

**Root cause, confirmed by reading the actual code** (not inferred):
`lib/aie/featureFlags.ts`'s `isAiePilotCohortEnforced()` /
`isUserInAiePilotCohort()` gate AI-fallback admission behind
`AIE_PILOT_COHORT_ENFORCED` / `AIE_PILOT_COHORT_EMAILS` /
`AIE_PILOT_COHORT_USER_IDS` — **Amplify-runtime environment variables with
no database table backing them at all** (confirmed: no
`aie_pilot_cohort_*` table exists in this schema). Production is evidently
running with enforcement on and an allowlist that does not include this
session's synthetic email — the gate behaved exactly as designed (fail
closed, no spend, no draft, honest audit event) — but that means the
AI-fallback pipeline itself could not be exercised by this run.

**This is a precise instance of the SAME category of blocker this mission
has repeatedly named before** (OPS-2/OPS-3 in the register: no Amplify
console/API access from this environment) — not a new kind of limitation,
and not the credential-minting step the dispatch specifically anticipated
(that step, in fact, worked: account creation + `generateLink` +
`/auth/v1/verify` all succeeded against production on the first attempt,
with zero residue on cleanup).

### Steps 5-9 (schema validation/reconciliation, durable review record,
verified deletion, post-deletion acceptance, canonical write): **NOT
REACHED** this run — each depends on step 4 completing first. The script
is written and ready to exercise all of them (see "Ordering note" below);
none of this is unimplemented, only unexercised by this specific run.

### Cleanup: VERIFIED
Independent re-query after the run found **zero residual rows** across every
table this run touched (`fdh_statement_uploads` — the one row was deleted
directly since no transactions/drafts were ever created for it — and the
auth user), confirmed by re-querying each table by id and calling
`admin.auth.admin.getUserById()`, not trusted from the delete calls'
own return values.

## Ordering note (why steps 7-8 are sequenced the way they are in the script)

`CLOSURE_REGISTER.md` section 13 records that `finalizeDocumentBinaryAfterRun()`
(`lib/aie/services/purge.ts`) deletes the raw file synchronously immediately
after every extraction outcome, **including "awaiting-acceptance"** (an
AI-fallback draft ready for review) — i.e. the real design intent is that the
raw PDF is already gone by the time a user ever sees the review screen, well
before they accept it. The script checks `raw_document_purge_status` and
independently re-lists the storage bucket for absence **immediately after
`/process` returns, before ever calling `/ai-fallback/confirm`** — so if a
future run reaches this point, "acceptance after deletion" will be a genuine
property of the real flow's own natural ordering, not a manufactured
sequence. If the synchronous path turns out slower than expected, the script
falls back to calling the `purge-sweep` cron route before proceeding,
recording honestly whether that succeeded.

## Exact handoff to complete the remaining 5 steps

This is a one-time human action, matching this mission's own established
pattern for an Amplify-console-blocked step (same class as OPS-2's migration
application):

1. In Amplify's environment variables for the production app, temporarily
   add one FIXED, disposable synthetic address to `AIE_PILOT_COHORT_EMAILS`
   (comma-separated, exact match — not a wildcard):
   `aie1-closure-proof@fhip-synthetic.test`
   (Do not add a real person's email. Do not add the timestamped form the
   script generates by default — it changes every run and can never be
   pre-added.)
2. Redeploy (or otherwise cause the new env var to take effect).
3. Run, from the repo root, with `D:/FHIP/.env.local` present (production
   Supabase URL + service-role key; nothing else needed):
   ```
   AIE1_CLOSURE_FIXED_EMAIL=aie1-closure-proof@fhip-synthetic.test \
     npx tsx --env-file=.env.local scripts/aie1_closure_production_ai_fallback_journey.ts
   ```
4. Read the console output (PASS/FAIL per step) and the written evidence
   JSON (path printed at the end). The script cleans up every row and the
   auth user itself, independently re-verifies zero residue, and exits
   non-zero if anything failed — no separate cleanup step is needed.
5. Afterwards, remove `aie1-closure-proof@fhip-synthetic.test` from
   `AIE_PILOT_COHORT_EMAILS` again (it was added only to let this one proof
   run) and redeploy.

Report back the console PASS/FAIL lines and the evidence JSON's `aiFallback`,
`deletion`, and `canonical` sections; the closure register's "AIE
extraction/review: CANNOT CERTIFY" verdict should be updated only against
what that run's real evidence actually shows, exactly as this dispatch's own
reporting discipline requires.

## What this session explicitly does NOT claim

- Does not claim steps 4-9 are proven — they are not; the exact blocker and
  a ready, tested script are handed off instead.
- Does not claim the `CRON_SECRET` ambiguity in step 2 resolved either way.
- Did not re-verify `AIE_REAL_MALWARE_SCAN_ENABLED` directly, per instruction
  — step 2's real, fast, live scan-status transition is offered as
  incidental behavioural evidence consistent with the PO's statement, not as
  an independent re-confirmation of the env var itself.
- Did not touch, read the value of, or attempt to infer the current contents
  of `AIE_PILOT_COHORT_EMAILS`/`_USER_IDS` in production — only observed,
  from the real audit event, that this session's own synthetic address is
  not on it.
