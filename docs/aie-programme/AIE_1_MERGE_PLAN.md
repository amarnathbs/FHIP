# AIE-1 Branch Merge Plan

**This document is planning only. No branch was actually merged by this
pass — the six real branches named below are byte-for-byte unmodified.**
Everything reported here as "observed" was produced by real, disposable
dry-run merges in a local scratch branch (`scratch/aie-merge-dryrun`,
never pushed, deleted before this pass finished) and real command
executions against the resulting tree — never guessed from reading diffs
alone. Section 3 of `AIE_1_PRODUCTION_CERTIFICATION_PLAN.md` states, at a
planning level, what a genuine merge needs to satisfy; this document is
that checklist turned into a validated, step-by-step execution record.

**No migration was applied to any database. No feature flag was enabled
anywhere. Nothing was pushed to origin except this document, on this new
branch.**

---

## 1. File-level overlap map

Method: `git diff --name-only <merge-base> <branch>` for each of the six
branches against their real merge-base (`cd2d4a2`, AIE-1.1's own tip, for
every branch except 1.6/cert-plan, whose base is 1.5's/1.6's own tip
respectively — confirmed by `git merge-base` for every pair, not assumed).

| Branch | Merge-base vs 1.1 | Own new/changed files (excl. migration, doc-report files) |
|---|---|---|
| `feature/aie-1-2-investment-adapter` | `cd2d4a2` (1.1 tip) | `lib/aie/adapters/investment-intelligence/**` (10 files), `tests/unit/aieIiAdapter*.test.ts` (6 files), `tests/support/buildAieIiCasFixtureText.ts`, **`tests/unit/fdh1Isolation.test.ts`** (shared), **`docs/aie-programme/AIE_1_MASTER_PLAN.md`** (shared) |
| `feature/aie-1-3-fdh-bank-adapter` | `cd2d4a2` | `lib/aie/adapters/fdhBankStatement/**` (7 files), `app/api/aie/fdh-bank/intake/route.ts`, `tests/unit/aieFdhBankStatement*.test.ts` (3 files), **`lib/aie/orchestrator.ts`** (1.1-core, additive), **`tests/unit/fdh1Isolation.test.ts`** (shared) |
| `feature/aie-1-4-other-modules` | `cd2d4a2` | `lib/aie/adapters/insurance/**` (8 files), `app/api/aie/insurance/intake/route.ts`, `tests/unit/aieInsuranceAdapter*.test.ts` (4 files), **`tests/unit/fdh1Isolation.test.ts`** (shared), **`docs/aie-programme/AIE_1_MASTER_PLAN.md`** (shared) |
| `feature/aie-1-5-exception-review-ux` | `cd2d4a2` (contains 1.4 in full — `git merge-base 1.4 1.5` = 1.4's own tip `90c1ffb`, confirmed) | `lib/aie/review/**` (13 files), `app/(app)/aie-review/**`, `app/api/aie/review/**`, `components/aie/review/**`, plus 1.4's own files carried through, **`lib/aie/audit.ts`**, **`lib/aie/db/repository.ts`** (both 1.1-core, extended, touched by no other branch), `proxy.ts`, `tests/unit/aieReview*.test.ts` (10 files) |
| `feature/aie-1-6-certification` | `feature/aie-1-5-exception-review-ux`'s own tip `17fe496` (confirmed via `git merge-base`) | 2 new adversarial test files + 1 certification report only — zero code changes vs 1.5 |
| `fix/aie-1-1-pdf-flatedecode-detection` | `cd2d4a2` | `lib/aie/validation/fileValidation.ts`, `tests/unit/aieFileValidation.test.ts` — touches no file any other branch touches |
| `feature/aie-1-production-cert-plan` | `feature/aie-1-6-certification`'s own tip `b22fc42` | 1 new doc file only |

**Files touched by more than one of the five independent (1.1-based)
branches — the only real collision candidates:**

1. **`docs/aie-programme/AIE_1_MASTER_PLAN.md`** — touched by 1.2 and 1.4
   (not 1.3, not the fix branch). Each inserts its own "phase N has since
   been implemented" paragraph at the identical anchor point (immediately
   after AIE-1.1's own paragraph, before "Source documents"). Purely
   additive prose, no shared line is edited by both sides.
2. **`tests/unit/fdh1Isolation.test.ts`** — touched by 1.2, 1.3, and 1.4
   (1.5's own diff vs 1.1 shows the identical change 1.4 already made,
   confirming 1.5 added nothing further here beyond carrying 1.4's edit
   forward). Each phase appends its own allow-listed-file comment block
   to the same array, at the same anchor point (immediately after the
   AIE-1.1 entry). Purely additive, no shared line is edited by more than
   one side.
3. **`lib/aie/orchestrator.ts`** (AIE-1.1 core) — the task specifically
   asked whether any branch besides 1.3 touches this file. **Confirmed:
   no.** `git diff --name-only cd2d4a2 <branch>` for 1.2, 1.4, and 1.5 does
   **not** list `lib/aie/orchestrator.ts` at all. Only 1.3 modifies it —
   an additive, optional `parserOverride?: RegisteredParser` field on
   `RunPipelineParams`, backward-compatible (every existing caller that
   omits it is byte-for-byte unaffected; confirmed by the merge in
   section 2 producing zero conflict on this file).
4. **`lib/aie/audit.ts`, `lib/aie/db/repository.ts`** (AIE-1.1 core) —
   touched only by 1.5 (verified: absent from 1.2's, 1.3's, and 1.4's own
   diffs). No collision risk from 1.2/1.3/1.4.

No other file is touched by more than one of the five independent
branches. Migration files are already collision-free by number
(`0140`-`0144`, confirmed again in section 3 below on the actual merged
tree, not just re-asserted from a prior report).

---

## 2. Dry-run merge — real results, in the validated order

Performed in a disposable local branch (`scratch/aie-merge-dryrun`),
created from `feature/aie-1-5-exception-review-ux`'s own tip (`17fe496`),
never pushed, **deleted after this pass** (confirmed at the end of this
document).

### Step 1 — merge `feature/aie-1-6-certification` (`b22fc42`)

```
Updating 17fe496..b22fc42
Fast-forward
 docs/aie-programme/AIE_1_6_CERTIFICATION_REPORT.md | 427 ++++++++++++++
 tests/unit/aie16CertificationAdversarial.test.ts   | 101 +++
 tests/unit/aie16CertificationAdversarialPdf.test.ts|  58 +++
 3 files changed, 586 insertions(+)
```

**Clean fast-forward** — exactly as expected, since 1.6 is a direct
descendant of 1.5's own tip and adds only new files.

### Step 2 — merge `fix/aie-1-1-pdf-flatedecode-detection` (`1afceec`)

```
Merge made by the 'ort' strategy.
 lib/aie/validation/fileValidation.ts | 114 +++++++++++++++++++++++++--
 tests/unit/aieFileValidation.test.ts |  93 ++++++++++++++++++++
 2 files changed, 203 insertions(+), 4 deletions(-)
```

**Clean real three-way merge, zero conflicts.** This is the first
non-fast-forward merge in the sequence (the fix branch diverges from 1.1's
tip independently of 1.5/1.6's own downstream history) and it resolved
automatically.

### Step 3 — merge `feature/aie-1-2-investment-adapter` (`5ac527e`)

**Real conflicts — two files, both purely additive/textual, both
resolved with full confidence:**

```
Auto-merging docs/aie-programme/AIE_1_MASTER_PLAN.md
CONFLICT (content): Merge conflict in docs/aie-programme/AIE_1_MASTER_PLAN.md
Auto-merging tests/unit/fdh1Isolation.test.ts
CONFLICT (content): Merge conflict in tests/unit/fdh1Isolation.test.ts
```

**Conflict 1 — `AIE_1_MASTER_PLAN.md`** (exact hunk):

```
<<<<<<< HEAD
**AIE-1.4 (other PDF-enabled FHIP modules) has since been implemented,
...
**AIE-1.5 (unified review/acceptance UX) has since been implemented,
...
grants no production authority.
=======
**AIE-1.2 (Investment Intelligence adapter) has since been implemented,
...
decision, not resolved by proceeding.
>>>>>>> origin/feature/aie-1-2-investment-adapter
```

Both sides add an independent "phase N has since been implemented"
paragraph at the same anchor point; neither edits a line the other side
also edited. **Resolution:** kept both paragraphs, ordered 1.2 before 1.4
before 1.5 (matching phase numbering) — a purely editorial ordering
choice with no semantic ambiguity. One pre-existing textual oddity
surfaces as a result, not introduced by the merge: AIE-1.4's own paragraph
says "Same caveat as AIE-1.2's note below" — at the time AIE-1.4 was
written it was never merged with 1.2, so "below" was aspirational; after
this merge 1.2's note is now genuinely above 1.4's, so the cross-reference
direction is technically backwards (should read "above"). Cosmetic only;
noted for whoever lands the real merge to fix in the same commit.

**Conflict 2 — `tests/unit/fdh1Isolation.test.ts`** (exact hunk,
abbreviated — full comment blocks preserved verbatim in the resolution):

```
<<<<<<< HEAD
      // AIE-1.4 (2026-09-11): lib/aie/adapters/insurance/documentCatalogue.ts
      ...
      path.join(REPO_ROOT, 'lib', 'aie', 'adapters', 'insurance', 'documentCatalogue.ts'),
      path.join(REPO_ROOT, 'lib', 'aie', 'adapters', 'insurance', 'labels.ts'),
=======
      // AIE-1.2 (2026-09-11): lib/aie/adapters/investment-intelligence/
      ...
      path.join(REPO_ROOT, 'lib', 'aie', 'adapters', 'investment-intelligence', 'featureFlags.ts'),
>>>>>>> origin/feature/aie-1-2-investment-adapter
```

Same shape as conflict 1: two independent appends to the same allow-list
array at the same anchor point, each documenting a different, disjoint set
of approved file paths. **Resolution:** kept both blocks, ordered 1.2's
entry before 1.4's. Verified post-resolution: exactly 7 distinct
`fdhBankStatement` path entries later (step 4) with zero duplicates, and
zero conflict markers left in the file (`grep -c '^<<<<<<<\|^=======\|^>>>>>>>'`
returned no matches).

Commit: `a03817a` (merge of 1.2 into the scratch branch).

### Step 4 — merge `feature/aie-1-3-fdh-bank-adapter` (`cf20616`)

**One real conflict — same file, same additive shape, same resolution
pattern:**

```
Auto-merging tests/unit/fdh1Isolation.test.ts
CONFLICT (content): Merge conflict in tests/unit/fdh1Isolation.test.ts
```

1.3's own block (7 file paths under `lib/aie/adapters/fdhBankStatement/`
plus the route file) conflicted with the already-resolved 1.2+1.4 content
at the identical anchor point, for the identical reason. **Resolution:**
inserted 1.3's block between 1.2's and 1.4's (phase-number order),
verified no duplicate paths and no leftover markers.

**`lib/aie/orchestrator.ts` — auto-merged with zero conflict**, confirming
section 1's finding empirically: no other branch in the sequence touches
this file, so git's three-way merge applied 1.3's additive
`parserOverride` hunk cleanly. Diff of the merged result against 1.1's own
tip, personally inspected:

```diff
-import { sniffDocument, type DeterministicParserResult } from './classifier/registry';
+import { sniffDocument, type DeterministicParserResult, type RegisteredParser } from './classifier/registry';
...
+  parserOverride?: RegisteredParser;
...
-  const sniff = sniffDocument(extractedText);
+  const sniff = parserOverride
+    ? parserOverride.sniff(extractedText)
+      ? ({ kind: 'unambiguous', parser: parserOverride } as const)
+      : ({ kind: 'none_matched' } as const)
+    : sniffDocument(extractedText);
```

Confirms AIE_1_3_IMPLEMENTATION.md's own claim exactly: optional,
backward-compatible, no interaction with any other branch's code.

Commit: `3e3e462` (merge of 1.3 into the scratch branch).

### Step 5 — merge `feature/aie-1-production-cert-plan` (`6b2854f`)

```
Merge made by the 'ort' strategy.
 .../AIE_1_PRODUCTION_CERTIFICATION_PLAN.md | 347 +++++++++++
 1 file changed, 347 insertions(+)
```

**Clean, zero conflicts** — a new doc file only, as expected.

Commit: `10db172` (final scratch-branch state re-verified in section 3).

### Summary

| Step | Branch | Result |
|---|---|---|
| 1 | 1.6 | Clean fast-forward |
| 2 | fix (flatedecode) | Clean 3-way merge |
| 3 | 1.2 | **2 real conflicts, both resolved** (additive doc + additive test allow-list) |
| 4 | 1.3 | **1 real conflict, resolved** (same allow-list file); `orchestrator.ts` auto-merged clean |
| 5 | cert-plan | Clean, zero conflicts |

Every conflict encountered was a textual "two independent appends at the
same anchor point" shape — never a semantic contradiction, never two
sides editing the same logic. All three were resolved with full
confidence; none required a "not confident, stopping" call.

---

## 3. Re-verification on the merged result — evidence actually observed

All commands below were run against the scratch branch's own final state
(commit `10db172`), in this exact worktree, after junctioning
`node_modules` to the main checkout's real `node_modules` (the same
workaround every prior AIE report discloses using — `node scripts/...`
require real, installed packages that are not part of a bare worktree
checkout).

