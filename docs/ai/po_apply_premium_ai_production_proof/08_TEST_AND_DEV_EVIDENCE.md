# 8. What was verified before you run anything (honest labels)

Branch `feat/premium-ai-prod-proof-20261019`, built on `origin/main` 22db19b. **No application code was changed** (no file under `lib/`, `app/`, `components/`, `supabase/`).
The branch adds tests, scripts, this pack, and one documentation fix. Therefore **nothing needs deploying for this branch**; deploying it changes no behaviour.

## 1. New and changed files

| File | What |
|---|---|
| `scripts/ai_production_proof_documents.ts` | deterministic generator for the eight synthetic documents, with the hand-computed expected values and per-document planted personal details |
| `scripts/ai_production_proof_dev_journey.ts` | DEV-only rehearsal of the production protocol (passwordless synthetic users, real scan, real gpt-4o-mini, shared-ledger limits restored in `finally`, residue re-counted) |
| `tests/unit/aiProductionProofDocuments.test.ts` (41) | files equal the generator, manifest matches, expected values recompute in cents, the real deterministic readers cannot read the documents (and read a control), the deterministic reconciliation accepts B1/B2, fails B3 at row 3 with variance 43.95, rejects an invented and a dropped line, masking removes every planted detail and keeps every figure |
| `tests/unit/premiumAiProductionConfig.test.ts` (9) | every AI-path environment variable is forwarded by `amplify.yml` or on a reasoned allowlist; the retired pilot settings change nothing; unrelated internal AI jobs are not started by the document-AI switches |
| `tests/unit/aiProductionProofSpendPglite.test.ts` (9) | the global allowance is a lifetime ledger; effective ceiling is the smaller of setting and stored value; realistic session accounting; a US$0.01 synthetic cap cycle |
| `tests/unit/aiProductionProofTenancy.test.ts` (6) | person B cannot read, claim, discard, release or confirm-check person A's draft |
| `tests/unit/aiProductionProofPackPglite.test.ts` (36) | every SQL file in the pack (and Module 11's) is editor-safe; READ-ONLY files are read-only; the A and E files run on a real engine and return the right facts; the cleanup sequence and the ops files work |
| `docs/ai/po_apply_premium_ai_production_proof/**` | this pack (README, 01 to 08, `sql/`, `synthetic/`, `tools/`, `evidence/`, `module11/`) |
| `ENVIRONMENT_VARIABLES.md` | documentation only: the quoted forwarding line now equals `amplify.yml` (a pre-existing failing test, `m12cServerOnlySecretBoundary`, is green again) |

## 2. Results

| Check | Result | Label |
|---|---|---|
| New suites above | 101 of 101 pass | UNIT-TESTED / PGLITE-VERIFIED |
| Related existing suites re-run (Premium guard, Premium uploads, per-user cap, refusals, single-flight, II gate, staff Premium) | 24 files, 679 tests pass | UNIT-TESTED / PGLITE-VERIFIED |
| `tsc --noEmit` | one error, `tests/unit/canonicalCertResidueAllSql.test.ts(127,75)`, which depends on a checked-in artifact a test run rewrites; the same single error exists on `origin/main` (recorded by the previous Premium-access report). No error in any new file | |
| `eslint` on every new or changed TypeScript file | clean | |
| Editor-safety lint on all 34 SQL files (including Module 11's 10) | clean | |
| `Check-AmplifyAiConfig.ps1` | parses with no errors; run in a session with a mocked `aws` command: it flagged a wrong provider, a missing set, a forbidden override, and printed no secret value | mock-verified only; **never run against Amplify** |
| Full repository test suite | **NOT PERFORMED** in this session (about 28 minutes; the previous report documents 36 files that fail on a clean `origin/main`). `git checkout -- scripts/` was run after the suites | NOT PERFORMED |

## 3. DEV rehearsal (DEV-verified, 19/10/2026, project `vqycarelcoijzwlpkpcz`, local build of `main`, real DEV GuardDuty scan, real gpt-4o-mini)

Raw (sanitized) results: `evidence/dev_rehearsal_bank_journeys_19-10-2026.json` and `evidence/dev_rehearsal_refusals_limits_payslip_19-10-2026.json`.

| Run | Checks | What it showed |
|---|---|---|
| Bank journeys (`bank`) | **20 of 20** | DOC-B1: scan clean and bound to the stored object (version, ETag, key equal), parser shortfall then draft, **draft equals the expected sheet row for row** (6 lines, balances, opening 3,215.40, closing 4,369.65, period), one metered attempt (gpt-4o-mini, 1,377 in and 396 out tokens, reserved US$0.009173, settled **US$0.000444**, one request id), replay and identical re-upload make no second call, cross-tenant 404/403, original purged and verified absent **while the draft was still pending** (clock shifted by 3 hours, real purge sweep), accepted **after** deletion, canonical result 6 transactions out 1,795.75 in 2,950.00 reconciled and certified, replayed confirm 409 and no charge. DOC-B2 for a second Premium account: equal to the sheet, accepted, isolated. DOC-B3: model reported 9,300.00 as printed, reconciliation failed with variance -43.95, document `review_required`, not certified. Cleanup: ledger ceilings restored, zero residue |
| Refusals, limits, payslip (`refuse limits payslip`) | **12 of 12** | Free upload 403 `PREMIUM_REQUIRED` with no row; forged plan and user claims ignored; no session 401; **former-pilot account (still listed on the retired variables) whose plan ended: `premium_required`, no attempt, nothing charged**; expired window refused; upgrade honoured on the next request; **per-user cap (temporary US$0.001): `daily_limit_reached`, attempt `user_daily_cap_reached`, nothing reserved**; **global ceiling (temporary US$0.001): attempt `budget_exhausted`, no request id**; DOC-P1 payslip draft gross 3,200.00 tax 512.00 net 2,488.00 fortnightly paid 15/08/2026 |
| `scripts/aie_user_cap_live_dev_check.ts` Part 1 | **12 of 12** | 22 truly parallel reservations for one user: exactly 10 admitted (cap US$1.00 in steps of 0.1); second user independent; replay charges nothing; rollover; global still refuses; anon key cannot call the function |
| Total real provider spend | about US$0.003 (six readings) | |

**What the rehearsal did not cover:** no browser screen was driven (the same routes the screens call were); DOC-L1, DOC-R1 and DOC-A1 (CSV classes) were not re-run with these exact files
(the same fixtures' content was DEV-verified on 14/10/2026 and the readers' inability is unit-tested); DOC-I1 (Investment Intelligence) could not run because `ii_ai_extraction_reviews`
(migration 0160) is **absent on DEV**; Part 2 (real money) of the cap script was not run; the S3 scan-copy delete on DEV answered `access_denied` (finding F-4); simultaneity across
different server instances; production-only facts (the build, the configuration, production's scan role).

## 4. Repeating the rehearsal

```
node scripts/aie1_final_dev_server.mjs 3991                                   (terminal 1: local build against DEV; needs the shared .env.local and the AWS profile for the DEV scan bucket)
npx tsx scripts/ai_production_proof_dev_journey.ts http://localhost:3991      (terminal 2: all journeys; or name them: bank refuse limits payslip)
npx tsx scripts/aie_user_cap_live_dev_check.ts                                (the parallel cap check)
npx vitest run tests/unit/aiProductionProof*.test.ts tests/unit/premiumAiProductionConfig.test.ts --testTimeout=120000
git checkout -- scripts/                                                      (after any full-suite run)
```
