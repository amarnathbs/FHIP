# 1. Production configuration: what is known, what is not, and how you find out

Evidence labels used throughout: **UNIT-TESTED**, **PGLITE-VERIFIED**, **DEV-verified**, **PRODUCTION-VERIFIED**, **NOT PERFORMED**, **UNKNOWN**.
Nothing in this pack is PRODUCTION-VERIFIED. The engineer who prepared it has no production credentials (they are stripped from the
environment) and did not use any stored cloud sign-in against production.

## 1. What was inspected, and what was not

| Item | Result | Label |
|---|---|---|
| Amplify console, app-level and branch-level variables | **NOT PERFORMED.** No authorised tool. The machine has an AWS command line with a stored profile; it was deliberately not used against production Amplify (the brief says no production credentials). Use section 3 instead | NOT PERFORMED |
| Which commit Amplify runs | **UNKNOWN** from the console. A public, unauthenticated probe on 19/10/2026 shows the live build contains the route added by commit `e9e6a87` (16/10/2026): `GET /api/admin/entitlements/staff` answered 401, while a non-existent sibling answered 404. That is a lower bound only. It implies the Premium AI guard (`83b94a4`) and Premium-only uploads (`cc1f30e`) are in the build, but NOT that the per-user cap commit `1501882` is (it is not an ancestor of `e9e6a87`) | lower bound only |
| `amplify.yml` on `origin/main` (22db19b) | Read. See section 2 | read from code |
| Production flag values, model, keys, AWS settings, cap and ledger values | **UNKNOWN.** Not assumed to be on or off. Section 3 returns them as booleans and presence only | UNKNOWN |
| Production database objects (migrations 0160, 0197, 0236, 0284 ...) | **UNKNOWN.** `sql/A01` returns present true/false per object | UNKNOWN |

**One dependency decides everything: migration 0284.** The code on `main` calls the database function `aie_reserve_ai_cost_v2`. If a build that
contains the per-user cap code is live and 0284 is not applied on production, **every AI reading is refused** (fail closed by design, it
never falls back to the uncapped function). The reverse is harmless. So `sql/A01` row "Per-user daily cap function" is the first thing to read.

## 2. How a variable reaches the running server (read from `amplify.yml`)

On Amplify a Next.js server component or API route cannot see console variables. The build writes the matching ones into `.env.production`
with one line: `env | grep -e SUPABASE_SERVICE_ROLE_KEY -e CRON_SECRET ... -e AIE_ ... -e II_AI_FALLBACK_ >> .env.production`.
Consequences:

* A variable is seen by the server only if its **name matches a term on that line** AND **a build ran after it was set**. Changing a console
  value without building changes nothing.
