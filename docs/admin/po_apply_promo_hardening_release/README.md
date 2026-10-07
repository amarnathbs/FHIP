# Promo and Premium hardening: PO hand-over (migrations 0264 to 0268)

Branch `feat/promo-premium-hardening-20261005`, cut from `origin/main` (b105cf4). Nothing in this branch is pushed, merged or applied anywhere. Nothing is switched on.

Migration numbers: the highest number found on every branch and every worktree was **0263** (NAV2, `0263_nav2_risk_free_refresh_attempts.sql`), so these five are **0264 to 0268**. They do not collide with NAV2 (0260 to 0263) or with 0253 (PC7).

The migrations are written to be pasted into the Supabase SQL editor in small parts. The editor on DEV mis-parsed text in comments and strings, so every file here follows the editor safety rule (ASCII only, no statement word followed by a name inside a comment or string, no semicolon or quote inside a comment). `scripts/migration_editor_safety_lint.mjs` checks it and a test enforces it. Each migration file is the exact concatenation of its parts (a test proves it), so you may paste the whole file or the parts one by one.

## 1. Apply order

DEV first. Production only after DEV passed and you have read section 5 (decisions). Always apply the migrations BEFORE deploying the application of this branch. The application then finds its new functions. (If the application is deployed first, creating and redeeming codes shows an explicit "not available" message until the migrations are applied. Nothing is granted or lost.)

| Step | What | Parts (in `parts/`) | Notes |
|---|---|---|---|
| 0 | Set the four secrets and the Vault secret (section 3) | none | Before the application is deployed |
| 1 | `0264_promo_hardening_foundations.sql` | `0264a`, `0264b`, `0264c`, `0264d` | Additive. Part D hides the plain code and digest columns from API roles |
| 2 | `0265_promo_hardening_functions.sql` | `0265a` to `0265f` | Drops and recreates 5 functions, creates the digest backfill functions |
| 3 | `0266_promo_email_abuse_controls.sql` | `0266a` to `0266d` | Drops the 3 argument begin function, adds limits, alerts, circuit breaker, status |
| 4 | `0267_promo_retention_and_cleanup.sql` | `0267a` to `0267d` | Policy, holds, evidence; the job switch ships OFF |
| 5 | `0268_platform_marker_hardening_and_cron_verify.sql` | `0268a`, `0268b` | Run the pre-check in 4.5 first |
| 6 | Deploy the application | none | Then the digest backfill (section 6) |

Do not edit the applied migrations 0231, 0237, 0238, 0242, 0250, 0251, 0252 (a test pins their hashes).

## 2. Verify after each part

Run these in the SQL editor after the part named. Expected results are in the comment on the right of each query. Dates print year first in the database; the text says them day first.

### 2.1 Migration 0264

```sql
-- after part A
select public.access_end_date('2024-02-28', 30) as end_date,          -- 28 March 2024
       public.access_window_days('2024-02-28', '2024-03-28') as days,  -- 30
       public.promo_normalise_email(E'  A@B.COM\n') as normalised,     -- a@b.com
       public.premium_grant_lifetime_ceiling() as ceiling;             -- 10
select count(*) from admin_users where can_override_entitlement_limits;  -- 0 (nobody holds it)
-- after part B
select to_regclass('public.admin_monitoring_events') is not null as monitoring,
       to_regclass('public.premium_entitlement_overrides') is not null as overrides;  -- true, true
-- after part C: the counter was counted out of the audit trail
select (select count(distinct target_user_id) from admin_entitlement_events where action in ('grant', 'extend')) as audited_users,
       (select count(*) from user_entitlements where admin_lifetime_grant_units > 0) as counted_users;  -- the two numbers are equal
-- after part D: API roles can no longer read the plain code or the digest
select has_column_privilege('authenticated', 'public.promo_codes', 'code', 'select') as code,            -- false
       has_column_privilege('authenticated', 'public.promo_codes', 'code_digest', 'select') as digest,   -- false
       has_column_privilege('authenticated', 'public.promo_codes', 'code_hint', 'select') as hint;      -- true
```

### 2.2 Migration 0265

