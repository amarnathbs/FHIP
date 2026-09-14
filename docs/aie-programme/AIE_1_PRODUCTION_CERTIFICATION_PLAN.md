# AIE-1 Production Certification & Rollout Plan

**This document is planning only. It authorizes nothing.** No migration
application, no feature-flag activation in any environment, no real AI
provider traffic, no real user's document, no cohort activation, and no
branch merge is authorized by this plan or by anything in it — that
restatement matches every one of the six AIE-1.x source documents' own
repeated, explicit language, and this plan does not weaken it.

**Where this sits in the programme.** AIE-1.6's own interim certification
(`AIE_1_6_CERTIFICATION_REPORT.md`) could not issue a platform-wide
GO/CONDITIONAL GO/NO-GO, for one structural reason (no merged release
candidate exists) and surfaced two real, material findings on top of that.
This plan does three things: (1) records that both of those findings have
since been closed, (2) turns AIE-1.6's own remaining "what a genuine
platform certification needs" list into a concrete, ordered plan rather
than a restatement, and (3) adds the parts AIE-1.6 could not address at
all because they require infrastructure or a Product Owner decision this
codebase does not have yet (a real AI provider, a controlled-rollout
mechanism, a retention/purge job, a cost budget).

---

## 1. Current state, as of this plan (2026-09-11)

| Item | Status |
|---|---|
| AIE-1.1 (shared gateway) | Implemented, tested, `feature/aie-1-1-document-gateway` |
| AIE-1.2 (Investment Intelligence adapter) | Implemented, tested, `feature/aie-1-2-investment-adapter` — paper-reviewed only by 1.6, never executed by any pass |
| AIE-1.3 (FDH bank-statement adapter) | Implemented, tested, `feature/aie-1-3-fdh-bank-adapter` — paper-reviewed only by 1.6, never executed by any pass |
| AIE-1.4 (Insurance adapter) | Implemented, tested, `feature/aie-1-4-other-modules` — merged into and executed by 1.5 |
| AIE-1.5 (unified review UX) | Implemented, tested, `feature/aie-1-5-exception-review-ux` — real, integration-tested against 1.1 core + Insurance/1.4 |
| AIE-1.6 (interim certification) | Done — CONDITIONAL PASS for 1.1+Insurance+review-UX on real evidence; 1.2/1.3 paper-reviewed only; no platform-wide verdict yet (no merge exists) |

**The two real findings AIE-1.6 surfaced are now CLOSED, as of this
planning pass:**

1. **Demonstrated PDF-structural-scan bypass** (a `/JavaScript` action
   deflate-compressed inside a standard `/Filter /FlateDecode` stream
   evaded `scanPdfStructure` entirely). **Fixed** on
   `fix/aie-1-1-pdf-flatedecode-detection` (based on
   `feature/aie-1-1-document-gateway`, commit `1afceec`, pushed): the scan
   now decompresses and re-scans every declared `/FlateDecode` stream,
   bounded by both a stream-count cap and a total-decompressed-bytes cap
   (flagging an over-budget stream as `oversized_compressed_stream` rather
   than silently skipping it — a zip-bomb shape is itself now a signal).
   Still explicitly a heuristic (a *different* or *chained* filter can
   still hide a token) — this closes one demonstrated hole, not the whole
   class. 7 new regression tests, including a byte-for-byte reproduction
   of AIE-1.6's own adversarial fixture, all pass; zero regression on the
   existing 62 AIE-1.1 tests. **This fix is NOT yet merged into any of the
   five phase branches** — it lives on its own branch specifically so the
   planned merge (section 3 below) picks it up for every downstream
   adapter at once, rather than patching each branch separately.
2. **AIE-1.3 had no implementation report; its commit path was never
   migrated onto AIE-1.5's centralized `accept.ts` gate.** The missing
   report is now written (`AIE_1_3_IMPLEMENTATION.md`, pushed to
   `feature/aie-1-3-fdh-bank-adapter`, commit `cf20616`) — retroactively,
   from the real committed code and an independent re-run of its own test
   suite (23/23, confirmed matching its original claim exactly). **The
   centralized-gate migration itself is NOT done** — that is a real code
   change to `lib/aie/adapters/fdhBankStatement/atomicImport.ts`/
   `route.ts` that only makes sense to do AS PART OF the branch merge
   (section 3), since `accept.ts` and this adapter's commit path
   currently live on different, unmerged branches. Recorded here as a
   **required merge-step task**, not deferred indefinitely.

---

## 2. What AIE-1.6 itself still says is missing, unchanged by this plan

Restated from `AIE_1_6_CERTIFICATION_REPORT.md` section 2/4/8 (not
re-discovered — this plan does not duplicate that report's own
investigation):

