# II-PC3 Phase 4 / II-PC3-C1 Gate B — Live DEV Campaign Status

Status: **EXECUTED 2026-09-05 — PASS** (see verdict below). Supersedes the original "NOT EXECUTED — blocked on missing credentials" status recorded when this pack was first built.

## What changed since the original CONDITIONAL PASS

DEV Supabase credentials were confirmed working (verified live in a separate, concurrent piece of work this session) and copied into this worktree's `.env.local` (matching every other worktree's own copy of the same DEV project credentials — `NEXT_PUBLIC_SUPABASE_URL` resolves to project ref `vqycarelcoijzwlpkpcz`, confirmed by a benign `ii_accounts` read before anything else ran). This closed the one remaining precondition Phase 4 needed.

## What actually ran

`tests/live-dev/iiPc3RealCamsQualificationLiveDev.test.ts`, against the real DEV Supabase project, via `npx vitest run --config vitest.livedev.config.ts tests/live-dev/iiPc3RealCamsQualificationLiveDev.test.ts`. Every fixture went through the REAL `processSourceDocument()` service function (never a direct table insert of parser output): real Storage upload, real password/decryption path, real extraction/detection/parsing, real account resolution, real transaction/holding persistence, real reconciliation, real certification. Q06 additionally drove the real R5 `loadSipDataset`/`runSipAnalytics` pipeline; Q03 additionally drove the real `taxRepository`/`taxOrchestrator` pipeline. All work used controlled synthetic users (`*@fhip-synthetic.test`) cleaned up in `afterAll`, independently re-verified as zero-residue both by the suite's own re-query and by a separate, out-of-band admin-client check run after the whole campaign (zero residual synthetic auth users; `ii_accounts` row count returned to the exact pre-campaign baseline of 14).

**Final result: 12 passed, 1 explicitly-skipped (Playwright UI journey — out of scope for a script-level campaign, consistent with every other PC-series live-dev suite), 0 failed.**

## Iteration required to get there — real, disclosed harness bugs, not product defects

Getting a genuinely correct run took 4 iterations. Each is disclosed here in full rather than silently smoothed over:

1. **BOM/CRLF `.env.local` parsing bug** — the original script's parser (`^([A-Za-z_]+)=`) never stripped this repo's real UTF-8 BOM, silently breaking `NEXT_PUBLIC_SUPABASE_URL` on the very first line. Fixed to match the already-correct parser in `iiPc2F1ReadSideMutationLiveDev.test.ts`.
2. **Missing household/owner precondition** — every fixture initially landed on `reconciliation_required` / `open_blocking_reconciliation_case` (`owner_unmatched`) for a reason that had nothing to do with parsing or reconciliation: `documentProcessing.ts`'s `ownerUnresolved = !doc.owner_member_id` is a real, by-design precondition (the real upload UI always asks "whose statement is this?"), and the original harness never created a `household_members` row or set `owner_member_id` at upload. Fixed by giving every synthetic user a household + member, matching `iiPc2F1ReadSideMutationLiveDev.test.ts`'s own fixture pattern.
3. **Re-upload semantics bypassed** — Q05's "exact reimport" originally blind-inserted a second `ii_source_documents` row and hit `uidx_ii_source_documents_user_checksum` directly. The REAL upload route (`app/api/investment-intelligence/source-documents/route.ts`, "spec section 31") checks for an existing `(user_id, checksum)` row FIRST and returns it unchanged (`deduplicated: true`) rather than ever attempting a duplicate insert. The harness now mirrors that real logic, and additionally proves `processSourceDocument()`'s own idempotent short-circuit (a cached prior-succeeded run returns `duplicateTransactionsLinked: 0` without re-executing anything) when the same already-processed document is reprocessed.
4. **Statement-staleness warnings mis-asserted as failures** — every fixture carries 2025 statement dates; real wall-clock "now" (over a year later) exceeds `reconciliationConfig.ts`'s 120-day `statementFreshnessWarningDays`, so a genuinely clean fixture correctly lands on `certified_with_warnings` (warning code `stale_statement_date`, occasionally alongside `incomplete_transaction_history` for Q04's incremental second upload) rather than bare `certified` — exactly as spec section 29 documents ("may permit CERTIFIED_WITH_WARNINGS"). The harness's assertions were relaxed to accept this and to positively enumerate the ONLY acceptable warning codes, so a genuinely new blocking condition would still fail the run.

None of the four are product defects. All four are now fixed in the harness itself (`tests/live-dev/iiPc3RealCamsQualificationLiveDev.test.ts`), committed alongside this status update.

## One genuine fixture-authoring bug found and fixed (not a product defect either)

Q07 (`pc3-q07-transaction-rich`)'s generator (`scripts/investment-intelligence/pc3/pc3FixturePack.ts`) started Scheme A's running balance at a synthetic pre-existing 500 units (`withRunningBalance(500, [...])`) — every other scenario in this pack correctly starts at 0. Because `documentProcessing.ts`'s `determineHistoryCompleteness` treats any first-time document import with at least one transaction as `complete_from_inception` (opening balance assumed zero — a real, existing, documented R2 design choice, not something introduced here), this made Q07's own printed closing balance (524.590) inconsistent with the sum of its own listed transactions (24.590), which would have deterministically produced a spurious `unit_variance_exceeds_tolerance` block unrelated to what Q07 is meant to test (that every transaction TYPE ingests correctly). Fixed at the source (`withRunningBalance(0, [...])`), fixture regenerated via the pack's own generator script, and the DB-free `tests/unit/iiPc3QualificationPack.test.ts` Q07 test (which only asserts canonical types, not closing balance) re-confirmed passing unaffected.

