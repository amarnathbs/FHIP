# AI features: inventory taken from the code on `origin/main` (af2d330), 14-10-2026

Method: every provider-reaching call shape, every route / server action / cron / DB function, every flag and environment
variable and every e-mail or user-id comparison under `app/`, `lib/`, `components/`, `supabase/migrations/`, `proxy.ts`,
`amplify.yml` was searched. Historical reports were used only as leads. Evidence label for everything below:
**read from code** unless stated.

## 1. Every restriction that existed (and what happened to it)

| Restriction | Where | What it did | Now |
|---|---|---|---|
| `AIE_PILOT_COHORT_ENFORCED`, `AIE_PILOT_COHORT_USER_IDS`, `AIE_PILOT_COHORT_EMAILS` | `lib/aie/featureFlags.ts` (`isUserInAiePilotCohort`) | Env allowlist by e-mail or user id. Unset enforcement meant everyone, enforced and empty meant nobody | **Removed from the code.** Nothing reads these variables any more |
| E-mail resolver for the cohort | `lib/aie/pilotCohortEmail.ts` (service-role Auth lookup) | Let an e-mail-only allowlist admit the 5 FDH services and the insurance route | **File deleted** |
| Shared fallback gate | `lib/aie/adapters/shared/fallbackGate.ts` | Adapter flag, global kill switch, cohort, masking for bank, AU investment, liability, retirement | Cohort step replaced by the Premium check (and a real-malware-scan precondition, see section 4) |
| Payslip inline gate | `payslipProcessingService.ts` `attemptAiPayslipFallback` | Same order, own copy | Same replacement |
| `II_AI_FALLBACK_PILOT_COHORT_ENFORCED/_USER_IDS/_EMAILS` | `lib/services/investment-intelligence/aiFallbackFeatureFlag.ts` | A second, separate allowlist for Investment Intelligence statements | **Removed**; Premium check instead |
| 5 AIE intake routes | `app/api/aie/{intake, insurance/intake, fdh-bank/intake, investment-intelligence/intake, investment-intelligence/intake/[id]/process}` | Cohort check after the intake flag | Premium check, same position (before any body read, row, or storage) |
| `userEmail` plumbing | `documentProcessing.ts` + 3 II routes | Carried the e-mail only for the cohort | Removed |
| Database | `supabase/migrations/**` | **No pilot list, e-mail comparison or cohort in any DB function** (searched). Only `0150` mentions a "pilot allowance" comment | Nothing to change |
| Hard-coded e-mails | `app`, `lib`, `components` | One unrelated recipient address in the contact form | Not related |
| Client visibility checks | `components/**` | None restricted by pilot or e-mail; Premium locked-state cards already exist | Unchanged |
| `proxy.ts` / middleware | | No AI route is pilot-listed | Unchanged |
| G4 module capability `AI_INSIGHTS` | `lib/services/appCapability.ts` | Country experience (AU/IN full, GENERIC unavailable). **Not a pilot**, deliberately untouched | Unchanged |
| Scheduled jobs that generate AI content | `app/api/**/cron` | **None exists on `main`** (cron routes are malware/purge sweeps, PC6/NAV, monthly report PDFs, Premium expiry e-mails). The Insight Pack batch cron is on the Module 11 branch only | See section 5 |

## 2. User-facing AI features that exist on `main`, and what changed

All Premium decisions use one function, `lib/ai/access/premiumAiAccess.ts` (`user_entitlements.plan_tier` plus its
`effective_from` / `effective_to` window, evaluated TODAY in UTC, fail closed). It is the same predicate the SQL AI
functions mirror (`ai_entitlement_state`, `ai_admit_request`, migration 0115) and report export / recommendations use.
Trial, past-due grace, cancel-at-period-end, promo and admin-granted Premium are all already encoded in that row by
`entitlementSync.ts`, the promo redemption and the admin grant, so they are honoured without special cases. Admin or
Analyst role is never consulted.