- No merged release candidate — addressed by section 3 below.
- No live-DEV verification anywhere for any AIE phase — addressed by
  section 4 below (already separately queued by the Product Owner as the
  next step after this plan).
- Cross-tenant isolation verified on paper + application layer, never
  against a real running database — subsumed by section 4's live-DEV pass.
- No real AI provider integration anywhere (only `MockAieProvider` has
  ever run) — addressed by section 5 below, which AIE-1.6 could not itself
  attempt (no provider is wired to attempt it with).
- No retention/purge/deletion sweep job for AIE documents anywhere —
  addressed by section 6 below.
- No PC5 integration, no bulk review actions, no post-acceptance amendment/
  undo, no notifications — addressed (as an explicit scope decision, not a
  build) in section 7 below.
- No WCAG-automated accessibility tooling anywhere in this repository —
  addressed (as an explicit scope decision) in section 7 below.
- No AIE-1.0 artifact (approved architecture/privacy/threat-model
  document) exists under that name anywhere in this repository — still an
  open Product Owner question, restated in section 8, not resolved here.

---

## 3. Merge (separately planned in detail as the user's own next queued
   step — this section states only what production certification NEEDS
   from that step, not how to execute it)

A genuine platform-wide certification requires ONE branch containing all
five phases plus the PDF-detection fix, re-tested as a whole — not five
separate paper trails. For that later merge-planning step to actually
close AIE-1.6's remaining gap, it needs to:

1. Merge `feature/aie-1-1-document-gateway` → `feature/aie-1-2-investment-
   adapter` → `feature/aie-1-3-fdh-bank-adapter` → `feature/aie-1-4-other-
   modules` (already inside `feature/aie-1-5-exception-review-ux`) →
   `feature/aie-1-5-exception-review-ux` → `fix/aie-1-1-pdf-flatedecode-
   detection`, resolving migration numbers across all of them (currently
   `0140`-`0144` plus this plan's own new documentation-only commits; no
   numeric collision exists today per AIE-1.6's own re-verified check, but
   git-level merge conflicts in the SQL files themselves are untested).
2. Migrate AIE-1.3's commit path (`atomicImport.ts`'s trust-the-caller
   shape) onto AIE-1.5's centralized `accept.ts` gate — a real code change,
   not just a merge, per section 1 finding 2 above and
   `AIE_1_3_IMPLEMENTATION.md` section 5/8's own disclosure.
3. Confirm AIE-1.2's canonical-write gate (`write.ts`'s three-gate
   discipline: flag → reconciliation outcome → open blocking items) is
   ALSO reachable through `accept.ts`, or make the same kind of change
   AIE-1.3 needs — AIE-1.6's paper review did not confirm this either way
   because it never executed 1.2's code.
4. Re-run, on the merged result, EXACTLY the evidence AIE-1.6 already
   gathered for the 1.1+Insurance+review-UX scope (tsc, eslint, full
   vitest run, the 10 automatic NO-GO condition checks, the two new
   adversarial tests) — a merge can silently change behaviour no
   branch-level review can see, per AIE-1.6's own stated reasoning for why
   it refused to extrapolate from paper review to a verdict.
5. Confirm the PDF-detection fix (section 1 finding 1) actually lands and
   its own 7 regression tests still pass once merged alongside every
   adapter's own test suite.

**This plan does not execute the merge.** It is recorded here as the
literal, ordered checklist the merge step needs to satisfy, so that step
can be scoped precisely rather than re-derived from scratch.

---

## 4. Live-DEV verification (separately queued by the user as the step
   after merge planning — this section states only what it needs to prove)

Every AIE phase to date has run exclusively against injected/faked
dependencies. A real DEV pass (disposable synthetic users, this session's
own established FHIP pattern — never real user data) needs to prove, for
the FIRST time for any AIE code:

1. Migrations `0140`-`0144` (merged, renumbered as needed) actually apply
   cleanly to a real Postgres/Supabase DEV instance.
2. RLS policies actually block a genuine cross-tenant read/write attempt —
   AIE-1.6's own report explicitly flagged this as "verified by reading
   the SQL, not by attempting a real negative-control query," which is
   this repository's own established gap-closing pattern for every prior
   module (FDH-3, Investment Intelligence R4's own live RLS exploit fix,
   etc.) — the same rigor needs to apply here before any real-user
   exposure.
3. The storage-bucket quarantine round-trip (upload → read → the
   documented retention/deletion story once section 6 exists) works
   against real object storage, not a mock.
4. A real end-to-end journey (upload → extraction → masking → review →
   accept → canonical write) completes against real infrastructure for at
   least the one adapter already integration-tested in-process (Insurance)
   — proving the SAME journey AIE-1.5's own test suite already proves
   against fakes also holds against real infrastructure.
