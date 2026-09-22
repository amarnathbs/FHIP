# R1 — Ranking Provenance Certification (SQ-AI-003 / SQ-AI-025 / `priority_review_areas`)

**Programme:** Module 11 AI Remediation, 2026-09-22
**Branch:** `feature/module11-ai-remediation-2026-09-22` (off `origin/main` @ `e5a379d`)
**Source audit basis:** `f0c0895` (PH-12 in `docs/ai/FHIP_AI_Placeholder_Register_2026-09-22.md`)
**Verdict:** **RANKING PROVENANCE DEFECT — REMEDIATED AND CERTIFIED**

Evidence classes used below: **CODE** = read directly from source on this branch; **TEST** = a vitest run executed in this session (counts quoted are from the run); **DEV** = a live query/run against the DEV Supabase project. No production access was used.

## 1. Reconciliation against current main (brief §2)

| Item | Value |
|---|---|
| `origin/main` at dispatch | `e5a379dc4b53f401600b2a6838a7e984a4735dcc` (merge of PR #7) |
| Audit basis | `f0c0895` |
| Commits between | PR #5 NAV1 (migrations 0166-0168, 0171, 0172), PR #6 `1aace3a` (tsc hotfix, `navRetentionPolicy.ts`), PR #7 `39269da` (RetirementStatementImportPanel envelope + `lib/financial-data-hub/clientApiEnvelope.ts`) |
| Touches `lib/ai/**` or Module 11 migrations? | **No** (verified with `git diff --stat f0c0895 e5a379d -- lib/ai supabase/migrations/01[12]*`, zero Module 11 paths) — the audit's Module 11 findings carry over unchanged. |
| Module 11 migrations present on main | 0110, 0115, 0117, 0121, 0123, 0124, 0126 |
| Highest migration anywhere (all remote + local branches scanned) | 0174 (unmerged AIE branches); this programme allocates from **0175** |
| Module 11 branches/worktrees | `D:/fhip-module11`, `-1`, `-2`, `-3` (11.0-11.3 feature branches, all merged), `feature/module-11-4-standard-question-library`, `mission/m11-final-certification-2026-09-15`, `origin/audit/module11-ai-production-completeness-2026-09-22` |

## 2. Full data lineage as found (brief §5) — every transformation

| Step | Location (CODE) | What actually happens |
|---|---|---|
| Canonical engines → FCO `recommendations` / `risks` | `lib/ai/context/financialContextObject.ts:134,651` | **Both arrays are hard-coded `[]`** in both the early-return and the full build path. No certified engine output ever reaches these fields. `RecommendationEntry.priority` (`lib/ai/context/types.ts:344-349`) is a type with no producer. |
| FCO → prompt payload | `insightPackService.ts` (pre-R1: `userPrompt = developer_prompt + "\n\nCONTEXT:\n" + JSON.stringify(context)`) | The provider received the whole context and **no ranked items** (the arrays are empty) and **no ordering instruction**. |
| Prompt template PR-AI-013 v1 | migration `0121` lines 226-252 | System/developer text says "use only supplied facts, cite metric codes"; **zero words about priority, ranking, ordering or `priority_review_areas`**. |
| Provider output | `lib/ai/insightPack/types.ts` (pre-R1 `priority_review_areas: z.array(z.string()).max(3)`) plus an optional free-text `priority_review_areas` block | Provider-authored free text — the LLM would have both selected and ordered. The mock returned `[]` and a fixed block, which is why nothing was ever visibly wrong. |
| Grounding validator | `lib/ai/insightPack/groundingValidation.ts` (pre-R1) | Metric/currency/source-ref/prose checks only. **No ordering or provenance check of any kind.** The envelope-level `priority_review_areas` array was not inspected at all. |
| Persistence | `insightPackService.ts` block loop → `ai_insight_pack_blocks` | Only the free-text block was persisted; the envelope array was discarded (survives only in `ai_runs.structured_output`). |
| Answer store | `BLOCK_INTENT_MAP` (`types.ts:118`) `priority_review_areas → PRIORITY_REVIEW_AREAS_EXPLANATION` → `ai_insights` | The block's prose was written as the stored answer whenever the block passed the (non-ranking) grounding checks. |
| SQ-AI-003 / SQ-AI-025 | `lib/ai/standardQuestions/catalogue.ts:70-88, 559-577`; `service.ts:400-402` | Both resolve `STORED_PERSONALISED` from that intent; SQ-AI-025 sentence-splits the prose into ≤3 items. Catalogue text says "already-ranked ... never re-ranked here" — true of 11.4, but the "already-ranked" input was the **provider's** ranking. |

**Answers to brief §6:**

- Does the provider receive pre-ranked deterministic recommendations? **No** (empty arrays).
- Is it explicitly instructed to preserve order? **No.**
- Can it reorder? **Yes** (nothing to preserve, nothing checked).
- Can it assign new priority? **Yes.**
- Can it invent `priority_review_areas`? **Yes** — the only constraint was `max(3)` strings of ≤300 chars.
- Does grounding validation verify ordering/provenance? **No.**

Conclusion: outcome **B** of §4 (LLM interpretation/ranking) was the shipped design. Not user-visible only because the provider was the mock. This had to be fixed before R2.

## 3. Remediation (brief §7 preferred fix, implemented exactly)

| Brief §7 step | Implementation (CODE) |
|---|---|
| Deterministic ordered recommendations | `lib/ai/insightPack/priorityRanking.ts` — `RankedPriorityArea {rank, action_code, title, source_ref}`, `PriorityRankingSource` (pure function of the certified FCO). Production binding `lib/ai/insightPack/priorityRankingSource.ts` — **empty until Module 11.6 (R5) replaces it**; under an empty canonical list any provider priority is rejected. |
| Provider receives immutable ranked items | `packComposition.ts` `buildPackUserPrompt()` appends a `RANKED_PRIORITY_AREAS (IMMUTABLE …)` section as JSON data after the context, with the preserve-order instruction rendered from code (cannot drift from the validator). PR-AI-013 **v2** (migration `0175`, seeded DRAFT) states the same RANKING RULE in the template. Used identically by the single-call service and the batch orchestrator. |
| Provider may only explain each item | `types.ts` `providerPriorityItemSchema = {rank, action_code, explanation}` `.strict()` — a provider `title` is a schema violation (cannot re-label). Pack schema version bumped **`insight-pack-1.1.0`** (identity-affecting, deliberate). |
| Output preserves action_code/rank/source | Validated by `validatePriorityRankingProvenance()`; `source_ref` is never sent to the provider and never accepted back. |
| Grounding validator verifies rank equality | `groundingValidation.ts` `summarisePackGrounding(..., ranking)` → `rankingProvenance` result; violation codes `invented_priority_area`, `dropped_priority_area`, `reordered_priority_area`, `rank_mismatch`, `duplicate_priority_area`. A failure marks the `priority_review_areas` block UNGROUNDED and caps the pack at PARTIAL. |
| Answer store | `packComposition.ts` `storedAnswersFromValidatedPack()` — `PRIORITY_REVIEW_AREAS_EXPLANATION` is **never** written from provider prose; only from `composeCanonicalPriorityExplanation()` (canonical order by construction) when canonical is non-empty **and** provenance is GROUNDED. |
| Producer guard | `assertCanonicalRanking()` — an invalid canonical list fails the generation `canonical_ranking_invalid` **before** any provider call (zero spend). |

Design choice recorded: the validator **rejects** rather than silently normalises a reordered response (brief §8 allows either). Rationale: a provider that ignores an explicit immutability instruction is evidence of misbehaviour worth surfacing in `violations_json`, and the unaffected blocks are still served, so nothing is lost by rejecting.

## 4. Negative test (brief §8) and full contract — TEST

`tests/unit/aiRankingProvenance.test.ts` — **19/19 passing** (run 2026-09-22 in this session).

| Test | Result |
|---|---|
| Canonical A(1) B(2) C(3); provider returns C, A, B → validator rejects with `reordered_priority_area` | PASS |
| Same, through the **real** `AIPersonalisedInsightPackService` (in-memory DB double, mock provider `reordered_priority`): pack PARTIAL, priority block UNGROUNDED, **no** `PRIORITY_REVIEW_AREAS_EXPLANATION` stored answer; unrelated grounded answers still stored | PASS |
| Same, through the **real** `AIInsightPackBatchOrchestrator` | PASS |
| Well-behaved echo → READY; stored answer text is `1. Action A: … 2. Action B: … 3. Action C: …` | PASS |
| Composer uses canonical order even when handed shuffled provider items (defence in depth) | PASS |
| Provider `title` field → schema rejection | PASS |
| invented / dropped / relabelled-rank / duplicate → rejected | PASS (4) |
| Empty canonical + provider invents → rejected; empty canonical + empty echo → READY with no focus-first answer | PASS (2) |
| Default production source is the empty source | PASS |
| Structurally invalid canonical → FAILED `canonical_ranking_invalid`, provider factory **never called** | PASS |
| Grounding-summary integration + legacy `NOT_APPLICABLE` path | PASS (2) |

Regression of the existing Module 11 estate after the change (TEST): `tests/unit/aiInsightPack*`, `aiStandardQuestion*`, `aiContextualExplanation*`, `aiResolution*`, `aiMockProviderAndGateway`, `aiZeroCost*` — 24 files, **796 tests, 796 passing** after one test-only fix (`aiInsightPackBatchOrchestrator.test.ts`'s adversarial provider hand-parsed the old prompt layout; now uses the production `splitPackUserPrompt()` and `PACK_SCHEMA_VERSION`). PGlite suites (`aiInsightPack20HouseholdE2E`, `IsolatedKillSwitchLiveProof`, `BatchOrchestratorPglite`, `StoredAnswerIntegration`) — **31/31** with migration 0175 in the chain and PR-AI-013 **v2** (only) activated in the ephemeral instance.

## 5. What this does NOT yet do (honest boundary)

- No deterministic ranking is **produced** on this branch until R5 wires Module 11.6 into `priorityRankingSource.ts`. Until then SQ-AI-003/025 correctly resolve `PACK_NOT_READY`/no stored answer rather than a provider-authored ranking. This is the intended fail-closed interim state, not a gap.
- `risks: []` in the FCO has the same "always empty" shape; it is narrative-only (not a ranking input) and is out of R1's scope.
- Migration `0175` is not yet applied to DEV at the time this document was first written; it is applied under R2 (see the R2 report), which also activates PR-AI-013 v2 in DEV.

## 6. Completion gate (brief §9)

**RANKING PROVENANCE DEFECT — REMEDIATED AND CERTIFIED.** Ranking is no longer ambiguous: the provider structurally cannot be the ranking authority. R2 may proceed.
