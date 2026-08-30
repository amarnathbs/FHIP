# FDH-12 — Retirement Statement Intelligence: Completion Report

**STATUS: CONDITIONAL PASS** — every gate that can be closed without applying
a migration is green; live-DEV certification is BLOCKED pending the Product
Owner applying migration `0111` to DEV.

## 1. Repository

* Worktree `D:/fhip-fdh12`, branch
  `feature/fdh12-retirement-statement-intelligence`, cut from `origin/main`
  @ `9e3cdec` (the FDH-11 merge).
* Migration: `0111_fdh12_retirement_statement_intelligence.sql` — **not
  applied** to DEV or production.
* Not merged, not pushed beyond the feature branch, production untouched.

## 2. Architecture Audit

`FDH12_REUSE_AND_GAP_AUDIT.md` was completed before any implementation, and
answers all eighteen spec-section-6 questions.

**Headline finding:** canonical Retirement is a SUMMARY-BALANCE register with
no event ledger — no rollover table, no withdrawal table, no contribution
history, no fee/tax/insurance column. `retirement_accounts.current_balance` is
a directly-stored numeric that `lib/engines/dashboard.ts:582` sums into net
worth, and that is the entire canonical retirement value model.

Consequences: spec 58 resolves to "balance is a direct canonical field, safe
update permitted"; spec 59's event-ledger prohibition does not bind; and spec
60's double-apply hazard is **unreachable**, because statement activities have
no canonical destination.

## 3. Zero Duplicate Retirement Engine

FDH-12 creates no retirement account table, no member table, no balance store,
no projection, no readiness calculation, no target-retirement-age concept, no
SMSF table, no ordinary-investment row, no income row, no expense row and no
bank transaction. Enforced mechanically by `tests/unit/fdh12Isolation.test.ts`.

## 4. Deliverables

| Layer | Count |
| --- | --- |
| Migration | 1 (3 tables, 6 guard triggers, 2 RPCs, bridge extension) |
| Hub evidence modules | 12 files under `lib/financial-data-hub/retirement/` |
| Canonical-read bridge | 1 file under `lib/retirement-import-bridge/` |
| Canonical-write bridge | 2 files under `lib/import-bridge/` |
| API routes | 7 |
| UI | 1 panel + the Retirement page wiring |
| Unit tests | 11 files, **382 tests** |
| DB certification harness | `scripts/fdh12_certification.mjs`, **53 checks** |
| Documentation | 20 files in `docs/financial-data-hub/` |

## 5. Test results

| Suite | Result |
| --- | --- |
| `fdh12FinancialIntegrity` | 40 PASS |
| `fdh12AuSuperStatements` | 66 PASS |
| `fdh12DedupAndRollover` | 39 PASS |
| `fdh12RetirementBridge` | 39 PASS |
| `fdh12SmsfBoundary` | 33 PASS |
| `fdh12BalanceReconciliation` | 31 PASS |
| `fdh12Isolation` | 30 PASS |
| `fdh12PayslipReconciliation` | 29 PASS |
| `fdh12ScaleCertification` | 28 PASS |
| `fdh12AccountMatching` | 24 PASS |
| `fdh12SchemaContract` | 23 PASS |
| **FDH-12 total** | **382 PASS, 0 FAIL** |
| PGlite DB certification | **53 PASS, 0 FAIL** (incl. anti-vacuity self-check) |
| Full repository suite | **4,078 passed, 1 failed, 5 skipped** — the single failure is `resourcesAdminRoleCtaHotfixLiveDev`, a live-DEV Resources test that passes 2/2 in isolation and fails only under full-suite parallel load against shared hosted DEV. Unrelated to FDH-12. |

## 6. Repository gates

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | **PASS**, 0 errors |
| Vitest (full) | 4,078 passed / 1 flaky pre-existing failure |
| Vitest (FDH-12) | 382/382 |
| ESLint (touched files) | **0 errors, 0 warnings** |
| ESLint (full repo) | 65 problems (19 errors, 46 warnings) — **byte-identical to `origin/main`**; FDH-12 adds none |
| `npm run build` | **PASS** — compiled in 97s, 229 static pages, all 7 FDH-12 routes present |
| Migration replay (101 migrations, empty DB) | **PASS** — 200 tables, 200 RLS-enabled, 0 disabled |
| Migration version guard | **PASS** — 101 migrations, one file per version |
| Cross-branch collision guard | **PASS** vs `origin/main` |
| Bundle security | **client bundle 0 findings** across 101 files; 1 disclosed server-only, non-credential, pre-existing value |

## 7. Real defects found and fixed during certification

