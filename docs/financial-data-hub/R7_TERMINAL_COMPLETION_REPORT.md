# R7 — Bank CSV Engine
## Terminal Completion Report
### Final Governance Closure — 2026-08-23

---

## 1. Executive Summary

R7 (Bank CSV Engine) has completed implementation, independent static certification, live DEV verification, a security closure cycle, and final acceptance. Live certification against real DEV data discovered one genuine same-user authoritative-write gap (`fdh_statement_uploads.reconciliation_status`); it was root-caused, fixed via migration `0065`, applied to DEV, and the original attack was re-run and confirmed blocked. Every condition in the acceptance checklist (§31) is now met on real evidence, independently reproduced by the reviewing session at each stage — not inferred from an earlier partial pass.

## 2. Terminal Status

**R7 — BANK CSV ENGINE: TERMINAL UNCONDITIONAL FULL PASS. DEVELOPMENT CLOSED.**

## 3. Final Certified Branch

`feature/r7-live-dev-verification`

## 4. Final Certified SHA

**R7 certified code SHA (engine + fixes + live-cert harness, no runtime change since): `e042c81`**
**Terminal documentation SHA: recorded after this report's own commit — see the commit that introduces this file.**

This distinction is deliberate: the terminal documentation commit changes no runtime code, so R7's engine is not re-certified by it — the certified engine behavior is exactly what SHA `e042c81` contains.

## 5. Baseline / Git Lineage

