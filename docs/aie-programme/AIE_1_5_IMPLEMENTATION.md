# AIE-1.5 — User Exception Review and Acceptance Integration

**Status: IMPLEMENTED and TESTED on a feature branch, NOT certified, NOT
merged, NOT deployed.** This report describes what was built in this pass.
It is not a certification — AIE-1.5's own source document requires
independent verification and traceability across all 346 numbered
requirements for a FULL PASS, and real certification of the whole AIE-1
platform is explicitly AIE-1.6's job, not this one. Nothing here should be
read as "AIE-1.5 complete" — see "What remains" below.

Branch: `feature/aie-1-5-exception-review-ux` (off
`feature/aie-1-1-document-gateway` at `cd2d4a2`, per this phase's own entry
conditions), with `feature/aie-1-4-other-modules` merged in for real
integration testing (see section 1).

## 1. Repository/branch/migration baseline (execution sequence step 1)

Confirmed by fetching all relevant refs directly, not guesswork:

| Ref | Highest/claimed migration |
|---|---|
| `origin/main` | 0137 |
| `feature/aie-1-1-document-gateway` (this branch's base) | 0140 |
| `feature/lr-1-upload-security-lifecycle` (separate, unmerged) | 0139 (`0138`/`0139`) |
| `feature/aie-1-2-investment-adapter` (separate, unmerged) | 0141 |
| `feature/aie-1-3-fdh-bank-adapter` (separate, unmerged) | 0142 |
| `feature/aie-1-4-other-modules` (merged into THIS branch) | 0143 |

This pass's own migration is numbered **0144** — verified collision-free
with both `scripts/check-migration-versions.mjs` (135 active migrations,
next version 0145) and `scripts/check-migration-versions-against-branch.mjs`
run against `origin/main`, `feature/lr-1-upload-security-lifecycle`,
`feature/aie-1-2-investment-adapter` and `feature/aie-1-3-fdh-bank-adapter`
in turn — all four report "OK: no cross-branch migration collisions".

**The adapter-branch decision.** The assignment's own instructions
recommended merging exactly ONE adapter branch for real integration
testing, naming Insurance as the likely simplest choice. This pass merged
`feature/aie-1-4-other-modules` (the Insurance adapter) — a clean merge
with zero conflicts, since that branch's two commits sit directly on this
branch's own base commit (`cd2d4a2`). **Investment Intelligence
(`feature/aie-1-2-investment-adapter`) and FDH bank
(`feature/aie-1-3-fdh-bank-adapter`) were NOT merged and their code was
never executed by this pass.** Everything this report says about those two
adapters' reason codes/contracts is transcribed from reading their source
on their own unmerged branches (`git show <branch>:<path>`), not from
running their code — see section 4's `integrationTested` flag, which is
`false` for both and `true` only for Insurance.

## 2. Verifying AIE-1.1's real contract (execution sequence step 2)

Read the actual code, not just `AIE_1_1_IMPLEMENTATION.md`'s prose:
`lib/aie/types.ts` (the closed `AieRunStatus`/`AieUnresolvedItemStatus`/
`AieReconciliationOutcome` unions — no `confidence` field exists anywhere,
by construction, P4), `lib/aie/stateMachine.ts` (`AIE_RUN_TRANSITIONS`,
`AIE_INTAKE_TRANSITIONS` — the exact legal-transition tables every AIE-1.5
transition below is checked against), `lib/aie/reconciliation/types.ts`
(`blockingItemsForReconciliation`'s reason-code format,
`reconciliation_<outcome>:<ruleId>`, and `worstOutcome`'s outcome
ordering), and `lib/aie/db/repository.ts`'s pre-existing
`recordReviewDecision` (already version-checked, already idempotent via a
unique `idempotency_key` on `aie_review_decision` — AIE-1.1 built the
concurrency-safe decision-recording primitive a phase early, and this pass
reuses it exactly rather than rebuilding it).

## 3. Existing exception/correction surface inventory (execution sequence step 2)

Searched the actual codebase (not assumed) for prior "review before
saving" patterns:

- **`components/investment-intelligence/ReviewCentreClient.tsx`** — an
  acknowledge/dismiss QUEUE (severity-grouped cards, two bookkeeping-only
  actions, explicitly NOT a resolution). Different shape from what
  AIE-1.5 needs (correction + acceptance, not acknowledgment), so its
  interaction pattern was not reused directly, but its "group by severity,
  filter by status, deep-link to the source document" information
  architecture informed `ReviewInbox.tsx`'s own status-chip design.
- **`app/(app)/financial-data-hub/review/ReviewWorkspace.tsx`** (FDH-7/8) —
  the closest real analogue: a full approve/correct/reject workspace with
  typed corrections posting to dedicated API routes, reusing
  `components/resources/admin/ResourceStates.tsx`'s loading/empty/error
  primitives, and a `cancelled`-flag IIFE pattern for its data-loading
  effects (to satisfy this repo's `react-hooks/set-state-in-effect` lint
  rule). AIE-1.5's `RunReviewPanel.tsx`/`ReviewInbox.tsx` reuse the SAME
  `ResourceStates.tsx` primitives and the SAME cancelled-flag effect
  pattern (found and matched exactly after this rule flagged a first,
  wrong attempt — see section 10's honest disclosure).
- **`components/ui/ConfirmDialog.tsx`** — this repo's one existing,
  genuinely reusable, already-accessible confirm/cancel modal (focus trap,
  Escape-to-cancel, focus restore on close, `min-h-11` touch targets).
  Reused verbatim for both the Accept and Reject confirmations — no new
  modal/dialog primitive was built.
- **No component named `ReviewPanel`, `ExceptionReview`, `ManualMapping`,
  `ReviewQueue` or `CorrectionModal` exists anywhere in this repository.**
  `UnresolvedItems` exists only as API/repository plumbing
  (`app/api/aie/unresolved-items/route.ts`), never a UI component —
  confirming AIE-1.5 is building the first real exception-review UI in
  this codebase, not duplicating one.
- **Accessibility precedent** — `docs/financial-data-hub/FDH8_ACCESSIBILITY_CERTIFICATION.md`
  and `docs/live-recovery/LR2_ACCESSIBILITY_CLOSURE.md` establish this
  repo's bar: real `<label htmlFor>` pairing (never ARIA-only labelling
  where a real label works), real button text (never icon-only), no
  `tabIndex`/`onKeyDown` hijacking, no clickable non-interactive elements,
  `focus-visible:ring-2` over bare `outline-none`. **No automated
  accessibility tool is configured anywhere in this repository** (no
  `jest-axe`, no `eslint-plugin-jsx-a11y`, no jsdom/`@testing-library` test
  environment — `vitest.config.ts` is `environment: 'node'` only). AIE-1.5
  follows the SAME documented-manual-certification convention rather than
  inventing tooling this repo has never used — see section 10.

## 4. Frozen contract: states, items, actions, transitions (execution sequence step 4)

**User-facing states** (`lib/aie/review/userState.ts`, section 35's own
table): `processing`, `ready_to_accept`, `needs_your_review`,
`unable_to_process_safely`, `accepted_importing`, `import_failed`,
`completed`. Computed by `computeUserFacingState()`, an exhaustive switch
over every real `AieRunStatus` value (a `never`-typed default branch fails
to compile if `lib/aie/types.ts` ever adds a status this function doesn't
handle — the same discipline `stateMachine.ts` already applies to its own
transition table). Deliberately reports `processing` rather than a false
`ready_to_accept`/`needs_your_review` when a blocking-item count looks
inconsistent with the run status (TRI-11).

**Item contract** (`AieReviewItemView`, `lib/aie/review/types.ts`): id,
reasonCode, status, severity, itemVersion, displayCandidate, evidenceRef,
and a resolved `AieReasonCodeMeta` (humanQuestion, explanation, severity,
allowedActions, correctableFields) — all derived from the REAL
`aie_unresolved_item` row plus a reason-code registry lookup, never a
second table.

**Permitted actions**: `accept` (run-level, gated — section 6),
`correct` (item-level, typed and field-allowlisted), `not_present`
(item-level assertion), `defer` (item-level, does not resolve, still
blocks acceptance), `reject_document` / `request_reprocessing`
(document-level). **Disclosed deviation from AIE-1.1's own schema**:
AIE-1.1 core's `blockingItemsForReconciliation` hard-codes every blocking
item's `permitted_action_types` column to
`['request_reprocessing', 'reject_document']` — it has no concept of a
per-field correction, because AIE-1.1 ships no domain adapter of its own.
AIE-1.5's reason-code registry (`lib/aie/review/reasonCodes.ts` +
`moduleRegistry.ts`) is the authoritative source for which of the five
actions above a SPECIFIC reason code actually permits — this NARROWS or
ENRICHES what the UI offers, it never widens what the database allows
(every actual status mutation still goes through the identical
version-checked `recordReviewDecision`). This is disclosed here rather
than silently reinterpreted.

