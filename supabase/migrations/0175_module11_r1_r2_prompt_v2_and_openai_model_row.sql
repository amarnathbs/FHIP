-- Module 11 AI Remediation Programme (2026-09-22) — R1 + R2 registry seeds.
--
-- MIGRATION NUMBER: 0175. Collision-checked fresh against EVERY remote and
-- local branch at dispatch (this repo has hit migration-number collisions
-- repeatedly): origin/main tops out at 0172; 0173 is held by the unmerged
-- feature/aie-payslip-ai-fallback-2026-09-22 / fix/aie-ii-openai-schema-
-- registration-2026-09-22 branches; 0174 by the unmerged
-- feature/aie-1-final-closure-v2 / integration/aie-1-final-closure-
-- reconciled-2026-09-22 branches; 0165 by an unmerged Admin branch. 0175
-- is the first number held by nothing anywhere.
--
-- ADDITIVE ONLY. No Module 1-10 table is touched. Nothing here ACTIVATES
-- anything: the prompt is seeded DRAFT and the real model row is seeded
-- active=false/approved=false. Activation (DEV first, production only under
-- the R7 activation plan with explicit Product Owner authority) is an
-- explicit admin-registry action performed OUTSIDE this file, exactly as
-- every Module 11.0/11.3 seed before it.

-- ---------------------------------------------------------------------------
-- A. R1 — PR-AI-013 version 2: the ranking-provenance prompt.
--
-- Version 1 (migration 0121) never told the provider anything about the
-- ordering of `priority_review_areas`, and the FinancialContextObject it
-- narrates carries recommendations: [] unconditionally, so the provider was
-- the de-facto ranking authority for SQ-AI-003 / SQ-AI-025. Version 2 makes
-- the contract explicit in the template itself. The SAME instruction is
-- also rendered into every user prompt by
-- lib/ai/insightPack/priorityRanking.ts's buildRankedPriorityPromptSection()
-- and ENFORCED by validatePriorityRankingProvenance() — the template text is
-- the human-readable statement of the rule, not the only place it lives.
--
-- output_schema_version is 'insight-pack-1.1.0' (envelope
-- priority_review_areas is now [{rank, action_code, explanation}], see
-- lib/ai/insightPack/types.ts). Version 1 stays in the table (DRAFT, never
-- activated on any environment) for audit history; it is NOT retired here
-- because it was never ACTIVE anywhere.
-- ---------------------------------------------------------------------------
insert into ai_prompt_templates (
  prompt_code, prompt_name, version, task_type, system_prompt, developer_prompt,
  context_schema_version, output_schema_version, country_scope, safety_policy_version, status
)
select
  'PR-AI-013',
  'Monthly Personalised Insight Pack',
  2,
  'monthly_insight_pack',
  'You are FHIP''s Insight Pack narrator. Use ONLY the supplied FHIP facts. '
  || 'Do not recalculate, infer missing values, or invent causes. Do not recommend '
  || 'financial products, and do not provide personal tax or legal advice. Distinguish '
  || 'forecasts (modelled projections) from facts (recorded values), and distinguish '
  || 'missing data from a confirmed zero. Preserve the household''s country/currency '
  || 'context exactly as supplied. Return the exact structured pack schema requested, '
  || 'and reference the source metric ID for every material numerical or classificatory claim. '
  || 'RANKING RULE: you never decide what the household should focus on first. FHIP supplies a '
  || 'pre-ranked, immutable RANKED_PRIORITY_AREAS list; for the envelope field priority_review_areas '
  || 'you must return exactly those items, in exactly that order, echoing each rank and action_code '
  || 'verbatim, adding only a plain-English explanation per item. Never reorder, re-rank, add, remove, '
  || 'merge or rename an item, and never invent a priority when the list is empty.',
  'Populate only the blocks supported by the certified data supplied. Every metric_claims '
  || 'entry must cite a metric_code and source_value taken verbatim from the supplied context. '
  || 'Never state a value, percentage, currency, benchmark, classification or causal driver '
  || 'that was not supplied. If a domain is unavailable or partial, say so in plain English '
  || 'rather than omitting the block silently or fabricating a value. For every block key you do '
  || 'not populate, return null. The priority_review_areas block (if populated) may only describe '
  || 'the supplied RANKED_PRIORITY_AREAS items in their supplied order.',
  'ai-context-1.0.0',
  'insight-pack-1.1.0',
  null,
  'safety-policy-1.0.0',
  'DRAFT'