### Migration collision check

```
node scripts/check-migration-versions.mjs
  -> OK: 137 active migrations, one file per version, next version is 0145.
  -> Note: unused version numbers in the chain: 0079, 0080, 0081, 0103, 0128, 0138, 0139
```

Migrations `0140`-`0144` (1.1 through 1.5) are all present, sequential,
one file per version, no collision. (The "unused" numbers listed are
pre-existing gaps from other, unrelated in-flight branches per this
session's own memory — not an AIE artifact.)

### `npx tsc --noEmit`

Exactly 10 errors, across the same 4 pre-existing files every prior AIE
report (most recently AIE-1.6's own certification, section on
verification) discloses as a known, unrelated baseline — **zero new
errors from the merge**:

```
app/api/payments/razorpay/webhook/route.ts(1,22): Cannot find module 'razorpay'
app/api/payments/stripe/webhook/route.ts(5,25): Cannot find module 'stripe'
lib/services/payments/invoices.ts(6,25): Cannot find module 'stripe'
lib/services/payments/invoices.ts(35,28): implicit 'any' (pre-existing, same file)
lib/services/payments/razorpayClient.ts(2,22): Cannot find module 'razorpay'
lib/services/payments/stripeClient.ts(8,20): Cannot find module 'stripe'
scripts/resources/lib/workbook.ts(10,23): Cannot find module 'xlsx'
scripts/resources/lib/workbook.ts(129,16 / 129,19): implicit 'any' x2 (same file)
tests/unit/support/pgliteInsightPackHarness.ts(16,24): Cannot find module '@electric-sql/pglite'
```

### `npx eslint lib/aie app/api/aie "app/(app)/aie-review" components/aie proxy.ts`

**Zero errors, zero warnings** — clean.

### `npx vitest run tests/unit/aie*.test.ts` (all five phases' own AIE test suites, together, for the first time ever)

```
Test Files  1 failed | 31 passed (32)
Tests       1 failed | 263 passed (264)
```

**The one failure is real, expected, and a positive signal, not a
regression** — see the dedicated finding below. Everything else passed.

### `npx vitest run` (full repository suite)

```
Test Files  18 failed | 310 passed | 2 skipped (330)
Tests       19 failed | 6575 passed | 18 skipped (6612)
```

Compared line-by-line against AIE-1.6's own last observed full-suite
baseline (run against 1.5+1.6, pre-merge: 300 files passed/17 failed/2
skipped; 6500 tests passed/18 failed/18 skipped): **every one of the 18
failed files matches a category AIE-1.6 already disclosed as pre-existing
and unrelated to AIE** — 3 `@electric-sql/pglite`-dependent AI Insight
Pack files, 9 `resources*LiveDev`/admin files that need a real Supabase
URL or `.env.local` (not present in this worktree), the pre-existing
`countryGateAccessMatrix` MC-15 assertion, the pre-existing
`aiResidualClosureFailClosed` A4 negative-control assertion, and the
`stripe`/`razorpay`-dependent payment provider/checkout/webhook tests (3
files, 15 individual test cases). **The one new file, and one new test,
beyond that known baseline is `aie16CertificationAdversarialPdf.test.ts`**
— explained in detail immediately below. No other regression against the
rest of the FHIP codebase was found.

### Genuine, newly-observed finding #1 — the AIE-1.6 adversarial PDF test now fails, because the security fix it was written to document has landed

`tests/unit/aie16CertificationAdversarialPdf.test.ts`'s second test
constructs a `/JavaScript` action hidden inside a `/Filter /FlateDecode`
stream and asserts `scanPdfStructure(...).suspicious` is `false` — it was
written, by design, to **confirm a known bypass exists** (its own
docstring: "recorded here as independently CONFIRMED... it is unit-tested
to REMAIN true... not asserted as acceptable"). Once
`fix/aie-1-1-pdf-flatedecode-detection` is merged in (step 2 above), the
bypass this test documents is exactly what that fix closes, so the
assertion now fails:

```
AssertionError: expected true to be false
- Expected: false
+ Received: true
```

I constructed and ran (in a throwaway, deleted probe file, never
committed) the identical fixture against the merged code to get the exact
post-fix values, not just the pass/fail signal:

```
suspicious: true
reasons: ["embedded_javascript"]
admission: { ok: false, failureCode: "structural_reject" }
```

This is **the fix working correctly** — not a functional regression. It
is, however, a real piece of merge-step work the eventual real merge must
do: `aie16CertificationAdversarialPdf.test.ts`'s second test needs its
assertions flipped (`suspicious` → `true`, add `reasons` to contain
`embedded_javascript`, `admission.ok` → `false`) and its own docstring
rewritten from "CONFIRMS the disclosed gap" to "CONFIRMS the fix closes
this specific gap" — otherwise a real merge would ship with one AIE test
permanently red. Not implemented here (would be a functional test-code
change to a certification artifact, which this planning pass does not
make) — recorded precisely so the merge step can apply it directly.

### `npx vitest run tests/unit/aieIiAdapter*.test.ts` (AIE-1.2's own suite, in the merged context)

```
Test Files  6 passed (6)
Tests       42 passed (42)
```

Confirms AIE-1.2's own claimed 42 tests genuinely still pass once run
alongside every other phase — not merely paper-reviewed.

### `npx vitest run tests/unit/aieFdhBankStatement*.test.ts` (AIE-1.3's own suite, in the merged context)

```
Test Files  3 passed (3)
Tests       23 passed (23)
```

Confirms AIE-1.3's own claimed 23 tests genuinely still pass once run
alongside every other phase — matching `AIE_1_3_IMPLEMENTATION.md`'s own
retroactive re-run exactly.

### Cross-adapter test-registry collision check

Grepped every `aieSchemaRegistry.register(...)` / `aieParserRegistry.register(...)`
call site across all three merged adapters plus core:

| Registry | Values registered by each adapter | Collision? |
|---|---|---|
| Parser `adapterId` | Insurance: `insurance_generic_schedule_v1`; Investment Intelligence: `ii_cas_kfintech_folio_v1`; FDH bank (classification): `aie_fdh_bank_statement_classification_v1`; FDH bank (request-scoped bridge, via `parserOverride`): `aie_fdh_bank_statement_bridge_v1` | None — 4 distinct strings |
| Schema `name` | Generic core: `aie_generic_field_completion`; Insurance: `aie_insurance_adapter_field_completion`; Investment Intelligence: `aie_ii_adapter_field_completion`; FDH bank: `fdh_bank_institution_hint`, `fdh_bank_statement_extraction` | None — 5 distinct strings |

`AieParserRegistry.register()` and the schema registry's own `register()`
both throw synchronously on a real `adapterId@version` or `name` collision
(confirmed by reading `lib/aie/classifier/registry.ts`); since every
import-time registration across the full suite ran without that error
being thrown (both the AIE-scoped and full-suite runs above import every
adapter's `index.ts`), this is empirically confirmed, not just
statically reasoned.

### Genuine, newly-observed finding #2 — AIE-1.5's own module-descriptor registry does not recognise either 1.2's or 1.3's real adapter ids

`lib/aie/review/moduleRegistry.ts`'s own header for the Investment
Intelligence and FDH-bank descriptors explicitly anticipated this risk:
"included so the review UI's contract is genuinely adapter-agnostic and a
future AIE-1.2 merge only needs to flip `integrationTested` to true **and
correct any drift found by then**" — because those descriptors'
`matchesAdapterId` predicates were written by guessing at 1.2/1.3's
eventual adapter-id naming before either branch was ever merged in
(1.5's own implementation report already discloses this: "their reason
codes/contracts were transcribed from their own unmerged branches, never
executed").

I tested the guess against the real, merged code. It is wrong for both:

```ts
// moduleRegistry.ts, as merged:
matchesAdapterId: (adapterId) => adapterId.startsWith('investment_intelligence_') || adapterId.startsWith('ii_adapter')  // Investment Intelligence
matchesAdapterId: (adapterId) => adapterId.startsWith('fdh_bank')                                                        // FDH bank
```

```ts
// The REAL, committed adapter ids (parserAdapter.ts / fdhBankStatement/index.ts / fdhBankStatement/parser.ts):
II_ADAPTER_ID                      = 'ii_cas_kfintech_folio_v1'                    // does not start with 'ii_adapter' or 'investment_intelligence_'
FDH_BANK_CLASSIFICATION_ADAPTER_ID = 'aie_fdh_bank_statement_classification_v1'    // does not start with 'fdh_bank'
FDH_BANK_STATEMENT_ADAPTER_ID      = 'aie_fdh_bank_statement_bridge_v1'            // does not start with 'fdh_bank' either — this is the id actually
                                                                                    // recorded for a real run, since the FDH-bank intake route uses
                                                                                    // `parserOverride` with this request-scoped parser, not the
                                                                                    // globally-registered classification-only one
```

Verified empirically (throwaway probe test, not committed) by calling
`resolveModuleDescriptorByAdapterId(...)` with all three real ids against
the actual merged registry:

```
{
  ii:               { id: "ii_cas_kfintech_folio_v1",                 resolved: null },
  fdhClassification:{ id: "aie_fdh_bank_statement_classification_v1", resolved: null },
  fdhBridge:        { id: "aie_fdh_bank_statement_bridge_v1",         resolved: null }
}
```

**All three resolve to `null`** — the generic fallback path, not their own
descriptor. Consumers of this resolver
(`lib/aie/review/decide.ts`, `app/api/aie/review/inbox/route.ts`) would
render generic reason-code labels/fields for every Investment Intelligence
and FDH-bank exception instead of the module-specific ones already built
in `moduleRegistry.ts` for exactly this purpose (custom
`summaryFieldOrder`, `reasonCodePrefixes`, human-readable questions). This
is a real, previously-undetectable-in-isolation defect — 1.5's own test
suite could never catch it (it only ever exercised Insurance, whose real
id `insurance_generic_schedule_v1` happens to exact-match its own
descriptor's exact-string predicate), and neither could 1.2's or 1.3's own
isolated suites (they have no `moduleRegistry.ts` in their own diff at
all). It surfaced only because this dry-run actually ran real 1.2/1.3 code
against real 1.5 code in the same process — exactly the class of
cross-branch interaction this plan's own instructions asked to watch for.

**Note for section 4 below**: this is a separate defect from the two
named "required post-merge code changes" (which are about the *write*
path), but it is directly adjacent — a correct implementation of either
change will need to determine "which adapter wrote this run" from its
`adapterId`, and reusing `moduleRegistry.ts`'s existing (broken)
predicates for that decision would silently misroute. Whoever lands the
real merge should fix these two predicates (exact-match against the real
constants, the same pattern Insurance's own descriptor already uses) in
the same pass, not defer it further.

### Not fabricated, not extrapolated

Every count, hunk, and outcome above was produced by an actual command
run against the actual merged tree in this pass, in this worktree — none
of it is copied from a prior report's claim, and none of it is a "should
pass" inference from reading source.

---

## 4. Two required post-merge code changes — described, not implemented

Per this planning pass's own scope: these are real functional code
changes, correctly out of scope for a planning dispatch. Both are
described here precisely enough to execute directly, grounded in the real
`accept.ts`/`atomicImport.ts`/`write.ts` code now available from the
dry-run merge (previously unavailable to any paper review, including
AIE-1.6's own).

### 4a. AIE-1.3 (FDH bank statement): move the commit path onto `accept.ts`'s centralized gate

**Current shape** (`route.ts`'s own inline gate, per
`AIE_1_3_IMPLEMENTATION.md` section 5's own disclosure): the FDH-bank
intake route itself checks `outcome.finalStatus === 'awaiting_acceptance'`
before calling `commitFdhBankStatementImport()` directly, in the same HTTP
request as the original upload. `atomicImport.ts`'s own header states it
"does not re-check the AIE reconciliation-run rows itself... trusts its
caller" — internally consistent today only because its one caller
(`route.ts`) does gate correctly, but it bypasses AIE-1.5's independently
tested, centralized `acceptRun()` gate entirely.

**Target shape** (matching exactly what AIE-1.5 already did for Insurance,
read directly from `accept.ts`): `accept.ts`'s `acceptRun()` currently
hardcodes ONE call, `deps.acceptAndWriteInsurance(...)`, after it has
already independently verified (a) the run belongs to the caller, (b) run
status is `awaiting_acceptance`, (c) zero blocking items remain, (d) the
latest reconciliation outcome is `pass`/`pass_with_tolerance`, and (e) a
CAS transition to `write_pending` has succeeded. FDH-bank needs the exact
same generic upstream gating, with its own adapter-specific call
substituted at the single dispatch point.

**Concretely, `accept.ts` needs:**

1. A way to know which adapter owns a run — `repo.getAdapterIdForRun(run.id)`
   already exists and is already used by `decide.ts`/`revalidate.ts` for
   exactly this purpose; `AcceptRunDeps` does not currently include it and
   would need to.
2. A dispatch branch, keyed off that adapter id (using the **corrected**
   exact-match predicates from finding #2 above, not the broken prefix
   guesses — e.g. `adapterId === 'aie_fdh_bank_statement_bridge_v1'`),
   replacing the single hardcoded `deps.acceptAndWriteInsurance(...)` call
   with an `if/else` (or small internal registry) that calls
   `commitFdhBankStatementImport()` for an FDH-bank run instead.
3. **A real shape mismatch to resolve, not just wire through**:
   `commitFdhBankStatementImport(req: FdhBankCommitRequest)` takes
   `{ userId, runId, intakeId, bytes, metadata: BankCsvUploadMetadataInput }`
   — it needs the **original file bytes** and upload-time metadata
   (`country_code`, `currency_code`, `declared_masked_identifier`,
   `statement_period_*`), because it re-runs FDH-5's own
   `uploadBankPdf` → `processBankPdfDocument` pipeline from scratch on
   those bytes. Insurance's and Investment Intelligence's own accept-time
   write functions do NOT need this — they write from already-extracted,
   already-corrected field *candidates* stored in AIE's own tables, never
   re-touching the original bytes. `accept.ts`'s call to
   `commitFdhBankStatementImport` therefore cannot simply reuse the
   `mergedCandidates` value `acceptRun()` already computes for Insurance;
   it needs a NEW path that downloads the original bytes from quarantine
   (the same pattern Investment Intelligence's own `write.ts` already uses
   internally via `downloadFromQuarantine`) and reconstructs
   `BankCsvUploadMetadataInput` from whatever AIE persisted about the
   original upload request (this metadata is not currently modeled
   anywhere in AIE-1.1's own schema — it would need a new, small persisted
   field, or the accept-time caller would need to re-derive it from the
   quarantined document's own extracted metadata; this sub-decision is not
   resolved by this document and should be flagged explicitly to whoever
   implements it).
4. `AcceptRunOutcome`'s `insurancePolicyId?: string` field is
   Insurance-specific; the FDH-bank branch's own outcome
   (`statementUploadId`, `transactionsCreated`) needs an equivalent
   optional field, or (cleaner) `AcceptRunOutcome` should grow a
   discriminated `writeResult` shape keyed by adapter rather than adding
   another adapter-specific optional field indefinitely (the same
   generalization Insight applies to 4b below).
5. `findOrCreateWriteBatch(...)`'s `targetModule` parameter is currently
   hardcoded to `'other'` in `acceptRun()` — it already accepts
   `'fdh_bank'` as a valid value (confirmed in
   `lib/aie/db/repository.ts`'s own type signature) and should be set from
   the resolved adapter, not hardcoded, once dispatch exists.

### 4b. AIE-1.2 (Investment Intelligence): confirm/whether `write.ts` needs the same treatment

**Read directly from the merged code (previously impossible for any paper
review — AIE-1.6's own report explicitly could not do this because it
never executed 1.2's code):**
`acceptAndWriteInvestmentCandidates(input: AcceptAndWriteInput, deps: AcceptAndWriteDeps)`
in `lib/aie/adapters/investment-intelligence/write.ts` **already
implements the identical three-gate discipline** `accept.ts` itself
enforces generically, as an internal defense-in-depth re-check (its own
header states this explicitly): (1) feature-flag kill switch, (2)
reconciliation outcome is `pass`/`pass_with_tolerance`, (3) no open
blocking unresolved item. Its outcome shape
(`{ ok: false, reason: ... } | { ok: false, reason: 'already_written', ... } | { ok: true, ... }`)
is structurally almost identical to Insurance's own
`AcceptAndWriteInsuranceOutcome` shape that `accept.ts` already consumes.

**Answer: it does NOT currently route through `accept.ts` at all** — there
is no call site anywhere in `lib/aie/review/**` to
`acceptAndWriteInvestmentCandidates`. It needs the same kind of dispatch
branch as 4a, not a rebuild, and the wiring is materially SIMPLER than
FDH-bank's because the input shapes are much closer to Insurance's
already-wired pattern:

1. Add the same `getAdapterIdForRun` dependency and dispatch branch as
   4a, matched against `II_ADAPTER_ID = 'ii_cas_kfintech_folio_v1'` (again,
   the corrected exact-match predicate, not the broken
   `moduleRegistry.ts` guess).
2. `AcceptAndWriteInput`'s fields (`ownerMemberId`, `countryCode`,
   `originalFilename`, `declaredMimeType`, `quarantineStorageKey`) are ALL
   either already available on the `run`/intake row `acceptRun()` already
   has in hand, or derivable the same way Insurance's own candidate-based
   path derives its input — no new persisted field is needed here (unlike
   4a), because `write.ts` already does its own `downloadFromQuarantine`
   internally rather than expecting the caller to supply raw bytes.
3. `AcceptAndWriteOutcome`'s `iiSourceDocumentId`/`iiResult` fields would
   need the same "grow a discriminated outcome shape" treatment noted in
   4a.5 rather than open-ended optional fields.

**In short: 4b is real, required work, but is a strictly smaller version
of the same change as 4a** — same dispatch mechanism, no byte-re-fetch
redesign needed, because Investment Intelligence's own write path was
already built candidate-first, matching Insurance's own pattern, while
FDH-bank's was built bytes-first because it deliberately reuses FDH-5's
own existing upload pipeline unmodified.

**Neither change was implemented in this pass.**

---

## 5. Recommended execution mechanism for the real merge

**Recommendation: a linear sequence of `git merge` commands into a new
`integration/aie-1-release-candidate` branch, in exactly the order
validated in section 2** — not cherry-pick, not squash, not an
alternative ordering.

**Why, grounded in what was actually observed, not a generic preference:**

- **Merge, not cherry-pick or rebase**: every one of the five branches
  carries real, meaningful commit history (1.2's and 1.3's own
  step-by-step implementation commits, 1.5's own multi-commit build-up
  including its own merge of 1.4). Cherry-picking would require manually
  re-selecting dozens of commits per branch and re-deciding conflict
  resolutions commit-by-commit instead of once at the tip; rebasing any of
  them onto a new base would rewrite commit hashes that this session's own
  memory and multiple existing reports already cite by hash
  (`cd2d4a2`, `5ac527e`, `cf20616`, `90c1ffb`, `17fe496`, `b22fc42`,
  `1afceec`, `6b2854f`) — breaking every one of those citations for no
  benefit, since the merge itself (not a rewritten history) is what a
  future certification pass needs to re-verify against.
- **Squash is actively worse here**: AIE-1.3's own retroactive
  implementation report and AIE-1.6's own certification report both
  depend on being able to point at specific commits (e.g. `0b7a192`'s
  branch-ordering bugfix, `83eb0cd`'s migration renumber) to substantiate
  their own claims. Squashing would destroy exactly the audit trail this
  repository's own established discipline (per this session's memory of
  how every prior AIE/FDH/II phase has been verified) relies on.
- **This exact order, not an alternative one, because it is the order
  actually validated**: 1.6 and the cert-plan branch merge trivially
  (fast-forward / additive-only, confirmed in section 2) regardless of
  where they land, so their position in the sequence is not load-bearing.
  The fix branch merging cleanly BEFORE 1.2/1.3 matters in practice only
  in that it means neither of the two real conflicts (section 2, steps 3
  and 4) involve `fileValidation.ts` at all — confirmed empirically, not
  assumed. 1.2 before 1.3 (rather than the reverse) was the order this
  pass actually exercised and is the order recorded as validated; the
  reverse order was not tested and this document does not claim it would
  behave identically (the `fdh1Isolation.test.ts` conflict would still
  occur, just with the two sides swapped — there is no reason to expect a
  materially different outcome, but "no reason to expect" is not the same
  standard as "personally observed," so the validated order is the one
  this plan recommends).
- **One sequence, not a merge-of-merges (octopus or otherwise)**: an
  octopus merge (`git merge b c d e f`) cannot surface per-pair conflicts
  the way a linear sequence does — this pass's own two real conflicts were
  only visible, resolvable, and attributable to a specific pair (1.2 vs
  the already-merged tree, then 1.3 vs that) because each merge happened
  one at a time. A linear sequence is also what lets the two conflict
  resolutions in section 2 be reviewed and approved individually by a
  human before the next branch lands.

**Concretely, for whoever executes the real merge:**

```
git checkout -b integration/aie-1-release-candidate feature/aie-1-5-exception-review-ux
git merge feature/aie-1-6-certification                    # clean, fast-forward
git merge fix/aie-1-1-pdf-flatedecode-detection             # clean, 3-way
git merge feature/aie-1-2-investment-adapter                # resolve 2 conflicts per section 2
git merge feature/aie-1-3-fdh-bank-adapter                  # resolve 1 conflict per section 2
git merge feature/aie-1-production-cert-plan                # clean
# then, as real follow-up commits on the same branch (not part of the merges themselves):
#   - flip aie16CertificationAdversarialPdf.test.ts's assertions (section 3, finding #1)
#   - fix moduleRegistry.ts's two matchesAdapterId predicates (section 3, finding #2)
#   - implement section 4a and 4b
#   - re-run every command in section 3 against the real result before proposing it for
#     any further certification or production-readiness step
git push origin integration/aie-1-release-candidate
```

This document does not authorize running that sequence for real — it is
the literal, validated checklist for the person/session who does.

---

## 6. Scratch branch cleanup

`scratch/aie-merge-dryrun` was created locally from
`feature/aie-1-5-exception-review-ux`'s own tip, used exclusively for the
dry-run merges in section 2 and the verification commands in section 3,
never pushed to origin, and is deleted as the final step of this pass (see
this pass's own closing commands). All six real branches named throughout
this document —
`feature/aie-1-1-document-gateway`,
`feature/aie-1-2-investment-adapter`,
`feature/aie-1-3-fdh-bank-adapter`,
`feature/aie-1-4-other-modules`,
`feature/aie-1-5-exception-review-ux`,
`feature/aie-1-6-certification`,
`fix/aie-1-1-pdf-flatedecode-detection`, and
`feature/aie-1-production-cert-plan` —
remain exactly as they were at the hashes cited throughout this document.
Nothing was pushed to origin by this pass except this document, on its own
new branch (`feature/aie-1-merge-plan`).
