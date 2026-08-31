# FDH-12 — Retirement Statement Intelligence: Completion Report

**STATUS: DEV CERTIFIED FULL PASS — READY FOR PRODUCT OWNER MERGE
AUTHORISATION.**

Live-DEV certification was executed in full **three times**.

| Round | Date | Checks | Result | What it established |
| --- | --- | --- | --- | --- |
| 1 | 2026-08-30 | 218 | 213 PASS / 5 FAIL | Found **two real defects**, one blocking; both fixed forward in `0113` and `0114`. |
| 2 | 2026-08-30 | 262 | 245 PASS / 17 FAIL | Complete re-run after the migrations were reported applied. Proved **neither was actually in effect** on DEV. No new defect, no regression. |
| **3** | **2026-08-31** | **262** | **262 PASS / 0 FAIL** | The Product Owner re-applied both migrations by full-file paste. **Both confirmed genuinely in effect.** All 17 round-2 failures verified passing individually. |

**Round 3 is the certifying run.** Its closure is grounded on four independent
things, not on the aggregate count alone:

1. **Label-by-label** verification of round 2's exact 17-item failure list —
   §119/§130/§132 (10 approval-transition and attribution checks),
   §133 (1 cross-tenant provenance link), §134 (6 provenance forgeries).
   17 / 17 now PASS. The result file records `"fail": 0` with an empty
   `failures` array.
2. **Zero stubs.** Round 2's log carried 16 checks labelled
   `[approval step stubbed via service role — pending migration 0113 on DEV]`.
   Round 3 carries none: every §119/§130/§132 downstream check now sits on top
   of a real owner-authenticated approval.
3. **String-level proof of `0114`.** The refusal messages observed live match
   `0114`'s source verbatim (lines 105 and 133), so the blocking behaviour is
   attributable to that file and not to something else.
4. **Zero-residue cleanup**, verified by a whole-table cardinality sweep and a
   content-marker sweep that do not depend on the run's own list of ids.

Full evidence: `FDH12_LIVE_DEV_CERTIFICATION.md`; raw run log
`scripts/fdh12-live-dev-run.log`.

> **Operational lesson, worth preserving beyond this module:** round 2 existed
> because `0113`/`0114` were pasted into the DEV SQL Editor, reported "no
> error," and were then genuinely absent from the live database — most likely
> a partial/highlighted-selection paste, which Supabase Studio runs and
> reports as successful regardless of what actually executed. **SQL Editor
> "success" is not sufficient evidence of migration activation; behavioural
> verification is required for critical security/authority migrations.**
> Round 3 only became the certifying run once the fixes were proven live by
> outcome (a real owner-authenticated approval; a real forgery attempt
> refused) — not by re-checking that the SQL Editor reported no error a
> second time.

> **FDH12-LD-1 (BLOCKING) — RESOLVED in `0113`, confirmed live.**
> `fdh12_approve_retirement_statement()` could never succeed for any caller:
> `security definer` does not change `auth.role()`, so migration 0112 PART F's
> own guard refused the RPC's write, and the service role is refused by the
> function's own `auth.uid()` check. No user could approve a retirement
> statement, so no proposal and no canonical apply were reachable at all.
> Round 3: an owner-authenticated call returns `200`, the row genuinely
> transitions `pending -> approved`, and `approved_by` is the owning end user.
>
> **FDH12-LD-2 (HIGH) — RESOLVED in `0114`, confirmed live.** 0112 added
> `retirement_accounts.last_import_application_id` / `last_imported_at` and
> widened `source_type`, but shipped neither of the two guards `income_sources`
> (0091) and `liabilities` (0096) pair with those exact columns. Live, an
> ordinary user could forge or erase their own import provenance, and point
> their own row at ANOTHER TENANT's import application. Round 3: all six such
> attempts return `400 P0001` and the columns are re-read unchanged, while a
> positive control confirms the rest of the same row stays user-editable.

## 1. Repository

