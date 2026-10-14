# Tests, build and DEV evidence (honest labels)

Labels: **UNIT-TESTED** (vitest, fakes), **PGLITE-VERIFIED** (real PostgreSQL engine, unchanged suites re-run),
**DEV-VERIFIED** (real HTTP against a local `next dev` of this branch, DEV Supabase project `vqycarelcoijzwlpkpcz`, real
DEV S3 + GuardDuty scan, real gpt-4o-mini), **PRODUCTION-VERIFIED** (none: I have no production access).
Hazards honoured: the full-suite run rewrites `scripts/` artifacts (`git checkout -- scripts/` run afterwards), and the
repo-walking / pglite / pipeline tests time out at the default 5 s under load, so every comparison below was re-run with
`--testTimeout=120000` and against a clean extract of `origin/main` (`af2d330`).

## 1. What changed in the tests

| Change | Files |
|---|---|
| **New** shared test double for the entitlement read | `tests/support/premiumAiAccessMock.ts` |
| **New** guard matrix: active / window ends inclusive / expired / not started / unknown tier / no row / unreadable / reader throws / empty id; no cache (upgrade and downgrade seen on the next call); retired pilot variables and admin status cannot grant or deny; denial envelope and message | `tests/unit/premiumAiAccessGuard.test.ts` |
| **New** the five AIE routes: unauthenticated 401, Free (listed on the retired variables) 403 with nothing created, expired 403, unreadable 503, Premium-not-in-pilot gets past the gate (negative control), caller-claimed user / plan ignored | `tests/unit/aiePremiumAccessRoutes.test.ts` (26 tests) |
| **New** Investment Intelligence fallback: Free / expired / unreadable refused before the provider, former pilot but Free refused, Premium outside the cohort succeeds, two users isolated, replay makes one call, downgrade after the draft still returns the draft but not a new reading, tenancy, malware precondition, kill switch first | `tests/unit/iiAiFallbackPremiumGate.test.ts` |
| **New** gate + real gateway + recording cost ledger: Free refused with no reservation or call, Premium + exhausted budget refused before the provider, gateway kill switch, six concurrent identical requests make one call, independent users do not interfere | `tests/unit/aiePremiumGateOrderingWithGateway.test.ts` |
| **New** coverage guard with two negative controls: any provider-reaching file must carry the shared guard or be a listed building block; the retired variables are read by no code; no e-mail literal comparison | `tests/unit/premiumAiGuardCoverage.test.ts` |
| **New** what the person is told (only two reasons ever reach the browser; no internal wording) | `tests/unit/aiFallbackRefusal.test.ts` |
| **Updated** (pilot mocks replaced by the Premium double, gate calls awaited, new refusal assertions incl. "provider never called") | `aieUnifiedFallbackMaskingEgress`, `aiePayslipFallbackTrigger`, `aieBankAiFiguresMustBePrinted`, `aieStatementAiBalancesMustBePrinted`, `aieStatementDraftConfirmRoundTrip`, `fdh10LiabilityZeroAmountAtomicPersist`, `statementReuploadAndResume`, `aieMalwareGateUnreachableExtraction`, `aieOtherPdfCallEvidenceAndBudget`, `aieOwnerBeforeUploadRoutes`, `iiAiReviewBeforeWrite`, `m12aFdhBankAccuracyCorpus`, `m12aFdhBankIntakeGate`, `m12bInsuranceAccuracyCorpus` |
| **Removed** (they tested the code that was deleted; replaced by the files above) | `aiePilotCohort`, `iiAiFallbackPilotCohort`, `iiAiFallbackCohortGateUnreachable` |
| Config | `vitest.config.ts` sets the DEV-only override `AIE_ALLOW_AI_FALLBACK_WITHOUT_REAL_SCAN=true` for unit tests (they use fake providers and no scanner); the tests that prove the refusal delete it |

## 2. Results

