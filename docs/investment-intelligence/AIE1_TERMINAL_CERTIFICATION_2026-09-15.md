# AIE-1 — Terminal Integration and Certification (M5)

**Mission:** FHIP — Investment Intelligence + AIE-1 Convergence, Master End-to-End Execution
**Phase:** M5 (Phase 6 of 11) — AIE-1 terminal integration and certification (Part L of the master dispatch)
**Date:** 2026-09-15
**Branch:** `mission/m5-aie-terminal-2026-09-15`, branched from M4B's tip `154542f190118c4014b3d034d4ef3630166e17ec`
**Carried forward:** the 8 prior phase documents (M0×2, M1×2, M2, M3, M4, M4B), verified byte-identical by SHA-1 against Phase 6's source worktree

**Nothing was pushed. Nothing was merged to `main`. No production database was written. No
production canary was run. No AWS resource was created. No migration was created or applied. No
credential value, API key, PAN, folio number, holder name or raw statement text appears anywhere
in this document, and the AWS account id is redacted wherever AWS quoted it back in an error.**

---

## 0. Headline

> ### AIE-1 — CONDITIONAL PASS. **NOT** production ready.
>
> Part L.10 permits `AIE-1 — UNCONDITIONAL FULL PASS — PRODUCTION READY` only when *"every
> mandatory in-scope adapter and shared control has evidence and no named dependency remains
> unresolved."* Four named dependencies remain unresolved, three of them operator-owned, and one
> newly-found defect had to be fixed inside this phase before the production rollout gate could
> even be described as operable. **That verdict is therefore not available, and this report does
> not award it.**
>
> **What is genuinely strong.** The shared gateway, the cost ledger, the prompt-injection
> defences, the one-way HMAC masking, the purge/retention lifecycle and the Investment
> Intelligence dispatch path are real, exercised, and re-proved fresh this phase against the real
> DEV project — 61 test files / 877 tests passing, a real OpenAI call returning strict structured
> output, and a live-DEV run whose 2 intakes, 2 runs, 4 candidates, 5 reconciliation runs, 2
> unresolved items and 2 storage objects were created, purged and then independently re-queried
> to zero residue across 8 tables.
>
> **What is not.** There is no malware scanner anywhere in this system and, by construction,
> there cannot be one in the configuration a production activation would have to use. Traceability
> against the Product Owner's own 2,214 numbered AIE requirements is **15.5%**, so L.3's *"no
> orphan requirements"* is not merely unmet — **1,870 requirements are unaccounted for**. Both
> migrations this mission left with the Product Owner are **still unapplied**, on DEV *and* on
> production. And the FDH-bank and Insurance adapters, which L.6 asks this phase to certify, were
> **not built, modified or re-certified by any phase of this mission** — they are byte-identical
> to the branch merged in at Phase 3.
>
> **Three corrections to beliefs this mission had been carrying forward** are recorded in §1.
> Each was found by re-verifying rather than inheriting, and each makes the picture *different*,
> not merely worse.

---

## 1. Three carried-forward beliefs that are wrong, corrected

The dispatch for this phase restated several facts as settled. Under the Part W standard
("never claim 'already proven' without re-verifying against the CURRENT state") each was
re-checked. Three did not survive.

### 1.1 "AI fallback is unreachable behind two independent blockers" — TRUE FOR INVESTMENT INTELLIGENCE ONLY

M3 established two independent blockers for the masked-AI path: the unset masking key
(operator-owned), **and** the fact that no parser declares an AI-eligible gap. M3 stated that
second blocker correctly and narrowly — *"no **Investment Intelligence** parser declares an
AI-eligible gap"*. By M4 and this phase's own dispatch it had been generalised to *"no II parser
declares any AI-eligible gap (`aiEligibleGaps: []` everywhere)"*.

**"Everywhere" is false.** Verified fresh in the current tree:

| Adapter | `aiEligibleGaps` | Reachable? |
|---|---|---|
| Investment Intelligence (`adapters/investment-intelligence/parserAdapter.ts:194`) | `[]` unconditionally | **No** — structurally unreachable |
| **FDH bank statement** (`adapters/fdhBankStatement/parser.ts:126`) | **`[INSTITUTION_HINT_FIELD_NAME]`** on an `ambiguous` layout, with `outcome: 'partial'` | **Yes** |
| **Insurance** (`adapters/insurance/parser.ts:217`) | **`['policyNameClarification']`** when the product name is missing, with `outcome: 'partial'` | **Yes** |

`orchestrator.ts:178` gates masking on `current === 'deterministic_partial' && aiEligibleGaps.length > 0`.
Both of those branches satisfy it.

**Consequence.** For AIE-1 as a whole the masked-AI path is blocked by **ONE** dependency — the
unset `AIE_MASK_TOKEN_ENCRYPTION_KEY` plus provider/flag configuration — not two. The second
blocker is real but II-scoped. This matters in both directions: clearing the key does **not**
light up II's AI fallback (it stays unreachable), but it **does** light up FDH-bank's and
Insurance's, on adapters this mission never exercised. That is an argument for caution about the
key, not only an argument for supplying it.

### 1.2 M2's H.6 live provider evidence is no longer reproducible as recorded

M2 recorded H.6 as **PASS**, on 6 real OpenAI calls and a committed 4/4 opt-in proof. Re-run
today against the current tree, with the environment exactly as it is:

```
Test Files  1 failed (1)
     Tests  3 failed | 1 passed (4)
Error: AIE_MASK_TOKEN_ENCRYPTION_KEY is not set or is not a 64-character hex string (32 bytes).
```

This is **not a regression in safety** — it is the fail-closed design working exactly as intended.
It is a change in what the evidence proves. M2's proof ran when masking used counter-based tokens
that derived nothing from a key; M3 then replaced that with the keyed one-way HMAC
(`identifierToken.ts`), which requires the key and throws without it. So the recorded 4/4 cannot
be reproduced on the environment as configured, and citing it unqualified would be citing a
result the current system does not produce.

**Re-proved properly** (§L.4): supplying an **ephemeral, in-memory, per-run** key — generated by
the runner, never printed, never written to disk, never committed, and explicitly *not* a
provisioning action — the suite returns **4/4 PASS with a real OpenAI call**. That is the honest
form of the evidence: *the code path works; the environment is still unconfigured.* Operator item
**OA-6** stays open and is reported open.

