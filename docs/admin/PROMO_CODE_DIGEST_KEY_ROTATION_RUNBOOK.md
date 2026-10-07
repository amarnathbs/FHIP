# Promo code digest key rotation runbook

Applies to the keyed digest that identifies a promo code (hardening migration 0264 and the later ones; code in `lib/services/promoSecrets.ts`, `lib/services/promoCodeDigest.ts`).

## What the key protects

A promo code is stored only as `HMAC-SHA256(key, "promo-code:v<version>:" + normalised code)`. The key is `PROMO_CODE_DIGEST_SECRET` (an application secret that never reaches the database). The database also keeps a masked hint (first two and last two characters) and the key **version** the digest was made with (`promo_codes.code_digest_version`).

Because the plain code is stored nowhere after the backfill is finalised, an existing digest **cannot be re-keyed**: nobody can recompute it under a new key. A rotation therefore never rewrites old rows. It adds a window in which both keys are accepted for lookup, and lets the old codes run out (or be replaced) under the old key.

## Settings

| Variable | Meaning |
|---|---|
| `PROMO_CODE_DIGEST_SECRET` | the current key. New codes are created with it. Required. |
| `PROMO_CODE_DIGEST_VERSION` | integer 1 or more, default 1. The version stamped on new codes. Never reuse or lower a number. |
| `PROMO_CODE_DIGEST_SECRET_PREVIOUS` | the previous key. Accepted for lookup only. Its version is the current version minus 1. Needs a current version of 2 or more, at least 32 characters, and must differ from the current key. |

Redemption sends the database the digests of the entered code under the current key and, during a rotation window, the previous key (at most three values). The database matches either.

## When to rotate

- Routine: once a year (PO to confirm), or when an operator who knew the key leaves.
- Immediately: if the key may have leaked. A leaked key lets someone test guesses offline against the stored digests. A generated 10 character code (31 letters, about 8e14 combinations) is not realistically guessable that way. A short admin-typed code is. See "After a leak" below.

## Procedure

1. Generate a new secret (`openssl rand -hex 32`). Keep the old one.
2. In the Amplify environment set, at the same time:
   - `PROMO_CODE_DIGEST_SECRET_PREVIOUS` = the old key
   - `PROMO_CODE_DIGEST_SECRET` = the new key
   - `PROMO_CODE_DIGEST_VERSION` = the old version plus 1 (1 becomes 2)
   Deploy. From now on new codes carry version 2, and a code entered by a user is looked up under both keys, so every existing code keeps working.
3. Check the window is working (a PO step, DEV first): redeem one existing code (made under version 1) and create and redeem one new code (version 2).
4. Watch what is still on the old key:
   ```sql
   select code_digest_version, count(*) as active_codes
     from promo_codes
    where status = 'active'
      and (expires_on is null or expires_on >= current_date)
      and (max_redemptions is null or redemption_count < max_redemptions)
    group by code_digest_version order by 1;
   ```
5. When no active code is left on the old version, or when the PO has disabled and replaced the rest, remove `PROMO_CODE_DIGEST_SECRET_PREVIOUS` and deploy. The old key is now dead everywhere.
6. Destroy the old key.

Only one previous key is kept. A second rotation must wait until step 5 of the first one is done (the application refuses a previous key whose version would be 0 or equal to the current key).

## After a leak

1. Rotate at once (steps 1 and 2).
2. Disable every active code made under the old version that is not needed, and re-issue the ones that are with "Generate a replacement code and email it" (a new code under the new key).
3. Short admin-typed codes are the exposed ones. Find them by their masked hint: `select id, code_hint from promo_codes where code_digest_version = <old> and status = 'active' and char_length(code_hint) <= 8;` (a hint of eight characters or fewer means a code of eight characters or fewer).
4. Remove the previous key as soon as the old codes are gone.

## Rollback

Put the old values back (current = old key and old version, remove the previous key). Codes created under the new version while the new key was live become unusable (they read as "cannot be used") until the new key is put back; replace them. This is why step 3 of the procedure is done on DEV first.

## Evidence in the repository

- The dual verify window and the version separation: `tests/unit/promoHardening/promoSecretsDigestAndIp.test.ts` (named controls NC-S2, NC-S3) and `tests/unit/promoHardeningPglite.test.ts` ("key rotation: a code stored under key version 1 is found by the previous-key candidate, and NOT without it").
- NOT yet proven: a rotation against a real DEV deployment with the real environment variables (this runbook, steps 2 and 3, is the DEV proof).