Each was found by a test or harness, not by inspection.

1. **Shared CSV intake: header row mis-indexed after blank lines.**
   `findHeaderRowIndex` returns an index into the RAW line array;
   `parseCsvSafe` filtered blanks out *before* indexing. For a file beginning
   with blank lines, the SECOND DATA ROW was read as the header and every
   column was silently mis-mapped — a wrong-financial-data bug affecting R7
   bank CSV, FDH-5 and FDH-11 as well as FDH-12. Fixed in
   `lib/financial-data-hub/bank-csv/csv.ts`; all existing CSV suites re-run
   green.
2. **Bridge target guard not extended for `retirement`.**
   `fdh9_assert_proposal_owner()` / `fdh9_assert_application_owner()` fail
   closed on an unknown `target_domain` by design. Every retirement proposal
   carrying a target was rejected outright. Caught by
   `scripts/fdh12_certification.mjs` section 6. Migration 0111 now extends both,
   in the same shape 0096 used for `liability`.
3. **Wrong `fdh_transactions` column names.** The bank-matching layer typed
   `currency_code` and `description_original`; the real columns are
   `currency_original` and `description_clean`/`description_raw`. Every bank
   match would have errored at runtime. Caught by the PGlite harness and
   **independently confirmed against the real hosted DEV schema.**
4. **SMSF detector inflated its own marker count.** Overlapping dictionary
   entries meant one phrase scored as several, so an ordinary fund's disclosure
   sentence ("You may transfer to a self-managed super fund at any time") would
   have been ROUTED AWAY rather than raised for review. Fixed to count distinct
   phrases.
5. **`fdh1Isolation` route filter matched the ABSOLUTE path**, so any checkout
   under a directory containing "fdh" (this worktree; the FDH-4 worktree
   before it) made every `app/` file match — and, worse, satisfied the test's
   own "at least its routes exist" assertion with unrelated files. Fixed to
   match the repo-relative path.
6. **A literal NUL byte** had been written into `dedup.ts` as a fingerprint
   delimiter, making the file binary to every line-oriented tool. Replaced with
   an explicit `'\u001F'` escape.

## 8. Architectural corrections made during certification

* Canonical-account reading was moved OUT of the Hub into
  `lib/retirement-import-bridge/`, because FDH-1's isolation contract forbids
  any file under `lib/financial-data-hub/` from naming a protected Input Data
  register. This follows FDH-9's and FDH-11's own precedents rather than
  weakening the rule.
* The `reconcile-matches` route was renamed `evidence-matches`, because
  `reconcile` is a reserved FDH-4+ path fragment in FDH-1's route guard.
* The summary CSV layout takes three columns rather than two, because the
  shared header heuristic requires three — adapting to a shared safety control
  rather than loosening it, and gaining a stated period-vs-YTD column.

## 9. Residuals — honestly disclosed

* **Live-DEV certification is not done.** Migration 0111 is unapplied, so spec
  sections 119-134, 137, 139 and 167 are PENDING, not passed. Full detail and
  status per scenario: `FDH12_LIVE_DEV_CERTIFICATION.md`.
* **No named Australian super fund adapter is certified.** Four fund-neutral
  layouts are. Every named provider is MANUAL_MAPPING_REQUIRED, and the UI says
  so.
* **PDF and OCR are not supported.** A PDF fails with a message naming the
  alternative; `ocr_required` exists in the vocabulary but nothing sets it.
* **India ingestion is PARTIAL** — EPF passbook CSV only; NPS and PPF layouts
  are not implemented. Six canonical India gaps are registered in
  `FDH12_INDIA_RETIREMENT_GAP_REGISTER.md`, none patched inside FDH-12.
* **Desktop/tablet/mobile was certified by construction and code review**, not
  by screenshots at three breakpoints against a running app.
* **No Playwright e2e spec** for the FDH-12 journey — consistent with FDH-9,
  FDH-10 and FDH-11, none of which shipped one.
* **5,000/10,000-row scale is PGlite/pure-TypeScript evidence**, explicitly
  permitted by spec section 139.
* **No malware scanning** of uploaded documents — inherited FDH-3 residual.
* One server-only, non-credential value (`CONTACT_FROM_EMAIL`) appears in a
  pre-existing server chunk; disclosed rather than suppressed.

## 10. Production

**NOT TOUCHED.** No production migration, no merge, no push beyond the feature
branch, no production credential used at any point.

## 11. Next action

STOP. Await Product Owner authorisation. The immediate ask is application of
`supabase/migrations/0111_fdh12_retirement_statement_intelligence.sql` to
**DEV only**, after which live-DEV certification can complete.