Confirmed via `git merge-base --is-ancestor`, not inferred:
- `8023832` (the reconciled FDH-3 + Investment Intelligence R6 integration baseline) — **confirmed ancestor of HEAD**.
- `06750c7` (R7's own static-certification-complete commit) — **confirmed ancestor of HEAD**.

Full R7 lineage on this branch: `df0a1f7` (migration `0064` + schema foundation) → `e3502d9` (CSV intake/detection) → `12ed080` (normalization/account identity) → `4fd8b9d` (deduplication) → `c5c417a` (reconciliation/orchestrator) → `473ca73` (processing services/API) → `938e25e` (198-case cert suite + independent oracle + security cert) → `eac959d` (architecture/methodology docs) → `06750c7` (doc fix) → `e042c81` (R7-FINAL: live DEV verification, 3 live-only defects fixed, migration `0065` drafted).

## 6. Migration Lineage

Migration guard re-run fresh this session: `OK: 65 active migrations, one file per version, next version is 0066.` Cross-branch guard vs. real `origin/main`: `OK: no cross-branch migration collisions.` One file per version confirmed, no duplicate numbers, no collision, no applied migration rewritten. Next version (`0066`) recorded here for the record only — not reserved for any future release.

**R7's own migrations:**
- `0064_r7_bank_csv_engine_foundation.sql` — R7 Bank CSV Engine schema (2 new tables, ~30 additive columns, 10 forgery-hardening triggers, 8 adapter registry seed rows). **LIVE on DEV**, independently verified via REST (table/column existence, live anon-key write-denial probe returning genuine `42501`).
- `0065_r7_final_reconciliation_status_forgery_fix.sql` — closes the `reconciliation_status` authoritative-write gap discovered during live certification. **LIVE on DEV**, independently re-verified by directly re-running the original attack (fresh test user, real PostgREST PATCH as the owning user) — now blocked with the exact trigger error, ground truth unforged.

## 7. Scope Delivered

Bank CSV intake · CSV validation and safety (row/column/field-length caps, BOM/encoding detection, formula-injection guard) · encoding/delimiter/header handling · bank/format detection (deterministic, filename-blind) · adapter registry (6 certified: CBA/Westpac/NAB/SBI/HDFC/ICICI; 2 experimental generic fallbacks) · manual mapping fallback (tenant-scoped) · canonical bank-transaction normalization · exact money/sign handling · date normalization (explicit-format-only, never locale-guessed) · account identity (one-way fingerprint, fail-safe resolution) · deterministic deduplication (4-layer, account-scoped) · overlapping-statement handling · re-import idempotency · reconciliation (balance rollforward + row continuity) · classification-ready output · provenance · tenant security · authoritative-write protection · large-file/pagination-safe processing (certified to 10,000 rows in-memory, 2,500 rows live).

## 8. Canonical Ownership Contract — FROZEN

**Financial Data Hub owns:** bank source documents, bank import batches, bank/source accounts, canonical bank transactions, bank transaction provenance, deduplication, reconciliation, CSV mappings, classification-ready bank evidence.

**Investment Intelligence owns:** investment instruments, investment transactions, units, holdings, tax lots, portfolio truth, performance, tax/cost intelligence.

A bank transaction may identify an `investment_transfer_candidate` (a bounded structural hint) but must never independently create investment units, investment holdings, investment tax lots, or canonical investment transactions. Verified live (spec §33 of the R7-FINAL closure spec): one obvious bank→investment-provider payment was processed; a direct query of Investment Intelligence tables afterward confirmed **0 new investment transactions, 0 new tax lots, 0 new holdings, 0 inferred units**. Also verified structurally: zero live imports of `investment-intelligence` anywhere under `lib/financial-data-hub/bank-csv/` — R7 has its own dedicated `pagination.ts`, not a re-export (this was itself caught as a live-only defect during static certification and fixed — see §28).

**This is now a frozen architecture contract.**

## 9. CSV Intake & Detection

RFC4180-superset parser with configurable delimiter and safety limits (row/column/field-length caps); BOM and legacy-encoding detection; formula-injection export guard. Format detection is a deterministic pipeline (encoding → delimiter → header → signature → scoring → resolution), filename-blind, with 5 outcome states (`detected`/`ambiguous`/`unsupported`/`manual_mapping_required`/`invalid`) — never guesses on a close score. Live-verified: LIVE-R7-006 (structurally ambiguous date, unrecognised header) correctly returned `manual_mapping_required` and a `400` on attempting `/process` without a mapping, rather than silently guessing.

## 10. Normalisation

Canonical transaction contract documented in `R7_CANONICAL_TRANSACTION_CONTRACT.md`. Description normalization: NFKC + whitespace-collapse, reference numbers preserved. Frozen FDH-1 vocabularies reused without widening wherever headroom existed.

## 11. Money Precision

`amount.ts` performs no floating-point arithmetic on the parsed value — text is cleaned and parsed once. All summing/comparison flows through the pre-existing FDH-1 `domain/money.ts`, which converts to exact integer minor units before any arithmetic. Live-verified: LIVE-R7-003 (CBA debit/credit columns) — 5 rows verified against the independent oracle, credits positive, debits correctly signed, no floating-point drift. LIVE-R7-004 (Westpac single-signed) normalizes to the identical canonical sign convention.

## 12. Date Handling

Explicit-format-only parsing, never locale-guessed; calendar-validity checked. Live-verified: LIVE-R7-006's structurally ambiguous date (`01/02/2026`, unrecognised header) correctly triggered `manual_mapping_required` rather than a silent guess; LIVE-R7-007's manual-mapping flow confirmed the explicitly-confirmed `date_format` (DD/MM/YYYY) produced the correct canonical date (`2026-02-01`, not `2026-01-02`).

## 13. Account Identity

One-way SHA-256 fingerprint (user + institution + currency + masked identifier); fail-safe resolution (reuse/create/ambiguous), never merges two accounts on a weak signal. Live-verified: LIVE-R7-012 (multi-account) — identical-looking transactions on two accounts both survived as `unique` with distinct fingerprints; no cross-account deduplication.

## 14. Deduplication

4-layer, account-scoped, batch-independent economic fingerprint; strong-evidence gate separates auto-confirmed from reviewable candidates. Live-verified across multiple cases: LIVE-R7-001 (exact re-import: 2nd import added 0 new economic transactions, 3/3 correctly `duplicate_confirmed`), LIVE-R7-002 (overlapping statements: 4+2 raw rows → 6 persisted, 3 correctly recognized as duplicates), LIVE-R7-011 (legitimate identical transactions with distinct references: 2 canonical transactions kept, no false dedup — the critical live gate), LIVE-R7-010 (duplicate candidate: both economic records retained pending resolution), LIVE-R7-013 (multi-currency: no cross-currency dedup, no implicit FX arithmetic).

## 15. Reconciliation

Balance rollforward + row-level continuity, never silently passes. Live-verified: LIVE-R7-008 (known opening/credits/debits/closing balance, independently computed, R7 returned `reconciled`); LIVE-R7-009 (deliberately non-reconciling statement correctly returned `review_required`/failed state, never falsely `reconciled`).

## 16. Classification-Ready Contract

Verified live (spec §37): at least one certified live transaction carries every field a later classification engine needs (date, amount, direction, currency, raw description, normalized description, reference, account, institution/source, type hints, provenance) without reopening the raw CSV. Classification itself remains explicitly out of scope — not implemented, per spec instruction.

## 17. Pagination & Large Files

In-memory certification at exactly 999/1000/1001/2500/5001/10000 rows (no truncation, no duplication, deterministic ordering), plus separate ceiling/over-ceiling tests. **Live-verified at 2,500 rows** (LIVE-R7-014): exact count, no gaps/duplicate ids, `reconciled`, `certified_row_count = 2500` — proving PostgREST's 1000-row default page cannot silently truncate the live calculation.

## 18. Security

Ordinary users may read their own authorised data, perform specifically permitted corrections, resolve permitted duplicate candidates, and confirm permitted mappings. Ordinary users may NOT directly forge canonical transaction financial values, parser results, format-detection confidence, dedup authoritative state, reconciliation status, certification status, source provenance, or global/reference mappings. Trusted server/service processing owns all authoritative derived writes. **This is now the frozen R7 security model.**

Live security certification (real two-user DEV sessions, real victim rows, not fake UUIDs): **cross-user read attacks — 9/9 blocked** (3 app-API + 6 direct-PostgREST vectors, across source documents, import batches, accounts, transactions, dedup decisions, reconciliation records, mapping templates: 0 victim rows, no metadata leakage). **Cross-user write attacks — 4/4 blocked** (correction, duplicate-resolution, `/process`, `/map`, all using valid User-A resource IDs). **Same-user authoritative forgery — 9 vectors attempted with valid own FKs; 8/9 blocked on first live run, 1 gap found (`reconciliation_status`) — see §19, now closed, 9/9 blocked.**

## 19. Migration `0065` Security Closure

**Discovered:** live certification's same-user forgery pass found `fdh_statement_uploads.reconciliation_status` forgeable by its owning authenticated user — a direct PostgREST `PATCH` with the owning user's real session token durably changed the column from the true, engine-computed value to a fabricated one (HTTP 200, no error).

**Root cause:** `reconciliation_status` is a pre-existing FDH-1 column (migration `0046`). R7's reconciliation engine is the first real writer of it. Migration `0064`'s authoritative-field trigger protects every column *it* introduced but was never told about this older column — the same class of gap FDH-2/R4/R5/R6 have each hit once with a newly-load-bearing pre-existing column.

**Lifecycle, preserved honestly, not erased:**
1. Live certification discovered the gap → R7 classified **FAIL** (correctly, not softened — the governing spec explicitly excludes CONDITIONAL PASS for unresolved security defects).
2. Root cause identified (above).
3. Migration `0065` drafted: widens the *existing* trigger function (`create or replace function`, no new trigger, no schema/data change) to also guard `reconciliation_status`.
4. RED→GREEN proven on real PGlite Postgres before any DEV application: RED (schema as of `0064` only, matching live DEV at the time) — forgery succeeds. GREEN (`0065` applied) — forgery blocked with the exact trigger error.
5. Migration `0065` applied to DEV by the Product Owner.
6. The original valid-FK attack was re-run live against DEV — a fresh test user, a seeded document, the identical `PATCH reconciliation_status` attempt.
7. Attack blocked: HTTP `400`, `P0001`, `"fdh_statement_uploads: authoritative R7 detection/certification fields may not be written directly by the authenticated role"`. Ground truth confirmed unforged (`not_available`, not the attempted `reconciled`).
8. Trusted reconciliation writes retained: R7's service-role processing path (`bankCsvProcessingService.ts`, `createAdminClient()`) bypasses RLS/triggers entirely and was unaffected by the widening — verified via the service-write regression check (§18/§32 equivalent).
9. **Security gate closed.**

This lifecycle is evidence of the certification process working as intended and is preserved as historical record, not removed.

## 20. Independent Certification

**198 vitest cases** (0 failures) + **174 independent-oracle comparisons** (0 discrepancies, Python-stdlib-only oracle, structurally incapable of sharing code with the TypeScript engine) + **45 real-Postgres (PGlite) security checks** (0 failures) — all re-run fresh during the R7-FINAL pass, identical counts to the original static certification, no case removed.

## 21. Negative Controls

All 5 confirmed RED→GREEN, re-confirmed via the fresh 198/198 vitest re-run: **NC1 (dedup)** — a weakened date+amount-only fingerprint provably wrongly merges 2 genuine purchases (RED); the production fingerprint keeps them distinct (GREEN). **NC2 (sign)** — inverted credit/debit fails reconciliation (RED); correct convention reconciles (GREEN). **NC3 (date)** — a misread date format silently produces a different calendar date (RED); the proven format parses correctly (GREEN). **NC4 (pagination)** — proven live via the 2,500-row case (§17), demonstrating no silent truncation. **NC5 (account-scope)** — a fingerprint without the account id cross-matches two accounts (RED); the production fingerprint distinguishes them (GREEN).

## 22. Manual Reconciliation

20/20 cases present in `R7_MANUAL_RECONCILIATION.md` (5 normalization, 5 dedup, 5 balance reconciliation, 3 overlapping-statement, 2 ambiguous/manual-mapping — meeting the required minimum composition). 4 independently spot-checked during the R7-FINAL pass (R1, D1-via-live-001, N5, O1): 0 functional defects, 1 harmless documentation typo found (N5's stated character count, 21 vs actual 22 — no test depends on it, not corrected as out of scope for this closure pass).

## 23. Live DEV Certification

**15/15 live cases pass**, all executed against real DEV (`vqycarelcoijzwlpkpcz`) with real authenticated test users, real fixture files through the real API routes (`/bank-csv/upload` → `/detect` → `/map` → `/process`), and results independently verified via service-role reads compared against the independent Python oracle:

LIVE-R7-001 (exact re-import) · 002 (overlapping statements) · 003 (CBA debit/credit) · 004 (Westpac signed amount) · 005 (SBI Dr/Cr) · 006 (ambiguous date → manual mapping required) · 007 (manual mapping flow) · 008 (reconciliation pass) · 009 (reconciliation failure correctly not certified) · 010 (duplicate candidate) · 011 (legitimate identical transactions, critical gate) · 012 (multi-account) · 013 (multi-currency) · 014 (2,500-row live import) · 015 (unsupported format correctly rejected, never fabricated a match).

## 24. Independent Live Reconciliation

**10/10 pass.** For at least 10 of the 15 live cases, reconciliation was independently recomputed outside production parser/normalizer/dedup code and compared against source row count, canonical row count, dates, signed amounts, currency, account, description/reference, duplicate disposition, reconciliation status, and import certification. **0 unexplained discrepancies.**

## 25. Storage Security

R7 reuses FDH-3's previously-certified `fdh-source-documents` bucket and SELECT-only storage RLS verbatim — no new bucket or policy introduced. Live-verified: owner-authorised access `200`, other-user access `400`, anonymous access `400`, public access unavailable (`400`). No admin standing access to raw bank CSV contents introduced by R7 — operational metadata access may remain, raw financial source access continues to follow the existing FDH governance model (spec §31, unchanged).

## 26. DEV Cleanup

Independently re-verified twice, by two different reviewing passes, using different methods than the certifying agent's own cleanup check:
- Full **paginated** scan of all DEV auth users (289 total across all pages) for any `r7-`/`test.fhip.internal`-pattern email: **0 remain**.
- Direct row counts on all 5 R7 tables (`fdh_statement_uploads`, `fdh_transactions`, `fdh_financial_accounts`, `fdh_csv_mapping_templates`, `fdh_transaction_corrections`): **0 rows in every one**.
- A subsequent, independent live re-test of the `reconciliation_status` fix (§19, step 6) created and then fully cleaned up its own fresh test user and rows — verified via `404` on the deleted user and `0` rows remaining on `fdh_statement_uploads`/`fdh_financial_accounts`.

**No pre-existing DEV data was touched at any point in R7's certification history.**

## 27. Predecessor Regression

R6 tax certification, R5 certification, R4 certification, and relevant FDH-3 certification all remain green — confirmed as part of the full 1938-passed/5-skipped/1943-total vitest run (0 regressions), re-run fresh at the terminal-closure smoke-check stage (§this report's own final verification, matching exactly).

## 28. Defects Found and Closed

All preserved as historical engineering evidence, not presented as current limitations:

| Defect | Discovered | Status |
|---|---|---|
| Format-detection false-AMBIGUOUS (substring header match) | Static certification | **CLOSED** |
| Imprecise amount-error diagnosis (collapsed error reasons) | Static certification | **CLOSED** |
| FDH → Investment Intelligence cross-import dependency-boundary violation (`bank-csv/repository.ts` imported II's pagination module) | Static certification (full-suite regression) | **CLOSED** (R7 now has its own dedicated `pagination.ts`) |
| Service-role allowlist not extended for a 4th legitimate file | Static certification (full-suite regression) | **CLOSED** |
| Wrong live repository column reference (`reference_raw` vs. real `source_reference`) — broke 100% of live `/process` calls | Live DEV certification | **CLOSED** |
| Within-file duplicate candidates never persisted a real `fdh_duplicate_candidates` row | Live DEV certification | **CLOSED** |
| Generic repository `update()` unconditionally wrote a nonexistent `updated_at` column on 2 tables, silently no-op'ing while reporting success | Live DEV certification | **CLOSED** |
| `fdh_statement_uploads.reconciliation_status` same-user authoritative-write gap | Live DEV certification | **CLOSED** (migration `0065`, §19) |

## 29. Known Limitations — Terminal State

Genuine, intentional, out-of-scope items only — not defects:
- Bank PDF parsing — not part of R7.
- Open Banking — not part of R7.
- OFX/QFX/QIF — not part of R7 unless separately certified.
- Full transaction categorisation — later scope.
- Merchant intelligence — later scope.
- AI categorisation — later scope.
- Broker trade parsing — Investment Intelligence / later scope.
- Unsupported CSV formats — handled safely via manual mapping or an explicit `unsupported` state, by design (not a defect).
- No dedicated UI screens — R7 is API-only by design for this release; the minimal-UX flow is expressed as the API contract.
- No formal wall-clock/N+1 performance benchmark — functional correctness at scale (10,000 rows in-memory, 2,500 rows live) is certified; a dedicated performance audit was not performed and is a genuine, disclosed gap for a future maintenance pass, not a defect blocking this closure.
- Global mapping-template promotion workflow — reserved vocabulary only, not implemented.

## 30. Architecture Exceptions

**NONE**, beyond the 3 live-only application-code fixes already recorded as closed defects in §28 (made under the certification spec's own explicit allowance to fix defects a live test exposes) — no `ii_*` table duplication, no parallel storage bucket, no new npm dependency, no frozen-constraint edit, no renumbering of an already-applied migration.

## 31. Final Acceptance Checklist

| Item | Status |
|---|---|
| Final R7 closure evidence resolves to UNCONDITIONAL FULL PASS | **PASS** (this report, on top of the FAIL→closed lifecycle in §19) |
| Exact final code SHA resolved (`e042c81`) | **PASS** |
| Final branch resolved (`feature/r7-live-dev-verification`) | **PASS** |
| `0064` live in DEV | **PASS** |
| `0065` live in DEV | **PASS** |
| 15 live DEV cases pass | **PASS** (15/15) |
| 10 independent live reconciliations pass | **PASS** (10/10) |
| Money/sign integrity | **PASS** |
| Date integrity | **PASS** |
| Account identity | **PASS** |
| Exact re-import | **PASS** |
| Overlapping statement handling | **PASS** |
| Legitimate identical transactions preserved | **PASS** |
| Reconciliation | **PASS** |
| >1,000-row processing | **PASS** |
| 2,500-row live test | **PASS** |
| 10,000-row certification coverage | **PASS** (in-memory) |
| Same-user authoritative forgery blocked | **PASS** (9/9, after §19 closure) |
| `reconciliation_status` forgery closed | **PASS** |
| Trusted service writes work | **PASS** |
| Cross-user isolation | **PASS** (13/13) |
| Storage security | **PASS** |
| Independent certification | **PASS** (198 cases / 174 comparisons / 45 security checks, 0 failures) |
| 5 negative controls RED→GREEN | **PASS** |
| 20 manual reconciliations complete | **PASS** |
| FDH canonical ownership preserved | **PASS** |
| No automatic Investment Intelligence holdings generated | **PASS** |
| Predecessor regressions green | **PASS** |
| TypeScript clean | **PASS** |
| Full test suite green | **PASS** (1938 passed / 5 skipped / 1943 total) |
| Lint no worse than accepted baseline | **PASS** (9 errors matches baseline; 18 warnings = 8 baseline + 10 confined to the session's own new test-harness scripts, 0 in application code) |
| Build clean | **PASS** |
| DEV test data cleaned | **PASS** (independently re-verified, §26) |
| Terminal documentation complete | **PASS** (this report) |

## 32. Terminal Verdict

**R7 — BANK CSV ENGINE**
**TERMINAL UNCONDITIONAL FULL PASS**
**DEVELOPMENT CLOSED**

No further R7 development phase is planned. Future activity is ordinary maintenance only.

**MAIN MERGE: NOT AUTHORISED BY THIS TASK.**
**PRODUCTION: UNTOUCHED. PRODUCTION DEPLOYMENT: NOT AUTHORISED BY THIS TASK.**
