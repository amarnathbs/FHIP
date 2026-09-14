# II Post-PC4 — Repository, Branch, Migration and Environment Baseline

**Mission:** FHIP — Investment Intelligence + AIE-1 Convergence, Master End-to-End Execution
**Phase:** M0 — Baseline and scope freeze (Part F of the master dispatch)
**Date:** 2026-09-15
**Branch:** `mission/m0-baseline-2026-09-15`
**Companion document:** `II_POST_PC4_MASTER_SCOPE_LEDGER_2026-09-15.md` (Part C)

**Discovery and documentation only.** No application code was modified. No migration was
applied. No OpenAI call and no AWS API call were made. Nothing was pushed. Every database
statement below came from a **read-only** PostgREST `GET` with paired negative controls; no
`POST`, no RPC execution, no DDL, no DML. No credential value appears anywhere in this
document.

---

## F.1 Git baseline

### F.1.1 Fetch

`git fetch --all --prune` was run at 2026-09-15. **`origin` fetched successfully.** A second
remote, **`doclife`, is broken**: it points at `D:/FHIP/.claude/worktrees/doc-lifecycle`, a
path that no longer exists, and every `--all` fetch therefore fails on it with
`fatal: ... does not appear to be a git repository`. This is cosmetic but it makes
`git fetch --all` return a non-zero exit code, which will break any script that checks it.
Recorded as housekeeping item **HK-1**; not fixed in this discovery-only phase.

| Remote | URL | Status |
|---|---|---|
| `origin` | `https://github.com/amarnathbs/FHIP.git` | OK |
| `doclife` | `D:/FHIP/.claude/worktrees/doc-lifecycle` | **BROKEN — path does not exist** |

### F.1.2 Branch / HEAD / upstream

| Item | Value |
|---|---|
| This phase's branch | `mission/m0-baseline-2026-09-15` |
| Upstream | **None** (deliberate — this phase does not push) |
| Base commit | `23b49da1d63c9c20f980ea9042e176845b6f60e3` |
| `origin/main` HEAD | `23b49da1d63c9c20f980ea9042e176845b6f60e3` — *"Merge remote-tracking branch 'origin/fix/app-review-live-defects-2026-09-14' into HEAD"*, 2026-09-15 00:07:20 +1000 |
| Local `main` | `582d5e17f678c7b5daf0cf03ab075103327048fd` (2026-09-05) — **176 commits behind `origin/main`**, do not use |
| Worktree dirty state (this branch) | Clean, 0 modified/untracked files before the two deliverables were written |

> **`origin/main` moved during this phase.** At the start of M0 `origin/main` was
> `ff35f54c5eb78bcdf91a9e32b25108712351986f` (2026-09-14 14:44). By the time the migration
> registry was inventoried it was `23b49da` — six commits later: `21afbd4` (FDH-9 payslip
> deduction-sign fix), `ea95507` (**LR P0-1 SMSF-linked property loan double-subtraction from
> Net Worth**), `8c44b5b` (reports crash on pre-Phase-0C report), `6773b3e` (nav: Reports
> group), `a136316`, `23b49da` (merges). This branch was reset onto `23b49da` before any
> document was written, so every count in both deliverables is against `23b49da`. **Phase 2
> must re-fetch; `main` is actively moving.**

### F.1.3 Scale

| Item | Count |
|---|---|
| Local branches | 295 |
| Remote branches on `origin` | 51 |
| Registered git worktrees | 89 |

The shared checkout at `D:\FHIP` sits on `feature/phase1-design-system` (`c9e4041`) and carries
a large set of untracked `_tmp_*.sql` / `_tmp_*.md` working files. Those are scratch artifacts,
not deliverables; none of them is a committed migration. Recorded as housekeeping item **HK-2**.

### F.1.4 Unpushed local-only work

**No AIE work is local-only.** All 11 AIE branches were verified against the real remote with
`git ls-remote origin "refs/heads/*aie*"` and every local SHA matches its remote SHA exactly.
This **contradicts the AIE closure reports' own repeated claim of "Not pushed"** and is recorded
as a conflict in the scope ledger §3.8.