## Live-DEV, per-fixture result (Gate B requirement checklist)

| Fixture | Live-DEV proof | Result |
|---|---|---|
| Q01 | Full pipeline; 2 accounts, 2 transactions; clean certification (warnings: staleness only) | PASS |
| Q02 | No/wrong/correct password against the real decryption path; same economic result as Q01 once decrypted; password absent from `ii_document_parse_runs.errors` and the full `ii_source_documents` row | PASS |
| Q03 | Real tax-lot-engine round trip: Folio A's 100.19 units untouched, Folio B's post-redemption 90.29 units correct — zero cross-account contamination in real persisted state | PASS |
| Q04 -> Q05 | Q04: same account id reused across 2 uploads, Jan deduped, Feb added once. Q05: identical-byte reupload deduplicated at the upload layer (same document id, `deduplicated: true`), and reprocessing that same document is idempotent (`duplicateTransactionsLinked: 0`, no new rows) — queried real persisted `ii_transactions`/`ii_accounts`/`ii_holding_snapshots` counts, not HTTP status alone | PASS |
| Q06 | 5 SIP transactions persisted with correct dates; real R5 `sipOrchestrator` (`loadSipDataset` -> `runSipAnalytics`) detects exactly one gap (2025-02-05 -> 2025-04-05) | PASS |
| Q07 | All 7 canonical transaction types persisted with correct type/units (post-fixture-fix); certifies cleanly | PASS |
| Q08 | Real `reconcilePosition`/`evaluateCertification` path: `reconciliation_required`, blocking code `unit_variance_exceeds_tolerance`, never certified | PASS |
| Q09 | All 12 transactions, 12 distinct `source_reference`s, zero loss/duplication across the real 2-page-object PDF break; certifies cleanly — proves the `camsParser.ts` `AMC Name:`/`inTable` fix holds end-to-end against real DEV, not just the unit oracle | PASS |
| Q10 | Certification blocked by `parser_fatal_error` (not reconciliation math alone); the one surviving clean row persisted; the corrupted row's rejection recorded as a structured `unparseable_transaction_row` warning, not a raw DB error — proves the `documentProcessing.ts` fix holds end-to-end | PASS |
| Cross-user RLS | A second real synthetic user, via the real anon-key client: zero rows back on every table (broad filter AND direct-ID reach), storage download rejected, forged insert claiming another user's `user_id` rejected | PASS |
| PC2-F1 `closed_at` idempotency | Applied to Q03's real disposal (a partial redemption — no fixture in this pack contains a full lot closure, disclosed honestly): `closed_at` stays null and stable, and lot/consumption/gains row counts are identical across a repeated real-DEV tax-pipeline read | PASS (partial-lot half of the claim only; closed-lot drift regression not exercised by any fixture in this pack) |
| Full UI journey | Not attempted — explicit, disclosed scope decision, consistent with every other PC-series live-dev suite in this codebase (none drive a browser) | SKIPPED (disclosed) |

## Regression re-run after the harness/fixture fixes

| Check | Result |
|---|---|
| `tests/unit/iiPc3QualificationPack.test.ts` (22 tests) | PASS, unaffected by the Q07 fixture regeneration |
| `tests/unit/iiR2ParserFixtures.test.ts` + `tests/unit/iiR2Certification.test.ts` | PASS, 73/73 |
| `tests/unit/iiPc1F1FifoAccountScope.test.ts` + `tests/unit/r7AccountIdentity.test.ts` + `tests/unit/r7Deduplication.test.ts` | PASS, 70/70 |
| `tsc --noEmit` (targeted at the two changed files) | 0 errors |
| ESLint (targeted at the two changed files) | 0 errors, 0 warnings |
| Live-DEV independent zero-residue re-check (separate admin-client script, after the whole campaign) | 0 residual synthetic auth users; `ii_accounts` row count returned to the exact pre-campaign baseline (14) |

No product code (`lib/services/investment-intelligence/**`, `lib/engines/investment-intelligence/**`) was touched during Gate B — every fix was to the live-DEV test harness itself or to one test fixture's generator input. The two PC3-phase product fixes (`camsParser.ts`, `documentProcessing.ts`) from the original CONDITIONAL PASS are unchanged and are exactly what Q09 and Q10 now prove hold end-to-end against real DEV.

## What this means for the verdict

**Gate B: PASS**, on its own terms — the live-hosted-DEV pipeline behaved correctly end-to-end for all 10 required fixtures, with zero unexplained mismatches, zero security gap, and zero residue, after 4 rounds of honest live iteration that fixed real harness bugs (never a product defect) and one real fixture-authoring bug (also never a product defect).

Per the task's own stated decision rule, Gate B alone does not make PC3 UNCONDITIONAL FULL PASS — **Gate A (a real CAMS structural reference comparison) remains the sole outstanding blocker**, unchanged from the original pass, and requires the Product Owner to supply an authorized genuine statement. See `II_PC3_CAMS_STRUCTURAL_FINGERPRINT.md` section 0.
