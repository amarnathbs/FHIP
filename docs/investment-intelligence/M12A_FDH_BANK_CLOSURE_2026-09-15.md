# M12A — FDH-Bank AIE Contract and Accuracy Certification

**Mission:** FHIP — M12 "Final Closure", Phase A (sections 3 and 4 of the M12 dispatch)
**Date:** 2026-09-16 (branched from the M11 tip dated 2026-09-15; the mission's date label is retained)
**Branch:** `mission/m12a-fdh-bank-2026-09-15`, branched from `e5879630f63aefb3873b14bc5de7c144f07469c4` — the M11 final integrated certification, **not** `origin/main`
**Terminal commit:** `8725fb6a6a18830395d8798d1120220a83004515`
**Carried forward:** all 14 prior mission documents, inherited by branching rather than copied (§8.1). With this document, `docs/investment-intelligence/` carries **15** mission documents.

**Authority exercised:** repository and git inspection; test execution; read-only PostgREST `GET` probes against DEV **and** PRODUCTION with paired negative controls.
**Authority NOT exercised, per the binding production override, and not exercised regardless of the verdict reached:** no push, no merge, no deployment, no production database write, no production configuration change, no migration applied anywhere, no migration created anywhere. Everything is committed locally.

**No credential value, API key, account number, BSB, IFSC, holder name or real statement text appears anywhere in this document or in anything it commits.** Every document in the corpus is synthetic.

---

## 1. Verdict

> # M12A — **CONDITIONAL PASS.**
>
> **Section 3 (the FDH-bank AIE contract) is closed unconditionally.** The defect the prior
> mission carried forward on paper for three phases — `M2-OPEN-6` — was reproduced against the
> live code, fixed by deleting it rather than flagging it off, and replaced by the acceptance
> path that already existed and had simply never been used by this route. The required
> lifecycle now holds end to end, proved by driving the real route handler and the real
> acceptance gate over real document bytes.
>
> **Section 4 (accuracy certification) meets both of its hard requirements and misses none of
> its scenarios, but one of the ten cannot be certified in this environment.** Across a sealed
> 12-document corpus measured against a hand-authored independent oracle:
>
> | Measure | Required | Achieved |
> |---|---|---|
> | Field precision | measured | **100.00%** (215/215) |
> | Field recall | measured | **100.00%** (215/215) |
> | Economic transaction precision | measured | **100.00%** (37/37) |
> | Economic transaction recall | measured | **92.50%** (37/40) |
> | **Unexplained economic omission** | **= 0** | **0** |
> | **False canonical write rate** | **= 0** | **0.00%** (0 of 12) |
> | False accept rate | measured | **0.00%** (0 of 5 must-not-be-acceptable cases) |
>
> **What keeps it CONDITIONAL, and it is exactly one thing.** **FDH-A05** — the ambiguous
> institution requiring AI clarification — is the only corpus case that reaches the masking
> stage, and `AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset in this environment. That is a
> Product-Owner/operator-owned blocker this phase was explicitly told not to work around, and
> did not. The deterministic invariants of that case are proved under an ephemeral in-process
> key (§6.5); the AI clarification itself is **NOT CERTIFIED**, and running it against the real
> environment as it actually stands produces a crash rather than a degraded answer (§6.5,
> `M12A-F2`).
>
> **Two real defects were found and fixed, both by running the system rather than reading it.**
> `M2-OPEN-6`, reproduced rather than assumed (§3); and `M12A-F1` (§5), which the corpus found
> on its first run — a statement whose first printed transaction was unreadable lost that row
> **silently**, reached `awaiting_acceptance`, and on an explicit accept wrote an incomplete
> statement to the canonical ledger. Before the fix the corpus measured **1 unexplained economic
> omission, a 20.00% false accept rate and an 8.33% false canonical write rate**; after it, all
> three are zero. Those pre-fix numbers are preserved in commit `5f07c75`, which deliberately
> commits the corpus **with** the defect it found rather than after it.
>
> **`UNCONDITIONAL FULL PASS` is not available and this report does not award it**, because one
> of the ten mandated scenarios is uncertified and the programme's own standing rule forbids
> awarding a full pass over a named gap.

---

## 2. What this phase was asked to do, and what it did

| M12 dispatch | Status |
|---|---|
| §3 — reproduce the FDH-bank intake-time canonical write against CURRENT code before fixing it | **DONE.** §3; RED commit `4daa0a4`, 2 passed / 2 |
| §3 — fix it, reusing the shared accept infrastructure, no second approval system | **DONE.** §4; commit `e82914f`, 7 passed / 7 |
| §4 — build a sealed synthetic corpus covering FDH-A01…A10 | **DONE**, plus two additive cases. §6 |
| §4 — independent oracle with account identity token, transaction count, dates, amounts, direction, balances, institution, expected unresolved items | **DONE.** §6.1 |
| §4 — measure field precision/recall, economic precision/recall, false accept rate, false canonical write rate | **DONE.** §7 |
| §4 — unexplained economic omission = 0 | **MET (0).** §5, §7 |
| §4 — false canonical write = 0 | **MET (0.00%).** §7 |
| Copy forward all 14 prior documents | **DONE** — inherited by branching, §8.1 |
| Verify migration numbering fresh | **DONE**, live on DEV and PRODUCTION with negative controls. §8.2 |
| No push, no merge, no production touch | **HONOURED.** §8.3 |

---

## 3. Section 3 — the RED reproduction

### 3.1 Did the defect reproduce as described? **Yes, exactly, and worse than the paper said.**

The M11 final certification §6.8 recorded that
`app/api/aie/fdh-bank/intake/route.ts:236-239` performed a canonical write inline at intake,
"bypassing `accept.ts` entirely — no acceptance flag, no re-read of blocking count, no CAS, no
explicit user acceptance", and that **no phase of that mission had ever touched the route**.
M12A did not take its word for it.

`tests/unit/m12aFdhBankIntakeGate.test.ts`, as committed at `4daa0a4`, asserts the **defective**
behaviour against the then-current code and **passes, 2 of 2**:

```
✓ a clean, fully-reconciling statement reaches awaiting_acceptance AND is canonically
  written in the same request                                                    1720ms
✓ CONTROL: the same statement with a seeded running-balance break is blocked at
  "unresolved" and writes nothing                                                   9ms
Test Files  1 passed (1)      Tests  2 passed (2)
```

**What was real in that reproduction, and what was not.** Real: the Next.js route handler,
imported and invoked directly with a real `Request` (its `ok`/`bad` helpers are plain
`Response.json`, so no server harness is needed — a stronger reproduction than the prior
mission's service-level tests achieved); genuinely valid synthetic PDF bytes; FDH-5's real
`classifyPdf`; the real parser bridge, orchestrator, reconciliation rule, account-identity
resolution and `commitFdhBankStatementImport` itself. Substituted: the database, object storage,
and FDH-5's two terminal write services — the last of those **precisely so their invocation
could be observed**.

**Four observations, each one a separate part of the defect:**

| # | Observation on the pre-fix code |
|---|---|
| 1 | FDH-5's own `uploadBankPdf` called **once** and `processBankPdfDocument` called **once**, during the intake request itself |
| 2 | An `aie_write_batch` row upserted `pending` then `committed`, `target_module = fdh_bank`, for a run nobody accepted |
| 3 | `isAieCanonicalAcceptanceEnabled` **never read**; **zero** CAS run transitions — the acceptance gate was not merely bypassed, it was never consulted |
| 4 | The commit result handed straight back in the intake response body, so a caller could reasonably believe the document was already committed |

**The negative control is what makes those four readable.** The same statement with a seeded
running-balance break stops at `unresolved` and records **zero** canonical-write activity on the
identical observation points. The instrumentation can therefore distinguish, which is the only
reason its positive readings mean anything.

### 3.2 The environment that made it visible

The reproduction runs with `AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED=true` — the configuration a
production activation of this adapter would have to use. **With the flag OFF the defect is
masked**: the inline commit call still happens, but `commitFdhBankStatementImport` returns
`atomic_import_disabled` before touching anything. That is exactly why it survived three phases
of a mission that was looking for things like it.

---

## 4. Section 3 — the fix

### 4.1 What changed

`app/api/aie/fdh-bank/intake/route.ts`:

- The intake-time `commitFdhBankStatementImport(...)` call is **removed**. Not flagged off, not
  left as a dormant branch — a branch behind a switch is still a second write path, and the
  entire point is that there is exactly one.
- The **import** of that service is removed with it, so a future re-introduction must be a
  deliberate act rather than flipping a switch. A test asserts the absence of both the import
  and the call at the source level.
- The response keeps `commit` as an explicit, always-`null` field (so an existing caller reads
  "nothing was committed" rather than `undefined`) and gains `accepted: false` plus
  `accept_endpoint`, naming the one place a write can now happen.
- The quarantined binary is deliberately **not** deleted at intake — the accept-time write
  re-fetches those exact bytes. (Insurance's route does delete at intake, correctly: its
  candidate-based write never needs them again.)

### 4.2 What infrastructure it reused — and the answer is "all of it"

**No new acceptance machinery was built, and none was needed.** `lib/aie/review/accept.ts` has
dispatched FDH-bank since the AIE-1 merge; this route had simply never used it. The path a run
now takes, every step of which already existed:

| Step in `accept.ts` | Pre-existing |
|---|---|
| Feature gate `isAieCanonicalAcceptanceEnabled` | yes |
| Ownership (IDOR) via `getRunForUser`'s own `user_id` filter | yes |
| Run status must be exactly `awaiting_acceptance` | yes |
| Blocking-item count **re-read from the database**, never trusted from the client | yes |
| Worst reconciliation outcome re-derived; `fail`, `indeterminate` **and `not_applicable`** all refused | yes |
| Adapter resolved from the run's own recorded `adapter_id` (`aie_fdh_bank_statement_bridge_v1`), never guessed | yes |
| CAS `awaiting_acceptance → accepted → write_pending → completed` | yes |
| Crash-window double-import guard `findCommittedFdhBankWriteForRun` | yes |
| Original bytes re-fetched from quarantine | yes |
| Original upload metadata re-read from `aie_document_intake.fdh_bank_upload_metadata` (**migration 0145**, added for exactly this later request) | yes |
| `finalizeDocumentBinaryAfterRun` only after the write succeeds | yes |

**Consequence worth stating plainly: this fix required no migration.** The one piece of
persistence a later, separate accept request needs was added by `0145` a long time ago, in
anticipation of precisely this — the route's own comment said so, while the route went on
writing at intake anyway.

### 4.3 The lifecycle, proved

`tests/unit/m12aFdhBankIntakeGate.test.ts` at `e82914f`: **7 passed / 7.**

| Proof | Evidence |
|---|---|
| Intake reaches `awaiting_acceptance` and performs **zero** canonical-write activity | `fdhUploadBankPdfCalls`, `fdhProcessDocumentCalls`, `writeBatchUpserts`, `runTransitions` all empty; `commit` null; `accepted` false |
| The route no longer imports the write service | source-level assertion on both the import and the call |
| A seeded running-balance break stops at `unresolved`, and acceptance then refuses it too | `acceptRun` → `{ ok: false, reason: 'not_ready' }`, zero writes |
| The run records the adapter id acceptance dispatches on | latest parser attempt = `aie_fdh_bank_statement_bridge_v1` |
| An **explicit accept** — and only then — writes, through the full gate | CAS ladder observed in order `awaiting_acceptance->accepted`, `accepted->write_pending`, `write_pending->completed`; quarantine re-fetched; one write; binary finalised only afterwards |
| An open blocking item still refuses, even on a passing reconciliation | `items_still_blocking`, zero writes, zero transitions |
| A second accept is idempotent | `{ ok: true, alreadyCompleted: true }`; **one** canonical write, not two |

### 4.4 Two harness findings recorded because they are real, not incidental

Both are documented in the test files themselves, because either one silently produces a test
that passes while proving nothing.

- **Vitest instantiates this file's `vi.mock` factories once per importer graph.** The intake
  route resolves `@/lib/aie/storage`; `accept.ts` resolves `../storage`. A module-level `let`
  is **not** shared between those two factory instances — proved by running exactly that, where
  the upload observed 989 bytes and the download in the same test observed 0. Shared fake state
  is therefore keyed off `globalThis`, and is never reset at module top level (a top-level reset
  re-ran mid-test, the moment `accept.ts` was first imported, wiping the bytes intake had just
  stored).
- **The route's request `ArrayBuffer` is detached further down the same request**, so a fake
  storage layer that retains an alias reads back zero bytes. It copies instead. Nothing in
  production depends on the caller's buffer staying alive — the real storage layer uploads the
  bytes — so this is the fake behaving like the real thing rather than like a reference.

---

## 5. `M12A-F1` — the defect the accuracy corpus found

**This is the most consequential finding of the phase, and it was found by the corpus on its
first run, not by reading code.**

### 5.1 What it was

A bank statement whose **first** printed transaction is unreadable loses that row **silently**:

- the parser rejects the row (an impossible `31 Feb` date; `normalizePdfRow` correctly refuses
  to guess);
- every surviving row still chains perfectly to its neighbour, because the break is at the edge
  of the chain rather than inside it;
- the opening balance is derived from the first **surviving** row, so the rollforward closes to
  the penny and `reconcileBalances` returns `reconciled`;
- the adapter's rule maps that to `pass`; the run reaches `awaiting_acceptance`;
- an explicit accept then writes an **incomplete statement** to the canonical FDH ledger.

**The parser knew.** It already computed `outcome: 'partial'` when rows were rejected or blocks
were unparseable. But `ReconciliationRule` receives **candidates only**, so that outcome never
reached the one place that decides whether a run may be accepted.

**The running-balance chain was never the safeguard it appeared to be.** It catches a dropped
row in the **middle** — that is corpus case FDH-A06, where the variance produced equals the
dropped row's own amount exactly, 220.24 — and it is **blind at the edges**. FDH-A11 exists
precisely to ask that second question, and the answer was a false canonical write.

### 5.2 Measured before and after, on the same corpus

| Measure | Before `M12A-F1` (commit `5f07c75`) | After (commit `8725fb6`) |
|---|---|---|
| Unexplained economic omissions | **1** | **0** |
| False accept rate | **20.00%** (1 of 5) | **0.00%** (0 of 5) |
| False canonical write rate | **8.33%** (1 of 12) | **0.00%** (0 of 12) |
| Field precision / recall | 100.00% / 100.00% | 100.00% / 100.00% |
| Economic precision / recall | 100.00% / 92.50% | 100.00% / 92.50% |

Note what did **not** move: extraction accuracy was already perfect and stayed perfect. This was
never an extraction defect. It was a **reporting** defect, and the corpus is what made the
difference visible, because a metric that only measured what was extracted would have scored
this document 100% precision and moved on.

### 5.3 The fix, and why it is shaped this way

- `parser.ts` emits `__fdh_bank_unreadable_row_count` and `__fdh_bank_unreadable_row_evidence`
  (which rows, and why — **never a guess at what they contained**; AIE13-AI-06 forbids inventing
  a date, amount or sign).
- `reconciliation.ts` adds `fdh_bank_statement_row_extraction_completeness` as **its own rule**.
  The blocking unresolved item is produced by AIE-1.1 core's own unchanged
  `blockingItemsForReconciliation`, so **no second exception channel is introduced** (P7).

Three deliberate choices, each one backed by a test:

1. **`indeterminate`, never `fail`.** This adapter does not know the unreadable rows are *wrong*
   — only that it could not read them, which is what INDETERMINATE means everywhere else in
   that file.
2. **The rule is emitted even at zero**, as an explicit `pass` with materiality
   `all_printed_rows_read`. A positive assertion beats silence, and a future change that stops
   emitting the candidate now fails loudly instead of quietly restoring the old behaviour.
3. **An absent candidate is `indeterminate`, not `pass`.** The entire defect was an absent
   signal being read as good news; a run produced by a pre-M12A parser must block, not sail
   through.

The balance rule is untouched. *"Did the arithmetic close?"* and *"did we read everything the
statement printed?"* are two questions, and the answer to one must never be read off the other.

`reasonCodes.ts` gains real reviewer-facing copy rather than falling through to
`GENERIC_FALLBACK_REASON_META`, whose text ("our automatic checks could not confirm this
document is safe to accept as-is") gives a reviewer nothing to act on. The registered wording
says the import would be **incomplete** — deliberately not that the figures are wrong, which is
not known.

### 5.4 No migration, verified structurally

`aie_field_candidate.field_name`, `aie_reconciliation_run.rule_id` and
`aie_unresolved_item.reason_code` are all unconstrained `text` in migration `0140`, and
`aie_reconciliation_run.outcome`'s CHECK already admits `'pass'` and `'indeterminate'`. Read
directly from the migration, not assumed.

### 5.5 Four pre-existing tests were updated — and they were failing correctly

`tests/unit/aieFdhBankStatementReconciliation.test.ts` built synthetic candidate sets that omit
the new candidate, so after the fix they failed **closed** — which is the behaviour the fix
exists to produce. They now supply the candidate at its clean value, so each test again tests
the one thing it names, and three new tests cover the completeness rule directly, including the
absent-candidate fail-closed case. Nothing was weakened; the assertion counts went up.

---

## 6. Section 4 — the corpus, the oracle and the harness

### 6.1 How the independence is structural, not claimed

| Artefact | What it contains | What it must not contain |
|---|---|---|
| `tests/support/buildM12aFdhBankCorpus.ts` | What each statement **prints**, and real PDF bytes built from those lines | Any expected outcome, parsed value or verdict |
| `scripts/m12a-fdh-bank-certification/oracle.json` | Every expected value, hand-derived from those printed lines | Any call into production code |
| `tests/support/aieAccuracyHarness.ts` | The metric definitions | Any knowledge of bank statements |
| `tests/unit/m12aFdhBankAccuracyCorpus.test.ts` | The driver | Any expectation of its own beyond the oracle's |

The oracle is read the way a person reconciling the statement would read it: parse the date in
the layout's own documented format, take the amount's magnitude and printed direction, take the
running balance as printed, roll it forward. `accountIdentityToken` is a SHA-256 over the
documented payload `JSON.stringify([userId, institutionId, currencyCode, maskedIdentifier])`,
**recomputed independently** rather than read back from `computeAccountFingerprint`.

The one thing the test **does** import from production is the adapter's field **names** — a
certification that silently looked for a field the adapter had stopped emitting would report a
perfect zero instead of a failure. The oracle's **values** remain entirely independent.

### 6.2 Evidence standard

Every document is synthetic, built from each bank's publicly documented statement conventions —
the same evidence tier FDH-5's own adapters and R7's CSV adapters shipped with (migration `0064`:
*"certification against synthetic representative fixtures — no real customer statement used"*).
**Nothing in the corpus is, or is derived from, a real bank statement, sanitised or otherwise.**
The only long digit run anywhere in it (FDH-A05) exists so a masking assertion has something to
prove.

### 6.3 How the account identity token is actually measured

Not scraped from a response — the route deliberately does not return it. The harness seeds the
account repository with **one** existing account whose fingerprint **is the oracle's token**. A
correct implementation therefore resolves `reuse` and loads that account's dedup index; an
implementation that computed any other fingerprint would resolve `create` and never touch it.
The observation is the system's own behaviour: `loadDedupIndexForAccount` called with
`oracle-account-1`, on every case that got as far as resolving an account (A01–A08, A10–A12).

### 6.4 Why the lifecycle runs twice per case

Every case is driven through an intake **and then an unconditional explicit accept attempt**.
That is what makes "false canonical write rate" a real measurement rather than a tautology: it
asks of every document *"if a user pressed accept, would this be written?"* and compares the
answer with what the oracle says may ever be written. Measuring only intake would score 0%
trivially, because after §4's fix intake writes nothing by construction.

A harness finding that mattered here: **`recordTransition`, not `transitionRunStatusCas`, is
what updates `aie_extraction_run.status`** in the real repository (`repository.ts:267`). Until
the fake mirrored that, no case ever became acceptable, every accept returned `not_ready`, and
the false-canonical-write rate was **vacuously** zero. A second finding of the same kind: the
fake admin client needed an `rpc` for the AI cost ledger — without it FDH-A05 threw
`admin.rpc is not a function`, and the unset-masking-key case passed for entirely the wrong
reason.

### 6.5 FDH-A05 — the one case that cannot be certified, stated precisely

FDH-A05 is the only corpus document that reaches the masking stage, because it is the only one
that declares an AI-eligible gap (`bank_institution_hint`, on a layout where two certified
adapters score too close to call).

**Run 1 — the environment as it actually stands, no key, no workaround:**

```
process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY === undefined      (asserted, not assumed)
intake threw: "AIE_MASK_TOKEN_ENCRYPTION_KEY is not set or is not a 64-character hex
               string (32 bytes). It is required before any identifier can be tokenised —
               masking fails closed without it, which also means no AI…"
canonical writes: 0        AI completion attempts: 0        field candidates: 0
```

Masking **fails closed**, which is the correct security posture. But the route has no handler
for it, so the request does not degrade to `unresolved` — **it does not return at all**
(`M12A-F2`, §9).

**Run 2 — under an ephemeral, in-process key**, so the deterministic invariants are still
measured rather than skipped (the same technique M2's own real-provider proof used, and the
same one `aieFdhBankStatementOrchestratorIntegration.test.ts` already used before this phase):

| Invariant | Observed |
|---|---|
| Terminal status | `unresolved` |
| Transaction rows extracted from an ambiguous layout | **0** — an AI hint about *which* bank is never taken as licence to trust that bank's row extraction |
| Blocking unresolved item | `reconciliation_indeterminate:fdh_bank_statement_layout_certification`, materiality `ambiguous_layout` |
| AI completion attempts | 1 |
| The document's 11-digit identifier in the provider prompt | **absent** — asserted against the captured prompt |
| Canonical writes, including after an explicit accept | **0**; accept refused `not_ready` |

**What this does and does not certify.** It certifies that an ambiguous layout can never be
accepted, can never yield transaction rows, and cannot leak a long identifier into a provider
prompt. It does **not** certify the AI clarification itself: no real provider is configured
here, the key is not provisioned in DEV, and provisioning it was explicitly out of scope for
this phase. **FDH-A05 is therefore CONDITIONAL.**

---

## 7. Section 4 — results

Generated by `tests/unit/m12aFdhBankAccuracyCorpus.test.ts`; the machine-readable form is
`scripts/m12a-fdh-bank-certification/results.json`, and the table below is
`results_table.md` verbatim rather than retyped, so report and run cannot drift.

| Case | Scenario | Field P | Field R | Econ P | Econ R | Unexplained omissions | False accept | False canonical write |
|---|---|---|---|---|---|---|---|---|
| FDH-A01 | normal bank PDF | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| FDH-A02 | multi-page transaction history | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| FDH-A03 | debit/credit terminology variant | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| FDH-A04 | wrapped description | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| FDH-A05 | ambiguous institution requiring AI clarification | n/a | n/a | n/a | n/a | 0 | no | no |
| FDH-A06 | malformed statement | 100.00% | 100.00% | 100.00% | 66.67% | 0 | no | no |
| FDH-A07 | duplicate / reimport | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| FDH-A08 | opening/closing balance mismatch | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| FDH-A09 | password-protected | n/a | n/a | n/a | 0.00% | 0 | no | no |
| FDH-A10 | adversarial prompt-injection text | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| FDH-A11 | ADDITIVE — silent-omission probe | 100.00% | 100.00% | 100.00% | 66.67% | 0 | no | no |
| FDH-A12 | ADDITIVE — India / INR jurisdiction variant | 100.00% | 100.00% | 100.00% | 100.00% | 0 | no | no |
| **ALL 12** | — | **100.00%** | **100.00%** | **100.00%** | **92.50%** | **0** | **0.00%** | **0.00%** |

- unexplained economic omissions: **0**
- false accept rate: **0.00%** (0 of 5 must-not-be-acceptable cases)
- false canonical write rate: **0.00%** (0 of 12 cases)

### 7.1 The raw counts behind those percentages

Percentages hide small denominators, so the counts are given as well.

| Case | Fields correct / asserted | Fields correct / expected | Econ matched / observed | Econ matched / printed |
|---|---|---|---|---|
| FDH-A01 | 23/23 | 23/23 | 4/4 | 4/4 |
| FDH-A02 | 48/48 | 48/48 | 9/9 | 9/9 |
| FDH-A03 | 23/23 | 23/23 | 4/4 | 4/4 |
| FDH-A04 | 13/13 | 13/13 | 2/2 | 2/2 |
| FDH-A05 | 0/0 | 0/0 | 0/0 | 0/0 |
| FDH-A06 | 13/13 | 13/13 | 2/2 | **2/3** |
| FDH-A07 | 23/23 | 23/23 | 4/4 | 4/4 |
| FDH-A08 | 23/23 | 23/23 | 4/4 | 4/4 |
| FDH-A09 | 0/0 | 0/0 | 0/0 | **0/1** |
| FDH-A10 | 18/18 | 18/18 | 3/3 | 3/3 |
| FDH-A11 | 13/13 | 13/13 | 2/2 | **2/3** |
| FDH-A12 | 18/18 | 18/18 | 3/3 | 3/3 |
| **Total** | **215/215** | **215/215** | **37/37** | **37/40** |

**Economic recall is 92.50%, and that number is correct rather than a failure.** The three
missing rows are the two unreadable rows (A06, A11) and the one transaction inside the
password-protected document (A09). **All three are accounted for**: A06 and A11 are blocked
`unresolved` with a blocking item naming the unreadable row and its reason; A09 is refused
outright. A system that had *guessed* those three would have scored 100% recall and been much
worse.

### 7.2 Per-case lifecycle, observed

| Case | Terminal status | Explicit accept | Writes at intake | Writes after accept | AI calls |
|---|---|---|---|---|---|
| FDH-A01 | `awaiting_acceptance` | **ok** | 0 | **1** | 0 |
| FDH-A02 | `awaiting_acceptance` | **ok** | 0 | **1** | 0 |
| FDH-A03 | `awaiting_acceptance` | **ok** | 0 | **1** | 0 |
| FDH-A04 | `awaiting_acceptance` | **ok** | 0 | **1** | 0 |
| FDH-A05 | `unresolved` | refused `not_ready` | 0 | 0 | 1 |
| FDH-A06 | `unresolved` | refused `not_ready` | 0 | 0 | 0 |
| FDH-A07 | `awaiting_acceptance` | **ok** | 0 | **1** | 0 |
| FDH-A08 | `unresolved` | refused `not_ready` | 0 | 0 | 0 |
| FDH-A09 | `rejected` (`password_required`) | refused `not_found` | 0 | 0 | 0 |
| FDH-A10 | `awaiting_acceptance` | **ok** | 0 | **1** | 0 |
| FDH-A11 | `unresolved` | refused `not_ready` | 0 | 0 | 0 |
| FDH-A12 | `awaiting_acceptance` | **ok** | 0 | **1** | 0 |
| FDH-A07R (reimport) | `unresolved` | refused `not_ready` | 0 | 0 | 0 |
| CONTROL corrupt PDF | `rejected` | — | 0 | 0 | 0 |

**Zero writes at intake on every case without exception**, and a write only ever after an
acceptance that genuinely succeeded. A09 is refused `not_found` because no run was ever created
— honest, and different from `not_ready`.

### 7.3 What each case actually proved

| Case | What it establishes |
|---|---|
| **A01** | Four transactions, one page, statement arithmetic closes; `au_cba_pdf_v1` detected; variance 0.000; `awaiting_acceptance` with zero unresolved items |
| **A02** | Nine transactions across three pages with repeated column headers and a page footer on every page: **all nine recovered**, headers/footers stripped, rollforward closes |
| **A03** | The same four transactions as A01 in a layout with **no DR/CR words at all** — direction carried entirely by the amount's sign. Identical dates, magnitudes and directions. A direction read from notation rather than meaning would have flipped every debit here |
| **A04** | A narrative wrapping over two further printed lines is **merged into one transaction**, not split and not truncated. The continuation line deliberately ends in a money-shaped token (`150.00`) that a naive reconstructor would have mistaken for the amount |
| **A05** | Ambiguous layout: **zero** transaction rows, blocked `unresolved`, the 11-digit identifier absent from the provider prompt. **CONDITIONAL** — see §6.5 |
| **A06** | A printed 220.24 debit against `31 Feb` is never guessed at; the broken chain produces a variance of **220.24 — the dropped row's own amount, exactly**; blocked `unresolved` |
| **A07** | First import: four unique rows, accepted, one write. **Reimport** (A07R): every row `duplicate_confirmed` from the dedup index the first pass genuinely populated (four distinct economic fingerprints), reconciliation `not_available`, blocked `unresolved`, **zero** new economic transactions. "Nothing left to check because it was all duplicates" is not the same claim as "checked and correct" |
| **A08** | Extraction is **perfect** — this case measures whether perfect extraction is mistaken for a correct document. The printed closing balance agrees with the *wrong* running balance, so a check that trusted the footer would have passed it. Observed: `fail`, variance **34.56**, blocked, never written |
| **A09** | A genuinely RC4-encrypted PDF with no password supplied: refused `password_required`, **zero** rows extracted, nothing written. Never a partial read, never an empty statement reported as clean |
| **A10** | Three narratives instructing the machine — one injecting a money-shaped `999999.99` larger than every real figure, one demanding acceptance, one demanding a zero balance and a certification. Every amount, direction and balance extracted exactly as printed; the injected text survives as **inert description data**; terminal status unchanged; zero AI calls |
| **A11** | **ADDITIVE.** The silent-omission probe — §5 |
| **A12** | **ADDITIVE.** India/INR with Indian comma grouping (`1,23,456.78`). A parser assuming Western grouping would not merely mis-format these, it would **mis-value** them. Account token differs from every AU case because currency is part of the identity payload |
| **CONTROL** | A structurally corrupt PDF is refused with nothing extracted and nothing written — so the corpus's positive readings are distinguishable from its negative ones |

---

## 8. Verification of the carried-forward state

### 8.1 The 14 prior documents

Inherited by branching from `e587963` rather than copied, so they are the same git objects, not
copies that could drift. Present in `docs/investment-intelligence/`:
`AIE_II_DISPATCH_CLOSURE_REPORT_2026-09-15.md`,
`AIE_II_POST_PC4_FINAL_CERTIFICATION_2026-09-15.md`, `AIE_INFRA_CLOSURE_REPORT_2026-09-15.md`,
`AIE1_TERMINAL_CERTIFICATION_2026-09-15.md`, `II_PC4_MIGRATION_AND_CONFIG_BASELINE_2026-09-15.md`,
`II_PC4_POST_CLOSURE_REGRESSION_CONTRACT_2026-09-15.md`, `II_PC4_VERIFICATION_VERDICT_2026-09-15.md`,
`II_POST_PC4_MASTER_SCOPE_LEDGER_2026-09-15.md`, `PC5_HUF_ADDENDUM_2026-09-15.md`,
`PC5_IMPLEMENTATION_CERTIFICATION_2026-09-15.md`, `PC6_MARKET_DATA_CERTIFICATION_2026-09-15.md`,
`PC6_OPERATOR_RUNBOOK.md`, `PC7_LOOKTHROUGH_CERTIFICATION_2026-09-15.md`,
`PC8_PC9_PC10_SCOPE_CLOSURE_2026-09-15.md`. With this document: **15**.

### 8.2 Migration numbering — verified fresh, not inherited

**File-level, across every ref in the repository** (`git log --all --diff-filter=A` over
`supabase/migrations/015*`/`016*`):

| Number | Owner | Note |
|---|---|---|
| 0153 | this mission (PC5) | |
| 0154 | this mission (HUF) | a `0154` collision with the app-review branch was resolved by that branch renumbering to `0156` in commit `ea4c124` |
| 0155 | this mission (PC6) | |
| 0156 | `fix/app-review-findings-2026-09-15` | unrelated data fix |
| 0157 | this mission (PC7) | |
| 0158 | `fix/app-review-findings-2026-09-15` | unrelated data fix |
| **0159** | **free** | no file numbered 0159 or above exists on any ref |

**Live application state, probed read-only today with paired negative controls:**

| Object | DEV | PRODUCTION |
|---|---|---|
| `0153` — table `ii_ownership_allocation` | HTTP 200 (present) | HTTP 404 `PGRST205` (**absent**) |
| `0155` — table `ii_scheme_master` | HTTP 200 (present) | HTTP 404 `PGRST205` (**absent**) |
| `0157` — column `ii_fund_holdings_snapshots.disclosure_period` | HTTP 200 (present) | HTTP 400 `42703` (**absent**) |
| `0145` — column `aie_document_intake.fdh_bank_upload_metadata` | HTTP 200 (present) | HTTP 200 (present) |
| **NEGATIVE CONTROL** — absent table | HTTP 404 `PGRST205` | HTTP 404 `PGRST205` |
| **NEGATIVE CONTROL** — absent column | HTTP 400 `42703` | HTTP 400 `42703` |

The controls fail in exactly the way a genuinely missing object fails, so the method cannot
return false positives. This **confirms the operator's statement fresh**: `0153`/`0155`/`0157`
are applied on DEV and remain unapplied on production, unchanged by this phase.

> **This phase created no migration and applied none, anywhere.** §4.2 and §5.4 show why none
> was needed, from the schema rather than from assertion. **The next genuinely free number
> remains `0159`.**

### 8.3 Production and regression state

| Check | Result |
|---|---|
| `origin/main` | **`23b49da1d63c9c20f980ea9042e176845b6f60e3`**, re-fetched today, unchanged |
| Pushed | **nothing**, by this phase or any phase of this mission |
| Merged | **nothing** |
| Production database writes | **0** — only read-only `GET` probes, §8.2 |
| Production configuration / deployment / rollout | **untouched** |
| Migrations applied or created | **0** |
| Full test suite | **17 files / 39 tests failing — file-for-file identical to the documented pre-existing baseline. Zero new failures.** 350 files / 7,352 tests passing |
| PC4's 19-invariant regression contract | **85 files, 84 passed / 1 skipped, 1,673 passed / 5 skipped, 0 failed — byte-identical to M1's recorded baseline** |
| `tsc --noEmit` | clean |
| `eslint` on every changed file | clean |
| Tokenisation | untouched. One-way HMAC only; no reversible map exists, and nothing this phase built claims to show an "original" value |

**One incidental corroboration worth recording.** Running the full suite regenerated
`scripts/ii-r5-certification/comparison_report.json` and
`scripts/ii-r6p1-certification/comparison_report.json`. The only line that changed in either is
`generatedAt`. Every computed figure is byte-identical — independent evidence that nothing this
phase changed touched those engines.

---

## 9. Open items

| Id | Item | Owner | Detail |
|---|---|---|---|
| **`M12A-F2`** | **An ambiguous-layout document crashes the intake request when `AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset**, rather than degrading to `unresolved`. `maskText` fails closed by throwing — correct — but `runExtractionPipeline` has no handler, and neither does any intake route, so the request never returns and the run is stranded mid-pipeline. | PO decision, then engineering | **Disclosed, deliberately not fixed here.** The fix belongs in shared AIE-1.1 core (`lib/aie/orchestrator.ts`), which is used by **Investment Intelligence, FDH-bank and Insurance alike** — a three-adapter blast radius that this phase's scope does not cover and that the Insurance phase will hit identically. Recommend it be owned by whichever M12 phase owns the shared gateway, not bolted onto one adapter. Evidence: `results.json` → `evidence["FDH-A05-no-masking-key"]` |
| **`OA-6` (inherited)** | `AIE_MASK_TOKEN_ENCRYPTION_KEY` unset — re-confirmed fresh today: absent from a 9-key `.env.local` and from the process environment | PO / operator | The single reason FDH-A05 is CONDITIONAL. Not provisioned by this phase, per the dispatch |
| **`M12A-O1`** | The FDH-bank adapter's three feature flags (`AIE_FDH_BANK_ADAPTER_ENABLED`, `AIE_FDH_BANK_AI_FALLBACK_ENABLED`, `AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED`) and `AIE_REVIEW_CANONICAL_ACCEPTANCE_ENABLED` are all still OFF in every environment | operator, at activation | Certification does not change that, and should not. The corpus runs them ON **in-process only** |
| **`M12A-O2`** | The parser bridge reports `sourcePage: 1` for every row, because it is handed one concatenated text rather than per-page text | disclosed, pre-existing | Already disclosed in `parser.ts`'s own header. FDH-A02 proves multi-page **content** is fully recovered; it does not prove per-page provenance through this bridge. The full-fidelity per-page path remains FDH-5's own `runBankPdfPipeline`, which is what the accept-time commit actually calls |
| **`M12A-O3`** | No OCR engine is wired into this repository, so an image-only statement stays refused | disclosed, pre-existing | Inherited unchanged from FDH-5. Not in this phase's corpus because there is nothing to certify |
| **`M12A-O4`** | **On a FULL reimport, the statement-period-overlap rule goes silent.** Observed on FDH-A07R: `overlapsPrior` is computed from the date coverage of the **non-duplicate** rows, and on a complete reimport there are none, so `computeDateCoverage` returns nulls and the overlap rule never fires — even though a prior statement covering the identical period was seeded. | disclosed, not fixed | **Harmless to the outcome and therefore not fixed here**: the run is still blocked `unresolved` by the balance rule (`not_available` with rows present → `indeterminate`), and per-row economic-fingerprint dedup — the real duplicate-prevention mechanism — worked perfectly, marking all four rows `duplicate_confirmed`. It is recorded because the overlap rule exists precisely so an overlapping **period** is never invisible to a reviewer, and on the one case where the overlap is total it is invisible. A partial reimport (some new rows, some duplicates) would still surface it |

---

## 10. Files changed

| File | Change |
|---|---|
| `app/api/aie/fdh-bank/intake/route.ts` | Intake-time canonical write and its import **removed**; response contract made explicit about it |
| `lib/aie/adapters/fdhBankStatement/types.ts` | Two new candidate names for `M12A-F1`, with the reasoning |
| `lib/aie/adapters/fdhBankStatement/parser.ts` | Emits the unreadable-row count and evidence |
| `lib/aie/adapters/fdhBankStatement/reconciliation.ts` | New `fdh_bank_statement_row_extraction_completeness` rule |
| `lib/aie/review/reasonCodes.ts` | Reviewer-facing copy for that rule |
| `tests/support/buildM12aFdhBankCorpus.ts` | **new** — 12 sealed synthetic documents |
| `tests/support/aieAccuracyHarness.ts` | **new** — domain-agnostic measurement harness |
| `scripts/m12a-fdh-bank-certification/oracle.json` | **new** — the sealed independent oracle |
| `scripts/m12a-fdh-bank-certification/results.json` / `results_table.md` | **new** — machine-readable results, regenerated by the suite |
| `tests/unit/m12aFdhBankIntakeGate.test.ts` | **new** — RED reproduction, then the lifecycle regression guard |
| `tests/unit/m12aFdhBankAccuracyCorpus.test.ts` | **new** — the corpus driver |
| `tests/unit/aieFdhBankStatementReconciliation.test.ts` | Updated for the new always-emitted rule; three new tests |

**Commits, in order, each one readable on its own:**

| SHA | What |
|---|---|
| `4daa0a4` | RED reproduction of the intake-time canonical write — **passes on the defective code** |
| `e82914f` | The fix: removal, and reuse of the existing acceptance path |
| `5f07c75` | The corpus, committed **with** the defect it found (1 unexplained omission, 20.00% false accept, 8.33% false canonical write) |
| `8725fb6` | `M12A-F1` fixed; all three of those measures go to zero |

---

## 11. For the next M12 phase (Insurance certification + AI privacy proof)

1. **Reuse `tests/support/aieAccuracyHarness.ts`. Do not build a second one.** It is
   domain-agnostic on purpose: it takes expected/observed field sets, expected/observed economic
   items, and a handful of lifecycle facts. An Insurance corpus supplies policy fields and
   premium/benefit line items instead, and every metric means exactly the same thing. The metric
   definitions live in that file's header, in code, so the two reports cannot define "precision"
   differently.
2. **Reuse the corpus's driving pattern, and its two traps.** Route handlers *are* directly
   invocable here — that is worth knowing, because the prior mission recorded the opposite. But
   `vi.mock` factories are instantiated once per importer graph (keep shared fake state on
   `globalThis`, never reset at module top level), and `recordTransition` is what moves
   `aie_extraction_run.status` (mirror it, or nothing is ever acceptable and the
   false-canonical-write rate is vacuously zero).
3. **`M12A-F2` will hit Insurance identically**, and its fix belongs in shared AIE-1.1 core, not
   in the Insurance adapter. See §9.
4. **Insurance's own intake route already removed the intake-time self-accept** — it is the
   route FDH-bank was fixed to match, so there is no equivalent of §3 to repeat there. Its
   canonical write never touches storage, so the binary is deleted at intake; that difference is
   deliberate and documented.
5. **Insurance declares an AI-eligible gap (`policyNameClarification`, `parser.ts:217`)**, so its
   corpus will reach the masking stage far more often than FDH-bank's did — most likely on every
   case where the product name is missing, not on one case in twelve. Expect the masking-key
   blocker to be the dominant constraint on Insurance's corpus rather than a single CONDITIONAL
   row.
6. **Ask the third question.** The most valuable case in this corpus was the one nobody asked
   for: FDH-A11 exists only because FDH-A06 passed and the obvious follow-up — *what if the
   unreadable row is somewhere the existing check cannot see?* — turned out to be a real false
   canonical write. The equivalent question for Insurance is worth finding before certifying it.

---

*End of M12A closure report. Nothing is pushed. Nothing is merged. No production database,
configuration, migration, deployment or rollout was touched.*
