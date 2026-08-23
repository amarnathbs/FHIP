# R0 — Acceptance Report

Status: FINAL
Branch: `feature/investment-intelligence-r0-architecture` (from `main` tip `fe7a094`)
Date: 2026-08-19

## Acceptance checklist

- [x] **Existing code/schema discovery complete** — `R0_CURRENT_STATE_DISCOVERY.md`, grounded in direct inspection of `supabase/migrations/0001–0030`, `lib/engines/`, `lib/services/`, `lib/grid/configs.ts`, `lib/validation/*`, `app/api/*`. No hypothetical description used where code inspection could determine the answer.
- [x] **Current net-worth calculation traced** — exact formula (`netWorth = totalAssets + totalInvestments + totalRetirement − totalLiabilities`) located and quoted verbatim from `lib/engines/dashboard.ts`, confirmed as the single computation path feeding Dashboard, Reports, and Forecasting.
- [x] **Current Assets/Investments/Retirement duplication risk documented** — `R0_CURRENT_STATE_DISCOVERY.md` section 11; confirmed live overlap (`gold`, `shares`, `etfs`, `managed_funds` valid `master_item_key`s in both asset and investment catalogues).
- [x] **Country-neutral Investment Intelligence Core frozen** — `R0_DOMAIN_ARCHITECTURE.md`.
- [x] **India adapter boundary frozen** — `R0_DOMAIN_ARCHITECTURE.md` section 3 (explicit global/India/outside-II table across 13 domain areas); `ADR-005`.
- [x] **Canonical entity model documented** — `R0_CANONICAL_DATA_CONTRACT.md`, all 20 entities.
- [x] **Canonical ID model documented** — `R0_CANONICAL_IDENTIFIER_STRATEGY.md`; `ADR-002`.
- [x] **Source/provenance model documented** — `R0_SOURCE_PROVENANCE_CONTRACT.md`; `ADR-003`.
- [x] **Current Investments publishing mapping frozen** — `R0_FHIP_PUBLISHING_CONTRACT.md`, every field verified against live `lib/grid/configs.ts`/`lib/validation/investment.ts`.
- [x] **Net-worth deduplication contract proven** — `R0_NET_WORTH_DEDUP_CONTRACT.md`; 12/12 scenarios resolved (`R0_TESTING_AND_VERIFICATION.md` section C); `ADR-004`.
- [x] **Goal contract frozen** — `R0_GOAL_INTEGRATION_CONTRACT.md`; `ADR-006`.
- [x] **Forecasting contract frozen** — `R0_FORECASTING_CONTRACT.md`; `ADR-006`.
- [x] **Cross-border contract frozen** — `R0_CROSS_BORDER_CONTRACT.md`.
- [x] **Insight/advice classification frozen** — `R0_INSIGHT_CLASSIFICATION.md`; `ADR-007`.
- [x] **Audit model frozen** — `R0_AUDIT_REQUIREMENTS.md`; `ADR-008`.
- [x] **Security/RLS requirements frozen** — `R0_SECURITY_RLS_ARCHITECTURE.md`; `ADR-009` (with an honestly-documented platform-wide gap — see Outstanding Issues below).
- [x] **Ten ADRs completed** — `docs/investment-intelligence/adr/ADR-001` through `ADR-010`.
- [x] **R1 implementation specification completed** — `R1_IMPLEMENTATION_SPEC.md`.
- [x] **Existing lint/typecheck/tests/build remain healthy** — `R0_TESTING_AND_VERIFICATION.md` section A: lint unchanged (6 pre-existing errors, confirmed unrelated to this work — no `.ts`/`.tsx` file was touched by R0), typecheck clean before and after, 124/124 tests before and after, build succeeds before and after.
- [x] **No R1+ scope accidentally implemented** — no migration file created, no `ii_*` table exists anywhere, no CAS parser, no analytics engine, no adviser feature, no production Investment Intelligence code of any kind. Verified: `git diff --stat main..HEAD` (see below) touches only files under `docs/investment-intelligence/`.

```
$ git diff --stat main..HEAD -- . ':!docs/investment-intelligence'
(no output — zero files outside docs/investment-intelligence/ changed)
```

## Outstanding issues (non-blocking for R1 start, but not silently resolved)

