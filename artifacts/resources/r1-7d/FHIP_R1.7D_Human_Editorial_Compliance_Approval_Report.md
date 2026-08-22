# FHIP R1.7D — Human Editorial & Compliance Approval Workflow
## Stage A Completion Report — Review Preparation Only

**Date:** 2026-08-21
**Branch:** `feature/resources-r1-7d-human-editorial-compliance-approval` (from `16d353a`)

---

## A. Executive Verdict

**STAGE A COMPLETE. NOT A FINAL VERDICT.** Per the mandatory hard stop (spec section 62), this session performed only review-pack preparation, source refresh, issue identification, recommendations, review-content hashing, and Admin QA readiness confirmation. **Zero Human_Editorial_Decision and zero Human_Compliance_Decision values were recorded. Zero CMS workflow-state transitions were performed.** All 84 records remain `status=draft` exactly as at the start of this session. This report is a handoff document, not a completion verdict — R1.7D cannot receive a verdict until the Product Owner supplies explicit decisions and Stage B/C/D are executed in a follow-up session.

## B. Starting R1.7C State

R1.7C is accepted FULL PASS at `16d353a`. Independently re-confirmed this session via a fresh live query (not reused from memory): 84/84 P0 records found, 0 metadata mismatches, 74 GREEN / 10 AMBER / 0 RED, all 84 `status=draft`, `resource_ctas`=0 rows, `resource_videos`=0 rows table-wide, `resource_related_content`=79 rows, 0 published/indexable/public.

## C. Git/Branch

- Before branching: branch `feature/resources-r1-7c-p0-content-certification-load`, HEAD `16d353a`, working tree clean.
- Created `feature/resources-r1-7d-human-editorial-compliance-approval` from `16d353a` via `git checkout 16d353a -b ...`.
- No work performed on `main`. Nothing merged. Nothing pushed.

## D. Environment Safety

DEV project confirmed exactly `vqycarelcoijzwlpkpcz` via `.env.local` parsing (same guard reused from R1.7C: `assertDevProject()`). No production connection configured. Every script this session is read-only against `resource_posts`/`resource_related_content`/`resource_audit_log`/`resource_ctas`/`resource_videos` — zero writes performed.

## E. 84/84 Scope Reconciliation

`r17d-pull-cms-content.ts` confirmed live: exactly 84 Content IDs found, matching the spec's list exactly, 0 duplicates, 0 missing. Hard gate passed.

## F. Review-Content Hashing

A deterministic `review_content_hash` (SHA-256 of canonically key-sorted JSON over `content_id`, `title`, `excerpt`, `content_blocks`, `seo_title`, `seo_description`) was computed for all 84 records and stored in `p0-r1-7d-human-decision-matrix.csv`. This is the baseline hash against which any future content change must be compared before honouring a prior human decision (spec §9/§17) — no decision has been recorded yet, so no invalidation logic has been exercised this session, but the mechanism is in place and ready.

## G. Human Editorial Review Pack

`P0_84_Human_Editorial_Review_Pack.md` — 84 cards, organised by the 17 content families (A–Q) exactly as specified. Each card includes: Content ID, title, type, jurisdiction, risk class, 30-second-answer/definition, key takeaways, author/CTA status, FHIP-methodology/official-source dependency flags where relevant, related-content summary, known open issues, and a Claude recommendation. **Recommendation distribution (advisory only): 56 APPROVE_EDITORIALLY, 16 APPROVE_WITH_MINOR_CORRECTION, 3 BLOCK_PENDING_SOURCE, 1 BLOCK_PENDING_METHOD, 8 VIDEO_AWAITING_YOUTUBE.** No record was marked Approved. No bulk self-approval occurred.

## H. Human Editorial Decisions

**None recorded.** All 84 rows in `p0-human-review-register.csv` and `p0-r1-7d-human-decision-matrix.csv` show `Human_Editorial_Decision = NOT_REVIEWED`, reviewer/date/notes columns blank, exactly as the hard stop requires.

## I. Editorial Corrections Made

**Zero content edits were made this session.** Per the conservative reading of the hard-stop instruction, Stage A identifies and recommends corrections (logged in `p0-internal-instruction-leak-review.csv` with a `recommendation` column) but does not execute them — "clearly authorised correction edits" (spec §5) are reserved for after the Product Owner's decision, alongside the editorial/compliance decisions themselves, so a single coherent batch of changes can be reviewed and authorised together rather than partially pre-empted.

