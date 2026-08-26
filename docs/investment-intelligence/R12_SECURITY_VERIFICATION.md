# R12 — Security Verification (results)

## Live DEV (real Supabase, real users, real JWTs) — `scripts/r12_live_dev_verification.mjs`

| Check | Result |
|---|---|
| LIVE-R12-01 existing MF regression | PASS |
| LIVE-R12-02 same-user holding forgery | **RED-CONFIRMED** (real, live, pre-existing — fix is migration 0092, pending DEV DDL application, see `R12_LIVE_DEV_VERIFICATION.md`) |
| LIVE-R12-02-restore | PASS (ground truth restored via service-role) |
| LIVE-R12-03a cross-user read | PASS (blocked) |
| LIVE-R12-03b cross-user write | PASS (blocked) |
| LIVE-R12-04 same ISIN / two exchanges → one instrument, duplicate ISIN rejected | PASS |

6/6 checks executed, 0 genuine failures, cleanup independently verified (0 residual synthetic rows).

## Post-migration PGlite (real Postgres, real RLS, migration 0092 applied) — `scripts/r12_post_migration_pglite_verification.mjs`

| Check | Result |
|---|---|
| `price_source` column functional | PASS |
| `'sale'` transaction_type accepted | PASS |
| `'direct_listed_security_rule'` basis accepted | PASS |
| NC6 same-user holding forgery — GREEN post-0092 | PASS |
| NC6 RED→GREEN (reintroduce old policy, prove it forges, restore) | PASS |
| NC7 cross-user read/write | PASS |
| NC1 same ISIN / two exchanges → one instrument | PASS |
| NC1 RED→GREEN (duplicate ISIN blocked) | PASS |
| NC2 holding double count (publication unique index) | PASS |

11/11 checks, 0 failures.

## Same-user authoritative forgery (spec section 80) — VERDICT: FIXED, LIVE-PROVEN RED, PGlite-PROVEN GREEN

## Tax forgery (spec section 81)

Not separately live-tested this round — `ii_scheme_tax_classification` already carried a correct
world-read/service-role-write-only policy since migration 0059 (R6-P1), unmodified by R12. No new gap
was found or introduced for this table.

## Professional access / raw-document privacy (spec sections 82-83)

Not independently re-tested this round (R12 touches neither surface) — inherited unchanged from R11's
own terminal closure.

## Verdict

Cross-user: **PASS** (live + PGlite). Same-user authoritative holding forgery: **FIXED** (real
pre-existing gap found and closed; RED reproduced live, GREEN reproduced post-migration; genuine DEV
DDL application remains outstanding — see `R12_LIVE_DEV_VERIFICATION.md`). Tax forgery / professional
access / raw-document privacy: unchanged, not separately re-verified this round (no R12 code touches
them).
