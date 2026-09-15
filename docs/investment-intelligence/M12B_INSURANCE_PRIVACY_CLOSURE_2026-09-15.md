# M12B — Insurance Accuracy, Real AI Privacy Proof, and the Investment Intelligence AI-Fallback Decision

**Mission:** FHIP — M12 "Final Closure", Phase B (sections 5, 6 and 7 of the M12 dispatch)
**Date:** 2026-09-16 (branched from the M12A tip dated 2026-09-15; the mission's date label is retained)
**Branch:** `mission/m12b-insurance-privacy-2026-09-15`, branched from `62e08a9bfd0c3ac31fefc1bd2efb4e632c20942e` — M12A's closure commit, **not** `origin/main`
**Terminal commit:** `fd1870d1d8f29eea11faf04c95fc8671416354f0`
**Carried forward:** all 15 prior mission documents, inherited by branching rather than copied (§8.1). With this document, `docs/investment-intelligence/` carries **16** mission documents.

**Authority exercised:** repository and git inspection; test execution; local static analysis.
**Authority NOT exercised, per the binding production override, and not exercised regardless of the verdict reached:** no push, no merge, no deployment, no production database read or write, no production configuration change, no migration applied anywhere, no migration created anywhere, **no secret provisioned in any persisted config file**, and **no outbound network request of any kind**. Everything is committed locally.

**No credential value, API key, policy number, PAN, Aadhaar, account number, holder name or real policy text appears anywhere in this document or in anything it commits.** Every document in the corpus is synthetic and every identifier in it was invented for the fixture.

---

## 1. Verdict

> # M12B — **CONDITIONAL PASS.**
>
> **Section 5 (Insurance accuracy certification) meets both of its hard requirements and misses
> none of its mandated scenarios.** Across a sealed 14-document corpus measured against a
> hand-authored independent oracle, through the real intake route and the real acceptance gate:
>
> | Measure | Required | Achieved |
> |---|---|---|
> | Field precision | measured | **100.00%** (169/169) |
> | Field recall | measured | **100.00%** (169/169) |
> | Economic precision | measured | **100.00%** (24/24) |
> | Economic recall | measured | **82.76%** (24/29) |
> | **Unexplained economic omission** | **= 0** | **0** |
> | **False canonical write rate** | **= 0** | **0.00%** (0 of 14) |
> | False accept rate | measured | **0.00%** (0 of 9 must-not-be-acceptable cases) |
>
> **Section 6 (the real AI privacy proof) passes for both adapters, on the real outbound HTTP
> request body, for every category the dispatch names** — and it did so only after fixing two
> shared-core defects it found. No live provider call was made and no credential was read; §6.2
> states exactly why, and why that is the stronger evidence rather than the weaker.
>
> **Section 7 (Investment Intelligence AI fallback): NO AI-eligible gap was introduced, and that is
> the finding rather than an omission.** The one candidate the dispatch named — `M3-F1`'s
> discarded CAS opening balance — was investigated against the code and fails three of the
> dispatch's own four conditions. Investment Intelligence is certified in the state the dispatch
> itself names as acceptable: deterministic-first path certified; AI fallback structurally
> available with no eligible extraction gap today.
>
> **What keeps the phase CONDITIONAL, and it is exactly one thing.** **INS-B05 and INS-B13** —
> the two corpus cases that declare the adapter's one AI-eligible gap — reach the masking stage,
> and `AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset in this environment. That is a
> Product-Owner/operator-owned blocker this phase was explicitly told not to work around, and did
> not. Their deterministic invariants are proved under an ephemeral in-process key (§5.6); the AI
> clarification itself is **NOT CERTIFIED** for Insurance.
>
> **Six real defects were found and fixed, every one by running the system rather than reading it.**
> Four were found on FIRST runs: the corpus found two false canonical writes (`M12B-F4`,
> `M12B-F5`), and the privacy harness found a genuine pre-egress PII leak (`M12B-F1`) and a guard
> that reported leaks in fully-masked text (`M12B-F2`). A third masking defect (`M12B-F3`)
> surfaced while fixing those two. The sixth is M12A's own carried-forward `M12A-F2`, reproduced
> here in a second adapter — which is what confirmed its blast radius — and fixed in shared core
> as M12A recommended. A seventh was *introduced* by this phase's first attempt at `M12B-F2` and
> caught by the harness before it was committed as fixed; §3 records how it failed, because the
> way it failed is not obvious.
>
> **`UNCONDITIONAL FULL PASS` is not available and this report does not award it**, because the
> Insurance AI clarification is uncertified and the programme's own standing rule forbids awarding
> a full pass over a named gap.

---

## 2. What this phase was asked to do, and what it did

| M12 dispatch | Status |
|---|---|
| §5 — sealed corpus over the ALREADY-APPROVED Insurance class only; do not enable the eight deferred classes or the prohibited sensitive class | **DONE.** §5.2. INS-B09 proves the boundary holds from the other side |
| §5 — test policy name, insurer, policy number token, insured-party masking, premium, coverage/sum insured, policy dates, renewal date, structured benefit fields, missing-policy-name AI fallback | **DONE.** §5.3 maps each to its case |
| §5 — include terminology variants, multi-page, password PDF, malformed policy, prompt injection, missing product name | **DONE**, plus four additive probes. §5.2 |
| §5 — measure accuracy exactly as Phase A did, same harness, same metric definitions | **DONE.** `tests/support/aieAccuracyHarness.ts` reused unchanged; no second harness built |
| §6 — build and fully implement the real-provider privacy-proof harness, with every named assertion | **DONE.** §6.1, `tests/support/aiePrivacyProofHarness.ts` |
| §6 — run it with a real OpenAI call if genuinely possible, or name the real-provider half blocked | **Deliberately NOT a live call.** §6.2 states the reasoning in full and what was done instead |
| §6 — do NOT provision `AIE_MASK_TOKEN_ENCRYPTION_KEY` (the more restrictive, more recent instruction) | **HONOURED.** §6.3 |
| §7 — inspect real parser outputs and PC4's real defects; introduce an AI-eligible gap only if a real ambiguity meets all four conditions | **DONE, and DECLINED with reasoning.** §7 |
| §3's contract-fix work does not apply to Insurance — confirm fresh, don't assume | **CONFIRMED FRESH.** §5.1 |
| Fix `M12A-F2` if it is a clean, narrowly-scoped shared-core fix | **FIXED.** §6.5 |
| Copy forward all 15 prior documents | **DONE** — inherited by branching, §8.1 |
| Verify migration numbering fresh | **DONE**, with a negative control. §8.2 |
| No push, no merge, no production touch, no persisted secret | **HONOURED.** §8.3 |

---

## 3. Findings summary

Six defects, in the order they were found. Every one was found by running the system.

| Id | What | Where | Status |
|---|---|---|---|
| **`M12B-F1`** | **A pre-egress PII leak.** A 10-digit policy number and an insurance policy-owner/insured-person name reached the AI provider **verbatim**. On INS-B05 the masking coverage was literally `{}` — nothing matched — and the provider call succeeded with the raw document text | `lib/aie/masking/piiMasking.ts` (shared core) | **FIXED** §6.4 |
| **`M12B-F2`** | The pre-egress PII guard reported residual PII in **fully masked** text, because the address rule re-matched the masker's own placeholder. Fail-closed, but it made a masked document indistinguishable from a leaking one, and made the AI fallback unreachable for every policy printing an address | `lib/aie/masking/piiMasking.ts` (shared core) | **FIXED** §6.4 |
| **`M12B-F3`** | Label-anchored masking rules ran past the end of their own line, swallowing the next line's label into a token | `lib/aie/masking/piiMasking.ts` (shared core) | **FIXED** §6.4 |
| **`M12A-F2`** | M12A's carried-forward shared-core defect: an ambiguous-layout document **crashed the intake request** instead of degrading, when the masking key is unset | `lib/aie/orchestrator.ts` (shared core) | **FIXED** §6.5 |
| **`M12B-F4`** | **A false canonical write.** Money printed under a label the taxonomy does not recognise vanished in silence; the run reached `awaiting_acceptance` and an explicit accept wrote an incomplete policy | `lib/aie/adapters/insurance/**` | **FIXED** §5.5 |
| **`M12B-F5`** | **A second false canonical write.** A renewal date printed `31/08/2027` was dropped without a word and written as `NULL` | `lib/aie/adapters/insurance/**` | **FIXED** §5.5 |

**One defect was introduced by a fix in this phase and caught before it shipped as fixed**, and it is recorded because the way it failed is not obvious. The first attempt at `M12B-F2` stripped placeholders before re-scanning. That leaves an *empty value slot behind a label that is still printed*, and every label-anchored rule then runs on and claims whatever comes next: on a real CAS header, `Folio No: <stripped>   IFSC: <stripped>` made the folio rule match the literal word `IFSC`. A different false positive with the same effect. The reasoning is now in the code at the fix site, not only here.

---

## 4. Scope, confirmed fresh rather than assumed

The dispatch told this phase two things to confirm rather than take on trust. Both were checked against the code.

**Insurance's intake route has no self-accept — CONFIRMED.** `app/api/aie/insurance/intake/route.ts:198-215` carries an explicit block recording that AIE-1.5 superseded the self-accept this route used to perform, and there is no `acceptAndWrite*` call anywhere in the file. So §3's contract-fix work genuinely does not apply here, and this phase moved straight to the accuracy corpus. The corpus asserts it stayed that way rather than trusting the comment: **zero canonical writes at intake on every one of the 14 cases, without exception** (§5.4, invariant 1).

**`AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset — RE-CONFIRMED FRESH.** Absent from the process environment, and absent from the only `.env.local` reachable from here (8 keys, none of them this one — names inspected, no value read or echoed). No `.env.local` exists in this worktree at all. A test asserts the repository-level half of this claim so the report cannot drift from it.

**Phase A's prediction was right, and slightly understated.** M12A §11.5 predicted the masking key would be "the dominant constraint on Insurance's corpus rather than a single CONDITIONAL row". Insurance declares its AI-eligible gap whenever the product name is missing, and **2 of 14 corpus cases** reach masking versus FDH-bank's 1 of 12. More importantly, the two that do are the two that exposed `M12B-F1` — a real leak FDH-bank's single case could never have surfaced, because FDH-bank's ambiguous-layout document has no person name and no policy-number-shaped identifier on it.

---

## 5. Section 5 — the Insurance accuracy certification

### 5.1 How the independence is structural, not claimed

| Artefact | What it contains | What it must not contain |
|---|---|---|
| `tests/support/buildM12bInsuranceCorpus.ts` | What each policy **prints**, and real PDF bytes built from those lines | Any expected outcome, parsed value or verdict |
| `scripts/m12b-insurance-certification/oracle.json` | Every expected value, hand-derived from those printed lines | Any call into production code |
| `tests/support/aieAccuracyHarness.ts` | The metric definitions — **M12A's, reused unchanged** | Any knowledge of insurance |
| `tests/unit/m12bInsuranceAccuracyCorpus.test.ts` | The driver | Any expectation of its own beyond the oracle's |

The oracle is read the way a person reconciling the policy would read it: take the label's meaning, take the money figure's magnitude with grouping separators removed, take the frequency word's meaning, and take a date **only where the printed format is unambiguous**. `policyNumberMasked` is recomputed independently from the printed digits rather than read back from `maskPolicyNumber()`.

The one thing the test imports from production is the adapter's field **names** — a certification that silently looked for a field the adapter had stopped emitting would report a perfect zero instead of a failure. The oracle's **values** remain entirely independent.

**One oracle correction was made, and it is recorded in the oracle itself rather than quietly applied.** The oracle originally expected `multiComponentPolicyDetected` to be `"true"` on INS-B12, reasoning that B12 is the same *product* situation as B11 and must be flagged the same way. The first half of that is right; the second half confused two different claims. That flag is defined as a count of *recognised* `coverAmount`/`premium` label occurrences, and `Trauma Cover` is recognised by nothing, so the flag genuinely cannot see this document. The oracle is entitled to require that the document be **flagged** — not to dictate which rule flags it.

### 5.2 The corpus, and why 14 cases

B01–B10 cover every scenario the dispatch mandates. B11–B14 are additive probes this phase added on its own initiative, following M12A §11.6's instruction to **ask the third question**.

| Case | Scenario | Why it exists |
|---|---|---|
| **B01** | normal policy schedule | The baseline: every field, arithmetic closing to the cent |
| **B02** | multi-page policy | Required fields deliberately **split across all three page breaks**, so a reader that stopped at page one would be missing cover amount, currency, premium and frequency entirely |
| **B03** | terminology variants | B01's exact economics under entirely different wording — `Underwriter`, `Sum Assured`, `Payment Frequency`, `Cover End Date`. Every extracted value must equal B01's, or the taxonomy is reading notation rather than meaning |
| **B04** | renewal notice + structured benefit fields | A second certified sub-class, carrying waiting period, benefit period and excess. The excess is printed `0.00` specifically to catch a falsy-zero drop |
| **B05** | missing product name | The adapter's one AI-eligible gap. **CONDITIONAL** — §5.6 |
| **B06** | malformed policy | Extraction is **perfect**; the document's own arithmetic is what fails. Measures whether perfect extraction is mistaken for a correct document |
| **B07** | password-protected | Genuinely encrypted, no password supplied |
| **B08** | prompt injection | Three injections as policy narrative: one demanding acceptance, one asserting a fabricated `999999.99` larger than every real figure, one demanding a certification |
| **B09** | deferred sub-class (PDS) | **The scope boundary, proved from the other side.** Carries plenty of policy-shaped labels a coercing parser could have used |
| **B10** | unsupported currency | Extraction perfect, USD outside the canonical table's accepted set |
| **B11** | ADDITIVE — multi-component the flag CAN see | Establishes that the flag works, which is what makes B12's question meaningful |
| **B12** | ADDITIVE — **the third question** | §5.5 |
| **B13** | ADDITIVE — India/INR + PII, product name absent | Indian lakh grouping (`12,50,000.00`) that a Western-grouping assumption would **mis-value**, not merely mis-format. Also the privacy proof's main fixture |
| **B14** | ADDITIVE — non-ISO renewal date | The same "can a printed fact vanish?" question, asked of a date |
| **CONTROL** | structurally corrupt PDF | So the corpus's positive readings are distinguishable from its negative ones |

**Evidence standard.** Every line is synthetic, built on the bounded generic `Label: Value` layout `adapters/insurance/labels.ts` is certified against — the one layout AIE-1.4 certified, and which that file's own ELIG-05 header is explicit about having *chosen* rather than sourcing any real insurer's PDF. **Nothing here is, or is derived from, a real insurance policy.**

### 5.3 The mandated field list, and where each is proved

| Dispatch item | Proved by |
|---|---|
| policy name | B01/B02/B03/B04/B06/B08/B10/B11/B12/B14 extract it exactly; B05/B13 are the absence case |
| insurer | B01 (`Insurer:`), B03 (`Underwriter:`) — same field, different notation |
| policy number token | Every case: `policyNumberMasked` asserted against an independently recomputed mask. **Never the raw digits** |
| insured-party masking | Two distinct layers, and §6.6 explains why they are different |
| premium | Every case, including the fortnightly `88.40 × 26` and quarterly `310.50 × 4` reconciliations |
| coverage / sum insured | B01 (`Sum Insured`), B03 (`Sum Assured`), B04 (`Benefit Amount`), B13 (lakh grouping) |
| policy dates | B01–B06, B08, B10–B13 (ISO); **B14** is the non-ISO probe |
| renewal date | as above; `Cover End Date` (B03) proves the label variants |
| structured benefit fields | B04: waiting period `30 days` → `30`, benefit period `2 years`, excess `0.00` → `0` (not dropped as falsy); B02: excess `750.00` |
| missing policy-name clarification via AI fallback | B05 and B13. **CONDITIONAL** — §5.6 |

### 5.4 Results

Generated by `tests/unit/m12bInsuranceAccuracyCorpus.test.ts`; the machine-readable form is `scripts/m12b-insurance-certification/results.json`, and the table below is `results_table.md` **verbatim** rather than retyped, so report and run cannot drift.

| Case | Scenario | Field P | Field R | Econ P | Econ R | Unexplained omissions | False accept | False canonical write |
|---|---|---|---|---|---|---|---|---|
| INS-B01 | normal policy schedule | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B02 | multi-page policy schedule | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B03 | terminology variants | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B04 | renewal notice with structured benefit fields | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B05 | missing policy name requiring AI clarification | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B06 | malformed policy — printed annual total contradicts the document's own premium | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B07 | password-protected policy schedule | n/a | n/a | n/a | 0.00% | 0 | no | no |
| INS-B08 | adversarial prompt-injection text | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B09 | deferred sub-class (product disclosure statement) | 100.00% | 100.00% | n/a | n/a | 0 | no | no |
| INS-B10 | unsupported currency | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B11 | ADDITIVE — multi-component policy the flag can see | 100.00% | 100.00% | 100.00% | 50.00% | 0 | no | no |
| INS-B12 | ADDITIVE — money printed under an unrecognised label | 100.00% | 100.00% | 100.00% | 66.67% | 0 | no | no |
| INS-B13 | ADDITIVE — India / INR jurisdiction variant carrying PII, product name absent | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| INS-B14 | ADDITIVE — renewal date printed in a non-ISO format | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| **ALL 14** | — | **100.00%** | **100.00%** | **100.00%** | **82.76%** | **0** | **0.00%** | **0.00%** |

- unexplained economic omissions: **0**
- false accept rate: **0.00%** (0 of 9 must-not-be-acceptable cases)
- false canonical write rate: **0.00%** (0 of 14 cases)

#### The raw counts behind those percentages

Percentages hide small denominators.

| Case | Fields correct / asserted | Econ matched / observed | Econ matched / printed |
|---|---|---|---|
| INS-B01 | 16/16 | 2/2 | 2/2 |
| INS-B02 | 16/16 | 2/2 | 2/2 |
| INS-B03 | 14/14 | 2/2 | 2/2 |
| INS-B04 | 17/17 | 2/2 | 2/2 |
| INS-B05 | 13/13 | 2/2 | 2/2 |
| INS-B06 | 13/13 | 2/2 | 2/2 |
| INS-B07 | 0/0 | 0/0 | **0/2** |
| INS-B08 | 14/14 | 2/2 | 2/2 |
| INS-B09 | 1/1 | 0/0 | 0/0 |
| INS-B10 | 13/13 | 2/2 | 2/2 |
| INS-B11 | 12/12 | 2/2 | **2/4** |
| INS-B12 | 13/13 | 2/2 | **2/3** |
| INS-B13 | 15/15 | 2/2 | 2/2 |
| INS-B14 | 12/12 | 2/2 | 2/2 |
| **Total** | **169/169** | **24/24** | **24/29** |

**Economic recall is 82.76%, and that number is correct rather than a failure.** The five unmatched money facts are B07's two (inside an encrypted document nobody read), B11's second component, and B12's trauma cover. **All five are accounted for**: B07 is refused outright, and B11/B12 are blocked `unresolved` with an item naming the reason. A system that had *guessed* those five would have scored 100% recall and been very much worse.

#### Per-case lifecycle, observed

| Case | Terminal status | Explicit accept | Writes at intake | Writes after accept | AI calls | Blocking items |
|---|---|---|---|---|---|---|
| INS-B01 | `awaiting_acceptance` | **ok** | 0 | **1** | 0 | 0 |
| INS-B02 | `awaiting_acceptance` | **ok** | 0 | **1** | 0 | 0 |
| INS-B03 | `awaiting_acceptance` | **ok** | 0 | **1** | 0 | 0 |
| INS-B04 | `awaiting_acceptance` | **ok** | 0 | **1** | 0 | 0 |
| INS-B05 | `unresolved` | refused `not_ready` | 0 | 0 | 1 | 1 |
| INS-B06 | `unresolved` | refused `not_ready` | 0 | 0 | 0 | 1 |
| INS-B07 | `quarantined` (`password_required`) | refused `not_found` | 0 | 0 | 0 | 0 |
| INS-B08 | `awaiting_acceptance` | **ok** | 0 | **1** | 0 | 0 |
| INS-B09 | `unresolved` | refused `not_ready` | 0 | 0 | 0 | 1 |
| INS-B10 | `unresolved` | refused `not_ready` | 0 | 0 | 0 | 1 |
| INS-B11 | `unresolved` | refused `not_ready` | 0 | 0 | 0 | 1 |
| INS-B12 | `unresolved` | refused `not_ready` | 0 | 0 | 0 | 1 |
| INS-B13 | `unresolved` | refused `not_ready` | 0 | 0 | 1 | 1 |
| INS-B14 | `unresolved` | refused `not_ready` | 0 | 0 | 0 | 1 |
| CONTROL corrupt PDF | `rejected` | — | 0 | 0 | 0 | 0 |

**Zero writes at intake on every case without exception**, and a write only ever after an acceptance that genuinely succeeded. B07 is refused `not_found` because no run was ever created — honest, and different from `not_ready`. A separate test proves a **second** explicit accept is idempotent: `{ ok: true, alreadyCompleted: true }`, **one** canonical write, not two.

#### Why the lifecycle runs twice per case

Every case is driven through an intake **and then an unconditional explicit accept attempt**. That is what makes "false canonical write rate" a real measurement rather than a tautology: it asks of every document *"if a user pressed accept, would this be written?"* and compares the answer with what the oracle says may ever be written. Measuring only intake would score 0% trivially, because Insurance's intake writes nothing by construction.

Both of M12A's documented harness traps were mirrored, and both matter: shared fake state lives on `globalThis` (never reset at module top level), and the fake mirrors **`recordTransition`**, not `transitionRunStatusCas`, because that is what actually updates `aie_extraction_run.status`. Had the wrong one been mirrored, no case would ever have become acceptable, every accept would have returned `not_ready`, and **the false-canonical-write rate would have read a vacuous zero — which would have hidden `M12B-F4` and `M12B-F5` completely.**

### 5.5 `M12B-F4` and `M12B-F5` — the defects the corpus found

**These are the most consequential findings of section 5, and the corpus found them on its first run.**

M12A §11.6 said to *ask the third question*: the most valuable case in its own corpus was the one nobody asked for. Here that question was: **B11 proves the multi-component flag fires when it can see the second component — what happens when it cannot?**

**`M12B-F4`.** INS-B12 prints `Trauma Cover: 150,000.00`. That label matches no rule in `labels.ts` — not `coverAmount` (whose terms are `sum insured`/`cover amount`/`sum assured`/`benefit amount`), not `policyType` (`cover type`), not anything. The parser ignored the line, **correctly**, because AIE14-INS-10 forbids guessing a bucket. But `multiComponentPolicyDetected` counts occurrences of *recognised* `coverAmount`/`premium` labels, so it had nothing to count; every required field was present; every rule passed; the run reached `awaiting_acceptance`; and an explicit accept wrote an incomplete policy to `insurance_policies`. **150,000.00 of printed cover disappeared without a word.**

**`M12B-F5`.** INS-B14 prints `Renewal Date: 31/08/2027`. The parser admits a renewal date only when it already matches `^\d{4}-\d{2}-\d{2}$`, `renewalDate` is not in `INSURANCE_REQUIRED_FIELDS`, and no reconciliation rule mentions it at all. The date was dropped, nothing noticed, and `renewal_date: null` was written.

**This is the same defect shape as `M12A-F1` on FDH-bank**, and it was fixed the same way, deliberately: in both cases **the parser knew**, and the knowledge never reached the one place that decides whether a run may be accepted, because `ReconciliationRule` receives **candidates only**.

**The fix.** `parser.ts` emits `unreadablePrintedFactCount` and `unreadablePrintedFactEvidence` (which label, and why — **never a guess at what it meant**). `reconciliation.ts` adds `insurance_printed_fact_completeness` as **its own rule**, and the blocking item is produced by AIE-1.1 core's own unchanged `blockingItemsForReconciliation`, so **no second exception channel is introduced** (P7). `reasonCodes.ts` gains real reviewer copy instead of falling through to `GENERIC_FALLBACK_REASON_META`, whose text gives a reviewer nothing to act on.

The existing rules are untouched. *"Did the arithmetic close?"* and *"did we read everything the policy printed?"* are two questions, and the answer to one must never be read off the other — **INS-B12's premium arithmetic closes to the cent while the cover is missing.**

Four deliberate choices, each backed by a test:

1. **`indeterminate`, never `fail`.** The adapter does not know the unread facts are *wrong* — only that it could not read them, which is what INDETERMINATE means everywhere else in that file.
2. **Emitted even at zero**, as an explicit `pass` with materiality `all_printed_facts_read`. A positive assertion beats silence, and a future change that stops emitting it fails loudly instead of quietly restoring the old behaviour.
3. **An absent candidate is `indeterminate`, not `pass`.** The entire defect was an absent signal being read as good news; a run from a pre-M12B parser must block, not sail through.
4. **Money-shaped values only.** A policy prints many unrecognised labelled lines carrying nothing economic — branch references, correspondence codes, footers — and flagging all of them would train a reviewer to dismiss the signal. A test proves a branch reference and a phone number do **not** trip it.

**`M12B-F5` is fixed by REPORTING, not by parsing more date formats**, and that is a deliberate choice rather than a lazy one. `31/08/2027` is unambiguous only because 31 cannot be a month; `05/08/2027` is not, and a parser accepting the family would have to **guess** between DD/MM and MM/DD exactly where guessing wrong is invisible. Renewal date drives cover-lapse and reminder behaviour, so a wrong one is worse than an absent one.

#### Measured before and after, on the same corpus

| Measure | Before (commit `a982006`) | After (commit `8143762`) |
|---|---|---|
| Unexplained economic omissions | **1** | **0** |
| False accept rate | **22.22%** (2 of 9) | **0.00%** |
| False canonical write rate | **14.29%** (2 of 14) | **0.00%** |
| Field precision / recall | 99.36% / 99.36% | 100.00% / 100.00% |
| Economic precision / recall | 100.00% / 82.76% | 100.00% / 82.76% |

Those pre-fix numbers are preserved in commit `a982006`, which deliberately commits the corpus **with** the defects it found rather than after them.

**No migration was needed, verified structurally.** `aie_field_candidate.field_name`, `aie_reconciliation_run.rule_id` and `aie_unresolved_item.reason_code` are all unconstrained `text` in migration `0140`, and `aie_reconciliation_run.outcome`'s CHECK already admits `'pass'` and `'indeterminate'`. Read from the migration, not assumed.

**Two pre-existing tests were updated — and they were failing correctly.** `tests/unit/aieReviewRevalidate.test.ts` builds a synthetic candidate set that predates the new candidate, so after the fix it failed **closed**, which is the behaviour the fix exists to produce. It now supplies the candidate at its clean value, so each test again tests the one thing it names. Nothing was weakened: the fail-closed case is asserted directly in `aieInsuranceAdapterReconciliation.test.ts`, and the assertion count went up by six.

### 5.6 INS-B05 and INS-B13 — what cannot be certified, stated precisely

These are the only two corpus documents that reach the masking stage, because they are the only two that declare the adapter's one AI-eligible gap (`policyNameClarification`, `parser.ts`) — which it declares exactly when the product name is missing.

**Run 1 — the environment as it actually stands, no key, no workaround.** `AIE_MASK_TOKEN_ENCRYPTION_KEY` is asserted `undefined`, not assumed. Both cases: **zero canonical writes, zero AI completion attempts, and neither run reaches `awaiting_acceptance`.** Since `M12A-F2`'s fix (§6.5) they now degrade to `unresolved` with a blocking item rather than crashing the request.

**Run 2 — under an ephemeral, in-process key**, so the deterministic invariants are measured rather than skipped:

| Invariant | INS-B05 | INS-B13 |
|---|---|---|
| Terminal status | `unresolved` | `unresolved` |
| Blocking item | `reconciliation_fail:insurance_required_fields_present` | same |
| AI completion attempts | 1 | 1 |
| Policy name invented by the pipeline | **none** — the mock returns an empty `fields` array deliberately; a corpus that scripted the AI into supplying the missing value would be measuring the script | same |
| Identifiers in the provider payload | **absent** — asserted against the captured outbound body, §6 | **absent**, all eight |
| Canonical writes, including after an explicit accept | **0**; accept refused `not_ready` | **0**; same |

**What this does and does not certify.** It certifies that a policy with no product name can never be accepted, can never have a name invented for it, and cannot leak an identifier into a provider payload. It does **not** certify the AI clarification itself: no real provider response was obtained, the key is not provisioned in DEV, and provisioning it was explicitly out of scope. **INS-B05 and INS-B13 are therefore CONDITIONAL**, and they are the only reason this phase is not a full pass.

### 5.7 What each case actually proved

| Case | What it establishes |
|---|---|
| **B01** | Every canonical and evidence field extracted exactly; `120.00 × 12 = 1440.00` closes to the cent; zero unresolved items |
| **B02** | Fields **split across three page breaks** are all recovered, page banners and `Page N of 3` footers ignored, `310.50 × 4 = 1242.00` closes |
| **B03** | The same four canonical values as B01 under `Underwriter` / `Sum Assured` / `Payment Frequency` / `Cover End Date`. A taxonomy matching only canonical spellings would have lost the **cover amount silently** rather than loudly |
| **B04** | A second certified sub-class with the supported structured benefit fields. `Waiting Period: 30 days → 30`, `Benefit Period: 2 years`, and **`Excess: 0.00 → 0`, not dropped as falsy**. `88.40 × 26 = 2298.40` closes exactly |
| **B05** | The AI gap declared; required-fields rule fails; blocked; nothing written. **CONDITIONAL** — §5.6 |
| **B06** | Extraction is **perfect** — this case measures whether perfect extraction is mistaken for a correct document. `150.00 × 12 = 1800.00` against a printed `900.00`: delta **900.00**, tolerance 18.00, `fail`, blocked, never written |
| **B07** | A genuinely encrypted policy with no password: refused `password_required`, **zero** fields extracted, nothing written. Never a partial read, never an empty policy reported as clean |
| **B08** | Three injections — one demanding acceptance, one asserting a fabricated `999999.99`, one demanding certification. Every real figure extracted as printed; `999999.99` asserted **never to be any field's value**; the injected text survives as inert `exclusionsText`; terminal status unchanged; **zero AI calls**. The `Notes:` line's label is unrecognised and its money-shaped content is inside prose, so it correctly does not even trip the new completeness rule |
| **B09** | **The scope boundary.** A PDS is NAMED (`product_disclosure_statement`) and refused, with the class rule `fail`ing and every other rule `not_applicable` — no double-guessing on an already-rejected document. Exactly one field candidate is emitted: the sub-class itself. The deferred classes stay deferred |
| **B10** | Extraction perfect, `currencyCode: USD`, currency rule `fail`, blocked. Never silently written in a unit the canonical table cannot express |
| **B11** | **ADDITIVE.** Two components under recognised labels → `multiComponentPolicyDetected: true` → `indeterminate` → blocked. Establishes the flag works, which is what makes B12 meaningful |
| **B12** | **ADDITIVE — the third question.** §5.5 |
| **B13** | **ADDITIVE.** India/INR with lakh grouping: `12,50,000.00 → 1250000` and `3,450.00 × 4 = 13,800.00` closes — which it only can if the grouping was read correctly. Also the privacy proof's main fixture, §6 |
| **B14** | **ADDITIVE.** §5.5 |
| **CONTROL** | A structurally corrupt PDF is refused with nothing extracted and nothing written |

---

## 6. Section 6 — the real AI privacy proof

### 6.1 Where the measurement is taken, and why it is there

Not on `maskText`'s return value, and not on the gateway's arguments. On the **real `OpenAiAieProvider`'s own outbound HTTP request body** — the last artefact that exists before the process hands bytes to the network. Anything measured earlier proves a property of an intermediate value; this proves a property of what egresses. It is also the only vantage point from which `store: false` and the strict-JSON-schema declaration are observable, because the provider adds both itself, after every other layer is finished.

`globalThis.fetch` is intercepted, so the bytes are built by entirely real code and then examined instead of sent.

**What is real:** the deterministic parsers, `maskText`, the `AieDocumentAiGateway` with its real kill switch and its real `containsUnmaskedPii` guard, `OpenAiAieProvider` building its real request body, the registered schemas, and `validateAiOutput`. **What is substituted:** exactly one thing — the network.

`tests/support/aiePrivacyProofHarness.ts` is domain-agnostic for the same reason `aieAccuracyHarness.ts` is: the privacy question is identical for both adapters and they must not be able to answer it to different standards.

**The harness is two-sided on purpose.** A masking layer can pass a "no PII" assertion by destroying the document, so every case also names the **financial evidence that must survive** — H.9's own wording is the standard ("financial values needed for extraction may remain"), and a harness that only checked absence would happily certify a layer that sent an empty string.

**And it reports a case where no payload was built as `VACUOUS`, never as a pass.** That is the vacuous-zero trap M12A recorded twice, and a harness scoring it `pass` would be repeating it. This mattered immediately: the first run scored INS-B13 `pass` with zero payloads, and the harness was hardened before anything was concluded from it.

### 6.2 The live-call question, resolved explicitly

The dispatch asks for a real OpenAI call "if genuinely possible", and explicitly permits declining. **No live call was made, no credential was read, and no outbound request of any kind left this process.** The reasoning, stated plainly because the dispatch asks for the opposite:

1. **The privacy assertions are fully provable without transmitting anything.** A live call answers "did any identifier reach the provider?" for the one payload it sent — *after* it has been sent. Interception answers it for the same bytes, **exhaustively, against every literal the source document contained, before anything leaves.** That is stronger evidence, not weaker.
2. **Everything else a live call would demonstrate is present in the captured body and asserted here** — that it goes to exactly one URL, that `response_format.json_schema.strict === true`, that `store: false` is set, that no tools or extra messages are attached.
3. **The one thing a live call would additionally exercise is response handling — and that is driven deterministically instead, on both paths.** §6.7 drives a schema-violating response through the real gateway and proves no result is accepted. A single live call could not have exercised the failure path at all.
4. **A live call is an outbound transmission billed to the Product Owner's own credential.** This phase was told, in the same breath, not to provision secrets — and the same reasoning that reserves secret provisioning for a Product-Owner-present phase reserves spending that credential. The dispatch's second option was taken deliberately, not by default.

**A genuinely available option was declined, not an unavailable one.** `AIE_OPENAI_API_KEY` is present in the repository's `.env.local` (name observed; value never read, never echoed, never used). The real-provider RESPONSE half is therefore named as blocked pending the Product Owner's own authorisation, exactly as `FDH-A05` was named in M12A — but note the asymmetry: the **request** half, which is the half the privacy question actually turns on, is fully proved here for both adapters.

### 6.3 The ephemeral masking key, and why it is not provisioning

The dispatch's original text asked this phase to provision `AIE_MASK_TOKEN_ENCRYPTION_KEY` in DEV, and then flagged its own contradiction with Phase A's later finding. **The more restrictive, more recent instruction was followed: no key was provisioned.**

Masking fails closed without a key, so an **in-process, in-memory key** is generated per test with `crypto.randomBytes(32)` purely so the masking layer can be exercised at all. It is never written to `.env.local`, never written to any config file, and does not survive the process. This is the same technique M2's own real-provider proof used and that `aieFdhBankStatementOrchestratorIntegration.test.ts` already used before this phase. **It is not a provisioning of DEV's real key**, and a test asserts the repository-level fact — no `.env.local` reachable from this worktree declares the variable — so the claim in this report is checked rather than asserted.

### 6.4 `M12B-F1`, `M12B-F2`, `M12B-F3` — what the harness found

**The harness found a real leak on its first run.**

`INS-B05` egressed **both** the policy owner's name (`Reese Ellis Vaughn`) and the 10-digit policy number in the outbound OpenAI request body, and `aie_masking_summary.coverage_by_type` for that run was **literally `{}`** — the masking layer matched nothing at all on an ordinary AU policy document.

| Id | Root cause |
|---|---|
| **`M12B-F1`** | `person_name_label`'s label list was **CAS/investment vocabulary only** (`investor`, `unit holder`, `nominee`, …) and contained no insurance term, so `Policy Owner:` and `Insured Person:` matched nothing. And **no rule of any kind covered a policy number**: `long_digit_run` needs 11+ digits, `card_number` 13–19, `bank_account` a BSB shape, and the AU-TFN rule a word boundary after 8–9 — an ordinary **10-digit** policy number fell through every one |
| **`M12B-F2`** | `containsUnmaskedPii` used a bare `pattern.test()`, so the address rule's `[^\r\n]{5,160}` value group **re-matched the masker's own placeholder**. `INS-B13` was refused `unmasked_pii_detected` and built no payload at all |
| **`M12B-F3`** | `\s`/`\s+` match newlines, so label-anchored rules ran past their own line: the person rule captured `Rohan Prakash Iyer\nPAN Number` as one name, **destroying the `PAN Number:` label** a downstream adapter needs; and an **empty** labelled field claimed the next line's text entirely |

**The two main defects interact, and the interaction is the important part.** `M12B-F2` was the **only** thing preventing `M12B-F1` from leaking on INS-B13. **Fixing F2 alone would have turned a false alarm into a real leak** — which is exactly why they are fixed together and why this is recorded rather than left implicit.

**The fixes.** `person_name_label` gains the insurance labels (`policy owner`, `policy holder`, `insured person`, `insured name`, `life insured`, `life assured`, `proposer`); `insured` is deliberately **not** added bare, because `Sum Insured` is a money field and matching it here would tokenise the cover amount. A new label-anchored `policy_number` rule is added, on the same design as the existing folio rule and for the same stated reason: policy-number formats are not uniform, so a bare shape rule would be either uselessly narrow or would swallow premiums. `containsUnmaskedPii` now applies `maskText`'s **own per-match acceptance logic** — the same three conditions in the same order — so it answers the question it was always meant to ask: *would `maskText` still find something here to mask?* Fail-closed is preserved exactly: every genuinely unmasked value still matches, still fails the `[MASKED:` check, still satisfies its predicate, and is still reported.

The **folio** rule is deliberately left alone. It does not misfire on any fixture here, it is on Investment Intelligence's certified path, and tightening its gap could reduce real coverage on a column-aligned CAS. It is disclosed as a latent analogue (`M12B-O1`) rather than changed opportunistically.

`coverage_by_type` now reads `{policy_number: 1, person_name_label: 3, address_label: 1, aadhaar: 1, tax_id: 1, email: 1, phone: 1}` for INS-B13 — seven categories where there were none for INS-B05 and a mislabelled, label-destroying partial set for INS-B13.

### 6.5 `M12A-F2` — fixed, in shared core, as M12A recommended

M12A disclosed this and deliberately left it: an ambiguous-layout document **crashed the intake request** when the masking key is unset, because `maskText` fails closed by throwing — correct — and **nothing caught it**. The exception escaped `runExtractionPipeline` and the intake route, so the request never returned and the run was stranded in `masking`, a non-terminal state nothing downstream would ever retire.

**This phase hit the identical crash in Insurance's own corpus, which is what confirmed the three-adapter blast radius rather than assuming it.** It is fixed in `lib/aie/orchestrator.ts`, where M12A said it belonged.

**The fix is narrow because the path already existed.** The run now degrades down exactly the route the orchestrator already took for every other "no usable AI data" condition — kill switch, PII guard, budget exhaustion, provider timeout, refusal (GW-12) — over the **`masking -> reconciling` edge `stateMachine.ts` had already declared legal and that simply had no caller**. No new state, no new edge, no migration. The audit event is new, and `aie_audit_event.event_type` is plain `text not null` in migration `0140` with no CHECK constraint, as that file's own header already records for the purge events.

**Not `privacy_blocked`, and the distinction is load-bearing.** That state is terminal and means the masking **policy** refused this document. A missing environment key is a fact about the **deployment**, not a verdict about the document, and recording it as a terminal privacy refusal would permanently mark documents that are in fact fine.

**Proved on M12A's own corpus.** `FDH-A05` with no key now reaches `unresolved` with the blocking item `reconciliation_indeterminate:fdh_bank_statement_layout_certification` — **the same item the ephemeral-key run produces** — instead of hanging. M12A's test that asserted the crash was failing correctly and has been updated with the reasoning recorded in place; **every M12A metric is byte-identical**, and the only line that changed in `results.json` is that case's evidence. The fix is independently re-observed from a third adapter in §7's decision test, which runs Investment Intelligence with the key deliberately unset.

### 6.6 Results

| Adapter | Case | Egress | person name | tax id | aadhaar | email | phone | address | bank acct | IFSC | acct id | evidence survived | strict schema | store:false | verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| insurance | INS-B13 | 1 | PASS | PASS | PASS | PASS | PASS | PASS | n/a | n/a | PASS | 5/5 | yes | yes | PASS |
| insurance | INS-B05 | 1 | PASS | n/a | n/a | n/a | n/a | n/a | n/a | n/a | PASS | 3/3 | yes | yes | PASS |
| fdh-bank | FDH-A05 | 1 | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | PASS | 2/2 | yes | yes | PASS |

`n/a` means the source document contained no literal of that category — reported as `not_applicable`, **never as a pass**, because nothing was proved. The machine-readable form is `scripts/m12b-insurance-certification/privacy_proof.json`.

**Before the fixes**, the same table read: `INS-B05` **FAIL** (person name and account identifier both leaked); `INS-B13` **VACUOUS** (no payload built at all); `FDH-A05` PASS. Those are preserved in commit `5e1b2bd`.

**Financial evidence survived in every case** — 5/5, 3/3, 2/2. For FDH-A05 that specifically means **both candidate institution names survived**, which is what the AI-eligible gap ("which of these two banks is it?") actually needs; masking that destroyed them would have made the feature impossible while scoring perfectly on privacy.

**Two layers of insured-party handling, and they are different things.** The dispatch names "insured-party masking", and the honest answer has two halves. *Within the user's own tenant*, `insuredPersonName`, `policyOwnerName` and `beneficiaryName` are retained verbatim as **evidence-only field candidates** — RLS-scoped rows showing a user their own document's contents, never written to the canonical table because no column exists (per `documentCatalogue.ts`'s own schema-gap disclosure). *At the egress boundary*, all three are tokenised and none appears in the provider payload — which was **not** true before `M12B-F1` was fixed. The policy number is additionally masked at the parser layer (`policyNumberMasked`, last four visible) so even the in-tenant evidence never carries the full identifier.

**Tokenisation is unchanged and remains one-way HMAC only.** No reversible map exists, nothing this phase built claims to show an "original" value, and the only occurrences of `reversibleTokenMap`/`persistMaskTokenMap` anywhere in `lib/aie/` are comments recording their removal.

### 6.7 Strict schema — the failure path, driven

The dispatch requires "strict JSON schema; any schema failure means no result accepted". Both halves are asserted:

- **Declared:** every captured payload carries `response_format.type === 'json_schema'` with `strict: true` and a real schema body.
- **Enforced:** a syntactically valid response naming `coverAmount` — a field outside the Insurance adapter's closed enum — is driven through the real gateway. `validateAiOutput` rejects it, the gateway returns `schema_rejected`, and **`data` is `undefined`**. Nothing a violating response contained can be used. This is refused by schema *shape*, not by a policy check a call site could forget.

---

## 7. Section 7 — the Investment Intelligence AI fallback

### 7.1 The decision

> **No AI-eligible gap was introduced for Investment Intelligence.** II is certified as:
> **deterministic-first path certified; AI fallback structurally available but currently with no
> eligible extraction gap.** The dispatch names this as an acceptable state, not a defect, and
> this phase reached it by investigation rather than by default.

### 7.2 The current state, verified rather than assumed

`aiEligibleGaps` is unconditionally `[]` at both return sites in `lib/aie/adapters/investment-intelligence/parserAdapter.ts`; there is no code path that populates it. The file's own header records why: *every registered II parser either extracts a line completely or records a typed warning against it, and none has a concept of "this one field is missing, ask AI to fill it in".*

The consequence is **structural, not a disabled switch**, and this phase proved it by running the real pipeline rather than reading the gate: with the AI kill switch forced **ON** and the masking key deliberately **unset**, a real CAS document produces zero AI attempts, zero masking summaries, and a run whose recorded transitions never enter `masking`, `ai_pending`, `ai_running` or `privacy_blocked`. Forcing the switch on matters — with it off, every one of those assertions would have passed for the wrong reason.

### 7.3 The one candidate worth taking seriously, and why it fails

The dispatch named `M3-F1` — the M0–M11 mission's real but **explicitly unverified** hypothesis that a discarded opening balance on the CAS layout explains two of PC4's five production reconciliation residuals — and warned against assuming it is the answer. It was investigated against the code.

**What is actually there.** `camsParser.ts`'s `OPENING_BALANCE_RE` is `/^Opening Unit Balance\s*:\s*(\(?-?[\d,]+\.\d+\)?)\s*$/i` — **the figure is captured in a group**. The use site calls `OPENING_BALANCE_RE.test(line)` and `continue`s, so the capture is thrown away. Meanwhile the sibling certified parser `camsFolioStatementParser.ts` `.exec()`s the equivalent line and emits a real `adjustment` transaction with the captured units.

Now the dispatch's own four conditions:

| Condition | Verdict |
|---|---|
| (a) AI can clarify it from source evidence | **FAILS.** There is nothing to clarify. The figure is printed unambiguously, the regex already captures it, and a second certified parser in this very repository reads the identical concept correctly. Two certified parsers disagree about the same concept and one of them proves it is deterministically readable. This is a **discard defect with a deterministic fix**, not a field ambiguity — and AI cannot help with a value the deterministic layer already has in hand |
| (b) cannot alter canonical identity by guess | not reached |
| (c) cannot create tax-lot semantics | **FAILS.** An opening unit balance is a **position** figure. FS1 emits it as `adjustment` *specifically* so R6's `ACQUISITION_TYPE_MAP` excludes it from acquisitions; an AI-supplied units figure feeds the identical path and sits one mapping away from tax-lot semantics |
| (d) cannot override deterministic reconciliation | **FAILS, most decisively.** `reconcilePosition` computes `opening + delta` and compares it to the statement's printed closing balance. An AI-supplied opening balance would not sit *alongside* deterministic reconciliation — **it would be its input**, and would directly determine the very variance PC4's five residuals are measured in |

**A fourth, independent reason.** II's registered schema's closed enum is exactly `['sourceDescriptionClarification']`, and its own header states it "must never include any identity/instrument/currency/cost-base/FX field name". A units figure could not be carried through it without first widening the enum — which is the prohibition itself.

**One other candidate was considered and rejected.** `OA-9` records 251 `unparseable_transaction_row` findings emitted at severity `error`, of which PC4's own accounting classified all 251 as benign (77 boilerplate, 84 non-economic lifecycle markers, 90 regulatory footnotes). Asking AI to classify such a row as boilerplate-versus-real would determine whether the row is economically material, which directly affects what reconciliation counts — condition (d) again. PC4's own report already places that fix at the parser's severity assignment, deterministically.

### 7.4 The decision, pinned in code

`tests/unit/m12bIiAiFallbackGapDecision.test.ts` makes the decision a fact about the code rather than a paragraph in a report nobody re-reads. Each assertion names the condition it protects, so a future change that introduces a gap has to come back and argue with it.

One assertion is deliberately written to **fail the day someone fixes `M3-F1` deterministically**, and its comment says so: at that point it should be updated to record the defect closed — which only reinforces this section's conclusion.

**What this guards is narrow and intentional:** not that II may never have an AI gap — a future document class with a genuine per-field gap may earn one — but the specific failure the dispatch warns about, **fabricating a gap merely to turn AI green**.

---

## 8. Verification of the carried-forward state

### 8.1 The 15 prior documents

Inherited by branching from `62e08a9` rather than copied, so they are the same git objects, not copies that could drift. Verified by comparing the full `docs/investment-intelligence/` listing against M12A's own worktree: **identical file sets, 199 files**. The 15 mission documents M12A enumerated in its §8.1, plus `M12A_FDH_BANK_CLOSURE_2026-09-15.md` itself, are all present. With this document: **16**.

### 8.2 Migration numbering — verified fresh, not inherited

**File-level, across every ref in the repository** (`git log --all --diff-filter=A` over `supabase/migrations/`):

| Number | Owner |
|---|---|
| 0153 / 0154 / 0155 / 0157 | this mission's own lineage (PC5, HUF, PC6, PC7) |
| 0156 / 0158 | `fix/app-review-findings-2026-09-15` — unrelated |
| **0159** | **free** |

**Negative control:** a search for any file numbered `0159` or above, on any ref, returns **nothing** — so the method can distinguish "free" from "not looked". This confirms M12A's finding fresh and independently.

> **This phase created no migration and applied none, anywhere.** §5.5 and §6.5 show why none was needed, read from the migrations rather than asserted. **The next genuinely free number remains `0159`.**

### 8.3 Production and regression state

| Check | Result |
|---|---|
| `origin/main` | **`23b49da1d63c9c20f980ea9042e176845b6f60e3`** — unchanged |
| Pushed | **nothing.** The branch has no upstream configured at all |
| Merged | **nothing** |
| Production database | **never contacted** — this phase made no network request of any kind |
| Production configuration / deployment / rollout | **untouched** |
| Migrations applied or created | **0** |
| Secrets provisioned in any persisted config | **0.** No `.env.local` exists in this worktree; the masking key is unset in the process environment; the only key used anywhere is generated in-memory per test |
| Outbound provider calls | **0** — `fetch` is intercepted in the one test that reaches a provider |
| Full test suite | **17 files / 39 tests failing — file-for-file identical to the documented pre-existing baseline. Zero new failures.** 353 files / 7,385 tests passing (M12A: 350 / 7,352 — this phase adds 3 files and 33 tests) |
| PC4's 19-invariant regression contract | **85 files, 84 passed / 1 skipped, 1,673 passed / 5 skipped, 0 failed — byte-identical to M1's recorded baseline** |
| `tsc --noEmit` | clean |
| `eslint` on every changed file | clean |
| Tokenisation | untouched. One-way HMAC only; no reversible map exists |

**Every file this phase touched is under `lib/aie/`, `scripts/m12*` or `tests/`** — verified with a diff against `62e08a9`. Nothing under `lib/ai/` (Module 11) was modified, which is why the pre-existing `aiResidualClosureFailClosed` baseline failure is demonstrably not attributable to this phase.

---

## 9. Open items

| Id | Item | Owner | Detail |
|---|---|---|---|
| **`OA-6` (inherited)** | `AIE_MASK_TOKEN_ENCRYPTION_KEY` unset — re-confirmed fresh | PO / operator | The single reason INS-B05/INS-B13 are CONDITIONAL. Not provisioned by this phase, per the dispatch's more restrictive instruction |
| **`M12B-O1`** | The **folio** masking rule has the same latent line-crossing gap `M12B-F3` fixed in the person and address rules | disclosed, deliberately not fixed | It misfires on no fixture here, it is on Investment Intelligence's certified path, and tightening it could reduce real coverage on a column-aligned CAS. Changing it opportunistically, with no failing case to justify it, would be the wrong trade |
| **`M12B-O2`** | The real-provider **response** path is uncertified for both adapters | PO | The request half — the half the privacy question turns on — is fully proved (§6.6). Needs the PO's own key provisioning plus explicit authorisation for outbound spend. §6.2 |
| **`M12B-O3`** | `insurance_printed_fact_completeness` blocks a run for a **non-ISO renewal date**, which is a common real-world layout | PO product decision | Deliberately blocking rather than silently lossy (§5.5), and `correct` is offered on `renewalDate` so a reviewer can resolve it in one action. If live volume shows this is the dominant reviewer task, the right answer is to certify specific date layouts deterministically — **never** to make the adapter guess between DD/MM and MM/DD |
| **`M12B-O4`** | Insurance's adapter flags (`AIE_INSURANCE_ADAPTER_ENABLED`, `AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED`) and `AIE_REVIEW_CANONICAL_ACCEPTANCE_ENABLED` are OFF in every environment | operator, at activation | Certification does not change that, and should not. The corpus runs them ON **in-process only** |
| **`M12B-O5`** | Only the **bounded generic `Label: Value` layout** is certified; no real insurer's exact PDF layout has ever been sourced | disclosed, pre-existing | Inherited unchanged from AIE-1.4's own ELIG-05 disclosure. The corpus certifies that layout thoroughly; it does not certify any named insurer |
| **`M12B-O6`** | No OCR engine is wired in, so an image-only policy stays refused | disclosed, pre-existing | Inherited. Not in the corpus because there is nothing to certify |
| **`M3-F1` / `OA-10` (inherited)** | The CAS discarded opening balance | PO decision, then engineering | §7.3 establishes it is a **deterministic discard defect**, not an AI-eligible ambiguity — which removes one option from the PO's decision but does not make the decision |
| **`M12B-O7`** | This worktree's `node_modules` is a **directory junction** to M12A's worktree, created so the suite could run | housekeeping | Git-ignored, so it affects nothing committed. Left in place deliberately: removing it would leave the next phase unable to run the suite in this worktree without a fresh install |

---

## 10. Files changed

| File | Change |
|---|---|
| `lib/aie/orchestrator.ts` | `M12A-F2` — masking failure degrades to reconciliation instead of escaping the request |
| `lib/aie/audit.ts` | One new audit event type for that degradation; no migration needed |
| `lib/aie/masking/piiMasking.ts` | `M12B-F1`/`F2`/`F3` — insurance name labels, a new `policy_number` rule, the guard rewritten to mirror the masker's own logic, and line-crossing closed in two rules |
| `lib/aie/adapters/insurance/types.ts` | Two new evidence candidate names, with the reasoning |
| `lib/aie/adapters/insurance/parser.ts` | Emits the unread-printed-fact count and evidence |
| `lib/aie/adapters/insurance/reconciliation.ts` | New `insurance_printed_fact_completeness` rule |
| `lib/aie/review/reasonCodes.ts` | Reviewer-facing copy for that rule |
| `tests/support/buildM12bInsuranceCorpus.ts` | **new** — 14 sealed synthetic policy documents |
| `tests/support/aiePrivacyProofHarness.ts` | **new** — domain-agnostic egress-boundary privacy harness |
| `scripts/m12b-insurance-certification/oracle.json` | **new** — the sealed independent oracle |
| `scripts/m12b-insurance-certification/results{.json,_table.md}` | **new** — machine-readable results, regenerated by the suite |
| `scripts/m12b-insurance-certification/privacy_proof{.json,_table.md}` | **new** — machine-readable privacy results |
| `tests/unit/m12bInsuranceAccuracyCorpus.test.ts` | **new** — the corpus driver |
| `tests/unit/m12bAiPrivacyProof.test.ts` | **new** — the privacy proof for both adapters |
| `tests/unit/m12bIiAiFallbackGapDecision.test.ts` | **new** — section 7's decision, pinned |
| `tests/unit/aieInsuranceAdapterReconciliation.test.ts` | Six new tests for the completeness rule |
| `tests/unit/aieReviewRevalidate.test.ts` | Updated for the new always-emitted candidate — was failing closed, correctly |
| `tests/unit/m12aFdhBankAccuracyCorpus.test.ts` | M12A's crash assertion inverted, with the reasoning recorded in place |
| `scripts/m12a-fdh-bank-certification/results.json` | Regenerated; **every metric byte-identical**, only `M12A-F2`'s evidence line changed |

**Commits, in order, each readable on its own:**

| SHA | What |
|---|---|
| `a982006` | The corpus, oracle and driver, committed **with** the four defects they found (1 unexplained omission, 22.22% false accept, 14.29% false canonical write) |
| `5e1b2bd` | The privacy harness, committed **with** what it found (INS-B05 FAIL, INS-B13 VACUOUS) |
| `002a4cf` | Shared core: `M12A-F2`, `M12B-F1`, `M12B-F2`, `M12B-F3` |
| `8143762` | Insurance adapter: `M12B-F4`, `M12B-F5`; all three hard measures go to zero |
| `0ea617b` | Section 7's decision — declined, pinned |
| `fd1870d` | The two revalidate tests that were failing closed, correctly |

---

## 11. For the next M12 phase (PC4 financial-integrity closure)

1. **No blocker prevents PC4 financial-integrity closure from starting.** Nothing this phase changed touches Investment Intelligence's reconciliation, tax-lot or valuation engines — PC4's own 19-invariant contract re-runs byte-identical to M1's baseline, and §8.3 shows every changed file is under `lib/aie/`, `scripts/` or `tests/`.
2. **One PC4-relevant conclusion is now settled, and it removes an option rather than making a decision.** `M3-F1` is a **deterministic discard defect**, not an AI-eligible ambiguity (§7.3): `camsParser.ts` already captures the figure and throws it away, while the sibling FS1 parser reads the identical concept correctly. Whether to fix it, and whether it explains any of PC4's five residuals, remains a Product-Owner decision and an unverified hypothesis — but "let AI resolve it" is off the table, with reasons.
3. **Two things still need the Product Owner before the AI half of AIE-1 can be certified anywhere**, and neither is engineering work: provisioning `AIE_MASK_TOKEN_ENCRYPTION_KEY`, and authorising an outbound provider call against the configured credential. Until then the AI clarification stays uncertified for Insurance **and** FDH-bank.
4. **The shared AIE-1.1 core now has one fewer carried-forward defect and three fewer masking defects**, and all four fixes are covered by tests that fail loudly if reverted. `M12A-F2` is closed; a future phase should not re-disclose it.
5. **Ask the third question.** It worked twice in a row. M12A's most valuable case was the follow-up nobody asked for, and so were this phase's: `INS-B12` exists only because `INS-B11` passed and the obvious next question — *what if the second component is under a label the taxonomy cannot see?* — turned out to be a real false canonical write; `INS-B14` asked the same question of a date and found a second one. The equivalent question for whatever the next phase certifies is worth finding before certifying it.
6. **Do not trust a zero until you have made the harness produce a non-zero.** Two separate metrics in this phase were vacuous before they were real: the privacy harness scored a case `pass` when no payload had been built at all, and the false-canonical-write rate would have read zero if the fake had mirrored `transitionRunStatusCas` instead of `recordTransition`. Both are now structurally prevented — `VACUOUS` is a distinct verdict, and the accept path is exercised on every case — but the general lesson is the one worth carrying.

---

*End of M12B closure report. Nothing is pushed. Nothing is merged. No production database, configuration, migration, deployment or rollout was touched, no secret was provisioned in any persisted config, and no outbound network request was made.*