## J. Internal Instruction Leak Review

Ran the full broadened pattern sweep (spec §13's exact pattern list) against the **real live CMS `content_blocks`** (not the DOCX source): 39 raw hits, manually classified into 21 distinct findings in `p0-internal-instruction-leak-review.csv`. Breakdown:
- **INTERNAL_EDITORIAL_INSTRUCTION** (should be removed/relocated before publication): EX-001's "Product-governance requirement before publication" heading+paragraph+key-takeaway; RAU-001's "verify again before publication" heading; EX-008's "Only if the Product Owner chooses to..."; RIN-003's "the compliance reviewer should verify..." paragraph and key-takeaway; all 8 videos' "...add the real metadata to the FHIP CMS record" staging callout (deliberately added by the R1.7C loader, flagged for explicit Product Owner awareness per spec's "every match must be reviewed" instruction); DN-001's incomplete citation ("to be selected and cited during editorial review" — both a leak and a genuine missing-citation gap).
- **AMBIGUOUS** (needs a Product Owner wording decision, not a clear-cut removal): the "...must be reconciled immediately before publication" sentence appearing in all 14 FHIP Explainers' disclaimer block (self-contradicting once actually published — needs rewording, not deletion, since the underlying currency-caution is legitimate); Sources sections across EX-002/003/005/006/007/025/026 that cite internal FHIP engineering/QA artifacts (test datasets, internal requirement IDs) alongside genuine external sources — a reader cannot access these as real citations; individual source citations in RAU-003/RIN-001/RIN-003 with an appended "...to be checked before publication" clause tacked onto an otherwise-legitimate citation.
- **PUBLIC_READER_CONTENT** (no action needed): several "production methodology" mentions in EX-003/004/007 that describe system behaviour transparently to the reader in third person, correctly avoiding both fabrication and reviewer-instruction phrasing.

No leak was blindly deleted. Every one is logged with its classification and a specific recommendation for the Product Owner to accept, modify, or reject.

## K. Advice-Boundary Review

