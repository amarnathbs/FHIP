# Document2 (Investment Intelligence App Review) — Non-Benchmark Final Closure Traceability Matrix

Mission: "FHIP Investment Intelligence — Application Review Final Closure Mission" (Document2 findings, non-benchmark scope only). Produced 2026-09-30, branch `fix/document2-non-benchmark-closure-2026-09-30` off `origin/main` at `bbd63ce`, worktree `D:\FHIP\.claude\worktrees\agent-a2d55a5359bdc1212`.

**Source of truth used**: (1) the mission's own verbatim reconstruction of Document2's findings #1-#12 plus the joint-holding/resolution-history/canonical-publish follow-ups; (2) recent commits `318b06d`, `56b4ef3`, `ce5b3c8`, `4a7b9a4`, `eeb13d6`, `d18f0a1`, `807dfd1`, `bcc0f32`, `c632533`, `4072260`, `84debc5`, `befdb53`, `360b494` — these ARE the "latest Findings #1-#12 status" for this module (no separate `DOCUMENT2_*` report existed before this one; the closest prior artifacts are `docs/aie1-canonical-closure/CLOSURE_REGISTER.md`, the user's `nav1_18point_walkthrough_and_pc5_reuse_2026_09_28` memory, and `docs/investment-intelligence/PC5_IMPLEMENTATION_CERTIFICATION_2026-09-15.md`); (3) current `origin/main`; (4) live read-only queries against production (`twwpnltizhtjxhamyoxt`) and read/write queries against DEV (`vqycarelcoijzwlpkpcz`, synthetic/disposable data only, cleaned up).

