# PDF routes for liability, retirement and Australian investment statements: report (19/10/2026)

Branch `feat/pdf-routes-liability-retirement-au-investment-20261019`, built on `origin/main` 44ff8d6. Pack: `docs/ai/pdf_routes_liab_ret_auinv/` (start at its `README.md`).
Decision implemented (Product Owner, 19/10/2026, final): the Liabilities, Retirement and Investments screens, which accepted CSV only and refused a PDF with "try a CSV", now accept a PDF too, landing in the same canonical outputs with the same review-then-accept model. CSV keeps working.
Evidence labels: UNIT-TESTED, PGLITE-VERIFIED, DEV-verified, PRODUCTION-VERIFIED, NOT PERFORMED. **Nothing here is PRODUCTION-VERIFIED.** No production credential was used, no production SQL was written or run, nothing was pushed.

## 1. Verdicts

| Class | Verdict | The exact gap |
|---|---|---|
| Liability statements (card, loan) | **FULL PASS on the stated rule** (8 of 8 corpus documents ended exactly where the specification says, on DEV, with the real scan and the real provider) | Conditions C-1 and C-2 below. DEV-verified on a synthetic corpus only; not performed: a browser drive of the screen, any real lender's layout, production |
| Retirement statements (super, pension, India provident fund) | **FULL PASS on the stated rule** (9 of 9) | Same. Additionally: **India has no certified deterministic layout; an India PDF always takes the AI path and is always review required** (by design, stated in the specification) |
| Australian investment statements (holdings, transactions) | **FULL PASS on the stated rule** (8 of 8) | Same. Cost base printed in a holdings table is validated but has nowhere to be stored |

"FULL PASS" is used in the sense the brief fixed: each class's corpus meets the stated reconciliation rules on DEV with the real scan and the real provider. It does **not** claim coverage of real-world statements: see section 6, which is the honest limit of every number below.
Each route is behind its own kill switch, default OFF: it is **released as code, dark**.

**Conditions that apply to all three verdicts (not rounded away):**
* **C-1. The temporary S3 scan copy is NOT verifiably deleted on DEV.** The original upload (the Supabase storage object) is deleted and verified absent for all 25 documents. The scan also makes a temporary copy in the S3 scan bucket; its deletion is done by the existing, unchanged scan-copy purge, and on DEV it was answered `access_denied` (HTTP 403, `verified: unverifiable`) again on 19/10/2026 for both documents checked (`evidence/dev_run_19-10-2026_scan_copy_check.json`). This is the earlier proof's finding F-4, still open: the DEV scan role lacks the delete permission (production's is UNKNOWN). **Until the permission is fixed and re-proved, "original and derivative PDFs deleted and verified" is true for the original only.** This is not fixable in code; it needs an AWS permission change by you.
* **C-2. Synthetic corpus only** (section 6, item 1).

## 2. What was built (and what was reused)

