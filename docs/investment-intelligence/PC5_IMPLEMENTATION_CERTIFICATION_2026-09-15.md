# PC5 — Governed Resolution Workflow: Implementation Certification

**Mission phase:** M4 (Phase 5 of 11) — "Investment Intelligence + AIE-1 Convergence"
**Branch:** `mission/m4-pc5-2026-09-15`, branched from Phase 4's tip `5df12d1d`
**Date:** 2026-09-15
**Overall verdict:** **CONDITIONAL PASS** — named blocker: migration `0153` cannot be applied from this environment.

---

## 0. What PC5's scope actually is, and why that needs saying first

M0's master scope ledger established, and this pass re-verified against the current
repository, that **PC5 has no original approved scope anywhere in version control**. The
ledger's row `SL-PC5` reads `NOT FOUND`. What exists is:

| Source | What it gives PC5 |
|---|---|
| `docs/investment-intelligence/II_PC4_STATUS_2026_09_07.md:138` | A single table cell: *"**PC5** — owner/reconciliation resolution workflow"* |
| `docs/aie-programme/AIE_1_MASTER_PLAN.md:121` | Architectural constraint P7 — *"PC5 single-source-of-truth for exceptions"* |
| `AIE-1.0_Architecture_&_Privacy_Contract.md` (uncommitted, PO filesystem only) | The binding boundary contracts `AIE10-CTX-05`, `AIE10-EXC-08/09/10` |
| `lib/aie/review/featureFlags.ts` | `AIE_REVIEW_PC5_PROJECTION_ENABLED` — a reserved flag with zero consumers |
| **This mission's dispatch, Part K (K.1–K.22)** | **The requirement set** |

**Part K's own text is therefore the totality of what this phase implemented.** There is no
separate "original PC5 requirements" this layers on top of, and none is invented here. Where
Part K asks for something this repository does not model, that is recorded as an open product
decision rather than closed by inventing one — see K.5.

### The five Phase-4 assumptions, re-verified fresh

Each was checked against the current tree rather than trusted from the M3 report.

| # | Phase 4 said | Verified fresh | Where |
|---|---|---|---|
| 1 | `permittedActionTypes` is `['request_reprocessing','reject_document']` only | **CONFIRMED, and worse than stated**: the column was also **never read back anywhere**. Written by `repository.ts`'s `createUnresolvedItems`; no `SELECT` in the repository included it; the review UI's permitted actions came entirely from the static registry. A write-only column that could diverge from the registry silently and forever. | §K.1 |
| 2 | Identity items are recorded TWICE (typed item + paired `fail` reconciliation row) | **CONFIRMED.** `dispatch.ts` creates the typed item and then `recordReconciliationRuns` with rule id `` `ii_adapter_identity:${item.reasonCode}` ``. Counted ONCE by PC5. | §K.13 |
| 3 | A run can reach `unresolved` from `awaiting_acceptance` | **CONFIRMED WITH A CORRECTION**: the edge is **indirect**. `AIE_RUN_TRANSITIONS` has no direct edge either way; `dispatch.ts` routes `awaiting_acceptance → reconciling → unresolved`. PC5's re-reconciliation uses the same waypoint in both directions. | §K.19 |
| 4 | `source_disagreement` exists in the type system but is never produced | **CONFIRMED**, and a further gap found: it had **no reason-code registry entry at all**, so it rendered as the generic fallback ("no specific guidance is registered for this exact condition yet"). Registered by this pass; still not exercisable. | §K.9 |
| 5 | Evidence reveal is permanently gone | **CONFIRMED.** `lib/aie/masking/tokenMapCrypto.ts` does not exist; `persistMaskTokenMap`/`findMaskTokenCiphertext` are gone; `reveal.ts` structurally refuses; `aie_mask_token_map` holds **0 rows on DEV** (live-verified, S-46). PC5 offers no reveal control anywhere. | §K.12 |

### The other open items, re-verified fresh

| Item | Status as of this pass |
|---|---|
| AWS S3 / GuardDuty | **STILL UNREACHABLE.** Not re-probed by PC5 — it is outside PC5's dependency surface, and PC5's own work (governed resolution of already-existing unresolved items) does not touch admission. **This report makes no malware-scanning claim of any kind.** |
| `AIE_MASK_TOKEN_ENCRYPTION_KEY` | **STILL UNSET.** PC5 deliberately does not depend on it — see K.4's masking note. |
| `aiEligibleGaps: []` on every II parser | **CONFIRMED** (`parserAdapter.ts:194`). AI fallback remains unreachable behind two independent blockers. PC5 resolves items regardless of their provenance, so this blocks nothing here except the `source_disagreement` shape (K.9). |
| Next free migration = 0153 | **CONFIRMED THREE WAYS**: `check-migration-versions.mjs` ("147 active migrations, next version is 0153"); `check-migration-versions-against-branch.mjs` (no collision vs `origin/main`); and a **live structural probe of BOTH databases** (`scripts/pc5_migration_baseline_probe.mjs`). See §5. |
| PC4's 19-invariant regression contract | **NOT BROKEN.** Full suite fails 16 files / 22 tests, **identical to the Phase 4 base** measured by checking out `5df12d1d` and running the same sixteen files. PC5 introduces zero new failures. §7. |
| PC4 production reconciliation residual (discarded opening balance, fixture C4b) | **NOT TOUCHED.** PC5 changes nothing in opening-balance handling. `openingBalanceMarker.ts` and `reconciliation.ts` are untouched; PC5's re-reconciliation calls the existing rule unchanged. |

---

## 1. The headline blocker, stated once, plainly

**Migration `0153` cannot be applied to DEV from this environment, and PC5's write path
does not work without it.**

Verified fresh, not inherited:

- `scripts/pc5_ddl_capability_probe.mjs` — eight candidate exec/DDL RPC names, all
  `PGRST202 Could not find the function`. No `SUPABASE_ACCESS_TOKEN`,
  `SUPABASE_MANAGEMENT_TOKEN` or `SUPABASE_PAT`. No `DATABASE_URL`/`POSTGRES_URL`.
- `scripts/pc5_rpc_inventory_probe.mjs` — reads PostgREST's own OpenAPI document and
  enumerates **all 40 RPCs** exposed on DEV. None executes SQL. (`smsf_create_fund` matched
  the word "create" in its name; the two "exec-shaped" matches take a `p_statement_id`
  uuid.)

So the conclusion rests on the complete list rather than on guessed names.

**What that blocks, precisely.** `recordReviewDecision` always writes 0153's three new
`aie_review_decision` provenance columns, so on a 0153-less database **every PC5 decision
fails** with `PGRST204 Could not find the 'original_value_at_decision' column`. That
cascades to every decision-dependent scenario. The columns are deliberately NOT written
conditionally: a decision recorded without its K.12 provenance would be a worse outcome
than a decision refused.

**What it does not block.** 41 of 54 live scenarios still pass, including every security
proof, the whole read/projection path, discard, purge, the acceptance summary, and the
one-exception-truth invariants. See §6.

---

## 2. Per-item verdicts, K.1 → K.22

Legend: **PASS** (evidence cited) · **CONDITIONAL PASS** (named blocker) · **FAIL** ·
**NOT APPLICABLE** (reason given).

---

### K.1 / K.2 — Mission: governed user-resolution workflow — **CONDITIONAL PASS**

*"PC5 must turn unresolved ownership/reconciliation from a passive Review Centre observation
into a governed user-resolution workflow."*

**Built.** `lib/pc5/` — 14 modules, 3,200 lines; 5 API routes under `app/api/pc5/`; 2 pages
and 2 client components; migration `0153`.