**Full unit suite on this branch** (`vitest run --testTimeout=120000 --hookTimeout=120000 --maxWorkers=3`, 734 files, 28 min):
12,769 passed, 69 skipped, 48 failed in 44 files. The 44 files were then re-run on a clean extract of `origin/main`
`af2d330` with the same flags, and the difference was resolved one by one:

| Group | Files | Verdict |
|---|---|---|
| Fail on clean `origin/main` too (admin analytics route, held schemes, promo pglite proof, scheme mapping, 16 planning-benchmark and benchmark-data files, resources R1.1 / R1.7C / import, LR-1 raw file lifecycle, net-worth NAV publish flow, factsheet reader admin routes, country gate matrix MC-15 (it now sees the admin account-deletion route), `aiResidualClosureFailClosed` A4, `m12cServerOnlySecretBoundary`) | 36 | Pre-existing, unrelated to this change, not touched |
| Failed in the full run because of **my change** and were updated: `iiAiFallbackDocumentExtractionTrigger`, `iiDocumentProcessingAiFallbackWiring` (they built an II context with no entitlement row, which the new gate correctly refuses; they now use the shared Premium double, and the wiring file gained a Free-user test) | 2 | Fixed; both pass (43 of 43 across these and three neighbours) |
| Load / live-DEV flakes: pass when re-run alone on this branch (`resourcesPublicR1_5`, `resourcesDiscoveryR1_6LiveDev`, `resourcesAdminRoleCtaHotfixLiveDev`, `resourcesAdminR1_2`, `fdh1Isolation`, `benchmarkDataAdminRoutes` 286 of 286) | 6 | Not related to AI code |
| `resourcesR1_4LiveDev` is in the clean-main group above: it writes to shared DEV tables and fails on clean main too, with a different subset each run ("new row violates row-level security policy for table resource_posts") | (in the 36) | Not related to AI code |

`git checkout -- scripts/` was run after the suite (it rewrites checked-in certification artifacts).

Pre-existing failures, each confirmed on a clean extract of `origin/main` `af2d330`:

| Failure | On clean `origin/main` | On this branch |
|---|---|---|
| `tests/unit/m12cServerOnlySecretBoundary.test.ts` > "ENVIRONMENT_VARIABLES.md's quoted Amplify forward list matches amplify.yml exactly" | **fails** (the quoted list lacks the five promo / reminder prefixes that `amplify.yml` carries) | same single failure, unchanged. Not mine, not fixed here |
| `tsc --noEmit` | exactly one error: `tests/unit/canonicalCertResidueAllSql.test.ts(127,75)` | the same one error and nothing else |
| `eslint` on every changed / new file | n/a | clean |
| 11 tests in `m12a*/m12b*/aieOwnerBeforeUploadRoutes` at the 5 s default | time out under load on clean main too | pass with `--testTimeout=120000` |

## 3. DEV evidence (DEV-VERIFIED)

Setup: a local `next dev` of this branch on port 3981 (not 3973) with DEV Supabase only (`PRODUCTION_*` values removed
from the child environment, host check enforced), `AIE_REAL_MALWARE_SCAN_ENABLED=true` against the DEV S3 bucket and DEV
GuardDuty plan, `AIE_AI_PROVIDER=openai`, model `gpt-4o-mini`, all five class flags and `II_AI_FALLBACK_ENABLED` on, and the
RETIRED pilot variables deliberately left in the old shape listing one Free fixture. `AIE_DOCUMENT_INTAKE_ENABLED` unset,
allowance not raised. Existing synthetic fixture users only (sessions minted with `generate_link` + `verify`; no password
created, no user created). Fixture entitlements were set for the run and **restored** (all four were Free before and
after). Every row created by the run was removed by diff (0 residue).

Bank statement class (`dev_journeys_premium.mjs`), 28 of 28 checks:

