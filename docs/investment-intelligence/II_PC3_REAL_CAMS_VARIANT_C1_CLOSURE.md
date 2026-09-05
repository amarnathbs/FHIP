# II-PC3-C1 — Real CAMS Variant Full Redesign & Final Qualification Closure

Status: **COMPLETE — VERDICT: UNCONDITIONAL FULL PASS.** This closes the whole II-PC3 release: `II-PC3` upgrades from **CONDITIONAL PASS** (Gate A's "no real CAMS structural reference available" blocker) to **UNCONDITIONAL FULL PASS**. Branch: `feature/ii-pc3-real-cams-qualification-pack`, built on top of `6a07bb3` (the prior narrow Gate A alt-layout fix). Not merged, not pushed, per task scope.

## 0. What this closure did, in one paragraph

Phase 1 re-opened the real, password-protected CAMS statement ONE more time (safety-bounded exactly as the prior Gate A pass was: password never persisted, decrypted content never written to disk, only abstract structural facts read) to confirm the one structural detail the prior pass had not fully characterized — the exact grammar of Stamp Duty/STT rows — and froze it into an authoritative fingerprint document. Phase 2 built one golden synthetic fixture reproducing every real structural characteristic, ran it through the unmodified parser, got a genuine RED (fee/tax rows rejected — the existing `ALT_TXN_ROW_RE` assumed every alt-layout row carries Price/Units/Balance fields, which a real fee row does not), applied one narrow additive fix (`ALT_FEE_ROW_RE`), and proved GREEN. Phase 3 rebuilt the entire qualification pack as Q01-Q12 in the real grammar. Phase 4 preflighted all 12, then ran the complete pack against real hosted DEV Supabase, achieving a clean pass after fixing two harness bugs (not product defects) found while running it for real.

## 1. Structural-match count: 12/13

See `II_PC3_REAL_CAMS_VARIANT_FINGERPRINT.md` section "Structural-match tracking" for the full property-by-property table. The one open item (property #4, AMC-name attribution) is the same honestly-disclosed, deliberately out-of-scope gap the prior Gate A pass already carried forward — `amcName` stays at its pre-existing `''` default for the real-variant grammar rather than guessing from the page-1 portfolio-summary table, which no fixture in either pack attempts to cross-reference. This is not a parser defect and does not block the verdict (the task's own "materially complete, no unexplained mismatch" bar is met — this gap is explained, not unexplained).

## 2. Golden fixture: RED -> GREEN

**RED** (confirmed against the unmodified parser, after `6a07bb3`): a golden synthetic fixture (`lib/fixtures/investment-intelligence/pc3-cams-real-variant/pc3-golden-real-variant.{txt,pdf}`, built by `scripts/investment-intelligence/pc3/pc3GoldenRealVariantFixture.ts`) reproducing an AMC transition, a folio, the combined scheme/ISIN line, the real transaction-table column order, one Stamp Duty row, one STT row, the real no-date closing grammar, and a page continuation with zero header reprint — run through `extractPdfText()` -> `parseExtractedDocument()` unmodified. Result: the Stamp Duty and STT rows both failed with `unparseable_transaction_row`, dropping 2 of 6 expected transactions with zero other symptoms — exactly the class of narrow, real structural incompatibility the fingerprint predicted (`ALT_TXN_ROW_RE` requires Amount+Price+Units+a trailing Unit Balance; the real fee-row grammar has only Date+Amount+a type label).

**Fix**: `lib/services/investment-intelligence/parsers/camsParser.ts` gained one new regex (`ALT_FEE_ROW_RE`) and one new handling branch in `parseTransactions`, tried only after `ALT_TXN_ROW_RE` fails — additive, never replacing any existing grammar. A fee/tax row now records `unitsScaled = 0` (a real fact, never fabricated) and `navScaled = null`/`balanceUnitsAfterScaled = null` (fields genuinely absent from this row shape, never guessed).

**GREEN** (confirmed): the same golden fixture, run through the real `extractPdfText()` -> `parseExtractedDocument()` pipeline (real `pdf-parse`, not a raw-text shortcut), now yields 2 accounts, 6 transactions (`purchase, fee, tax, sip, sip, purchase`), 2 holdings, **zero warnings**. Both fee/tax rows carry `unitsScaled = 0n` and `navScaled = null` — proven never misclassified as units/NAV/a holding.

## 3. Fee (Stamp Duty/STT) handling outcome — evidence-first

Per `II_PC3_REAL_CAMS_VARIANT_FINGERPRINT.md` section 9:
- **Stamp Duty**: `STANDALONE_ROW, amount-only` — confirmed present as 95 real transaction-table rows in the real statement, interleaved with full economic rows at the same date, carrying zero unit/price/balance fields. `CAPTURED_AT_PARSE_ONLY` and fully classified (`transactionTypeMapping.ts`'s existing, unmodified `fee` rule) — no schema change was needed; the existing `ii_transactions.transaction_type = 'fee'` canonical type already represents this correctly with `units = 0`.
- **STT**: the real statement inspected contains ZERO materialized STT transaction rows — the token "STT" occurs exactly once, in disclosure/footer prose. Classified `EVIDENCE_ONLY / NOT_CURRENTLY_MATERIALIZED_IN_THIS_STATEMENT` for direct observation; the parser's `ALT_FEE_ROW_RE` also recognises `STT`/`Securities Transaction Tax` on the disclosed INFERENCE (not observation) that it would share Stamp Duty's row grammar if a real sample ever contains one, given both are the same class of SEBI-mandated transaction-level charge.
- **No migration required**: the current canonical `ii_transactions` schema already preserves both fee categories correctly (`transaction_type IN ('fee','tax')`, `units = 0`, no fabricated NAV) — confirmed no cost-basis/gain corruption, since R6's tax-lot engine only ever consumes `purchase`/`sip`/`redemption`/`switch_*`/`reinvestment`-typed rows as acquisitions/disposals and does not touch `fee`/`tax` rows at all (verified by reading `taxOrchestrator.ts`'s input construction in the qualification tests — fee/tax transactions are never included in `acquisitions`/`disposals`).
- Fee/tax rows are proven, both DB-free and live-DEV, to never become their own holding, never carry non-zero units, and never get summed into an adjacent transaction's units/NAV (Q11's dedicated fee-evidence fixture and its live-DEV assertions).

## 4. Q01-Q12 REAL_CAMS_VARIANT_QUALIFICATION pack — fixture-by-fixture result

All fixtures live under `lib/fixtures/investment-intelligence/pc3-cams-real-variant/`, generated by `scripts/investment-intelligence/pc3/pc3RealVariantFixturePack.ts` (deterministic, no unseeded randomness). Oracles in each `.expected.json` are authored directly from the generator's own scenario data — never by running the parser and serializing its output.

| ID | Purpose | DB-free preflight | Live-DEV |
|---|---|---|---|
| Q01 | Multi-folio (2 accounts), purchase+SIP+redemption, Stamp Duty + STT, multi-page | PASS — 6 txns, 2 holdings, oracle match, zero warnings | PASS — 2 accounts, 6 txns persisted, fee/tax rows correctly zero-unit, clean certification |
| Q02 | Password-protected duplicate of Q01 (synthetic password `PC3RV-Qualification-2026` — never the real document's) | PASS — no/wrong/correct password states all correct via the real `PasswordException` type | PASS — same 3-state behaviour live; password never persisted in `ii_document_parse_runs`/`ii_source_documents` |
| Q03 | Same instrument, two folios (F1 probe) | PASS — 2 distinct account-resolution keys, zero cross-folio contamination | PASS — Folio A's 100.19 units untouched by Folio B's redemption (90.29 units), live-verified |
| Q04 | Monthly delta reusing Q01/Q03's account identities, only new txns added | PASS — shared transactions fingerprint-dedup, new ones don't | PASS — same 4 accounts reused (no 5th/6th minted), 4 duplicate links, 2 genuinely-new rows added |
| Q05 | Exact reimport of Q04 | PASS — identical fingerprints per row across two parses | PASS — upload-layer dedup (`deduplicated: true`, same doc id) and idempotent reprocessing (`duplicateTransactionsLinked: 0`, zero new rows) |
| Q06 | SIP-rich, one skipped month (March) | PASS — exactly 5 SIPs, correct dates, zero phantom row | PASS — same 5 persisted; real R5 `sipOrchestrator` detects exactly one Feb->Apr gap |
| Q07 | Every canonical transaction type + fee evidence, correct zero-based opening balance | PASS — 8 txns, all 7 non-fee types + 1 fee, balance arithmetic verified against the real holding | PASS — same 8 persisted with correct types/units; both schemes correctly share 1 account (2 instruments) per this grammar's AMC-collapse, 2 holdings |
| Q08 | Deliberate reconciliation mismatch | PASS (VALID_NEGATIVE) — parses cleanly, `reconcilePosition`/`evaluateCertification` correctly return `reconciliation_required`/`unit_variance_exceeds_tolerance` | PASS — same live: never certified |
| Q09 | Page-continuation (zero header reprint) + AMC transition | PASS — 7 txns, zero duplicate refs, 2 distinct folios present | PASS — 7 txns persisted, 6 distinct refs (fee row carries none, by design), 2 accounts, zero cross-account leakage, clean certification |
| Q10 | Impossible calendar date (30-Feb-2025) on one row | PASS (VALID_NEGATIVE) — `unparseable_date` error, one clean row survives, `parser_fatal_error` reaches certification | PASS — same live: `reconciliation_required`/`parser_fatal_error`, one clean row (`PCRV10-002`) persisted, no raw DB error |
| Q11 | Dedicated Stamp Duty/STT fee-evidence: single-fee and dual-fee (same date) transactions | PASS — 4 fee/tax rows, all zero-unit/null-nav, dual-fee date yields 2 distinct rows, 1 holding only | PASS — same live: 4 fee/tax rows persisted correctly, dual-fee date confirmed as 2 rows, zero extra holdings |
| Q12 | Continuation stress: 16-row table across a page break + a second folio/scheme/AMC | PASS — 18 txns, zero duplicate refs, 2 distinct folios/accounts | PASS — same live: 18 txns, 14+2 refs split correctly, 2 accounts, zero cross-scheme/cross-AMC leakage, 2 holdings |

DB-free preflight: **22/22 PASS** (`tests/unit/iiPc3RealVariantQualificationPack.test.ts`, includes the golden-fixture gate + manifest-completeness + synthetic-PAN-only guard). Live-DEV: **16 passed, 1 explicitly skipped (Playwright UI journey, disclosed scope decision consistent with every other PC-series live-dev suite), 0 failed** (`tests/live-dev/iiPc3RealVariantQualificationLiveDev.test.ts`).

## 5. Non-negotiables

- **Net-worth-once-only (Q01/Q03)**: proven at the persistence layer directly via the real, unmodified `publishPositionStructural()` (`publishing.ts`) — publishing the SAME canonical position twice returns the identical `publicationId` and leaves exactly one `ii_fhip_publications` row; Q03's two distinct folio positions publish to two distinct rows, never merged. (Disclosed scope note: the full request-scoped `publishPosition()` orchestration in `investmentPublicationService.ts` requires a Next.js server/cookie context with no script-level live-dev entry point anywhere in this codebase — this is the same bounded, honest proof available at this layer, not a re-implementation of the full service.)
- **F1 cross-account FIFO contamination = 0**: Q03 proves this both DB-free (`planFolioAccountResolution` resolves 2 distinct keys) and live-DEV (Folio A's 100.19 units genuinely untouched after Folio B's redemption).
- **F2 stale-v2-current-observation**: **NOT SUPPORTED by this harness** — no live-dev suite in this codebase (including the legacy Gate B suite) exercises this at the script level; honestly disclosed rather than fabricated, per the task's own "if the harness supports it" qualifier.
- **PC2-F1 `closed_at` passive-read invariant**: re-proven against Q03's real-variant partial redemption — `closed_at` stays null and stable, and lot/consumption/gain row counts are identical across repeated real-DEV tax-pipeline reads (1 then a second read after a 1.1s wall-clock tick). No fixture in this pack contains a full lot closure (disclosed honestly, same as the legacy pack).
- **Cross-user RLS security**: a second real synthetic user, via the real anon-key client, gets zero rows on broad and direct-ID reads across every II table, a rejected storage download, and a rejected forged insert claiming another user's `user_id`.

## 6. Two harness bugs found and fixed while running this live for real (not product defects)

1. **Test timeout too tight for the first, cold-start test.** The first live-DEV test in the file pays a one-time module-transform cost (`await import('@/lib/services/investment-intelligence/documentProcessing')` compiling for the first time) that pushed it to 60045ms against a 60000ms timeout. Every other test using the same import passed comfortably within 60s. Fixed by raising this suite's per-test timeouts to 120000ms (90000ms for the two multi-upload Q04/Q05 tests, which do 2-3 full upload+process cycles per test) — a harness-only change.
2. **`expectCleanCertification` helper used `.single()` against a query that can legitimately return multiple rows.** `ii_portfolio_truth_status` is keyed by `(account_id, instrument_id)`, not `account_id` alone. Q07 is the first fixture in either pack where two distinct schemes share one account (this grammar's `amcName` collapses to `'Unknown AMC'` for every scheme, so two different instruments under the same folio resolve to the same account — a legitimate, correct behaviour of `accountResolution.ts`, confirmed by reading `documentProcessing.ts`'s instrument-level keying). The helper's `.single()` call failed silently whenever more than one truth row matched, producing `undefined` and a confusing assertion failure. Fixed to check every matching row instead of assuming exactly one.

Diagnosed directly against real DEV (a throwaway diagnostic script, deleted after use, cleaned up its own synthetic user) before applying either fix — confirmed via the diagnostic run that Q07's real persisted state was already entirely correct (1 account, 2 correctly `certified_with_warnings` truth rows, 2 holdings) and the failure was purely in the test's own query shape.

## 7. Regression (same run)

| Check | Result |
|---|---|
| Legacy `LEGACY_CAMS_GRAMMAR_REGRESSION` (Q01-Q10, `tests/unit/iiPc3QualificationPack.test.ts`) + Gate A alt-layout probe (`tests/unit/iiPc3GateAAltCamsLayout.test.ts`) + `iiR2ParserFixtures.test.ts` + `iiR2Certification.test.ts` | PASS, 83/83 — unaffected by the `ALT_FEE_ROW_RE` addition (additive-only, tried after every existing grammar branch) |
| New real-variant DB-free pack (`tests/unit/iiPc3RealVariantQualificationPack.test.ts`) | PASS, 22/22 |
| New real-variant live-DEV pack (`tests/live-dev/iiPc3RealVariantQualificationLiveDev.test.ts`) | PASS, 16/16 (+1 disclosed skip) |
| Full `tests/unit/` suite | 237 files / 6000 tests: 5964 passed, 7 failed, 29 skipped. **All 7 failures are pre-existing and unrelated** — confirmed by isolated re-run: `fdh1Isolation`, `fdh11Isolation`, `g3RegistrationAlignment`, `countryGateAccessMatrix` (4 tests, all pass cleanly in isolation — confirmed concurrency/CPU-contention flakiness from running this suite alongside the live-DEV campaign, same class already documented in this codebase's own history) and `aiResidualClosureFailClosed` (3 tests, in `lib/ai/` — a pre-existing, already-independently-documented AI-module defect wholly unrelated to Investment Intelligence, reproduces identically in isolation, zero diff against `origin/main` for anything it touches). A further 9 `resources*` test files fail/skip with `supabaseUrl is required` — root-caused to a pre-existing, unrelated bug in those files' own `loadEnv()` helpers (a hardcoded absolute path `D:/FHIP/.env.local` with no BOM-stripping, breaking in any worktree whose `.env.local` differs byte-for-byte from the literal main checkout's) — confirmed unrelated to any file this closure touches. |
| `tsc --noEmit` | Clean except one pre-existing, unrelated error in `.next/types/app/api/admin/recommendations/gaps/route.ts` (Admin module, generated types) — confirmed via `git diff --stat origin/main` to be byte-identical to `origin/main`, last touched by an unrelated commit (`5aa878e`) well before this branch existed. |
| ESLint on every changed/new file | Clean, 0 errors, 0 warnings |
| Production build (`next build --webpack`) | Webpack compilation **succeeded** ("Compiled successfully in 3.4min"). Next's post-compile internal route-shape TypeScript check then failed on `app/api/admin/recommendations/gaps/route.ts` — confirmed via `git diff --stat origin/main` to be byte-identical to `origin/main` and last touched by an unrelated commit (`5aa878e`) well before this branch existed — the exact same pre-existing, disclosed, out-of-scope defect every prior PC3 pass on this branch has already documented. Not caused by, or fixable within, this closure's scope. |
| Second `origin/main` fetch mid-session | `origin/main` at `582d5e1` throughout this pass — no drift to reconcile |

## 8. Cleanup — zero residue, independently re-verified

Every synthetic user/household/member/document/account/transaction/holding/reconciliation-case/portfolio-truth-status/tax-lot/tax-lot-consumption/capital-gains/publication row created by this closure's live-DEV run was deleted in the suite's own `afterAll` (which itself re-queries every table to assert zero rows before completing). An additional, fully independent out-of-band script (deleted immediately after use) then paged through every auth user looking for any `pc3rv-`/`pc3g-`/`diag07-`-tagged synthetic email across the ENTIRE project — **zero found**, including from the first (pre-fix) live-DEV run that hit the two timeouts/failures described in section 6 (its own `afterAll` still ran and cleaned up despite the mid-file test failures). `ii_accounts` total row count returned to **14** — the exact same pre-campaign baseline the original Gate B campaign documented — and `ii_source_documents`/`ii_fhip_publications` both returned to **0**. No shared/reference catalogue row was touched by this closure (every table this pack writes to is user-scoped; nothing under a shared/reference schema was created, updated, or deleted).

## 9. Commit discipline

No real CAMS artifact of any kind (decrypted PDF, extracted text, name, PAN, folio, amount, unit count, NAV, balance, password) entered git history or any file that survives — verified by an explicit grep/strings sweep across every new/changed tracked file before commit (see the task's own commit for the exact sweep). Not merged, not pushed to `main`.

## 10. Final verdict

**`II-PC3` UPGRADES FROM CONDITIONAL PASS TO UNCONDITIONAL FULL PASS.**

- Structural match: **12/13** materially complete, the one open item (AMC-name attribution) explained and disclosed, not unexplained.
- Golden fixture: **RED -> GREEN** (fix: `ALT_FEE_ROW_RE`, additive, narrow, verified end-to-end through the real extraction pipeline).
- Parser genuinely supports both the legacy ("detailed_v1") and real-variant ("detailed_v1_alt_layout") CAMS grammars side by side — 83/83 legacy regression unaffected.
- Q01-Q12 preflight and live-DEV both pass as designed, Q08/Q10 correctly negative.
- All financial oracles match; F1, PC2-F1 clean; F2 honestly disclosed as not supported by this harness (not fabricated).
- Security passes (cross-user RLS, zero forgery, zero storage cross-reach).
- Cleanup is zero-residue, independently re-verified.