**The "choose/confirm a value" action this mission made PC5 responsible for adding.**
`'choose_value'` was added to the SHARED `AieReviewActionType` vocabulary
(`lib/aie/review/types.ts`), not to a PC5-private one — a private vocabulary would be the
first brick of the second exception system K.3 forbids.

It is genuinely a different action from `'correct'`, not a synonym:

| | `'correct'` (AIE-1.5) | `'choose_value'` (PC5) |
|---|---|---|
| Input | free-form, typed by the user | an id or closed-vocabulary token |
| Validated against | a static per-field type/bounds spec | a **closed set resolved server-side, per user, per item, from canonical data** |
| Permitted values | open; only the shape is constrained | enumerable, and the client cannot widen it |

Collapsing them would have meant either validating a household-member uuid as "a string"
(letting a browser post any id — K.20's forged-owner case) or hard-coding a user's household
into a process-wide static registry (a cross-tenant leak waiting for a cache to outlive a
request). Hence `AieChoosableFieldSpec`, which declares an option **source**, never options.

**`permitted_action_types` is now load-bearing.** Before this pass it was written on every
item since migration 0140 and read by nothing. PC5 reads it as the **outer bound**:
`permittedPc5Actions()` intersects it with the reason-code registry and PC5's own domain
rules. Narrowing is always safe; widening never happens. The II adapter's writes are widened
per-condition rather than repeating one hard-coded pair —
`lib/aie/adapters/investment-intelligence/unresolvedItems.ts`.

**Evidence.** `tests/unit/pc5ReviewStatus.test.ts` (the outer-bound test asserts that an
EMPTY bound yields exactly `['acknowledge','discard_statement']`); live S-21/S-23/S-25.

**Blocker:** the decision write needs 0153.

---

### K.3 — One exception truth — **PASS**

*"PC5 may NOT: create a second unresolved-item table/state machine; maintain a divergent
open-count; copy evidence into a parallel lifecycle; directly update canonical II tables."*

**This was not written the obvious way, and the reason matters.** The obvious design — and
the one this codebase already has a table shaped for — would be to upsert each AIE exception
into `ii_review_items` (migration 0067), which already has
`status in ('open','acknowledged','resolved','dismissed','superseded')`, `identity_key`
dedup, `superseded_by_id` lineage and a working UI. It is an almost exact fit for K.13's
vocabulary.

It is also exactly what K.3 forbids. `ii_review_items` has `for all` RLS — the browser writes
it directly — plus its own status column, its own resolution timestamps and its own open
count. Projecting AIE exceptions into it would create a second row per exception, with a
second status a user could change without the underlying AIE item changing, and a count that
would drift the first time a refresh was missed. A user could then "resolve" a blocking
exception in the Review Centre and still find the document refused, with the two surfaces
disagreeing and neither obviously wrong.

**So AIE exceptions are projected LIVE and rendered ALONGSIDE `ii_review_items`, never INTO
it.** `lib/pc5/projection.ts` computes on every read and persists nothing.

| Evidence | Result |
|---|---|
| Live S-47 — PC5 activity created **zero** `ii_review_items` rows | PASS |
| Live S-48 — PC5's projected blocking count equals `countItemsBlockingAcceptanceForRun`'s own count, **for all 16 runs**, zero mismatches | PASS |
| `tests/unit/pc5Prohibitions.test.ts` — migration 0153 creates exactly `['ii_ownership_allocation']` and no table matching `unresolved\|exception\|review_item\|queue` | PASS |
| Same — no PC5 file opens `.from('aie_*')` at all; every AIE access goes through the repository | PASS |
| Same — no PC5 file writes `ii_review_items` | PASS |
| Same — no PC5 file sets an item status to `resolved`/`superseded`/`rejected` | PASS |

**The type system enforces it too.** `recordGovernedResolutionForPc5` types `newStatus` to
the literal `'in_review'`. PC5 **cannot** write `resolved` — only AIE's own
`resolveItemBySystem`, after a real re-reconciliation stopped reproducing the condition, may
assert that.

---

### K.4 — Statement owner matching — **PASS**

*"Compare extracted owner evidence with canonical household/entities locally. Normalize
cautiously... no fuzzy auto-match that can assign another person's financial data."*

**This did not exist in any form.** PC4-INV-12 records it in terms this implementation is the
direct answer to: `ParsedAccountRecord.holderName` has been parsed by the CAMS, CAMS-Folio and
KFintech parsers since R2 and had **zero consumers outside tests**; *"A statement belonging to
a different person, uploaded with any `ownerMemberId` set, is ingested with no mismatch signal
at all. There is no test, because there is no code."*

`lib/aie/adapters/investment-intelligence/ownerMatching.ts`.

**There is no edit distance, no similarity score and no threshold anywhere in the module.**
Adding one later would be a defect, not an improvement: the cost of a false positive is
attributing a stranger's portfolio to a household member, silently, inside net worth.

**What normalisation does and where it stops:**

| Normalised away | Kept |
|---|---|
| case, whitespace, diacritics (NFKD + `\p{M}`) | everything else |
| honorifics — `MR/MRS/SHRI/SMT/DR/LATE/...` (a registrar printing convention, not part of a name) | |
| token ORDER, by sorting — `SHARMA ANIL` ≡ `ANIL SHARMA`, which Indian registrars genuinely print both ways. **Reordering, not guessing.** | |
| apostrophes, **deleted rather than split on** | |

That last row is a defect the tests found and fixed: the first draft treated `'` as a
separator, so `O'Brien` and `OBrien` did not match — a false mismatch on a very common AU/IN
surname shape. An apostrophe sits *inside* one token, unlike every other punctuation mark in
the set.

**Initials are never a match.** `A B SHARMA` vs `Anil Bhaskar Sharma` yields
`initials_consistent`, which maps to **AMBIGUOUS, never MATCHED** — because "A Sharma" fits
both Anil and Asha. It is additionally behind a policy flag defaulting **OFF**, so the
strictest behaviour is what you get without configuring anything.

**Privacy.** The module never returns or persists a raw holder name. `maskHolderName()`
produces an irreversible partial form (`A*** S*****`), the same discipline Insurance's parser
already applies to `policyNumberMasked`. It deliberately does **not** use
`identifierToken.ts`: that requires `AIE_MASK_TOKEN_ENCRYPTION_KEY`, which is unset in every
environment, and a masking scheme that throws when a key is missing is the wrong dependency
for a display hint that must always render.

| Evidence | Result |
|---|---|
| `tests/unit/pc5OwnerMatching.test.ts` — 45 assertions, most of them refusals | PASS |
| Live S-04 — exact match against real DEV `household_members` rows resolves to exactly one member | PASS |
| Live S-09 — owner evidence survives the candidate round trip, so a re-check after binary purge reads the SAME holder | PASS |
| Privacy test — no raw name reaches `evidence_ref` under **any** outcome; every payload contains `*` | PASS |

---

### K.5 — Ownership choices — **CONDITIONAL PASS** (one named open product decision)

*"Support: self; spouse/partner; joint; child/dependent; HUF; trust/family trust; other
existing household entity types. **Do not invent a new entity type if an existing canonical
one already models it.**"*

The second sentence is the binding one. Honouring it required establishing what this
repository actually models before writing a line:

| K.5 asks for | This repository models it as | Status |
|---|---|---|
| self | `household_members.relationship = 'self'` → `OWNER_VALUES` `'self'` | **EXISTS** |
| spouse / partner | relationships `'spouse'` and `'partner'`, **both** mapping to the single owner role `'spouse'` via the **existing** `mapRelationshipToOwner` (an R3 decision, not one PC5 made) | **EXISTS** |
| joint | `OWNER_VALUES` `'joint'` + PC5's allocation ledger for the breakdown | **EXISTS** |
| child / dependent | `'child'` and `'other_dependant'` → `'child'` and `'other'` | **EXISTS** |
| trust / family trust | `business_entities.entity_type = 'family_trust'` (migration 0136) | **EXISTS** |
| other household entity types | `business_entities.entity_type = 'company'`; `retirement_members`/SMSF for retirement | **EXISTS** |
| **HUF** | **NOTHING.** | **DOES NOT EXIST** |

**HUF is a named, open Product-Owner decision, not a silent omission.** The only HUF in this
codebase is `RESIDENT_HUF`, a value of `ii_tax_profiles.taxpayer_type` (migration 0061) — an
India income-tax filing status, not an owner, not an entity, and not referenced by any
register's `owner` column.

Offering it would have meant one of two things, both wrong:

1. **Widening the `owner` CHECK on all seven registers plus
   `ii_fhip_publications.published_owner`**, inventing a ninth ownership value with no
   valuation, consolidation or net-worth semantics behind it. That is precisely what
   `'company'` and `'family_trust'` already are — cosmetic tags that backed nothing and had
   to be retired into `LEGACY_ENTITY_OWNER_RESTRICTIONS` and withdrawn from new rows. Making
   the same mistake a third time, in the phase whose own instruction forbids inventing entity
   types, would be indefensible.
2. **Quietly mapping HUF onto `'other'`**, recording a Hindu Undivided Family's holdings
   under a label carrying none of its distinct tax treatment — wrong in exactly the
   jurisdiction where it matters.

An Indian user whose folio is genuinely HUF-held can today record a `business_entities` row
and attribute the position to it (`ii_ownership_allocation.owner_business_entity_id` supports
this), but `entity_type` is CHECK-constrained to `('company','family_trust')`, so that entity
would have to be mislabelled. **This is Product-Owner decision PO-PC5-1 in §9.**

| Evidence | Result |
|---|---|
| Live S-01 — the option set is resolved from **this user's own** household: self/spouse/partner/child/dependant + joint, `self` ordered first, `partner` → `'spouse'`, `other_dependant` → `'other'`, every role one of the canonical eight | PASS |
| Live S-02 — HUF is offered nowhere | PASS (as designed) |
| Live S-06, S-07 — spouse and child/dependant statements match their own members, not "self" | PASS |
| `tests/unit/pc5OptionSetsAndLinks.test.ts` — `PC5_PERMITTED_OWNER_ROLES` **is** `OWNER_VALUES`, unchanged, 8 values, no `huf` | PASS |

---

### K.6 — Joint ownership — **CONDITIONAL PASS**

*"Default equal ownership (50/50 for two owners)... user may edit... **total must equal
100%**... audited and effective-dated/amended... household total must still count the
economic asset once, with owner breakdown separately represented."*

The last clause is global invariant D.2 restated, and it is why the allocation carries
**basis points and nothing else** — no amount, no currency. There is no arithmetic path by
which the breakdown could add a second contribution to net worth. Structural impossibility,
not a rule someone must remember.

**Basis points out of 10,000, not percent.** "The total must equal 100%" is a hard
requirement, not a tolerance, and a three-way split cannot satisfy it in two decimal places:
33.33 × 3 = 99.99. Integers make 3333 + 3333 + 3334 exact.
`business_entities.ownership_percentage numeric(5,2)` was deliberately not reused — it models
a single entity's consolidation factor, where no cross-row sum is ever asserted.

**Refusals, not helpfulness.** `validateAllocation` rejects a zero share rather than dropping
it ("owns 0%" and "is not an owner" are different assertions), and rejects 9,999 rather than
scaling it to fit (K.6 requires allocations to be *explicit decision records* — a stored
allocation must be the submitted one).

**Amendment, never mutation.** A change marks the whole active group `'superseded'`, stamps
`effective_to` and `superseded_by_group_id`, and inserts a NEW group. Ordering is
**supersede-then-insert**, deliberately: a crash after the supersede leaves the position with
no active allocation (readable, and the item is still open about it), whereas insert-first
would leave two active groups totalling 200% — a state no reader could interpret.

| Evidence | Result |
|---|---|
| `tests/unit/pc5JointAllocation.test.ts` — 2 owners = exactly 50/50; 3 = 3333/3333/3334; every default split for n = 1…12 validates; zero/negative/fractional/duplicate/both-identities/neither-identity all refused | PASS |
| Live S-08 — joint holding detected from real evidence; both named holders resolve to real members | PASS |
| Live S-28 — a joint statement **still blocks** after a single owner is chosen | PASS |
| Live S-35 — no active group deviates from exactly 100% | PASS |
| Live S-36 — a 60/30 allocation is refused and the database never sees it | PASS |
| Live S-33 (default 50/50 stored), S-34 (70/30 supersession) | **BLOCKED_ON_0153** |

---

### K.7 — Owner mismatch behavior — **PASS**

*"An unresolved owner mismatch must block unquestioned publication/certification as 'self'.
User must resolve it or discard."*

New reason code `ii_adapter:owner_mismatch` + `ii_adapter:owner_joint_allocation_required`,
raised by `dispatch.ts`, with registry entries and `choose_value` permitted.

**One subtlety worth naming.** An exact match against a **different** member than the declared
one is escalated to `ambiguous`, not silently re-filed — the document names a real household
member, just not the one the upload was filed against, and silently re-filing would be the
"plausible guess" global invariant D.5 forbids.

The comparison runs **only** when the user actually declared an owner: with no declared owner
the pre-existing `owner_unresolved` item already blocks, and raising a mismatch as well would
be two items for one problem.

| Evidence | Result |
|---|---|
| `ownerOutcomeBlocksAcceptance` — blocks mismatch, ambiguous and joint; does **not** block `exact_match`; does **not** block `no_owner_evidence` | PASS |
| Live S-05 — a statement naming someone outside the household yields `mismatch`, and leaks no raw name | PASS |

---

### K.8 — Password-required case — **PASS (with a disclosed gap that is not PC5's)**

*"A password-required AIE item should deep-link to the secure reprocess/password flow."*

`pc5PasswordUnlockHref()` / `pc5PasswordUnlockEndpoint()` point at
`app/api/aie/investment-intelligence/intake/[intakeId]/process/route.ts` — the **real** unlock
route, which accepts `{ password, owner_member_id }` and resumes from the same quarantined
bytes.

**Why not a `request_reprocessing` action instead: there isn't one.**
`'request_reprocessing'` appears in nearly every `permittedActionTypes` and `allowedActions`
array in this codebase and is implemented by **nothing** — `VALID_ACTIONS` in the decide route
is `['correct','not_present','defer']` and no service anywhere implements reprocessing. PC5
does not implement it either; deep-linking to a route that works rather than to a vocabulary
entry that does not is the honest answer. **The gap itself is reported, not papered over.**

**A related design consequence worth stating.** PC5's re-reconciliation works from the
immutable `aie_field_candidate` evidence rather than re-reading the PDF, so a document that
was unlocked **once** never needs the password again. See K.19.

| Evidence | Result |
|---|---|
| Live S-39 — a run with no candidates is refused `no_candidates`, and says so rather than guessing | PASS |
| `tests/unit/pc5OptionSetsAndLinks.test.ts` — the unlock route file exists on disk at the linked path | PASS |

---

### K.9 — Summary mismatch — **PASS**

*"Show: statement value; reconstructed value; variance; affected scheme/account; source
evidence reference; allowed user actions. **Do not let the user simply type an arbitrary
balancing number into canonical truth.**"*

`Pc5SummaryMismatchView` requires **all six** fields — "show the variance but not the source
reference" is exactly the half-disclosure K.9 forbids.

**There is no numeric input anywhere in the decision path.** `PC5_SUMMARY_MISMATCH_OPTIONS`
contains three closed-vocabulary tokens — trust the statement, trust the transactions,
discard — and no free-form value. The route's zod schema has **no numeric field at all**. The
only number a user can type on the whole PC5 surface is an ownership *percentage*, which is
not a financial value: it attributes a figure that already exists and can never change it.

**The `source_disagreement` shape** (`ii_adapter:source_disagreement:<field>`) previously fell
through to the generic fallback, rendering as *"no specific guidance is registered for this
exact condition yet"*. It now has a registry entry. **It remains unexercisable**: it needs an
AI-fallback candidate to disagree with a deterministic one, and the AI fallback is unreachable
behind two independent blockers. Registered anyway, because leaving a real blocking shape
rendering as "no guidance" is strictly worse.

| Evidence | Result |
|---|---|
| Live S-31 — submitting `'12345.67'` as a balancing figure is refused `invalid_choice` | PASS |
| `tests/unit/pc5OptionSetsAndLinks.test.ts` — every option value matches `^[a-z_]+$` and contains no digit | PASS |

---

### K.10 — Duplicate candidate resolution — **CONDITIONAL PASS**

*"Allow user to confirm: same economic event; both genuine separate events; wrong
statement/source. Rerun canonical dedup/reconciliation after the decision."*

Modelled as a `choose_value` over the closed three-option `duplicate_resolution` set — those
three options **are** K.10's three questions. Before this pass the only permitted action on
`ii_adapter_duplicate_overlap` was `reject_document`, which is wrong in one of the three
cases: when the overlap is genuinely two separate events that look alike, rejecting discards
real data.

**"Separate genuine events" SUPPRESSES the overlap finding rather than rewriting it to
`pass`.** A suppressed check and a passed check are different facts, and recording a `pass`
for a check the user overrode would put a false clean result into the reconciliation history.
The user's decision is recorded in `aie_review_decision`, so the audit explains the absence.

| Evidence | Result |
|---|---|
| `tests/unit/pc5ReReconciliation.test.ts` — the overlap result is **absent**, not present-with-`pass` | PASS |
| Live S-29, S-30 | **BLOCKED_ON_0153** |

---

### K.11 — Wrong statement handling — **PASS**

Five requirements, five answers (`lib/pc5/discard.ts`):

| Requirement | How |
|---|---|
| **Block canonical publication** | Delegated to AIE's `rejectRun` → run `failed_terminal`, intake `cancelled`. `failed_terminal` has **no onward transitions** in `AIE_RUN_TRANSITIONS`, so the acceptance gate's `status !== 'awaiting_acceptance'` check can never again be satisfied. Structurally stronger than a PC5 "discarded" flag some call site might forget. |
| **Purge binary** | Delegated to `finalizeDocumentBinaryAfterRun` — delete, then **independently verify absent**, then mark. A delete returning success is not treated as proof. |
| **Purge token maps** | **None left to purge, mechanism intact.** Phase 4 deleted the reversible map; the TTL sweep still runs unconditionally on every cron pass so the guarantee survives if some future path starts writing again. Re-verified: 0 rows on DEV (S-46). |
| **Minimal privacy-safe audit** | Two rows: AIE's `run_failed`, plus `pc5_statement_discarded`. Reason is a **closed vocabulary**, not free text — a free-text discard reason is the field most likely to contain the very PII the discard exists to remove. |
| **Not delete unrelated investments** | The module imports no write service and issues **no delete of any kind**. A discarded statement was never accepted, so by construction it produced no canonical rows. |

| Evidence | Result |
|---|---|
| Live S-40 — run `failed_terminal`, intake `cancelled`, binary `deleted` | PASS |
| Live S-41 — after discard, re-reconciliation is refused `wrong_state`; the run can never reach `awaiting_acceptance` again | PASS |
| Live S-42 — an already-accepted run is refused `already_accepted` (that is K.18's amendment, not discard) | PASS |

---

### K.12 — User correction overlay — **CONDITIONAL PASS**

*"Never overwrite immutable extracted/source evidence. Store: original extracted value (the
masked/tokenized form only — NOT a recoverable original); parser/provider version; user
decision/correction; reason; actor; timestamp; resulting reconciliation version."*

Migration 0153 adds **three additive, nullable columns** to the existing
`aie_review_decision` — the identical move migration 0144 already made on the same table, for
the identical reason (so a typed fact has somewhere to live instead of being smuggled into
`rationale` as an ad-hoc JSON blob). **No new table.**

| K.12 field | Where |
|---|---|
| original extracted value (masked only) | `original_value_at_decision` |
| parser/provider version | `parser_version_at_decision` — **frozen at decision time**, so a later reprocess cannot retroactively rewrite a decision's provenance |
| user decision / correction | `decision_type`, `correction_value_normalized` (existing) |
| reason | `rationale` (existing) |
| actor | `actor_id` (existing) |
| timestamp | `created_at` (existing) |
| resulting reconciliation version | `resulting_reconciliation_at` — a timestamp, because one decision fans out to MANY `aie_reconciliation_run` rows; `created_at >= this` for the same run is the join. **Null keeps its meaning**: no re-reconciliation ran. |

**No recoverable original exists, and the type system says so.**
`Pc5CorrectionOverlayView.originalValueIsRecoverable` is typed to the **literal `false`** —
not a boolean — so a future change that tried to make it conditional would not compile. The UI
shows the masked form and states plainly that it cannot be turned back; there is no reveal
control, because there is no reveal path.

| Evidence | Result |
|---|---|
| `tests/unit/pc5Prohibitions.test.ts` — no PC5 file references `revealMaskedToken`, `tokenMapCrypto`, `persistMaskTokenMap`, `findMaskTokenCiphertext` or `aie_mask_token_map`; `tokenMapCrypto.ts` genuinely absent from the repository; the UI contains no `reveal` and does say "one-way / cannot be shown again" | PASS |
| Live S-32 | **BLOCKED_ON_0153** |

---

### K.13 — Review Centre semantics — **PASS**

*"Acknowledge/Dismiss must never masquerade as resolution."*

Prevented **structurally**, not by convention. Acknowledgement and dismissal produce an
`aie_unresolved_item.status` of `'in_review'`, which
`countItemsBlockingAcceptanceForRun` (`open`/`in_review`/`deferred`) counts as **still
blocking**. A user can acknowledge every exception on a document and it still cannot be
accepted. The only statuses that stop blocking are `resolved` and `superseded`, and PC5
cannot write either.

**Dismissal is refused outright for a blocking item.** K.13 permits it only as *"presentation
suppression where allowed"* — and there is no financial circumstance in which suppressing a
blocking exception from view is allowed, because the user would then face a clean-looking
document that still cannot be accepted, with no visible reason. Refused in
`permittedPc5Actions` **and again** server-side (`cannot_dismiss_blocking_item`).

**A real AIE inconsistency PC5 had to close.** `listOpenUnresolvedItemsForRun` filters to
`['open','in_review']` while `countItemsBlockingAcceptanceForRun` counts
`['open','in_review','deferred']` — so today a **deferred item blocks the accept button while
being invisible in the run-detail response**. PC5's listing reads `PC5_LIVE_ITEM_STATUSES`,
which includes `'deferred'`, precisely so that cannot happen here.

**The identity pair is counted once.** Verified assumption #2: an II identity exception is
recorded twice by design. `dropIdentityMirrors` drops the reconciliation half **only when its
typed partner is present** — an orphaned mirror is KEPT, because hiding the only remaining
evidence of a real blocking condition would be far worse than showing one extra row.

| Evidence | Result |
|---|---|
| `tests/unit/pc5ReviewStatus.test.ts` — `toPc5Status` total over every AIE status; NO live status maps to `resolved` when dismissed; `itemStillBlocks` mirrors the gate exactly; live/terminal sets **partition** every AIE status with no overlap and no gap | PASS |
| Live S-10 — a real open item projects OPEN, blocking, with `choose_value` offered and `dismiss` **not** offered | PASS |
| Live S-13 — a **deferred** item is visible to PC5 and counted as blocking, while AIE's own open-list returns zero rows for it | PASS |
| Live S-22 — dismissing a blocking item is refused | PASS |

---

### K.14 — Actionable deep links — **PASS**

The failure K.14 describes is not "no link exists" — it is a link landing one level too high,
on a list the user must then search. Centralised in `lib/pc5/deepLinks.ts` so the routes are
asserted **once** against the real page paths; a page that moves breaks a test rather than
quietly degrading every link to a list.

| Evidence | Result |
|---|---|
| Live S-11 — the item projects `/investment-intelligence/resolutions/<itemId>`, not the base path | PASS |
| Live S-14 — a direct link to a **non-material** item still renders it (the list view's filter never suppresses a followed link) | PASS |
| `tests/unit/pc5OptionSetsAndLinks.test.ts` — ids URL-encoded (a crafted id cannot break out of the path); every link is a path, never absolute (an absolute one would break previews and be an open-redirect shape); **the target pages exist on disk**; the surface is reachable from the workspace nav, not only by deep link | PASS |

---

### K.15 — User acceptance — **PASS**

All eleven required fields are present in `Pc5AcceptanceSummary` and **every one is derived
from real evidence; none is defaulted.**

| Evidence (live S-43, against a real run) | Observed |
|---|---|
| source type | `cams` |
| transaction / holding / scheme counts | 1 / 1 / 1 — real candidate rows |
| accounts (folio **masked**) | `******4455` — not `1122334455` |
| statement period | `2025-01-01` → `2025-03-31` |
| history completeness | `not_assessed` |
| reconciliation status | `not_applicable` |
| `readyToAccept` | **`false`** |

The last three lines are the interesting ones. `not_assessed` is a **real answer, not a
fallback**: a statement with no prior snapshot has no roll-forward rule result, and reporting
`complete` would claim a check that never ran — exactly what PC4-INV-08 is about. And
`readyToAccept: false` for a `not_applicable` reconciliation mirrors `accept.ts`'s own
refusal: accepting a document nothing ever checked is the silent gap AIE-1.6's NO-GO criteria
warn about, and this summary must not imply otherwise.

`readyToAccept` is **advisory and says so** — the accept route re-derives every condition
server-side and could not be made to read this flag.

---

### K.16 — Exception-only review — **PASS**

Default view shows only material items; the full extracted dataset is a **second request**
(`?full=1`) by design, so the default response does not hand a user several hundred
transaction rows they did not ask to audit.

| Evidence | Result |
|---|---|
| Live S-12 — a non-material item is hidden by default, present in the full view, and the hidden count is **reported** (1) so the UI can say so truthfully | PASS |
| Live S-44 — the full extract is null unless asked for, and **even then** holder names and folios stay masked | PASS |

**A real privacy defect the live matrix found here.** The full extract masked *account* folios
and left `folioNumber` in the clear on every *transaction* and *holding* — each carries its
own copy, verbatim from the statement. So the "full extract" leaked exactly the identifier the
summary had just masked, once per transaction. Fixed; regression-tested per-occurrence so a
fourth record shape added later is covered automatically.

---

### K.17 — Bulk decisions — **PASS (by deliberate non-implementation)**

*"Do not implement blind 'Accept all'... **If** bulk action is supported, restrict it to
explicitly safe homogeneous items."*

The "if" is a permission, not a requirement. **PC5 ships no bulk action at all**, and says so
rather than shipping a narrow one nobody can use and calling K.17 satisfied.

The exception set PC5 can produce is irreducibly heterogeneous: an owner mismatch, an ambiguous
account, a duplicate-overlap candidate and a statement-period defect need four different
decisions, from four different option sets, with four different re-reconciliation
consequences. There is no homogeneous subset large enough to be worth the risk.

`acknowledge` is the one uniform action — and acknowledging in bulk is precisely the "seen it
all, move on" gesture K.13 warns must never be mistaken for resolution. A bulk control whose
only effect is to make a blocked document *look* attended-to is worse than no control.

| Evidence | Result |
|---|---|
| Live GATE-3 — the flag is OFF | PASS |
| `tests/unit/pc5Prohibitions.test.ts` — no PC5 route accepts `itemIds`/`item_ids`/`bulk`; the flag has **zero consumers** | PASS |

---

### K.18 — Undo / amendment policy — **PASS (decision made and implemented)**

**The decision: PC5 implements AMENDMENT-BY-SUPERSESSION and does NOT implement "undo".**
No PC5 operation, at any lifecycle point, removes a record so the system afterwards looks as
though something never happened. What a user can do depends on where the canonical write sits:

| Where | Path | Why |
|---|---|---|
| **Before** the canonical write | **DISCARD** (`discard.ts`) | The statement never became financial truth. Nothing is erased because nothing was written. |
| **In-flight PC5 decisions** | **AMEND** — decide again | `aie_review_decision` has no update and no delete path; `recordReviewDecision` only inserts. The previous decision stays; the new one is appended; re-reconciliation runs against the new answer. An amended allocation supersedes its whole group with `effective_to` stamped. |
| **After** the canonical write | **II SUPERSESSION** — PC5 refuses and points | `ii_source_documents.superseded_by_document_id`, `ii_fhip_publications`'s bidirectional chain, `ii_transactions.corrects_transaction_id`. All already certified. |

**Three reasons PC5 does not build a post-acceptance undo**, in descending order of how much
they should bother a reviewer:

1. **It would be a second write path into canonical tables** — arguably the most dangerous
   one, since it deletes rather than inserts. K.3 and K.20 both forbid it. II's
   `unpublishPosition`/`republishPosition` already exist, are certified, emit the right audit
   events, and handle the net-worth consequences.
2. **The blast radius is not the statement.** One accepted CAS creates instruments, accounts,
   transactions, holding snapshots, FIFO tax lots, publications, goal allocations and forecast
   inputs, which downstream engines have already read. "Undo the statement" is a cascade whose
   correct shape is a domain question — e.g. whether tax lots consumed by a later disposal can
   be withdrawn at all — that this phase has no authority to answer.
3. **"Undo" is the wrong word for what users want.** The real requests are "this was the wrong
   person" (discard, available pre-acceptance) and "a corrected statement replaced it"
   (supersession, already modelled). A button labelled Undo invites the third, dangerous
   reading — "make it as if I never imported it" — which is the silent erasure of historical
   truth K.18 prohibits in its own sentence.

| Evidence | Result |
|---|---|
| `tests/unit/pc5AmendmentAndCapability.test.ts` — `amendmentPathForRunStatus` total over every run status; **no status maps to a path matching `undo\|delete\|erase\|remove`**; the accepted-statement guidance says "correction", not "undo", and promises nothing is deleted | PASS |
| Live S-42 — discarding an accepted run is refused `already_accepted` | PASS |

---

### K.19 — Resolution triggers re-reconciliation — **CONDITIONAL PASS**

**The gap this closes was total.** `resolveReconciliationRuleForAdapter` reads, in full:

```ts
if (adapterId === 'insurance_generic_schedule_v1') return buildInsuranceReconciliationRule();
return null;
```

`null` → `unsupported_adapter`. So **every** `correct`/`not_present` decision on an Investment
Intelligence item returned `revalidation: { ok: false, reason: 'unsupported_adapter' }` and
left the run in `unresolved` **permanently** — the only other exit being `rejectRun`. An II
document needing any decision could only ever be thrown away.

That is not an oversight in `revalidate.ts`: it returns `null` rather than
`noDomainAdapterReconciliationRule` precisely so it can never fabricate a PASS for an adapter
it cannot re-check. The gap was that nobody had built II's re-check.
`lib/pc5/reReconciliation.ts` is that.

**It reconciles against the immutable `aie_field_candidate` evidence, not a re-parsed PDF** —
for four independent reasons:

1. **Global invariant D.3.** The candidates ARE the recorded source evidence: written once,
   never mutated. Reconciling against them is reconciling against the evidence of record.
   Re-parsing produces a second, possibly different reading — the "silent rewrite" D.3 forbids.
2. **Parser drift.** A re-parse runs whatever parser is deployed *today*. If it changed
   between upload and decision, the user answers a question about one document and the system
   re-decides a different one, with no signal. K.12's `parser_version_at_decision` exists to
   pin exactly this and would be meaningless otherwise.
3. **The bytes are often legitimately gone.** AIE deletes the quarantine object as soon as it
   is no longer required, with a 24-hour hard backstop. A user returning the next day would
   find re-reconciliation impossible — the workflow defeated by the privacy guarantee it must
   coexist with. K.21 wants the PDF gone; K.19 wants resolution to re-reconcile; only
   candidate-based reconciliation satisfies both.
4. **Password-protected documents** would otherwise need the password on every decision.

**It is not a second lifecycle.** Every state-changing primitive is AIE's own —
`transitionRunStatusCas`, `recordReconciliationRuns`, `resolveItemBySystem`,
`createUnresolvedItems`, `recordRunTransitionAudit`. PC5 is a **third caller**, alongside
`revalidate.ts` and `dispatch.ts`.

**The single most important line in the module**: an identity rule that previously failed and
now passes is **re-recorded as `pass`**, not merely omitted. `latestReconciliationOutcomesForRun`
keeps the latest row per rule id, so an absent-but-previously-failing rule would keep its stale
`fail` forever and the acceptance gate would refuse a run for a condition that no longer exists.

| Evidence | Result |
|---|---|
| `tests/unit/pc5ReReconciliation.test.ts` — 22 tests: the cleared-identity-rule branch; that a **non**-identity prior failure is NOT cleared; CAS in and out through `reconciling`; `lost_race`; never stranded in `reconciling` when the pass throws | PASS |
| Live S-26 (owner cleared → `awaiting_acceptance`), S-27 (repeated observation) | **BLOCKED_ON_0153** |

**A real defect the live matrix found here.** The blocking count was derived from what the
pass **intended**, never from what it achieved. A failed `resolveItemBySystem` left the item
open in the database while the pass counted it gone and moved the run to
`awaiting_acceptance`. Nothing unsafe could follow — `accept.ts` re-derives the count — but a
stored run status contradicting the stored item set is the exact trap M3 fixed in
`dispatch.ts`, and a user would be told their document was ready and then refused with no
visible cause. Fixed; two regression tests added.

---

### K.20 — PC5 security — **PASS**

Every clause proven live against the real DEV database.

| K.20 clause | Scenario | Result |
|---|---|---|
| Only the authorised household user can resolve their item | S-19 — the attacker cannot decide the owner's item even with its real id (`not_found`) | PASS |
| Cross-user direct-ID access returns no sensitive evidence | S-15 — `projectItemContext` returns `null`; the attacker's listing is empty. S-16 — the attacker's own JWT reads **0 rows** | PASS |
| Browser cannot forge victim account/owner IDs | S-18 — a decision naming a **real, existing** household-member uuid belonging to another user is refused `invalid_choice`. The option set is built by a query filtered on the caller's own user id, so the id is simply absent from it | PASS |
| Same-user valid-FK forgery blocked for authoritative fields | S-37 — the database trigger refuses a cross-tenant `owner_member_id` (**BLOCKED_ON_0153**; the trigger is in 0153). S-17 — even the **owner's own** JWT cannot mutate an item status; 0 rows affected, status re-read as still `open` | PASS / BLOCKED |
| PC5 cannot direct-write canonical Investment tables | S-20 — a direct `ii_transactions` insert refused 403. Structurally: no PC5 file mutates a canonical table, imports `processSourceDocument`, references `acceptAndWriteInvestmentCandidates`, or imports the acceptance gate | PASS |
| Audit actor/source is accurate | S-23 — `actor_id` is the acting user; `decision_type` is `pc5_`-prefixed so a PC5 decision is distinguishable from AIE's own and from its system actors (**BLOCKED_ON_0153** for the live half; unit-tested) | PASS / BLOCKED |
| Allocations are not browser-writable | S-38 — the owner's own JWT cannot insert one | PASS |

**The capability check is real, not a stub.** `Pc5ExceptionInterfaceDeps.checkCapability` was
deliberately left required with no default when the AIE seam was built. PC5 supplies it:
same-tenant only, `callerId === targetUserId`, with empty-id guards so "unauthenticated equals
unauthenticated" can never be a match.

That looks almost trivially strict, so what was checked before settling on it: this codebase
has three delegated-access shapes and **none** extends to AIE exceptions —
`professional_access`/`permission_grant` are II audit vocabulary with no table granting third
parties access to `aie_*` rows (every `aie_*` policy is `user_id = auth.uid()` with no
exception); admin capabilities exist but PC5 builds no admin surface (an administrator
deciding whose money a statement represents is a different product decision with its own
consent requirements); and household membership is a **data** relationship, not an auth one —
"my spouse can resolve my exception" is not expressible today and must not be faked.

---

### K.21 — PC5 lifecycle + PDF purge — **PASS**

| Evidence | Result |
|---|---|
| Live S-45 — a **real** storage object is uploaded, purged via `finalizeDocumentBinaryAfterRun`, **independently verified absent**, and the intake row reads `status: deleted`, `storage_key: null`, `purge_status: purged`, `purged_at` set | PASS |
| Live S-46 — `aie_mask_token_map` holds **0 rows** on DEV | PASS |
| `tests/unit/pc5AcceptanceSummary.test.ts` — the lifecycle copy states the file is deleted **and** the data remains (the half users get wrong if left implicit), states masking cannot be reversed "by you or by us", and never promises a reveal or a recovery | PASS |

---

### K.22 — PC5 live DEV — **CONDITIONAL PASS**

`scripts/pc5_live_dev_matrix.ts` — **54 scenarios**, run against the real DEV project.

```
PASS             41
FAIL              0
BLOCKED_ON_0153  13
NOT_APPLICABLE    0
```

Full results: `scripts/pc5-live-dev-results.json`.

**What makes it real.** Every scenario calls PC5's **own production services** —
`decidePc5Resolution`, `projectResolutionsForUser`, `projectItemContext`,
`reReconcileInvestmentRun`, `discardStatement`, `buildAcceptanceSummary`,
`recordAllocationGroup`. Nothing reimplements the logic it checks. The field candidates come
from running the **real certified CAMS parser** over a fixture and serialising through the
**real `toAieCandidates`**, so the rehydration and reconciliation paths exercised are the ones
production uses.

**K.22's required matrix, mapped:**

| K.22 requires | Scenario(s) | Result |
|---|---|---|
| exact owner match | S-04 | PASS |
| owner mismatch | S-05 | PASS |
| self | S-01, S-04 | PASS |
| spouse / partner | S-01, S-06 | PASS |
| joint default allocation | S-08 (detection), S-33 (storage) | PASS / BLOCKED |
| edited allocation | S-34 | BLOCKED |
| child / dependent | S-07 | PASS |
| trust / HUF / existing entity types | S-01, S-02 | PASS (HUF disclosed absent — K.5) |
| duplicate candidate same / different | S-29, S-30 | BLOCKED |
| summary mismatch | S-31 | PASS |
| password required / reprocess | S-39 | PASS |
| wrong statement discard | S-40, S-41, S-42 | PASS |
| correction overlay | S-32 | BLOCKED |
| accepted canonical write | — | **NOT EXERCISED** (see below) |
| post-accept PDF purge | S-45 | PASS |
| cross-user denial | S-15, S-16, S-19 | PASS |
| concurrent resolution idempotency | S-24 | BLOCKED |
| repeated refresh / observation resolution | S-27 | BLOCKED |
| **zero synthetic residue** | CLEAN-1 | **PASS** |

**"Accepted canonical write" is NOT EXERCISED, and that is deliberate rather than an
omission.** Driving a real canonical write would require three feature flags on
(`AIE_REVIEW_CANONICAL_ACCEPTANCE_ENABLED`, `AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED`,
`AIE_DOCUMENT_INTAKE_ENABLED`) plus pilot-cohort membership, and would write real rows into
DEV's canonical Investment Intelligence tables through `processSourceDocument`. That is the
AIE-1 acceptance path, already certified by earlier phases, and it is **not PC5's code** —
PC5's own requirement is that it cannot write those tables, which is proven positively (S-20)
and structurally (`pc5Prohibitions`). Enabling production-shaped write flags to exercise
someone else's certified path was judged out of scope for a phase with no production
authority. The post-accept purge half, which **is** lifecycle-relevant to PC5, is exercised
for real (S-45).

**Rows created and cleaned** — counted by the harness itself, not estimated
(`CLEAN-1.detail.createdCounts`):

| | Created |
|---|---|
| synthetic auth users | 2 |
| households | 3 |
| household members | 7 |
| `ii_accounts` | 1 |
| `aie_document_intake` | 17 |
| `aie_extraction_run` | 16 |
| `aie_unresolved_item` | 15 |
| plus | 16 parser attempts, ~90 field candidates, 1 real storage object |

**Every one deleted and independently re-verified absent** across 12 tables plus the auth
users — a delete call returning success is not treated as proof, matching `purge.ts`'s own
discipline:

```
ii_ownership_allocation 0, aie_review_decision 0, aie_unresolved_item 0,
aie_reconciliation_run 0, aie_field_candidate 0, aie_parser_attempt 0,
aie_extraction_run 0, aie_document_intake 0, ii_accounts 0,
household_members 0, households 0, ii_review_items 0, authUsersRemaining 0
```

---

## 3. Summary verdict table

| Item | Verdict | Blocker |
|---|---|---|
| K.1 / K.2 Mission + `choose_value` | CONDITIONAL PASS | 0153 |
| K.3 One exception truth | **PASS** | — |
| K.4 Statement owner matching | **PASS** | — |
| K.5 Ownership choices | CONDITIONAL PASS | HUF = open PO decision (PO-PC5-1) |
| K.6 Joint ownership | CONDITIONAL PASS | 0153 |
| K.7 Owner mismatch behavior | **PASS** | — |
| K.8 Password-required case | **PASS** | (discloses: `request_reprocessing` unimplemented repo-wide) |
| K.9 Summary mismatch | **PASS** | (discloses: `source_disagreement` unexercisable) |
| K.10 Duplicate candidate resolution | CONDITIONAL PASS | 0153 |
| K.11 Wrong statement handling | **PASS** | — |
| K.12 User correction overlay | CONDITIONAL PASS | 0153 |
| K.13 Review Centre semantics | **PASS** | — |
| K.14 Actionable deep links | **PASS** | — |
| K.15 User acceptance | **PASS** | — |
| K.16 Exception-only review | **PASS** | — |
| K.17 Bulk decisions | **PASS** (deliberate non-implementation) | — |
| K.18 Undo / amendment policy | **PASS** | — |
| K.19 Resolution triggers re-reconciliation | CONDITIONAL PASS | 0153 |
| K.20 PC5 security | **PASS** | (one clause's live half needs 0153) |
| K.21 Lifecycle + PDF purge | **PASS** | — |
| K.22 Live DEV matrix | CONDITIONAL PASS | 0153 |

**13 PASS · 9 CONDITIONAL PASS · 0 FAIL.** Eight of the nine conditionals share **one**
blocker: migration 0153.

---

## 4. Defects found and fixed

Five, all found by writing tests or running the live matrix rather than by review.

| # | Defect | Found by | Fix |
|---|---|---|---|
| 1 | `normaliseHolderName` split on the apostrophe, so `O'Brien` ≠ `OBrien` — a false mismatch on a very common AU/IN surname shape | unit test | Apostrophes deleted rather than treated as separators (they sit *inside* one token, unlike every other mark in the set) |
| 2 | `reReconcileInvestmentRun` called `latestReconciliationOutcomesForRun` directly on the repository, breaking its own DI contract and making the cleared-identity-rule branch untestable without a database | unit test | Injected |
| 3 | The blocking count was derived from what a re-reconciliation **intended**, not what it achieved; a failed resolution left the item open while the run moved to `awaiting_acceptance` | **live matrix S-26** | Failed resolutions of blocking items count as still blocking and are reported as `failedResolutionItemIds` |
| 4 | K.16's full extract masked account folios but left `folioNumber` in the clear on every transaction and holding — leaking, once per transaction, the identifier the summary had just masked | **live matrix S-44** | All three record shapes masked; regression-tested per-occurrence |
| 5 | `recordReviewDecision` returned a bare `db_error` with no detail, making a transient failure, a constraint violation and a missing column indistinguishable | **live matrix** (six scenarios misreported as FAIL) | Sanitised DB message (URLs stripped, length capped) carried through the PC5 seam and decision service |

Defects 3 and 4 have regression tests. Defect 5 is an improvement to production diagnostics,
not only to the harness.

---

## 5. Migration 0153

**`supabase/migrations/0153_pc5_governed_resolution.sql`**

| | |
|---|---|
| **Version free?** | Yes, three independent ways — see §0 |
| **Collides with 0149–0152?** | **No.** Those four **ARE live-applied on DEV and on production** while still unmerged to `main` (`aie_document_intake.purge_status`, `.purge_due_at` from 0149; `aie_ai_cost_ledger` from 0150 all probe PRESENT on both). 0151/0152 replace 0150's RPC bodies and cannot be told apart by a read-only structural probe; 0153 touches none of their objects. **0153 sits cleanly ON TOP of live 0149–0152 state.** |
| **Applied to DEV?** | **NO** — no DDL path exists from this environment (§1) |
| **Applied to production?** | **NO.** No production authority anywhere in this phase. |

**What it does — deliberately small:**

1. **Three additive, nullable columns** on the **existing** `aie_review_decision` —
   `original_value_at_decision`, `parser_version_at_decision`, `resulting_reconciliation_at`.
   The identical additive move migration 0144 already made on the same table.
2. **One new table**, `ii_ownership_allocation` — **not an exception table**. It is Investment
   Intelligence *domain* data: the owner breakdown of an economic position. Nothing in the
   repository can express "this folio is 50/50 between two household members" (every register
   carries a single scalar `owner` role enum; `ii_accounts.owner_member_id` is a single
   nullable pointer), so K.6 cannot be met by reusing an existing shape. Modelled on
   `ii_goal_allocations` rather than invented: same
   `status in ('active','superseded','removed')` + `effective_from`/`effective_to` lifecycle.
   **SELECT-only RLS** (deliberately unlike `ii_goal_allocations`'s `for all`) plus a
   cross-tenant FK trigger.
3. **Widens `ii_audit_events`'s event-type CHECK** with five `pc5_*` values, reproducing every
   prior value verbatim.

**What it deliberately does NOT do:** no second unresolved-item table, no second status
vocabulary, no PC5 exception queue, no PC5 open-counter.

**An earlier draft of this migration's header asserted the opposite about 0149–0152** — that
they were not applied anywhere. That was wrong, and the reason is recorded in the file itself:
the first probe asked for `aie_document_intake.binary_purged_at` and `aie_cost_admission`,
neither of which 0149/0150 ever create, and read the resulting "absent" as evidence. The probe
now names the objects those migrations actually create, read from the migration files.

---

## 6. What was proven live, in one place

**41 PASS across 54 scenarios**, zero failures, zero residue. Notably:

- **Security is fully proven** — 8 of 10 K.20 scenarios PASS; the two blocked are the
  allocation-table trigger and the audit-actor live half, both 0153.
- **The entire read/projection path** — Review Centre semantics, deferred-item visibility,
  deep links, item context, exception-only default.
- **Discard end-to-end** — terminal run, cancelled intake, purged binary, structural
  publication block.
- **PDF purge end-to-end** — a real storage object, independently verified absent.
- **The acceptance summary** — every K.15 field from real evidence, folio masked,
  `readyToAccept: false` for an unchecked document.
- **Both one-exception-truth invariants** — zero `ii_review_items` rows created, and PC5's
  blocking count equal to the acceptance gate's for all 16 runs.

**13 BLOCKED_ON_0153.** Each was *attempted* and reports the exact database refusal — e.g.
`PGRST204 Could not find the 'original_value_at_decision' column of 'aie_review_decision'`.
"PC5's code reached the database and only the schema was missing" is materially different
evidence from "not tested", and is what makes the matrix re-runnable the moment 0153 is
applied.

---

## 7. Regression safety

| | |
|---|---|
| Full suite on this branch | **16 files / 22 tests failing** |
| Full suite at the Phase 4 base `5df12d1d` | **16 files / 22 tests failing** — measured by checking out the base and running the same sixteen files |
| **New failures introduced by PC5** | **ZERO** |
| PC5's own tests | **10 files / 220 tests, all passing** |
| Typecheck | `tsc --noEmit` clean |

One route-manifest test **did** fail on first run (`app/api/pc5` had no `ModuleKey` mapping)
and was fixed by mapping PC5 to `INVESTMENT_INTELLIGENCE` — mapped rather than added to the
infra allowlist alongside `aie`, because `aie` is genuinely cross-domain while every PC5 route
today is II-specific.

*Disclosure:* one intermediate full-suite run reported 17 files / 23 tests. A JSON-reporter run
and two subsequent plain runs all reported 16 / 22, and the 17th file in that run was one of
the nine `resources*` suites that fail at **collection** time (0 failing assertions — an import
failure, not an assertion failure). Treated as a transient in that environment, and recorded
here rather than omitted.

PC4's 19-invariant regression contract is not broken. PC5 **advances** two of its named gaps:
**CG-2** ("owner *mismatch* is not implemented at all; `holderName` is parsed and discarded")
is now implemented, and **PC4-INV-12**'s unenforced half is closed.

---

## 8. What PC5 did NOT close

Stated plainly so no later phase inherits a false assumption.

| Not closed | Why |
|---|---|
| **AWS S3 / GuardDuty malware scanning** | Outside PC5's dependency surface; not re-probed. **This report makes no malware-scanning claim.** The quarantine remains the Supabase Storage fail-closed *admission* gate M2/M3 documented — a genuine admission gate, and not a malware scanner. |
| **`AIE_MASK_TOKEN_ENCRYPTION_KEY`** | Still unset. PC5 deliberately does not depend on it. |
| **AI fallback** | Still unreachable behind two independent blockers. PC5 resolves items regardless of provenance, so this blocks only the `source_disagreement` shape. |
| **`request_reprocessing`** | Still implemented by nothing, repo-wide. PC5 does not implement it; K.8 deep-links to the real unlock route instead. |
| **A real accepted canonical write through PC5's own journey** | Deliberately not exercised — see K.22. |
| **Screen-reader/accessibility pass on the PC5 UI** | Not performed. The components use semantic markup, `role="alert"`/`role="status"`, `<fieldset>`/`<legend>`, and `sr-only` labels, but no assistive-technology testing was done. |

---

## 9. Product-Owner decisions required

**PO-PC5-1 — HUF as an ownership concept.** K.5 asks for HUF; this repository does not model
it, and PC5 refused to invent a ninth `OWNER_VALUES` entry backed by no valuation or
consolidation semantics (the mistake `'company'`/`'family_trust'` already represent). Options:
(a) accept that an HUF-held folio is recorded as a `business_entities` row, which requires
widening `entity_type` beyond `('company','family_trust')`; (b) build real HUF entity
semantics including its India tax treatment; (c) accept the gap and remove HUF from PC5's
scope. **PC5 implements none of these and awaits the decision.**

**PO-PC5-2 — Apply migration 0153 to DEV.** The single blocker behind 8 of 9 conditional
verdicts. Once applied, re-running `npx tsx scripts/pc5_live_dev_matrix.ts` should report
FULL mode and convert the 13 BLOCKED scenarios without any code change.

**PO-PC5-3 — Name the PC5 consumer owner.** `AIE10-GOV-01` requires it; M0 recorded that no
such naming exists. PC5 now exists and still has no named owner.

---

## 10. Files

**New (`lib/pc5/`, 3,200 lines):** `types.ts`, `featureFlags.ts`, `capability.ts`,
`deepLinks.ts`, `jointAllocation.ts`, `reviewStatus.ts`, `optionSets.ts`, `projection.ts`,
`decide.ts`, `allocationStore.ts`, `reReconciliation.ts`, `discard.ts`,
`acceptanceSummary.ts`, `amendment.ts`

**New (AIE adapter):** `ownerMatching.ts`, `rehydrate.ts`

**Modified (AIE):** `review/types.ts` (+`choose_value`, +`AieChoosableFieldSpec`),
`review/reasonCodes.ts`, `review/moduleRegistry.ts`, `db/repository.ts`,
`pc5/pc5ExceptionInterface.ts` (+`recordGovernedResolutionForPc5`), `adapters/…/dispatch.ts`,
`adapters/…/unresolvedItems.ts`, `adapters/…/householdContext.ts`

**New (routes/UI):** 5 routes under `app/api/pc5/`; 2 pages; 2 client components

**New (tests, 2,057 lines):** 10 files, 220 tests

**New (scripts):** `pc5_live_dev_matrix.ts`, `pc5_migration_baseline_probe.mjs`,
`pc5_ddl_capability_probe.mjs`, `pc5_rpc_inventory_probe.mjs`,
`pc5-live-dev-results.json`

**Migration:** `0153_pc5_governed_resolution.sql`