1. **No genuine multi-person household access model exists in FHIP today.** `R0_SECURITY_RLS_ARCHITECTURE.md`/`ADR-009` document this honestly rather than assuming Investment Intelligence can deliver the spec's "family-member access" requirement — it cannot, until a platform-wide fix is made outside this module's scope. R1 should proceed with owner-only RLS (identical to every existing table) and treat "family-member access" as explicitly deferred, not silently dropped.
2. **Republish-vs-user-correction conflict resolution UX is not fully resolved.** `R0_NET_WORTH_DEDUP_CONTRACT.md` scenario 12 and `R0_FHIP_PUBLISHING_CONTRACT.md` section 3 flag that the exact mechanism (last-write-wins-with-warning vs. merge-prompt) for when a republish would overwrite a user's manual correction is an R1 UX decision, not resolved by R0 architecture alone. The *data model* supports either resolution (the layered correction model in `R0_SOURCE_PROVENANCE_CONTRACT.md` doesn't presuppose one); the *product decision* is open.
3. **No automated migration path for pre-existing misclassified rows** (e.g. a user who manually entered an NPS holding under Investments before Investment Intelligence existed) — `R0_NET_WORTH_DEDUP_CONTRACT.md` scenario 6 flags this as a manual-remediation-only concern, not a blocking architectural gap, since Investment Intelligence's own publishing is correctly single-target from day one; it just can't retroactively fix unrelated historical manual-entry mistakes without a separate, explicit product decision.
4. **Transaction-level source-reference de-duplication column is not yet named** — `R0_CANONICAL_IDENTIFIER_STRATEGY.md` section 4 flags this as a small, genuinely R1-level implementation detail (not an architectural ambiguity — the *mechanism*, a provider-reference column used for de-dup, is decided; only its exact name/shape is deferred).
5. **Two dead audit tables (`audit_events`, `financial_records_audit`) remain unconsolidated** — `ADR-008` explains why R0 does not attempt to fix this pre-existing, unrelated condition; noted here as a legitimate candidate for a separate cleanup task, not an R0/R1 blocker.

None of the five items above represent an unresolved *architectural* ambiguity that would force a schema redesign during R1 — each is either an explicitly-deferred platform-wide gap (item 1), a product/UX decision layered on top of an already-adequate data model (items 2, 3), or a small naming/implementation detail (items 4, 5).

## R0 recommendation

## PASS

**Justification, against the spec's own PASS bar (Section 21):**

- **No unresolved architectural ambiguity that would force a schema redesign during R1.** Every one of the 20 canonical entities has a fully-specified ownership model, identifier strategy, provenance relationship, country/currency treatment, audit requirement, lifecycle, and FHIP relationship (`R0_TESTING_AND_VERIFICATION.md` section B, 20/20). The five outstanding issues above are deferred product/platform decisions layered on an adequate model, not open architectural questions.
- **Baseline tests remain healthy.** Lint (6 pre-existing errors, unrelated, unchanged), typecheck (clean), tests (124/124), and build (success) were all executed before R0 documentation began and re-executed after — byte-identical results both times, because R0 changed zero source files (`R0_TESTING_AND_VERIFICATION.md` section A).
- **Source-of-truth and deduplication rules are clear.** `R0_NET_WORTH_DEDUP_CONTRACT.md` resolves all 12 required scenarios to exactly one household economic value each, via a mechanism (single-target publishing + `unique(canonical_position_id)` + reuse of the existing `is_active` exclusion) that was checked against the actual `computeDashboard()` source code, not assumed — and requires zero changes to that function or any other existing calculation path (`ADR-004`).
- **R1 can begin safely.** `R1_IMPLEMENTATION_SPEC.md` translates every R0 decision into a concrete, additive-only migration plan with no ambiguity about table order, RLS shape, or storage design left for R1 to improvise.

This verdict is issued on the same honest-verdict standard applied throughout this project's history (per the operating instructions governing this work) — it reflects that R0's specific, bounded objective (architectural certification, not product delivery) was genuinely and verifiably met, not that Investment Intelligence as a whole is complete or that every product decision has been made. The outstanding issues above are real and listed precisely so they are not lost, not because they invalidate the PASS.

## Exact prerequisites for R1

1. Product/engineering sign-off on the two open UX decisions in Outstanding Issues item 2 (republish-vs-correction conflict handling) — does not block *starting* R1's schema work, but should be resolved before R1's publish-flow implementation ships.
2. Confirmation that Outstanding Issues item 1 (no multi-person household access) is acceptable as an explicitly-deferred limitation for the R1 release, not silently expected to be solved within Investment Intelligence.
3. `R1_IMPLEMENTATION_SPEC.md` section 1's table creation order followed exactly (dependency-ordered) to avoid FK-creation-order migration errors.
4. R1's own acceptance gate (`R1_IMPLEMENTATION_SPEC.md` section 16) must independently re-verify the 12-scenario dedup matrix as real integration tests against a real DEV-Supabase-backed schema — R0's version is a design/paper test only, explicitly not a substitute for that.
5. No work under this branch is pushed or merged — `feature/investment-intelligence-r0-architecture` remains local-only per the standing instruction governing this release; R1 should branch from wherever this work is subsequently merged/reviewed, not assume this branch is mergeable as-is without human review first.