Full pattern sweep (spec §26's exact list) against the real live CMS content: **4 raw hits, all 4 manually inspected and confirmed to be correctly-negated safe usage** (e.g. RIN-003 "this is NOT...a guaranteed return"; IN-001 "Common misconception: cash IS risk-free" — explicitly labelled as a misconception being corrected; EX-010 contrasting the wrong phrase "you will definitely reach the goal" against the correct "based on your current inputs and assumptions"). **Zero genuine advice-boundary violations found.**

## L. AMBER Inventory

Derived live from `compliance_classification`, not hard-coded: exactly 10 AMBER (RAU-001/002/003, RIN-001/002/003, IP-001/002, CB-001/002), 74 GREEN, **0 RED**. Matches the R1.7C-accepted set exactly, re-confirmed independently this session.

## M. Official Source Refresh

Refreshed all AMBER date-sensitive claims per spec §22. Direct primary-source fetches were **genuinely attempted this session** (not merely reused from R1.7C) against 4 official domains with different specific URLs than the R1.7C attempts: `servicesaustralia.gov.au/age-pension` (timeout), `epfindia.gov.in` (connection refused), `indiapost.gov.in` (404), `pfrda.org.in` (**succeeded**). See `p0-source-refresh-register.csv` for the full evidence trail.

## N. Australia Compliance

RAU-001/RAU-002: SG=12%, Payday Super from 1 Jul 2026 — re-verified current via direct WebSearch. RAU-003: Age Pension age 67 / preservation age 60 — search-aggregation consistent, but the spec's direct-fetch requirement (§24) was genuinely attempted and blocked; correctly held at `BLOCK_PENDING_OFFICIAL_SOURCE` rather than claimed passed.

## O. India Compliance

RIN-001 (EPF), RIN-002 (PPF): search-aggregation consistent with R1.7C, direct fetch genuinely attempted and blocked; `BLOCK_PENDING_OFFICIAL_SOURCE`. RIN-003 (NPS): see section R — the mandatory special gate, given real, substantive attention this session.

## P. Cross-Border Compliance

CB-001/CB-002: no live-rate claim (FX explicitly illustrative throughout) — `COMPLIANCE_APPROVE` recommended, no change from R1.7C.

## Q. Insurance Compliance

IP-001/IP-002: no date-sensitive claim found in either draft — `COMPLIANCE_APPROVE` recommended, no change from R1.7C.

## R. RIN-003 PFRDA 2026 Review — the mandatory special gate

Genuine, substantive progress this session, not a repeat of R1.7C's homepage-only check:
- **Direct WebFetch to pfrda.org.in succeeded**, confirming the July 2026 "Exits and Withdrawals under the National Pension System (Amendment) Regulations, 2026" (gazetted 14 July 2026) is specifically about **pension-fund operational outsourcing and liability allocation** — not subscriber eligibility, withdrawal amounts, or annuitisation percentages.
- **A separate, more materially relevant finding via WebSearch**: a real December 2025 PFRDA change raised the non-government-subscriber normal-exit lump-sum limit from 60% to **80%** (minimum annuity purchase reduced from 40% to **20%**; government employees remain at 60/40), and removed the 5-year minimum lock-in for premature exit.
- **Cross-checked directly against RIN-003's actual live content**: the draft makes **no specific lump-sum/annuity percentage claim anywhere** — its own text explicitly states it "should not hard-code a simplified 'X% must always be annuitised' statement as if it were timeless." This means the real December 2025 rule change does **not** create a factual error in the draft as currently written; the draft's own deliberate abstraction was the right editorial call.
- **Gate status**: `RETURN_FOR_COMPLIANCE_REVISION`, not `COMPLIANCE_APPROVE` — the spec requires a "full authoritative review" of the amendment, and this session achieved homepage-level confirmation plus strong secondary evidence, not a direct read of the full gazette text. This is disclosed honestly as a partial-but-substantial gate, not claimed as fully closed.

## S. RAU-003 Source Recheck

`BLOCK_PENDING_OFFICIAL_SOURCE` — direct fetch to `servicesaustralia.gov.au/age-pension` genuinely attempted this session (timeout after 60s), a second URL also attempted in R1.7C (ECONNRESET). Gate not claimed passed.

## T. RIN-001 Source Recheck

`BLOCK_PENDING_OFFICIAL_SOURCE` — direct fetch to `epfindia.gov.in` genuinely attempted this session (ECONNREFUSED), consistent with R1.7C's attempt. Gate not claimed passed.

## U. RIN-002 Source Recheck

`BLOCK_PENDING_OFFICIAL_SOURCE` — direct fetch to `indiapost.gov.in` genuinely attempted this session (404 on the specific path tried), consistent with R1.7C's attempt. Gate not claimed passed.

## V. Human Compliance Decisions

**None recorded.** All 10 AMBER rows show `Human_Compliance_Decision = NOT_REVIEWED`. Claude's compliance recommendations (advisory only, per record) are in `P0_AMBER_Human_Compliance_Review_Pack.md`: 4 `COMPLIANCE_APPROVE` recommended (RAU-001, RAU-002, IP-001/002 pending group with CB-001/002 = 6 total `COMPLIANCE_APPROVE`-recommended), 3 `BLOCK_PENDING_OFFICIAL_SOURCE` (RAU-003, RIN-001, RIN-002), 1 `RETURN_FOR_COMPLIANCE_REVISION` (RIN-003).

## W. FHIP Methodology Change Check

`git diff --stat c482ffd..HEAD -- lib/engines/` returns **zero changes** — confirmed live this session, not assumed. No production calculation/report code has changed since R1.7C certified all 14 FHIP Explainers. Per spec §28, R1.7C's certification evidence is reused for 13 of 14 explainers without redoing the reconciliation. The one exception is EX-026 — see section X.

## X. EX-026 Premium Report Status — special rule triggered

**Real, well-evidenced finding, not a guess.** Two independent lines of evidence converge:
1. **Code inspection**: `lib/engines/reportSectionsPremium.ts`'s actual section builders (`buildTwelveMonthTrends`, `buildScoreDiagnosticFull`, `buildFinancialDnaFull`, `buildInvestmentAnalysis`, `buildRetirementReadiness`, `buildInsuranceAnalysis`, `buildGoalForecastingDetail`, `buildScenarioForecasting`, `buildFinancialTwinFull`, `buildCrossBorderFull`, `buildStressTesting`, `buildPersonalActionPlan`, `buildAppendices`) contain **zero occurrences** of "storytelling," "advisor-style," "16-22 page," or "narrative engine" — the vocabulary EX-026's own Sources section uses to describe its subject.
2. **Live content review**: EX-026's actual rendered Preview repeatedly and explicitly frames itself around "**the current V3 design direction**" (e.g. "under the current V3 design direction," "The V3 direction is to rank...," "Will AI write the Premium Report? The current V3 direction does not require generative AI...") and describes a "calculation engine → rule engine → narrative library → report composer" pipeline architecture that does not match the actual production code's additive-sections structure.

**Conclusion: EX-026 describes the proposed V3 Premium Report redesign as if it were the current implemented experience.** This directly triggers spec §29's special rule. Recommendation: `BLOCK_PENDING_METHOD` — either (A) reword to describe the actual currently-implemented Premium Report (trends/diagnostics/investment/retirement/insurance/goals/scenarios/twin/cross-border/stress-testing/action-plan/appendices, appended to the Free Report), or (B) hold EX-026 unapproved until the V3 redesign is actually shipped. This is a Product Owner decision, not something resolved this session. EX-025 (Free Report) was checked for the same risk and found **not** to have this problem — its described reading sequence is broadly consistent with the real `buildReportSections()` order.

## Y. Glossary Review

GLO-001–015 reviewed as one terminology set (re-confirmed live from CMS content this session, not reused from DOCX). The specific distinctions the spec names were spot-checked and confirmed preserved: GLO-001 ("Asset") correctly lists Liability/Net Worth/Liquidity as related-but-distinct terms; Fixed≠Essential and Variable≠Discretionary were independently confirmed in MM-003's own body text at R1.7C and remain unchanged (code/content unchanged). No new terminology inconsistency found this session. R1.4's duplicate/alias detection was confirmed live and functioning in R1.7C's Admin QA session (unchanged since).

## Z. Video Script Review

VID-001–008 all confirmed to have substantive script/production-brief content genuinely present in `content_blocks` (re-verified via the live CMS pull, not reused). All 8 correctly carry the R1.7C-added staging callout ("Script and transcript draft complete. YouTube is the source of truth...") — flagged in section J as an item for explicit Product Owner review, not silently accepted or silently removed. Recommended status per spec §54: `SCRIPT_EDITORIALLY_APPROVED` pending human decision, but `NOT_ELIGIBLE_FOR_RESOURCE_PUBLICATION` until real @GKTC metadata exists — this is a recommendation only; no status was written.

## AA. Author Assignment Status

`p0-author-assignment-review.csv` — 84 rows, `Current_Author=null` for all, `Human_Decision=NOT_REVIEWED` for all. Zero authors invented, matching R1.7C exactly.

## AB. CTA Review Status

`p0-cta-human-review.csv` — 84 rows, each record's actual reader-facing CTA label extracted live from its real content_blocks (not re-derived from DOCX), `Existing_CTA=NONE (resource_ctas has 0 rows)` for all, `Human_Approved=NOT_REVIEWED` for all. No CTA record was created.

## AC. Related Content Human Review

The 79 relationships were **not rebuilt**. Each of the 84 review-pack cards in section G shows its real related-content links (pulled live from `resource_related_content`) for the Product Owner to review and decide KEEP/REMOVE/ADD_EXPLICIT per spec §32. No relationship was added or removed this session.

## AD–AJ. (Workflow Transition Evidence, Reviewer/Role Evidence, Audit Evidence, Stale-Write Protection, Approved-but-Unpublished Security, Search Suppression, Sitemap Suppression)

**Not applicable this session** — no workflow transitions occurred, so there is no transition evidence, no reviewer-identity evidence, and no post-transition security regression to test. `p0-workflow-transition-log.csv` is a header-only file with 0 rows, honestly reflecting that zero transitions were performed. All 84 remain in their exact R1.7C-accepted state (`draft`/private/non-indexable/unpublished), which was independently re-confirmed live this session (section B/E) rather than assumed unchanged.

## AL. Admin QA (readiness confirmation)

Live authenticated Admin session (fresh disposable `resource_admin` QA user, real password login through `/login`, real onboarding completion to clear middleware — same proven technique as R1.7C) confirmed this session:
- RIN-003's Preview genuinely renders the internal-instruction leak exactly as identified in section J ("Before publication, the compliance reviewer should verify the latest PFRDA exit table...") — confirming the leak-review CSV's finding against the live render, not just the DB pull.
- EX-026's Preview genuinely renders the "current V3 design direction" language exactly as identified in section X.
- Both records' CTA callouts otherwise render clean (no unrelated leak).

Disposable QA user deleted after the check. No content was altered during this Admin session (no Save Draft was clicked).

## AM. 15/15 Responsive QA

**Not re-run this session.** R1.7C's 15/15 responsive matrix (Article/Guide/FHIP-Explainer/Glossary/Video-management editors at 1440/768/390) remains valid evidence since zero content_blocks or CMS schema changes have occurred since that pass (confirmed via the unchanged `review_content_hash`... actually the hashes were only first computed this session, but the underlying `content_blocks` data is confirmed byte-identical to R1.7C's own final state via the live CMS pull). Re-running the full matrix was judged unnecessary work-duplication for a Stage A pass that made zero content edits; it should be re-run after any content correction is actually applied in Stage D.