| Branch | SHA (local == remote) |
|---|---|
| `feature/aie-1-1-document-gateway` | `cd2d4a2c4d9a4f475dff5f9db2561b201c399591` |
| `feature/aie-1-2-investment-adapter` | `5ac527e2976f60b295ef0ba90cbb77634dad551a` |
| `feature/aie-1-3-fdh-bank-adapter` | `cf206169ab4ddeffb4ac1fe3af66ba409c177bc5` |
| `feature/aie-1-4-other-modules` | `90c1ffb5a79762c45be65786506fa5fa371ea216` |
| `feature/aie-1-5-exception-review-ux` | `17fe49610e845c6dd606d761e9b4791e61dfd8c1` |
| `feature/aie-1-6-certification` | `b22fc4298ba2ed920f9cf4c732ac55f3a108ecd1` |
| `feature/aie-1-merge-plan` | `3c88ba326edc579f1299da9cd6c23bd32d11d633` |
| `feature/aie-1-production-cert-plan` | `6b2854f0f784f04643cbecd96cf67208b8b8ee12` |
| `fix/aie-1-1-pdf-flatedecode-detection` | `1afceec3359700e7cc44b534cebf9bf179d23183` |
| `integration/aie-1-release-candidate` | `80e707b99b77fb3e4012473410e267f27f74bf30` |
| **`feature/aie-1-final-closure`** | **`74b7a5e72eac0ceb91615b18d6b4e0027c8f616b`** |

### F.1.5 Active PC branches

**None.** No branch on any ref is named for PC4–PC10. PC4's work reached `main` through
ordinary fix commits (`c22ea75`, `1ab6d40`, `a978382`, `8519148`, `77c059e`, `02b3754`,
`e946557`) rather than a dedicated branch. There is nothing to preserve or recover on a PC
branch.

---

## F.2 Current AIE-1 closure tip (proved by ancestry, not by report text)

**Tip: `feature/aie-1-final-closure` @ `74b7a5e72eac0ceb91615b18d6b4e0027c8f616b`**
2026-09-14 16:54:08 +1000 — *"test(aie1-infra): independent production verification of
migrations 0149-0152 (14/14 PASS)"*.

### F.2.1 Ancestry proof

`git merge-base --is-ancestor <branch> 74b7a5e` returns **YES for all ten other AIE branches**
listed in F.1.4. There is exactly one AIE tip; no orphan AIE work exists outside it.

`git merge-base --is-ancestor 74b7a5e origin/main` returns **NO** — the tip is not merged.

| Measure | Value |
|---|---|
| Merge-base with `origin/main` | `9793949b17164f5f50747b73040972fcd5c1a58b`, 2026-09-11 18:02:47 +1000 |
| Commits on `origin/main` not on tip | **75** |
| Commits on tip not on `origin/main` | **84** |
| Commits on tip after the release candidate (`80e707b`) | **37** |
| AIE source files under `lib/`+`app/` on `origin/main` | **0** |
| `docs/aie-programme/` directory on `origin/main` | **does not exist** |

### F.2.2 The 37 post-release-candidate commits

Range `integration/aie-1-release-candidate..feature/aie-1-final-closure`, oldest to newest:
`7ac548b`→`74b7a5e`. Materially they add: the real OpenAI GPT-4o mini provider + provider
factory + document-lifecycle purge job (`7ac548b`), atomic AI cost/quota admission (`44dcc42`),
the GuardDuty scan-result decision gate (`5646ab2`), the PC5 exception-consumption interface +
AWS runbook (`2394377`), the allowlisted pilot-cohort gate (`093a44f`), automated accessibility
scanning (`80463a0`), the 0147/0148→0149/0150 renumber (`121cfd4`), three real cost-admission
defect fixes (`be5af50`, `c4e25e0`, plus `3fcb4fa` verification), four real review-UI render-gap
fixes (`4026637`, `7b2d4b3`), the 24h hard-retention backstop proof (`5b30c8f`), the
masking-before-egress proof that found and fixed a real DEV config gap (`555795f`, `481e7fd`),
the live-DEV HTTP cross-tenant proof (`5958545`), the **first real OpenAI call** (`c674832`),
and the **production verification of 0149–0152** (`74b7a5e`).