where exists (select 1 from ai_prompt_templates where prompt_code = 'PR-AI-013' and version = 1)
on conflict (prompt_code, version) do nothing;

-- ---------------------------------------------------------------------------
-- B. R2 — the real OpenAI model registry row (brief sections 10, 15, 16).
--
-- MODEL DECISION. No Module-11-specific model decision exists; the Product
-- Owner's standing decision for the sibling AIE subsystem is OpenAI
-- gpt-4o-mini as the approved low-cost tier, adopted here as the
-- CONFIGURABLE default (MODULE11_AI_MODEL, lib/ai/config.ts) — never
-- hard-coded in a service.
--
-- PRICING. Verified against OpenAI's official pricing page on 2026-09-22
-- (https://developers.openai.com/api/docs/pricing), NOT copied from the AIE
-- config (brief section 16 forbids that): gpt-4o-mini text tokens
--   standard: input $0.15 / 1M  = 0.000150 / 1K ; output $0.60 / 1M = 0.000600 / 1K
--   cached input $0.075 / 1M (informational; the registry has no cached column)
--   Batch API: 50% of standard (input 0.000075 / 1K, output 0.000300 / 1K)
-- The registry stores the STANDARD (synchronous) rate — every cost ceiling
-- errs conservative by pricing a batch call at the synchronous rate. The
-- batch rate is applied to actual_cost attribution by the batch adapter
-- (lib/ai/providers/openaiBatchProvider.ts) which records its own pricing
-- basis. Pricing is versioned by `effective_from` and is admin-editable
-- through the existing /api/admin/ai/models/[id] route.
--
-- SEEDED INACTIVE AND UNAPPROVED. resolveModelForTask() only returns
-- active AND approved rows, and ai_admit_request() denies model_inactive /
-- model_not_approved for anything else, so merely applying this migration
-- to production can never route a request to OpenAI.
--
-- TOKEN CAPS. gpt-4o-mini's context window is 128k; the caps below are the
-- platform-side ceilings this task is allowed (an Insight Pack prompt is
-- ~15-25k chars of context JSON, well inside 32k input tokens; 3,000 output
-- tokens is the pack's fixed budget plus headroom). ai_admit_request()
-- enforces the LOWER of this row and ai_platform_controls.
--
-- fallback_model_id is NULL: no fallback is approved. A disabled/unknown
-- model is a refusal, not a redirect (Module 11.1 section 32).
-- ---------------------------------------------------------------------------
insert into ai_model_registry (
  provider, model_identifier, internal_tier, active, approved, task_types,
  max_input_tokens, max_output_tokens, supports_structured_output, supports_streaming, supports_batch,
  cost_input_per_1k_usd, cost_output_per_1k_usd, effective_from, rollout_percentage, fallback_model_id
) values (
  'openai', 'gpt-4o-mini', 'LOW_COST', false, false,
  array['monthly_insight_pack'],
  32000, 3200, true, false, true,
  0.000150, 0.000600, '2026-09-22T00:00:00Z', 100, null
) on conflict (provider, model_identifier) do nothing;

-- ---------------------------------------------------------------------------
-- C. R2 — the Insight Pack task's per-task cost limit already exists
-- (migration 0121: 0.50 USD/request, 50 USD/month, max tier STANDARD). The
-- real model is LOW_COST, which is within STANDARD, so no change is needed
-- here. Left as a note so the next reader does not go looking.
-- ---------------------------------------------------------------------------
