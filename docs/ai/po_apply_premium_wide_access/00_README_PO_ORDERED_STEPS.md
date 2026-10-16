# Wide Premium access to AI features: what you do, in order

Branch `feat/ai-premium-wide-access-20261014`. Status: **READY FOR PO DEPLOYMENT** (not deployed, not pushed, nothing
touched in production). Authority: Product Owner instruction 14-10-2026.

**What changes for people.** Any signed-in person with an active Premium entitlement gets the AI reading of documents
the deterministic reader cannot read (payslip, bank statement, AU investment statement, liability statement, retirement
statement, Investment Intelligence statement), no matter whether they were in the two-e-mail pilot. A Free, lapsed or
unauthenticated person gets no AI reading (no provider call, no charge), is told it is a Premium feature and offered the
upgrade, and keeps the normal import and manual entry. Admin status does not grant it. Reviewing and accepting a draft
that already exists keeps working after a plan ends.

**What does not change.** No database migration, no new table, no SQL to apply, no budget raised, no quota raised. The
spend ceiling is still one global US$10 ledger (see the limitation list). Module 11's zero-cost Insights and Explain
features already needed Premium and had no pilot list; unchanged. AI Coach, Next Best Action and the scheduled monthly
pack are not on `main` yet.

**One new safety rule you should know about.** The AI reading is now refused unless the real malware scan is switched on
(`AIE_REAL_MALWARE_SCAN_ENABLED=true`). Before, "scan off" was accepted as "not required" for any document. You told me the
production scanner is live; if it is not, nothing breaks, the AI reading simply refuses with a clear reason.

**A defect found and fixed on the way.** On DEV, five identical `/process` requests sent at the same instant for one document
made four metered provider calls and left the document in conflicting states. Concurrent identical requests now share one
reading per server instance (`lib/ai/access/singleFlight.ts`). Two requests that land on two different serverless instances at
the same instant are still protected only by the atomic ledger and the one-pending-draft index (a duplicate costs a fraction of
a cent and cannot create two accepted results); a database claim would close that and needs a migration, so it is listed as a
follow-up rather than added unasked.

## Ordered steps

### Step 1: read-only checks on production (5 minutes, writes nothing)
Run in the SQL editor, one statement at a time: `sql/P01_schema_inventory_READONLY.sql` (every row must be `true`),
`sql/P02_premium_population_and_controls_READONLY.sql` (how many people this opens it to, and the Module 11 control values),
`sql/P03_aie_spend_ledger_READONLY.sql` (note `remaining_usd`).
- Any `false` row in P01 is a blocker for the named feature. `0180`, `0195`, `0197` missing means the AI reading cannot
  save a draft safely: stop and tell me. `0236` missing means uploads that need an owner will fail: apply 0236 first
  (its own pack is `docs/ownership/po_apply_0236_dev`, DEV first).
- If `remaining_usd` is under about US$3, decide on the ceiling before step 4. I did not raise it.

### Step 2: check Amplify holds what the AI reading needs (no change yet)
Confirm these exist (names only; never paste a value anywhere): `AIE_OPENAI_API_KEY`, `AIE_MASK_TOKEN_ENCRYPTION_KEY`,
`AIE_AI_PROVIDER=openai`, `AIE_REAL_MALWARE_SCAN_ENABLED=true` and the five `AIE_MALWARE_*` settings. Anything missing is a
blocker; the full table is `02_AMPLIFY_ENV_CHANGES.md`.

### Step 3: stage it closed, then push
1. Amplify, production, environment variables: set `AIE_AI_FALLBACK_ENABLED=false` and `II_AI_FALLBACK_ENABLED=false`.
   Leave the retired pilot variables exactly as they are.
2. Push (verified after `git fetch`, see the end of this file).
3. Wait for the Amplify build to finish green and confirm the deployed commit is the one you pushed.

### Step 4: open ONE class and prove it (journeys 5, 6, 1, 2, 3 in `05_...`)
1. Set `AIE_AI_FALLBACK_ENABLED=true` and only `AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED=true` (the other four class flags and
   `II_AI_FALLBACK_ENABLED` stay `false`). Redeploy (variables apply only on a new build).
2. Run the journeys in `05_PRODUCTION_PROOF_PROCEDURE_AND_EVIDENCE.md`: the Free refusal first (nothing may move in
   `sql/P03`), then the Premium account that was never in the pilot.
3. Fill the evidence table. Stop here if any expected result is not seen, and use the rollback below.

### Step 5: open the rest
Set the other four class flags and `II_AI_FALLBACK_ENABLED` to `true`, redeploy, run journey 11. Then journeys 7 to 10 and 12.

### Step 6: tidy, a day later
Delete the six retired pilot variables (`02_...` section 3). Never before.

## Rollback (data-safe, no SQL)
- **Instant stop of all AI reading**: `AIE_AI_FALLBACK_ENABLED=false` and `II_AI_FALLBACK_ENABLED=false`, redeploy. Deterministic imports,
  manual entry, existing drafts, review and accept are untouched.
- **Stop one class**: its `AIE_*_AI_FALLBACK_ENABLED=false`.
- **Revert the code**: redeploy the previous Amplify build. Keep the retired pilot variables set while you do this (the old code treats
  "enforcement unset" as everybody), or switch the kill switches off first. The branch adds no migration, so there is no schema to undo.
- Money already spent stays in the ledger; nothing deletes financial data or security controls.

## What is not claimed
Nothing is PRODUCTION-VERIFIED. Per-feature status is in the table in the final report and in `06_TEST_AND_DEV_EVIDENCE.md`.
"All implemented, release-ready AI features are live for all eligible Premium users" may be written only after your
journeys 1, 2, 5 and 11 have real rows.

## Files
`01_FEATURE_INVENTORY.md`, `02_AMPLIFY_ENV_CHANGES.md`, `sql/*`, `05_PRODUCTION_PROOF_PROCEDURE_AND_EVIDENCE.md`,
`06_TEST_AND_DEV_EVIDENCE.md`, `07_MODULE11_POST_MERGE_NOTES.md`. Proof fixtures: `scripts/ai_premium_proof_make_fixtures.ts`.
