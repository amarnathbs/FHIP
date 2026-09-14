# AIE-1 Investment Intelligence Dispatch and Document-Lifecycle Closure — M3 Report

**Mission:** FHIP — Investment Intelligence + AIE-1 Convergence, Master End-to-End Execution
**Phase:** M3 — AIE-1 Investment Intelligence dispatch and document lifecycle closure (Part I of the master dispatch)
**Date:** 2026-09-15
**Branch:** `mission/m3-ii-dispatch-2026-09-15` (not pushed, not merged)
**Base:** Phase 3's tip `5363aebf3a7eca80216de46951e600c50360db08`, which already carries `feature/aie-1-final-closure` merged in
**Carried forward:** the 5 prior M0/M1/M2 documents, verified byte-identical by MD5 against Phase 3's worktree

**Nothing was pushed. Nothing was merged to `main`. No migration was created or applied. No production
database was written or read for this phase's own work. No AWS resource was created. No credential
value, PAN, folio number, holder name or raw statement text appears anywhere in this document.**

---

## 0. Headline

> **M3 verdict: CONDITIONAL PASS.**
>
> **The missing Investment Intelligence dispatch path now exists and is proved running against the
> real DEV project** — a user-authenticated route, through quarantine, decryption, certified
> deterministic parsing, deterministic reconciliation, typed AIE unresolved items, and a run row in
> exactly the state the governed acceptance gate will read. It performs **no canonical write**, and
> therefore does not reproduce the intake-time auto-commit M2 recorded as **M2-OPEN-6**.
>
> **Both Product-Owner decisions are implemented in full.** Identifier masking is now a keyed
> one-way HMAC with no escrow map, no decrypt path and no reveal capability anywhere in the
> codebase; mask-token retention is a fixed 48-hour TTL that fires on age alone, joined to nothing.
>
> **Three real defects were found by running the thing rather than reading it.** Two are fixed (a
> reconciliation that silently never ran on a first upload; a reported state that diverged from the
> stored state). One is disclosed and deliberately not fixed, because fixing it changes shipped
> production parser behaviour: **on the CAS layout, a printed opening balance is discarded** — and
> the variance it produces is exactly the size of the discarded value, which makes it a concrete,
> testable hypothesis for reconciliation residuals M1 recorded as having no hypothesis at all.
>
> **It is not a FULL PASS, and the reasons are named rather than softened:** the masked-AI-fallback
> half of the pipeline is structurally unexercised end to end (two independent blockers, one of them
> operator-owned), and the S3 + GuardDuty quarantine the mission's H.2/H.3 describes remains
> unreachable infrastructure, re-confirmed fresh today.

---

## 1. Evidence index — I.1 to I.13 at a glance

| ID | Item | Verdict |
|---|---|---|
| **I.1** | The missing real Investment Intelligence path | **PASS** — built; 17 unit + 6 live-DEV tests; proved end to end against the real DEV project |
| **I.2** | Source-document identity | **PASS** — identity is the immutable intake UUID; the named two-document case is tested |
| **I.3** | Preserve certified II parsers | **PASS** — deterministic parsers remain Level 1; zero AI calls on every clean fixture; an unclaimed document is refused, not passed to AI |
| **I.4** | AI investment JSON contract | **PASS (contract)** / **NOT EXERCISED (path)** — versioned strict schema built and proved; the fallback branch it serves is unreachable today, see §5 |
| **I.5** | Deterministic reconciliation after AI | **PASS — with a real defect found and FIXED** (brand-new positions were never reconciled) |
| **I.6** | PC4 semantic preservation | **PASS** — PC4's 85-file regression contract re-run: 84 passed / 1 skipped, 1,673 tests passed, **byte-identical to M1's recorded baseline** |
| **I.7** | AI vs deterministic disagreement | **PASS (engine)** / **NOT EXERCISED (path)** — neither source wins by default; 19 tests including the proof it is not a dressed-up precedence rule |
| **I.8** | Cross-source overlap | **CONDITIONAL PASS** — the AIE path provably does not bypass or shadow the certified engine; the four order-invariance proofs remain live-dev-only (CG-1/CG-6), now runnable |
| **I.9** | Atomic canonical write | **PASS** — no write at dispatch; the M2-OPEN-6 anti-pattern is asserted absent by an executable guard |
| **I.10** | Binary lifecycle under the no-retention policy | **PASS** — delete, independently verify absent, then record; proved on a real storage object |
| **I.11** | Abandoned-document retention | **PASS** — the 24-hour backstop selects on age alone; verified against real DEV storage and DB bookkeeping |
| **I.12** | Investment live-DEV corpus | **CONDITIONAL PASS** — 10 fixtures with sealed oracles + a live-DEV run; 3 scenarios named as covered elsewhere or blocked, not silently dropped |
| **I.13** | Investment accuracy thresholds | **PASS** — every threshold asserted literally, with negative controls and a mutation proof |

**Six items pass outright. Four pass with a named, evidenced condition. Two (I.4, I.7) are built
and proved as contracts but cannot be exercised end to end, for two blockers named in §5.**

---

## 2. The two Product-Owner decisions

### 2.1 Decision 1 — one-way HMAC, no reveal

M2 recorded this as **PO-BLOCKER-2**: global invariant D.6 requires "stable pseudonyms via keyed
one-way HMAC, never reversible/dictionary-vulnerable", while the implementation did the opposite —
opaque counter tokens (`[MASKED:<type>:<salt>:<counter>]`, carrying no derivation from the value at
all) plus an AES-256-GCM-encrypted escrow map that made the original recoverable through the
evidence-reveal feature. The Product Owner chose D.6, explicitly accepting that a user will never
see their own original folio / account / PAN / holder-name value again, including during their own
document review.

**What was built** (`lib/aie/masking/identifierToken.ts`, new):

| Property | How it is achieved | Why it matters |
|---|---|---|
| **Genuinely keyed** | HMAC-SHA256 under a subkey derived from `AIE_MASK_TOKEN_ENCRYPTION_KEY` by one-step HKDF-style domain separation | A folio, a 10-character PAN and a BSB+account are all small enough spaces to enumerate exhaustively. An unkeyed digest would be trivially reversible while still *looking* one-way. A test asserts the output is not any unkeyed digest of the same inputs, and that changing only the key changes the output. |
| **Tenant-bound** | The MAC input is `tenantKey ‖ type ‖ normalisedValue` | The same folio under two users yields two different tokens, so a provider observing many documents cannot correlate users by identifier (PII-06). `tenantKey` is required with no default — an untenanted call throws rather than silently minting a globally-correlatable token. |
| **Stable** | Deterministic per `(tenant, type, value)` | January's and February's statements yield the **same** token for the same folio. This is the "account/folio stable token" I.4 asks for, and the per-call counter scheme could not express it at all. A genuine improvement, not only a cost. |
| **Injective input** | Length-prefixed rather than separator-delimited | Without it, `('ab','c',x)` and `('a','bc',x)` would MAC identically. A separator would work only if it provably cannot occur in a folio's charset, which is not something that charset guarantees. |
| **Structurally safe token** | MAC rendered in the letters `a`–`p`, 24 chars (96 bits) | `maskText` applies its patterns in sequence over progressively-masked text. A hex-rendered MAC would be re-matched by `long_digit_run` (`\d{11,}`) or `card_number` (13–19 digits) and double-tokenised. The previous random salt documented this same hazard for itself; the property is preserved deliberately. |
| **Fails closed** | Throws on a missing or malformed key | No key means no tokenisation, which means no payload, which means nothing egresses. Never downgraded to an unkeyed hash. |
| **Compatible** | Still matches the pre-existing `/^\[MASKED:[a-z_]+:[a-z]+:[0-9a-z]+\]$/i` shape | No downstream consumer had to be loosened to accept it. |

**What was removed, not merely disabled.** This is the part that makes the decision real:

- `lib/aie/masking/tokenMapCrypto.ts` — **deleted**.
- `persistMaskTokenMap` — **deleted** from the repository. It was the only writer of
  `aie_mask_token_map`. Removed rather than left dormant, because a dormant function that writes
  reversible PII is an invitation for a future adapter to call it "because it was already there".
