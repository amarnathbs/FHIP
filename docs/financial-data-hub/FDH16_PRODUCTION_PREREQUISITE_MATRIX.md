# FDH-16 — Production Prerequisite Matrix

Per spec §233: "A fix on `main` is not necessarily in production." Three columns are kept genuinely separate;
"DEV ACTIVE" is only claimed where this round or a directly-cited prior round exercised the actual RPC/trigger
behaviour live (not merely "pasted without error").

## Production-column vocabulary (corrected this closure round)

The prior round's "NOT TESTED" wording was ambiguous — it did not distinguish "confirmed absent from
production" from "this round simply did not check production". Replaced below with exactly three explicit
states, used consistently across every row:

- **`VERIFIED ACTIVE`** — this round (or a specifically-cited prior round) directly confirmed the
  migration/behavior is live in production.
- **`VERIFIED NOT ACTIVE`** — this round (or a specifically-cited prior round) directly confirmed the
  migration/behavior is genuinely absent from production.
- **`UNKNOWN / NOT VERIFIED THIS ROUND`** — no round has actually checked production for this item; absence or
  presence must not be implied either way.

This closure round has no production credentials and performed no production check of any kind (same hard
constraint as every prior FDH-16/FDH-15/FDH-14 round). Every row below is therefore `UNKNOWN / NOT VERIFIED
THIS ROUND` unless a specific prior round is cited with actual, citable production evidence — none was found
for any row in this inventory (a full grep of every `docs/financial-data-hub/*.md` file for "0119"/"0120"
alongside "production" turned up only this same matrix's own prior "NOT TESTED" line — no prior round has ever
produced direct production evidence for that pair, so it is marked `UNKNOWN`, not `VERIFIED NOT ACTIVE` — a
guess would violate the very ambiguity this correction exists to remove).

| Migration(s) | Code on `main` | DEV active | Production active |
|---|---|---|---|
| `0091` FDH-9 payslip income intelligence | YES (`6fdcf7e`) | **YES — fresh, this round**: `fdh9_apply_income_proposal` exercised live via real JWT (`I-1`, and again this closure round's own items 3/4/5 scripts) | `UNKNOWN / NOT VERIFIED THIS ROUND` |
| `0096` FDH-10 credit cards/loans intelligence | YES | **YES — fresh, this round**: `fdh10_approve_liability_statement`/`fdh10_apply_liability_proposal` exercised live (`I-2`/`I-3`, and again this closure round) | `UNKNOWN / NOT VERIFIED THIS ROUND` |
| `0104`/`0105`/`0108`/`0111` Mandatory Country Confirmation | YES | **YES — fresh, this round**: every synthetic user this round (and this closure round) required full MCC-compliant fields to pass onboarding gates; all succeeded | `UNKNOWN / NOT VERIFIED THIS ROUND` (repository memory records MCC production activity for *other* pieces of the MCC rollout, but not a round-specific confirmation for this exact migration triple in production) |
| `0106` FDH-11 AU investment statement intelligence | YES | REUSED (FDH-14's multi-account/cross-border script, 16/16, same week) — not re-run fresh this or the prior round | `UNKNOWN / NOT VERIFIED THIS ROUND` |
| `0107` Admin A0.2 Wave 1 / D-01 (Recommendations conditions-CSV import atomicity) | YES | **Not an FDH-16 migration — no FDH-16 ownership.** DEV = APPLIED/CERTIFIED under the Admin A0.2 Wave 1 workstream (not re-verified by FDH-16 in any round; listed here only because it falls inside the active migration chain FDH-16's replay/collision-scan mechanically covers) | `UNKNOWN / NOT VERIFIED THIS ROUND` — **ownership: Admin A0.2**, a separate Admin-workstream release action with its own pre-apply inspection and D-01 behavioural proof requirement. FDH-16 does not attempt, incorporate, or imply any production status for this migration; today's unrelated production activity in other workstreams (MCC, etc.) does not authorize or evidence anything about `0107`. |
| `0112`/`0113`/`0114` FDH-12 retirement statement intelligence | YES | **YES — fresh, this round**: `fdh12_approve_retirement_statement`/`fdh12_apply_retirement_proposal` exercised live (`I-4`/`I-5`, and again this closure round) | `UNKNOWN / NOT VERIFIED THIS ROUND` |
| `0115` Module 11.1 AI entitlements | YES | REUSED (Module 11.1's own certification) | `UNKNOWN / NOT VERIFIED THIS ROUND` |
| `0116`/`0118` Admin A0.2 Wave 2 | YES | REUSED (Admin A0.2 Wave 2's own FULL PASS, DEV-certified 2026-08-30) | `UNKNOWN / NOT VERIFIED THIS ROUND` — ownership: Admin A0.2, not FDH-16 |
| `0119`/`0120` FDH-15 member-mismatch guards | YES | **YES — DEV-confirmed** (FDH-15's own same-week re-verification: `INC-6`/`RET-2` now return `MEMBER_MISMATCH` live, not merely "no SQL error"); this round's and this closure round's own scripts implicitly re-exercised the same RPC bodies cleanly | `UNKNOWN / NOT VERIFIED THIS ROUND` — **explicitly flagged**: this is the most security-relevant pending-production migration pair in the current inventory. No round has produced direct production evidence either way; do not read the absence of a "VERIFIED NOT ACTIVE" label as a claim that it IS active, and do not read it as a claim that it is absent — it is simply unchecked. |

## FDH-16's own contribution to this inventory

No new migration was authored by FDH-16 across either round (the two genuine defects found and fixed —
FDH16-DEF-001 in `lib/services/dashboardData.ts`/`lib/services/reportSnapshotResolver.ts`, and this closure
round's `lib/ai/context/financialContextObject.ts` fail-closed-contract regression fix — are **application-code**
fixes, not schema changes; neither requires a migration and neither requires DEV/production database action,
only a code deployment).

## Deployment verification (§239)

Per repository memory, Amplify auto-deploys on push to `main`. Neither the original round nor this closure
round pushed anything to `main` (hard stop per rule 2/§252) and neither independently verified the current
production deployment's actual running commit — that check is out of scope for a DEV-only certification round
and would require production access neither round has.

## Verdict

**Production certification: NOT AUTHORIZED, NOT ATTEMPTED.** This matrix exists to give the Product Owner an
accurate pending-production-action list, not to claim any production state. The highest-priority pending item
remains migrations `0119`/`0120` (closes two already-DEV-confirmed P1 authority-forgery paths), status
`UNKNOWN / NOT VERIFIED THIS ROUND` — not confirmed active, not confirmed absent — followed by the FDH-9/10/11/12
statement-intelligence migrations, none of which have been independently confirmed active in production by this
or any cited prior round. `0107` is listed for completeness only (it falls inside the migration chain FDH-16
mechanically scans) and remains exclusively the Admin Redesign workstream's own production-release decision —
FDH-16 asserts nothing about its production status beyond `UNKNOWN / NOT VERIFIED THIS ROUND`.
