# R7 — Bank CSV Engine: Acceptance Report

## R7-FINAL UPDATE (live DEV verification performed)

Everything below this notice is the ORIGINAL acceptance report, written when live DEV verification was genuinely blocked (no DDL credential). That blocker is now resolved (migration 0064 confirmed live), and live DEV verification has now been PERFORMED for real — see `R7_FINAL_LIVE_DEV_VERIFICATION.md`, `R7_FINAL_SECURITY_VERIFICATION.md`, `R7_INDEPENDENT_LIVE_RECONCILIATION.md`.

**Result**: all 15 live cases PASS, all 10 independent live reconciliations PASS, cross-user security PASS — but **one genuine, live-only-discoverable, unresolved security/reconciliation defect was found**: a user can forge their own document's `reconciliation_status` via direct PostgREST (migration 0064's authoritative-field trigger protects every column it introduces but missed this pre-existing FDH-1 column). A fix is drafted and RED→GREEN proven (`supabase/migrations/0065_r7_final_reconciliation_status_forgery_fix.sql`) but **not applied** to live DEV (no DDL credential this session).

Three OTHER live-only defects were found and (unlike the one above, which needs DDL) fixed at the application-code layer this session, then re-verified clean end-to-end:
1. `reference_raw`/`source_reference` column-name mismatch in `bank-csv/repository.ts` — broke **100%** of live `/process` calls.
2. Within-file duplicate candidates never got a real `fdh_duplicate_candidates` row (`bankCsvProcessingService.ts`'s `pending-row-N` placeholder was never resolved).
3. The generic repository's `update()` unconditionally wrote a nonexistent `updated_at` column on `fdh_duplicate_candidates`/`fdh_transaction_corrections`, silently breaking every legitimate duplicate-resolution while the API still reported success.

Per spec §45-47's own acceptance rules, a genuine unresolved forgery affecting "reconciliation"/"security" excludes both UNCONDITIONAL FULL PASS and CONDITIONAL PASS. **Final verdict: FAIL** (bounded to the single `reconciliation_status` trigger gap — every other dimension of the release, including all money/date/dedup/account-identity/canonical-ownership logic, genuinely proved correct live). See the final response for the complete classification.

---

## Original acceptance report (pre-live-DEV, superseded above where it conflicts)

## Acceptance checklist (spec §90)

### Architecture
| Item | Status | Evidence |
|---|---|---|
| Existing FDH architecture reused | PASS | `R7_BANK_CSV_ARCHITECTURE.md` §1 |
| No duplicate `ii_*` bank ledger | PASS | `r7SchemaContract.test.ts` (0 tables matching forbidden patterns) |
| Bank/investment ownership boundary preserved | PASS | R7-TC156-158, no `ii_*` write anywhere in R7 code |
| Migration range correctly allocated | PASS | `0064`, both local and cross-branch guards clean |

### Intake
| Item | Status | Evidence |
|---|---|---|
| Safe CSV validation | PASS | `r7CsvIntake.test.ts`, safety-limit cases R7-TC131-136 |
| Encoding handled | PASS | R7-TC001-005 (UTF-8/BOM/latin1) |
| Delimiter handled | PASS | R7-TC006-011 (`,;\t\|`) |
| Header detection handled | PASS | R7-TC012-016 |
| Malformed inputs fail safely | PASS | R7-TC131-136, all `CsvIntakeError` typed |
| Raw file immutable | PASS | Reuses FDH-3's immutable-storage design verbatim; no R7 code writes to `raw_document_storage_reference` after upload |

### Detection
| Item | Status | Evidence |
|---|---|---|
| Adapter registry implemented | PASS | 8 adapters, `R7_ADAPTER_REGISTRY.md` |
| Deterministic detection | PASS | R7-TC028 (same bytes → same result twice) |
| Evidence/confidence stored | PASS | `detection_evidence` jsonb, R7-TC029 |
| Ambiguous format not guessed | PASS | R7-TC031-034, the false-AMBIGUOUS bug found+fixed is direct proof the guard is real |
| Generic mapping supported | PASS | `/bank-csv/:id/map`, `fdh_csv_mapping_templates` |

### Normalization
| Item | Status | Evidence |
|---|---|---|
| Canonical amount sign | PASS | R7-TC041-046 (all 3 conventions) |
| Decimal precision | PASS | R7-TC047-051, A$10.01 ≠ A$10.00 (R7-TC048) |
| Dates deterministic | PASS | R7-TC052-057, NC3 |
| Raw description preserved | PASS | `description_raw` never mutated post-parse |
| Normalized description separate | PASS | `description_clean`, R7-TC061-063 |
| Account identity safe | PASS | `R7_ACCOUNT_IDENTITY_SPEC.md`, R7-TC121-130 |
| Multi-currency safe | PASS | R7-TC126, fingerprint includes currency |

### Dedup
| Item | Status | Evidence |
|---|---|---|
| Exact re-import idempotent | PASS | D1 manual case, R7-TC077 |
| Overlap handled | PASS | D2/O1-O3, R7-TC079 |
| Legitimate identical txns preserved | PASS | D3, NC1, R7-TC080 |
| Account scope included | PASS | D5, NC5, R7-TC067/088/093-095 |
| Reversal/refund not false-deduped | PASS | D4, R7-TC083-084 |
| Duplicate provenance recorded | PASS | `fdh_duplicate_candidates`, match_method/confidence stored |

### Reconciliation
| Item | Status | Evidence |
|---|---|---|
| Opening/closing balance where available | PASS | R1/R2, R7-TC096-097 |
| Row-level balance checks where possible | PASS | R7-TC102-106 |
| Date coverage | PASS | R7-TC107-111 |
| Partial files not silently certified | PASS | R7-TC142-143 (decideCertification) |
| Clear certification states | PASS | 4-state table, `R7_CANONICAL_TRANSACTION_CONTRACT.md` §4 |

### Security
| Item | Status | Evidence |
|---|---|---|
| RLS on all household tables | PASS (real-Postgres) | `r7_security_certification.mjs`, 45/45 |
| Cross-user reads blocked | PASS (real-Postgres) | 8/8 tables |
| Cross-user writes blocked | PASS (real-Postgres) | 2/2 |
| Same-user authoritative forgery blocked | PASS (real-Postgres) | 9 cases, valid own FKs |
| Valid-FK security tests | PASS | every forgery case used the tenant's own real ids |
| Raw storage private | CARRIED FORWARD, not re-proven | FDH-3's existing bucket/policy, unmodified by R7 |
| Admin has no standing raw-content access | PASS | no admin route added; `pg_roles` check |
| Trusted service processing still works | PASS (real-Postgres) | service-write regression, 3/3 |
| **Live DEV** (real Supabase project) | **PERFORMED — 1 genuine unresolved gap** | `R7_FINAL_SECURITY_VERIFICATION.md` — `reconciliation_status` forgery succeeds; fix drafted (migration 0065), not applied |

### Certification
| Item | Status | Evidence |
|---|---|---|
| 160+ independent cases | PASS | 198 vitest + 174 oracle comparisons |
| Oracle independent from production | PASS | Python stdlib, no shared imports |
| All comparisons pass | PASS | 0 discrepancies |
| 20 manual reconciliations | PASS | `R7_MANUAL_RECONCILIATION.md` |
| 5 negative controls RED→GREEN | PASS | NC1/NC2/NC3/NC5 in vitest + a 5th (RLS/trigger-disable) in the real-Postgres security script |
| 999/1000/1001/2500/5001/10000 tests | PASS | `r7LargeFile.test.ts`, 8/8 |
| **Live DEV 15 cases** | **PASS — 15/15** | `R7_FINAL_LIVE_DEV_VERIFICATION.md` |
| **10 independent live reconciliations** | **PASS — 10/10** | `R7_INDEPENDENT_LIVE_RECONCILIATION.md` |

### Regression
| Item | Status | Evidence |
|---|---|---|
| R6 remains frozen/green | PASS | 0 R6 files touched; full suite includes R6's own tests, all still passing |
| Relevant FDH predecessor regression green | PASS | `fdh1Isolation.test.ts`, `fdh1SchemaContract.test.ts`, `fdh3*.test.ts` all pass |
| TypeScript clean | PASS | `npx tsc --noEmit` clean |
| All tests pass | PASS | 1938/1938 non-skipped, 5 pre-existing skips unrelated to R7 |
| Lint no worse than baseline | PASS | identical 9 errors/8 warnings, both pre-existing |
| Production build clean | PASS | `npm run build` exit 0 |

## Critical fail conditions (spec §91) — checked against, none present

Amount sign never reversed (R7-TC041-046 + NC2) · dates never silently guessed (NC3, R7-TC052-057) · legitimate transactions never falsely deleted-as-duplicate (D3, NC1) · duplicates never double-counted (D1, R7-TC077) · overlap never double-counted (D2, O1-O3) · accounts never incorrectly merged (`R7_ACCOUNT_IDENTITY_SPEC.md`, ambiguous fail-safe) · partial imports never certified (R7-TC142-143) · closing balance never wrongly reconciled (R2, R7-TC097) · no 1000-row truncation (R7-TC-LARGE, 8/8) · raw file never exposed cross-user (carried-forward FDH-3 guarantee, unmodified) · no authoritative forgery possible (9/9 same-user forgery cases blocked) · no `ii_*` duplication (`r7SchemaContract.test.ts`) · no investment holdings inferred from bank payments (R7-TC156-158) · independent oracle agrees on every comparison (174/174) · prior R6 integrity unchanged (0 R6 files touched).

**One item cannot be checked**: "live DEV differs materially from certification" — because live DEV verification was not performed at all (disclosed, not glossed over). This is the deciding factor in the classification below.

## Classification

Every FAIL-condition item that COULD be checked was checked and found clean, with real (not staged) bugs caught and fixed during the process. The one genuinely unmet spec requirement — live DEV verification (§79-84) — is disclosed with the exact technical reason (no DDL-execution credential reaches the live project from this session) rather than fabricated or silently skipped.

Per spec §92-93: UNCONDITIONAL FULL PASS explicitly requires live DEV verification; CONDITIONAL PASS is "NOT allowed for... security" as an unqualified statement, but the security work that COULD be done (real-Postgres, real forgery, real negative controls) is complete and clean — what's missing is not a security DEFECT, it's an unperformed verification STEP against one specific environment this session cannot reach. This is recorded as the deciding, disclosed gap rather than resolved by weakening the claim.

See the final response's Section 46 for the exact classification and Section 47 for next-release readiness.