| # | Feature (document class) | Where the user meets it | Flags that must be true | Entitlement check (after) | Production readiness |
|---|---|---|---|---|---|
| A1 | Payslip AI reading | Income, payslip import | `AIE_AI_FALLBACK_ENABLED`, `AIE_PAYSLIP_AI_FALLBACK_ENABLED` | `attemptAiPayslipFallback` inline | Code ready. Env state unknown to me (see README) |
| A2 | Bank statement PDF AI reading | Expenses, bank import | `AIE_AI_FALLBACK_ENABLED`, `AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED` | `evaluateAiFallbackGate` | Code ready. Proven live on production only as far as the cohort refusal (01-10-2026 journey) |
| A3 | AU investment statement CSV | Investments | `AIE_AI_FALLBACK_ENABLED`, `AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED` | `evaluateAiFallbackGate` | Code ready |
| A4 | Liability (card / loan) statement CSV | Liabilities | `AIE_AI_FALLBACK_ENABLED`, `AIE_LIABILITY_AI_FALLBACK_ENABLED` | `evaluateAiFallbackGate` | Code ready |
| A5 | Retirement statement | Retirement | `AIE_AI_FALLBACK_ENABLED`, `AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED` | `evaluateAiFallbackGate` | Code ready |
| A6 | Investment Intelligence statement (India CAS and others) | Investments, statement import | `II_AI_FALLBACK_ENABLED` and `AIE_AI_FALLBACK_ENABLED` (gateway kill switch and cost ledger) | `getAiFallbackDocumentExtraction` | Code ready |
| A7 | Review, confirm, discard of the drafts produced by A1 to A6 | Import panels; `/api/financial-data-hub/*/ai-fallback/confirm`, `.../ai-draft/discard`, `/api/investment-intelligence/ai-extraction-reviews/*` | none beyond sign-in | **Deliberately NOT Premium-gated**: no new AI execution happens, the user must still be able to accept or reject work already done after a downgrade. Session user and tenant scoped (existing) | Existing, DEV-proven 25-09-2026 |
| B1 | Standard question library (`/ai-insights`) | Insights page | platform controls `ai_globally_enabled`, `custom_ai_enabled` (defaults on) | `ai_entitlement_state` (Premium + window) | **Zero provider cost**: answers come from the user's own certified data. No pilot existed. Unchanged. Needs migrations 0110, 0115, 0124 (P01) |
| B2 | Contextual Explain / Why? in 8 modules | Embedded controls | same | same | Zero provider cost. Unchanged. Needs 0126 |
| B3 | Entitlement read (`GET /api/ai/entitlement`) | Insights page | none | session user only | Read only |

Free user on A1 to A6: the normal deterministic import still runs; if the file is unreadable the document ends as it
always did, and the screen now says why no AI reading was tried and offers the upgrade (new `ai_fallback_refusal`
response field). Manual entry is untouched.

## 3. Present in the repository but NOT activated (listed separately, on purpose)