* Worktree `D:/fhip-fdh12`, branch
  `feature/fdh12-retirement-statement-intelligence`, cut from `origin/main`
  @ `9e3cdec` (the FDH-11 merge).
* Migrations, all three **applied to DEV and confirmed in effect**, and **none
  applied to production**:
  * `0112_fdh12_retirement_statement_intelligence.sql`
  * `0113_fdh12_approve_rpc_authoritative_write_fix.sql`
  * `0114_fdh12_retirement_provenance_guards.sql`
* Not merged. Pushed to `origin` on the feature branch only. Production
  untouched — no production migration, no production code, no production
  credential used at any point.

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

> **Permanent architecture record, for any future maintainer of this table:**
> **Canonical Retirement remains a summary-balance register. FDH-12 statement
> activities are evidence/reconciliation records only and do not constitute a
> second retirement event ledger.** `fdh_retirement_statement_activities`
> exists to be matched, deduplicated, and reconciled against evidence — never
> to be read as, or migrated into, an authoritative transaction history for
> `retirement_accounts`. Proven live in round 3 (§ARCHITECTURE of
> `FDH12_LIVE_DEV_CERTIFICATION.md`): statement activities accumulate as
> evidence while canonical `retirement_accounts` sits byte-unchanged until an
> explicit, approved Apply; zero second canonical ledger was created.

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
| DB certification harness | `scripts/fdh12_certification.mjs`, **62 checks** (53 + 9 added for FDH12-LD-1/LD-2) |
| Live-DEV certification harness | `scripts/fdh12_live_dev_certification.mjs`, **262 checks** (218 + 26 negative controls for FDH12-LD-1/LD-2 + 18 for the whole-table cleanup sweep) |
| Documentation | 20 files in `docs/financial-data-hub/` |
| Hotfix migrations from live-DEV certification | 2 (`0113`, `0114`) — **applied to DEV, confirmed in effect** |

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
| PGlite DB certification | **62 PASS, 0 FAIL** (incl. anti-vacuity self-check and 9 new regressions for FDH12-LD-1/LD-2, each proven to FAIL with its fix migration removed) |
| **Live DEV — round 3, certifying** (`scripts/fdh12_live_dev_certification.mjs`) | **262 PASS, 0 FAIL** — all twenty live sections closed, no stubbed check |
| Live DEV — round 2 (same harness, 262 checks) | 245 PASS, 17 FAIL — `0113`/`0114` not in effect on DEV at the time |
| Live DEV — round 1 (same harness, 218 checks) | 213 PASS, 5 FAIL — the round that found the two defects |
| Shared-CSV blast radius (R7 + FDH-5 + FDH-11 + FDH-12, 30 files) | **702 PASS, 0 FAIL** — the `findHeaderRowIndex` fix in `bank-csv/csv.ts` is shared with those modules and none regressed |
| Full repository suite | **4,075+ passed** — the only failures are Resources live-DEV files failing in `beforeAll` with Supabase Auth `Request rate limit reached`, an environmental quota exhausted by repeated full-suite runs against shared hosted DEV. They pass on retry once the quota recovers, the failing set varies run to run, and this branch touches **no** Resources file (`git diff 9e3cdec..HEAD` — zero Resources paths). Same flakiness class the round-1 report recorded. |

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
   `scripts/fdh12_certification.mjs` section 6. Migration 0112 now extends both,
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

* **Live-DEV certification is CLOSED** as of round 3 — 262 / 262, all twenty
  sections, no stubbed check. This certifies **DEV only**; it is not a
  production certification and does not authorise one. Every residual below
  stands unchanged and is **not** cancelled by that pass.
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

STOP. Await **explicit Product Owner authorisation to merge**.

FDH-12 is DEV-certified and the branch is pushed to `origin`. Everything past
this point — merging to `main`, applying `0112`/`0113`/`0114` to production,
deploying, and starting FDH-13 — is the Product Owner's call and has not been
done.

Nothing has been merged. Nothing has been applied to production. FDH-13 has not
been started.