> Three of those commits post-date the "latest" consolidated report and falsify two of its own
> headline claims. See scope ledger §3.8.

---

## F.3 Migration registry

### F.3.1 Repository registry — `origin/main` @ `23b49da`

| Measure | Value |
|---|---|
| Active migration files (`supabase/migrations/`) | **136** |
| Version range | `0001` … `0148` |
| Duplicate version numbers | **NONE** |
| Unused version numbers (holes) | `0079`, `0080`, `0081`, `0103`, `0128`, **`0140`–`0146`** |
| `scripts/check-migration-versions.mjs` result | `OK: 136 active migrations, one file per version, next version is 0149.` |

Tail of the chain on `main`: `0138_g6_contract2_country_code_columns.sql`,
`0139_g6_contract3_snapshot_fx_lineage.sql`, `0147_g8_generic_archive_bypass_fix.sql`,
`0148_lr_p0_2_restore_smsf_balance_write_guard_bracket.sql`.

The `0140`–`0146` hole is **exactly the AIE-1 block**, which lives only on
`feature/aie-1-final-closure`.

### F.3.2 Repository registry — AIE tip @ `74b7a5e`

| Measure | Value |
|---|---|
| Active migration files | **143** |
| Duplicate version numbers | **NONE** |
| On tip but not on `main` (11) | `0140_aie1_1_shared_document_gateway`, `0141_aie1_2_investment_adapter_link`, `0142_aie1_3_fdh_bank_statement_adapter`, `0143_aie1_4_insurance_adapter_link`, `0144_aie1_5_review_decision_correction_columns`, `0145_aie1_merge_fdh_bank_upload_metadata`, `0146_aie1_adapter_link_trigger_column_fix`, `0149_aie1_closure_document_lifecycle_purge`, `0150_aie1_closure_cost_admission`, `0151_aie1_cost_admission_reserve_single_row_fix`, `0152_aie1_cost_admission_idempotent_reserve_settle` |
| On `main` but not on tip (4) | `0138`, `0139`, `0147`, `0148` — the tip's merge-base predates them |

136 − 4 + 11 = 143 ✔ (arithmetic consistent).

### F.3.3 Applied registries — DEV and PRODUCTION (live read-only probe)

`supabase_migrations.schema_migrations` is **not reachable**: it is not exposed through
PostgREST on either project (`PGRST205` on both `schema_migrations` and
`supabase_migrations.schema_migrations`), and **no SQL-execution RPC exists** on either project
(`exec_sql`, `execute_sql`, `run_sql`, `admin_exec`, `sql` all return `PGRST202`). **Applied
migration *names and checksums* therefore could not be listed**, on DEV or on production. This
is an environment capability limit, not a permission refusal, and is recorded as operator-action
item **OA-3**.

In its place, each migration's own DDL target was probed for existence — read-only `GET` with
`limit=1`, with two negative controls per environment that both correctly reported absence
(`zz_no_such_table_m0` → `PGRST205`; `aie_document_intake.zz_no_such_column_m0` → `42703`),
proving the method is sound rather than returning false positives.

