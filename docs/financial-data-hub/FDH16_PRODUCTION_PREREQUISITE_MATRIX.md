# FDH-16 — Production Prerequisite Matrix

Per spec §233: "A fix on `main` is not necessarily in production." Three columns are kept genuinely separate;
"DEV ACTIVE" is only claimed where this round or a directly-cited prior round exercised the actual RPC/trigger
behaviour live (not merely "pasted without error").

| Migration(s) | Code on `main` | DEV active | Production active |
|---|---|---|---|
| `0091` FDH-9 payslip income intelligence | YES (`6fdcf7e`) | **YES — fresh, this round**: `fdh9_apply_income_proposal` exercised live via real JWT (`I-1`) | NOT TESTED this round |
| `0096` FDH-10 credit cards/loans intelligence | YES | **YES — fresh, this round**: `fdh10_approve_liability_statement`/`fdh10_apply_liability_proposal` exercised live (`I-2`/`I-3`) | NOT TESTED this round |
| `0104`/`0105`/`0108`/`0111` Mandatory Country Confirmation | YES | **YES — fresh, this round**: every synthetic user this round required full MCC-compliant fields to pass onboarding gates; all succeeded | NOT TESTED this round (memory: production MCC status previously unclear for various pieces) |
| `0106` FDH-11 AU investment statement intelligence | YES | REUSED (FDH-14's multi-account/cross-border script, 16/16, same week) — not re-run fresh this round | NOT TESTED this round |
| `0112`/`0113`/`0114` FDH-12 retirement statement intelligence | YES | **YES — fresh, this round**: `fdh12_approve_retirement_statement`/`fdh12_apply_retirement_proposal` exercised live (`I-4`/`I-5`) | NOT TESTED this round |
| `0115` Module 11.1 AI entitlements | YES | REUSED (Module 11.1's own certification) | NOT TESTED this round |
| `0116`/`0118` Admin A0.2 Wave 2 | YES | REUSED (Admin A0.2 Wave 2's own FULL PASS, DEV-certified 2026-08-30) | NOT TESTED this round |
| `0119`/`0120` FDH-15 member-mismatch guards | YES | **YES — DEV-confirmed** (FDH-15's own same-week re-verification: `INC-6`/`RET-2` now return `MEMBER_MISMATCH` live, not merely "no SQL error"); this round's own scripts implicitly re-exercised the same RPC bodies cleanly | NOT TESTED this round — **explicitly flagged**: this is the most security-relevant pending-production migration pair in the current inventory |

## FDH-16's own contribution to this inventory

No new migration was authored by FDH-16 (the one genuine defect found and fixed this round — FDH16-DEF-001,
Dashboard scale truncation — is an **application-code** fix in `lib/services/dashboardData.ts`, not a schema
change; it requires no migration and no DEV/production database action, only a code deployment).

## Deployment verification (§239)

Per repository memory, Amplify auto-deploys on push to `main`. This round did not push anything to `main` (hard
stop per rule 2/§252) and did not independently verify the current production deployment's actual running
commit — that check is out of scope for a DEV-only certification round and would require production access this
round does not have.

## Verdict

**Production certification: NOT AUTHORIZED, NOT ATTEMPTED.** This matrix exists to give the Product Owner an
accurate pending-production-action list, not to claim any production state. The highest-priority pending item
is migrations `0119`/`0120` (closes two already-DEV-confirmed P1 authority-forgery paths) followed by the FDH-9/
10/11/12 statement-intelligence migrations, none of which have been independently confirmed active in
production by this or any cited prior round.