**Verdict key**: PASS (fully verified, real, live) / PARTIAL (real but incomplete or unverified for part of the requirement) / FAIL (requirement not met) / CANNOT VERIFY (no safe/available way to test within this pass's access).

---

## #1 — Self / household member / owner matching

| Field | Detail |
|---|---|
| Original PO comment | Self name not visible; owner_unmatched cases couldn't be resolved; owner selector didn't offer expected member; joint-holding handling needed correction. |
| Previously claimed | "Fixed and live-verified" (2026-09-28 walkthrough memory), backfill accepted, joint-holding follow-up "also merged". |
| Implementation | `lib/services/household/ensureSelfMember.ts` (lazy-create-on-first-need, commit `318b06d`); `lib/aie/adapters/investment-intelligence/ownerMatching.ts`'s `matchStatementOwner` reused from `documentProcessing.ts` (commit `ce5b3c8`) to detect `owner_mismatch`/`joint_holding_allocation_required` in addition to the pre-existing `owner_unmatched`; `ReviewCentreClient.tsx` "Assign to" control. |
| On `origin/main`? | Yes — `318b06d`, `ce5b3c8`, `eeb13d6` all confirmed ancestors of `origin/main` via `git merge-base --is-ancestor`. |
| Required migration | `0227_ii_reconciliation_owner_mismatch_and_joint_types.sql` (widens `discrepancy_type` CHECK for the two new values). |
| DEV DB | **CONFIRMED APPLIED** — verified directly, not inferred: a disposable synthetic insert of `discrepancy_type='owner_mismatch'` and one of `'joint_holding_allocation_required'` both succeeded (HTTP 201) against DEV, then were deleted (zero residue); a control insert of a bogus type was correctly rejected with Postgres `23514` (CHECK violation), proving the constraint is live and still closed-vocabulary. This **contradicts the migration file's own header comment** ("NOT YET APPLIED to DEV/production") and the `ce5b3c8` commit message's claim of the same — evidently applied to DEV by an operator/PO after that commit was written (2026-09-29→2026-09-30). Lesson: do not infer DB state from a migration file's or commit message's own claim; test it. |
| Production DB | **NOT INDEPENDENTLY CONFIRMED** (read-only access; cannot run the same insert negative-control against production). Indirect evidence: of 185 real production `ii_reconciliation_cases` rows, 0 have `discrepancy_type` in (`owner_mismatch`, `joint_holding_allocation_required`) — consistent with either "not applied yet" or "applied but no real statement has hit that path yet". **Needs an operator/PO confirmation of the production migration ledger before this can be called PASS in production.** |
| Deployment | Code is deployed (main → Amplify auto-deploy per standing deployment_plan); DB migration status for production unresolved per above. |
| UI route | `/investment-intelligence/review` (owner_unmatched/owner_mismatch "Assign to" control), `/investment-intelligence/data` (source-documents list with issue badges, commit `807dfd1`). |
| Live DEV proof | `ce5b3c8`'s own commit message documents a real live-DEV round-trip: resolve → history → amend → supersession all correct, using the real `ownerMatching.ts` function. |
| Live production proof | Real production data confirms the **pre-existing** `owner_unmatched` path is genuinely live and used (170 of 185 real cases, 176 total resolved) — this part of #1 is PASS in production. The **new** `owner_mismatch`/`joint_holding_allocation_required` extension is blocked pending the production-migration confirmation above. |
| Negative controls | DEV: bogus discrepancy_type correctly rejected (23514). Household members: queried all 6 real production `household_members` rows directly — all `relationship='self'`, no duplicates, no orphaned rows found (4.3's data-quality checks pass on the evidence available). |
| Financial oracle | N/A (not a value-computation finding). |
| 4.1 Self+Spouse test | **CANNOT VERIFY end-to-end in production**: production `household_members` contains only 6 rows, all `relationship='self'` — no real `spouse`/joint household member has ever been created in production, so the Self+Spouse/joint-holding selector behaviour is verified only by unit tests (`pc5OwnerMatching.test.ts`, `pc5JointAllocation.test.ts`, both green, 131 combined tests across the II owner/joint/date/resolution-guidance suites) and the 2026-09-28 walkthrough's real-account testing (Dinesh + dv), not by a fresh synthetic two-member household created for this pass (time-boxed out of this session; see Deferred Items). |
| 4.3 Backfill | PO-ACCEPTED HISTORICAL RESIDUAL, per prior PO decision — not reopened. No duplicate/orphaned rows found in the current production `household_members` table. |
| **Current result / Verdict** | **PARTIAL.** Pre-existing `owner_unmatched` resolution: PASS, live in production. New `owner_mismatch`/`joint_holding_allocation_required` codepath: code correct and DEV-verified, but production DB-migration status is unconfirmed and joint-holding UI intentionally still has no real percentage-split allocation control (only "assign single sole owner", which the migration's own comment discloses supersedes a genuine joint reading). |
| Severity | Medium (real capability, correctly gated; not a false "done" claim once this matrix is read literally). |

---

## #2 — Re-evaluate → Publish workflow

| Field | Detail |
|---|---|
| Original complaint | "Reevaluate button is not working after click." |
| Implementation | `POST /api/investment-intelligence/portfolio-truth/certify` (re-evaluate); `lib/services/investment-intelligence/investmentPublicationService.ts`'s `publishPosition()` (publish, not the older structural-only `publishing.ts` stub). Discoverability fix `807dfd1`: per-document badges (open-issue count, positions-needing-attention count) surfaced on the Statements & data list itself, not only inside a document detail panel; Unpublish control added. |
| On `origin/main`? | Yes (`807dfd1` confirmed ancestor). |
| Database | `ii_portfolio_truth_status` (re-evaluate target), `ii_fhip_publications` (publish target) — both pre-existing tables, no new migration needed for this finding. |
| Production DB | Queried directly: 53 `ii_portfolio_truth_status` rows (52 `reconciliation_required`, 1 `certified`); exactly 1 `ii_fhip_publications` row, `status='published'`, real economic value (₹49,048.93, Parag Parikh Flexi Cap Fund, Dinesh's account) — i.e. the full loop has genuinely run once in production, not merely in a test. |
| 5.2 Publish → canonical → Net Worth | **VERIFIED, PASS.** The one production publication's `published_row_id` (`70bd7e9c-...`) was independently queried in the canonical `investments` table: `current_value 49048.93`, `source_type='investment_intelligence_published'`, `ii_publication_id` linked back correctly. `dashboardData.ts` sums Net Worth's investments bucket from `investments.current_value where is_active=true` — the exact row `publishPosition()` writes — with II's own pre-publish total (`overviewSummary.ts`, sums `ii_holding_snapshots.value`) never read by the dashboard, so there is no pre-/post-publish double count. |
| Duplicate-publish protection | **VERIFIED, PASS.** DB-level `unique index uidx_ii_fhip_publications_one_active_position on ii_fhip_publications(account_id, instrument_id) where status='published'` (migration `0042`) — a real, race-safe guarantee, not just an app-level check. A losing insert triggers a compensating rollback (`investmentPublicationService.ts` ~line 615-640) that deactivates the just-created `investments` row. App-level `idempotencyKey` short-circuit also present as a first-line optimisation. |
| 5.1 Re-evaluate | `807dfd1`'s own commit message documents a live-DEV round trip: Publish → Unpublish confirmed via `ii_fhip_publications.status='unpublished'`. Re-evaluate itself (`certify` route) is exercised by the 2026-09-28 walkthrough's real accounts (52 of 53 production rows are `reconciliation_required`, meaning re-evaluation runs regularly and correctly reports "still blocked" rather than silently no-opping) — **but** memory (`nav1_18point_walkthrough`) records an unresolved, NOT-fixed-in-this-pass defect: a fully-redeemed (zero-unit) position can never be re-evaluated/certified (`recertifyPosition`/`evaluatePositionAndCertify` silently no-ops). Re-confirmed as still open — not touched by any commit in the current `git log`. |
| 5.3 Discoverability | PASS as of `807dfd1` — badges now on the list view, guidance text present. Not independently re-walked in a fresh browser session this pass (see Deferred Items). |
| **Current result / Verdict** | **PARTIAL.** Publish→NetWorth and duplicate-publish protection: PASS, real, verified against live production data. Re-evaluate: PASS for the general path, but the known zero-unit-position defect (real, previously found, not fixed here — explicitly out of a narrow re-scope, see Deferred Items) remains open. |
| Severity | Medium (edge case, not the general path). |

---

## #3 — Processed statements must leave the active list

| Field | Detail |
|---|---|
| Implementation | Commit `9c6b4d2 fix(investment-intelligence): move fully-published statements into a collapsed "Previously processed" section`. |
| On `origin/main`? | Confirmed ancestor. |
| Verdict evidence | Not independently re-walked live in this pass (time-boxed); the commit exists, is on main, and is consistent with `807dfd1`'s per-document badge design (badges only shown for cases still needing attention). |
| **Current result / Verdict** | **PASS (code-level), CANNOT VERIFY (fresh live walkthrough)** — real commit on main implementing exactly this; not re-confirmed via a new browser session this pass. |
| Severity | Low residual risk — this exact commit was part of the same 2026-09-28/29 pass already cross-verified for several sibling commits in this matrix. |

---

## #4 — XIRR / TWRR (benchmark comparisons excluded)

| Field | Detail |
|---|---|
| Governing tests | `tests/unit/iiNavMarkToMarketGoldenFixtures.test.ts` (commit `bbd63ce`, this branch's own HEAD) + `tests/unit/iiPortfolioTwrrValuationReconstruction.test.ts` (`c632533`) — both re-run this pass: **20/20 PASS**. |
| 7.1/7.2 | Per the mission's own note, these two suites already independently hand-computed-fixture-certify TWRR/XIRR valuation-series reconstruction and NAV mark-to-market; re-run and confirmed green this pass rather than rebuilt. |
| 7.3 Real UI proof | **CANNOT VERIFY this pass** — no fresh browser walkthrough of `/investment-intelligence/performance` against a live/synthetic portfolio was performed (time-boxed out; see Deferred Items). This is the one sub-item the mission explicitly flagged as NOT yet done by the prior pass. |
| **Current result / Verdict** | **PARTIAL.** Fixture-level correctness: PASS (re-verified). Real-UI production/DEV display proof (7.3): still CANNOT VERIFY / outstanding. |
| Severity | Medium — the calculation engine is well-tested, but nobody has re-confirmed the Performance page actually surfaces it instead of "Not enough history" against a real portfolio since the golden-fixture suite landed. |

---

## #5 — Current NAV / current holding value

| Field | Detail |
|---|---|
| Implementation | `4072260 fix(investment-intelligence): mark holdings to market against the daily NAV feed`; golden-fixture suite as above. |
| Verdict evidence | Golden-fixture suite re-run, PASS. Production spot-check: the one real published position (`ii_publication_id 9189b2ae...`) shows `published_value 49048.93` matching `ii_holding_snapshots`/`investments.current_value` exactly — internally consistent. |
| **Current result / Verdict** | **PARTIAL** — fixture-level PASS; multi-currency / redeemed-holding / future-dated-NAV / finalized-report-immutability scenarios not independently re-walked with fresh synthetic data this pass (CANNOT VERIFY beyond what the existing golden fixtures already cover). |
| Severity | Low-medium. |

---

## #6 — Never show random/internal numbers to users

| Field | Detail |
|---|---|
| Original complaint | Global: no UUIDs/internal ids in user-facing UI. |
| Prior claimed status | Portfolio Truth list showed raw truncated ids ("Position a8b86c2e.../42c2515b...") — flagged as an open real bug in the 2026-09-28 walkthrough memory. |
| **Re-audit finding (this pass)** | **FIXED, confirmed in current code.** `components/investment-intelligence/InvestmentIntelligenceClient.tsx:1008-1014` now builds `positionLabel` from real `accountLabel`/`instrumentName` fields (joined through in `807dfd1`'s `source-documents/[id]/summary` route fix), falling back to the truncated-id form only when neither is resolvable (e.g. archived). A dedicated grep audit (UUID regex, `.id` interpolations, `error.message` renders) across `components/investment-intelligence/**`, `components/pc5/**`, and `app/(app)/investment-intelligence/**` found no other genuine user-facing UUID/internal-id leak — every other `.id` use is a React `key`/`value`/`htmlFor` attribute or an internal API-call URL. |
| Regression test | `tests/unit/investmentIntelligenceDateDisplay.test.ts` and the II date/UI-contract suites do not directly assert "no raw UUID" as a standing regression guard. **Gap**: mission section 6 asks for one; none exists yet for this specific class (see Deferred Items — recommend a source-text guard test analogous to `iiTaxErrorMessageSanitization.test.ts` added this pass). |
| **Current result / Verdict** | **PASS** for the specific previously-flagged defect (now fixed and confirmed); **PARTIAL** on the mission's broader ask for a standing regression test, which does not yet exist for this class. |
| Severity | Low (the actual leak is fixed; only the regression-guard is missing). |

---

## #8 / #19 — Date localisation

| Field | Detail |
|---|---|
| Canonical formatter | `lib/engines/date.ts` (`formatDateShort`/`formatDateTimeShort`), wrapped by `components/investment-intelligence/dateDisplay.ts` (`fmtDate`/`fmtDateTime`) — threads each row's own currency code (AU vs India date convention), not a global locale. Header comment documents a **2026-09-29 fix** (was hardcoded to `'INR'` unconditionally) and a **2026-09-30 fix** (today) for `ResolutionHistoryClient.tsx`'s `resolvedAt`, which was still calling `new Date(...).toLocaleString()` directly. |
| Compliant | `HoldingsTable.tsx`, `InvestmentIntelligenceClient.tsx`, `OverviewClient.tsx`, `PerformanceClient.tsx`, `PortfolioXrayClient.tsx`, `ResolutionHistoryClient.tsx` (confirmed: imports + uses `fmtDateTime`/`fmtDate`), `SipIntelligenceClient.tsx`, `TaxIntelligenceClient.tsx`, `TransactionDetailModal.tsx`. |
| **New defect found (this pass)** | `components/pc5/ResolutionDetailClient.tsx:459` — `{new Date(o.decidedAt).toLocaleString()}` — no import of the canonical formatter at all, browser-default-locale-dependent, the exact bug class `dateDisplay.ts`'s own header says was just fixed in its sibling component. **However**: independently confirmed this component is **orphaned/unreachable in the live app** — `app/(app)/investment-intelligence/resolutions/page.tsx`'s own header comment states explicitly that `components/pc5/ResolutionCentreClient.tsx`, `app/api/pc5/*`, and (by the same reasoning) the `[itemId]` detail page reading `ResolutionDetailClient.tsx` are "left in place, untouched and now unreferenced by any page" since the 2026-09-28 repoint to `ResolutionHistoryClient.tsx`. A repo-wide grep for links into `/investment-intelligence/resolutions/[itemId]` found none. **Not fixed in this pass** (dead code; fixing a screen no live user can reach is lower value than the two defects that were fixed) — flagged for a follow-up cleanup/deletion pass instead. |
| **Current result / Verdict** | **PASS** for every reachable Investment Intelligence surface (all live components route through the canonical formatter as of today). **FAIL, but in dead code** for `ResolutionDetailClient.tsx` — real defect, zero live user impact. |
| Severity | Low (unreachable code) — recommend deleting the orphaned PC5 UI/API surface in a dedicated pass rather than patching it. |

---

## #9 — Fund House / AMC exposure

| Field | Detail |
|---|---|
| Implementation | `84debc5 feat(investment-intelligence): add fund-house concentration pie chart` (UI only) on top of the pre-existing `calculateAmcConcentration()` engine (`lib/engines/investment-intelligence/xray/concentration.ts`). |
| **Defect found and FIXED this pass** | `lib/services/investment-intelligence/r5Repository.ts`'s `loadXrayDataset()` **hardcoded every position's `amcId`/`amcName` to `null`** (pre-existing since the original R5 commit, not introduced by `84debc5`) — the query to `ii_instruments` never selected an AMC field at all. Net effect verified: `calculateAmcConcentration()` always saw zero attributed value and returned `status:'unavailable'`, so the AMC table AND the new pie chart silently never rendered for ANY real user. Independently confirmed `ii_instruments.amc_name` is itself null/empty for every real production mutual-fund instrument sampled (HDFC/SBI/ICICI/Franklin/Kotak — all null or empty string). Confirmed the real source of truth is `ii_scheme_master` (amc_name populated: "SBI Mutual Fund", "Franklin Templeton Mutual Fund", "HDFC Mutual Fund", etc.), keyed by `instrument_id` with one current row per instrument (`effective_to is null`) — and confirmed, against REAL DEV holding data (not synthetic), that every one of 3 real held instruments resolves to a correct, non-null AMC name via this join. **Fixed**: `r5Repository.ts` now queries `ii_scheme_master` and wires the resolved name through as both `amcId`/`amcName`. Commit `e9c9d2f` on `fix/document2-non-benchmark-closure-2026-09-30`, plus new regression test `tests/unit/iiR5AmcMappingWired.test.ts`. |
| 11.2 Financial reconciliation | Verified: exposure value = `position.value`, sourced from `ii_holding_snapshots.value` — the identical column `overviewSummary.ts` sums for "current holding value" elsewhere, so no divergent valuation basis. |
| 11.3 Table + pie chart | Both read the same `data.amcConcentration.buckets` object (`PortfolioXrayClient.tsx`); the chart only regroups the tail into "Other", never recomputes — cannot disagree by construction. |
| 11.4 Underlying holdings | Confirmed genuinely separate, still-unaddressed capability: AMC concentration is a scheme-metadata measure requiring no look-through; true look-through into underlying securities is `lookThrough.ts`'s own engine (already exists, already distinct, referenced by `analysisAvailability.ts`'s own "Underlying holdings analysis is not available" messaging). The AMC pie-chart work does not touch or improve look-through availability — this is the PO's original question answered: **YES, this is a distinct requirement**, not resolved by #9, and it was not in scope to build in this pass (would require authoritative underlying-security holdings data this repo does not currently have wired for real user portfolios). |
| Production/DEV proof | **CANNOT VERIFY end-to-end with a real portfolio in this pass** (the fix was just made; no live user has reloaded Portfolio X-Ray against it yet). The DATA-LAYER correctness is verified directly against real DEV rows (see above), which is the strongest verification available without a live UI reload session against a real account. |
| **Current result / Verdict** | **FIXED THIS PASS, PARTIAL pending live reload confirmation.** Before this pass: FAIL (silently non-functional against all real data). After: implementation corrected and DEV-data-verified; a live browser reload against Dinesh's real production account (the one account with a real published position) was not performed in this session — recommended as the very next verification step. |
| Severity | Was High (entire feature non-functional); now Low-Medium pending the live-reload confirmation. |

---

## #10 — Every actionable Review issue needs a real fix path (global rule)

| Field | Detail |
|---|---|
| Current discrepancy_type vocabulary (source of truth: migration `0227`'s CHECK constraint, live on DEV) | `owner_unmatched`, `account_unmatched`, `instrument_unmatched`, `ambiguous_instrument`, `transaction_unclassified`, `unit_mismatch`, `value_mismatch`, `duplicate_suspected`, `missing_opening_history`, `unsupported_document`, `document_corrupt`, `document_password_required`, `parse_incomplete`, `statement_period_gap`, `other`, `cross_source_exact_duplicate`, `cross_source_high_confidence_duplicate`, `cross_source_conflict`, `cross_source_review_required`, `cross_source_holding_conflict`, `transaction_missing_from_restatement`, `ai_fallback_reconciliation_attempted`, `owner_mismatch`, `joint_holding_allocation_required` — **24 types**, matching the mission's own estimate exactly. |
| Types with a real Fix action today | `owner_unmatched`/`owner_mismatch` (Assign-to selector, `ReviewCentreClient.tsx`), `unsupported_document`/`document_corrupt`/`parse_incomplete`/`document_password_required` (discard + re-upload guidance, `befdb53`), `transaction_unclassified` has a classification path per `documentProcessing.ts`'s wiring. `joint_holding_allocation_required` is detected and surfaced with an explanation but **intentionally has no true percentage-split allocation UI yet** (only "assign single sole owner", which the `0227` migration's own comment discloses is a semantically different action, not a real fix for a genuine joint holding). |
| **Types confirmed to have NO real fix action (Acknowledge/Dismiss only)** | `ambiguous_instrument` and every `cross_source_*` type. This is an **explicit, disclosed, in-code decision**, not a silent gap: `ReviewCentreClient.tsx`'s own header comment (2026-09-29) states these were checked against real production data and found to have **zero occurrences ever in production**, so no bespoke action was built. Per the mission's own instruction ("confirm their current status even if zero production cases currently exist, do not let them drop off the register silently") — **this is that confirmation.** `duplicate_suspected`, `value_mismatch`, `unit_mismatch`, `missing_opening_history`, `statement_period_gap`, `account_unmatched`, `instrument_unmatched`, `ai_fallback_reconciliation_attempted`, `other` were not found to have a dedicated fix action in `ReviewCentreClient.tsx` either — same status (Acknowledge/Dismiss only), not separately called out in the code's own comments the way `ambiguous_instrument`/`cross_source_*` were. |
| Non-actionable/informational types | Not all of the above are necessarily wrong to leave as Acknowledge-only (e.g. `other`/`ai_fallback_reconciliation_attempted` may be genuinely informational) — but the code does not yet **distinguish** INFO from unresolved ERROR for this rule's purposes; every non-bespoke type currently gets the same generic Acknowledge/Dismiss treatment regardless of whether it is informational-by-design or actionable-but-unbuilt. |
| **Current result / Verdict** | **PARTIAL.** The four highest-real-volume types are genuinely actionable and fixed. A confirmed, disclosed, zero-current-cases gap remains for `ambiguous_instrument`/`cross_source_*` (Acknowledge/Dismiss is not a fix per mission rule #18) — this is accepted-risk-until-a-real-case, not silently dropped, but it is not closed either. The remaining ~11 types' actionability was not individually re-audited in this pass beyond confirming they have no bespoke Fix control (same status). |
| Deferred item | PO decision needed: build real fix actions for `ambiguous_instrument`/`cross_source_*`/the remaining ~11 types now (proactively), or formally accept the zero-occurrence-based deferral as current policy until a real case appears. Not decided in this pass. |
| Severity | Medium (disclosed, not hidden, but still open per the mission's own explicit instruction not to let this drop silently). |

---

## #11 — Resolution history + amendment

| Field | Detail |
|---|---|
| Implementation | `ce5b3c8` — `ResolutionHistoryClient.tsx` + `GET /api/investment-intelligence/resolutions` + `POST .../resolutions/[caseId]/amend`. Never mutates the original resolved case; inserts a new superseding row referencing it, full audit trail. |
| 13.1 History display | Friendly names via `fmtDateTime`/`fmtDate` (fixed today, see #8) — no raw UUID (confirmed by the #6 grep audit, which specifically checked `ResolutionHistoryClient.tsx`). |
| 13.2 Amend | `ce5b3c8`'s own commit message documents a live-DEV round trip: resolve → history → amend → supersession, all correct. Downstream re-evaluation/Publish-uses-latest-approved-resolution behaviour not independently re-derived line-by-line in this pass — relying on the commit's own documented live-DEV proof. |
| **Current result / Verdict** | **PASS** (code + live-DEV proof from the originating commit), with the #8 date-formatting fix landing the same day this matrix was produced. Post-publication-amendment re-publish/recompute semantics not independently re-tested this pass (CANNOT VERIFY that specific sub-scenario). |
| Severity | Low. |

---

## #12 — Unresolved message must explain how to resolve

| Field | Detail |
|---|---|
| Implementation | `360b494 fix(investment-intelligence): link unresolved-issue counts directly to their resolution UI`. |
| **Current result / Verdict** | **PASS (code-level)**, not independently re-walked link-by-link for dead-link/404 in a fresh browser session this pass (time-boxed; see Deferred Items). |
| Severity | Low residual risk. |

---

## Joint-holding follow-up

Covered under #1 above — `eeb13d6 fix(investment-intelligence): detect joint holdings on owner-unresolved statements`, confirmed ancestor of `origin/main`. Detection: PASS. Real allocation UI: intentionally not built (explicit scope decision recorded in `0227`'s migration comment, not a silent gap).

## Resolution-history date fix follow-up

Covered under #8/#11 above — `d18f0a1 fix(investment-intelligence): thread real currency into Resolutions history dates` fixed `ResolutionHistoryClient.tsx`; the sibling `ResolutionDetailClient.tsx` (dead code) was missed but has zero live impact.

## Canonical Publish → Net Worth (#15)

Fully covered under #2 above. **PASS**, verified against the one real production publication end-to-end: `ii_fhip_publications` → `investments` → (by column semantics) Net Worth, with a real DB-level uniqueness guard preventing duplicate publish and no evidence of pre-/post-publish double counting in `dashboardData.ts`.

## Tax & Cost — random identifier negative control (#16)

| Field | Detail |
|---|---|
| Original complaint | Screenshot showed an internal-looking identifier inside a user-facing tax failure message. |
| **Defect found and FIXED this pass** | `lib/engines/investment-intelligence/tax/taxLotEngine.ts` / `taxOrchestrator.ts` throw errors embedding raw `sourceEventId`/`lotId`/`instrumentKey`. Three routes — `tax/summary`, `tax/lots`, `tax/redemption-simulation` — caught these and interpolated `.message` verbatim into the `bad(...)` response, rendered directly by `TaxIntelligenceClient.tsx`. `lib/api.ts`'s own header comment documents this exact class of defect was fixed for Retirement routes on 2026-09-14 and explicitly flags "the same pattern exists on other registers' routes too" as an unaddressed cleanup — Tax & Cost was one of those unaddressed routes. **Fixed**: all three routes now log the raw message server-side only and return a fixed, clean, generic explanation. New regression test `tests/unit/iiTaxErrorMessageSanitization.test.ts` (source-text guard + negative control proving it is not vacuous). |
| **Current result / Verdict** | **FIXED THIS PASS.** Not independently re-walked through a real failing tax calculation in a live browser session (the underlying failure conditions — invalid lot history, negative units — were not reproduced live; the fix is verified by direct code inspection + a regression test, not a live-UI repro). |
| Severity | Was Medium (real user-facing leak); now fixed, pending a live-UI repro for full closure. |

---

## Underlying-holdings question (discovered under #9)

Answered above under #9 §11.4: genuinely separate requirement from AMC concentration, still not addressed for real user portfolios, not fabricated, not touched in this pass (would require new authoritative data wiring, out of this pass's time-box).

---

## Summary table

| # | Verdict |
|---|---|
| #1 Self/household/owner matching | PARTIAL — production migration status for the new owner_mismatch/joint_holding codepath unconfirmed |
| #2 Re-evaluate → Publish | PARTIAL — Publish/NetWorth/duplicate-protection PASS; known zero-unit re-evaluate bug still open (not fixed here) |
| #3 Processed statements leave active list | PASS (code), not freshly live-walked |
| #4 XIRR/TWRR | PARTIAL — fixtures PASS; real-UI production proof (7.3) still outstanding |
| #5 Current NAV/holding value | PARTIAL — fixtures PASS; edge scenarios not freshly re-walked |
| #6 No random/internal numbers | PASS (specific prior defect fixed); standing regression-test gap for this class |
| #8/#19 Date localisation | PASS on every reachable surface; FAIL in one confirmed-orphaned/dead component |
| #9 AMC/Fund House exposure | Was FAIL (non-functional against real data) — **FIXED this pass**, PARTIAL pending live reload confirmation |
| #9 sub-item: Underlying holdings | Confirmed genuinely separate & still unaddressed (not fabricated) |
| #10 Every actionable issue has a fix path | PARTIAL — 4 highest-volume types fixed; disclosed zero-case gap remains for `ambiguous_instrument`/`cross_source_*`/~11 others |
| #11 Resolution history + amend | PASS |
| #12 Unresolved message explains how to resolve | PASS (code), not freshly link-walked |
| Joint-holding follow-up | PASS (detection); allocation UI explicitly deferred by design |
| Resolution-history date fix follow-up | PASS (live component); FAIL in dead component |
| Canonical Publish → Net Worth (#15) | PASS, verified against real production data |
| Tax & Cost identifier leak (#16) | Was a real defect — **FIXED this pass** |

No item in this matrix is marked FULL PASS by virtue of a prior report's own claim alone; every PASS above cites the specific commit/DB query/test run that supports it.