| Migration | Probe (read-only) | DEV | PRODUCTION |
|---|---|---|---|
| `0138` G6 country_code columns | `income_sources.country_code` | **PRESENT** | **PRESENT** |
| `0139` G6 snapshot fx lineage | `financial_snapshots.fx_rate_aud_inr` | **PRESENT** | **PRESENT** |
| `0140` AIE-1.1 gateway | `aie_document_intake.id` | **PRESENT** | **PRESENT** |
| `0141` AIE-1.2 II adapter link | `aie_ii_adapter_link.id` | **PRESENT** | **PRESENT** |
| `0142` AIE-1.3 FDH bank adapter | `aie_write_batch.id` | **PRESENT** | **PRESENT** |
| `0143` AIE-1.4 insurance adapter link | `aie_insurance_adapter_link.id` | **PRESENT** | **PRESENT** |
| `0144` AIE-1.5 review correction columns | `aie_review_decision.correction_field_name`, `.correction_value_raw`, `.correction_value_normalized` | **PRESENT** | **PRESENT** |
| `0145` AIE FDH bank upload metadata | `aie_document_intake.fdh_bank_upload_metadata` | **PRESENT** | **PRESENT** |
| `0149` AIE closure purge | `aie_document_intake.purge_status`, `.purge_due_at`, `.purged_at`, `.purge_reason` | **PRESENT** | **PRESENT** |
| `0150` AIE closure cost admission | `aie_ai_cost_ledger.id` | **PRESENT** | **PRESENT** |
| `0152` AIE cost idempotency | `aie_ai_cost_attempt.idempotency_key` | **PRESENT** | **PRESENT** |
| `0146` adapter-link trigger fix | trigger + function only | **NOT PROBEABLE read-only** | **NOT PROBEABLE read-only** |
| `0147` G8 generic archive bypass | RLS policy only | **NOT PROBEABLE read-only** | **NOT PROBEABLE read-only** |
| `0148` LR P0-2 `smsf_recompute_fund` | function body replacement | **NOT PROBEABLE read-only** | **NOT PROBEABLE read-only** |
| `0151` reserve single-row fix | function body replacement | **NOT PROBEABLE read-only** | **NOT PROBEABLE read-only** |

