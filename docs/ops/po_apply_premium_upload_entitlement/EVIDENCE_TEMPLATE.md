# Evidence -- Premium Upload Entitlement production verification

| Field | Value |
|---|---|
| Merge SHA on origin/main | |
| Amplify build / deployment id | |
| Time live (UTC) | |
| Executed by / date | |
| Synthetic Free user (id prefix only) | |
| Synthetic Premium user (id prefix only) | |

## Result matrix

| Surface | Free: HTTP / code | Premium: HTTP / code | Notes |
|---|---|---|---|
| (paste the 28 rows from the probe JSON, or attach the JSON) | | | |

## Checks

| # | Check | Result (PASS / FAIL / NOT RUN) | Evidence (screenshot / JSON file) |
|---|---|---|---|
| 1 | Free: manual Add / Edit / Delete works (Income, Expenses, Liabilities, Investments, Retirement, Insurance) | | |
| 2 | Free: Import shown as a locked Premium link on every domain; no file picker; upgrade link works | | |
| 3 | Free: probe 28/28 PREMIUM_REQUIRED, `import_access = premium_required` | | |
| 4 | Premium: probe 0/28 PREMIUM_REQUIRED, no unexpected 5xx, `import_access = allowed` | | |
| 5 | (optional) Premium: one real synthetic upload end to end, deleted, residue = baseline | | |
| 6 | Admin without Premium: Resources / Benchmarks / Recommendations screens usable | | |
| 7 | Read-only SQL 03 (stamp check) clean | | |
| 8 | Downgrade check (optional) | | |

## Residue and cleanup

| Item | Before | After |
|---|---|---|
| documents (synthetic Premium user) | | |
| upload sessions | | |
| income source rows | | |
| storage objects | | |

P0 findings: __  P1 findings: __  Real customers affected: none / describe.

Verdict (use only wording the evidence supports): ______________________________