Reused unchanged: the shared Premium-only capability (`financialDataImport.ts`) at the route and again inside `createUploadSession` / `completeUpload`; the Premium re-check at the AI step (`premiumAiAccess.ts` through `evaluateAiFallbackGate`); the real malware scan bound to the stored object; local text extraction (the bank PDF engine's `extractPdfPages`); PII masking; the three AI adapters, the shared gateway, the strict schemas, the per-user US$1/day cap and the global ledger; `fdh_ai_fallback_drafts` (durable draft, claim-once, replay); the identical-upload rule; `singleFlight`; the verified purge; and the three canonical evidence writers `persistLiabilityStatementEvidence`, `persistRetirementEvidence`, `persistAuInvestmentEvidence`, with their existing reconciliation, bank matching, review, approve, proposal and apply steps. **No competing entitlement check, no new provider, no unrelated AI job.**

New: `lib/financial-data-hub/pdf-statements/` (kill switches, outcome vocabulary, line/money/date parsing, the document-class check, the provenance guard, text reading); three certified deterministic readers (`liability/pdfStatement.ts` layouts CARD-1 and LOAN-1, `retirement/pdfStatement.ts` RET-1, `investment/pdfStatement.ts` HOLD-1 and TXN-1); the intake branch in each service and route; three purge helpers (after durable evidence, after a durable draft, after a refusal); the printed-totals finder for AI-read holdings; PDF-aware prompts and a distinct ledger key prefix per route; the screen wiring; the corpus, the tests and the scripts.

Flow per class (specification `00_COMMON_SPEC.md` section 2): Premium at the route (403 before the body) -> PDF switch (403 before anything is stored) -> owner -> upload, structural scan, **real scan** -> text read locally -> class check (a wrong document is refused, **no model call, nothing charged**) -> certified reader (every line or a typed failure, never a guess) -> only a typed shortfall (`layout_unsupported`, `unread_lines`) may reach the model, through the unchanged gates, with the provenance guard on the draft -> the person reviews, then accepts -> the same writer. The original PDF is deleted and verified absent after the evidence, after a durable draft, or after a refusal.

## 3. Accuracy: the corpus run on DEV (DEV-verified, 19/10/2026)

Corpus: 25 synthetic PDFs (8 liability, 9 retirement, 8 investment), generated deterministically, SHA-256 in `corpus/MANIFEST.sha256`; expected values written by hand with the arithmetic shown (`EXPECTED_VALUES.md`) and re-derived in integer cents by a test that uses no reader. Run: `scripts/pdf_routes_dev_server.mjs` + `scripts/pdf_routes_dev_run.ts`, a local build of this branch against DEV project `vqycarelcoijzwlpkpcz`, the **real GuardDuty scan** (every document: scan clean and bound to the stored object), the **real gpt-4o-mini**, passwordless synthetic Premium people, cleanup re-counted (zero residue). Evidence: `evidence/dev_run_19-10-2026.json` and `_accuracy.txt`.

| Class | Documents | Ended as the specification says | Fields correct / total | Certified | Review required | Refused | Model calls |
|---|---|---|---|---|---|---|---|
| Liability | 8 | **8 of 8** | **145 / 147** (98.6%) | 3 | 3 | 2 | 2 |
| Retirement | 9 | **9 of 9** | **110 / 113** (97.3%) | 4 | 3 | 2 | 2 |
| Australian investment | 8 | **8 of 8** | **123 / 123** (100%) | 3 | 3 | 2 | 1 |
| **All** | **25** | **25 of 25** | **378 / 383** (98.7%) | 10 | 9 | 6 | 5 |

Not rounded up. "Fields" are every printed header figure, every line and every holding or option in the expected sheet (header, per line: date, type or name, quantity, price, amount). The five misses, exactly:

| Document | Missed field | Why |
|---|---|---|
| LB-03, LB-07 (model-read) | masked card digits (last four) | The masking layer tokenises the card number before the model sees the page, and a token is never accepted as an identifier (`ai_masked_identifier_rejected`). By design the person types the last four at review. |
| RT-03 (model-read) | member number last four | The same. |
| RT-09 (India passbook, model-read) | member number last four; **fund name** | The same; the model returned a different fund name from the heading. Shown to the person at review. |

Every certified document was read with zero model calls. Refused documents (negative controls and two-account files) cost nothing. **Wrong-on-the-page documents (LB-04 variance -43.95, RT-04 variance -180.00, AI-04 variance) were read exactly as printed and were NOT certified.** The invented-and-dropped-line traps behaved as the specification says (LB-06 and AI-06: summary lines excluded, both identical genuine rows kept; LB-07: the certified reader refused to guess at the footnoted amount and the model's reading reconciled). On the real model the provenance guard did real work once: for RT-03 the model returned a summary employer-contribution total (the sum of two printed lines, 1,900.00) that the page does not print, and it was dropped with the visible code `ai_figure_not_printed_dropped_employerContributions`.

Real provider spend for the whole run: **5 metered calls, all `gpt-4o-mini`, 12,067 tokens, US$0.0028 settled**, every call under a PDF-route ledger key (`liability-statement-pdf-ai-fallback`, `retirement-statement-pdf-ai-fallback`, `au-investment-statement-pdf-ai-fallback`) so cost is attributable by route, against a US$1/day per-person cap that was not approached.

DEV also proved (checks of the same run): a **Free** person's PDF upload to each of the three screens is refused 403 `PREMIUM_REQUIRED` with no document row, no scan and no model attempt; a byte-identical re-upload makes **no second model call**; a second confirm of the same draft is refused and charges nothing; another person can neither read nor confirm the statement.
Findings from the DEV work: (a) the first attempt reached the existing limit of 20 upload sessions per person per hour with one person, so the script now uses one person per class (a real consequence for anyone uploading many files in an hour); (b) in the second full run one confirm answered "fetch failed" (a network failure between the server and the database, not a decision of this code) and the identical retry succeeded; that run is kept as `dev_run_19-10-2026_run2_one_transient_network_failure.json`; I did not investigate the cause.

## 4. Tests (UNIT-TESTED / PGLITE-VERIFIED)

| Suite | What it proves |
|---|---|
| `pdfRoutesCorpus` (78) | files equal the generator; manifest and sheet current; every expected figure re-derived in cents with no reader; every figure is printed on its page |
| `pdfLiabilityReader` (16), `pdfRetirementReader` (34), `pdfInvestmentReader` (35) | the real PDFs through the real extractor and readers; fallback-needing documents fail **legitimately** (the readers are not weakened); strictness, summary-line exclusion, YTD column, wrong-on-the-page, identical rows; the existing reconciliation gives the corpus verdict; in-memory mutations of the text |
| `pdfRoutesServices` (69) | each class end to end over an in-memory database with the real writers, purge and drafts: kill switches (default off, literal `true` only, also after the upload), deterministic read, wrong-on-the-page not certified, refusals with **no gate and no model call**, password and image-only, malware hold, AI draft then confirm then replay refused, invented line dropped, dropped line gives variance, Free/lapsed at the AI step, resume with no second call, cross-tenant, deletion verified and its failure visible, SMSF routing, printed-total tie, a wrong line whose total still adds up |
| `pdfRoutesRoutes` (20) | the real route handlers and the real Premium capability: Free 403 **before the body is read**, spoofed plan claims, switch off, CSV unaffected, loan type required, size limit |
| `pdfRoutesMasking` (26) | the real extracted text of every document through the real masker: no planted detail survives (this found three real gaps, fixed), the gate fails closed without a key |
| `pdfRoutesCostAndFlags` (8), `pdfRoutesProvenance` (44) | ledger prefix and prompt per route; switch contract; `amplify.yml` forwards `AIE_`; environment document lists the switches; day-first, exact money, lakh grouping |
| `pdfRoutesSchemaPglite` (10) | on a real engine with the whole migration chain: **no migration is needed**; negative controls (an unknown code and event type are refused) |
| Mutation controls (`scripts/pdf_routes_mutation_controls.mjs`, `MUTATION_CONTROLS_RESULT.md`) | **20 of 20 killed**: removing the Premium guard, either switch check, the class check, the AI eligibility check, strictness, summary exclusion, the provenance guard, any of the three deletions, the retirement review policy, the line-check variance, the printed-total tie, the password check, the multiple-account check, the class threshold, two masking rules, and breaking one hand-computed corpus figure each makes a named test fail |

TypeScript: `tsc --noEmit` clean. ESLint: clean on every new and changed file.
Existing tests changed (3, each for a stated reason): `fdh10LiabilityLedgerUi` (pinned an ISO date the PO rule forbids), `fdh12Isolation` (allow the date formatter beside the money formatter), `fdhPurgeRawOnAiConfirm` (allow other named imports from `./purge`).

**Full repository suite, run once on this tip (19/10/2026): 15,404 tests; 15,345 passed; 41 failed in 52 files; 18 skipped.** Nothing was assumed: the 52 failing files were re-run on a clean `origin/main` checkout (45 files, 26 tests fail there too); every other failure passed when re-run alone on this branch (load-dependent), except `ownerBeforeUploadScripts`, which this branch DID break (my mutation script named an upload route as a literal path) and which is fixed and green. `aiResidualClosureFailClosed` A4 and the other baseline failures fail identically on `origin/main`. New suites in the full run: 340 tests, all passing. `git checkout -- scripts/` was run afterwards.

## 5. Migrations, rollback

**Migrations used: none.** Reserved numbers untouched (0286, 0289-0290, 0292-0293; 0287/0288/0291 spare; 0294 not needed). No CHECK constraint is widened, so the drop-and-recreate trap does not arise. Every value written already satisfies the existing constraints (PGlite proof).
**Rollback, per class, no deploy of code:** unset the class switch (or set anything other than `true`) and redeploy settings: new PDFs for that class are refused before anything is stored; CSV is unaffected. It **preserves** the per-user cap, the global ledger, every saved statement and pending draft (the pack adds no database object, so there is nothing to drop). Stopping all new AI spend without a deploy remains `sql/ops/O02a` of the Premium proof pack.

## 6. Residual risks and honest limits

1. **The corpus is synthetic and its PDFs are simple text layers.** No real lender, fund or broker statement was available. The certified layouts are exact (CARD-1, LOAN-1, RET-1, HOLD-1, TXN-1); a real statement will usually not match one, and then the result is the AI path (a draft the person checks) or a refusal as unread lines. **The real-world rate of certified reads is unknown and probably low until layouts for named institutions are added.** The document-class check is a signal count tuned on this corpus; a real statement worded unusually can be refused as "not this kind of statement" (nothing is charged and the person is told).
2. **No browser drive.** The three screens were type-checked and their wiring read, not driven. The DEV run used the same routes the screens call. NOT PERFORMED: opening the screens as a person.
3. **Identifiers.** An AI-read statement usually carries no card, member or HIN digits (masked before the model); the person types the last four, otherwise facility and account matching falls back to institution and type.
4. **The temporary scan copy** is condition C-1 above (still `access_denied` on DEV; production unknown).
5. **Password-protected PDFs are refused** (the bank PDF's password flow was not copied) and **image-only PDFs have no OCR**; a PDF with two accounts is refused (one statement row holds one account).
6. **Investment limits.** Cost base is validated but not stored; the types `CORPORATE_ACTION_EVIDENCE` and `UNKNOWN` are not read deterministically (they go to the fallback). A holdings PDF sent as a transaction statement (or the reverse) is refused, never silently re-typed.
7. **Per-user cap behaviour was reused, not re-proved here.** The 22-parallel and cap-rollover checks of the earlier proof apply to the same gateway; this run stayed far below the cap and did not exercise the limit refusal. NOT PERFORMED for these routes.
8. **One transient network failure** during a DEV confirm (section 3).
9. **Possible merge interaction:** `feat/premium-ai-prod-proof-20261019` also edits `ENVIRONMENT_VARIABLES.md`; a trial merge (`git merge-tree`) showed no conflict.
10. The pre-existing test failures on `origin/main` (about 36 files, repeated in the earlier reports) are unchanged by this branch; see the full-suite line above.

## 7. What the Product Owner must do, in order

1. Read this report and `docs/ai/pdf_routes_liab_ret_auinv/EXPECTED_VALUES.md` (the numbers I hand-computed); say whether the certified layouts and the refuse-rather-than-guess rules are what you want. Send real statements (redacted) if you want named-institution layouts added: that is where certified coverage is won.
2. Merge and push yourself, only if the verified tip is a fast-forward (commands in the final message; two separate PowerShell 5.1 lines).
3. Deploy with the three switches **unset**. Confirm a PDF sent to each screen is refused with plain words and a CSV still works.
4. **Fix and re-prove the scan-copy delete permission (C-1)** on the scan role (DEV first, then read production's), then re-run `evidence` check B1/`s3Purge` for one document. Until then do not claim derivative deletion.
5. Confirm the existing AI prerequisites on production exactly as for the bank and payslip PDFs (migration 0284, the AI switches, the real scan, the masking key, the provider settings). Without the AI switches a switched-on PDF route reads only certified layouts and refuses the rest.
6. Switch ONE class on (`AIE_LIABILITY_PDF_ROUTE_ENABLED` = `true`), redeploy, and run its journey with a synthetic Premium person and the corpus files (check SHA-256 first, `04_DEV_PACK.md` section C). Then the next class. Decide, with real statements, how much traffic reaches the AI path.
7. Decide whether to drive the three screens in a browser on DEV before step 5 (NOT PERFORMED here).

## 8. Files

Application: `lib/financial-data-hub/pdf-statements/*`, `lib/financial-data-hub/{liability,retirement,investment}/pdfStatement.ts`, `lib/financial-data-hub/investment/printedTotals.ts`, the three `*ProcessingService.ts`, `services/purge.ts`, `validation/liabilityStatement.ts`, the three upload routes, the liability process route, the retirement confirm route, the three AI gateways (prompt and ledger prefix), `lib/aie/masking/piiMasking.ts` (three rules), `lib/aie/adapters/shared/reviewDraft.ts` (lakh grouping), the three panels, `.env.example`, `ENVIRONMENT_VARIABLES.md`.
Pack and scripts: `docs/ai/pdf_routes_liab_ret_auinv/**`, `scripts/pdf_routes_{corpus,dev_run,dev_server,mutation_controls}`.