`0146`, `0147`, `0148` and `0151` change only a trigger, an RLS policy, or a function *body*.
Confirming them would require **executing** a volatile function, which is a write — deliberately
not done in a discovery-only phase. They are recorded as verification item **OA-4** for a phase
with write authority. (Independent evidence exists for `0151`/`0152` in commit `74b7a5e`, which
functionally exercised `aie_reserve_ai_cost`'s 4-argument signature against production.)

### F.3.4 Checksum differences

**Not determinable.** No applied-migration ledger is readable from either environment (F.3.3),
so no checksum comparison between repository files and applied migrations is possible from this
execution environment. Recorded as **OA-3**.

### F.3.5 Duplicates and collisions

**No live collision exists today.** Both historical collisions were genuinely resolved, and the
resolutions are verifiable in the tree:

| Collision | Resolved by | Evidence |
|---|---|---|
| `0141` claimed by both AIE-1.2 (`1c968ca`) and AIE-1.3 (`8c89bc8`) | AIE-1.3 renumbered `0141` → `0142` | commit `83eb0cd` |
| `0147`/`0148` claimed by both AIE closure (`7ac548b`, `44dcc42`) and `main`'s G8/LR-P0 work (`3632ad2`, `ea95507`) | AIE closure renumbered `0147`/`0148` → `0149`/`0150` | commit `121cfd4` |

### F.3.6 Migrations present in a DB but absent from current `main` — **the key finding**

> **Eleven AIE migrations are applied to BOTH DEV and PRODUCTION while none of them exists on
> `main` and none of their application code is merged or deployed.**
>
> Nine of the eleven were positively proved present in production by this pass's read-only probe
> (`0140`, `0141`, `0142`, `0143`, `0144`, `0145`, `0149`, `0150`, `0152`); the remaining two
> (`0146`, `0151`) are function/trigger-only and were not probeable read-only, but `74b7a5e`
> records `0151`/`0152` as applied to production and functionally verified there.
>
> **Why this matters for every later phase:**
> 1. Production carries AIE schema objects that the deployed application knows nothing about.
>    They are inert (no route references them), but they are real, they are in the production
>    security surface, and they are not represented in `main`'s migration chain.
> 2. A fresh database rebuilt from `main` today would **not** match DEV or production.
> 3. Under Part U.1 ("never assume numbers"), the AIE block must be merged onto `main`
>    **without renumbering** — every one of these migrations is already applied to a shared
>    environment, so re-emitting effects forward is the only legal correction if anything is
>    wrong with them.

### F.3.7 Migrations present on a branch but not in a DB

None identified. Every AIE migration on the tip probes present (or is independently recorded as
applied). `main`'s own `0147` and `0148` were not read-only probeable; their application state is
part of **OA-4**.

### F.3.8 Live collision hazard for the next migration

`scripts/check-migration-versions.mjs` on `main` reports **"next version is 0149"** — but `0149`,
`0150`, `0151` and `0152` are already taken by AIE **and already applied to DEV and production**.

> **Any new migration created on `main` before the AIE block is merged will collide with an
> already-applied migration.** The next genuinely free version is **`0153`**. This is the single
> most actionable migration-governance item out of M0 and must be respected by every later phase
> (Part U.1/U.2). Recorded as **MG-1**.

---

## F.4 Configuration inventory

Status vocabulary: `PRESENT` / `MISSING` / `MISCONFIGURED`. **No secret value is printed.**
Lengths and key-format prefixes are reported only where they evidence a real finding.

### F.4.1 Supabase

| Variable | Status | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **PRESENT** | DEV project. Verified **not equal** to the production URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **PRESENT** | New-format publishable key. |
| `SUPABASE_SERVICE_ROLE_KEY` | **PRESENT** | Legacy JWT format. |
| `PRODUCTION_SUPABASE_URL` | **PRESENT** | Verified **distinct** from the DEV URL. |
| `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` | **PRESENT** | New-format `sb_secret_` key. Verified **not equal** to the DEV service key. Both were exercised read-only this pass and both work. |

### F.4.2 OpenAI / AIE provider

| Item | Status | Notes |
|---|---|---|
| `AIE_OPENAI_API_KEY` | **PRESENT** | Project-scoped `sk-proj-` key, present in `D:\FHIP\.env.local`. **This closes external dependency #2 of `AIE_1_EXTERNAL_DEPENDENCIES_REGISTER.md`, which still records it as absent.** |
| `AIE_AI_PROVIDER` | **MISSING** | `lib/aie/config.ts` `getAieAiProviderKind()` defaults to `'mock'`. **Real provider traffic is OFF by default and stays off until this is set to `openai`.** |
| `AIE_AI_MODEL` | **MISSING from `.env.local`** | Default is the pinned snapshot `gpt-4o-mini-2024-07-18`. **MISCONFIGURATION RISK:** commit `c674832` records that the OpenAI project's allowlist **rejects that snapshot**, and the first real call only succeeded with a local `AIE_AI_MODEL=gpt-4o-mini` override that was **not persisted** to DEV or production configuration. Either the allowlist must be widened or this variable must be set in every environment before real provider traffic is enabled. |
| `AIE_AI_FALLBACK_ENABLED` | **MISSING** → OFF | Kill switch; must be `'true'` to permit AI fallback at all. |
| `AIE_AI_TIMEOUT_MS` | MISSING → default 20,000 ms | |
| `AIE_AI_MAX_TRANSIENT_RETRIES` | MISSING → default 2 (hard-capped at 2) | |
| `AIE_AI_MAX_INPUT_TOKENS` | MISSING → default 4,000 | Reservation ceiling. |
| `AIE_AI_MAX_OUTPUT_TOKENS` | MISSING → default 512 | |
| `AIE_AI_COST_ALLOWANCE_USD` | MISSING → default **$10** | Pilot allowance, deliberately separate from Module 11's budget. |
| Pricing config | **PRESENT in code, dated** | `AIE_OPENAI_PRICING` in `lib/aie/config.ts`, `AIE_PRICING_CONFIRMED_DATE = '2026-09-13'` ($0.15/1M in, $0.60/1M out). **Re-verify before any production cost decision.** |

### F.4.3 AIE masking / encryption

| Item | Status | Notes |
|---|---|---|
| `AIE_MASK_TOKEN_ENCRYPTION_KEY` | **MISSING from `.env.local`** | Referenced by `lib/aie/masking/tokenMapCrypto.ts`. Commit `481e7fd` records that a real DEV config gap around this variable was found and fixed during the masking-before-egress proof — but it is **not** present in the local env file inspected here. Must be confirmed set in DEV and production before real provider traffic. |

### F.4.4 AIE feature flags, cohort gates and kill switches

All read `=== 'true'` and are therefore **OFF unless explicitly set**. None is set in
`D:\FHIP\.env.local`.

| Flag | Status | Purpose |
|---|---|---|
| `AIE_DOCUMENT_INTAKE_ENABLED` | **MISSING → OFF** | Master intake switch. |
| `AIE_AI_FALLBACK_ENABLED` | **MISSING → OFF** | AI-fallback kill switch. |
| `AIE_ALLOW_MISSING_SIGNATURE_SCANNER` | **MISSING → OFF (fail-closed)** | Disclosed DEV-only override. |
| `AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED` | **MISSING → OFF** | Investment Intelligence canonical write. |
| `AIE_FDH_BANK_ADAPTER_ENABLED` | **MISSING → OFF** | |
| `AIE_FDH_BANK_AI_FALLBACK_ENABLED` | **MISSING → OFF** | |
| `AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED` | **MISSING → OFF** | |
| `AIE_INSURANCE_ADAPTER_ENABLED` | **MISSING → OFF** | |
| `AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED` | **MISSING → OFF** | |
| `AIE_REVIEW_UI_ENABLED` | **MISSING → OFF** | |
| `AIE_REVIEW_CANONICAL_ACCEPTANCE_ENABLED` | **MISSING → OFF** | |
| `AIE_REVIEW_EVIDENCE_REVEAL_ENABLED` | **MISSING → OFF** | |
| `AIE_REVIEW_BULK_ACTIONS_ENABLED` | **MISSING → OFF** | |
| `AIE_REVIEW_PC5_PROJECTION_ENABLED` | **MISSING → OFF** | **Zero consumers exist behind this flag.** |
| `AIE_PILOT_COHORT_ENFORCED` | **MISSING → OFF** | Cohort restriction is a second, independent toggle from the intake switch. |
| `AIE_PILOT_COHORT_USER_IDS` | **MISSING** | Fails **closed**: enforced-with-empty-allowlist admits nobody. |
| `AIE_PILOT_COHORT_EMAILS` | **MISSING** | Same. |

**Production upload enablement: effectively OFF at three independent layers** — the code is not
merged to `main`, it is not deployed, and every flag defaults off. There is no path by which a
production user can reach AIE today.

### F.4.5 AWS

| Item | Status | Notes |
|---|---|---|
| AWS CLI | **PRESENT** | `aws-cli/2.36.15`, `C:\Program Files\Amazon\AWSCLIV2\aws` |
| AWS credential mechanism | **PRESENT** | `~/.aws/credentials`, `[default]` profile with `aws_access_key_id` + `aws_secret_access_key` (static IAM user keys, not a role). Values not read. |
| `AWS_REGION` | **PRESENT** | `~/.aws/config` `[default] region = ap-southeast-2` (Sydney), matching the runbook. |
| IAM identity | Previously probed as `arn:aws:iam::879807128139:user/Amar` | **Not re-probed this phase** — M0 is explicitly barred from calling AWS. |
| IAM permissions | **BLOCKED (as of 2026-09-13)** | `AIE_1_PROVISIONING_IAM_POLICY_REQUEST.md` records live-probe evidence that this identity had **zero** relevant permissions: `s3:ListAllMyBuckets`, `amplify:ListApps`, `cloudfront:ListDistributions`, `iam:GetUser` all `AccessDenied`. **Must be re-confirmed in M2**, since the Product Owner may have granted the policy since. |
| Quarantine S3 bucket | **MISSING** | Does not exist. **Name conflict in the source documents:** the runbook `AIE_1_CLOSURE_AWS_INFRASTRUCTURE.md` uses `aie-document-quarantine-dev`, while `AIE_1_PROVISIONING_IAM_POLICY_REQUEST.md` scopes its IAM policy to `arn:aws:s3:::fhip-aie-quarantine-dev`. **These two names do not match** — provisioning against one while the policy authorises the other will fail. Recorded as **OA-2b**. |
| GuardDuty Malware Protection for S3 | **MISSING — not subscribed at the account level** | `guardduty:ListDetectors` returned `SubscriptionRequiredException`, meaning GuardDuty has never been enabled on this AWS account. This is an **ongoing-cost decision**, not a permissions gap. |
| EventBridge rule | **MISSING** | Planned: `aie-guardduty-scan-result-rule`, matching detail-type "Object Scan Result" scoped to the protected bucket. |
| SQS queue / DLQ | **MISSING** | Planned: `aie-guardduty-scan-result-dev`, `aie-guardduty-scan-result-dlq-dev` (redrive `maxReceiveCount: 5`). |
| Scan-result consumer | **MISSING** | `lib/aie/malware/scanResultHandler.ts` implements the decision logic; no SQS poller or consumer route exists. |
| `AIE_QUARANTINE_BUCKET` (or equivalent) | **MISSING** | No AWS-related environment variable is referenced by any AIE source file — the S3/GuardDuty path is not yet wired to configuration at all. |

### F.4.6 Cron / purge

| Item | Status | Notes |
|---|---|---|
| `CRON_SECRET` | **PRESENT** | Used by `app/api/aie/cron/purge-sweep/route.ts`. |
| Purge cron schedule | **NOT VERIFIED** | `pg_cron` job registration for the AIE purge sweep was not inspected (would require SQL access — see **OA-3**). Migration `0135_lr1_document_purge_sweep_scheduler.sql` is on `main` and is the LR-1 scheduler, a different sweep. |

### F.4.7 Other

`RESEND_API_KEY` **PRESENT**; `CONTACT_FROM_EMAIL` **PRESENT**;
`STRIPE_WEBHOOK_SECRET` / `RAZORPAY_WEBHOOK_SECRET` **MISSING** (referenced by payment routes,
out of this mission's scope).

---

## F.5 Consolidated operator action request (Part F.5)

One consolidated list. Exact names given; **nothing was guessed and no credential was requested
in chat plaintext.** Every non-blocked M0 task was completed before this list was produced.

| ID | Action | Exact names | Why it is blocked here |
|---|---|---|---|
| **OA-1** | Supply, or confirm the non-existence of, the **original approved scope documents** for PC4, PC5, PC6, PC7 (and PC8/PC9/PC10 if they exist). | PC4 spec with ≥48 numbered sections; any `PC5`/`PC6`/`PC7` approved-scope document. | Exhaustively searched: all 346 refs, full pickaxe history, `docs/`, `User tests/`, root `*.md`, untracked files, and `C:\Users\user\Downloads\`. Not found. Later phases cannot honestly claim "original scope preserved" without them. |
| **OA-2a** | Grant the drafted least-privilege IAM policy to the provisioning identity **and** accept the recurring GuardDuty cost. | Policy JSON in `docs/aie-programme/AIE_1_PROVISIONING_IAM_POLICY_REQUEST.md`; identity `arn:aws:iam::879807128139:user/Amar` (or a new purpose-scoped user); account `879807128139`; region `ap-southeast-2`. | The identity has zero relevant permissions and GuardDuty is not subscribed on the account. Subscribing is a billable, hard-to-reverse decision. |
| **OA-2b** | **Decide the quarantine bucket name** — the two AIE documents disagree. | `aie-document-quarantine-dev` (runbook) **vs** `fhip-aie-quarantine-dev` (IAM policy resource ARN). Also confirm queue names `aie-guardduty-scan-result-dev` and `aie-guardduty-scan-result-dlq-dev`, and rule `aie-guardduty-scan-result-rule`. | Provisioning against the runbook name while the policy authorises the other ARN will fail with `AccessDenied`. |
| **OA-3** | Provide a way to read the **applied-migration ledger** (names + checksums) on DEV and production. | `supabase_migrations.schema_migrations`; e.g. a direct `postgres://` connection string, or exposing a read-only `SECURITY DEFINER` RPC. | Not exposed via PostgREST on either project; no SQL-execution RPC exists. Part F.3's checksum comparison is impossible without it, and Part U.4's production migration proof will hit the same wall. |
| **OA-4** | Confirm the applied state of the four **function/trigger/policy-only** migrations. | `0146_aie1_adapter_link_trigger_column_fix`, `0147_g8_generic_archive_bypass_fix`, `0148_lr_p0_2_restore_smsf_balance_write_guard_bracket`, `0151_aie1_cost_admission_reserve_single_row_fix`. | Confirming them read-only is impossible via PostgREST; executing the functions would be a write, which M0 is barred from. Resolved automatically once **OA-3** is available. |
| **OA-5** | Confirm the **model pin** decision. | `AIE_AI_MODEL`. Either widen the OpenAI project allowlist to include `gpt-4o-mini-2024-07-18`, or set `AIE_AI_MODEL=gpt-4o-mini` in DEV **and** production. | The pinned default is rejected by the project allowlist; the working override exists only in one local `.env.local`. |
| **OA-6** | Confirm `AIE_MASK_TOKEN_ENCRYPTION_KEY` is set in DEV and production. | `AIE_MASK_TOKEN_ENCRYPTION_KEY` | Not present in the inspected `.env.local`; masking must not run without it. |
| **HK-1** | Remove or repoint the broken `doclife` git remote. | `doclife` → `D:/FHIP/.claude/worktrees/doc-lifecycle` (path gone) | Makes `git fetch --all` exit non-zero. |

---

## F.6 M0 Part F verdict

| ID | Item | Result |
|---|---|---|
| MB-F1 | Git baseline captured (fetch, HEAD, upstream, dirty state, worktrees, unpushed work, AIE branches, PC branches, merge-bases) | **PASS/FOUND** |
| MB-F2 | AIE-1 closure tip identified and ancestry **proved**, not assumed | **PASS/FOUND** — `74b7a5e`, all 10 sibling branches proved ancestors |
| MB-F3 | Repository migration registry (main + AIE tip) | **PASS/FOUND** — 136 / 143, zero duplicates |
| MB-F4 | DEV applied registry | **CONDITIONALLY FOUND** — object-existence proved with negative controls; **names/checksums unreadable (OA-3)** |
| MB-F5 | Production applied registry | **CONDITIONALLY FOUND** — same method, same limitation (OA-3) |
| MB-F6 | Checksum differences | **NOT FOUND — blocked by OA-3** |
| MB-F7 | Duplicates / collisions | **PASS/FOUND** — none live; both historical collisions genuinely resolved (`83eb0cd`, `121cfd4`) |
| MB-F8 | Migrations in DB but absent from `main` | **FOUND — 11 AIE migrations live in DEV *and* production, absent from `main`, code undeployed** |
| MB-F9 | Migrations on branch but not in DB | **NONE identified** (subject to OA-4) |
| MB-F10 | Next-version collision hazard | **FOUND — MG-1: `main`'s guard says "next is 0149"; 0149–0152 are already applied. Next free version is `0153`.** |
| MB-F11 | Configuration inventory (OpenAI, masking, AWS, GuardDuty, flags, cohort, kill switches, cost, cron, production upload) | **PASS/FOUND** — full `PRESENT`/`MISSING`/`MISCONFIGURED` table, no secret values printed |
| MB-F12 | Consolidated operator action request | **PASS/FOUND** — 7 items, exact names, no credential requested in plaintext |
| MB-F13 | No code modified / no migration applied / no OpenAI or AWS call / nothing pushed | **PASS** |

**M0 Part F verdict: COMPLETE**, with two capability limits honestly recorded (OA-3 applied-ledger
read access, OA-4 function-body verification) rather than papered over.