- `findMaskTokenCiphertext` — **deleted**.
- `MaskingResult.reversibleTokenMap` — **removed** from the type. `maskText` no longer retains
  original values past the `.replace()` callback that MACs them.
- `revealMaskedToken` — now **always refuses**, with the typed reason
  `not_revealable_one_way_masking`, and audits the refusal. Its dependency surface is asserted by
  test to contain exactly `{ audit, getRunForUser }` — no decrypt, no ciphertext lookup.

Even with every flag on and full database access, recovering an original from a token would mean
breaking HMAC-SHA256 or obtaining the server-held key. Verified read-only on 2026-09-15:
`aie_mask_token_map` holds **zero rows in DEV and zero rows in production**, so no historical escrow
row exists to migrate or strand either.

**UI and copy** (`components/aie/review/EvidenceReveal.tsx`): the Reveal control is **removed**, not
shown-and-disabled. An affordance that can only ever fail invites a user to believe recovery is
possible and then tells them no. The token itself is still displayed, deliberately — a stable
pseudonym lets a reviewer see that two rows refer to the same folio, which is what the review task
actually needs, and replacing it with bullets would destroy that without protecting anything
further. Nothing in the component says "original value" or "hidden value". The route answers **410
Gone** for a one-way token rather than 404 or 403: the resource is not missing and access is not
denied — the capability was removed and will not return, which is what 410 means, and it lets a
client stop retrying.

#### 2.1.1 Category-by-category breakdown (the decision's own item (c))

The question the Product Owner asked: which D.6 categories can move to pure one-way HMAC with no map
at all, and which genuinely still need short-term reversible or plaintext handling.

| D.6 category | Detector | **Scheme now** | Map needed? | Reasoning |
|---|---|---|---|---|
| **Names** (investor / account holder / unit holder / first/second/joint holder) | `person_name_label`, label-anchored | **One-way HMAC** | **No** | Nothing downstream consumes the name. PC4-INV-12 records that `holderName` is parsed and **discarded** — it has zero consumers outside tests. Owner attribution comes from an explicit `ownerMemberId`, never from the document. |
| **Nominee details** | same `person_name_label` rule | **One-way HMAC** | **No** | Same as names. D.6 requires nominee details never to egress; no FHIP feature reads them. |
| **Email** | `email` | **One-way HMAC** | **No** | No consumer. |
| **Phone** | `phone` (AU/India mobile shapes) | **One-way HMAC** | **No** | No consumer. |
| **PAN / tax id** | `tax_id` (India PAN, AU TFN) | **One-way HMAC** | **No** | The canonical write never receives a PAN: `camsParser` already masks it at parse time (`maskPan`, first-5/last-1) and `ii_source_documents` has no PAN column. |
| **Aadhaar** | `aadhaar` (spaced canonical form) | **One-way HMAC** | **No** | No consumer. |
| **Bank / card / account numbers** | `bank_account`, `card_number`, `long_digit_run` | **One-way HMAC** | **No** | Investment Intelligence stores `account_number_masked`, never a full number. |
| **IFSC** | `ifsc` | **One-way HMAC** | **No** | No consumer. |
| **Folio / account identifiers** | `folio_number`, label-anchored | **One-way HMAC** | **No** | **The important row.** A folio IS load-bearing for account identity — but the canonical write never reads the masked text. `write.ts` re-fetches the **original document bytes** from quarantine and hands them to `processSourceDocument`, which re-parses them unmasked. Masking exists solely on the AI-egress path. And the HMAC is *better* here than the old scheme: stable per user, so it can serve as I.4's folio stable token. |
| **Address** | `address_label`, **new in M3** | **One-way HMAC** | **No** | Closes **M2-OPEN-7**, the last D.6 category with no detector of any kind. Disclosed limitation below. |
| *Financial values* (amounts, units, NAV, closing balances, market value) | — | **Not masked at all** | **N/A** | **Not a masked-identifier category, and unaffected by this decision.** H.9's own text preserves them ("financial values needed for extraction may remain"). They are not identifiers — they are the evidence the adapter exists to read. Masking them would not protect a user; it would make the feature impossible. |

> **Answer to the decision's question (c): ZERO categories require a reversible map.** Every masked
> identifier category moves to pure one-way HMAC. The only category anyone might expect to need
> reversal — folio, because account identity depends on it — does not, because the canonical write
> re-parses the original document rather than consuming masked text. That architectural fact is what
> makes the Product Owner's decision cost-free on the write path and confined entirely to the review
> UX, exactly as they understood it.

**Disclosed limitation on the new address rule**, stated rather than implied to be complete: a postal
address printed across several lines is masked on its **first line only**. There is no reliable
end-of-address signal, so extending the capture across newlines would run on and swallow the next
labelled field — the exact over-capture failure the folio rule already hit once during M2 and had to
be narrowed for. Lines two and three of a wrapped address still reach the provider. This is an
improvement on "no rule at all", and it is not full coverage.