* Forwarded on `main`: the whole `AIE_` and `II_AI_FALLBACK_` prefixes (every document-AI flag, the OpenAI key `AIE_OPENAI_API_KEY`, the masking
  key, the five `AIE_MALWARE_*` scan settings, the cost settings), `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `APP_BASE_URL`, `STRIPE_`, `RAZORPAY_`, `ROLLOUT_`, `PREMIUM_*`.
* **Not forwarded on `main`, with consequences** (UNIT-TESTED by `tests/unit/premiumAiProductionConfig.test.ts`, which fails if a new
  AI-path variable is added without being forwarded):
  1. `FDH_DOCUMENT_UPLOAD_ENABLED` (the upload kill switch). A console value of `false` never reaches the server, and the code treats anything but
     the exact text `false` as on. So uploads cannot be switched off from the console. **Open finding.** Forwarding it is a deliberate change: if the
     console holds a stale `false`, forwarding it would switch uploads off.
  2. `MODULE11_*` and `OPENAI_API_KEY` (Module 11 only). `main` has no live Module 11 provider, so nothing is lost today; the Module 11 branch adds
     `-e MODULE11_ -e OPENAI_API_KEY` (read by the Module 11 pack).
  3. `FACTSHEET_READER_AI_ENABLED` (an unrelated internal job): not forwarded, so the document-AI kill switch cannot start it.
  4. `AWS_ACCESS_KEY_ID` and friends: Amplify reserves AWS_ names; the scanner uses `AIE_MALWARE_AWS_*`, which are forwarded.
* The flags are read per request from `process.env`, so a new build is the only step needed after changing them.

## 3. Operator checks you run (all read-only; none prints a secret)

### 3.1 Amplify variables: `tools/Check-AmplifyAiConfig.ps1`

```powershell
.\Check-AmplifyAiConfig.ps1 -AppId <your Amplify app id> -Region <the console region>
```

It reads the app-level and branch-level variables with your own AWS sign-in and prints, per name: where it is set (branch overrides app),
the value **only for plain switches and numbers**, otherwise `set (hidden)` or `MISSING`, whether `amplify.yml` forwards that name, and a verdict
against the expected setting. Secrets are never printed (checked with a mocked `aws` in the engineer's session: a planted secret value did not
appear). Paste the table into the evidence sheet. If you prefer the console, the names to look at are exactly the first column of that table.

Expected values for the proof (a variable not listed here does not matter to it):

| Group | Names | Expected |
|---|---|---|
| Global and per-class switches | `AIE_AI_FALLBACK_ENABLED`, `II_AI_FALLBACK_ENABLED`, `AIE_PAYSLIP_AI_FALLBACK_ENABLED`, `AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED`, `AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED`, `AIE_LIABILITY_AI_FALLBACK_ENABLED`, `AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED` | exactly `true` (anything else is off) |
| Real scan | `AIE_REAL_MALWARE_SCAN_ENABLED` | exactly `true`. With it off the AI reading refuses (`malware_scan_not_enforced`) |
| Provider | `AIE_AI_PROVIDER` | exactly `openai`. **`mock` is accepted by the code in any environment** (see finding F-3); unset means "unconfigured" and fails every call closed |
| Model | `AIE_AI_MODEL` | unset or `gpt-4o-mini`; any other model is refused |
| Secrets / settings that must exist | `AIE_OPENAI_API_KEY`, `AIE_MASK_TOKEN_ENCRYPTION_KEY` (64 hex), `AIE_MALWARE_S3_BUCKET`, `_REGION`, `_ACCOUNT_ID`, `AIE_MALWARE_AWS_ACCESS_KEY_ID`, `AIE_MALWARE_AWS_SECRET_ACCESS_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `APP_BASE_URL` | present. Incomplete scan settings make the scan fail closed (`scan_failed`) |
| Must be unset or `false` | `AIE_ALLOW_AI_FALLBACK_WITHOUT_REAL_SCAN`, `AIE_ALLOW_MISSING_SIGNATURE_SCANNER` (DEV-only overrides that silently remove protections); `AIE_DOCUMENT_INTAKE_ENABLED`, `AIE_FDH_BANK_ADAPTER_ENABLED`, `AIE_II_ADAPTER_ENABLED`, `AIE_INSURANCE_ADAPTER_ENABLED`, the `*_CANONICAL_WRITE_ENABLED` and `AIE_REVIEW_*` switches (deferred pipelines, section 6 of `02_...`); `FACTSHEET_READER_AI_ENABLED` | unset or false |
| Cost | `AIE_AI_COST_ALLOWANCE_USD`, `AIE_USER_DAILY_COST_CAP_USD` | leave as they are. Each can only LOWER the figure stored in the database (the database takes the smaller) |
| Retired | the six `*_PILOT_COHORT_*` names | whatever they hold, no code reads them. Delete them after one stable day |

### 3.2 Database state: `sql/A01`, `A02`, `A03`, `A04` (read-only)

Run on DEV first (address bar must show project `vqycarelcoijzwlpkpcz`), then on production (`twwpnltizhtjxhamyoxt`). One statement per file.
`A01` every `present` true (the 0284 row is the critical one; the 0160 row decides whether the Investment Intelligence AI review can save). `A02` gives the
ledger (stored allowance, settled, remaining, per-user cap), reservations open over an hour (should be 0) and the number of active Premium accounts today.
`A03`/`A04` show the four scheduled jobs that finish the malware scan and delete original files.

### 3.3 Premium enforcement (read from code, UNIT-TESTED, DEV-verified)

One predicate decides: an active `user_entitlements` row with plan `premium` whose window (`effective_from`, `effective_to`) contains today (UTC),
read on every request with no cache. It is `lib/ai/access/premiumAiAccess.ts` (the AI step) and `lib/entitlements/financialDataImport.ts`
(every customer upload, retry and re-process). Admin or Analyst role never counts. Staff accounts are Premium only because the database gives them a
real `staff_admin` entitlement row (migration 0283).

## 4. Retired pilot settings: no effect, and every remaining reference

**Proof.** `tests/unit/premiumAiProductionConfig.test.ts` (UNIT-TESTED) drives the real shared gate with the six retired variables absent, set
to name only the former pilot, and set to name nobody who is testing. In all three states the verdict is the entitlement alone: Free and expired
former-pilot users are refused `premium_required`; Premium former-pilot and never-pilot users are admitted; and with the global switch off, or the
scan flag off, both kinds of Premium user get the same refusal. A second test strips comments from every file under `lib`, `app` and `components`
and finds no reference to a retired name or helper; `lib/aie/pilotCohortEmail.ts` is gone; no e-mail literal is compared in any AI scope.
DEV-verified on 19/10/2026: a Premium-then-lapsed account whose e-mail was listed on the retired variables (the DEV server still sets them)
was refused `premium_required`, not `cohort_denied`, with no provider attempt and nothing charged.