### 1.3 Accessibility tooling is NOT absent — but screen-reader tooling still is

Prior phases recorded accessibility as unverifiable for want of tooling. `@axe-core/playwright`
is in fact **declared in `package.json` and installed**, and the pre-existing AIE closure mission
used it for real against two AIE review states. What is genuinely unavailable in this environment
is a **screen reader** (NVDA/JAWS/VoiceOver) — and axe-core is a rule engine, not a screen
reader. The distinction is carried through §L.2 rather than collapsed in either direction.

---

## 2. Evidence index — L.1 to L.10 at a glance

| ID | Item | Verdict |
|---|---|---|
| **L.1** | Terminal preconditions | **4 of 11 MET** — 3 partially, 4 not met. Certification proceeds as *assessment*, which is what L.1 asks for. |
| **L.2** | Manual screen-reader gap | **NOT APPLICABLE (tooling)** for screen-reader; **CONDITIONAL** for automated — 1 real a11y defect found and **fixed** |
| **L.3** | Full AIE traceability matrix | **FAIL** — 344/2,214 traced (15.5%); **1,870 orphans**; zero requirement ids cited in any live-DEV suite |
| **L.4** | Real AI provider security suite | **PASS** — 12/12 required cases; 4/4 live against real OpenAI; 186 tests across the 11 named suites |
| **L.5** | Malware suite | **FAIL (structural)** — no scanner exists, and activating intake *requires* opting into the no-scanner posture |
| **L.6** | Accuracy corpus | **CONDITIONAL PASS (II only)** — II fully measured; **FDH-bank and Insurance entirely pre-existing and not certified by this mission** |
| **L.7** | Privacy proof | **PASS (II)** / **NOT EXERCISED (FDH, Insurance)** — no raw PII egress, re-proved live |
| **L.8** | Purge proof | **PASS** — all six clauses, re-proved fresh on a real DEV storage object, zero residue |
| **L.9** | Production rollout gate | **CONDITIONAL PASS after a fix** — the gate was **inoperable in production**; found, fixed, disclosed |
| **L.10** | AIE terminal verdict | **CONDITIONAL PASS — NOT production ready** |

---

## 3. L.1 — Preconditions, assessed honestly

L.1 lists eleven preconditions for beginning terminal certification. The dispatch instructs that
the job is to determine whether a meaningful verdict is reachable given that several are known
unmet — not to pretend they are met.

| # | Precondition | State | Evidence |
|---|---|---|---|
| 1 | Shared gateway is integrated | **MET** | `AieDocumentAiGateway` is the single egress seam; all four intake routes inject it and none holds a direct provider reference. 14 gateway tests pass. |
| 2 | Real OpenAI provider works in DEV | **MET** | 4/4 live proof this phase, real HTTP 200, strict `json_schema` honoured (§L.4) |
| 3 | AWS S3 / GuardDuty live path works in DEV | **NOT MET** | Zero AWS permissions; 6 candidate buckets provably nonexistent; no `aws-sdk` dependency exists; `decideScanResult` has zero production callers (§L.5) |
| 4 | Purge / retention works | **MET** | Re-proved live this phase — delete, independently verify absent, then record; 48h mask-token TTL fires on age alone (§L.8) |
| 5 | Investment II HTTP path works | **MET** | 6/6 live-DEV, re-run fresh this phase (§L.6/L.8) |
| 6 | FDH path certified for its approved scope | **PARTIAL — and not by this mission** | Pre-existing CONDITIONAL verdict on `feature/aie-1-final-closure`; zero diff since (§L.6) |
| 7 | Insurance path certified | **PARTIAL — and not by this mission** | Same; AIE-1.4 is FULL for Insurance only, 8 classes deferred, 1 prohibited |
| 8 | PC5 integration exists and uses AIE unresolved truth | **PARTIAL** | Built and 41/54 live scenarios pass, but 13 remain blocked on unapplied `0153` (§5) |
| 9 | Migrations reconciled | **NOT MET** | `0153` and `0154` unapplied on DEV **and** production; the 11-migration AIE block remains applied to both databases while absent from `main` |
| 10 | Accessibility automation present | **MET (partially exercised)** | `@axe-core/playwright` installed; 2 of the named AIE review states scanned by the pre-existing closure mission; PC5's 2 new screens unscanned (§L.2) |
| 11 | Production rollout gate present | **MET only after this phase's fix** | The gate existed in code but could not take effect in production at all (§L.9) |

**4 MET · 4 PARTIAL · 3 NOT MET.** A terminal *verdict* is still meaningful — the controls that
protect user financial truth are the ones with the strongest evidence — but a terminal *pass* is
not available, and §L.10 says so plainly rather than grading on a curve.

---

## 4. L.2 — Accessibility and the screen-reader gap

**Screen-reader pass: NOT APPLICABLE — tooling genuinely unavailable.** No screen reader exists
in this headless environment. L.2's own instruction is followed exactly: *"do not falsely claim
it ran — record it as an operational/tooling evidence limitation."* It is recorded as one. No
phase of this mission has ever run a screen reader, and none has claimed to.

**Automated pass: partially present, and one real defect found and fixed.**

The dispatch asks specifically whether review screens *"correctly show 'not recoverable' rather
than attempting to show original values"* after Phase 4's one-way-HMAC decision. **They do —
verified directly:**

| Surface | Copy | Reveal affordance |
|---|---|---|
| `components/aie/review/EvidenceReveal.tsx:77` | `masked {label} — not recoverable` | **Removed**, not disabled |
| `components/aie/review/EvidenceReveal.tsx:87` | `masked — not recoverable` | — |
| `components/pc5/ResolutionDetailClient.tsx:236` | *"Masking here is one-way, so the original cannot be shown again — not by you and not by us."* | None exists |
| `components/pc5/ResolutionDetailClient.tsx:456` | *"(masked; cannot be shown unmasked)"* | None exists |

No component anywhere in the AIE or PC5 surface says "original value", "hidden value", or offers
a control that could imply recovery. **PASS.**

### 4.1 M5-F1 — PC5's two new screens announced nothing to assistive technology. **FIXED.**