| Check | Result |
|---|---|
| Premium A (never on any pilot list): real AI reading, draft stored server-side and owned by A | PASS. gpt-4o-mini, 1,286 input and 262 output tokens, cost about US$0.00035, 8.7 s, one provider request id recorded |
| Premium B (independent): own draft; B cannot process A's document (404); a Free user cannot confirm A's draft (422) | PASS |
| Free, and Free-but-listed-on-the-retired-pilot-variables: no draft, `ai_fallback_refusal = premium_required`, audit reason `premium_required` (not `cohort_denied`), no `attempted` event | PASS |
| Free refusals move nothing: ledger identical, cost-attempt row count unchanged | PASS (51 to 51) |
| Replay of the same document: existing draft returned, no new provider call or charge | PASS (52 to 52) |
| Forged `plan_tier` / `user_id` / `premium` in the query, body and headers from a Free client | PASS (still refused) |
| Accept the reviewed draft: three canonical rows, original file purged after the durable result; a replayed confirm writes nothing (409) | PASS |
| Downgrade: B's window ended, a new document is refused with no provider call (53 to 53), but B can still open the draft issued earlier | PASS |
| Upgrade: the former Free user, same session cookie, gets the AI reading on the next request | PASS |

Other classes (`dev_journeys_classes.mjs`), 15 of 15 checks: liability, retirement and AU investment CSVs. For each, Free
is scanned clean, gets no draft and `premium_required`, and moves nothing; Premium A gets a real draft and the call is accounted.

| Class | Input tokens | Output tokens | Cost (US$) |
|---|---|---|---|
| Liability statement | 1,724 | 373 | 0.000482 |
| Retirement statement | 2,379 | 518 | 0.000668 |
| AU investment statement | 1,321 | 216 | 0.000328 |

Concurrency (`dev_journeys_race.mjs`): see section 4.

Total DEV spend for the whole verification, including the concurrency runs: about US$0.0043 (the DEV ledger moved from US$0.02064 to
US$0.02492 settled, of the US$10 allowance; nothing reserved afterwards).

## 4. Concurrent first requests (DEV)

Five identical `/process` requests sent at the same instant for ONE fresh Premium document (bank class):

| | Provider calls (cost-attempt rows) | Draft rows | Responses |
|---|---|---|---|
| **Before the fix** (this branch without `singleFlight`) | **4** | 2 (one superseded, one pending) | 2 drafts and **3 reporting the document unreadable** while a draft existed |
| **After the fix** | **1** | 1 (pending review) | 4 drafts (the same one); 1 request answered 400 "not currently ready to be processed" because it arrived after the first had moved the document to processing (the existing state guard) |

That duplicate-charge and conflicting-state defect is pre-existing (it is the same code on `origin/main`) but wide Premium access makes
a double click or a retrying client real, so it is fixed here: `lib/ai/access/singleFlight.ts` wraps the chargeable section of all six
fallbacks (`tests/unit/singleFlight.test.ts`, including a wiring check). Honest limit: it is per server instance. Two requests that hit
two different serverless instances at the same instant are still protected only by the atomic ledger and the one-pending-draft
index. A database claim would close it and needs a migration, so it is a follow-up, not added unasked.

## 5. Not verified, stated plainly

- **Browser UI**: the new message and upgrade offer in the five import panels are type-checked and the response field they read
  is DEV-verified, but I did not drive the panels in a browser (no file-chooser tool in this session).
- **Payslip and Investment Intelligence classes** were not run live on DEV (their gate is the same shared code; the payslip inline
  gate and the II gate are unit-tested above).
- **Kill switch live**: unit-tested against the real gateway; not toggled on a running DEV server.
- **Payments**: the Free to Premium transition was done by writing the entitlement row; the Stripe / Razorpay webhook path that
  normally writes it was not exercised (it is unchanged and writes the same row).
- **Scheduled jobs**: none generates AI content on `main`; Module 11's scheduler is on another branch (see `07_...`).
- **Production**: nothing. See `05_...` for what you run.