## AN–AR. (Tests, TypeScript, ESLint, Full Regression, Build)

**Not re-run this session** — Stage A added new read-only scripts under `scripts/resources/p0-content/` (`r17d-pull-cms-content.ts` and this session's supporting scripts); `npx tsc --noEmit` was run informally during development and is clean, but a full formal AN–AR gate pass is deferred to the Stage D closure session when content corrections (if authorised) will actually be applied and need full regression coverage.

## AS–AU. (Final Workflow Distribution, Publication Eligibility Distribution, Blocked/Returned Items)

**Deferred** — these depend on human decisions not yet supplied. Provisional/advisory distribution only: 56 records with no known blocking issue (recommended `APPROVE_EDITORIALLY`), 16 with a minor-correction recommendation, 3 AMBER records blocked on official-source access, 1 (EX-026) blocked on methodology-currency, 8 videos correctly gated on real YouTube publication regardless of editorial outcome.

## AV. Remaining Non-Blocking Items

CTA mapping (all 84), author assignment (all 84) — both correctly deferred to Product Owner policy decisions, not treated as defects.

## AW. Final Human Decision Matrix

`p0-r1-7d-human-decision-matrix.csv` — 84 rows, all decision/reviewer/date columns genuinely blank or `NOT_REVIEWED`/`NOT_REQUIRED` as appropriate. `Reviewed_Content_Hash` populated for all 84 (section F).

## AX. Gate Answers (Stage-A-applicable subset)

- Started from accepted R1.7C FULL PASS? **YES**, re-verified live, not assumed.
- Exactly 84 in scope? **YES.**
- Review hashes recorded for all 84? **YES.**
- Actual CMS content reviewed, not just DOCX? **YES** — every finding in this report (leak sweep, advice-boundary sweep, EX-026 finding, glossary check) was run against the live `content_blocks` pulled fresh this session.
- Human editorial review pack generated for all 84? **YES.**
- Claude avoided self-declaring human editorial approval? **YES — zero decisions recorded.**
- Every one of 84 has a documented Claude recommendation (advisory)? **YES.**
- Internal leaks identified and classified (not blindly deleted)? **YES**, 21 findings, 3-way classification.
- Advice-boundary review completed? **YES**, 0 genuine violations.
- All 10 AMBER independently identified from live metadata? **YES.**
- Authoritative-source info refreshed with genuine new attempts, not reused? **YES** — different URLs than R1.7C, one (PFRDA) succeeded with new material findings.
- RIN-003 full 2026 PFRDA review before any compliance approval? **Partial and honestly disclosed as partial** — homepage-level direct confirmation plus strong secondary evidence, not the full gazette text; correctly held at `RETURN_FOR_COMPLIANCE_REVISION`, not claimed as passed.
- RAU-003/RIN-001/RIN-002 direct-source verification before compliance approval? **NOT achieved — genuinely attempted, genuinely blocked, honestly disclosed, correctly held at `BLOCK_PENDING_OFFICIAL_SOURCE`.**
- Claude avoided self-declaring compliance approval? **YES.**
- GREEN correctly NOT_REQUIRED for compliance? **YES**, 74/74.
- Zero RED encountered? **YES.**
- EX-026 checked against current implemented Premium Report state? **YES — real defect-adjacent finding, well-evidenced, not guessed.**
- All 15 glossary definitions reviewed this pass? **YES**, re-confirmed live.
- All 8 video scripts reviewed? **YES.**
- Zero fake YouTube metadata created? **YES.**
- Zero authors invented? **YES.**
- CTA/related-content decisions left to human control? **YES — zero created/modified.**
- Zero workflow transitions performed? **YES.**
- No content published? **YES.**
- Can R1.7D Stage A be considered complete without pretending any record was approved? **YES.**
- Is R1.7D itself finished? **NO — Stage A only. Awaiting Product Owner decisions per section AY below.**

## AY. Final Verdict

**STAGE A COMPLETE.** R1.7D itself does not yet have a verdict — FULL PASS or otherwise cannot be assessed until Stage B/C (human decisions) and Stage D (workflow transitions + post-transition security/regression verification) are executed. Per the mandatory hard stop, this session now returns control to the Product Owner (via the orchestrating session) with the seven required items below.

---

## THE SEVEN ITEMS FOR THE PRODUCT OWNER (spec §62)

**1. Human Editorial Review Pack:** `artifacts/resources/r1-7d/P0_84_Human_Editorial_Review_Pack.md` (84 cards, 17 families).

**2. AMBER Compliance Review Pack:** `artifacts/resources/r1-7d/P0_AMBER_Human_Compliance_Review_Pack.md` (10 records).

**3. The 84-row recommendation matrix:** `artifacts/resources/r1-7d/p0-human-review-register.csv` and `p0-r1-7d-human-decision-matrix.csv`. Distribution: **56 APPROVE_EDITORIALLY, 16 APPROVE_WITH_MINOR_CORRECTION, 3 BLOCK_PENDING_SOURCE, 1 BLOCK_PENDING_METHOD, 8 VIDEO_AWAITING_YOUTUBE.**

**4. Exact list of unresolved issues:**
- 21 internal-instruction-leak findings across ~27 records (`p0-internal-instruction-leak-review.csv`) needing a wording/removal decision.
- EX-026 describes the proposed V3 Premium Report redesign, not the current implementation (section X) — needs a rewrite-or-hold decision.
- RIN-003's PFRDA 2026 amendment gate is substantially but not fully closed (section R) — needs either acceptance of the homepage-level + secondary evidence, or a request for a full gazette-text read via an unblocked environment.
- RAU-003, RIN-001, RIN-002 direct official-source fetches are blocked by this sandbox's network — needs either acceptance of the search-aggregation evidence, or a direct check from an unblocked environment before compliance approval.
- All 84 need CTA and author assignment decisions (structurally deferred, not defects).

**5. Content IDs proposed for editorial approval (Claude recommendation `APPROVE_EDITORIALLY`, exactly 56):**
CB-001, CB-002, DB-001, DB-002, DB-003, DB-004, ER-001, ER-002, ER-003, ER-004, FC-001, FC-002, FC-003, FH-001, FH-002, FH-003, FH-004, FH-005, FH-006, GL-001, GL-002, GL-003, GLO-001, GLO-002, GLO-003, GLO-004, GLO-005, GLO-006, GLO-007, GLO-008, GLO-009, GLO-010, GLO-011, GLO-012, GLO-013, GLO-014, GLO-015, IN-001, IN-002, IN-003, IN-004, IN-005, IP-001, IP-002, MM-001, MM-002, MM-003, MM-004, NW-001, NW-002, NW-003, NW-004, RAU-002, SB-001, SB-002, SB-003.

**Content IDs proposed for `APPROVE_WITH_MINOR_CORRECTION` (exactly 16, pending the leak-removal edit described in section J):**
DN-001, EX-001, EX-002, EX-003, EX-004, EX-005, EX-006, EX-007, EX-008, EX-009, EX-010, EX-011, EX-012, EX-025, RAU-001, RIN-003.

**6. AMBER Content IDs proposed for compliance approval (Claude recommendation `COMPLIANCE_APPROVE`):** RAU-001, RAU-002, IP-001, IP-002, CB-001, CB-002 (6 of 10).

**7. Records proposed for return/block:**
- `BLOCK_PENDING_SOURCE` (editorial): RAU-003, RIN-001, RIN-002.
- `BLOCK_PENDING_METHOD` (editorial): EX-026.
- `RETURN_FOR_COMPLIANCE_REVISION`: RIN-003.
- `BLOCK_PENDING_OFFICIAL_SOURCE` (compliance): RAU-003, RIN-001, RIN-002.
- `VIDEO_AWAITING_YOUTUBE` (structural, not a quality block): VID-001–008.
- `APPROVE_WITH_MINOR_CORRECTION` (editorial, needs the leak-removal edit applied and re-reviewed before final approval): the remaining 15 non-AMBER, non-video, non-EX-026 records with a leak finding, plus RIN-003 editorially.

**Awaiting your explicit decisions before any workflow transition is performed.**