The pre-existing AIE review UI has a proper polite live region
(`RunReviewPanel.tsx:246` — `role="status" aria-live="polite" class="sr-only"`). **Neither of
PC5's two new client components had one for its load transition.** Both render a bare
`<p>Loading…</p>` and then swap it for content, so a screen-reader user following a deep link to
a resolution hears nothing at all — no announcement that the page finished loading, and no way to
know content had arrived short of re-navigating.

`ResolutionDetailClient` already had `role="status"` on its post-decision **success** message
(`:248`), so the defect was confined to the load transition; `ResolutionCentreClient` had no live
region of any kind.

**Fixed** by making the loading placeholder itself the live region in both components, following
`RunReviewPanel.tsx`'s existing pattern rather than inventing a second one. `tsc --noEmit` clean;
full suite unchanged (§8).

### 4.2 What remains open on accessibility

A **meaningful** automated axe pass over PC5's resolution states is itself blocked twice over: it
needs the full app stood up with authentication and a seeded unresolved item, **and** the
decision affordances it would most want to audit (the `choose_value` radio groups, the ownership
allocation inputs) only become interactive once migration `0153` is applied. Recorded as
**M5-OPEN-1**, not attempted and not claimed.

---

## 5. L.3 — The full AIE traceability matrix

### 5.1 Method, and why it is measured rather than asserted

L.3 requires every AIE-1.0 → AIE-1.6 requirement to map onto a code artifact, a migration where
relevant, an automated test, live-DEV evidence where required, security/privacy evidence, a
production enablement state and a residual risk — with **no orphan requirements**. Every prior
report asserted coverage narratively. With 2,214 numbered requirements, a narrative assertion is
not checkable and neither is a hand-written table.

`scripts/m5_aie_traceability_matrix.mjs` measures it. It reads the seven Product-Owner
specification files (still present, unchanged since M0), extracts **requirement identifiers only
— never requirement text, never data**, and indexes every citation of those identifiers across
2,942 repository files, bucketed by artifact kind.

**Two measures are reported, and the flattering one is not chosen.** This codebase cites
requirements in short form (`GW-03`, `QUA-05`, `PII-06`) with the phase prefix dropped, so a
fully-qualified match alone is a severe undercount; but a short form is ambiguous across phases
(`COST-01` is defined by four of them), so short-form matching over-credits. Both bounds are
given.

### 5.2 Result

```
Phase    Reqs   code   test   liveDev  migr   traced  ORPHAN  cover%   strict%
AIE-1.0  258    24     13     0        6      49      209     19.0     2.7
AIE-1.1  332    59     21     0        22     75      257     22.6     0.6
AIE-1.2  334    12     5      0        6      27      307     8.1      0.3
AIE-1.3  346    24     13     0        6      37      309     10.7     3.8
AIE-1.4  286    19     13     0        3      41      245     14.3     5.2
AIE-1.5  322    68     23     0        5      83      239     25.8     4.7
AIE-1.6  336    13     11     0        4      32      304     9.5      0.0
TOTAL    2214   219    99     0        52     344     1870    15.5     2.4
```

**344 of 2,214 requirements (15.5%) are traceable to any repository artifact. 1,870 (84.5%) are
orphans.** L.3's "no orphan requirements" is **FAIL**, and not marginally.

Three subsidiary findings inside that number:

- **`liveDev` is ZERO for every phase.** Not one AIE requirement id is cited in any
  `tests/live-dev/` suite. The live-DEV proofs are real and they pass — but nothing connects them
  to the requirements they discharge, so L.3's "live-DEV evidence where required" column cannot
  be populated from evidence at all.
- **AIE-1.6 has the worst coverage and a strict score of 0.0%** — not a single `AIE16-*`
  identifier appears anywhere in the repository. AIE-1.6 is the *production cost, security and
  accuracy certification* phase; it is the one whose requirements a terminal verdict most needs
  to discharge.
- **AIE-1.2 (Investment Intelligence) is 8.1%**, the lowest of the adapters, despite being the
  adapter this mission worked on hardest.

### 5.3 What this does and does not prove — stated before anyone over-reads it

Citation-based traceability is a **proxy**. A requirement can be correctly implemented without its
identifier appearing in a file, and this codebase's convention of citing governing ids in module
headers is followed unevenly rather than universally. So 15.5% is **not** a claim that 84.5% of
AIE-1 is unimplemented — that would be a serious misreading, and the conformance evidence in
§L.4–L.9 plainly contradicts it.

What it **is**: the honest answer to the only question L.3 can be automated to answer — *is any
requirement completely unaccounted for?* For 1,870 of them, yes. A terminal certification that
claims to have discharged 2,214 requirements cannot rest on evidence that connects to 344 of
them.

### 5.4 A harness defect in this very script, disclosed

The first run reported 2.4% coverage — an artifact of matching only fully-qualified ids. The
second run, after adding short-form matching, reported **100.0% coverage with zero orphans on
both measures**. That was wrong in the reassuring direction: the script writes its results to
`scripts/m5-aie-traceability-matrix.json`, `scripts/` is one of its own scanned roots, and the
second run found all 2,161 orphan ids from the first run "cited" — by its own previous output.

It was caught because the *strict* column jumped 2.7% → 100.0%, which no citation-convention
change could explain. A self-contamination guard now excludes the output file by name, the script
is verified idempotent across consecutive runs, and the finding is recorded here rather than
quietly corrected. **Independently spot-checked afterwards by hand**: `AIE11-API-01`, `API-01`,
`AIE16-ATOM-01`, `ATOM-01`, `AIE12-ACCT-01`, `ACCT-01` return 0 citing files by direct grep;
positive controls `EXC-08` (11 files), `GW-03` (5), `QUA-03` (2) return real ones.

---

## 6. L.4 — Real AI provider security suite

Consolidated from Phase 3's work and **re-verified fresh against the current tree**, as the
dispatch directs. All twelve required cases:

| # | L.4 case | Result | Evidence (re-run this phase) |
|---|---|---|---|
| 1 | Masking before egress | **PASS** | Orchestrator masks, then the gateway **independently re-scans** and returns `unmasked_pii_detected` before any reservation or provider call. 30 masking tests. |
| 2 | Prompt injection | **PASS** | `aieM2PromptInjection.test.ts` — **8 tests**; a model that fully obeys the injection still yields `schema_rejected` with no `data` |
| 3 | Refusal | **PASS** | `refusal` checked before content is read; typed `refused`, no `data` |
| 4 | Malformed JSON | **PASS** | `aieAiGateway.test.ts` — 14 tests |
| 5 | Schema-valid but financially impossible | **PASS** | An invented value that *does* satisfy the schema remains a candidate and never a write — four independent guards |
| 6 | Timeout | **PASS** | 20s bound; typed failure |
| 7 | Retry | **PASS** | Hard-capped at 2 (`Math.min(raw, 2)`), not operator-raisable |
| 8 | Kill switch | **PASS** | Live proof returns `kill_switch_blocked` against the **real** provider |
| 9 | Cost ceiling | **PASS** | `budget_exhausted` returned before `executeOnce` |
| 10 | Concurrent admission | **PASS** | PGlite-on-real-Postgres proof, 5/5; M2's 12-parallel live proof admitted exactly 4 of 12 with `reserved_usd` exactly 1.000000 |
| 11 | Concurrent settlement | **PASS** | `for update` row lock (`0152`); idempotent repeat settlement proved |
| 12 | Provider unavailable | **PASS** | `costAdmission.ts` returns `admitted: false` on RPC error — fails closed |

**In every unsafe case the result is no canonical write**, enforced by four independent guards
(gateway Zod re-validation → orchestrator success-branch-only → reconciliation blocking item →
acceptance gate server-side re-check with CAS).

**Fresh counts, this phase:**

| Suite | Tests |
|---|---|
| `aieAiGateway` | 14 |
| `aieCostAdmissionPglitePostgresProof` | 5 |
| `aieFileValidation` | 18 |
| `aieGuardDutyScanResultHandler` | 15 |
| `aieIdentifierTokenOneWay` | 13 |
| `aieM2PromptInjection` | 8 |
| `aieM3InvestmentCorpusAccuracy` | 57 |
| `aieMaskTokenTtl` | 8 |
| `aiePiiMasking` | 30 |
| `aiePilotCohort` | 8 |
| `aiePurgeService` | 10 |
| **Total** | **186 tests, 0 failures** |

**Live, real provider, this phase:** `tests/live-dev/aieM2RealProviderProof.live.test.ts` —
**4/4 PASS**. Real `OpenAiAieProvider` (asserted `.not.toBeInstanceOf(MockAieProvider)`), real
HTTP 200, `strict: true` json_schema honoured, 7 PII sentinels asserted absent from the
pre-egress payload, usage and cost recorded. Run under an ephemeral masking key per §1.2; the API
key was never printed.

---

## 7. L.5 — Malware suite

### 7.1 The decision function is good, and it is dead code

`decideScanResult` (`lib/aie/malware/scanResultHandler.ts:89`) is pure, ordered defensively and
fails closed, with **15 unit tests** covering L.5's cases: clean, threats-found, FAILED, SKIPPED
(UNSUPPORTED and ACCESS_DENIED), wrong bucket / account / region / key, stale versionId, eTag
mismatch, duplicate delivery, past-deadline, unrecognised enum, and identity-before-content
ordering.

**Re-verified fresh: it has zero production callers.** A repository-wide search for
`decideScanResult` returns its own definition line and its test file, and nothing else. There is
no `aws-sdk`/`@aws-sdk` dependency in `package.json`, and no S3 client anywhere under `lib/` or
`app/`. `lib/aie/storage.ts:21` uses Supabase Storage (`AIE_QUARANTINE_BUCKET = 'aie-document-quarantine'`).

This is precisely the dispatch's own non-FULL-PASS condition: *"A pure decision function with no
production caller is not FULL PASS."*

### 7.2 AWS, re-probed fresh 2026-09-15 — unchanged

| Probe | Result |
|---|---|
| `sts:GetCallerIdentity` | **OK** (requires no policy) — `arn:aws:iam::<ACCOUNT_REDACTED>:user/Amar` |
| `s3:ListAllMyBuckets` | `AccessDenied` |
| `guardduty:ListDetectors` (ap-southeast-2) | `AccessDeniedException` |
| `guardduty:ListDetectors` (us-east-1) | `AccessDeniedException` |

