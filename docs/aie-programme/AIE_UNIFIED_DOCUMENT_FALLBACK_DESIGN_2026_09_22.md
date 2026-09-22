# Unified AI-Fallback Design for Every Document Upload (2026-09-22)

**Status:** Design + first real increment (payslip). Branch
`feature/aie-payslip-ai-fallback-2026-09-22` off `origin/main` (`f0c0895`).
Nothing merged, nothing applied to any shared environment. This document is
Phase 1 of a two-phase mission; Phase 2 (payslip AI-fallback, built) is
summarised in section 9.

## 0. The instruction this document answers

The Product Owner's instruction: every PDF upload — current and future —
must follow the *same* AI-fallback path when native/rules-based parsing
can't read or reconcile a document. Today that isn't true, and the
inconsistency is the problem. This document says what "the same path" should
concretely mean, based on evidence read from the actual code (not the
architecture the AIE programme's own planning documents describe), and
implements it for one document type as proof.

---

## 1. What actually exists today (evidence, not assumption)

Two independent research passes (full-file reads, not sampling) confirmed
and corrected the discovery brief this mission started from. Citations are
`file:line` against this branch's tree.

### 1.1 The AIE-1 core (`lib/aie/`)

- `orchestrator.ts` (`runExtractionPipeline`, 125-395): deterministic
  parse → mask → gated AI fallback → schema validation → reconciliation →
  `awaiting_acceptance`/`unresolved`. Every side effect injected
  (`AieOrchestratorDeps`), fully unit-testable.
- `provider/gateway.ts` (`AieDocumentAiGateway`): the ONE place any AI
  provider is ever called from. Kill switch (`AIE_AI_FALLBACK_ENABLED`),
  PII re-scan, in-flight idempotency collapse, cost admission
  (reserve/settle), typed outcomes. `provider/openaiAieProvider.ts` makes the
  real `gpt-4o-mini` call (model configurable via `AIE_AI_MODEL`), reading
  `AIE_OPENAI_API_KEY` (a key deliberately separate from Module 11's own).
- `provider/openaiJsonSchema.ts`: **a hand-written, closed map from
  `schemaName@version` to the strict-mode JSON Schema actually sent to
  OpenAI.** This is not auto-derived from the Zod schema in
  `schema/schemaRegistry.ts` — a schema not added here throws, and the
  gateway maps that throw to `outcome: 'provider_error'`. **This turned out
  to matter a great deal — see section 6.1.**
- `db/repository.ts` persists to `aie_document_intake`,
  `aie_extraction_run`, `aie_processing_transition`, `aie_parser_attempt`,
  `aie_masking_summary`, `aie_ai_completion_attempt`,
  `aie_schema_validation_result`, `aie_field_candidate`,
  `aie_reconciliation_run`, `aie_unresolved_item`, `aie_review_decision`,
  `aie_write_batch`, `aie_audit_event`, plus per-adapter link tables
  (`aie_insurance_adapter_link`, `aie_ii_adapter_link`).
- `review/accept.ts` (`acceptRun`): the one canonical-acceptance gate for
  the three adapters that use this pipeline. Dispatches to exactly one
  domain write service by the run's own recorded `adapter_id` — **a
  hardcoded if/else chain, not a registry** (see section 6.2).
- `malware/` is real (S3 quarantine + a GuardDuty-style scan gate,
  `AIE_REAL_MALWARE_SCAN_ENABLED`), shared with FDH-3's own upload path as of
  yesterday's fix — see section 5.

### 1.2 The three existing adapters (`lib/aie/adapters/*`)

`fdhBankStatement/`, `insurance/`, `investment-intelligence/` (the AIE-1.2
adapter, distinct from the older II mechanism below) all follow the same
shape: a `RegisteredParser` (or a request-scoped override), a Zod schema
registered against `aieSchemaRegistry`, an adapter-owned
`ReconciliationRule`, a domain write service dispatched from `accept.ts`, and
their own `AIE_<NAME>_ADAPTER_ENABLED` / `AIE_<NAME>_ADAPTER_CANONICAL_WRITE_ENABLED`
flag pair, both default OFF.

**The finding that reshapes this whole design: none of the three has a
working frontend entry point.** A repo-wide grep for every intake route
(`aie/fdh-bank/intake`, `aie/insurance/intake`,
`aie/investment-intelligence/intake`) outside `app/api/**` returns nothing
except one stale comment in the review UI. The only real frontend AIE
surface anywhere in this codebase is the generic review inbox
(`app/(app)/aie-review/**`), which can only act on runs that already exist —
there is no page that creates one. **The orchestrator/intake/accept pipeline
is architecturally complete and individually well-tested, but it has never
once been exercised by an actual user upload, for any of its three
adapters, in this repository's history.**

### 1.3 The Investment Intelligence duplication

Two mechanisms exist for II documents:

| | Mechanism A (old) | Mechanism B (AIE-1.2 adapter) |
|---|---|---|
| Entry point | `POST /api/investment-intelligence/source-documents` | `POST /api/aie/investment-intelligence/intake` |
| Called from live UI? | **Yes** — `components/investment-intelligence/InvestmentIntelligenceClient.tsx` | **No** — zero callers outside tests/scripts |
| AI trigger | Two failure points inside `documentProcessing.ts::processSourceDocument()` (`format_unrecognized`, `parse_failed`), `lib/services/investment-intelligence/aiFallbackDocumentExtraction.ts` | `lib/aie/adapters/investment-intelligence/dispatch.ts`, the full orchestrator |
| AI provider | The SAME `AieDocumentAiGateway` + `createAieAiProvider()` — not a second AI call | Same gateway, via the orchestrator |
| Write on success | Auto-applies via `applyAiExtractionReview()` (PO instruction, 2026-09-20) — the exact accept-click write path | `accept.ts` → `acceptAndWriteInvestmentCandidates` → re-inserts an `ii_source_documents` row and re-runs `processSourceDocument()` **from scratch** |
| Own kill switch | `II_AI_FALLBACK_ENABLED` (+ its own pilot cohort, `II_AI_FALLBACK_PILOT_COHORT_*`) | `AIE_II_ADAPTER_ENABLED` / `AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED` |

**Verdict: not two competing implementations and not dead code — mechanism B
is a genuine, more sophisticated *intended successor* that has never been
finished being wired up, while mechanism A is the one live users actually
depend on today** (made "fully automatic" only two days before this dispatch
started). A latent defect makes this more than a tidiness question:
mechanism B's `write.ts` calls `processSourceDocument()` again on accept —
the exact function containing mechanism A's own AI-fallback trigger points.
If `AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED` were ever turned on, a document
that had already gone through the orchestrator's own AI fallback could be
**re-parsed and independently AI-fallback'd a second time** by the "old"
path, double-charging the OpenAI cost ledger for one document.

**Recommendation:** keep mechanism A as the reference shape (see section 2 —
its shape is now this whole document's recommended pattern), and either (a)
retire mechanism B's dispatch/write path given it has no callers and no
near-term activation plan, or (b) if the PC5/orchestrator machinery is
wanted long-term, fix `write.ts` to stop re-invoking
`processSourceDocument()` before ever enabling its write flag. This
dispatch does not action (a)/(b) — it is an II-scoped decision, out of this
dispatch's payslip-scoped authority — but it must not be left unrecorded.

### 1.4 FDH-3/FDH-9's five document types

Payslip, bank-statement, investment-statement, liability-statement,
retirement-statement each have their own processing service
(`lib/financial-data-hub/services/*ProcessingService.ts`) and upload panel.
**None of the five has any AI-fallback path today** — confirmed by grep for
`openai|gpt|AIE|aie|fallback` in all five services: zero real matches.
Every one fails to the identical "we couldn't read this, add it manually"
dead end. Payslip and bank-statement are two-call flows (upload-session then
a separate `/process` call); the other three are single-call
upload+process. All five now sit behind the real malware-scan gate as of
`fix/fdh3-async-malware-scan-race-2026-09-21` (unmerged) fixing an async race
in that gate — this dispatch does not depend on that fix, because with the
shared kill switch off (`AIE_REAL_MALWARE_SCAN_ENABLED`, the shipped
default) the gate is a no-op either way, and because
`processPayslipDocument()`'s own re-entry guard (`processing_status` must
already be `queued`/`failed`) means it can only ever run once the scan gate
has already resolved.

---

## 2. The pattern chosen, and why

**Every existing AI-fallback mechanism that is actually reachable from a
live upload — there is exactly one, Investment Intelligence's mechanism A —
shares one shape: call the shared `AieDocumentAiGateway` directly from
inside the native processing service's own failure branch, using the
adapter's own schema, gated by its own kill switch plus the shared global
one plus a pilot-cohort allowlist. Every mechanism that instead uses the
fuller intake/orchestrator/accept pipeline has zero live callers, in three
independent instances.** That is not a coincidence to route around; it is
the strongest evidence available in this codebase for which shape actually
ships. Extending the *heavier* pattern with a fourth adapter, when the
existing three have never once been connected to a real button, would
repeat the exact thing this whole mission was dispatched to fix (documented
capability, no live path) rather than fix it.

**Chosen answer to the design question the mission brief poses** (native
routes call into the shared pipeline as an in-request fallback step, vs. a
bigger move to the separate review-based intake+accept model): **native
routes call into the shared core as an in-request fallback step** —
mechanism A's shape, generalised.

This does **not** mean skipping the "then ask you to review" half of the
PO's own stated goal. It means implementing it where it is actually cheap
and correct to implement — as an explicit confirm step inside the SAME
upload panel and the SAME request/response cycle the user is already in —
rather than redirecting into a separate, currently-empty review UI that was
built for a different flow shape (accept/reject a background-processed run
you didn't just watch happen) and has never shipped an intake side to feed
it.

### 2.1 What "the same path" concretely means for a document type

1. **A schema**, registered in `lib/aie/schema/schemaRegistry.ts`
   (Zod, matching this codebase's own established "no ajv" decision), naming
   exactly the fields the AI may report, each nullable with a closed
   `missingReasonCode` enum — never a plausible guess in place of "I
   couldn't read this." Money as decimal strings, dates as ISO strings.
2. **A hand-written OpenAI strict-JSON-Schema mirror**, registered in
   `lib/aie/provider/openaiJsonSchema.ts`'s `KNOWN_SCHEMAS` map. **This step
   is easy to forget and, per section 6.1, has already been forgotten once
   for a live mechanism** — the JSON Schema is not derived from the Zod
   schema automatically.
3. **A mapping function** from the AI's response shape onto the SAME
   extraction type the native parser already produces (`PayrollExtraction`
   for payslip), so the rest of the pipeline — reconciliation, canonical
   write — runs completely unchanged. Jurisdiction/currency/owner identity
   is *never* read from the AI response; always the caller's own
   already-established context, matching every existing adapter's rule.
4. **One gated call site** inside the native processing service's existing
   failure branch: mask the already-locally-extracted text, check the
   adapter's own flag + the shared `AIE_AI_FALLBACK_ENABLED` + the shared
   `lib/aie/featureFlags.ts` pilot cohort (reused, not cloned — see 2.2),
   call the gateway, map the result back to the native extraction shape.
5. **No new write path.** The AI-fallback result is handed to the exact
   same canonical-write function a native successful parse already calls.
   An AI-fallback-produced row must be indistinguishable from a
   natively-parsed one to every downstream step.
6. **An explicit review/confirm step**, inside the same panel, before
   anything is written — never an auto-write of an unreviewed AI guess
   (this is where this design is *more* conservative than II mechanism A's
   current auto-apply behaviour; see section 8's note on that
   inconsistency).

### 2.2 One shared pilot-cohort gate, not a third clone

`lib/aie/featureFlags.ts` already has one pilot-cohort mechanism
(`AIE_PILOT_COHORT_ENFORCED` / `_USER_IDS` / `_EMAILS`, fail-closed). The old
II mechanism cloned its own
(`II_AI_FALLBACK_PILOT_COHORT_*`) with a documented reason ("this sits
outside the AIE-1 pipeline"). This design does **not** repeat that clone for
payslip or for any future type: every new adapter should reuse
`isAiePilotCohortEnforced()`/`isUserInAiePilotCohort()` directly. One
allowlist, one operator surface, for every document type this pattern
covers — that consistency is a first-class part of "the same path," not
just the AI-calling mechanics.

### 2.3 The one real gap in "any adapter plugs in the same way": `accept.ts`

`lib/aie/review/accept.ts` dispatches to a domain write service by a
hardcoded `if (isInsurance) ... else if (isInvestmentIntelligence) ... else
if (isFdhBank)` chain — there is no `RegisteredParser`-style plugin
interface at the write-dispatch layer the way there is at the classify
layer (`lib/aie/classifier/registry.ts`). This dispatch's payslip pattern
sidesteps that gap entirely by not routing through `accept.ts` at all (see
2.1's shape). A future document type that *does* want the fuller
intake/review/accept pipeline (e.g. because it genuinely needs a background
review queue, not an in-request confirm) will hit this same gap and should
either extend `accept.ts`'s chain by hand (matching the existing three) or —
better, and out of this dispatch's scope — turn that dispatch into a real
registry first.

---

## 3. Per-document-type: what changes

| Document type | Today | Under this design |
|---|---|---|
| **Payslip** | Zero AI-fallback (confirmed, section 1.4) | **Built this dispatch** (section 9) — `lib/aie/adapters/payslip/`, gated `AIE_PAYSLIP_AI_FALLBACK_ENABLED`, wired into `payslipProcessingService.ts`'s existing failure branch |
| **Bank-statement (FDH-3 native)** | Zero AI-fallback in the LIVE route (`bankPdfProcessingService.ts`/`bankCsvProcessingService.ts`) | Same recipe: a schema for statement header/transaction facts, wired into the native service's failure branch. The EXISTING `lib/aie/adapters/fdhBankStatement/` adapter is not reused as-is (it is intake/accept-shaped, unreachable per section 1.2) — its deterministic classification logic (`detectPdfBankAdapter`) can still be reused as the "is this even a claimable layout" check before offering AI fallback. Not built this dispatch. |
| **Investment-statement** | Zero AI-fallback | Same recipe once `investmentStatementProcessingService.ts`'s own extraction shape is mapped. Not built this dispatch. |
| **Liability-statement** | Zero AI-fallback | Same recipe. Not built this dispatch. |
| **Retirement-statement** | Zero AI-fallback | Same recipe. Not built this dispatch. |
| **Insurance (AIE-1.4 adapter)** | Intake/accept-shaped, unreachable from any UI | No live upload UI exists for insurance documents at all today (confirmed: no component calls `/api/aie/insurance/intake`, and insurance policies are entered manually). Out of scope to build one; if/when one is built, it should use this design's shape, not the existing unreachable adapter's. |
| **Investment Intelligence** | Two mechanisms, one live (section 1.3) | Consolidate onto mechanism A's *shape* (already this design's reference pattern) for any future extension; retire or fix mechanism B per 1.3's recommendation. Not actioned this dispatch (II-scoped decision). |

## 4. What a genuinely new document type needs to do

1. Add `lib/aie/adapters/<type>/schema.ts` — a Zod contract for exactly the
   fields the AI may complete, following `payslip/schema.ts`'s pattern
   (nullable + closed reason-code enum per field, decimal-string money,
   ISO-string dates, `.strict()` everywhere).
2. Add `lib/aie/adapters/<type>/openaiSchema.ts` — the hand-written strict
   JSON Schema mirror, and register it in
   `lib/aie/provider/openaiJsonSchema.ts`'s `KNOWN_SCHEMAS`. **Do this before
   ever flipping the type's flag on anywhere** — section 6.1 is what
   happens when it's skipped.
3. Add `lib/aie/adapters/<type>/mapping.ts` — AI response → the type's own
   existing native extraction shape. Never map jurisdiction/currency/owner
   from the AI response.
4. Add `lib/aie/adapters/<type>/gateway.ts` — one gateway instance, one
   `request<Type>AiExtraction()` function, mirroring `payslip/gateway.ts`
   exactly (kill switch via `isAieAiFallbackEnabled()`, cost admission via
   `reserveConservativeAiCost`/`settleAiCost`).
5. Add `lib/aie/adapters/<type>/featureFlags.ts` — exactly one
   `AIE_<TYPE>_AI_FALLBACK_ENABLED` flag (default OFF, literal `'true'`
   required). Reuse `lib/aie/featureFlags.ts`'s shared pilot cohort — do not
   add a second one.
6. In the type's own native processing service, in the existing failure
   branch, for the subset of failure kinds that mean "this looks like the
   right document type but couldn't be parsed" (never for "wrong document
   type" or "no readable text at all" kinds): mask the text, check flags +
   cohort, call the gateway, map to the native extraction shape, return a
   draft — never write.
7. Add a `POST .../ai-fallback/confirm` route mirroring
   `app/api/financial-data-hub/payslip/[documentId]/ai-fallback/confirm/route.ts`
   — validates the (possibly user-corrected) submitted values and calls the
   SAME canonical write function the native success path already uses.
8. Update the upload panel to show a review/edit step for the draft,
   mirroring `PayslipImportPanel.tsx`'s `ai_fallback_review` phase.
9. Add the type's own audit-event vocabulary widening (a migration + the
   matching `FDH_DOCUMENT_AUDIT_EVENT_TYPES_*` constant), following the
   FDH-9/10/11/12 precedent this dispatch's own migration 0173 also
   follows.
10. Unit-test the mapping/schema/gating logic with a faked gateway (never a
    real provider call in `tests/unit/`), and add an opt-in
    `tests/live-dev/*.live.test.ts` proof mirroring
    `aiePayslipAdapterLiveProviderProof.live.test.ts` for a reviewer to
    reproduce.

## 5. Rollout plan (prioritised)

1. **Payslip** — built this dispatch, DEV-only, flag off. Next: apply
   migration 0173 to DEV, get PO sign-off on the masking additions
   (section 6.3), then a real DEV activation with the pilot cohort
   restricted to the PO's own account.
2. **Bank-statement** — highest remaining value (highest document volume
   per the existing FDH-3 usage), same recipe.
3. **Investment-statement / Liability-statement / Retirement-statement** —
   same recipe, roughly equal priority; order by whichever the PO is
   actively testing next (matching how this dispatch's own scope was
   chosen).
4. **Investment Intelligence consolidation** (section 1.3's (a)/(b)) —
   should happen before any of the above reuses its shape further, so a
   future adapter isn't modelled on a mechanism already known to have a
   double-processing defect.
5. **Insurance** — no live upload UI exists; build one only if/when the
   product wants insurance documents uploaded at all, using this design's
   shape from the start rather than the existing unreachable adapter.

---

## 6. New defects found while building this (byproduct of live-proving payslip)

None of these were in the original discovery brief. All found through this
dispatch's own live-DEV proof against the real OpenAI provider
(`tests/live-dev/aiePayslipAdapterLiveProviderProof.live.test.ts`), not by
inspection.

### 6.1 Investment Intelligence's live AI-fallback mechanism cannot complete a real OpenAI call today (P0-class)

`lib/aie/adapters/investment-intelligence/documentFactsSchema.ts`'s
`investmentDocumentFactsSchema` — the schema mechanism A
(`aiFallbackDocumentExtraction.ts`, the ONE reachable II AI-fallback path,
made "fully automatic" 2026-09-20) actually validates against — was never
added to `openaiJsonSchema.ts`'s `KNOWN_SCHEMAS`. Confirmed live: calling
the real gateway with that schema name/version and `AIE_AI_PROVIDER=openai`
throws `"no strict JSON Schema mapping registered"`, which the gateway maps
to `outcome: 'provider_error'`. **In any environment where
`AIE_AI_PROVIDER=openai` is actually set, every real II AI-fallback attempt
fails before ever reaching a usable result** — independent of, and in
addition to, this mechanism's two already-disclosed blockers (masking key
unset; every II parser declares `aiEligibleGaps: []`). Fixed in this
dispatch's own `openaiJsonSchema.ts` change *only* for the payslip schema
(a new `rawSchema` escape hatch was added for schemas that don't fit the
generic field-completion-envelope builder — see the file's own 2026-09-22
header comment); the II schema itself was deliberately **not**
hand-converted here, given its nesting depth and cross-field refinements
make a rushed conversion under this dispatch's payslip-scoped time budget a
real risk of silently mis-shaping what the provider is allowed to return. A
follow-up task has been flagged separately.

### 6.2 A payslip document's most common person-bearing label was unmasked (P0/P1-class, fixed this dispatch)

`lib/aie/masking/piiMasking.ts`'s `person_name_label` rule's label
alternation (investor, holder, nominee, policy owner, insured person, ...)
did not include `employee`/`employee name` — the single most common
person-bearing label on an AU or India payslip. Confirmed live: a synthetic
payslip's `Employee: JANE ANNE CITIZEN` line egressed to the masked payload
completely unmasked. This is the identical class of gap M12B found and
fixed for insurance's `Policy Owner:`/`Insured Person:` labels
(`piiMasking.ts`'s own header on that fix). **Fixed in this dispatch**
(`piiMasking.ts`, `employee` added to the alternation; `employer` is
deliberately *not* added — a business name is the field this adapter exists
to read, not personal PII). Regression tests added in
`tests/unit/aiePiiMasking.test.ts`.

### 6.3 Narrower, disclosed-not-fixed formatting gaps in shared masking

Found live, not fixed (out of this dispatch's scope — these are pre-existing
shared-pattern limits, not payslip-specific bugs):

- The `tax_id` pattern requires the ATO-standard spaced format
  (`123 456 789`); a hyphenated TFN (`123-456-789`) — which some payroll
  software genuinely exports — is not masked.
- The `bank_account` pattern requires the BSB and account digits
  immediately adjacent; a real payslip's "BSB 062-000 Acc 1234 5678" (label
  text and a space between the two groups) does not match, so bank account
  details on a payslip may reach the provider unmasked in that
  presentation. This is a real, disclosed residual privacy exposure for
  payslip specifically, since bank account details are printed on many real
  AU payslips (for salary crediting) — the PO should see this called out
  explicitly, not buried, before any DEV pilot cohort is widened beyond the
  PO's own account.

### 6.4 The model needs explicit format instructions, or its own strict-mode JSON Schema won't save you

OpenAI's structured-outputs strict mode enforces the JSON Schema's
*structure* (types, enums, required keys) but does not, in this codebase's
hand-written schemas, enforce string *patterns* — so a model can return
`"$3,200.00"` for a field this adapter's own Zod re-validation requires as
`"3200.00"`, and get correctly rejected (`schema_rejected`) rather than
accepted with a value the app can't use. Fixed for payslip by adding an
explicit format instruction to the system prompt
(`lib/aie/adapters/payslip/gateway.ts`'s
`PAYSLIP_AI_EXTRACTION_SYSTEM_PROMPT`). Worth checking whether the same
prompt gap exists for II's and insurance's own prompts.

---

## 7. Migration

`supabase/migrations/0173_aie_payslip_ai_fallback_audit_events.sql` — widens
`fdh_document_audit_events.event_type`'s CHECK constraint with 7 new event
types, following the exact FDH-9/10/11/12 precedent. **DRAFTED, NOT
APPLIED** to any environment. Numbered 0173 after checking migration numbers
claimed across every currently-active branch found (not just `origin/main`,
which itself only requires 0171) — see the migration file's own governance
comment for the full list of branches checked.

## 8. Known limitation carried over, not this dispatch's to fix

Investment Intelligence's mechanism A now auto-applies a successful AI
extraction with no confirmation step (2026-09-20 PO instruction). This
design deliberately makes payslip's own confirm step explicit, per the
mission brief's own framing of the PO's goal ("try AI, **then ask you to
review**"). That is an intentional inconsistency between II's current
behaviour and this new pattern, not an oversight — flagged here so it's a
conscious choice rather than a silent divergence. If the PO wants one
uniform answer, whichever direction is chosen should be applied to both.

## 9. Phase 2 status: payslip AI-fallback

See the accompanying report for full detail. Summary: built, unit-tested,
type-checked, and live-proven against the real `gpt-4o-mini` provider (three
real API calls made during this dispatch, each a few hundred tokens,
well under a cent). Shipped disabled by default via
`AIE_PAYSLIP_AI_FALLBACK_ENABLED`. Not merged, not applied to DEV or
production. Branch pushed for review.