**Every remaining reference (all comments or prose, none executable):**

| Where | What it is |
|---|---|
| `amplify.yml` lines 80-87, 129-131, 145 | Comments explaining why the prefixes are forwarded and that the allowlists were removed |
| `lib/aie/featureFlags.ts` 33-34 | Comment: the cohort was removed 14/10/2026 |
| `lib/services/investment-intelligence/aiFallbackFeatureFlag.ts` 34 | Comment, same |
| `lib/services/investment-intelligence/aiFallbackDocumentExtraction.ts` 300 | Comment, same |
| `lib/aie/adapters/*/featureFlags.ts` (bank, AU investment, liability, retirement, payslip) | Stale doc comments that still say "reuses the shared pilot cohort". Harmless; worth a tidy-up |
| `lib/ai/access/premiumAiAccess.ts` | Comment stating that pilot membership neither grants nor denies |
| `.env.example`, `ENVIRONMENT_VARIABLES.md` | Notes that the variables were removed |
| `tests/unit/*` (5 files) | Tests that set the retired variables to prove they change nothing |
| `docs/**`, `scripts/aie1_*` | History (the 01/10/2026 production journey that hit `cohort_denied`, and its harness) |

## 5. Runtime proof by behaviour: which refusal names which missing setting

The console cannot prove what the running server sees. The first Premium bank journey does: when the AI step does not run, the document's audit
event `bank_statement_ai_fallback_not_usable` (sql `E02`) carries a `reason`. Read it like this:

| `reason` | Meaning | Fix |
|---|---|---|
| `adapter_disabled` | the class flag is not exactly `true` at runtime (or not built in) | set it, build |
| `global_kill_switch_disabled` | `AIE_AI_FALLBACK_ENABLED` not `true` at runtime | set it, build |
| `malware_scan_not_enforced` | `AIE_REAL_MALWARE_SCAN_ENABLED` not `true` at runtime | set it (and the five scan settings), build |
| `premium_required` / `entitlement_unavailable` | the account is not Premium today / the plan could not be read | grant Premium / check the database connection |
| `masking_unavailable` | `AIE_MASK_TOKEN_ENCRYPTION_KEY` missing | set it, build |
| `masking_below_policy`, `no_extracted_text` | the document, not the configuration | |
| `kill_switch_blocked` | gateway kill switch off | |
| `budget_exhausted` | global lifetime ceiling used up | raise the stored `allowance_usd` (`sql/ops/O01`, section 5 of `05_...`) |
| `user_daily_cap_reached` | that account used its US$1.00 for the UTC day | wait, or change the stored cap |
| a provider outcome: `provider_error` | `AIE_AI_PROVIDER` unset (unconfigured), key missing or rejected, network, or the provider refused | check provider and key |
| `schema_rejected`, `refused`, `timeout`, `rate_limited` | the model answered badly or too slowly | retry once; record |

A **successful** run proves in one go: the global and class flags, the scan flag and scan settings, the provider, the key, the masking key,
the service-role key, the per-user cap function and the ledger. The sign that the model was real and not the mock: `E02` shows `ai_model` =
`gpt-4o-mini` **and** a provider request id count of 1 or more (the mock returns neither).

## 6. Findings from this inspection

| # | Finding | Severity | Status |
|---|---|---|---|
| F-1 | `FDH_DOCUMENT_UPLOAD_ENABLED` is not forwarded: the upload kill switch cannot be operated from the console | Medium (rollback gap) | Open. Not changed (could switch uploads off if the console holds a stale `false`) |
| F-2 | Migration 0284 must exist on production before (or with) any build that has the cap code, or every AI reading is refused | High if unmet | Check with `sql/A01` |
| F-3 | `AIE_AI_PROVIDER=mock` is honoured in any environment. A mistaken `mock` in production would "succeed" with an empty reading and no provider request id | Low (needs a mistake) | Open. The proof detects it (no request id). Recommended hardening: ignore `mock` when `NODE_ENV` is production |
| F-4 | On DEV the S3 scan-copy delete was answered `access_denied` (`verified: unverifiable`) for the DEV scan role. The copy is supposed to be deleted right after the verdict. Production permission is **UNKNOWN** | Medium (derivative copy of the uploaded document) | Check `sql/E01` (`scan_copy_purge_verified`) and `E09` on production |
| F-5 | Cross-instance duplicate protection relies on the atomic ledger and the unique pending-draft index; the in-memory single-flight is per server instance | Low (a duplicate costs a fraction of a cent, bounded by the per-user cap) | Known, unchanged |
| F-6 | `MODULE11_*` and `OPENAI_API_KEY` are not forwarded on `main` | None today (no live Module 11 provider on `main`) | Becomes a blocker when the Module 11 branch merges (it adds the forwarding) |
