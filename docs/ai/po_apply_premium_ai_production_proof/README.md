# Premium AI: production proof pack (19/10/2026)

Authority: your decision that every eligible Premium user gets the AI features (the two-e-mail pilot is retired). This pack is **how you prove, on production,
that it is true**, and what to do if it is not. I have **no production access** and changed no application code. Production configuration is **UNKNOWN**:
nothing here assumes a switch is on or off, and nothing is PRODUCTION-VERIFIED until you fill a row of `07_EVIDENCE_TEMPLATE.md` with real values.

The full report (feature-by-feature table, verdicts, blockers) is `docs/ai/PREMIUM_AI_PRODUCTION_PROOF_REPORT_2026-10-19.md`.

## What is in this folder

| File or folder | Purpose |
|---|---|
| `01_PRODUCTION_CONFIGURATION.md` | what is known and not, how a variable reaches the server, what to check, how a refusal names a missing setting, retired pilot settings, findings |
| `02_DOCUMENT_CLASS_ROUTE_MATRIX.md` | the six document classes, their screens, formats (PDF scan versus CSV), active versus deferred routes, **implementation gaps** |
| `03_JOURNEY_1_BANK_PDF_CONTINUOUS.md` | the continuous bank-PDF journey, step by step, with the evidence for each step |
| `04_JOURNEYS_OTHER_CLASSES.md` | payslip, liability, retirement, Australian investment, Investment Intelligence |
| `05_REFUSAL_AND_SPEND_PROTOCOL.md` | Free, former-pilot, lapsed, forged and cross-tenant refusals; the spending controls and their real reset periods; cleanup |
| `06_ROLLBACK_PER_FEATURE.md` | each feature's own controls; what every rollback preserves |
| `07_EVIDENCE_TEMPLATE.md` | the sanitized sheet to fill |
| `08_TEST_AND_DEV_EVIDENCE.md` | what was verified before you start, with honest labels |
| `synthetic/` | eight synthetic documents, `MANIFEST.sha256`, `EXPECTED_VALUES.md` (hand-computed) |
| `sql/` | read-only `A01` to `A04` (state), `E01` to `E10` (evidence); `cleanup/C00` to `C05`; `ops/O01` to `O03` (WRITE, clearly named) |
| `tools/Check-AmplifyAiConfig.ps1` | read-only Amplify variable check; prints no secret |
| `evidence/` | sanitized results of the DEV rehearsal |
| `module11/` | Module 11 (Coach, Next Best Action, Insight Packs, Standard questions, Explain): protocol, SQL, rollback, gates, findings |

## Ground rules

* Production has **no managed backups**. Any step that changes data starts with the backup file named in it.
* SQL: paste one file at a time. Read-only files are named `_READONLY`; files that change something say `WRITE`. Check the address bar first:
  DEV is `vqycarelcoijzwlpkpcz`, production is `twwpnltizhtjxhamyoxt`. DEV first, always.
* You create the proof accounts yourself and choose their passwords; nobody else handles them.
* Dates you read or write are day-first (dd/mm/yyyy).

## Ordered steps (you)

1. **Know the build.** Amplify console, app, `main`: note the commit marked Deployed. In a terminal (two separate lines, nothing chained):
   `git fetch origin`, then `git merge-base --is-ancestor 1501882 <that commit>`. Exit code 0 means the per-user cap code is in the live build. (A public check on 19/10/2026 showed
   the live build is at least `e9e6a87`; whether it includes `1501882` is **UNKNOWN**.) This branch changes no application code, so it does not need to be deployed to run the proof.
2. **Read the database state** (`sql/A01` to `A04`; DEV first, then production). Every `A01` row must be true. **Migration 0284 missing while the cap code is live means every AI reading is refused.**
   If any row is false, stop and tell the engineer which. If 0160 is false, the Investment Intelligence journey (4.5) cannot run.
3. **Check Amplify** with `tools/Check-AmplifyAiConfig.ps1` (or the console, using the names in section 3.1 of `01_...`). Fix every `MISSING` and every `CHECK` row. After any change a **build** is needed. Staging
   advice: if you want the feature closed while you fix settings, set `AIE_AI_FALLBACK_ENABLED=false` and `II_AI_FALLBACK_ENABLED=false`, build, and open the classes one at a time (bank first).
4. **Create the accounts** (P1, P2 Premium outside the former pilot; F1 Free; X1 former-pilot e-mail without Premium; A1 optional Admin without Premium). Premium through Admin, Premium grant, 1 to 3 days. Copy each user id.
5. **Baseline.** `sql/A02`, `sql/E05`. Write the numbers into `07_EVIDENCE_TEMPLATE.md` 7.1. Check each file's SHA-256 against `synthetic/MANIFEST.sha256`.
6. **Journey 1** (`03_...`): P1 with DOC-B1 (variant B: accept after the original is deleted), P2 with DOC-B2, optional DOC-B3. Stop at the first unexpected result and use the reason table in `01_...` section 5.
7. **Refusals** (`05_...` section 3): R1 to R7 and R9 now; R8 optional. Do **not** lower the cap or the ceiling on production.
8. **Other classes** (`04_...`): payslip, liability, retirement, Australian investment (CSV), Investment Intelligence.
9. **Module 11** (`module11/README.md`): journeys a to i, after its remaining gates. It is a separate decision: its blockers do not hold back document AI and the reverse.
10. **Close out.** `sql/E09`, `sql/A02` (open reservations over an hour must be 0), then cleanup `sql/cleanup/C00` to `C05` (backup first). Let the Premium grants end.
11. **Decide with the report.** Use the table at the end of the report: a feature is "live for eligible Premium users" only when its production execution cell has a real row. Write `PRODUCTION-VERIFIED` only for rows you filled.

## If something goes wrong

Stop the spending first: `sql/ops/O02a` (no deploy). Then read `06_ROLLBACK_PER_FEATURE.md`. The cap is never dropped as a rollback.

## What I could not do, and why

Anything on production (no credentials by design); a browser session (no browser file-chooser tool in this session, so the screens were not driven: the DEV rehearsal drove the same routes the screens call);
the Investment Intelligence AI journey on DEV (migration 0160 is absent on DEV); a full repository test run (28 minutes; not done).
