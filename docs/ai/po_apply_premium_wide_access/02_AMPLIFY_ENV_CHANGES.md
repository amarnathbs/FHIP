# Amplify environment: exact changes (production app, `main` branch)

Environment variables in Amplify take effect **only on the next build**. Changing a variable and not building changes
nothing. Pushing the change set builds, so every value below that you set BEFORE the push is applied by that same build.
No value below is a secret except the three marked SECRET, which you only CHECK EXIST; never paste a secret into chat or
a file.

## 0. The one ordering rule that matters

> **Do not delete the retired pilot variables (section 3) before the new code is live AND stable.**
> The OLD code (what runs today, and what you would roll back to) treats `AIE_PILOT_COHORT_ENFORCED` unset as
> "everybody is in the pilot". Deleting it first, or deleting it and then rolling back, would open the AI reading
> to every user without a Premium check. The new code ignores the three variables entirely, so leaving them set is
> harmless. Delete them last, after a full day of normal operation.

## 1. Stage the release closed (set BEFORE the push)

The moment the new build is live, every active Premium user gets AI reading for every document class whose flag is
already `true` in production. To keep it closed until your own proof is done, set the global kill switch off first:

| Variable | Set to | Why |
|---|---|---|
| `AIE_AI_FALLBACK_ENABLED` | `false` | Global kill switch: no AI call for any class or any user. Deterministic import and manual entry are unaffected. **You switch it back to `true` in step 3** |
| `II_AI_FALLBACK_ENABLED` | `false` | Same for Investment Intelligence statements |

(If you accept that activation happens on deploy, skip section 1 and apply section 2 before the push instead.)

## 2. Desired steady state (apply after the proof in the README, then build)

| Variable | Value | Notes |
|---|---|---|
| `AIE_AI_FALLBACK_ENABLED` | `true` | Global kill switch ON |
| `II_AI_FALLBACK_ENABLED` | `true` | Investment Intelligence statements |
| `AIE_PAYSLIP_AI_FALLBACK_ENABLED` | `true` | A1 |
| `AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED` | `true` | A2 |
| `AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED` | `true` | A3 |
| `AIE_LIABILITY_AI_FALLBACK_ENABLED` | `true` | A4 |
| `AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED` | `true` | A5 |
| `AIE_AI_PROVIDER` | `openai` | Unset means "unconfigured": every call fails closed (by design, never the mock) |
| `AIE_AI_MODEL` | unset (default `gpt-4o-mini`), or `gpt-4o-mini` | Any other model is refused by the gateway |
| `AIE_OPENAI_API_KEY` | **SECRET, must already exist** | Check only |
| `AIE_MASK_TOKEN_ENCRYPTION_KEY` | **SECRET, must already exist** (64 hex characters) | Without it masking throws and the AI is refused (fail closed) |
| `AIE_REAL_MALWARE_SCAN_ENABLED` | `true` | **Required by this change**: with it off the AI fallback is refused (`malware_scan_not_enforced`). Needs the AWS settings below |
| `AIE_MALWARE_S3_BUCKET`, `AIE_MALWARE_S3_REGION`, `AIE_MALWARE_S3_ACCOUNT_ID`, `AIE_MALWARE_AWS_ACCESS_KEY_ID`, `AIE_MALWARE_AWS_SECRET_ACCESS_KEY` | **SECRET / config, must already exist** | Check only. Incomplete settings make the scan fail closed (`scan_failed`) |
| `FDH_DOCUMENT_UPLOAD_ENABLED` | unset or `true` (never `false`) | Uploads are on in production by the hard-coded project allowlist unless this is `false` |
| `AIE_AI_COST_ALLOWANCE_USD` | **leave exactly as it is** | Not raised by this change. The stored ledger row is the real ceiling (read it with `sql/P03`) |
| `AIE_AI_TIMEOUT_MS`, `AIE_AI_MAX_*` | leave as they are | Cost bounds per document |

## 3. Retired variables: nothing reads them after this change

Delete **last** (see section 0): `AIE_PILOT_COHORT_ENFORCED`, `AIE_PILOT_COHORT_EMAILS`, `AIE_PILOT_COHORT_USER_IDS`,
`II_AI_FALLBACK_PILOT_COHORT_ENFORCED`, `II_AI_FALLBACK_PILOT_COHORT_USER_IDS`, `II_AI_FALLBACK_PILOT_COHORT_EMAILS`.

## 4. Must be unset or `false` in production

| Variable | Why |
|---|---|
| `AIE_ALLOW_AI_FALLBACK_WITHOUT_REAL_SCAN` | DEV-only override of the malware precondition. If set in production it silently removes the protection |
| `AIE_ALLOW_MISSING_SIGNATURE_SCANNER` | DEV-only (existing) |
| `AIE_DOCUMENT_INTAKE_ENABLED` | Used only by the four diagnostic AIE-fronted routes, which have no UI. The user-facing flows do not need it. Leaving it `true` makes those API routes reachable by every Premium user, which is NOT part of this release |
| `AIE_FDH_BANK_ADAPTER_ENABLED`, `AIE_II_ADAPTER_ENABLED`, `AIE_INSURANCE_ADAPTER_ENABLED`, `AIE_*_CANONICAL_WRITE_ENABLED`, `AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED` | Deferred pipelines |
| `AIE_REVIEW_*` | Belong to the deferred `/aie-review` inbox. Not needed |

## 5. Amplify forwarding

`amplify.yml` already forwards the `AIE_` and `II_AI_FALLBACK_` prefixes, so the variables above reach the runtime
with no change to `amplify.yml` (this release changes only its comments).

## 6. Rollback of the environment

Set `AIE_AI_FALLBACK_ENABLED=false` and `II_AI_FALLBACK_ENABLED=false`, then build. That alone stops every AI call for
every user, immediately after the build, and leaves deterministic imports, drafts already issued, review and
manual entry untouched. To stop one class, set only its `AIE_*_AI_FALLBACK_ENABLED` to `false`.