```sql
-- after parts A and B and C: one definition each, the old shapes are gone
select proname, count(*) from pg_proc where pronamespace = 'public'::regnamespace
 and proname in ('admin_create_promo_code', 'admin_list_promo_codes', 'redeem_promo_code_for_user', 'admin_manage_premium_entitlement', 'premium_reminder_claim')
 group by proname order by proname;                                   -- every count is 1
select has_function_privilege('authenticated', 'public.redeem_promo_code_for_user(uuid,text[],text,text,text)', 'execute') as users,   -- false
       has_function_privilege('service_role', 'public.redeem_promo_code_for_user(uuid,text[],text,text,text)', 'execute') as server;  -- true
-- the list no longer returns a code column
select pg_get_function_result('public.admin_list_promo_codes()'::regprocedure) not like '%code text%' as no_code_column;  -- true
-- after part D (backfill functions exist and report the counts)
select public.promo_codes_finalise_hash_only(true);                    -- {"dry_run": true, "rows_total": N, "rows_with_plain_value": N, "rows_unverified": N}
-- after part E
select obj_description('public.admin_manage_premium_entitlement(text,uuid,date,text,boolean)'::regprocedure, 'pg_proc') is not null as has_comment;  -- true
```

### 2.3 Migration 0266

```sql
select public.promo_email_limits();   -- admin 100 a day, platform 300 a day, 3 replacements per code per day, alert at 80 percent, breaker 5 failures / 15 minutes
select count(*) from pg_proc where proname = 'admin_promo_email_begin';                                   -- 1
select has_function_privilege('authenticated', 'public.promo_email_circuit_report(boolean)', 'execute');   -- false (server only)
select kind, count(*) from promo_email_requests group by kind;                                              -- existing rows: create
```

### 2.4 Migration 0267

```sql
select data_set, retention_days, action from promo_retention_policy order by data_set;   -- 6 rows: the proposed periods
select job_key, enabled from premium_reminder_job_control order by job_key;               -- expiry_email false, promo_retention false
select public.promo_retention_run(true);                                                  -- a DRY run: counts only, changes nothing
select count(*) from cron.job where jobname = 'promo-retention-cleanup';                  -- DEV: 0. Production: 1 only if the marker row exists
```

### 2.5 Migration 0268 (run the pre-check BEFORE part A)

```sql
-- pre-check: must return 0 or 1 row, and never a production row on DEV
select environment, updated_at from platform_deployment_environment;
-- after part B
select * from public.premium_cron_verify(null);   -- one row per check; on DEV every row is ok (the vault and cron rows may say not installed)
-- production only: compare the Vault secret with the application CRON_SECRET by digest (never paste the secret):
--   on your machine:  printf '%s' "$CRON_SECRET" | sha256sum        then
select * from public.premium_cron_verify('<that hex digest>');
-- the constraint is added NOT VALID. After reading the pre-check output you may validate it:
alter table public.platform_deployment_environment validate constraint platform_deployment_environment_value_check;
```

## 3. Secrets the PO must generate

Exactly these. Each is a different random value of at least 32 characters (for example 32 random bytes written as 64 hex characters: `openssl rand -hex 32`). No secret is ever written to a file, a chat or a log. **There are no fallbacks between them any more**: a feature whose secret is missing, too short or equal to another one refuses with an explicit message.

| Name | New? | Needed for | Where it goes |
|---|---|---|---|
| `PROMO_CODE_DIGEST_SECRET` | **New, generate now** | creating and redeeming any code | Amplify environment (DEV and production) |
| `PREMIUM_PROMO_EMAIL_BIND_SECRET` | Generate if it is not already a dedicated value. It used to fall back to the IP secret then `CRON_SECRET` | address-bound codes, e-mailed codes, and redemption | Amplify environment. Changing an existing value makes already bound codes unusable (they read as "cannot be used") |
| `PROMO_IP_HASH_SECRET` | Generate if production relied on the `CRON_SECRET` fallback | the per-network redemption limit | Amplify environment |
| `CRON_SECRET` | Keep, unless it is shorter than 32 characters or equals one of the three above (then rotate it) | the scheduled routes | Amplify environment **and** the Vault secret `premium_reminder_cron_secret` (same value) |

Optional settings (none required): `PROMO_TRUSTED_PROXY_HOPS` (default 1; see the report, item 6, before changing it), `PROMO_CODE_DIGEST_VERSION` and `PROMO_CODE_DIGEST_SECRET_PREVIOUS` (only during a key rotation: `docs/admin/PROMO_CODE_DIGEST_KEY_ROTATION_RUNBOOK.md`).

`amplify.yml` already forwards these names (the `PROMO_CODE_DIGEST_` prefix, `PROMO_TRUSTED_PROXY_HOPS`, `PROMO_IP_HASH_SECRET`, `CRON_SECRET`, `PREMIUM_PROMO_EMAIL_`, `PREMIUM_REMINDER_`). `ENVIRONMENT_VARIABLES.md` describes each.

## 4. What stays OFF