**Server-side transitions**: every one goes through
`lib/aie/stateMachine.ts`'s real `assertRunTransition`/
`assertIntakeTransition` (via `transitionRunStatusCas`, a new
compare-and-swap wrapper) or `recordReviewDecision`'s existing
version-checked item update. No new transition table exists.

## 5. Reason-code / module registry (execution sequence steps 3-4, "design generically")

`lib/aie/review/reasonCodes.ts` + `moduleRegistry.ts` implement ONE
registry keyed by adapter id (resolved from the run's own recorded
`aie_parser_attempt.adapter_id` — the real fact of which parser claimed the
document, never re-derived from `source_module_hint`, which AIE-1.1's own
docs are explicit is caller metadata, not an authority). Three module
descriptors exist:

| Module | `integrationTested` | Source of its reason codes |
|---|---|---|
| Insurance | **true** | `buildInsuranceReconciliationRule`'s actual 5 rule ids, read from the merged-in `lib/aie/adapters/insurance/reconciliation.ts` |
| Investment Intelligence | **false** | Transcribed from `feature/aie-1-2-investment-adapter`'s `reconciliationRule.ts`/`unresolvedItems.ts` via `git show` — never executed |
| FDH bank statement | **false** | Transcribed from `feature/aie-1-3-fdh-bank-adapter`'s `reconciliation.ts` via `git show` — never executed |