| Item | Why it stays off |
|---|---|
| Four AIE-fronted intake routes plus `.../process` (`/api/aie/intake`, `.../insurance/intake`, `.../fdh-bank/intake`, `.../investment-intelligence/intake`) and the `/aie-review` inbox | `lib/canonical-data/disposition/insurance.ts` lists them as `not_active`: no UI calls them, diagnostic / adapter pipeline. They got the Premium check instead of the cohort so no e-mail list remains, but they are still behind `AIE_DOCUMENT_INTAKE_ENABLED` and their adapter flags. **Leave those unset.** `AIE_DOCUMENT_INTAKE_ENABLED` is read by nothing in the user-facing flows A1 to A6 |
| Insurance adapter | No UI; flags unset |
| II reconciliation AI path `aiFallbackReconciliation.ts` | `resolveAieProvider()` returns `null` unconditionally: inert by construction |
| Factsheet reader (`factsheetReader/aieAdapter.ts`, cron `factsheet-benchmark-reader`) | Admin / index-data ingestion, not user-facing. Not activated |
| Insight Pack service and batch orchestrator | Trigger is admin-only (`/api/admin/ai/insight-packs/generate`, mock provider only); no user surface and no scheduler on `main` |
| Module 11 live provider adapters (`lib/ai/providers/openaiProvider.ts`) | Throw `PROVIDER_UNAVAILABLE` by design on `main`; only the mock provider is wired |
| `POST /api/internal/ai/resolve` and `/api/internal/ai/provider/health` | Internal testers; the resolver blocks live AI by policy; health uses the mock provider |
| Admin AI operations (`/api/admin/ai/**`) | Out of scope by instruction; not touched |
| Market-data ingestion, risk-free refresh, benchmark crons | Out of scope by instruction; not touched |
| AI Coach (free-text questions), Next Best Action, scheduled monthly Insight Pack, Module 11.6 / 11.7 | **Not on `main`: blocked on the Module 11 merge.** See `07_MODULE11_POST_MERGE_NOTES.md` |
| Signed upload URLs | None exist (`createSignedUploadUrl` is not used anywhere); all uploads are server-mediated, so there is no second issuance point to guard |

## 4. Controls that still bound broader use (unchanged, not raised)

| Control | Value found in code | Does it constrain wide use? |
|---|---|---|
| Kill switches | `AIE_AI_FALLBACK_ENABLED` (global), 5 per-class flags, `II_AI_FALLBACK_ENABLED`; all default OFF unless the literal `true` | Yes by design. They are the rollback |
| AIE spend ceiling | **One GLOBAL ledger**, default US$10 total (`AIE_AI_COST_ALLOWANCE_USD`, stored `aie_ai_cost_ledger.allowance_usd`), atomic reserve before the call, settle after, stale reservations settled conservatively | **Yes.** Once it is spent the AI reading refuses for everyone ("capacity") until the PO raises it. Not raised here. Read it with `sql/P03` |
| AIE per-user spend or count limit | **None exists** | **A gap.** One Premium user can use the whole global ceiling. Recommended follow-up (needs a migration, so not done unasked) |
| Per document limits | 4000 input tokens reserved, 512 output (4096 for line-item documents), 2 transient retries, 20 s timeout, `gpt-4o-mini` only | Yes; they bound cost per document |
| Idempotency | Cost key per attempt, a replayed key is never admitted again (0195); durable draft is claimed once on confirm (0197); a repeat of an already-read document returns the stored draft with no new call | Prevents duplicate provider calls / charges for sequential repeats |
| Concurrent identical requests (**new**) | `lib/ai/access/singleFlight.ts`: concurrent callers for the same user + document + class share ONE gate + provider call + draft write. Found on DEV: five simultaneous identical requests made four metered calls and left the document in conflicting states | Fixed per server instance. **Cross-instance** simultaneity still relies on the atomic ledger and the unique pending-draft index; a database claim is the listed follow-up |
| Real malware scan precondition (**new**) | `lib/aie/malware/aiEgressPrecondition.ts`: the AI fallback is refused (`malware_scan_not_enforced`) unless `AIE_REAL_MALWARE_SCAN_ENABLED=true` (DEV-only override `AIE_ALLOW_AI_FALLBACK_WITHOUT_REAL_SCAN`) | Fail closed. Added because the existing upload admission treats "scan off" as "not required"; that is acceptable for the in-process reader, not for sending every Premium user's document content out |
| Masking | `AIE_MASK_TOKEN_ENCRYPTION_KEY` required; masking failure refuses | Yes; unchanged |
| Module 11 | 10 custom questions a month, 12 requests an hour, US$5 per user a month, US$500 platform a month, US$0.50 per request (defaults in `ai_platform_controls`) | Only matters once a live provider path exists (Module 11 branch); the zero-cost features on `main` do not consume it |
