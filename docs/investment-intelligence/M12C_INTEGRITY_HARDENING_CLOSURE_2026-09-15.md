# M12C — PC4 Financial-Integrity Closure and Integrity Hardening

**Mission:** FHIP — M12 "Final Closure", Phase C (sections 8 through 16 of the M12 dispatch)
**Date:** 2026-09-16 (the mission's `2026-09-15` date label is retained, as Phase B retained it)
**Branch:** `mission/m12c-integrity-hardening-2026-09-15`, branched from `48e053d613726079fed8b6856b0e9937ec20192c` — M12B's closure commit, **not** `origin/main`
**Carried forward:** all 16 prior mission documents, inherited by branching rather than copied (report §16.1). With this document, `docs/investment-intelligence/` carries **17** mission documents.

**Authority exercised:** repository and git inspection; test execution; **read-only** PostgREST `GET` probes against PRODUCTION with paired negative controls; read/write against the **DEV** database for synthetic fixtures only.
**Authority NOT exercised:** no push, no merge, no deployment, **no production write of any kind — not one `POST`, `PATCH`, `DELETE`, RPC, DDL or DML reached the production database**, no production configuration change, no rollout change, **no secret provisioned in any persisted config file**, and no `.env.local` created anywhere in this worktree.

**No credential value, PAN, Aadhaar, folio number, bank number, policy number, holder name or raw statement text appears anywhere in this document.** Instrument identifiers are truncated to an 8-character prefix, exactly as M1 and M11 did, and the only economic figures reproduced are unit counts that PC4's own published reports already contain.

---

## 1. Verdict


> # M12C — **CONDITIONAL PASS.**
>
> **PC4's five reconciliation residuals now have a single, named, live-proved
> mechanism — and it is not the one anyone was looking for.** They are not a
> parser arithmetic defect. Production's `ii_transactions` is a **union of rows
> written by five different parse runs, three of which are recorded `failed`
> with `transactions_found = 0`**, and the final, fully-fixed run contributed
> **zero** of its 964 rows because every one deduplicated against that
> accumulated union. **PC4's fixes shipped; the stored data was never rebuilt.**
> §8.4.
>
> **The 251 "benign" findings are reclassified at source, on evidence rather
> than on a hand tally.** A structural probe using the *same predicates as the
> shipped classifier* found **zero of 251** are date-led and money-shaped — not
> one is a transaction row. `parsed.errors` for that document goes from **251 to
> 0**, clearing `parser_fatal_error` on all 17 positions, **without a single
> character of `certification.ts` being weakened**. §8.2.
>
> **`M3-F1` is CONFIRMED and FIXED.** §8.3.
>
> **Sections 9 through 16 are closed with real code and observed RED-before
> evidence**, with the exceptions named in their own rows.
>
> **What keeps the phase CONDITIONAL, and it is exactly five things:**
>
> 1. **The PC4 owner mapping is a Product-Owner action inside the running
>    application** that no agent may perform. §8.1 documents the flow
>    click-by-click and proves it works on a synthetic reproduction; it cannot
>    perform it. **`OA-8`.**
> 2. **Four of the five residuals remain unexplained at the ROW level.** Their
>    mechanism is now known and proved; naming the specific missing rows
>    requires the source document, which this phase does not have. §8.4.
> 3. **The remediation that mechanism implies deletes the Product Owner's real
>    production rows** and is therefore an operator action, not an autonomous
>    one. **`OA-11`, new.**
> 4. **`AIE_MASK_TOKEN_ENCRYPTION_KEY` is still unprovisioned** — inherited
>    unchanged, not this phase's to fix. **`OA-6`.**
> 5. **The canonical `server-only` package is not installed**, so §13's boundary
>    is enforced by a test and a runtime guard rather than by a build failure.
>    §13 states the difference rather than implying the stronger claim.
>
> **`UNCONDITIONAL FULL PASS` is not available and this report does not award
> it.**

### 1.1 Section verdicts

| § | Item | Verdict |
|---|---|---|
| **8.1** | PC4 owner mapping | **CONDITIONAL** — flow traced, documented click-by-click and proved end to end on a synthetic reproduction; **the real mapping cannot be performed in production today** for three named product-gap reasons (`OA-8`, `M12C-O8`, `M12C-O9`) |
| **8.2** | The 251 benign rows | **PASS** — reclassified at source on live structural evidence; `certification.ts` untouched |
| **8.3** | Opening-balance defect `M3-F1` | **PASS** — confirmed RED first, fixed as an adjustment only |
| **8.4** | The five variances | **CONDITIONAL** — 1 of 5 fully attributed row-for-row; all 5 share one proved mechanism; 4 of 5 not explained at row level |
| **9** | Reduced synthetic pack S01–S10 | **PASS** — 11 of 11 cases, DEV only, zero residue proved; `OA-7` resolved; **two new defects found** |
| **10** | II password brute-force gap `M2-OPEN-8` | **PASS** |
| **11** | Wrong-document / shared storage path `CG-10` | **PASS** |
| **12** | AIE state-machine cleanup | **PASS** — all three closed; a real shipped defect found (`purged` was not terminal); no live DB proof, substitute named |
| **13** | Server-only secret boundary `M2-OPEN-4` | **CONDITIONAL** — enforced by graph-walk test + runtime guard; build-time enforcement is a named follow-up |
| **14** | Cost accounting retry gap `M2-OPEN-5` | **PASS** |
| **15** | Multiline address masking `M3-OPEN-2` | **PASS** — with named residual limits |
| **16** | PC5 accessibility `M5-OPEN-1` | **CONDITIONAL** — axe genuinely ran on all 7 states with 0 violations and a harness negative control; all 6 keyboard items exercised; screen-reader testing NOT AVAILABLE |

---

## 2. What this phase was asked to do, and what it did


| M12 dispatch | Status |
|---|---|
| §8.1 — investigate the PC5 owner-resolution flow, verify it on a synthetic reproduction of the same shape, name it as an operator action rather than scripting around it | **DONE.** §8.1 |
| §8.1 — re-run certification against production READ-ONLY for a fresh baseline | **DONE.** §8.1.1, negative controls paired |
| §8.2 — re-examine the 251; change classification AT SOURCE if the evidence supports it; never weaken `certification.ts`; add regressions per category | **DONE.** §8.2 |
| §8.3 — investigate `M3-F1`, prove RED first, fix as an adjustment only | **DONE.** §8.3. 9 of 18 tests observed failing against the pre-change parser |
| §8.4 — re-run all five; explain as many as possible; replay any residual's full source-order history rather than leaving it an unexamined number | **DONE, and the replay is what found the mechanism.** §8.4 |
| §9 — run the reduced synthetic pack in DEV; do not leave `OA-7` unresolved | **DONE.** 11 of 11 cases, zero residue proved, two new defects found |
| §10 — apply the existing certified limiter to II password surfaces; shared limiter; record BEFORE decryption; existing threshold | **DONE.** §10 |
| §11 — reproduce CG-10 in DEV; trace UI id → route id → document id → storage object → parse run; fix narrowly; add the named regressions | **DONE.** §11 |
| §12 — close `M2-OPEN-1/2/3` narrowly, with explicit tests and live proof | **DONE**, except live proof — no database access was held for this item and the substitute is named as a substitute |
| §13 — `import 'server-only'`; update `.env.example` and `ENVIRONMENT_VARIABLES.md` (names only); build/static tests | **DONE, with one honest substitution.** §13 |
| §14 — sum usage across attempts; never double-settle; preserve fail-closed admission | **DONE.** §14 |
| §15 — bounded labelled-field address extraction, never an unbounded newline regex | **DONE.** §15 |
| §16 — axe must actually run over the seven PC5 states | **DONE.** All seven states reached and scanned, with a harness negative control proving the scanner can fail |
| Copy forward all 16 prior documents | **DONE** — inherited by branching, report §16.1 |
| Re-verify migration numbering fresh | **DONE**, with positive and negative controls. report §16.2 |
| No push, no merge, no production touch, no persisted secret | **HONOURED.** report §16.3 |

---

## 3. Findings summary


| Id | What | Where | Status |
|---|---|---|---|
| **`M12C-F1`** | **The PC4 residuals' real mechanism.** `ii_transactions` in production is a union of rows from **five** parse runs, **three of them `failed` with `transactions_found = 0`**; the final fixed run inserted **zero** of its 964 rows. A run killed mid-pipeline leaves its partial writes behind, and those orphans permanently suppress every later run's identical rows through the fingerprint dedup | `lib/services/investment-intelligence/documentProcessing.ts` (stale-run rescue + fingerprint preload) | **EXPLAINED, NOT FIXED** — the remediation deletes real production rows (`OA-11`) |
| **`M12C-F2`** | **Reclassification changes fingerprints, so a parser FIX defeats its own idempotency.** `computeTransactionFingerprint` includes `transaction_type`; when `reclassifyNegativeSignedInflowRows` retyped a row `purchase → reversal`, the later run's row no longer matched the earlier one and was inserted **alongside** it. Both copies of three real events are in production today | `lib/services/investment-intelligence/fingerprint.ts` | **EXPLAINED, NOT FIXED** — same remediation |
| **`M3-F1`** | **CONFIRMED.** The CAS opening balance was captured and discarded, forcing every CAS import to reconcile from a zero baseline | `lib/services/investment-intelligence/parsers/camsParser.ts` | **FIXED** §8.3 |
| **`OA-9` / `M1-F3`** | 251 structurally non-economic findings emitted at severity `error`, blocking certification of all 17 positions | same file | **FIXED** §8.2 |
| **`M2-OPEN-8`** | Two PDF password surfaces accepted unlimited guesses on authenticated documents | `documentProcessing.ts`, `payslipProcessingService.ts` | **FIXED** §10 |
| **`CG-10`** | A storage-path-keyed row lookup that failed open on a collision, and a silent re-upload substitution | `manualImporter.ts`, the upload route's client | **FIXED** §11 |
| **`M2-OPEN-4`** | No server-only marker, no lint rule and no test anywhere in the repository | `lib/aie/**` | **FIXED** §13 (with a named residual) |
| **`M12C-F3`** | `ENVIRONMENT_VARIABLES.md` quoted a version of `amplify.yml`'s env-forward list that was **stale by six entries**, making the document itself the source of a misleading "known gap" — a reader would have concluded AIE configuration could not reach the runtime at all | `ENVIRONMENT_VARIABLES.md` | **FIXED** §13 |
| **`M2-OPEN-5`** | Retry-loop usage under-settled; an all-attempts-fail sequence settled **zero** tokens after up to three real requests | `lib/aie/provider/**` | **FIXED** §14 |
| **`M3-OPEN-2`** | The address masking rule masked only the first line of a multi-line address | `lib/aie/masking/piiMasking.ts` | **FIXED** §15 |

---

## 4. Section 8.1 — the PC4 owner mapping


> **The headline is not the one this section was expected to produce.** The PC5
> owner-resolution flow exists, works end to end, and is documented
> click-by-click in
> `docs/investment-intelligence/M12C_PC4_OWNER_MAPPING_OPERATOR_ACTION.md`. **But
> the Product Owner cannot perform it in production today, for three concrete
> reasons that are product gaps rather than caveats**, and telling them to "go
> and click Resolutions" would have sent them to an empty screen.

### 4.1 What the investigation actually found

The flow was traced from the sidebar to the database write, and then **verified end to end on DEV against a synthetic reproduction of the same scenario shape** (`scripts/m12c_pc5_owner_mapping_synthetic_repro.ts`, driven through the real screens and the real HTTP route). The instruction sheet gives the exact on-screen wording at every step: the **Resolutions** tab (and why it is *not* the Review tab, which holds advisory items that can be dismissed); the item *"We could not confirm who owns this investment account."*; the **Answer this** link; the radio list built from the user's own household only and re-checked server-side; the joint-allocation panel; **Save this answer**; and the three distinct confirmation messages, including the one that means something went wrong and should be reported.

It also records what the screen will **never** offer — there is no reveal control for a masked value, because masking is one-way by design and a button that always failed would be worse than its absence — and what the two buttons a user should *not* press actually do.

**Three blockers, found by probing production rather than by assuming the screen would work:**

1. **There is nobody to map the statement to.** `household_members` is **empty**. Every owner-choice screen will correctly say *"There is nothing available to choose from yet."*
2. **No screen in the product adds a household member.** The capability exists as an API (`POST /api/household-members`) and **no page calls it**. A genuine product gap.
3. **The three existing statements are in the OLDER ingestion path**, and the owner-mapping screen reads the newer AI-extraction pipeline's exception records — of which production has **zero**. The older path's own Review screen says, in as many words, that this functionality *"is not yet available"*.

And the obvious workaround does not work either: re-uploading the same PDF is de-duplicated by checksum and returns the existing document unchanged, and **the upload form never sends an owner at all** — which is precisely why all three documents have none.

> **`OA-8` is therefore larger than "the PO must click something".** The
> click-by-click sheet is ready and proven; the prerequisites A1–A3 in its Part A
> must be arranged first. Writing the sheet without Part A would have been the
> more comfortable deliverable and the less honest one.

### 4.2 The fresh production re-baseline

Re-run read-only on 2026-09-16 by `scripts/m12c_pc4_readonly_probe.mjs`, with **two** negative controls (a nonexistent column → `42703`, a nonexistent table → `PGRST205`), so the method can distinguish "absent" from "not looked".

| Measure | Value, 2026-09-16 | M1's value, 2026-09-15 | Match |
|---|---|---|---|
| `ii_portfolio_truth_status` rows | 17 | 17 | exact |
| `status` | `reconciliation_required` ×17 | `reconciliation_required` ×17 | exact |
| `certified_at` non-null | **0** | 0 | exact |
| `unit_variance_within_tolerance` | 12 `true`, 5 `false`, 0 `null` | 12 / 5 / 0 | exact |
| `history_completeness` | `complete_from_inception` ×17 | `complete_from_inception` ×17 | exact |
| The five residuals | −156.618, +111.505, −12.932, −4.457, −2.678 | identical | **5 of 5 reproduce exactly** |
| `blocking_reasons` | `parser_fatal_error` ×17, `unresolved_owner` ×17, `open_blocking_reconciliation_case` ×17, `unit_variance_exceeds_tolerance` ×5, `material_unclassified_transaction` ×1 | identical | exact |
| `ii_source_documents` | 3 rows, **`owner_member_id` NULL on all 3** | (not previously reported) | new |
| `ii_accounts` | 12, **all with no owner recorded** | (not previously reported) | new |
| `household_members` | **0 — nobody has been added yet** | (not previously reported) | new, and it is `OA-8`'s first blocker |
| `ii_document_parse_runs` | 35 rows: 25 `failed`, 10 `succeeded` | (not previously reported) | new, and §7.5 is why it matters |
| `ii_reconciliation_cases` | **127**, all `open`: `owner_unmatched` ×120, `transaction_unclassified` ×4, `document_password_required` ×2, `unsupported_document` ×1 | M1 recorded **126** | **+1, explained** |
| Max `last_evaluated_at` | `2026-09-07T13:07:02Z` | same | **PC4's economic data has not moved** |

**One number moved, and it is accounted for rather than waved past.** `ii_reconciliation_cases` is 127 where M1 recorded 126. The extra is a single `unsupported_document` case, and the parse-run history explains it: three further runs exist against a *different* document (2026-09-13 ×2 and 2026-09-15 ×1), all `failed`. Someone uploaded and tried to process a document after M1's probe. **No economic row moved** — `max last_evaluated_at` is unchanged to the millisecond, and the 17 positions and five residuals are identical.

**A defect in this phase's OWN probe is recorded rather than quietly fixed.** Its first version counted `blocking_reasons` elements directly and rendered every one as the literal `[object Object]` — a single bucket of 57, telling the reader nothing — because those arrays hold `{code, message}` objects, not strings. It also queried `ii_document_parse_runs.status` and `ii_reconciliation_cases.case_type`, **neither of which exists** (`run_status` and `discrepancy_type` are the real names), so both blocks reported `UNAVAILABLE` and simply produced no evidence. All three were found by a second reader, fixed against the migrations rather than by guessing again, and re-run; the table above is the corrected output. **An evidence tool that cannot read its own fields is worse than no tool, because its silence looks like a finding.**

**Nothing else has drifted.** The next phase inherits a baseline it did not have to take on trust.

---

## 5. Section 8.2 — the 251 benign rows


### 5.1 The evidence, and why it is not a hand tally

PC4's Section 3 classified all 251 by hand as 77 boilerplate / 84 non-economic lifecycle markers / 90 regulatory footnotes. M1 correctly refused to act on that: *"the system and the report disagree about the same 251 rows. The analysis says benign; the code says `error`."*

This phase did not repeat the tally. It asked a **structural** question instead, and asked it of the real findings in production.

**The discriminator.** Every transaction-row grammar in `camsParser.ts` — `TXN_ROW_RE`, `ALT_TXN_ROW_RE`, `ALT_FEE_ROW_RE`, `ALT_FEE_ROW_SPLIT_DATE_AMOUNT_RE`, `ALT_TXN_ROW_WRAPPED_START_RE` — is `^`-anchored on a `DD-MMM-YYYY` date, and every economically material row carries a money-shaped amount. So **a line that is not date-led AND money-shaped cannot be a transaction row by that file's own grammar.**

`scripts/m12c_pc4_warning_taxonomy_probe.mjs` applies exactly those two predicates — **character-identical to the shipped classifier's, deliberately, so the evidence and the code cannot drift** — to the 251 real findings. It never prints a source line: every one is reduced in-process to a skeleton in which each digit becomes `9` and each letter run becomes `A`.

**Result, on the real production run `aa8d50fa` (964 transactions, 17 schemes):**

| Structural class | Count | Redacted example |
|---|---|---|
| Leading date **and** money — an economic candidate | **0** | — |
| No digit at all (`*** … ***` lifecycle markers) | 100 | `***A A A A A***` |
| Digits, but no date and no amount | 68 | `A A.A A / A-A A A A 9 …` |
| A bare date, or a bare `<date> To <date>` page stamp | 56 | `9-A-9`, `9-A-9 A 9-A-9` |
| `Page N of M` footers | 14 | `A 9 A 9` |
| A URL or an email address | 8 | — |
| Mid-line-date prose | 5 | — |
| **Total** | **251** | |

> **Zero of 251 are date-led and money-shaped.** Not one is a transaction row.

**The 56 bare-date lines were the one class that could have hidden a real omission** — a bare date is what the leading fragment of a pdf-parse-split transaction row would look like. So they were examined further, by adjacency on `lineHint`:

- 42 are a date and nothing else (≤ 12 characters);
- 14 are `DD-MMM-YYYY To DD-MMM-YYYY` — the per-page tracking stamp `extractMetadata`'s own comment already documents for a since-inception request — and **all 14 are immediately followed by a `Page N of M` footer**;
- **every one of the 56** has either a no-digit marker line or a page footer as an immediate neighbour, and **none carries an amount**.

The first pass of this probe reported **1** economic candidate and **4** money-only lines. Both were artefacts of a money predicate that was too narrow in one direction (`\d{1,3}` on the leading run, which cannot see an ungrouped `3000.00`) and too broad in another (it matched `0.005%` and the version triple `V3.5.1`). **The predicate was corrected in the probe and the parser together**, and the corrected, *more inclusive* predicate returns **0**. That correction is recorded because the first number was wrong, and a report that only showed the second would be hiding how the answer was reached.

### 5.2 The fix, and where it deliberately is not

`classifyUnparsedTableLine()` in `camsParser.ts` assigns severity from the line's own structure at the single emission site:

| Structure | Code | Severity | Why |
|---|---|---|---|
| Leading date **and** money | `unparseable_transaction_row` | **`error`** — **UNCHANGED** | A real unreadable economic row. This is the case the blocker exists for |
| Money, but not date-led | `unparseable_non_transaction_row_with_amount` | `warning` | Not a row by this grammar, but an amount is printed, so it must stay visible. The severity `unclassified_transaction` already uses |
| Page footer / URL / email / bare date stamp | `non_transaction_boilerplate` | `info` | Carries no amount; cannot move a position |
| No digit at all | `non_economic_lifecycle_marker` | `info` | The `*** … ***` marker family |
| Mid-line date or a percentage | `regulatory_footnote` | `info` | Prose |

**`certification.ts` is untouched — not one character.** The chain `registry.ts:112` → `parsed.errors` → `documentProcessing.ts:885` `parserHasFatalError` → `certification.ts:65` `parser_fatal_error` is correct, is pinned by the PC4 regression contract as **PC4-INV-19**, and must stay exactly as strict. The gap was always upstream, in severity assignment, exactly as M1 said.

**Effect on the real document:** `parsed.errors.length` goes from **251 to 0**, which clears `parser_fatal_error` on all 17 positions. It clears **nothing else** — `unresolved_owner` and `open_blocking_reconciliation_case` still block all 17, and §8.1 is why.

### 5.3 Regressions, one per category

`tests/unit/m12cPc4FinancialIntegrity.test.ts`, §8.2 block — 8 tests, of which **7 were observed failing against the pre-change parser**. The eighth is the end-to-end *negative* control, and it passed before the change too — correctly, because the old parser also emitted an `error` for a genuinely unreadable row. A test that goes from green to green is doing its job here; it is recorded as such rather than counted as evidence of the fix:

- `error` is kept for three date-led money-shaped shapes, including a parenthesised negative;
- a money-bearing, non-date-led line is `warning` — never silence, never `info`;
- boilerplate, lifecycle marker and regulatory footnote each have their own test;
- a dotted version stamp and a percentage are **not** mistaken for money;
- **end-to-end**: a statement whose table carries only benign lines yields `parsed.errors === []`, with an anti-vacuity assertion first that at least four benign findings were genuinely produced (so the zero cannot come from the parser having skipped the lines entirely);
- **end-to-end negative control**: a genuinely unreadable date-led money row still yields an `error`. If this ever passes by zero, the downgrade has gone too far.

---

## 6. Section 8.3 — the opening-balance defect `M3-F1`


### 6.1 Confirmed, and the consequence is larger than the discard

M12B established from the code that `OPENING_BALANCE_RE` captures the figure in group 1 and the use site called `.test()` and `continue`d, while the sibling certified `camsFolioStatementParser.ts` `.exec()`s the identical concept. That was right. **The consequence had not been traced, and it is structural.**

`documentProcessing.ts:1158` computes `hasExplicitOpeningBalanceTransaction` by looking for a row carrying `OPENING_BALANCE_SOURCE_REFERENCE`. `:1164` then computes:

```
statementCoversFromInception: !earlierSnapshot && txnInputs.length > 0 && !hasExplicitOpeningBalanceTransaction
```

**Because `camsParser.ts` could never emit that marker, the third conjunct was unconditionally true for every CAS document.** So `determineHistoryCompleteness` always returned `complete_from_inception`, and `reconcilePosition` always summed from a **zero** baseline — regardless of what the statement actually printed. The system inferred "since inception" from the absence of a signal the parser was structurally incapable of producing.

**Proved live, read-only, against PRODUCTION:** `history_completeness = complete_from_inception` and `reconciled_opening_units = 0` on **all 17** of the Product Owner's real positions, without exception.

### 6.2 RED first

`tests/unit/m12cPc4FinancialIntegrity.test.ts` contains an explicit RED-proof test that drives the real `reconcilePosition` with the arithmetic the production residuals are made of and asserts `unitVarianceScaled === -156.618` and `withinTolerance === false`. Against the **pre-change** parser, **9 of the file's 18 tests fail**, including both opening-balance behaviour tests. Two prior-phase tests were also failing correctly and are inverted rather than deleted (§6.5).

### 6.3 The fix shape, exactly

The value is preserved as an **adjustment and nothing else** — the shape FS1 already certified, reusing the shared `openingBalanceMarker.ts` sentinel rather than a second magic string:

| Field | Value | Why |
|---|---|---|
| `canonicalType` | `'adjustment'` | Absent from `taxRepository.ts`'s `ACQUISITION_TYPE_MAP`, so R6's FIFO/tax-lot engine can never consume it as an acquisition. Asserted by reading that map from source, so a future widening breaks the test |
| `amountScaled` | `0` | A position figure is never cash consideration — never an amount-as-transaction |
| `navScaled` | `null` | No NAV is invented |
| `sourceReference` | `OPENING_BALANCE_SOURCE_REFERENCE` | The shared sentinel |
| tax lot / cost basis | **none created** | No code path creates either from an `adjustment` |

Reconciliation may use it, and does: `hasExplicitOpeningBalanceTransaction` becomes true, `determineHistoryCompleteness` returns `complete_from_known_opening_balance`, and the opening contribution reaches `reconcilePosition` **through the transaction stream**, exactly as FS1's does.

### 6.4 Two restrictions that bound the blast radius to the defect

**1. A ZERO opening balance emits nothing at all.** A since-inception CAS prints `Opening Unit Balance: 0.000` for every scheme; emitting 17 no-op rows for those would flip every real position out of `complete_from_inception` and change certified behaviour for the 12 that reconcile to variance `0.000` today. Zero keeps the pre-M12C path **byte-identical**, and a test asserts it.

**2. A NON-ZERO opening balance with no printed date FAILS CLOSED.** This layout's line carries no date, unlike FS1's (`DD-MMM-YYYY Opening Balance <units>`). **No date is invented.** The only date used is the document's own printed `Statement Period : <start> To <end>` start. Where the document prints no labelled period start — which is the case for a real since-inception request, whose range is printed unlabelled and whose leading date `extractMetadata`'s own comment calls a sentinel placeholder — an `error`-severity `opening_balance_not_datable` finding is raised, so the position blocks rather than silently reconciling from a fabricated zero.

**No CAS golden fixture in this repository prints an opening balance at all**, which is why 33 II parser test files / 446 tests pass unchanged: the fix cannot regress a case that does not exist. That absence is itself recorded in `II_FS1_CAMS_FOLIO_STRUCTURE.md`.

### 6.5 Two prior-phase tests, inverted rather than deleted

Both were failing **correctly**, which is the behaviour this fix exists to produce.

- **`tests/unit/m12bIiAiFallbackGapDecision.test.ts`.** M12B wrote its assertion to fail *"the day someone fixes `M3-F1` deterministically ... at that point this test should be updated to record that the defect is closed, and section 7's conclusion — that no AI gap was warranted — is only reinforced."* That day is M12C. The assertion is inverted: the parser must now `.exec()`, must carry the sentinel, and must use `canonicalType: 'adjustment'`. A revert would re-open a discard defect and this test would catch it.
- **`tests/unit/aieM3InvestmentCorpusAccuracy.test.ts`, case C4b.** Pinned the discard and the exact `−200.000` variance it caused. Now pins the preservation and the **zero** variance, plus the adjustment-only field shape. **Its second mechanism is still open and stays pinned**: `OPENING_BALANCE_RE` requires a colon, so a column-aligned label bypasses the pattern entirely. Deliberately **not** widened — relaxing the delimiter to "whitespace" on a value that now feeds reconciliation directly would trade a known bounded gap for an unbounded false-positive surface, and no fixture in this repository prints the colon-less form, so there is no failing real case to justify the risk.

---

## 7. Section 8.4 — the five variances


### 7.1 What was re-run, and in what order

1. **All five re-probed live.** 5 of 5 reproduce exactly (report §4.2).
2. **The opening-balance hypothesis tested first, and REFUTED** — see §7.2. This matters: §8.3's fix is real and necessary, and it explains **none** of the five.
3. **Per-type decomposition and six named hypotheses tested per position** (`scripts/m12c_pc4_residual_attribution_probe.mjs`).
4. **Full source-order replay**, which is what found the mechanism.

### 7.2 The opening-balance hypothesis, refuted by its own control

The obvious reading of §8.3 is that the four negative residuals are the discarded opening balances. It was tested properly and it is **wrong**.

The test: `reconcilePosition` sums from zero when `history_completeness = complete_from_inception`, which production reports for all 17. If a position's **running cumulative unit balance ever goes negative** in source order, it cannot have started from zero — units were redeemed that the reconstructed stream never acquired.

| Result | Count |
|---|---|
| Residual positions whose running balance goes negative | **1 of 5** |
| …whose `|minRunning|` equals the variance exactly | **0 of 5** |
| **Positions at variance `0.000` whose running balance ALSO goes negative** | **1 of 12** |

**The control invalidated the test**, and that is why it was built. A date-ordered query is not physical order, and reversals are pre-signed, so a transient negative excursion is an ordering artefact rather than evidence of a missing opening. M1 anticipated exactly this: a fix *"needs the transactions' true physical parse order, which a date-sorted query cannot supply."*

**A hypothesis that would have been recorded as "confirmed" by a less careful test is recorded here as refuted.**

### 7.3 Kotak `9a923d57`, **+111.505 — FULLY EXPLAINED, row for row**

Per-type decomposition of the 99 persisted rows:

| Type | n | Σ signed delta | Σ raw units |
|---|---|---|---|
| `purchase` | 48 | 690.251 | **467.241** |
| `fee` | 48 | 0.000 | 0.000 |
| `reversal` | 3 | **−111.505** | −111.505 |

Two facts fall straight out:

1. **Σ|units| exceeds Σunits by exactly `2 × 111.505`** for the purchase rows — so three `purchase` rows carry **negative** printed units, and `DIRECTION_TABLE` types `purchase` as an inflow, so `unitDeltaForTransaction` applies `abs()` and flips them to **positive**.
2. **Σ raw units of the purchase rows is `467.241` — exactly the statement's printed closing balance.**

So: reconciled `= 690.251 + (−111.505) = 578.746`; truth `= 467.241`; variance `= +111.505`. And with the duplicate copies removed, `578.746 + (−111.505) = 467.241` exactly. **Both halves confirmed against the live rows:** a direct query returns exactly **3** negative-units rows still typed `purchase`, alongside **3** `reversal` rows for the **same three dates and the same three magnitudes**.

**The same three economic events are persisted twice, under two different classifications.** §7.5 explains how that happened, and it is not a parser bug.

This is pinned in `tests/unit/m12cPc4FinancialIntegrity.test.ts` §8.4 block: the sign flip, the passthrough, the exact `+111.505` reconstruction, **and a control proving that removing the duplicate copies takes the same stream to zero** — so the attribution is shown to be both necessary and sufficient, not merely consistent.

### 7.4 The four negative residuals — narrowed, not closed

| Instrument | Variance | What the replay establishes |
|---|---|---|
| `45773ec3` | **−156.618** | 24 rows, ending 2016. The reversal pairs net to zero and the redemption exactly cancels the first four SIPs — the stream is internally coherent. The shortfall is **missing inflow rows**, not mis-signed ones |
| `948fb23a` | **−12.932** | 8 rows. Four are `unclassified` (four of the run's eight `unclassified_transaction` warnings). A monthly SIP series with **2015-09 absent** |
| `385feb70` | **−4.457** | 8 rows. The same SIP dates as the two above, the same 2015-09 gap |
| `76c30cb9` | **−2.678** | 194 rows. **The variance equals exactly one purchase row's units.** One row of an otherwise perfect weekly/monthly series is missing |

All four are **missing-inflow shortfalls**. Three independent things are now known about them:

- **They are not in the 251 findings.** Zero of those are date-led money rows (§5.1), so the parser did not see-and-fail on them.
- **They are not explained by any of the six hypotheses tested** — reversals double-applied, reversal sign inverted, unclassified mis-signed, a single row, a same-date pair, or a missing opening balance. Each was tested per position and the result is recorded per position, rather than the list being reported in aggregate.
- **Three of the four share identical transaction dates** (2015-08-21, 2015-10-07, 2015-11-09, 2015-12-07, 2016-01-07, 2016-02-08, 2016-03-08) — one SIP mandate across three schemes — and **all three are missing the same month**. A per-scheme parser defect would not produce a gap aligned across three schemes on one date.

**They are not closed, and this report does not claim they are.** Naming the specific missing rows requires the source document, which this phase does not have and may not obtain. What has changed is that they are no longer *unexamined numbers*: each has a replayed history, a tested hypothesis set, and a mechanism (§7.5) that accounts for how correctly-parsed rows can be absent from the database.

### 7.5 `M12C-F1` — the mechanism, and it accounts for all five

The decisive probe was not arithmetic. It was asking **which parse run wrote each row**.

```
ii_transactions by parse_run_id:
  7979970a: 249     <- run_status = FAILED,  transactions_found = 0
  57cec31d: 686        run_status = succeeded, transactions_found = 953
  9de0bb86:  11        run_status = succeeded, transactions_found = 964
  5f78fdda:   3     <- run_status = FAILED,  transactions_found = 0
  92e731ce:   3     <- run_status = FAILED,  transactions_found = 0
  --------------
  total      952
```

And the final, fully-fixed run:

```
  aa8d50fa: 0 rows   run_status = succeeded, transactions_found = 964, schemes = 17
```

Three findings, each independently serious:

**(a) Three runs recorded `failed` with `transactions_found = 0` own 255 transaction rows between them.** A run killed mid-pipeline — the platform execution ceiling this file's own stale-run rescue exists for — has already flushed its bulk transaction inserts. Nothing rolls them back, and the counter that would reveal them is never updated. **The rescue marks the run failed and leaves its writes in place.**

**(b) Those orphans permanently suppress every later run's identical rows.** The fingerprint preload loads `(account_id, transaction_fingerprint)` for the whole document without regard to whether the owning run succeeded, so a later, correct run sees its own rows as already present. The final run `aa8d50fa` found all 964 rows and inserted **zero**.

**(c) `M12C-F2` — a parser FIX defeats its own idempotency.** `computeTransactionFingerprint` includes `transaction_type`. `reclassifyNegativeSignedInflowRows` — PC4's own fix for exactly the Kotak sign defect — retypes a row `purchase → reversal`, which **changes its fingerprint**. The later run's corrected row therefore matches nothing and is inserted **alongside** the stale, wrongly-typed one. That is precisely the state §7.3 measures: three negative `purchase` rows from run `9de0bb86` and three `reversal` rows from run `92e731ce`, for the same three events.

> **PC4's fixes shipped and are correct in the code. The stored data is a frozen
> union of pre-fix and mid-fix runs, and no later run can repair it, because
> every later run deduplicates against the contamination.** That is why the
> residuals survived a parser campaign that demonstrably fixed the underlying
> parsing.

It also settles **`M1-F4`**, M1's open observation that 964 parsed rows became 952 persisted. M1 attributed the 12-row difference, cautiously, to the in-run fingerprint collision guard. That guard is real and does apply, but the larger and previously unseen fact is that **none of the 952 came from the final run at all**.

### 7.6 Why this is not fixed here

The remediation is to rebuild the Product Owner's Investment Intelligence data from a clean re-import. That **deletes real production rows**, and this phase holds no production write authority of any kind. Three narrower code fixes were each considered and each declined, with reasons:

| Candidate | Why not |
|---|---|
| Roll back a failed run's own partial writes | `ii_tax_lots.opening_transaction_id` and `ii_transactions.corrects_transaction_id` are `references` with **no `ON DELETE`**, so the delete can be refused by the database — which would break the stale-run rescue PC4 shipped to fix a real production dead end. A destructive change to a certified path, added autonomously, with a failure mode that reopens a known incident |
| Exclude failed-run rows from the fingerprint preload | Correct in isolation, but on its own it makes the next import insert the correct rows **alongside** the orphans. It is only safe together with the retroactive cleanup, which is the operator action |
| Make the fingerprint type-independent | The right long-term answer to `M12C-F2`, and a redesign of transaction identity — not a narrow fix, and not this phase's remit |

**Raised as `OA-11`** (report §17), with the exact remediation sequence, for a Product-Owner-present phase.

---

## 8. Section 9 — the PC4 reduced synthetic pack


Run against **DEV only**, through the real `processSourceDocument` pipeline, the real CAS and folio-statement parsers, the real reconciliation and certification code, and real Supabase Storage. `scripts/m12c_pc4_synthetic_pack_live_dev.ts`; machine-readable results in `scripts/m12c-pc4-synthetic-pack/`.

**`OA-7` is resolved as the dispatch instructed:** the pack was run, in DEV, and the zero-residue cleanup step 7 depends on now exists and is proved.

| Case | Invariant | Verdict |
|---|---|---|
| **S00** *(additive)* | The out-of-request reconciliation-config fallback is a genuine no-op, so the pack's tolerances are the product's | **PASS** |
| **S01** | A wrong password leaves **zero** partial economic state | **PASS** — and it found a defect, below |
| **S02** | A byte-identical document imported twice creates no duplicated economic rows | **PASS** |
| **S03** | One scheme under two folios → **one** instrument, **two** accounts | **PASS** |
| **S04** | CAS first, then an overlapping folio statement: no economic duplication | **PASS** |
| **S05** | Folio statement first, then an overlapping CAS: no duplication, order-independent | **PASS** — and it found a second defect, below |
| **S06** | A document whose own arithmetic does not close is **blocked**, never certified | **PASS** |
| **S07** | A position contributes to net worth **once**, not once per source document | **PASS** |
| **S08** | Two distinct source documents are never confused for one another (database half) | **PASS** |
| **S09** | User A can never see, process or download user B's document or rows | **PASS** |
| **S10** | Zero-residue cleanup, independently re-queried | **PASS** |

**Every case carries a real anti-vacuity control, and they are the reason the results mean anything.** S01's zero-delta is paired with the *same* counters on the *same* document with the *correct* password, which moves them all by one. S06's block is paired with an arithmetically correct position **in the same import** that does reach `certified` — so it is discrimination, not a blanket block. S07's "exactly one position row" is paired with an unfiltered query returning nine, proving the filter is real and the table is not empty. S09's cross-user refusal is paired with the identical probes pointed at B's own rows and B's own storage object, which return data — **so a leak would have been visible**. S10's zeros are paired with the identical sweep run *before* cleanup, which reported **204 rows across 26 tables and 11 storage objects**.

**Zero residue, proved rather than asserted.** 26 tables re-queried to zero, the globally-scoped `ii_instruments` / `ii_instrument_identifiers` rows this run minted removed, and all 11 uploaded Storage objects gone with an empty remaining-object list.

### 8.1 Two new defects the pack found — which is the most valuable thing it did

> **`M12C-F4` (S01) — a password-required reconciliation case is never resolved
> by a later successful unlock.** After a wrong password, a blocking
> `document_password_required` case is opened. When the **correct** password
> subsequently succeeds and the document parses cleanly, **nothing in
> `processSourceDocument` resolves that case** — so the position parses, and is
> then left `reconciliation_required` with blocking reason
> `open_blocking_reconciliation_case`.
>
> **This is not hypothetical, and it is sitting in production right now.** This
> phase's own re-baseline counts **2 open `document_password_required` cases**,
> both at blocking severity, among 127 that are *all* still `open` — and
> `open_blocking_reconciliation_case` is one of the three blockers on all 17
> positions. **A user who simply typed the right password on their second attempt
> is permanently blocked by the record of their first.**

> **`M12C-F5` (S05) — an FS1-first import silently drops the ISIN the document
> printed.** The folio statement printed a real ISIN in its FINANCIAL
> TRANSACTIONS section, yet the instrument minted from it carries `isin: null`
> and zero identifier rows. `documentProcessing.ts` keys `uniqueSchemes` on
> `(normalisedName|plan|option|amc)` and writes the **transaction** scheme first,
> then **overwrites** it with the **holding** scheme — and
> `camsFolioStatementParser.parseHoldings` deliberately emits
> `buildScheme(name, null)`, because the Summary of Holdings block prints no
> ISIN.
>
> **And the loss is permanent, which the pack went on to prove rather than
> assume.** A later CAS import that *does* print the same ISIN, and that
> resolves to this same instrument by normalised name, **still leaves it
> `isin: null` with zero identifier rows** — because `schemeResolution`'s
> `resolved` branch only *maps* to the existing instrument, and only the
> `unresolved` branch ever writes `ii_instrument_identifiers`. Nothing backfills.
>
> Resolution keeps landing on the right instrument by normalised name plus
> plan/option plus country, **so this is a lost-identifier defect, not a
> duplication defect today** — which is why no existing test caught it. The
> consequence is deferred rather than absent: a future statement carrying **only**
> an ISIN, with no matching scheme name, would mint a **second** instrument for
> the same real fund.

Neither is fixed here. Both are **outside sections 8–16's scope**, both were found by running the system rather than reading it, and both are recorded as new open items (report §17) rather than quietly appended to this phase's work.

---

## 9. Section 10 — the password brute-force gap `M2-OPEN-8`


### 9.1 What was actually exposed, corrected

Prior reports named five surfaces: the old II process route, payslip, retirement, liability and generic investment PDF. **Checked rather than inherited, and the list is shorter: exactly two.** Retirement, liability and generic AU investment statements are **CSV-only pipelines that accept no password parameter at all** — `source_type: 'csv'`, no `password` argument anywhere in their modules. There is nothing to rate-limit there. Reported rather than silently dropped.

The two real surfaces: `processSourceDocument` (Investment Intelligence) and `processPayslipDocument`. Both handed a user-supplied password straight to the PDF extractor with **no counting of any kind**, while the FDH-5 bank-PDF path and the AIE unlock endpoint — the same extractor, the same threat — had been limited for some time.

### 9.2 The fix, against each of the dispatch's four requirements

| Requirement | How it is met |
|---|---|
| **Use the SHARED limiter, not multiple counters** | Both call sites import `checkPasswordAttemptRateLimit` from `lib/financial-data-hub/bank-pdf/password.ts` unchanged. A test asserts both files import it **and** that neither hard-codes an attempt-count comparison of its own |
| **Use the existing certified threshold** | `MAX_PASSWORD_ATTEMPTS_PER_DOCUMENT_PER_HOUR`, imported. No new constant, no new policy, no PO decision needed |
| **Record the attempt BEFORE decryption** | II: the record is the parse-run row's **existing** `password_supplied` column, written at `insert` — which is before `extractPdfText` is ever reached. **No migration.** Payslip: a `pdf_password_required` audit event, written before `extractPdfPages`. Both orderings are asserted by source position, so a future edit cannot silently reverse them |
| **Cross-user isolation** | Enforced by the counting query itself: `.eq('source_document_id', …).eq('user_id', …)`. Asserted |

Two further properties, both asserted:

- **The password VALUE is never counted, stored or logged.** The only thing derived from it in the entire limiter block is a boolean. Migration `0039`'s own comment already required this of `password_supplied` (*"only whether one was required/supplied, never the value"*); the fix stays inside it.
- **A refused attempt does not itself consume a slot** — the check runs before the run row is created, mirroring FDH-5, where the refusal throws before the audit write.

One deliberate difference from the FDH-5 call site, and it is **stricter**: FDH-5 gates on `document.error_code === 'password_required'`, so a guess against a document not yet flagged is uncounted. Both new gates trigger on a password having actually been **supplied**, which counts every guess. Behaviour when no password is supplied is unchanged in every respect.

Both routes answer **429**, matching the bank-PDF and AIE unlock routes exactly.

### 9.3 Tests

`tests/unit/m12cPasswordLimiterAndDocumentIdentity.test.ts`, §10 block — **8 of the file's 17 tests were observed failing against the pre-change code.** Covering: one threshold and one window in the product; repeated wrong passwords allowed below the ceiling and refused at it; the rolling-hour reset, **including the 59-minute boundary so it is a real boundary and not an off-by-one**; cross-user isolation in the query; record-before-decrypt on both paths; 429 on both routes; and the password value never reaching a counter or a metadata field.

---

## 10. Section 11 — wrong-document / shared storage path `CG-10`


### 10.1 The trace, end to end

The dispatch asks for `UI id → route id → source document id → storage object → parse run`. All five links were followed.

| Link | Finding |
|---|---|
| UI → route | `InvestmentIntelligenceClient.tsx` renders the Process button per row and calls `handleProcess(doc.id)`; the password box is keyed `passwordInputs[doc.id]`. **The correct row id is passed in every case** |
| route → document | The route forwards `[id]` unchanged; `processSourceDocument` resolves it with `.eq('id', sourceDocumentId).eq('user_id', userId)` — ownership enforced by the query itself |
| document → storage | `storage_path` is read **off the already-identified row**, purely to fetch bytes |
| document → parse run | **Every** parse-run lookup is keyed on `source_document_id`. `ii_document_parse_runs` **has no `storage_path` column at all**, links by foreign key to `ii_source_documents(id)`, and its one-active-run unique index is keyed on the document id |

> **There is no storage-path-keyed lookup anywhere in the processing chain.** The
> immutable id is already authoritative there. `CG-10`'s symptom is produced
> elsewhere, and both real causes are now fixed.

### 10.2 Cause (a) — the one storage-path-keyed ROW lookup in the codebase

`findExistingManualImportByFixtureKey` (`manualImporter.ts`) looked a row up by `storage_path` using `.maybeSingle()`. `ii_source_documents` has **no unique index on `storage_path`** — only `(user_id, checksum)` and the primary key — so two rows can legitimately share one. When they do, `.maybeSingle()` returns an **error** and `data === null`, and the error was discarded: the function reported *"no prior submission"* for a fixture key that demonstrably had one, minting a duplicate chain instead of replaying the first. Now ordered by `created_at` then `id`, with `limit(1)`, so a collision resolves deterministically instead of failing open.

A repo-wide test asserts this is the **only** `storage_path`-keyed lookup under `lib/services/investment-intelligence`, by listing it explicitly rather than allowing "zero or more" — so a new one cannot appear unnoticed.

### 10.3 Cause (b) — the silent re-upload substitution

The upload route answers a byte-identical re-upload with the **first** document's id and `deduplicated: true`. The client read `json.data.id` and **ignored the flag**, silently switching the user onto the existing document while they believed they had created a second one. That is exactly how "the Process button acted on the wrong document" is produced with no wrong-document lookup existing anywhere. The client now says so, in a `role="status" aria-live="polite"` notice — a notice, not an error, because nothing failed.

### 10.4 The named regressions

`tests/unit/m12cPasswordLimiterAndDocumentIdentity.test.ts`, §11 block — static assertions plus a **behavioural reproduction** driving the real `processSourceDocument` control flow against a faked Supabase client, with two documents deliberately sharing one `storage_path`:

- **A processes A, B processes B** — each run's `source_document_id` is the document that was asked for, and the two runs are distinct;
- **password A is never carried into B's attempt** — the extractor receives `['pw-A', 'pw-B']` in order. The test also asserts both attempts read the **same object**, which is the honest statement of what a shared path means and exactly why the path is not identity;
- **cross-user**: another user's document is `not_found` and **nothing is even downloaded**;
- **run A belongs to A, run B belongs to B** — asserted on the run rows, with an anti-vacuity check that runs were created at all.

On "password A cannot unlock B": there is **no stored password and no per-document credential check anywhere** in this path — the password is passed straight to the extractor for the bytes the row's own `storage_path` resolves to. The test proves that absence directly (`password_hash`, `stored_password`, `expected_password`, `comparePassword` all absent), because asserting the absence is the honest form of the claim.

The fake mirrors both harness traps recorded by earlier phases: shared state lives on `globalThis` (a `vi.mock` factory is instantiated once per importer graph), and the fake mirrors what the code actually calls.

---

## 11. Section 12 — AIE state-machine cleanup


Three narrow additions. **No working state machine was rewritten.**

### 11.1 `M2-OPEN-1` — accept/reject wrote no FSM audit at all

`accept.ts` moved run status through `transitionRunStatusCas` at **ten** call sites and `reject.ts` at one, and **not one of them wrote a row to `aie_processing_transition`**. The one audit that existed went to `aie_audit_event`, a different and coarser table. So the FSM audit table had no record of any accept or reject edge — the two edges a human actually commands.

The repository already contained the intended partner, `recordRunTransitionAudit`, and two call sites already paired it with the CAS (`review/revalidate.ts`, `pc5/reReconciliation.ts`). Both files now do the same, through a **single choke point**, so an audit row is written only when the CAS genuinely succeeded — a transition that did not happen is never audited.

**`lib/aie/db/repository.ts` was deliberately NOT modified.** Making `transitionRunStatusCas` write the audit itself was the tempting rewrite and would have silently changed the two existing call sites that already pair them explicitly.

Actor attribution is argued in code rather than assumed: `'user'` for `awaiting_acceptance → accepted` and the reject edge — the only two a human commands — and `'system'` for every other edge, because no user can command "begin the canonical write". Reasons are fixed internal codes, never `params.rationale` (AUD-09), pinned by a test. Three **distinct** replay reasons exist so an outer-batch replay, an adapter-reported `already_written` and the FDH-bank prior-write guard can never be confused with one another.

**No migration.** `aie_processing_transition.from_state` and `to_state` are unconstrained `text`; the table's only CHECK is on `actor_type`, which already permits `'user'` and `'system'`. Read from migration `0140` and **asserted mechanically** in the new contract test, rather than assumed.

**RED first:** 10 failures in accept, 3 in reject, including `expected [] to deeply equal [ { runId: 'run-1', … }, …(2) ]` and `expected [] to have a length of 3 but got +0`.

### 11.2 `M2-OPEN-2` — `purge_status` had no validator, and a real defect was behind it

`purge_status` had no transition table and no validator anywhere, and its five-value vocabulary was duplicated as an inline literal union inside a non-exported interface. It now has a real third machine alongside the intake and run machines, with the vocabulary given a TypeScript home it did not have.

**The RED was not merely a missing export.** The most important failure proved a defect in shipped code:

```
> finalizeDocumentBinaryAfterRun can NEVER resurrect an already-purged row
AssertionError: expected 'pending' to be 'purged'
```

**A row already `purged` was genuinely re-marked `pending`** by the retry path, which wrote with no from-state check at all. `purged` is meant to be terminal; it was not.

Every declared edge is one the shipped code actually takes — including `not_required → purged`, AIE's **primary** immediate-deletion path, which FDH's otherwise-similar table forbids. That divergence is exactly why FDH's implementation was **mirrored in shape and not imported**: FDH also has a sixth status AIE's CHECK does not permit. Two edges are deliberately **absent**: `not_required → in_progress` (a purge attempt on a row nobody scheduled is refused — a real safety property) and `* → failed` from anything but `in_progress` (a failure verdict can only come from an attempt that was in flight).

**Enforcement is split deliberately, and the reason is operational.** Where the from-state is statically known, an illegal transition **throws**. Where it comes from untyped DB `text` — inside `runPurgeAttempt` and the backstop loop — it **refuses without throwing**, because `app/api/aie/cron/purge-sweep/route.ts` has no per-row `try`/`catch`: throwing on one corrupt row would abort the entire sweep and return a 500. Refusing one row and continuing is the safer behaviour for a retention backstop, and the sweep's own `scanned > forcedPurgeCount` is the signal.

A CAS was added only where it is safe: the retry path gained `.neq('purge_status', 'purged')`, which enforces the machine atomically without a TOCTOU read, and now returns the existing `already_deleted` outcome rather than falsely claiming a retry was scheduled. `runPurgeAttempt`'s `→ in_progress` write is **validated only, not CAS'd**, because a CAS would also fail on a legitimate concurrent sweep and would change the bounded-retry semantics two existing suites pin.

### 11.3 `M2-OPEN-3` — `'ready'`, and why it maps to `processing`

`computeUserFacingStateForIntakeWithoutRun` declared an inline **five**-member parameter union while `AieIntakeStatus` has **six**; `'ready'` fell to the exhaustiveness `default:` and threw.

**`'ready'` is the intake's ADMISSION verdict** — "these bytes were accepted for processing" — **not a review verdict about extracted content.** Reaching this function means no run exists, so there are no candidates, no reconciliation outcome and nothing to accept.

- `ready_to_accept` is wrong in the **dangerous** direction: it invites importing a document nothing has extracted or reconciled. The near-collision between the DB value `ready` and the UI value `ready_to_accept` is the most likely reason this was overlooked.
- `unable_to_process_safely` is wrong in the **opposite** direction: nothing failed. A false negative pushing the user to re-upload something still in flight.
- `processing` is honest, and from the user's side indistinguishable from `received`/`quarantined` — which is why it maps with them. A genuinely stuck row keeps reporting `processing` until the 24-hour backstop purges it, the same mechanism that already resolves a row stuck in the other two.

**The test file looped `AIE_RUN_STATUSES` but not `AIE_INTAKE_STATUSES`. That omission is precisely why this survived**, and the missing exhaustive loop is now added, so a seventh status cannot slip through again. The throw was **latent, not live** — the function has zero production callers — and that is stated rather than the severity being inflated.

### 11.4 Live proof — what was obtained, and what was not

> **No live database proof was obtained for this section, and none is claimed.**
> This phase's DEV access was used for the synthetic pack and the accessibility pass; section 12's implementer had none and
> did not seek any. Migration `0149`, which introduces `purge_status`, states in
> its own header that it is **not applied anywhere**.
>
> **The substitute is named as a substitute:** a migration-CHECK ↔
> TypeScript-constant contract test that reads `0140` and `0149` from disk and
> asserts the CHECK's value list equals `AIE_PURGE_STATUSES` exactly, and that
> `aie_processing_transition` has exactly one CHECK and it is not on
> `from_state`/`to_state`. That is the idiom `fdh1SchemaContract.test.ts`
> already uses. It proves the code and the schema agree; it does not prove the
> schema is deployed.

**Two files outside the implementation boundary were touched and are disclosed:** `aie16CertificationAdversarial.test.ts` and `aieReviewE2eInsuranceJourney.test.ts` construct `AcceptRunDeps` inline and stopped typechecking the moment the new dep became required. The minimal additive fix was made, plus one meaningful assertion in each, rather than leaving `tsc` broken.

**GREEN:** 10 touched suites, 147 tests passing at the time of that work; re-verified at 189 tests across the combined §12/§14/§15 suites after all three landed.

## 12. Section 13 — the server-only secret boundary `M2-OPEN-4`


### 12.1 What was actually true before

There was **no `import 'server-only'` anywhere in this repository** — not in `lib/aie`, not anywhere else, so there was no precedent to copy. No lint rule. No test. The secrets stayed out of the client bundle because nobody had yet written the import that would put them there. That held, and "nobody has done it yet" is not an enforcement.

Three AIE modules read a secret directly: `provider/providerFactory.ts` and `provider/openaiAieProvider.ts` (`AIE_OPENAI_API_KEY`), and `masking/identifierToken.ts` (`AIE_MASK_TOKEN_ENCRYPTION_KEY`, the HMAC master secret). Eleven further modules reach `SUPABASE_SERVICE_ROLE_KEY` transitively through `lib/supabase/admin.ts`.

### 12.2 What is enforced now, and what is not — stated precisely

`lib/serverOnly.ts` is imported by all three secret-reading modules, and `tests/unit/m12cServerOnlySecretBoundary.test.ts` (11 tests) proves:

- **the property that actually matters** — a walk of the **value-import graph** from every `'use client'` component shows none can reach a secret-reading module, even transitively. The distinction between value and type imports is load-bearing: the two AIE modules a client component does import today terminate in type-only imports, which are erased at compile time, and that is precisely why the boundary holds;
- no secret has a `NEXT_PUBLIC_` twin, in source **or** in the declared environment files;
- no `NEXT_PUBLIC_AIE_*` exists anywhere;
- no `'use client'` file names a secret at all;
- the secret-reading allowlist is **exhaustive** — no other file under `lib/aie` reads one;
- every `AIE_*` name the code reads is declared in `.env.example`, and none has a value there.

Each carries an anti-vacuity assertion, so an empty offender list means "none found", not "nothing was scanned".

> **What this is NOT.** The canonical `server-only` npm package makes bundling
> into a client graph a **BUILD-TIME** error via a `react-server` export
> condition — strictly stronger, and the right destination. It is **not
> installed** (absent from `package.json`, `package-lock.json` and
> `node_modules`), and adding a dependency is a lockfile change this DEV-only
> phase did not make. `lib/serverOnly.ts` says so in its own header, and the
> swap is a one-line change because every call site already points there. **This
> section is CONDITIONAL for that reason and no other.** No static analysis here
> inspected a compiled `.next/static` chunk; it proves the properties from which
> that conclusion follows, and says so rather than implying more.

### 12.3 `M12C-F3` — the documentation was itself wrong

`.env.example` and `ENVIRONMENT_VARIABLES.md` had **not one `AIE_*` variable** between them, though two are genuine secrets. Both now carry a full AIE section — **names only, no value anywhere** — and a test fails if the code ever reads an `AIE_*` name `.env.example` does not declare, so there is one place to keep current and forgetting it is a test failure rather than a silent gap.

While writing it, a second defect surfaced. `ENVIRONMENT_VARIABLES.md` quoted `amplify.yml`'s env-forward `grep` as:

```
env | grep -e SUPABASE_SERVICE_ROLE_KEY -e CRON_SECRET -e APP_BASE_URL -e RESEND_API_KEY -e CONTACT_FROM_EMAIL >> .env.production
```

The real line has since gained six more entries, including **`-e ROLLOUT_` and `-e AIE_`**. The document was therefore the source of a misleading "known gap": a reader would have concluded that AIE configuration — including both secrets — **could not reach the runtime at all**. Corrected, and pinned by a test that compares the quotation against `amplify.yml` itself, so it cannot drift again. The surrounding warning is kept, because its underlying point — that the list is hand-maintained and forgetting a new name has no failure mode — is still true; only its specific claim was stale.

**A first draft of the AIE variable list was written from memory and was wrong** — six invented or mis-spelled names, several real ones missing. It was corrected against a repo-wide scan of `process.env.AIE_*`, and the drift-proof test exists precisely because that mistake was easy to make.

---

## 13. Section 14 — the cost accounting retry gap `M2-OPEN-5`


*(Implemented and verified; see the summary below.)*

The gap was structural rather than a single overwrite. `openaiAieProvider.generateStructured` declares its usage variables **inside** the retry loop, and its three `continue` statements skip the body parse entirely — so a 429 or 5xx attempt's `usage` was never read, and only the returning iteration contributed. Worse, on exhaustion the provider **throws**, and `gateway.ts` settled a hard-coded `0, 0` — **an all-attempts-fail sequence settled ZERO tokens after up to three real HTTP requests.**

The fix hoists a cumulative accumulator outside the loop, mirroring how `lastError` is already hoisted; reads `usage` defensively off retried 429/5xx bodies and terminal 4xx bodies, never letting a parse failure of an error body break the retry; carries the accumulated usage on the thrown error so the gateway's catch path can settle it; and reports cumulative totals on every exit path while adding explicit final-attempt fields so nothing that needed the last attempt's numbers changed silently.

**Deliberate non-changes, each with a reason recorded in code:** the shared `ProviderError` class (Module 11's, used by an unrelated gateway) is untouched — usage rides as a non-enumerable own property read by AIE-local helpers, and an error from any other source reads back `null` and settles zero exactly as before; the provider still throws rather than returning, because converting it would have broken `mapProviderErrorToOutcome` and four existing adapter tests for no gain; and **no second idempotency mechanism was added in TypeScript** — "never double-settle" is enforced in SQL by `aie_ai_cost_attempt.idempotency_key` and migration `0152`'s `v_already_settled` guard, and the TypeScript test says exactly that rather than implying it proved more.

Fail-closed admission is preserved exactly: a refused reservation still short-circuits before any provider call, with no `recordAttempt` and no settle.

**Observed RED then GREEN.** With the accumulator reverted: `9 failed | 21 passed`, including `expected 100 to be 170`, `expected 100 to be 161`, `expected 100 to be 231` and — the defect itself — `expected +0 to be 210`. Restored: 17/17 in the new suite, 53/53 across the four AIE provider/cost files, and the real-Postgres PGlite idempotency proof goes from 5 to 6 passing cases.

**Honest limit:** `AIE_OPENAI_API_KEY` was never read, so whether OpenAI actually populates `usage` on a 429 or 5xx body is **not proved here**. The implementation treats it as opportunistic and the module header says so.

---

## 14. Section 15 — multiline address masking `M3-OPEN-2`


The rule now captures the label line plus **at most three** continuation lines, each capped at 120 characters, stopping at the first of nine guards: a blank line; a line already carrying `[MASKED:`; a recognised label term at line start, **with or without a colon** (reusing this file's own in-module `FORBIDDEN_LABEL_TERMS` plus financial vocabulary, with no new cross-module import); a generic `Label:` shape; a pipe or tab; a rule line; three or more whitespace columns; a money-shaped line; a date-led line.

**No unbounded newline regex**, and the whole mechanism lives inside the existing `pattern` / `valueGroup` fields — so `maskText` and `firstResidualPiiType`, which read only those two fields, **cannot desynchronise**. That is the `M12B-F2` failure mode, designed out by construction rather than by discipline, and a test loops all 16 inputs asserting the guard and the masker agree on every one.

**Counting decision, taken and documented:** a wrapped address counts as **one** `address_label` and yields **one** token, not one per line — `coverage_by_type` answers *"how many identifiers did this document contain?"*, and a household with one address printed over four lines does not have four addresses.

**RED observed first**: 8 failed / 6 passed, with line 2 of a wrapped address (`Indiranagar, Bengaluru 560038`) egressing verbatim. After: 18/18.

**A second, unplanned RED is worth recording** because the way it failed is not obvious. The first date-led guard was `\d{1,2}\s+(jan|feb|mar|…)` and, because the rule runs `/i`, it matched `12 Mar` **inside `12 Marigold Avenue`** — killing the capture on line 2 of the four-line case. It went red, then *differently* red, then green. That near-miss is now pinned by its own test: a month-prefixed street name is not a date, but `31 March 2027` is.

**Named residual limits, disclosed rather than hidden:** addresses of five or more lines still egress from line five; a continuation line genuinely beginning with a stop term under-captures (two known imperfect terms — `mobile` as in Mobile, Alabama, and `pan` as in Pan Bazaar — are kept and documented in place); **unlabelled** addresses are still not matched at all, unchanged; and lone-`\r` line endings are not handled. Performance was measured on adversarial input — 90k–240k characters mask in 2–11 ms with no catastrophic backtracking — and pinned by a loose regression test.

The malicious-block case asserts an **exact** bound: of a 200-line block, exactly three continuation lines are consumed, `LINE-0004` survives, and `matchAll(/LINE-\d{4}/g)` returns exactly 197.

---

## 15. Section 16 — PC5 accessibility (`M5-OPEN-1`)


**Automated axe genuinely ran**, against the real rendered DOM of the real app connected to real DEV data, using `@axe-core/playwright` with `wcag2a` + `wcag2aa` tags. `scripts/m12c_pc5_accessibility_live_dev.ts`; results in `scripts/m12c-pc5-accessibility/`.

| State | Reached | axe rules passed | Violations (critical / serious / moderate / minor) |
|---|---|---|---|
| Resolution centre (listing, blocking items outstanding) | yes | 24 | **0** (0/0/0/0) |
| Owner choice (radio group of household members) | yes | 26 | **0** |
| Joint allocation editor (percentage split) | yes | 26 | **0** |
| Duplicate decision | yes | 26 | **0** |
| Correction overlay | yes | 26 | **0** |
| Blocking-unresolved state (dismissal refused) | yes | 26 | **0** |
| Resolved state (history view) | yes | 24 | **0** |

**All seven states named by the dispatch were reached and scanned. None was skipped, and none is reported as a pass without having been measured.**

**The zero is not taken on trust, twice over.** Every reached state reports a **non-zero** count of axe rules that *passed*, and each asserted a state-specific element was on screen before scanning — a state with zero passing rules would be recorded as NOT MEASURED, not as a pass. And separately, a **harness negative control** injected deliberately broken markup and confirmed axe reported **2** violations (`image-alt`, `label`), then confirmed they disappeared when the markup was removed. **The scanner is demonstrably capable of failing.**

One `incomplete` result (`color-contrast`) is reported as incomplete rather than folded into either column.

### 15.1 The manual keyboard test — all six items exercised

Driven with real key presses and real assertions on `document.activeElement`, live-region text and label association — **not by reading code**.

| Item | Result | Evidence |
|---|---|---|
| Focus order | **PASS** | 37 tab stops, DOM-order monotonic, reaches **Save this answer** |
| Radio groups | **PASS** | `ArrowDown` moved both focus **and** selection within the group |
| Labels | **PASS** | every control inspected has a programmatic accessible name; zero without |
| Error announcements | **PASS** | a **real API failure** surfaced in `role="alert"` |
| Loading announcements | **PASS** | `role="status" aria-live="polite"` announced the load transition |
| Save announcements | **PASS** | `role="status"` announced the post-save confirmation |

### 15.2 Screen-reader testing — NOT AVAILABLE, and not claimed

> No screen reader (NVDA / JAWS / VoiceOver / Orca) is installed or drivable in
> this environment. **No manual screen-reader pass was performed and none is
> claimed.** The ARIA live-region behaviour above was verified
> *programmatically* — role and `aria-live` attributes and their rendered text —
> which is **not** the same as verifying what a screen reader actually
> announces. The dispatch permits this gap to remain open provided automated axe
> actually runs. It did.

**Zero-residue cleanup** of every seeded PC5 row was performed and re-queried.

## 16. Verification of the carried-forward state


### 16.1 The 16 prior documents

Inherited by branching from `48e053d` rather than copied, so they are the same git objects and cannot have drifted. Verified by diffing the full `docs/investment-intelligence/` listing against M12B's own worktree: **identical file sets, with exactly one addition — this document.** The 16 mission documents M12B enumerated are all present. With this one: **17**.

### 16.2 Migration numbering — re-verified fresh, with both controls

Not inherited from M12B's finding. Re-derived, file-level, across **every ref in the repository** (`git log --all --diff-filter=A` over `supabase/migrations/`):

| Number | Owner |
|---|---|
| 0153 / 0154 / 0155 / 0157 | this mission's own lineage (PC5, HUF, PC6, PC7) |
| 0156 / 0158 | `fix/app-review-findings-2026-09-15` — unrelated |
| **0159** | **free** |

- **Negative control:** a search for any migration numbered `0159` or above, on any ref, returns **nothing** — so the method can distinguish "free" from "not looked".
- **Positive control:** the same method finds `0158`, so a non-empty answer is reachable.

> **This phase created no migration and applied none, anywhere.** §8.2, §8.3, §10, §11 and §12 each state, with the DDL read rather than assumed, why none was needed. **The next genuinely free number remains `0159`.**

### 16.3 Production and regression state

| Check | Result |
|---|---|
| `origin/main` | **`23b49da1d63c9c20f980ea9042e176845b6f60e3`** — unchanged |
| Pushed | **nothing.** The branch has no upstream configured at all |
| Merged | **nothing** |
| Production database — **writes** | **zero.** Not one `POST`, `PATCH`, `DELETE`, RPC, DDL or DML. Every production probe is `GET`-only and carries a paired negative control |
| Production database — **reads** | read-only probes, as M1 and M11 did, for report §4.2, §5.1 and §7 |
| Production configuration / deployment / rollout | **untouched** |
| Migrations applied or created | **0** |
| Secrets provisioned in any persisted config | **0.** No `.env.local` exists in this worktree; credentials are sourced into a process from the shared file and never written, printed or committed |
| Outbound provider calls | **0** |
| `tsc --noEmit` | **clean** |
| Full unit suite | **20 files / 42 tests failing.** Three of those files pass standalone immediately afterwards (`m12bInsuranceAccuracyCorpus`, `paymentProviderActivation`, `paymentsCheckoutRoute`) — each contributing exactly one failure, each a 5-second **timeout under concurrent load**, not an assertion. That leaves **17 files / 39 tests — file-for-file and test-for-test identical to the documented pre-existing baseline. Zero new failures.** 7,516 tests passing |

**Two real regressions were introduced by this phase, found by the FULL suite and fixed.** Both were out-of-date test fakes, not broken behaviour: `m12aFdhBankAccuracyCorpus` and `m12aFdhBankIntakeGate` drive the **real** `createDefaultAcceptRunDeps()` against a fake Supabase admin client that knew only `upsert`, so §12's new `recordRunTransitionAudit` insert died with `admin.from(...).insert is not a function` on every case reaching acceptance — 7 corpus cases and both gate tests. **Neither was visible to the targeted runs each item used**, which is the argument for running the whole suite before claiming a verdict. After the fix M12A's corpus metrics are **byte-identical** to what M12A committed, and the gate test now additionally asserts the exact three-edge FSM audit trail and its actor attribution.

**Two certification artefacts were restored, and the reason is worth recording.** `scripts/m12a-fdh-bank-certification/results.json` and `results_table.md` are regenerated by M12A's corpus test, so a run of a *subset* of that suite rewrote them with only the cases that ran — silently deleting seven of the twelve rows and the `ALL 12` summary. They were restored to their committed state with `git checkout`, and M12A's metrics are byte-identical to what M12A committed. The same happened to two `generatedAt` timestamps in the R5 and R6-P1 comparison reports; also restored. **A self-regenerating evidence file is only trustworthy when the whole suite runs**, which is worth knowing before the next phase runs a filtered subset.

## 17. Open items


New items first, then inherited ones re-confirmed rather than restated from memory.

| Id | Item | Owner | Detail |
|---|---|---|---|
| **`OA-11`** *(new, and the most consequential)* | **Rebuild the Product Owner's Investment Intelligence data from a clean re-import.** Production `ii_transactions` is a union of rows from five parse runs, three of them `failed`, and the final fixed run contributed none of them | **Product Owner / operator** | This is the remediation `M12C-F1` and `M12C-F2` imply, and it **deletes real production rows**, which no autonomous phase may do. The sequence: (1) confirm the five residuals still reproduce; (2) delete the document's `ii_transactions`, `ii_transaction_source_links`, `ii_holding_snapshots` and `ii_reconciliation_cases` rows, in that dependency order, after checking `ii_tax_lots.opening_transaction_id` and `ii_transactions.corrects_transaction_id` for references that would block the delete; (3) re-process the document on the M12C parser; (4) re-probe. §8.2's and §8.3's fixes only reach the data through step (3) |
| **`M12C-O1`** *(new)* | **A failed parse run's partial writes are never rolled back**, and its `transactions_found` counter stays `0`, so the orphans are invisible to anyone reading the run | engineering, after `OA-11` | Three candidate fixes were each considered and declined with reasons (§7.6). The narrow one — excluding failed-run rows from the fingerprint preload — is only safe *after* `OA-11`, because on its own it would insert correct rows alongside the orphans |
| **`M12C-O2`** *(new)* | **A parser reclassification defeats its own idempotency**: `computeTransactionFingerprint` includes `transaction_type`, so retyping a row changes its fingerprint and the corrected row is inserted alongside the stale one | engineering / architecture | The right answer is a type-independent transaction identity, which is a redesign, not a narrow fix. Recorded so the next parser fix that retypes rows does not silently repeat this |
| **`M12C-O3`** *(new)* | **`OPENING_BALANCE_RE` still requires a colon**, so a column-aligned `Opening Unit Balance   200.000` bypasses the pattern entirely | disclosed, deliberately not fixed | M3 predicted this and it is still true. Relaxing the delimiter to "whitespace" on a value that now feeds reconciliation directly would trade a known bounded gap for an unbounded false-positive surface, and no fixture prints the colon-less form, so there is no failing real case to justify the risk. Pinned by a test |
| **`M12C-O4`** *(new)* | **The canonical `server-only` package is not installed**, so §13's boundary is a graph-walk test plus a runtime guard, not a build-time failure | engineering, one line | `lib/serverOnly.ts`'s body becomes `import 'server-only';` and every call site already points there. Needs `npm install server-only` — a lockfile change this DEV-only phase did not make |
| **`M12C-O5`** *(new)* | **Multi-line address masking has four named residual limits**: 5+ line addresses egress from line five; two imperfect stop terms (`mobile`, `pan`) can under-capture a continuation line that legitimately starts with them; **unlabelled** addresses are still not matched at all; lone-`\r` line endings are unhandled | disclosed | All four documented in `piiMasking.ts` itself, not only here |
| **`M12C-O6`** *(new)* | **Whether OpenAI populates `usage` on a 429 or 5xx body is unproved.** §14 reads it opportunistically | PO, with `M12B-O2` | Provable only with a real provider call, which needs the PO's own authorisation for outbound spend |
| **`OA-8`** *(inherited, re-confirmed live)* | **Map the CAMS statement to a household member in the app.** `owner_member_id` is NULL on **all 3** production source documents; `unresolved_owner` blocks all 17 positions | **Product Owner**, in the app | §8.1 gives the click-by-click instructions. Not performable by any agent — it requires the PO's own account |
| **`OA-9`** *(inherited)* | Decide the severity taxonomy for the 251 findings | **CLOSED by §8.2** | Decided on structural evidence rather than on a tally, at the parser, with `certification.ts` untouched |
| **`OA-7`** *(inherited)* | Decide closure step 6 — run the reduced synthetic pack, or drop it | **CLOSED** | The dispatch resolved the decision half by instructing a DEV run; the pack ran 11 of 11 with the zero-residue cleanup step 7 depends on, which did not previously exist |
| **`OA-10` / `M3-F1`** *(inherited)* | The CAS discarded opening balance | **CLOSED by §8.3** | Confirmed against production, fixed, RED observed first |
| **`OA-1`** *(inherited, unchanged)* | PC4's ≥48-section specification does not exist in the repository or on the PO's filesystem, so a "Section 47/48 terminal verdict" cannot honestly be issued | **Product Owner** | Unchanged by this phase. Not re-searched — M0's search was exhaustive and nothing new surfaced |
| **`OA-6`** *(inherited)* | `AIE_MASK_TOKEN_ENCRYPTION_KEY` unset | **PO / operator** | Not this phase's to provision, and it was not |
| **`M12B-O1`** *(inherited)* | The **folio** masking rule has the same latent line-crossing gap M12B fixed in the person and address rules | disclosed | §15 did not change it. It misfires on no fixture, and it is on Investment Intelligence's certified path |
| **`M12B-O2`** *(inherited)* | The real-provider **response** path is uncertified for both adapters | PO | Unchanged |
| **`M12B-O3`** / **`M12B-O4`** / **`M12B-O5`** / **`M12B-O6`** *(inherited)* | Insurance non-ISO renewal-date blocking; adapter flags OFF everywhere; only the bounded generic `Label: Value` layout certified; no OCR | PO / operator / disclosed | Unchanged |
| **`M12C-F4`** *(new defect, report §8.1)* | **A `document_password_required` case is never resolved when the correct password later succeeds** — the position parses and is then blocked by the record of the earlier failure. **2 such cases are open in production now** | engineering | Found by S01. Not fixed: outside §§8–16's scope, and it would change certified behaviour on a path PC4 shipped |
| **`M12C-F5`** *(new defect, report §8.1)* | **An FS1-first import permanently drops the ISIN the document printed** — the holding scheme (no ISIN) overwrites the transaction scheme (ISIN present), and **nothing backfills it**: `schemeResolution`'s `resolved` branch only maps, while only its `unresolved` branch writes identifiers | engineering | Found by S05. A lost-identifier defect, **not** a duplication defect *today* — which is why nothing caught it. The consequence is deferred: a future ISIN-only statement would mint a **second** instrument for the same real fund |
| **`M12C-O8`** *(new)* | **`household_members` is empty in production and no screen in the product creates one** — the API exists with no UI consumer. The II upload form never sends an owner either | **Product Owner / engineering** | Blocker 1 and the root cause of `OA-8`. See the operator sheet's Part A |
| **`M12C-O9`** *(new)* | **The PC5 resolution screen projects `aie_unresolved_item` only, and production has zero rows in the entire AIE pipeline.** The 120 open `owner_unmatched` cases live in the legacy `ii_reconciliation_cases`, whose own Review screen says the functionality *"is not yet available"* | **Product Owner / engineering** | Blocker 3. The two pipelines' exception stores are not bridged |
| **`M12C-O10`** *(new, minor)* | **"Show resolved history" alone shows nothing** — `includeHistory` widens the status set but the request keeps the exception-only `materialOnly` default, and no terminal status is "material", so resolved items are fetched and filtered straight back out. Both toggles are needed | engineering | Found live during the axe pass. Documented as step 9 of the operator sheet so the PO is not left thinking their answer vanished |
| **`M12C-O11`** *(new, minor)* | The joint-allocation panel asks for a **raw `ii_accounts` id** rather than offering a picker | engineering | Disclosed in the operator sheet with the workaround |
| **`M12C-O12`** *(new)* | `color-contrast` is **incomplete** (needs review), not passing, on all seven PC5 states — axe could not resolve some backgrounds | design / engineering | Reported as incomplete rather than folded into either column |
| **`M12C-O7`** *(new, housekeeping)* | This worktree's `node_modules` is a **directory junction** to another worktree's, created so the suite could run | housekeeping | Git-ignored, affects nothing committed. Left in place so the next phase can run the suite without a fresh install |

## 18. Files changed

| File | Change |
|---|---|
| `lib/services/investment-intelligence/parsers/camsParser.ts` | §8.2 `classifyUnparsedTableLine` + the single emission site; §8.3 opening balance preserved as an adjustment |
| `lib/services/investment-intelligence/documentProcessing.ts` | §10 the shared password limiter, recorded before decryption |
| `lib/services/investment-intelligence/manualImporter.ts` | §11 the one `storage_path`-keyed row lookup no longer fails open |
| `lib/financial-data-hub/services/payslipProcessingService.ts` | §10 the same shared limiter on the payslip surface |
| `app/api/investment-intelligence/source-documents/[id]/process/route.ts` · `app/api/financial-data-hub/payslip/[documentId]/process/route.ts` | §10 429 on refusal, matching the certified surfaces |
| `components/investment-intelligence/InvestmentIntelligenceClient.tsx` | §11 a de-duplicated re-upload is announced instead of silently substituted |
| `lib/serverOnly.ts` | **new** — §13 the boundary marker, with what it does not do stated in its own header |
| `lib/aie/provider/providerFactory.ts` · `openaiAieProvider.ts` · `lib/aie/masking/identifierToken.ts` | §13 the marker; §14 the cumulative usage accumulator |
| `lib/aie/provider/gateway.ts` · `provider/types.ts` · `db/repository.ts` | §14 settlement uses the accumulated usage on every path, including exhaustion |
| `lib/aie/masking/piiMasking.ts` | §15 the bounded multi-line address rule |
| `lib/aie/review/accept.ts` · `review/reject.ts` · `review/userState.ts` · `stateMachine.ts` · `types.ts` · `services/purge.ts` | §12 FSM audit pairing, the purge machine, and `'ready'` |
| `.env.example` · `ENVIRONMENT_VARIABLES.md` | §13 the AIE section (names only) and the corrected Amplify quotation |
| `scripts/m12c_pc4_readonly_probe.mjs` · `m12c_pc4_warning_taxonomy_probe.mjs` · `m12c_pc4_residual_replay_probe.mjs` · `m12c_pc4_residual_attribution_probe.mjs` | **new** — the read-only production probes §8.2/§8.3/§8.4 rest on |
| `scripts/m12c-pc4-evidence/**` | **new** — the committed, redaction-safe evidence, and a README naming what is deliberately withheld |
| `scripts/m12c_pc4_synthetic_pack_live_dev.ts` · `scripts/m12c-pc4-synthetic-pack/**` | **new** — §9 |
| `scripts/m12c_pc5_owner_mapping_synthetic_repro.ts` · `scripts/m12c_pc5_accessibility_live_dev.ts` · `scripts/m12c-pc5-accessibility/**` | **new** — §8.1 and §16 |
| `docs/investment-intelligence/M12C_PC4_OWNER_MAPPING_OPERATOR_ACTION.md` | **new** — §8.1's instruction sheet for the Product Owner |
| `tests/unit/m12cPc4FinancialIntegrity.test.ts` · `m12cPasswordLimiterAndDocumentIdentity.test.ts` · `m12cServerOnlySecretBoundary.test.ts` · `m12cCostRetryAccounting.test.ts` · `m12cMultilineAddressMasking.test.ts` · `m12cAiePurgeStatusContract.test.ts` | **new** — 88 tests |
| `tests/unit/m12bIiAiFallbackGapDecision.test.ts` · `aieM3InvestmentCorpusAccuracy.test.ts` | Inverted, not deleted — both were failing correctly against §8.3's fix |
| `tests/unit/m12aFdhBankAccuracyCorpus.test.ts` · `m12aFdhBankIntakeGate.test.ts` | Fakes brought up to date with §12's new audit write; M12A's metrics byte-identical |
| `tests/unit/aieReviewAccept.test.ts` · `aieReviewReject.test.ts` · `aieReviewUserState.test.ts` · `aieStateMachine.test.ts` · `aiePurgeService.test.ts` · `aiePiiMasking.test.ts` · `aieOpenAiProvider.test.ts` · `aieCostAdmissionPglitePostgresProof.test.ts` · `aie16CertificationAdversarial.test.ts` · `aieReviewE2eInsuranceJourney.test.ts` | Extended for §§12, 14, 15 |

**Commits, in order, each readable on its own:**

| SHA | What |
|---|---|
| `69d5248` | §8.2 severity at source, §8.3 the opening balance, §8.4's arithmetic pinned, and the four read-only production probes |
| `61c4282` | §10 the password limiter, §11 document identity, §13 the server-only boundary, and the two inverted prior-phase tests |
| `94ef2ea` | The committed production evidence, with the three unsafe outputs deliberately withheld |
| `86b60fd` | §12 the state machine, §14 retry-summed settlement, §15 bounded address masking |
| `51fc217` | The two M12A fakes, found only by a full-suite run |
| `d7a232e` | §8.1's operator sheet and synthetic reproduction, §9's pack, §16's axe pass, and the fixes to this phase's own probe |

---

## 19. For the next M12 phase (traceability, section 17)


1. **No blocker prevents traceability work from starting.** Nothing this phase changed touches the traceability surface, `origin/main` is unchanged, nothing is pushed or merged, and no migration exists to reconcile.

2. **The single most important thing to carry forward is `M12C-F1`.** For nine days the PC4 residuals were read as an unexplained *arithmetic* problem. They are a **data-provenance** problem: production's transaction set is a union across five parse runs, three of them failed, and the fixed run's output never reached the database. Any future claim of the form *"the parser was fixed, therefore the data is correct"* is unsafe in this system until `OA-11` is executed. **The fix shipping and the data being right are two different facts, and this programme has now been bitten by the gap between them.**

3. **`OA-8` is the cheapest remaining win and it belongs to the Product Owner alone.** One owner mapping inside the app clears `unresolved_owner` on all 17 positions and most of the 120 open `owner_unmatched` cases. Combined with §8.2's `parser_fatal_error` clearance, it leaves `open_blocking_reconciliation_case` — mostly downstream of the same mapping — and the five residuals. §8.1's instruction sheet exists so this does not need an engineer present.

4. **Do not trust a zero, and do not trust a one either.** This phase's own money-shape predicate reported **1** economic candidate on its first pass and **0** on the corrected pass — the first predicate was simultaneously too narrow (blind to an ungrouped `3000.00`) and too broad (it matched `0.005%` and a version triple). The corrected, *more inclusive* predicate returns zero. **A number that looks plausible is not evidence that the measurement is right;** both passes are recorded in §5.1 for that reason.

5. **Build the control before you believe the hypothesis.** The opening-balance explanation for the four negative residuals was intuitive, aligned with a real confirmed defect, and **wrong**. It was refuted by a control that ran the same test against the twelve *reconciling* positions — one of which failed it too. Without that control it would have been recorded as confirmed. §7.2.

6. **A self-regenerating evidence file is only trustworthy when the whole suite runs.** A filtered subset run silently rewrote M12A's committed corpus results with seven of twelve rows deleted, including the summary row (report §16.3). Restored here; worth knowing before the next phase runs a targeted subset of a corpus suite.

7. **Two prior-phase tests were inverted rather than deleted, and both were failing correctly.** M12B deliberately wrote one of them to fail the day `M3-F1` was fixed and said so in place. **That is the pattern worth copying**: when a test pins a known defect, write it so the fix breaks it loudly and leave instructions in the test for whoever closes it.

8. **Three things still need the Product Owner before anything AI-related can be certified anywhere**, and none is engineering work: provisioning `AIE_MASK_TOKEN_ENCRYPTION_KEY` (`OA-6`), authorising an outbound provider call (`M12B-O2`), and supplying or formally retiring PC4's ≥48-section specification (`OA-1`).

---

*End of M12C closure report. Nothing is pushed. Nothing is merged. No production database write, configuration change, migration, deployment or rollout was performed, no secret was provisioned in any persisted config file, and no `.env.local` was created in this worktree.*