5. Feature-flag defaults are confirmed OFF in the actual DEV environment
   configuration, not just absent from a local `.env*` file check.

---

## 5. Real AI provider integration test (new — AIE-1.6 could not attempt
   this at all, since no provider has ever been wired)

Every AIE phase's masked-AI-fallback path has run only against
`MockAieProvider`. Before any claim that the "minimum-necessary masked
low-cost AI fallback" architecture actually works, this needs a scoped,
narrow real-provider test:

1. **Provider choice and cost bound**: pick one low-cost provider (the
   architecture documents describe "low-cost AI" as the intended fallback
   tier throughout — this plan does not pick one, that is a Product Owner/
   engineering decision informed by this repo's existing `lib/ai/
   providers/**` abstraction, which AIE's own gateway already deliberately
   does NOT reuse directly, per `AIE_1_1_IMPLEMENTATION.md`'s own disclosed
   reuse decision). Whatever is chosen, set an explicit, small dollar cost
   ceiling for this test pass specifically (this is exactly AIE-1.6's own
   "cost" certification dimension, which it could not measure at all
   without a real provider to measure).
2. **Scope**: exercise only the ONE currently-real AI-eligible gap that
   exists in the certified scope — Insurance's declared gaps (see
   `AIE_1_4_IMPLEMENTATION.md`) or the FDH bank adapter's institution-hint
   gap (`AIE_1_3_IMPLEMENTATION.md` section 4) — with synthetic fixtures
   only, never real documents.
3. **Prove, with real evidence, not a mock's stand-in**: (a) the pre-call
   masking re-scan (`lib/aie/provider/gateway.ts`'s `containsUnmaskedPii`)
   genuinely blocks a real call if masking somehow failed — construct a
   deliberately-under-masked fixture and confirm the call is refused
   before it reaches the real provider; (b) a real provider response that
   fails strict schema validation is genuinely rejected, not silently
   coerced; (c) a real provider error (rate limit, timeout, malformed
   response) maps to `ProviderError`/`ProviderErrorCode` without leaking
   raw provider error text into any log/trace/audit event, matching the
   non-negotiable prohibition already enforced against the mock.
4. **Kill switch proof**: confirm `AIE_AI_FALLBACK_ENABLED` (and each
   adapter's own narrower flag) genuinely prevents ANY provider call when
   OFF, using the real provider client (not the mock) so the kill switch
   is proven against the thing it's actually meant to stop.

---

## 6. Retention / purge job (new — flagged as missing by every AIE phase,
   never designed by any of them)

No AIE phase built a deletion/retention sweep for quarantined documents,
extraction artifacts, or mask-token maps. Before any real user document is
ever processed, this needs:

1. A retention policy decision (how long a document/extraction/mask-token-
   map row may persist after processing completes, or after a document is
   rejected) — a Product Owner/privacy decision, not an engineering one,
   though FDH-1's own existing document lifecycle work is the direct
   precedent to reuse the SHAPE of, not necessarily the exact schedule.
2. A sweep job design following the same pattern LR-1's own account-
   deletion-sweep cron already established in this codebase (see
   `docs/live-recovery/`) — reuse that pattern, don't invent a new one.
3. A "delete on demand" path (a user or admin explicitly requesting
   deletion of a specific intake) distinct from the scheduled sweep,
   matching this repository's own established convention of both a
   scheduled AND an on-demand deletion path for other sensitive data
   classes.

---

## 7. Explicit scope decisions needed before a real GO (not built, not
   silently deferred — named as decisions)

- **PC5 integration**: AIE's unresolved-item lifecycle is real and
  exercised by tests, but nothing outside AIE itself reads it yet — PC5
  does not exist as a consuming surface in this repository today. Decide:
  is PC5 integration a hard prerequisite for ANY production cohort, or can
  AIE's own review UX (already built, AIE-1.5) stand alone for an initial
  limited rollout, with PC5 integration following later? This plan
  recommends the latter (AIE-1.5's own UI is a complete, real acceptance
  path on its own) but this is a Product Owner call, not an engineering
  one.
- **Accessibility**: this repository has zero automated accessibility
  tooling configured anywhere (no `jest-axe`, no `eslint-plugin-jsx-a11y`,
  confirmed by AIE-1.6's own independent grep) — this is a pre-existing,
  repo-wide gap, not something introduced by AIE. Decide: does a
  production AIE rollout require closing this repo-wide gap first (a
  larger, separate initiative), or does AIE-1.5's own manual-convention-
  matching + pure-function label/announcement tests suffice for an initial
  limited cohort while the repo-wide gap is tracked separately? This plan
  recommends the latter, consistent with how this repository has shipped
  every other module to date.
- **Malware/AV signature scanning**: still explicitly a disclosed stub —
  section 1's fix closes one demonstrated structural-heuristic bypass, but
  a real signature engine (e.g. ClamAV) remains unbuilt, and none exists
  anywhere else in this codebase either (FDH-3's own threat model
  discloses the identical gap). Decide: is standing up a real scanner a
  hard prerequisite for accepting real user PDFs, or is the combination of
  (structural heuristics + masking + strict schema validation + human
  review before any canonical write) an acceptable interim risk posture
  for a small, monitored initial cohort? **This plan does not recommend
  either way** — this is a genuine security risk-acceptance decision for
  the Product Owner, not an engineering judgment call, and AIE-1.6's own
  certification method requires exactly this kind of decision to be named
  explicitly rather than silently assumed.

---

## 8. Staged rollout design (AIE-1.6's own required step: "design and,
   where authorised, rehearse a staged production rollout" — design only,
   per that document's own words, not activation)

**Cross-reference, not a new discovery**: this session's own G6-G8
programme work (`docs/country-programme/g8-discovery-batch6-a11y-seo-
rollout-rollback.md`) already found that **no controlled-cohort/
percentage-rollout mechanism exists anywhere in this codebase** — every
existing feature flag in this repository goes straight from "verified in
DEV" to "100% of production instantly." `ai_model_registry.rollout_
percentage` is the one near-miss column with zero consumers. AIE would
need exactly this same, currently-nonexistent mechanism — this is not an
AIE-specific gap, it is a repository-wide gap AIE would be the first
feature to actually need for real.

Proposed staged design (design only — matches every stage's own existing
"feature flag defaulted OFF" discipline, just sequenced):

1. **Stage 0 — DEV-only, synthetic data, internal**: exactly what exists
   today, extended by sections 4-5 above (live-DEV + real-provider proof).
   No real user, no production infrastructure.
2. **Stage 1 — production infrastructure, zero real cohort**: migrations
   applied to production, all flags still OFF, a real (not DEV) provider
   contract in place with the cost ceiling from section 5, but no user can
   reach any AIE route (the feature flags ARE the gate, verified against
   production config directly, not assumed).
3. **Stage 2 — named internal/synthetic cohort only**: a small, explicitly
   named allowlist of internal/test accounts (not a percentage — this
   codebase has no percentage mechanism yet, per the cross-reference
   above) gets the flags enabled; every other user is unaffected. This is
   the SMALLEST real-user-shaped test possible without a rollout
   percentage mechanism, and does not require building one.
4. **Stage 3 — building the actual rollout-percentage mechanism**: if a
   true percentage-based cohort is required before wider release (a
   Product Owner call, following on from G8's own already-flagged open
   decision), this is a separate, scoped engineering task — extending
   `ai_model_registry.rollout_percentage` (or an equivalent) to actually
   have a consumer, likely shared infrastructure useful beyond AIE alone.
5. **Stage 4 — general availability**: only after stages 0-3 (or an
   explicit Product Owner decision to skip the percentage mechanism and go
   allowlist-only) are each separately signed off.

Each stage transition requires its own explicit Product Owner
authorization — this plan does not authorize moving between any of them,
including Stage 0 to Stage 1.

---

## 9. Ordered gate list before ANY real production GO

For traceability, the complete list, in the order this plan recommends
addressing them (not all are hard blockers — section 7 marks which are
scope decisions rather than build items):

1. ~~PDF-structural-scan bypass~~ — **CLOSED** (section 1).
2. ~~AIE-1.3 missing report~~ — **CLOSED** (section 1).
3. AIE-1.3's commit-path migration onto `accept.ts` — **open, scoped into
   the merge step** (section 3, item 2).
4. AIE-1.2's canonical-write gate reachability through `accept.ts` —
   **open, unconfirmed, scoped into the merge step** (section 3, item 3).
5. The branch merge itself and its full re-verification — **open,
   separately queued** (section 3).
6. Live-DEV verification — **open, separately queued** (section 4).
7. Real AI provider integration test — **open, newly scoped here**
   (section 5).
8. Retention/purge job — **open, newly scoped here** (section 6).
9. PC5 / accessibility / malware-scanner scope decisions — **open,
   explicit Product Owner decisions, not build items** (section 7).
10. Staged rollout mechanism (if required beyond an allowlist) — **open,
    cross-referenced from G8, a separate engineering task if authorized**
    (section 8).

No item on this list is closed by this plan itself beyond items 1-2, which
were closed as real engineering work during this planning pass (not merely
planned) because both were small, contained, and directly named as open
findings by AIE-1.6's own certification. Every remaining item is planning
only, per this document's own opening statement.