Six candidate bucket names probed directly — `fhip-aie-quarantine-{dev,prod,}` (the IAM policy's
name) and `aie-document-quarantine-{dev,prod,}` (the runbook's name): **all six 404 Not Found.**
The discrimination control holds — `nyc-tlc` (exists, not ours) returns **403 Forbidden**,
`zz-no-such-bucket-m5-20260915` returns **404**. Against a globally unique namespace, 404 means
genuinely nonexistent.

### 7.3 What CAN be proven — and the sentence that decides L.5

The quarantine the codebase actually has is a **Supabase Storage fail-closed admission gate**,
and it is substantive: `lib/aie/validation/fileValidation.ts` (**18 tests**) does magic-byte/MIME
validation, size bounding, embedded-`/JavaScript` and `/Launch` detection **including inside
deflate-compressed streams**, polyglot detection via trailing content after `%%EOF`, a
decompression-bomb budget, and `/Encrypt` detection. That is real structural defence a signature
engine would not catch anyway.

**It is not a malware scanner, and this report does not claim it is one.**
`scanForMalwareSignatures()` is an explicit, disclosed stub. Its policy is that *"no scanner is
configured" IS a scanner failure*, so it fails closed — **unless** the caller opts in via
`AIE_ALLOW_MISSING_SIGNATURE_SCANNER`. All four intake routes pass
`allowMissingSignatureScanner: isMissingSignatureScannerAllowed()`.

> **The consequence, stated once and plainly.** With the flag unset — the default, and the only
> fail-safe posture — **every document is rejected at admission and AIE intake does nothing at
> all.** Therefore *any* production activation of AIE document intake **necessarily requires
> explicitly opting into the "no signature scanner is configured" posture.** There is no
> configuration of this system, today, in which a real malware scan runs on an uploaded document.
> That is not a gap to be closed by more testing; it is the current architecture.

| L.5 case | Decision function | Live pipeline |
|---|---|---|
| Clean PDF | **PASS** | **N/A** — no scanner runs |
| Safe malware-test signature (EICAR) | **NOT RUN** — no bucket to place it in, no scanner to read it | **FAIL** |
| Missing scan result | **PASS** | unreachable |
| Stale result | **PASS** — strongest control in the file | unreachable |
| Wrong bucket / key / account / region | **PASS** (4 tests) | unreachable |
| Duplicated event | **PASS** | **FAIL** — no idempotency ledger exists |
| Unrecognised enum | **PASS** | unreachable |
| Scan service unavailable / timeout | **PASS** | unreachable |

**L.5 verdict: FAIL (structural).** Not for want of effort or evidence — the decision logic would
pass on its own merits. The flow it decides for does not exist, and the substitute admission gate
must be run in its disclosed no-scanner mode for the product to function at all.

---

## 8. L.6 — Accuracy corpus, and the FDH/Insurance provenance question

### 8.1 Investment Intelligence — measured, and the numbers hold

`tests/unit/aieM3InvestmentCorpusAccuracy.test.ts` — **57 tests, re-run fresh this phase, all
pass**, over a 10-fixture corpus with hand-written oracles sealed before implementation, plus a
mutation proof that a deliberately-wrong oracle fails.

| L.6 metric | Result |
|---|---|
| Field precision / recall | **100%** on all 8 clean fixtures, compared as `(date, type, units)` triples **in both directions** |
| Document classification accuracy | 100% — including a negative control where an unclaimed document is **refused**, not guessed |
| Financial reconciliation accuracy | **variance exactly `0`** — not merely within tolerance |
| Unresolved rate | 2 of 10 fixtures by design (both negative controls, correctly detected) |
| **False-accept rate** | **0** |
| **False-canonical-write rate** | **0** |
| Avg / p95 provider tokens and cost | **NOT MEASURABLE for II** — zero AI calls occur on any II fixture (`aiWasUsed === false`, asserted). The one measured figure available anywhere is M2's instrumented probe: 261 prompt + 37 completion = 298 tokens, $0.00006135 |
| Deterministic-only vs AI-fallback proportion | **100% deterministic / 0% AI** for II, structurally (§1.1) |

### 8.2 FDH-bank and Insurance — the finding the dispatch asked for

The dispatch asks this phase to establish whether FDH/Insurance AIE work came from this mission
or from the pre-existing `feature/aie-1-final-closure` branch merged in at Phase 3. **Answered
definitively by git:**

```
git diff --stat 74b7a5e HEAD -- lib/aie/adapters/fdhBankStatement lib/aie/adapters/insurance \
                                 app/api/aie/fdh-bank app/api/aie/insurance
  (no output — zero changed files, zero changed lines)
```

**Byte-identical.** Broadening to the whole AIE/PC5 surface: 39 files at the AIE closure tip,
67 at HEAD — **28 files added**, and every one of them is Investment Intelligence dispatch
(`adapters/investment-intelligence/{context,disagreement,dispatch,documentFactsSchema,householdContext,ownerMatching,rehydrate}.ts`
plus 2 routes) or PC5 (`lib/pc5/*` ×14, `app/api/pc5/*` ×5).

> **Conclusion.** The FDH-bank and Insurance AIE adapters were **not built, not modified, and not
> re-certified by any phase of this mission.** Parts I and J were split, and **J was never
> dispatched as its own phase**, so no phase ever owned them. Their verdicts remain exactly what
> `feature/aie-1-final-closure` recorded — **AIE-1.3 CONDITIONAL, AIE-1.4 FULL for Insurance only
> (8 classes deferred, 1 PROHIBITED)** — carried forward unexamined.

Their test coverage exists but is adapter-unit level, not an accuracy corpus with sealed oracles:
`aieFdhBankStatementParser` 8, `aieFdhBankStatementReconciliation` 11,
`aieInsuranceAdapterParser` 16, `aieInsuranceAdapterReconciliation` 9. **No FDH or Insurance
accuracy corpus exists** — `tests/support/` holds `buildAieInsuranceFixtureText.ts`,
`buildBankPdfFixture.ts` and `buildM3InvestmentCorpus.ts`, and only the last is a corpus with
oracles. There is no measurable precision/recall, false-accept rate or cost profile for either
adapter.

**L.6 verdict: CONDITIONAL PASS, Investment Intelligence only.** Recorded as **M5-OPEN-2**.

---

## 9. L.7 — Privacy proof

**Re-verified fresh; nothing has regressed.**

| Egress surface | II | FDH-bank | Insurance |
|---|---|---|---|
| Provider request | **PASS** — 7 PII sentinels asserted absent pre-egress, live, this phase | **NOT EXERCISED** | **NOT EXERCISED** |
| Provider logging wrapper | **PASS** — field *names* only (`aie_ai_completion_attempt`) | same | same |
| Application logs | **PASS** — errors sanitised before recording; no signed URL or host detail can reach the audit trail | same | same |
| Error reporting payloads | **PASS** | same | same |
| Analytics telemetry | **PASS** — none exists in `lib/aie` | same | same |
| Generated certification reports | **PASS** — this document and all 8 carried-forward documents contain no PAN, folio, holder name or raw statement text |

Two independent gates with no bypass: the orchestrator masks and passes only `masking.maskedText`;
the gateway **independently re-scans** and returns `unmasked_pii_detected` *before* any reservation
or provider call. `requestFieldCompletion` has exactly one production caller.

**Tokenisation is one-way HMAC only, re-confirmed structurally.** `tokenMapCrypto.ts` does not
exist; `persistMaskTokenMap` and `findMaskTokenCiphertext` are gone; `revealMaskedToken` refuses
with `not_revealable_one_way_masking`; `aie_mask_token_map` holds **0 rows on DEV and 0 on
production**. 13 tests in `aieIdentifierTokenOneWay` assert the output is not any unkeyed digest,
that changing only the key changes the output, and that an untenanted call throws.

**The FDH/Insurance columns read NOT EXERCISED for the same reason throughout: their AI path has
never been run.** Per §1.1 it is now *reachable* — so the moment the masking key is provisioned,
these two adapters would begin egressing to a provider on a path this mission has never tested.
That is the sharpest single argument in this report for not treating the key as a routine
operator task.

---

## 10. L.8 — Purge proof

All six clauses, **re-proved fresh this phase** against the real DEV project — not cited from
Phase 4.

| L.8 clause | Result | Evidence |
|---|---|---|
| Success-path immediate purge after accepted canonical write | **PASS** | `accept.ts` deletes immediately after the write succeeds |
| Abandoned / failed backstop purge | **PASS** | `enforceAieRawFileHardBackstop` selects on **age alone, no status filter** — asserted, because that is the point |
| Purge idempotency | **PASS** | `aiePurgeService` 10 tests |
| Storage delete independently verified | **PASS** | Live L4 — `purge result=deleted`, object confirmed gone by an independent re-listing |
| DB bookkeeping not advanced before storage absence verified | **PASS** | Order asserted **by position in the source**, so a reordering fails the test |
| No orphan mask-token maps | **PASS** | Live L5 — a 72h-old row on a **non-terminal** run deleted, `ttlHours=48`; live L6 negative control — a row inside the TTL **survives** the same sweep |

**M2's purge-sweep defect is still fixed**, re-verified: all three update results are checked and
route to `failAttempt`, and the terminal status is decided in one shared helper so the two call
sites cannot drift apart again.

**Live-DEV run, this phase** (`tests/live-dev/aieM3InvestmentDispatchLiveDev.test.ts`, **6/6 PASS**):

```
[M3 L1] run=da192224 status=unresolved candidates=4 recon=3 items=1
[M3 L3] run=fafd4d85 status=unresolved rollForwardFail=1 delta=-75
[M3 L4] purge result=deleted        (object independently re-listed and confirmed absent)
[M3 L5] runStatus=unresolved ttlHours=48 deleted=1
[M3 CLEANUP] created:  {intakes:2, runs:2, candidates:4, reconciliationRuns:5,
                        unresolvedItems:2, auditEvents:0, storageObjects:2}
[M3 CLEANUP] residue:  {aie_document_intake:0, aie_extraction_run:0, aie_audit_event:0,
                        aie_unresolved_item:0, aie_field_candidate:0,
                        aie_reconciliation_run:0, storage_objects:0, auth_users:0}
```

Residue is **re-queried from the database**, not inferred from deletes having returned success.
Zero rows written to production.

---

## 11. L.9 — Production rollout gate

### 11.1 What exists

`lib/aie/featureFlags.ts` implements a deliberately narrow, AIE-scoped cohort gate rather than a
generic platform-wide percentage system — which is what L.9 asks for. **27 `AIE_*` variables**
exist. All default OFF; `isAiePilotCohortEnforced()` requires an explicit `'true'`; an
enforced-but-empty allowlist admits **nobody** (fail-closed). All four intake routes check
adapter flag → intake flag → cohort **server-side, before admission**. 8 tests.

| L.9 requirement | State |
|---|---|
| Adapter-specific enablement | **PASS** — `AIE_II_ADAPTER_ENABLED`, `AIE_FDH_BANK_ADAPTER_ENABLED`, `AIE_INSURANCE_ADAPTER_ENABLED`, plus per-adapter canonical-write flags |
| Environment-specific enablement | **PASS after this phase's fix** — see §11.2 |
| Explicit allowlist / cohort before broad rollout | **PASS** — `AIE_PILOT_COHORT_{ENFORCED,USER_IDS,EMAILS}`, fail-closed |
| Immediate global kill switch | **PASS** — `AIE_DOCUMENT_INTAKE_ENABLED` |
| Provider kill switch separate from deterministic parser | **PASS** — `AIE_AI_FALLBACK_ENABLED`, and a per-adapter `AIE_FDH_BANK_AI_FALLBACK_ENABLED` |
| No effect on purge / cleanup | **PASS** — `app/api/aie/cron/purge-sweep/route.ts` imports **no** AIE feature flag; it reads only `CRON_SECRET`, which *is* forwarded |
| **Audit of rollout configuration changes** | **NOT MET** — see §11.3 |

### 11.2 M5-F2 — the rollout gate could not take effect in production at all. **FIXED.**

**`amplify.yml` forwarded no `AIE_*` variable into the Next.js server runtime.** Per AWS's own
documented behaviour — and per the root-cause comment already in that file — a Next.js route
handler has no access to console-configured environment variables unless the build writes them
into `.env.production`. The grep list carried `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`,
`APP_BASE_URL`, `RESEND_API_KEY`, `CONTACT_FROM_EMAIL`, the `G4`/`G5B`/`G2` flags and `ROLLOUT_`.
**Not one `AIE_` variable.**

This is the identical defect class the G8 closure found and fixed for G4/G5B on 2026-09-13, where
a feature was "enabled" in the console and provably OFF at runtime across multiple redeploys.
Found here by auditing L.9 rather than by an incident.

**Why it is not merely cosmetic, and why a partial fix would be worse than none.** The current
state is fail-*safe*: every AIE flag defaults OFF, so AIE is simply unreachable in production no
matter what the console says. The danger is partial remediation. `isUserInAiePilotCohort()`
returns **true for everyone** when `AIE_PILOT_COHORT_ENFORCED` is unset — deliberate, and correct
when both variables travel together. An operator who added only `AIE_DOCUMENT_INTAKE_ENABLED` to
the forwarding list would switch intake on while cohort enforcement stayed silently OFF, turning
an allowlisted pilot into **a rollout to every user**. That is a fail-**open** combination reached
by an entirely reasonable partial fix.

**Fixed** by forwarding the whole `AIE_` prefix, which keeps the kill switch and its allowlist
inseparable, with the reasoning recorded inline so a later phase does not "tidy" it back. **No
AIE flag is set in any environment today**, so this changes nothing about what is currently
enabled — it makes the gate operable for the first time, which L.9 requires *before* any
production activation. Committed to this branch only; **not deployed**.

### 11.3 M5-OPEN-3 — rollout configuration changes are not audited

L.9's last requirement is an audit of rollout configuration changes. There is none. Every gate is
an environment variable set in the Amplify console; nothing in the application records who changed
a flag, when, or from what to what, and `lib/aie/audit.ts` has no event type for it. This is not
fixable in application code alone — it needs either AWS CloudTrail access to the Amplify
configuration API (this identity has `amplify:ListApps` denied) or a move to a database-backed
flag store. **Recorded as an open item, not fixed**, because inventing a flag store inside a
certification phase would be the wrong call.

---

## 12. Migrations `0153` and `0154` — fresh status

**Both are STILL UNAPPLIED, on DEV and on production.** Re-verified fresh 2026-09-15 by
`scripts/m5_migration_0153_0154_freshness_probe.mjs` and `scripts/pc5_migration_baseline_probe.mjs`,
with positive controls passing on both databases.

| Migration | DEV | PRODUCTION | Method |
|---|---|---|---|
| **`0153_pc5_governed_resolution.sql`** | **NOT APPLIED** | **NOT APPLIED** | Structural. `ii_ownership_allocation` → `PGRST205`; all three `aie_review_decision` columns → `42703 column does not exist`. Positive controls (`0140`, `0141`, `0144`, `0149`, `0150` objects) all **PRESENT** on both. |
| **`0154_huf_entity_type_india_gate.sql`** | **NOT APPLIED** | **NOT APPLIED** | Behavioural (a widened CHECK is invisible to PostgREST's schema cache). A real `entity_type='huf'` insert is refused **`23514` on `business_entities_entity_type_check`** on both databases — the two-value CHECK is still live. |

The probe creates nothing: it uses an all-zero `user_id` so the row cannot land even in the branch
where the CHECK has been widened, and it re-verifies cleanup. Reported: `nothing to clean — no row
was created`, on both databases.

**Therefore the blocked scenarios remain blocked and were not re-run**, exactly as the dispatch
directs when the migrations are still unapplied:

- PC5: **13 BLOCKED_ON_0153** of 54 (41 PASS, 0 FAIL) — unchanged
- M4B HUF: **4 BLOCKED_ON_0154** of 16 (12 PASS, 0 FAIL) — unchanged

**Why, re-verified rather than inherited.** `scripts/pc5_ddl_capability_probe.mjs`, run fresh:
eight candidate exec/DDL RPC names all return `PGRST202 Could not find the function`;
`SUPABASE_ACCESS_TOKEN`, `SUPABASE_MANAGEMENT_TOKEN` and `SUPABASE_PAT` all absent;
`DATABASE_URL`/`POSTGRES_URL` absent. **No DDL path exists from this environment.** This remains
an operator action, and it is this phase's carried-forward blocker too.

**Migration numbering, re-verified fresh:** `OK: 149 active migrations, one file per version, next
version is 0155` and `OK: no cross-branch migration collisions between "HEAD" (149 files) and
"origin/main" (136 files)`. **No migration was created or applied by this phase.**

---

## 13. Regression safety

| Check | Result |
|---|---|
| `npx tsc --noEmit`, full project | **clean, zero errors** |
| **Full repository suite** | **365 files / 7,236 tests — 17 files / 23 tests failed.** After removing one disclosed flake (below): **16 files / 22 tests — byte-identical to PC5's and M4B's documented baseline. ZERO new failures.** |
| AIE + PC5 unit suites | **61 files / 877 tests — all pass** |
| The 11 named L.4–L.8 evidence suites | **186 tests, 0 failures** |
| Live-DEV II dispatch proof | **6/6 pass**, zero residue across 8 tables |
| Live real-OpenAI provider proof | **4/4 pass** (ephemeral masking key; see §1.2) |
| `scripts/check-migration-versions.mjs` | `OK: 149 active migrations, next version is 0155` |
| `scripts/check-migration-versions-against-branch.mjs` | `OK: no cross-branch collisions` |
| PC4's 19-invariant regression contract | **Not broken.** This phase changed two React loading placeholders, one build spec and added three scripts. No parser, reconciliation, classification, identity, RLS or write-path file was touched. |

**Changes made by this phase, in full:** `amplify.yml` (one grep term + comment),
`components/pc5/ResolutionCentreClient.tsx` and `components/pc5/ResolutionDetailClient.tsx` (a
live region each), and three new scripts. Nothing else.

### 13.1 The 17th failing file, chased down rather than counted

The full run failed **17 files / 23 tests** against the documented baseline of **16 / 22**. The
extra file is `tests/unit/g3RegistrationAlignment.test.ts`, and it is **not a regression**:

- It failed with **`Error: Test timed out in 5000ms`**, not an assertion — and the file's own
  reported duration was **8,949 ms**. It is a drift-guard test that scans route files from disk,
  so it is exactly the kind of test that exceeds a 5 s bound under full-suite parallel I/O load.
- **Run in isolation it passes 71/71.**
- Subtracting it gives **22 failing tests — exactly the documented baseline number.**
- M5 touched three files, none of which this test inspects (it enumerates
  `requireCountryConfirmedUserAllowingGeneric` call sites in `app/api/**`).

Both PC5 §7 and M3 §7 documented this same class of contention flake in their own runs
(`resources*` collection failures, and `paymentsCheckoutRoute` respectively). Recorded here
rather than silently dropped from the count.

**The 16 baseline failures** are unchanged and unrelated to AIE: 9 `resources*` suites failing at
**collection** time for missing DEV env vars (0 failing assertions — environmental), plus
`aiResidualClosureFailClosed`, `countryGateAccessMatrix`, `fdh1Isolation`,
`lr12rSmsfPropertyLoanLinkOverride`, `lrFi2DebtServiceExactlyOnce`, `lrFi2HouseholdDebtRatios`
and `smsfHouseholdIsolation` in SMSF/debt-ratio/isolation territory.

---

## 14. Consolidated blockers and open items

### Needing Product-Owner or operator action

| ID | Item |
|---|---|
| **PO-BLOCKER-1** *(carried, re-verified fresh)* | **AWS S3 + GuardDuty.** Zero permissions beyond the implicit STS call; 6 candidate bucket names provably nonexistent against a 403/404 control. Needed: the exact bucket name, the AWS account id it lives in, and credentials or a purpose-scoped identity for that account. The runbook (`aie-document-quarantine-dev`) and the IAM policy (`fhip-aie-quarantine-dev`) still disagree (**OA-2b**). |
| **OA-6** *(carried, re-verified fresh)* | **`AIE_MASK_TOKEN_ENCRYPTION_KEY` is still unset** — absent from `.env.local` (9 keys parsed) and from the process environment. **Read §1.1 and §7 before supplying it:** it is now the *single* blocker on the AI path for FDH-bank and Insurance, two adapters whose AI fallback this mission has never exercised and whose privacy proof therefore reads NOT EXERCISED. |
| **PO-PC5-2** *(carried, re-verified fresh)* | **Apply migrations `0153` and `0154` to DEV.** Still unapplied on both databases. Clears 13 + 4 blocked live scenarios with no code change; both matrices auto-detect and switch to FULL mode. |
| **M5-BLOCKER-1** *(new)* | **AIE-1 requirement traceability is 15.5%, with 1,870 orphans and AIE-1.6 at 0.0% strict.** A terminal certification cannot discharge 2,214 requirements on evidence connected to 344. Needs either a decision that citation-level traceability is not required, or a real mapping pass. |

### Open items (no decision needed)

| ID | Item |
|---|---|
| **M5-OPEN-1** | A meaningful automated axe pass over PC5's resolution states needs the full app stood up **and** `0153` applied (the affordances worth auditing only render once decisions are possible). |
| **M5-OPEN-2** | **No accuracy corpus exists for FDH-bank or Insurance.** No measurable precision/recall, false-accept rate, or cost profile for either. Their verdicts are inherited unexamined. |
| **M5-OPEN-3** | Rollout configuration changes are **not audited** (§11.3). Needs CloudTrail access or a DB-backed flag store. |
| **M5-OPEN-4** | Zero AIE requirement identifiers are cited in **any** live-DEV suite, so L.3's live-DEV evidence column cannot be populated from evidence. |
| Carried | **M2-OPEN-1..5**, **M2-OPEN-8**, **M3-OPEN-1/2/3**, **CG-10**, **M2-OPEN-6** (still open for `app/api/aie/fdh-bank/intake/route.ts`, which no phase has touched), **PO-PC5-3** (PC5 consumer owner still unnamed, `AIE10-GOV-01`), **OA-10 / M3-F1** (the CAS opening-balance discard). |

---

## 15. L.10 — AIE-1 terminal verdict

> ## AIE-1 — CONDITIONAL PASS. NOT PRODUCTION READY.
>
> This supersedes `docs/aie-programme/AIE_1_FULL_CONSOLIDATED_REPORT_2026_09_14.md`, which M0
> recorded as stale by three commits and two environment changes and which M0 explicitly routed
> to this phase to reissue *"against current truth rather than amending a stale report."*
>
> **The four named dependencies that remain unresolved**, any one of which forbids the
> unconditional verdict under L.10's own wording:
>
> 1. **No malware scanning exists, and cannot exist in the posture production would run in.** The
>    GuardDuty decision gate has zero production callers; there is no S3 code path, no AWS
>    dependency, and no reachable bucket. The substitute admission gate must be run with
>    `AIE_ALLOW_MISSING_SIGNATURE_SCANNER` on for the product to admit any document at all.
> 2. **Migrations `0153` and `0154` are unapplied** on DEV and production, leaving 17 live
>    scenarios blocked across PC5 and HUF.
> 3. **`AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset**, and the masked-AI path for the two adapters
>    that can actually reach it has never been exercised end to end.
> 4. **Requirement traceability is 15.5%** against the Product Owner's own specifications, with
>    AIE-1.6 — the certification phase itself — at 0.0% strict.
>
> **Deferred and prohibited classes are explicitly outside the certified enabled scope and
> disabled**, as L.10 requires: 8 AIE-1.4 document classes DEFERRED and 1 (identity / medical /
> legal / sensitive) **PROHIBITED** by binding exclusion. No ingestion path exists for any of
> them, and none was built.
>
> **Production enablement state: everything OFF, at four independent layers** — not merged to
> `main`; not deployed; every flag defaults OFF; and, until this phase's `amplify.yml` fix, no
> AIE flag could reach the production runtime even if set.
>
> **What this phase adds to the record.** Two real defects found and fixed — a production rollout
> gate that could not take effect, with a fail-open partial-remediation trap behind it, and two
> PC5 screens that announced nothing to assistive technology. Three carried-forward beliefs
> corrected. One quantitative traceability measurement where there had only ever been assertion,
> including the disclosure of a harness defect in the measuring script itself that had briefly
> reported a perfect score.
>
> **Production authority: NOT exercised and NOT requested.** Per this phase's binding override,
> no push to `main`, no production database or configuration change, and no production canary was
> attempted, and none would have been attempted even had the verdict come out unconditional. All
> work is committed to `mission/m5-aie-terminal-2026-09-15` and left ready for a human-present
> follow-up at the end of the full 11-phase mission.

---

## 16. Exact counts (Part W)

| Measure | Value |
|---|---|
| Prior-phase documents carried forward | **8**, SHA-1 verified byte-identical |
| Source files modified | **3** (`amplify.yml`, 2 PC5 components) |
| Source files created | **0** |
| Scripts created | **3** (migration freshness probe, provider-proof runner, traceability matrix) |
| Migrations created / applied | **0 / 0** — next free version re-verified as **0155** |
| AIE + PC5 unit tests run | **61 files / 877 tests — 877 pass, 0 fail** |
| Named L.4–L.8 evidence suites | **11 files / 186 tests — 0 failures** |
| Live-DEV tests run | **10** (6 dispatch + 4 real-provider), all pass |
| Live-DEV rows created / cleaned / residue | **2 intakes, 2 runs, 4 candidates, 5 reconciliation runs, 2 unresolved items, 2 storage objects / all / 0 across 8 tables** |
| Real OpenAI calls made | **1 successful strict-schema completion** (plus kill-switch and pre-egress assertions that make none) |
| AWS probes run | **4 service calls + 8 bucket probes** (6 candidates, 2 controls) |
| Database probes run | **2 read-only structural scripts across DEV and PRODUCTION**, plus 2 behavioural CHECK probes that created nothing |
| Requirement ids inventoried | **2,214** across AIE-1.0 … AIE-1.6 |
| Requirement ids traced / orphaned | **344 / 1,870** |
| Repository files scanned for traceability | **2,942** |
| Defects found and fixed this phase | **2** (M5-F1 accessibility, M5-F2 rollout gate) |
| Carried-forward beliefs corrected | **3** |
| Harness defects found in this phase's own tooling | **1**, disclosed (§5.4) |
| Production database writes | **0** |
| Pushes / merges to `main` | **0** |