Two supporting hardenings came out of building it: an `(?<!e-?mail )` lookbehind, so `Email Address:
investor@example.com` stays classified as an **email** rather than an address (the value is masked
either way — the failure would be in `coverage_by_type`, the same "privacy evidence describes the
document inaccurately" problem M2 fixed for TFN-vs-folio); and a global guard that no rule may
re-tokenise a span already containing `[MASKED:`, so an open-ended pattern cannot MAC a token.

### 2.2 Decision 2 — fixed 48-hour TTL, independent of document lifecycle

M2 recorded this as **PO-BLOCKER-4**, with the H.10 finding stated as: *"Mask token maps — which
hold reversible PII under a single global key — are never destroyed. There is no TTL, no purge, no
retention policy, and no code path that can delete them."* The only theoretical destruction route
was `on delete cascade` from `aie_extraction_run`, and nothing ever deletes an extraction run.

**Implemented at 48 hours** — the looser end of the decided 24–48 band. Nothing shorter was chosen
because no reason to prefer 24 was found: after decision 1 there is no legitimate writer of this
table left at all, so the TTL now acts purely as a hard backstop rather than as a working retention
window, and the looser end is the safer default for a backstop.

**It is lifecycle-independent, and that is asserted as a property rather than left to a comment.**
`purgeExpiredMaskTokenMapRows` filters on `created_at` and nothing else — no join to
`aie_document_intake`, no `status`, no `purge_status`, no run state, no "is this still under review"
signal. A test enumerates every filter the query applied and asserts the lifecycle columns are
absent from that list, so a future change that "helpfully" started skipping rows mid-review would
fail rather than quietly substitute a different policy for the decided one. A second test asserts
the accepted consequence directly: an expired row belonging to a run that is still awaiting a
decision **is deleted**.

**No migration was needed, and that matters practically rather than aesthetically.**
`aie_mask_token_map.created_at` already exists (`0140:312`, `not null default now()`), so the TTL is
expressed against it instead of adding an `expires_at` column. This environment has no way to apply
DDL to DEV or production — M0 operator item **OA-3**: no SQL-execution RPC is exposed on either
project — so a column-based TTL would have shipped as an **unapplied migration**, and the retention
guarantee would have been a statement of intent rather than something that actually runs. It runs.

Wired into the existing sweep (`app/api/aie/cron/purge-sweep/route.ts`), **first and
unconditionally**, before any document-lifecycle work, so a slow or failing binary purge later in
the handler cannot delay or skip the retention guarantee.

**Proved live** (see §4, L5/L6): a row seeded 72 hours old, attached to a run in a **non-terminal**
state, was deleted by the real sweep; a row inside the TTL survived the same sweep. Without the
second half, the first would pass for a sweep that deleted everything.

---

## 3. I.1 through I.13, item by item

### I.1 — the missing real Investment Intelligence path — **PASS**

**What was actually missing.** Every individual piece of AIE-1.2 existed and was unit-tested: a
registered parser wrapping the certified CAMS/KFintech/Folio parsers, conservative account and
instrument matching, a deterministic reconciliation rule, typed unresolved items, a gated atomic
canonical write, and a governed acceptance gate that already dispatches on `II_ADAPTER_ID`. **What
did not exist was anything that called them together.**

Three facts, verified fresh against the current tree:

1. `registerInvestmentIntelligenceAdapter()` had **zero production callers** — so `sniffDocument()`
   could never match an investment document.
2. `buildInvestmentReconciliationRule` had **zero production callers** — the
   `InvestmentReconciliationContext` it consumes was only ever assembled inside test files.
3. The generic `/api/aie/intake` route ran `noDomainAdapterReconciliationRule`, which reports
   `not_applicable`, which `accept.ts` explicitly refuses as *"accepting a document nothing ever
   actually checked"*.

Net effect: `source_module_hint=investment_intelligence` was metadata and nothing else — exactly
what the dispatch says must not be treated as dispatch.

**What was built.**

| File | Role |
|---|---|
| `lib/aie/adapters/investment-intelligence/dispatch.ts` | The orchestration service. Quarantine → decrypt if needed → local extraction → certified deterministic parser → gated masked AI fallback → strict schema → deterministic reconciliation → typed AIE unresolved items → correct run state. **No canonical write.** |
| `lib/aie/adapters/investment-intelligence/context.ts` | The read-only canonical snapshot the reconciliation rule was always written to consume but which nothing ever assembled. Every query is a SELECT. |
| `lib/aie/adapters/investment-intelligence/householdContext.ts` | Jurisdiction resolution, from the authenticated profile, failing closed. |
| `app/api/aie/investment-intelligence/intake/route.ts` | The authenticated HTTP dispatch route. |
| `app/api/aie/investment-intelligence/intake/[intakeId]/process/route.ts` | The password-unlock / resume endpoint. |

**A dedicated route rather than a flag on the generic one.** Widening `/api/aie/intake` to branch on
`source_module_hint` would have made a metadata field load-bearing for routing — the same mistake in
a new place. `accept.ts` already made the opposite choice deliberately, dispatching on the run's
recorded `adapter_id` and never on the hint. The new route still *records* the hint (it is true and
useful for querying) while the actual adapter binding comes from the deterministic parser that
claims the document and is written to `aie_parser_attempt.adapter_id` — the one fact acceptance
dispatches on.

**Jurisdiction is not inferred from the document.** A CAMS statement is an Indian document, so
"detect IN from the parser that claimed it" looks obvious and would work for every fixture. It is
still wrong: a user resident in AU can legitimately hold an Indian folio, and deriving jurisdiction
from the document's origin would silently mislabel that holding's currency and country — a
cross-border error that surfaces much later, in net-worth aggregation, far from its cause. Country
comes from `getUserHomeCountry` and **fails closed**; an unresolved home country returns a `409` the
user can act on rather than an import that is quietly wrong.

**Password support** (closing half of M2's H.11, for this surface). M2's verdict explained precisely
why AIE's password capability was unreachable: *"AIE intake is a raw-body byte upload with the
filename in the query string, so a password cannot be added to the existing request shape — it needs
either a second endpoint or a body/header redesign. That is a new authenticated API surface carrying
a secret, and it should be designed and reviewed rather than bolted on."* This is that second
endpoint, built to the constraints M2 itself named and following the repository's one existing
rate-limited precedent:

- the password travels in the **JSON body of a POST** — never a URL, query string or header, so it
  cannot land in an access log, a referrer or an analytics event;
- it is read into one local, passed once to the decrypt attempt, and never assigned anywhere that
  outlives the handler — no column, no audit metadata, no response field, no error message;
- **rate limited** by reusing FDH-5's certified `checkPasswordAttemptRateLimit` **unchanged**, fed
  from AIE's own audit trail, so the bound (8 per document per hour) stays defined in exactly one
  place in this codebase;
- the attempt is recorded **before** the decrypt is tried, so aborting a request cannot buy a free
  guess;
- the two failure cases stay distinguishable **by exception type**, never by string-matching a
  message, preserving PC4-INV-17's discipline on a new surface.

> **M2-OPEN-8 is only half closed, and the half that remains is stated plainly.** The *pre-existing*
> Investment Intelligence password endpoint
> (`app/api/investment-intelligence/source-documents/[id]/process/route.ts`) still has no rate
> limiting, which M2 correctly called "a real brute-force exposure on an authenticated endpoint".
> That route is outside M3's scope and was **not touched**. M2-OPEN-8 stays open for it.

**Evidence:** `tests/unit/aieM3InvestmentDispatch.test.ts` — **17 tests**, driving the real service
with **real PDF bytes** through **real pdf-parse extraction** and the **real certified parsers**
(only the database and object storage are substituted). Plus **6 live-DEV tests** against the real
DEV project (§4).

### I.2 — source-document identity — **PASS**

Identity is `intakeId`, the `aie_document_intake` primary key: a server-generated UUID. `storageKey`
is used **only to fetch bytes**, never as a logical identity, and is itself built from two random
UUIDs (`{userId}/{intakeId}/{intakeId}.bin`), so it carries no filename component and cannot collide
between two documents with the same name.

The dispatch's own named test case — **same user, same filename, different bytes** — is exercised
directly: two intakes, two distinct runs, and each action processed exactly the intended document
(the first reconciled; the second, a deliberately-wrong statement, did not). Overlapping statement
periods and differing passwords are covered by the password suite and by the corpus's monthly-delta
and overlap fixtures.

> **A known-open sub-case is carried forward unresolved, not silently absorbed.** Regression contract
> **CG-10**: two parse runs sharing an identical `storage_path` caused a second document's "Process"
> button to hit the **first** document's run. That is an *Investment Intelligence* frontend defect
> recorded by PC4 as "a separate, pre-existing frontend issue"; it has no owner and no test. The new
> AIE path does not have it — identity is the intake UUID — but the old path still does. **M3 does
> not close CG-10.**

### I.3 — preserve certified II parsers — **PASS**

The certified CAMS / KFintech / Folio-Details parsers remain Level 1 and run **before** any AI
consideration. `dispatch.ts` calls `detectSource` first and, if no certified parser claims the
document, **refuses it** rather than handing an unknown layout to an AI fallback and hoping — the
document catalogue's own rule is "do not claim broker/platform support you have not built and
tested". Proved by fixture C11: a document no parser claims produces `not_an_investment_document`,
**no run is created**, and the intake is rejected.

Zero AI calls occur on every clean fixture, asserted rather than assumed (`aiWasUsed === false`).

### I.4 — AI investment JSON contract — **PASS (contract) / NOT EXERCISED (path)**

`lib/aie/adapters/investment-intelligence/documentFactsSchema.ts`, registered against AIE-1.1's
existing Zod registry as `aie_ii_document_facts@1` — **no second schema mechanism**.

It is a different contract from the one that already existed, and both stay.
`schema.ts`'s `aie_ii_adapter_field_completion` is a gap-filling contract with a single-entry enum
("one narrative fragment was illegible; what does it say?"), correct for that job. This one is the
whole-document facts contract I.4 specifies — and it is what makes the I.7 comparison possible at
all, since you cannot compare two sources field by field unless the AI side speaks in fields.

**Coverage against I.4's named list:** document type/source, statement period, account/folio stable
token, AMC/institution, scheme text, ISIN (conditional), transaction date, narrative, type
candidate, amount, units, NAV/price, running unit balance, fees (`feeAmount` + `feeKind`, including
stamp duty and STT), closing units, statement NAV, NAV date, statement market value, opening-balance
evidence, source page/line/region, and missing/ambiguous reason code. **All present.**

**The anti-invention rules are enforced by shape, not by policy text:**

- **No canonical-id field exists anywhere** — no `accountId`, `instrumentId`, `userId`,
  `householdId`, `taxLotId`. With `.strict()` at every level, naming one is a validation failure. So
  "AI must never invent a canonical instrument" is a sentence this contract *cannot express*, rather
  than a rule someone has to enforce later.
- **No confidence field exists** — P4/REC-04. The cheapest guarantee that a score cannot move a
  reconciliation outcome is to give the model no channel to report one.
- **ISIN requires paired evidence.** `isin` is nullable beside `isinPresentOnDocument`; supplying an
  ISIN while stating it was not printed is a **schema rejection** via a cross-field refinement, not
  a judgement call at a call site. The symmetric incoherence is rejected too.
- **Opening balance requires paired evidence**, for the same reason, and is modelled as its **own
  field** rather than as a transaction — a schema that could only express it as a transaction would
  invite exactly the PC4-INV-08 mistake it exists to prevent.
- **Money and units are exact decimal strings, never JSON numbers.** A JSON number is an IEEE-754
  double; II's entire money layer is exact scaled integers precisely because a double silently loses
  unit and NAV precision, and this is the boundary where that would be hardest to notice.
- **The transaction-type enum is deliberately narrower than the canonical union**, excluding
  `switch_in`/`switch_out`/`stp_*`/`swp`/`merger`/`bonus`/`split`/`sale`. Several of those feed R6's
  tax-lot engine, which needs cost-basis data no statement narrative supplies — the same reasoning
  PC4-INV-18 records for mapping "Lateral Shift" to the neutral `transfer`. A model that guessed one
  would not merely mislabel; it would seed a tax lot with an invented cost base. A narrower enum
  fails in the safe direction: an unrepresentable transaction becomes `unknown`, which is an
  unresolved item for a human. A test asserts the subset relation against the canonical union (so a
  typo cannot create a value that maps to nothing) and asserts the exclusions are still excluded.
- **Every missing-reason code describes the DOCUMENT, never the model's certainty.** `low_confidence`
  is deliberately absent — it would reopen the "hide errors behind a confidence score" channel I.13
  forbids.

**Evidence:** `tests/unit/aieM3InvestmentDocumentFactsSchema.test.ts` — **22 tests**.

**Why the PATH is NOT EXERCISED:** see §5. Two independent blockers, one of them operator-owned.

### I.5 — deterministic reconciliation after AI — **PASS, with a real defect found and FIXED**

The adapter runs, against a read-only snapshot of real canonical state: **unit roll-forward**
(`reconcilePosition` + `determineHistoryCompleteness`, II's own certified functions),
**duplicate/overlap** (`computeTransactionFingerprint`, the same formula the real write path uses),
**statement value / closing-balance check**, **account and folio identity** (conservative matching;
ambiguity becomes a typed blocking item, never a guess), **owner check**, **opening-balance
completeness classification**, and **canonical conflict** (an existing account's currency against
what this statement's jurisdiction implies).

> #### M3-F2 — brand-new positions were never reconciled. **FIXED.**
>
> `rollForwardResults` used to `continue` — skip entirely, producing **no result at all** — whenever
> a position did not resolve to an *existing* canonical account and instrument, on the reasoning
> that there is "nothing to roll forward against yet".
>
> That conflates two different checks. Roll-forward against **prior canonical state** does need an
> existing snapshot. The **statement-internal** check needs nothing: a statement's printed closing
> balance must equal the sum of its own printed transactions, from zero, regardless of whether the
> platform has ever seen this folio.
>
> **Consequence:** every position on a user's **first upload** was silently unreconciled.
> `worstOutcome` over the remaining results read `pass`, the run reached `awaiting_acceptance`, and
> `accept.ts` — which re-checks the recorded outcomes rather than re-deriving them — would have
> found nothing to object to. **A materially wrong first statement could be accepted on a
> reconciliation that never ran.**
>
> **Why it survived review:** every existing unit test for this rule seeds an existing account and
> instrument. Nothing exercised the first-upload case. It was found by M3's own dispatch test
> driving a deliberately-broken statement (corpus fixture C10) through the real path with an empty
> canonical store.
>
> **Fix:** reconcile from zero using II's own `reconcilePosition` with `statementCoversFromInception`
> — exactly what `documentProcessing.ts` already does for a first-time position on the real write
> path. No new formula. Rows are grouped by the statement's own `(folio, scheme)` identity, which
> keeps two folios holding the same scheme **separate** (the PC4-INV-07 property account-scoped FIFO
> depends on) rather than summing them. The rule id is stable and unique per position, because
> `latestReconciliationOutcomesForRun` collapses by `rule_id` — two positions sharing one would mean
> one silently overwrote the other's outcome.
>
> **Proved live:** a first upload of a statement claiming 175.000 units against 100.000 of activity
> now produces a roll-forward `fail` with `delta = -75.000` and a blocking unresolved item, against
> the real DEV database with an empty canonical store.
>
> **Regression cover added** in `tests/unit/aieIiAdapterReconciliation.test.ts`, in both directions —
> a correct first statement must still `pass`, a wrong one must now `fail`. The coverage hole that
> allowed the defect is closed, not just the defect.

### I.6 — PC4 semantic preservation — **PASS**

**The central architectural fact, which is the strongest answer available:** every PC4 semantic is
implemented inside Investment Intelligence's own certified `processSourceDocument`, and the AIE
acceptance path reaches it by **re-parsing the original document bytes**. `write.ts` downloads the
quarantined file, uploads it into II's own storage, inserts an `ii_source_documents` row, and hands
that row to `processSourceDocument`. **The AIE field candidates are not the input to the canonical
write; the document is.**

So there is no second parser, no second classifier and no second reconciliation on the write path
that could drift from PC4's. Preservation is by **construction**, not by re-implementation. A
structural test pins it, so a future refactor that started writing from candidates fails loudly.

The semantics AIE's own candidate encoding could still get wrong are verified directly: opening
balance is an `adjustment` and carries no NAV or amount to invent a cost base from; a reversal keeps
its negative effect and the position nets to the printed closing balance; two folios holding one
scheme stay two positions; exact reimport produces byte-identical fingerprints (with a non-vacuity
control); and amounts/units/NAV survive as exact decimal strings, never floats.

**PC4's own regression contract re-run in full** — the 85 files §1 of
`II_PC4_POST_CLOSURE_REGRESSION_CONTRACT_2026-09-15.md` names:

```
tests/unit/ii*                        82 passed | 1 skipped (83 files), 1,624 passed | 5 skipped
tests/unit/reportsIIChapters          \
tests/unit/fdh11AuInvestmentIntelligence  }  2 passed, 49 passed
                                      ------------------------------------------------
TOTAL                                 85 files: 84 passed, 1 skipped
                                      1,673 tests passed, 5 skipped, 0 failed
```

**Byte-identical to M1's recorded baseline** (*"84 passed, 1 skipped, 0 failed; 1,673 tests passed, 5
skipped, 0 failed"*). **Zero PC4 regressions.**

### I.7 — AI vs deterministic disagreement — **PASS (engine) / NOT EXERCISED (path)**

`lib/aie/adapters/investment-intelligence/disagreement.ts`.

**The property that is hard to get right, and the one a naive implementation gets wrong:** the
obvious design is a precedence table — deterministic beats AI. That is explicitly forbidden, and
rightly, because the deterministic parser's real failure mode is not "returns nothing" but "misreads
a glued or wrapped row and returns a confident wrong number" (PC4 defects #2 and #7b were exactly
that). A precedence table would silently discard the one piece of evidence that could have caught it.

So resolution is a three-way classification, not a preference:

1. **Agree** — within the module's own certified tolerance, and by **value** rather than string, so
   `100.000` and `100.0` agree (failing a document over a formatting difference would be a defect,
   not a safety property).
2. **Objectively resolved** — an *external arithmetic fact on the document itself* settles it. The
   only such fact available on an investment statement is the printed running unit balance: if
   exactly one candidate makes the roll-forward close, the document has answered the question. The
   winner is recorded **with the arithmetic that decided it**, so the decision is auditable rather
   than asserted.
3. **Unresolved** — a material disagreement with nothing objective to settle it becomes a
   **blocking** `aie_unresolved_item` carrying **both** candidate values and **both** provenances.

**Three tests make the "neither wins" claim real rather than decorative:**

- the same tie-breaker mechanism picks the **AI** value when the AI is the one that closes — the
  arithmetic is identical, only which side is right has changed. This is what distinguishes a
  genuine tie-breaker from "deterministic wins, with extra steps";
- when **neither** candidate closes, the disagreement **stands** — the nearer one is not chosen,
  because a printed balance disagreeing with both sources is itself a finding;
- the tie-breaker is **not applied** to amounts or NAVs, where the identity does not hold, rather
  than being misapplied to fabricate a winner.

**Materiality is a closed property of the field**, never of the size of the gap: units, amount,
NAV/price, transaction date, type candidate and closing units are material; narrative and scheme text
are not. A 0.001-unit disagreement is small and still wrong about someone's money, so it is still
material.

**No confidence anywhere** — asserted structurally (`compareFieldEvidence.length === 3`, and the
serialised result contains no `confidence`).

**Evidence:** `tests/unit/aieM3SourceDisagreement.test.ts` — **19 tests**.

**Why the PATH is NOT EXERCISED:** see §5.

### I.8 — cross-source overlap — **CONDITIONAL PASS**

Order-invariance of CAS-then-Folio and Folio-then-CAS is a property of `crossSourceIdentity.ts` and
`documentProcessing.ts`, already certified under PC4-INV-06. What M3 has to show is that the AIE path
does not **bypass or shadow** it, and it does not: the adapter imports II's own
`computeTransactionFingerprint`, `reconcilePosition` and `determineHistoryCompleteness`, and defines
no local implementation of any of them (asserted structurally, including the absence of any local
`createHash`). The canonical write re-parses the original document through `processSourceDocument`,
so the cross-source engine runs exactly as it does for a manual upload.

**Why CONDITIONAL rather than PASS.** The four scenarios I.8 names by test — CAS-then-Folio,
Folio-then-CAS, monthly updates, exact reimport at the DB level — are proved **only** in
`tests/live-dev/iiFs1CamsFolioStatementLiveDev.test.ts` (regression-contract gaps **CG-1** and
**CG-6**). M3 has made them *runnable* rather than merely dormant (below), but did not re-run that
suite: it is PC4's own certified proof over PC4's own fixtures, and re-running it would evidence PC4,
not the AIE path. **M3 asserts non-bypass; it does not re-certify order-invariance.**

> **CG-1 is now closed as a tooling gap.** `vitest.config.ts` includes only `tests/unit/**`, so all
> live-dev suites are dormant under `npm test` — deliberate, since they talk to a real database, but
> with a real cost the regression contract spelled out: *"A later phase that runs `npm test` and sees
> green has NOT regression-tested those four."* Running them previously meant hand-assembling a
> config, which is exactly the friction that makes a reviewer skip the step. M3 adds
> `vitest.live-dev.config.ts`, so it is one documented command. **Two independent locks remain:** the
> config can reach the suites, and each suite's own opt-in environment gate admits them. The config
> alone runs nothing.

### I.9 — atomic canonical write — **PASS**

Accepted Investment results write through **one** domain-owned atomic, idempotent service, reached
**only** through `POST /api/aie/review/runs/{runId}/accept`. That gate re-validates server-side:
tenant (`getRunForUser`'s own `.eq('user_id', …)`), run status is exactly `awaiting_acceptance`,
blocking-item count re-derived rather than trusted from the client, the **latest** reconciliation
outcome per rule, adapter identity from the run's recorded `adapter_id`, a CAS transition, and an
idempotency key via `findOrCreateWriteBatch`. No browser-supplied canonical id is trusted — the
adapter's schema cannot even express one (I.4).

> **M2-OPEN-6, answered directly.** M2 recorded that `app/api/aie/fdh-bank/intake/route.ts`
> auto-commits a canonical write at intake, bypassing `accept.ts` — the same pattern the Insurance
> route explicitly removed as an AIE-1.5 violation. **The M3 Investment Intelligence dispatch does
> not reproduce it.** `dispatch.ts` imports no canonical write service, holds no reference to
> `acceptAndWriteInvestmentCandidates` or `processSourceDocument`, and contains no mutation verb at
> all. This is enforced by an executable guard in `tests/unit/aieIiAdapterProhibitions.test.ts`, not
> only by review. **M2-OPEN-6 itself remains open for the FDH route**, which M3 did not touch.

**Two adapter prohibition violations were caught in drafts of this work by the adapter's own test,
and fixed in the code rather than by relaxing the test:**

1. An early `dispatch.ts` constructed its own `AieDocumentAiGateway`, violating prohibition **P2**
   ("no adapter file imports a provider or provider-selection module — only the orchestrator wires
   the gateway in"). Fixed by injecting `AieOrchestratorDeps` from the route, matching the Insurance
   route's own structure.
2. `context.ts` reads canonical `ii_*` tables, which tripped a blunt check for `.from('<table>')`.

For (2) the **test was tightened, not relaxed**: it now asserts the property the prohibition is
actually about — no adapter file **mutates** a canonical table — per occurrence, requiring a
`.select(` and refusing any mutation verb in the same statement, plus a whole-file mutation-free
assertion on `context.ts` and a dedicated no-write assertion on `dispatch.ts`. The scan was also made
comment-aware, because the blunt version punished a file for *documenting* why it must not call
`processSourceDocument` — the wrong incentive, since it pushes a future author to delete the
explanation rather than the call.

### I.10 — binary lifecycle under the no-retention policy — **PASS**

The required order — delete, **independently verify absent**, *then* mark purged — holds, and is
asserted by position in the source so a reordering fails. Proved on a **real storage object** in DEV
(§4, L4): the object existed before, the service reported `deleted`, an **independent** re-listing
confirmed it genuinely gone, and only then did the row read `status=deleted`, `purge_status=purged`,
`storage_key=null`, `purged_at` set.

**The Investment Intelligence route deliberately does NOT delete the binary at intake**, unlike the
generic and Insurance routes. II's canonical write re-fetches the original bytes from quarantine at
**accept** time, so deleting at intake would break acceptance outright. `accept.ts` deletes
immediately after the write succeeds, and the 24-hour hard backstop catches a document that is never
accepted. That is I.10's "retained only as long as required" applied honestly, rather than by
deleting early and breaking the journey.

Non-sensitive provenance that survives destruction is already correct, and errors are **sanitised**
before being recorded, so a signed URL or host detail cannot leak into the audit trail through a
failure message. Mask token maps are purged by the §2.2 TTL.

### I.11 — abandoned-document retention — **PASS**

`enforceAieRawFileHardBackstop` selects on **age alone** with no status filter — asserted, because
that is the whole point: an upload that crashed while still `received` or `quarantined` is precisely
the case the backstop exists for, and M2 fixed a real defect where such rows were unpurgeable and
accumulated forever. Verified against real DEV storage and DB bookkeeping in L4.

### I.12 — investment live-DEV corpus — **CONDITIONAL PASS**

`tests/support/buildM3InvestmentCorpus.ts` — **10 fixtures**, each a pair of document text and a
**hand-written oracle** fixed before the implementation was run.

| ID | I.12 scenario | Result |
|---|---|---|
| C1 | CAMS CAS baseline | PASS |
| C3 | Long multi-row SIP (12 instalments, running balance after each) | PASS |
| C4 | Opening balance — Folio Details layout (the certified path) | PASS |
| **C4b** | Opening balance — **CAS layout** | **FINDING fixture** — see M3-F1 |
| C5 | Fees (stamp duty) | PASS |
| C6 | Switches / transfers / reversals | PASS |
| C7 | Same instrument across two folios | PASS |
| C9 | Prompt-injection text embedded in a valid statement | PASS |
| C10 | Malformed / reconciliation failure | **Negative control** — correctly detected |
| C11 | Unsupported document class | **Negative control** — correctly refused |

**What makes the oracles sealed rather than decorative.** Every expected figure is a literal, never
derived from `parsed.*` — a test asserting `parsed.length === parsed.length` would pass forever and
prove nothing. And every fixture's closing balance is **redundant** with its transactions, so a wrong
oracle and a wrong parser would have to agree with each other *and* with the arithmetic to go
unnoticed. A **mutation proof** confirms a deliberately-wrong oracle fails, so a passing corpus is
evidence rather than tautology.

**Three I.12 scenarios are NOT in this corpus, and are named rather than dropped** (`M3_BLOCKED_SCENARIOS`):

| Scenario | Why |
|---|---|
| Password-protected CAS | Covered, but not by a **text** corpus — it needs real encrypted PDF **bytes**. Exercised through the real encrypted-PDF builder in the dispatch suite: no password → `password_required`; wrong password → `wrong_password`; **correct password → an economic result identical to the unencrypted original**. |
| CAMS Folio Details, and CAS/Folio overlap | Exercised against the existing certified FS1 fixtures and the cross-source engine suite, not duplicated. A second parallel copy of an already-certified corpus would measure the copy, not the parser. |
| **Deliberately ambiguous layout requiring AI fallback** | **BLOCKED**, not skipped for convenience. See §5. |

### I.13 — investment accuracy thresholds — **PASS**

`tests/unit/aieM3InvestmentCorpusAccuracy.test.ts` — **57 tests**. Every threshold asserted
literally:

| I.13 threshold | How it is measured | Result |
|---|---|---|
| Economic transaction **recall** and **precision** | `(date, type, units)` triples compared **in both directions** against the oracle — a count alone would let a wrong row substitute for a right one | **100%** on all 8 clean fixtures |
| Closing units exact within certified tolerance | `reconcilePosition` per position | **variance exactly `0`** — not merely "within 0.0001", so a real rounding defect cannot hide inside the allowance |
| Unexplained economic omission | Net-units aggregate vs oracle (an independent check from the per-row one: a compensating pair of errors would have to cancel exactly to survive both) | **0** |
| False economic transaction | Same | **0** |
| False canonical account | Position count vs oracle, per `(folio, scheme)` | **0** |
| False instrument | Same | **0** |
| False tax lot | Opening-balance marker must be `adjustment`, carrying no NAV and no amount to invent a cost base from | **0** |
| Duplicate net-worth contribution | Two folios holding one scheme stay two positions; C7's oracle is the second folio's balance specifically, so a summed 150.000 would fail | **0** |
| "Do not hide errors behind a confidence score" | C10 is a genuinely wrong statement that the parser is nonetheless **confident** about (confidence measures layout recognition, not economic truth) — and reconciliation still **fails** it | **Asserted** |

---

## 4. Live-DEV proof

`tests/live-dev/aieM3InvestmentDispatchLiveDev.test.ts` — **6/6 PASS**, run twice.

Real synthetic auth user in the real DEV project; real PDF bytes uploaded to the real
`aie-document-quarantine` Supabase Storage bucket; the real `dispatchInvestmentDocument` against the
real DEV database. Hard production guard: the target project ref is derived from the service-role JWT
and compared against the known DEV ref before anything runs, plus an explicit inequality check
against `PRODUCTION_SUPABASE_URL`.

| ID | What it proves | Observed |
|---|---|---|
| **L1** | A clean CAS runs end to end against real infrastructure | `run=ef689a82` `status=unresolved` `candidates=4` `recon=3` `items=1`; parser `cams_detailed_v1`; `aiWasUsed=false`; the adapter's **own** rules ran (`ii_adapter_*`) and the generic `aie1_1_no_domain_adapter_registered` placeholder did **not**; **stored run status equals reported status** |
| **L2** | An unresolved owner produces a real typed blocking item, not a guess | `ii_adapter:owner_unresolved`, `severity=blocking`, `status=open` |
| **L3** | **M3-F2 fix**: a wrong statement is blocked on a **first upload** | `run=2a56da80` `status=unresolved` `rollForwardFail=1` **`delta=-75`** |
| **L4** | Binary purge deletes and **independently verifies absence** before recording | `purge result=deleted`; object confirmed gone by re-listing; row `deleted`/`purged`/`storage_key=null`/`purged_at` set |
| **L5** | **Decision 2**: the TTL fires on age alone, regardless of lifecycle | `runStatus=unresolved` (**non-terminal**) `ttlHours=48` `deleted=1` — and the run itself untouched |
| **L6** | Negative control: a row **inside** the TTL survives the same sweep | 1 row remained |

**Exact counts — created and cleaned:**

```
created: intakes=2  runs=2  candidates=4  reconciliationRuns=5  unresolvedItems=2  storageObjects=2
residue: aie_document_intake=0  aie_extraction_run=0  aie_audit_event=0  aie_unresolved_item=0
         aie_field_candidate=0  aie_reconciliation_run=0  storage_objects=0  auth_users=0
```

Teardown is FK-ordered and followed by an **independent zero-residue re-query** — the counts above
are read back from the database, not inferred from the deletes having returned successfully. The
suite throws if any residue remains.

> PC4-INV-16 records that **no production synthetic-cleanup mechanism exists anywhere in this
> repository**, and that any phase writing synthetic data must bring and prove its own. This suite
> does, for DEV. **It writes nothing to production.**

---

## 5. Why the masked-AI half is NOT exercised — two independent blockers

I.4's schema and I.7's disagreement engine are built, unit-proved and wired into the dispatch. Neither
can run end to end today, for two reasons that are independent — fixing either alone changes nothing.

**Blocker A — `AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset. Operator-owned. Re-verified 2026-09-15.**
Masking fails closed without it (it throws, by design), so no masked payload can be constructed and
no AI fallback can run. M0 raised this as **OA-6**; M2 re-confirmed it; M3 re-confirmed it again
today — still absent. Generating a key is a secret-provisioning decision, not an engineering one, and
this phase did not fabricate one.

**Blocker B — no Investment Intelligence parser declares an AI-eligible gap. Engineering-owned, and
deliberate.** `parserAdapter.ts` returns `aiEligibleGaps: []` unconditionally, with its own reasoning
recorded in-file: every registered II parser either extracts a line completely or records a typed
warning/error against it; none has a concept of "this one field is missing, ask AI". Manufacturing a
gap to exercise the path would mean inventing an AI-eligible field that corresponds to no real
extraction gap — worse than declaring honestly that the path is designed and unexercised.

**Consequence, stated precisely.** The orchestrator only reaches the masking stage when a parser
reports `deterministic_partial` **with** a non-empty gap list. For Investment Intelligence that
condition is never met, so **masking is not merely blocked for II — it is unreachable**, and would
remain so even if the key were set tomorrow. This is also why the live-DEV proof ran successfully
with the key absent: the deterministic path never touches masking.

**What would make I.4 and I.7 exercisable:** the key (operator), **and** a real II document class
with a genuine per-field gap — I.12's "deliberately ambiguous layout" scenario — which needs a parser
change, not a test change. Both are named in §8.

---

## 6. Findings

### M3-F1 — a CAS opening balance is DISCARDED. **NOT FIXED — needs a Product-Owner decision.**

**What the code does.** On the CAS layout, `camsParser.ts:196`'s `OPENING_BALANCE_RE` matches
`Opening Unit Balance : NNN` and is used at `:842` **only** to set the in-table flag
(`inTable = true; continue;`). The **value is discarded**. It never becomes a transaction row, never
carries `OPENING_BALANCE_SOURCE_REFERENCE`, and is never supplied as an opening position to
`reconcilePosition`. It is not reported as an error either — it is silently consumed, which is why
this was invisible.

The Folio Details parser does the opposite, correctly: `camsFolioStatementParser.ts:127` →`:388`
emits a real opening-balance row. **The two certified parsers disagree about the same concept.**

**The consequence is arithmetic and unavoidable.** The position reconciles from zero, so the unit
variance equals the discarded opening balance **exactly**, and the document is blocked with
`unit_variance_exceeds_tolerance` even though every transaction row parsed correctly.

**A second, independent mechanism.** The pattern requires a **colon** and an end-of-line anchor, so a
column-aligned `Opening Unit Balance        200.000` (no colon) does not match at all. Even if the
discard at `:842` were fixed, that rendering would still be lost.

**Both mechanisms are pinned** as corpus fixture **C4b** with executable assertions, including that
the variance equals the discarded value exactly (`-200.000` for a 200.000 opening balance).

> **Why this matters beyond M3, and what is NOT being claimed.**
>
> PC4 has **five reconciliation residuals** that M1 re-verified as reproducing exactly in production:
> `-156.618`, `+111.505`, `-12.932`, `-4.457`, `-2.678`. M1 records that R-1's hypothesis *"failed to
> confirm"* and that R-3/4/5 have **no hypothesis at all** (operator item **OA-10**).
>
> A discarded opening balance produces a variance of **exactly** the discarded quantity. That is a
> concrete, testable hypothesis for a class of residual that currently has none, and it is cheap to
> test: look for `Opening Unit Balance` in the affected schemes' blocks and compare the printed
> figure to the residual.
>
> **I have NOT verified this against the Product Owner's real statement, and I am not claiming it is
> the cause.** Doing so would mean reading and reporting their real personal financial transactions,
> which Part A.1 forbids committing to this repository — the same constraint M1 cited for declining
> to investigate R-2. Two things argue for caution: PC4's own report records
> `history_completeness: complete_from_inception` on all 17 positions, which is what you would expect
> when no opening-balance marker exists (i.e. consistent with the defect, but also consistent with
> statements that genuinely print none); and 12 of 17 positions reconcile to `0.000`, so if those
> statements print opening balances the defect would have to be absent there too.
>
> **Recorded as a defect candidate with a reproduction and a named hypothesis, not as a diagnosis.**

**Why it was not fixed here.** It changes shipped production parser behaviour, which is a PC4 campaign
re-run that Part G.1 explicitly defers. It also interacts with **OA-10** (are the residuals defects to
fix or accepted variances to document?) and with the **OA-9** severity question. Fixing the parser
without that decision risks changing 17 real production positions' reconciliation state as a side
effect of an infrastructure phase.

### M3-F2 — brand-new positions were never reconciled. **FIXED.** See I.5.

### M3-F3 — reported state diverged from stored state. **FIXED.**

Identity checks (ambiguous account/instrument, unstated owner, unusable statement period) are
evaluated after the shared pipeline returns, because they are not arithmetic. A document could
therefore pass arithmetic reconciliation, reach `awaiting_acceptance`, and only then acquire a
blocking item — at which point the dispatch **reported** `unresolved` while the run row still **read**
`awaiting_acceptance`, the state `accept.ts` treats as ready.

Safe in practice: the acceptance gate independently re-derives the blocking count and the
reconciliation outcomes, and would have refused. But a stored state contradicting the reported one is
a trap for the next reader and for any future feature that reasonably trusts the row.

**Fixed** by transitioning the run through `reconciling` to `unresolved`, matching `revalidate.ts`'s
established idiom (`unresolved → reconciling → unresolved | awaiting_acceptance`). **One new FSM
edge** (`awaiting_acceptance → reconciling`) rather than a direct back-edge, so the FSM keeps saying
that every arrival at `unresolved` came through reconciliation.

**Found by the live-DEV proof, not by inspection** — the first live run printed
`runStatus=awaiting_acceptance` where `unresolved` was expected. A live assertion that the stored
status equals the reported one now guards it.

### M2-OPEN-7 — address masking. **CLOSED** (with a disclosed line-scope limitation). See §2.1.1.

### CG-1 — dormant live-dev suites. **CLOSED as a tooling gap.** See I.8.

---

## 7. Regression safety

| Check | Result |
|---|---|
| `tsc --noEmit`, full project | **clean, zero errors** |
| `scripts/check-migration-versions.mjs` | `OK: 147 active migrations, one file per version, next version is 0153` |
| **PC4 19-invariant regression contract** (85 files) | **84 passed / 1 skipped; 1,673 passed / 5 skipped — byte-identical to M1's baseline** |
| M3's own new and rewritten suites (11 files) | **203 tests, all pass** |
| Live-DEV dispatch proof | **6/6 pass**, run twice |
| Full repository suite | **355 files, 6,993 tests: 6,953 passed, 22 failed — an identical failure set to the pre-M3 baseline** |

**Pre-existing failures, measured rather than assumed.** A full-suite run on M3's branch was compared
against a full run at the **unmodified base commit `5363aeb`** (checked out detached, so the
comparison was against a genuinely clean tree — a first attempt using `git checkout <base> -- .` was
discarded because it leaves files added since the base in place, which contaminated the result). The
base run failed **16 files / 22 tests**; M3's branch fails **the same 16 files / 22 tests**. Every one
is unrelated to this phase's scope — `resources*` (9 files), `lr*` (3), `smsfHouseholdIsolation`,
`countryGateAccessMatrix`, `aiResidualClosureFailClosed`, and `fdh1Isolation` (which fails on
`InvestmentIntelligenceSubNav.tsx` importing FDH, a `main` change from commit `f86962a`). **M3
introduces zero regressions.**

> **Correction to a commit message.** Commit `3ac6088`'s message quotes *"355 files, 7047 tests"*.
> That figure was written from a projection before the final full run finished; the measured total is
> **6,993**. The failing-set claim in that message (22 failing, identical to the baseline) is correct.
> This report's figures are the authoritative ones.

> **One flake observed and chased down rather than ignored.** In one of four full-suite runs,
> `tests/unit/paymentsCheckoutRoute.test.ts` reported a 17th failure (`NEG-01`, with a bare
> `STACK_TRACE_ERROR` and no assertion detail). It **passes in isolation** (7/7) and passed in the
> other three full runs, including the run immediately after. It is a parallel-execution artifact, not
> a regression: nothing in M3 touches payments, and the failure did not reproduce. Recorded here
> rather than quietly dropped from the count.

The two `scripts/ii-*-certification/comparison_report.json` files are rewritten as a side effect of
running the II suite; as in M1 and M2, the diff is the `generatedAt` timestamp only and both were
reverted, not committed.

---

## 8. Blockers and open items

### Needing Product-Owner or operator input

| ID | Item | What is needed |
|---|---|---|
| **PO-BLOCKER-1** *(carried, re-verified)* | **AWS S3 + GuardDuty quarantine.** Re-probed fresh 2026-09-15: `sts:GetCallerIdentity` succeeds (it requires no policy); `s3:ListAllMyBuckets` **AccessDenied**; `guardduty:ListDetectors` **AccessDeniedException** in `ap-southeast-2`; both candidate bucket names — `fhip-aie-quarantine-dev` (the IAM policy's ARN) and `aie-document-quarantine-dev` (the runbook's `BUCKET=`) — return **404 Not Found**, i.e. genuinely nonexistent against a globally-unique namespace. Unchanged from M2. | The exact bucket name, the AWS account id it lives in, and credentials or a purpose-scoped identity for that account. The two documents' conflicting bucket names still need reconciling (**OA-2b**). |
| **OA-6** *(carried, re-verified)* | **`AIE_MASK_TOKEN_ENCRYPTION_KEY` is still unset.** Confirmed absent again today. Masking fails closed without it. | The key set in DEV and production. **Blocker A** of §5. Note this is now the key for the HMAC subkey as well as the legacy AES path, so it is a single secret rather than two. |
| **OA-10 / M3-F1** | **The CAS opening-balance discard.** A defect candidate with a reproduction and a named hypothesis for PC4's five residuals. | Decide whether to fix the parser (changing shipped production behaviour and, potentially, 17 real positions' reconciliation state) and whether the residuals are defects or accepted variances. |

### Open items carried forward (no PO decision needed)

| ID | Item |
|---|---|
| **M3-OPEN-1** | **Blocker B of §5**: no II parser declares an AI-eligible gap, so masking and the AI fallback are structurally unreachable for Investment Intelligence. Needs a real document class with a genuine per-field gap, not a test change. |
| **M2-OPEN-6** | Still open **for `app/api/aie/fdh-bank/intake/route.ts`**, which M3 did not touch. The M3 II dispatch does not reproduce it, and an executable guard now enforces that. |
| **M2-OPEN-8** | Still open for the **pre-existing** II password endpoint (`app/api/investment-intelligence/source-documents/[id]/process/route.ts`), which has no rate limiting. The new AIE unlock endpoint does. |
| **CG-10** | The "two parse runs sharing an identical `storage_path`" defect remains open for the **old** II path. The new AIE path is keyed on an immutable intake UUID and does not have it. |
| **M2-OPEN-1..5, M2-OPEN-7** | M2-OPEN-7 is **closed** (address masking). The rest are unchanged and untouched by M3. |
| **M3-OPEN-2** | The new address rule masks only the **first line** of a multi-line address (§2.1.1). |
| **M3-OPEN-3** | `.env.local` in this repository is **UTF-8 with a BOM and CRLF line endings**. The existing live-dev suites parse it with `split('\n')` and a `(.*)$` regex; because JavaScript's `.` does not match `\r`, that combination matches **zero** keys and produces an empty environment with no error. M3's own suite handles both (and asserts the key was actually parsed), but the other 9 live-dev suites still carry the latent hazard. |

---

## 9. M3 verdict

> **AIE-1 INVESTMENT INTELLIGENCE DISPATCH AND DOCUMENT-LIFECYCLE CLOSURE — CONDITIONAL PASS.**
>
> **PASS on the dispatch path.** The real authenticated Investment Intelligence route exists, runs
> the full required journey, and is proved against the real DEV project with real bytes, real
> storage and real database rows — 17 unit tests, 6 live-DEV tests, zero residue. It performs no
> canonical write and does not reproduce the M2-OPEN-6 anti-pattern, enforced by an executable guard
> rather than by review.
>
> **PASS on both Product-Owner decisions.** Identifier masking is a keyed, tenant-bound, one-way
> HMAC; the escrow map, its crypto module, its writer, its reader and the reveal capability are all
> **deleted**, not disabled. Mask-token retention is a fixed 48-hour TTL that fires on age alone and
> is proved deleting a row belonging to a non-terminal run. Every D.6 identifier category moves to
> pure one-way HMAC; **zero categories need a reversible map**, for the architectural reason set out
> in §2.1.1.
>
> **PASS on PC4 preservation.** The canonical write re-parses the original document through II's own
> certified orchestrator, so PC4's semantics are preserved by construction. The 85-file regression
> contract re-runs byte-identical to M1's baseline.
>
> **Three real defects found by running the path rather than reading it.** Two fixed — a
> reconciliation that silently never ran on a first upload, and a reported state that diverged from
> the stored one. One disclosed with a reproduction and deliberately not fixed, because it changes
> shipped production parser behaviour and bears on an open Product-Owner decision.
>
> **NOT a FULL PASS, for two reasons that are structural rather than effort:**
>
> **(1) The masked-AI half of the pipeline is unexercised end to end.** The I.4 schema and the I.7
> disagreement engine are built and unit-proved, but two independent blockers stand between them and
> a real run: the masking key is unset (operator-owned, **OA-6**), and no Investment Intelligence
> parser declares an AI-eligible gap, which makes masking *unreachable* for this adapter rather than
> merely blocked. Fixing either alone changes nothing.
>
> **(2) The S3 + GuardDuty quarantine the mission's own H.2/H.3 describes does not exist and is not
> reachable.** Re-verified fresh today: zero S3 and GuardDuty permissions, and both documented bucket
> names provably nonexistent. M3 therefore built and proved the dispatch against the quarantine the
> codebase **actually has** — Supabase Storage, private, service-role-only, per-user path prefix, with
> a real fail-closed admission gate. That is a genuine quarantine. **It is not a malware scanner**, and
> this report does not claim it is one.

---

## 10. Exact counts (Part W)

| Measure | Value |
|---|---|
| Prior-phase documents carried forward | **5**, MD5-verified byte-identical |
| Source files created | **7** (2 routes, 5 library modules) |
| Source files modified | **11** |
| Source files deleted | **1** (`lib/aie/masking/tokenMapCrypto.ts`) |
| Test files created | **7** (6 unit, 1 live-dev) + 1 fixture-corpus support file |
| Test files modified | **8** |
| M3's own new/rewritten suites | **11 files, 203 tests, all pass** |
| PC4 regression contract re-run | **85 files, 84 passed / 1 skipped, 1,673 passed / 5 skipped** |
| Live-DEV tests | **6, all pass**, run twice |
| Live-DEV documents processed | **2 per run** (one clean CAS, one deliberately-broken) |
| Live-DEV rows created / cleaned / residue | **2 intakes, 2 runs, 4 candidates, 5 reconciliation runs, 2 unresolved items, 2 storage objects, 1 auth user / all deleted / 0** |
| Corpus fixtures | **10**, each with a hand-written sealed oracle |
| I.12 scenarios named as not-in-corpus | **3**, each with a reason |
| Migrations created | **0** (none needed; next free version re-verified as **0153**) |
| Migrations applied | **0** |
| AWS bucket probes re-run | **2** (both 404), plus `sts`, `s3:ListAllMyBuckets`, `guardduty:ListDetectors` ×1 region |
| Production database writes | **0** |
| Production database reads (this phase) | read-only migration/row-count probes only, with negative controls |
| Full-suite tests, M3 branch | **6,993** (355 files) — **6,953 passed, 22 failed, all pre-existing** |
| Full-suite tests added by M3 | **+134** against the pre-M3 baseline of 6,859 |
| Pushes / merges to `main` | **0** |

---

## 11. What Phase 5 (M4 — PC5) inherits

PC5 consumes AIE unresolved items, so the precise shapes M3's reconciliation actually produces
matter. **Every item goes through AIE-1.1's existing `aie_unresolved_item` lifecycle via
`repo.createUnresolvedItems` — no new table, no new status vocabulary, no parallel queue**
(AIE10-EXC-08/09/10).

**Reason codes an Investment Intelligence run can now emit:**

| `reason_code` | Severity | `evidence_ref` payload | Source |
|---|---|---|---|
| `ii_adapter:owner_unresolved` | `blocking` | `{ reason }` — prose, no PII | Emitted when `ownerMemberId` is null and at least one account matched |
| `ii_adapter:ambiguous_account` | `blocking` | `{ folioNumber, amcName, candidateAccountIds }` | Two or more existing unknown-AMC accounts share this folio |
| `ii_adapter:ambiguous_instrument` | `blocking` | `{ schemeKey, matchedVia, candidateInstrumentIds, reason }` | Multiple existing instruments equally match |
| `ii_adapter:statement_as_of_date_missing` | `blocking` | `{ reasonCode }` | No closing reference point |
| `ii_adapter:statement_period_invalid_order` | `blocking` | `{ reasonCode }` | Start after end |
| `reconciliation_fail:<ruleId>` | `blocking` | `{ ruleId, ruleVersion, delta, tolerance }` | Generated by AIE-1.1 core from a `fail` outcome |
| `reconciliation_indeterminate:<ruleId>` | `blocking` | same | Generated from an `indeterminate` outcome |
| `ii_adapter:source_disagreement:<fieldName>` | `blocking` | `{ recordRef, fieldName, material, deterministic:{value,producedBy,provenance}, ai:{…} }` | **I.7. Built and unit-proved, but NOT emitted by any live run today** — see §5 |

**Rule ids that appear in `<ruleId>`, all now stable and unique per position:**
`ii_adapter_duplicate_overlap`; `ii_adapter_roll_forward:{accountId}:{instrumentId}` (existing
position); **`ii_adapter_roll_forward:new:{folio}:{schemeKey}`** (brand-new position — new in M3);
`ii_adapter_roll_forward:ambiguous:{schemeKey}`; `ii_adapter_canonical_conflict:{accountId}`;
`ii_adapter_identity:{reasonCode}`; `ii_adapter_no_candidates`.

**Five things that change Phase 5's starting assumptions:**

1. **`permittedActionTypes` is `['request_reprocessing', 'reject_document']` on every II item.** M3
   deliberately did **not** invent a bespoke "choose this candidate" action for the I.7 disagreement
   item, because the action vocabulary is AIE-1.5's and `decide.ts` validates against it. **If PC5
   needs a choose-a-value action, PC5 owns adding it** — to the shared vocabulary, not as an
   adapter-local fork.
2. **An identity-derived blocking item is recorded twice, on purpose** — once as a typed
   `aie_unresolved_item` (carrying the precise reason code and evidence PC5 needs) and once as a
   `fail` row in `aie_reconciliation_run` under `ii_adapter_identity:<reasonCode>`. That keeps the
   acceptance gate's two independent signals — blocking-item count and worst reconciliation outcome —
   in agreement. **PC5 must not treat the paired reconciliation row as a second, separate exception.**
3. **A run can now arrive at `unresolved` from `awaiting_acceptance`** (via `reconciling`), because of
   the M3-F3 fix. PC5's Review Centre must not assume `awaiting_acceptance` is terminal-until-accepted.
4. **The `ii_adapter:source_disagreement:*` shape exists but is never produced today.** PC5 can build
   against it, but must not expect live examples until the two §5 blockers clear. Designing the
   Review Centre as though disagreement items were routine would be designing against an empty set.
5. **Evidence reveal is GONE.** PC5 resolution-context screens must show the masked token and say it
   is not recoverable. There is no server capability to return an original value, `POST
   .../reveal` answers **410 Gone**, and no PC5 copy may say "original value". This is the Product
   Owner's decision, taken with the UX consequence understood.