A genuinely unrecognised reason code (for any module, including
Insurance) falls back to `GENERIC_FALLBACK_REASON_META` — blocking, no
correction offered, reject/reprocess/defer only — rather than crashing or
inventing a plausible-looking action for a rule this pass has no real
information about (ACT-09's conservative default).

This satisfies the assignment's "design the review UI's contract
generically enough that the other two adapters could plug in without
changing the UI's core" instruction: the UI component
(`RunReviewPanel.tsx`) renders purely off `AieReasonCodeMeta` and
`AieReviewItemView` — it has no Insurance-specific branch anywhere. Wiring
in Investment Intelligence or FDH for real would mean (a) merging that
adapter branch, (b) flipping its descriptor's `integrationTested` to
`true` and correcting any drift found by then, and (c) adding one branch
to `lib/aie/review/revalidate.ts`'s `resolveReconciliationRuleForAdapter`
and `lib/aie/review/accept.ts`'s write-service call — no change to the API
routes, the reason-code matching logic, or any component.

## 6. Canonical-write gate (execution sequence step 9)

`lib/aie/review/accept.ts`'s `acceptRun()` — see the commit history for
the exact gate order. The single most safety-critical property this phase
must hold: **a `fail`, `indeterminate`, or `not_applicable` reconciliation
outcome structurally cannot reach a write**, proven by 17 unit tests with
fully injected dependencies (`tests/unit/aieReviewAccept.test.ts`),
including the deliberate decision to treat `not_applicable` as a refusal
too (accepting a document nothing ever actually reconciled would itself be
a silent gap). Only `acceptAndWriteInsuranceCandidates` (AIE-1.4's own
gated write, unchanged) is ever called — no direct table write exists
anywhere in AIE-1.5.

**Insurance's self-accept placeholder was removed.**
`app/api/aie/insurance/intake/route.ts` used to call
`acceptAndWriteInsuranceCandidates` itself the moment extraction reached
`awaiting_acceptance`, with a code comment explicitly calling this "a
disclosed placeholder for 'required user acceptance' [because] there is no
review/acceptance UI yet — explicitly AIE-1.5's job." That placeholder is
now gone; the route stops at reporting the extraction outcome, and the
real acceptance path (`POST /api/aie/review/runs/{runId}/accept`) is the
only way a write can happen.

## 7. Dependency-aware revalidation (execution sequence step 6)

`lib/aie/review/revalidate.ts`'s `revalidateRun()` re-runs the SAME real
`ReconciliationRule` a document's own adapter uses, against the original
candidates merged with the latest accepted corrections
(`candidateMerge.ts` — the original `aie_field_candidate` rows are never
mutated, VALID-12). Items whose rule no longer fails are resolved by a
system-actor decision through the identical version-checked
`aie_review_decision` path a human decision uses; items whose rule changed
OUTCOME (not just disappeared) are superseded with an explicit
`evidence_ref.supersedesItemId` lineage pointer (DEP-11) rather than
silently mutated in place; a correction-introduced NEW conflict gets a
fresh item (VALID-11).

**A real safety gap was found and fixed during this pass, not shipped.**
The first version of `resolveReconciliationRuleForAdapter` fell back to
AIE-1.1 core's own `noDomainAdapterReconciliationRule` for any adapter this
pass has no real reconciliation code for (Investment Intelligence, FDH
bank). That rule always reports `not_applicable`, which
`blockingItemsForReconciliation` never turns into a blocking item — so a
correction submitted against an Investment Intelligence or FDH item would
have silently produced ZERO blocking items and wrongly moved the run to
`awaiting_acceptance`, without ever genuinely re-checking the condition
that created the item. Fixed: the function now returns `null` for any
adapter this pass cannot actually reconcile, and `revalidateRun` treats
`null` as "refuse and round-trip the run status" rather than guessing —
covered by a dedicated test
(`tests/unit/aieReviewRevalidate.test.ts`, "SAFETY: never resolves an item
for an adapter it cannot reconcile").

## 8. Evidence viewer / masking / reveal (execution sequence step 6)

`lib/aie/review/reveal.ts` operates on AIE-1.1 core's own reversible
mask-token-map (`aie_mask_token_map` + `tokenMapCrypto.ts`) — genuinely
adapter-agnostic, since masking happens once in the shared orchestrator
before any AI-fallback payload is built. Ownership-checked, one token per
call, audited via a new `evidence_revealed` audit event whose metadata
carries the opaque token, never the plaintext value (proven by a test that
asserts the plaintext string is absent from the serialized audit event).

**Honest limitation, disclosed rather than hidden**: not every
masked-looking value is revealable this way. Insurance's own
`maskPolicyNumber` (parser.ts) discards everything but the last four
digits at PARSE TIME — irreversibly, by design, since that field has no
canonical column and exists for display/audit only. `EvidenceValue`
(the frontend component) only renders a Reveal control for a value that
actually matches the reversible `[MASKED:<type>:<salt>:<n>]` token shape;
anything else displays as-is with no false promise.

## 9. What was built — file inventory

- **Migration** `supabase/migrations/0144_aie1_5_review_decision_correction_columns.sql`
  — three additive nullable columns on `aie_review_decision`
  (`correction_field_name`, `correction_value_raw`,
  `correction_value_normalized`). No new table. **HELD LOCALLY. Not
  applied to any DEV or production database.**
- **`lib/aie/review/`** (12 files) — types, userState, reasonCodes,
  moduleRegistry, validation, candidateMerge, projection, revalidate,
  decide, accept, reject, reveal, featureFlags, ariaLabels.
- **`lib/aie/db/repository.ts`** — 13 new functions, additive only
  (existing exports unchanged).
- **`lib/aie/audit.ts`** — one new audit event type (`evidence_revealed`),
  additive to a closed union.
- **`lib/aie/adapters/insurance/reconciliation.ts` / `index.ts`** — one
  named export extracted (`INSURANCE_REQUIRED_FIELDS`), no behaviour
  change.
- **`app/api/aie/review/`** — 6 routes (inbox, run detail, item decide,
  accept, reject, reveal).
- **`app/api/aie/insurance/intake/route.ts`** — self-accept removed (see
  section 6).
- **`app/(app)/aie-review/`** — 2 pages (inbox, run detail).
- **`components/aie/review/`** — 4 components (ReviewInbox,
  RunReviewPanel, CorrectionForm, EvidenceReveal).
- **`proxy.ts`** — `aie-review` added to the `isAppRoute` regex (a real
  regression this pass's own test run caught before it reached a commit —
  see section 10).
- **10 new test files, 138 tests** — see the test commit's own message for
  the full per-file breakdown.

**Feature flags, all default OFF** (`lib/aie/review/featureFlags.ts`):
`AIE_REVIEW_UI_ENABLED` (gates the read routes), `AIE_REVIEW_EVIDENCE_REVEAL_ENABLED`
(gates reveal, separately from read access — a materially higher-risk
action), `AIE_REVIEW_CANONICAL_ACCEPTANCE_ENABLED` (gates `acceptRun`,
additive to and independent of Insurance's own
`AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED` — both must be `true` for
a real write). `AIE_REVIEW_BULK_ACTIONS_ENABLED` and
`AIE_REVIEW_PC5_PROJECTION_ENABLED` are reserved per AIE15-ENTRY-10's own
instruction but gate nothing yet, since neither feature is built this pass
(section 11).

## 10. Two real regressions found and fixed this pass

1. **`react-hooks/set-state-in-effect` (eslint)** — the first draft of both
   `ReviewInbox.tsx` and `RunReviewPanel.tsx` called a `useCallback`d load
   function directly from a `useEffect` body. `eslint` flagged both;
   fixed by matching `ReviewWorkspace.tsx`'s own established
   cancelled-flag-IIFE convention exactly (every `setState` call lives
   INSIDE the IIFE, not before it — a subtlety the first attempt at the
   fix still got wrong once before landing correctly).
2. **`proxy.ts`'s `isAppRoute` regex / the page-folder capability
   manifest** — adding `app/(app)/aie-review/` without updating either
   `proxy.ts`'s route regex or
   `tests/unit/appCapabilityManifest.test.ts`'s `PAGE_FOLDER_INFRA_ALLOWLIST`
   caused two existing regression-guard tests
   (`countryGateAccessMatrix.test.ts` MC-17,
   `g3RegistrationAlignment.test.ts`, `appCapabilityManifest.test.ts`) to
   fail. Both fixed; the full suite was re-run afterward and confirmed
   back at the exact pre-existing baseline (6500 passed / 18 skipped / 18
   failed, same failing tests by name as AIE-1.1/AIE-1.4's own disclosed
   baseline).

## 11. Honest limitations / deferred work

- **Investment Intelligence and FDH bank are design-compatible-only, NOT
  integration-tested.** Their reason-code entries, module descriptors, and
  `resolveReconciliationRuleForAdapter`'s `null` fallback are real,
  defensible, unit-tested-for-safety code — but no run through either
  adapter's actual parser/reconciliation/write path was ever executed by
  this pass, because neither branch was merged. `revalidateRun` and
  `acceptRun` both structurally REFUSE (rather than fabricate a result)
  for either adapter today, until a future pass merges the real branch and
  wires in its write service.
- **No PC5 integration** (section 18 of the spec, AIE15-PC5-01..12). No
  PC5 code, table, or route was found or touched by this pass — the spec's
  own instruction that PC5 must consume AIE's items rather than introduce
  a parallel lifecycle is honoured by NOT building a competing surface,
  but the actual "governed AIE query/view for PC5" integration itself is
  not built. `AIE_REVIEW_PC5_PROJECTION_ENABLED` is reserved, not wired.
- **No bulk review actions** (section 17, AIE15-BULK-01..12).
  `AIE_REVIEW_BULK_ACTIONS_ENABLED` is reserved, not wired. Every action
  in this pass is single-item/single-run.
- **No amendment/undo flow** (section 22, AIE15-AMEND-01..12). A completed
  run's canonical write is final in this pass — no post-acceptance
  correction path exists yet.
- **No support/dispute flow** (section 23) and **no notifications**
  (section 24) — neither was built.
- **No live-DEV verification.** Every test in this pass runs with fully
  injected/faked persistence — no real Supabase database was reached (no
  DEV credentials or authority in this environment, matching every prior
  AIE phase's own disclosed constraint). The migration is held locally,
  unapplied.
- **No WCAG 2.2 AA automated certification.** This repository has no
  accessibility testing tool configured at all (confirmed by
  discovery — no `jest-axe`, no `eslint-plugin-jsx-a11y`, no jsdom test
  environment). AIE-1.5's components follow the SAME conventions this
  repo's own prior manual accessibility certifications document (real
  labels, real button text, keyboard-native elements only,
  `focus-visible` rings, a live region for status changes, a reused
  accessible confirm dialog) and one pure-function accessibility
  assertion suite (`ariaLabels.ts` + its tests) proves the label/
  announcement LOGIC is correct — but no rendered-DOM, screen-reader, or
  manual keyboard-journey certification was performed. This is reported as
  genuinely unverified, not claimed as passed.
- **No mobile-device testing.** Tailwind responsive classes and `min-h-11`
  touch targets are used throughout, matching this repo's own convention,
  but no actual mobile viewport/device testing occurred.
- **No navigation-menu link** into `/aie-review` from the main app shell —
  reachable today only by direct URL. A deliberate scope cut given the
  size of the rest of this pass, not an oversight.
- **`next build` was not run** — this worktree's pre-existing
  `node_modules` symlink limitation (documented in
  `AIE_1_1_IMPLEMENTATION.md`) is unchanged by this branch; `tsc`/`eslint`/
  `vitest` all resolve modules correctly and were run.
- **AIE-1.6 owns real certification, GO/CONDITIONAL GO/NO-GO recommendation,
  and independent traceability across all 346 AIE-1.5 requirements** —
  this report is not that, and does not claim to be.

## 12. Non-negotiable prohibitions — self-check (not a certification)

| Prohibition | Where enforced |
|---|---|
| No accept-anyway for material failed/indeterminate reconciliation | `accept.ts` refuses on `fail`/`indeterminate`/`not_applicable` before any transition; 17 tests including both explicit negative cases |
| No direct client mutation of status/canonical fields | Every mutation goes through `recordReviewDecision`/`transitionRunStatusCas`, both server-only; no route accepts a raw status value |
| No second exception table/state machine/queue | Migration 0144 only ADDS COLUMNS to the existing `aie_review_decision`; zero new tables |
| No raw PII in URLs/analytics/logs/errors/notifications | Reveal is POST-only (token never in a URL); audit metadata for reveal carries the token, never the value (tested); reject's audit metadata carries "provided"/"none", never the raw rationale (tested) |
| No arbitrary field/value mass assignment | `decide.ts` validates `fieldName` against the reason code's OWN `correctableFields` allowlist before any DB write; 3 dedicated tests including a `__proto__` probe |
| No stale decision silently overwriting a newer result | Item decisions reuse AIE-1.1's `item_version` check; run transitions use a new CAS wrapper; both tested against a lost race |
| No partial/duplicate canonical write on retry | `findOrCreateWriteBatch`'s unique `idempotency_key` + the adapter's own unique `aie_run_id` link both checked before any write; idempotent-replay tested at both levels |
| No PC6 presented as document-extracted value | Zero imports of any PC6/pricing/NAV/benchmark module anywhere in `lib/aie/review/**` |
| No production activation without separate authority | Migration held locally; every new feature flag defaults OFF |

## 13. What this means for AIE-1.6

AIE-1.6's independent certification pass inherits: a real, tested
review/acceptance contract wired end-to-end against one adapter
(Insurance), a generic reason-code/module-registry extension point with
two more adapters' contracts already transcribed (but unexecuted) for it,
and an honest, itemized list of what remains unbuilt (PC5, bulk actions,
amendments, notifications, live-DEV proof, accessibility certification).
None of AIE-1.6's own exit criteria are asserted met by this report.