- `PREMIUM_PROMO_EMAIL_ENABLED`: unset (off). Only the exact text `true` turns code e-mail on.
- The expiry reminder e-mail job (`premium_reminder_job_control`, key `expiry_email`): disabled.
- The optional seven day reminder (`PREMIUM_REMINDER_SEVEN_DAY_ENABLED`): unset (off). Built and proven not to duplicate the thirty day reminder (`tests/unit/premiumExpiryReminderSevenDayPglite.test.ts`). Enabling it is your decision.
- The retention cleanup (`premium_reminder_job_control`, key `promo_retention`): disabled. The scheduled job is registered only where the production marker row exists and does nothing while the switch is off.
- The override capability `can_override_entitlement_limits`: granted to nobody.

## 5. Decisions needed from the PO

1. **Hint format.** The mission example `ABCD...WXYZ` shows 8 of the 10 characters of a generated code. I kept the existing two plus two (`AB******YZ`), which shows 4 of 10. Confirm, or choose a shorter hint.
2. **Lifetime ceiling = 10** admin grants and extensions per user, never reset by a revoke. Promo redemptions are NOT counted (they are bounded per code and per user per code). Confirm both.
3. **Latest end date of a grant is today plus 364** (a 365 day window counting today). It used to be today plus 365, which was 366 calendar days. This is one day shorter than before.
4. **Limits**: 100 e-mail recipients per admin per day, 300 across all admins per day, 3 replacements per code per day, alert at 80 percent; circuit breaker after 5 consecutive provider failures for 15 minutes.
5. **Retention periods** (proposals): attempts 30 days, e-mail requests 180 days, send ledger 180 days (anonymised), reminder ledger 400 days, codes 365 days after disable or expiry (anonymised), audit events 7 years (anonymised). Alert rows are not purged.
6. **Who gets `can_override_entitlement_limits`**, if anyone.
7. **Trusted hop count.** The default (1, CloudFront) is UNVERIFIED for Amplify. Prove it on DEV (report, item 6) before relying on the per-network limit.
8. **Secret length.** A minimum of 32 characters is enforced. If the current `CRON_SECRET` is shorter, the reminder route refuses until you rotate it.
9. Whether to run the digest backfill and the finalise on DEV first (recommended) and when on production.

## 6. Digest backfill, verification and the reversal plan

Existing codes keep working at every step. `scripts/promo_code_digest_backfill.mjs` is a dry run unless told otherwise and never prints a code, a digest or a secret.

1. After step 6 of section 1 (application deployed with `PROMO_CODE_DIGEST_SECRET`): `node scripts/promo_code_digest_backfill.mjs` (dry run, counts only).
2. `node scripts/promo_code_digest_backfill.mjs --apply` stores each digest and asks the database to verify the copy (the digest is recomputed from the plain value read back and compared inside the database).
3. Check: `select count(*) filter (where code is not null) as plain, count(*) filter (where code_digest_verified_at is not null) as verified from promo_codes;` Every row with a plain value must be verified.
4. Redeem one existing code on DEV to see it still works by digest.
5. Make a restore point or backup. `node scripts/promo_code_digest_backfill.mjs --finalise-dry`, then `--finalise --i-have-a-backup`. This blanks the plain values for good. It is all or nothing: it refuses while any plain row is unverified.
6. Check: `select count(*) from promo_codes where code is not null;` is 0.

Reversal. Before step 5: `update promo_codes set code_digest = null, code_digest_version = null, code_digest_verified_at = null;` returns every code to the legacy plain lookup. After step 5 the plain values exist nowhere by design; the digests keep every code working; the only way back is a restore. A code that must be handed out again is replaced with "Generate a replacement code and email it". The structural migrations are additive; the functions they replace can be restored by re-running their `create or replace` text from 0231, 0237, 0238 and 0242, together with a rollback of the application.

## 7. Files

- `parts/` the hand-run parts (source of truth; `scripts/promo_hardening_build_migrations.mjs` rebuilds the migrations from them)
- `resend_sample_body.txt` the sample message the real-send certification uses (a test keeps it equal to the real message)
- `../ADMIN_PROMO_CODES_AND_REMINDERS_REPORT.md` section 18: one section per item with finding, change, evidence and residual risk
- `../PROMO_CODE_DIGEST_KEY_ROTATION_RUNBOOK.md`, `../PROMO_EMAIL_RESEND_DEV_CERTIFICATION_RUNBOOK.md`, `../PROMO_HARDENING_BROWSER_TEST_PLAN.md`
- `scripts/promo_code_digest_backfill.mjs`, `scripts/promo_hardening_dev_proof.mjs`, `scripts/promo_email_resend_dev_certification.mjs`
