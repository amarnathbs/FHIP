// Module 11.5 — the controlled contextual target registry (spec sections
// 7, 9-12). Code/config, following the same "stable taxonomy lives in code"
// precedent as lib/ai/resolution/intentTaxonomy.ts and
// lib/ai/standardQuestions/catalogue.ts; the mutable admin-controlled subset
// (enabled/display_order) is additionally DB-backed by migration 0126.
//
// SPEC SECTION 7 — "DO NOT ADD EXPLAIN EVERYWHERE". This registry is
// deliberately small: 20 targets across 8 modules (dashboard 4, score 2,
// dna 2, resilience 3, goals 2, forecast 2, twin 2, reports 3), every one
// attached to a materially meaningful metric/status that a user plausibly
// asks "why?" about AND that a certified zero-cost source can genuinely
// answer. Values that are decorative, self-explanatory, or unanswerable from
// certified data have no target and get no button — which is why there is no
// pillar-level Score target and no rate-stress target (see the SCORE and
// RESILIENCE sections below for the specific reasons).
//
// SPEC SECTION 9 — REUSE. 12 of the 20 targets delegate wholesale to an
// EXISTING Module 11.4 standard question. Only 8 declare their own
// composition, and every one of those composes ALREADY-EXISTING Module 11.2
// intent codes (lib/ai/resolution/intentTaxonomy.ts). Exactly ONE new intent
// was added anywhere in this phase (REPORT_READING_EXPLANATION) — see that
// file's Module 11.5 section for why.

import type { ContextualExplanationTarget, ContextualModule } from '@/lib/ai/contextualExplanations/types';

export const CONTEXTUAL_TARGETS_INTRODUCED_VERSION = 'module-11.5';

type TargetInput = Omit<ContextualExplanationTarget, 'version' | 'enabled' | 'introduced_version' | 'components' | 'standard_question_code' | 'country_scope' | 'premium_required'> &
  Partial<Pick<ContextualExplanationTarget, 'components' | 'standard_question_code' | 'country_scope' | 'premium_required'>>;

function t(def: TargetInput): ContextualExplanationTarget {
  return {
    components: [],
    standard_question_code: null,
    country_scope: null,
    premium_required: true,
    ...def,
    version: 1,
    enabled: true,
    introduced_version: CONTEXTUAL_TARGETS_INTRODUCED_VERSION,
  };
}

/** Shorthand for a target that delegates entirely to a Module 11.4 catalogue question. */
function delegated(
  def: Omit<TargetInput, 'components'> & { standard_question_code: string }
): ContextualExplanationTarget {
  return t(def);
}

export const CONTEXTUAL_EXPLANATION_TARGETS: ContextualExplanationTarget[] = [
  // =========================================================================
  // DASHBOARD (spec sections 23-26)
  // =========================================================================
  delegated({
    target_code: 'DASHBOARD_NET_WORTH',
    module_code: 'dashboard',
    display_label: 'Explain',
    display_question: 'What makes up my net worth?',
    intent_code: 'CTX_DASHBOARD_NET_WORTH_EXPLAIN',
    standard_question_code: 'SQ-AI-009',
    required_domains: ['balance_sheet'],
    target_entity_type: null,
    stored_pack_block_codes: ['net_worth_explanation'],
    availability_rule: 'Balance-sheet domain certified; composes the certified net worth with the stored net-worth explanation where one exists.',
    related_module: 'dashboard',
    action_route: '/dashboard',
  }),
  delegated({
    target_code: 'DASHBOARD_CASH_FLOW',
    module_code: 'dashboard',
    display_label: 'Explain',
    display_question: 'How strong is my monthly cash flow?',
    intent_code: 'CTX_DASHBOARD_CASH_FLOW_EXPLAIN',
    standard_question_code: 'SQ-AI-006',
    required_domains: ['cash_flow'],
    target_entity_type: null,
    stored_pack_block_codes: ['cash_flow_explanation'],
    availability_rule: 'Cash-flow domain certified. Never recalculates surplus (spec section 25) — reads the certified figure only.',
    related_module: 'dashboard',
    action_route: '/dashboard',
  }),
  delegated({
    target_code: 'DASHBOARD_SAVINGS_RATE',
    module_code: 'dashboard',
    display_label: 'Explain',
    display_question: 'What does my savings rate mean?',
    intent_code: 'CTX_DASHBOARD_SAVINGS_RATE_EXPLAIN',
    standard_question_code: 'SQ-AI-007',
    required_domains: ['cash_flow'],
    target_entity_type: null,
    stored_pack_block_codes: ['savings_explanation'],
    availability_rule: 'Cash-flow domain certified and a savings rate is recorded (a missing rate is never shown as 0%).',
    related_module: 'dashboard',
    action_route: '/dashboard',
  }),
  t({
    // Contextual-only: no Module 11.4 question covers the data-quality panel,
    // and both intents it composes already exist.
    target_code: 'DASHBOARD_DATA_QUALITY',
    module_code: 'dashboard',
    display_label: 'Explain',
    display_question: 'What does my data quality state mean?',
    intent_code: 'CTX_DASHBOARD_DATA_QUALITY_EXPLAIN',
    components: [
      { role: 'metric', intent_code: 'DATA_COMPLETENESS', required: true },
      { role: 'metric', intent_code: 'STALE_DATA_AREAS', required: false },
      { role: 'explanation', intent_code: 'DATA_QUALITY_SUMMARY_EXPLANATION', required: false },
    ],
    required_domains: [],
    target_entity_type: null,
    stored_pack_block_codes: ['data_quality_summary'],
    availability_rule: 'Always answerable from the certified context; the stored data-quality commentary is added when a compatible pack exists.',
    related_module: 'dashboard',
    action_route: '/dashboard',
  }),

  // =========================================================================
  // SCORE (spec sections 27-30)
  //
  // Pillar-level Why? is DELIBERATELY ABSENT (spec section 30). The certified
  // context exposes pillar VALUES (ScoreSection.pillar_scores) but no
  // per-pillar causal driver — lib/ai/resolution/deterministicResolver.ts's
  // WHY_EXTRACTORS.SCORE_EXPLANATION returns null by design for exactly this
  // reason. A pillar "explanation" built from (code, score, weight) would
  // restate a number the user can already see while implying causation that
  // no engine asserted. Section 30: "If not: defer pillar-level explanation."
  // =========================================================================
  delegated({
    target_code: 'SCORE_OVERALL',
    module_code: 'score',
    display_label: 'Why?',
    display_question: 'Why is my Financial Health Score what it is?',
    intent_code: 'CTX_SCORE_OVERALL_EXPLAIN',
    standard_question_code: 'SQ-AI-004',
    required_domains: ['score'],
    target_entity_type: null,
    stored_pack_block_codes: ['score_explanation'],
    availability_rule: 'Score domain certified. Never reverse-engineers the scoring model (spec section 27) — reads the certified score plus the stored score explanation.',
    related_module: 'score',
    action_route: '/score',
  }),
  delegated({
    target_code: 'SCORE_CHANGE',
    module_code: 'score',
    display_label: 'Why did this change?',
    display_question: 'Why did my score change?',
    intent_code: 'CTX_SCORE_CHANGE_EXPLAIN',
    standard_question_code: 'SQ-AI-005',
    required_domains: ['score'],
    target_entity_type: null,
    stored_pack_block_codes: ['score_change_explanation'],
    availability_rule: 'NOT_APPLICABLE when no prior comparable score exists (spec section 29) — a movement reason is never invented.',
    related_module: 'score',
    action_route: '/score',
  }),

  // =========================================================================
  // FINANCIAL DNA (spec sections 31-32)
  //
  // No Module 11.4 question covers DNA and no `dna_explanation` Insight Pack
  // block exists (lib/ai/insightPack/types.ts PACK_BLOCK_CODES), so these are
  // contextual-only compositions over existing intents. DNA_EXPLANATION is
  // declared OPTIONAL: the deterministic WHY extractor for it returns null by
  // design and there is no stored block, so requiring it would make DNA
  // permanently unavailable. The certified classification itself is the
  // personalised content (spec section 32 — never reclassify).
  // =========================================================================
  t({
    target_code: 'DNA_PRIMARY_PROFILE',
    module_code: 'dna',
    display_label: 'Explain',
    display_question: 'What does my Financial DNA profile mean?',
    intent_code: 'CTX_DNA_PRIMARY_EXPLAIN',
    components: [
      { role: 'metric', intent_code: 'DNA_PRIMARY_PROFILE', required: true },
      { role: 'definition', intent_code: 'FINANCIAL_DNA_DEFINITION', required: false },
      { role: 'explanation', intent_code: 'DNA_EXPLANATION', required: false },
    ],
    required_domains: ['financial_dna'],
    target_entity_type: null,
    stored_pack_block_codes: [],
    availability_rule: 'Financial DNA domain certified and a primary profile is classified. The classification is read, never recomputed (spec section 32).',
    related_module: 'financial_dna',
    action_route: '/dna',
  }),
  t({
    target_code: 'DNA_SECONDARY_PROFILE',
    module_code: 'dna',
    display_label: 'Explain',
    display_question: 'What does my secondary Financial DNA trait mean?',
    intent_code: 'CTX_DNA_SECONDARY_EXPLAIN',
    components: [
      { role: 'metric', intent_code: 'DNA_SECONDARY_PROFILE', required: true },
      { role: 'definition', intent_code: 'FINANCIAL_DNA_DEFINITION', required: false },
    ],
    required_domains: ['financial_dna'],
    target_entity_type: null,
    stored_pack_block_codes: [],
    availability_rule: 'Only when a secondary profile is actually classified — NOT_APPLICABLE otherwise, never a fabricated second trait.',
    related_module: 'financial_dna',
    action_route: '/dna',
  }),

  // =========================================================================
  // RESILIENCE (spec sections 33-35)
  //
  // Rate stress is DELIBERATELY ABSENT (spec section 35). The Resilience
  // stress panel is ephemeral — it POSTs /api/resilience/scenario and stores
  // nothing — and ResilienceSection.stress_test_outputs is unconditionally
  // empty in the certified context. There is therefore no EXISTING certified
  // stress result for 11.5 to explain, and producing one would be Scenario
  // Coach. This matches SQ-AI-013's own DEFERRED_CAPABILITY handling.
  // =========================================================================
  t({
    target_code: 'RESILIENCE_OVERALL',
    module_code: 'resilience',
    display_label: 'Explain',
    display_question: 'What does my Financial Resilience status mean?',
    intent_code: 'CTX_RESILIENCE_OVERALL_EXPLAIN',
    components: [
      { role: 'metric', intent_code: 'RESILIENCE_STATUS', required: true },
      { role: 'definition', intent_code: 'FINANCIAL_RESILIENCE_DEFINITION', required: false },
      { role: 'explanation', intent_code: 'RESILIENCE_EXPLANATION', required: false },
    ],
    required_domains: ['resilience'],
    target_entity_type: null,
    stored_pack_block_codes: [],
    availability_rule: 'Resilience domain certified. Reads the certified status band; never recalculates resilience or runs a stress scenario (spec sections 35, 45).',
    related_module: 'resilience',
    action_route: '/resilience',
  }),
  delegated({
    target_code: 'RESILIENCE_EMERGENCY_FUND',
    module_code: 'resilience',
    display_label: 'Explain',
    display_question: 'Do I have enough emergency savings?',
    intent_code: 'CTX_RESILIENCE_EMERGENCY_FUND_EXPLAIN',
    standard_question_code: 'SQ-AI-011',
    required_domains: ['resilience'],
    target_entity_type: null,
    stored_pack_block_codes: ['liquidity_explanation'],
    availability_rule: 'Resilience domain certified and emergency-fund months recorded. No independent threshold logic lives in 11.5 (spec section 34).',
    related_module: 'resilience',
    action_route: '/resilience',
  }),
  delegated({
    target_code: 'RESILIENCE_DEBT_PRESSURE',
    module_code: 'resilience',
    display_label: 'Explain',
    display_question: 'How much debt pressure do I have?',
    intent_code: 'CTX_RESILIENCE_DEBT_PRESSURE_EXPLAIN',
    standard_question_code: 'SQ-AI-012',
    required_domains: ['balance_sheet'],
    target_entity_type: null,
    stored_pack_block_codes: ['debt_explanation'],
    availability_rule: 'Balance-sheet domain certified. Confirmed-zero liabilities and missing liability data stay distinguishable (spec section 83).',
    related_module: 'liabilities',
    action_route: '/liabilities',
  }),

  // =========================================================================
  // GOALS (spec sections 36-38)
  // =========================================================================
  delegated({
    target_code: 'GOALS_OVERALL_STATUS',
    module_code: 'goals',
    display_label: 'Explain',
    display_question: 'Which of my goals are on track?',
    intent_code: 'CTX_GOALS_OVERALL_EXPLAIN',
    standard_question_code: 'SQ-AI-020',
    required_domains: ['goals'],
    target_entity_type: null,
    stored_pack_block_codes: [],
    availability_rule: 'Goals domain certified. Counts certified per-goal track statuses; runs no new forecast (spec section 46).',
    related_module: 'goals',
    action_route: '/goals',
  }),
  delegated({
    // Spec sections 37-38: requires one of the caller's OWN off-track goals.
    // Ownership is enforced server-side by AIStandardQuestionService, which
    // only ever matches against ctx.goals — the authenticated household's own
    // goals. A goal_id belonging to another user is indistinguishable from
    // one that does not exist (both TARGET_NOT_FOUND).
    //
    // Spec section 38: an ON-TRACK goal is NOT given an off-track explanation
    // — SQ-AI-021 returns NOT_APPLICABLE when nothing is off track, and
    // TARGET_NOT_FOUND for an on-track goal id.
    target_code: 'GOAL_STATUS',
    module_code: 'goals',
    display_label: 'Why?',
    display_question: 'Why is this goal off track?',
    intent_code: 'CTX_GOAL_STATUS_EXPLAIN',
    standard_question_code: 'SQ-AI-021',
    required_domains: ['goals'],
    target_entity_type: 'goal',
    stored_pack_block_codes: [],
    availability_rule: 'Requires a goal_id owned by the authenticated household AND currently off-track/at-risk. Never answers with another goal’s explanation.',
    related_module: 'goals',
    action_route: '/goals',
  }),

  // =========================================================================
  // FORECASTING (spec sections 39-41)
  // =========================================================================
  delegated({
    target_code: 'FORECAST_SUMMARY',
    module_code: 'forecast',
    display_label: 'Explain',
    display_question: 'What does my forecast mean?',
    intent_code: 'CTX_FORECAST_SUMMARY_EXPLAIN',
    standard_question_code: 'SQ-AI-022',
    required_domains: ['forecasts'],
    target_entity_type: null,
    stored_pack_block_codes: ['forecast_summary'],
    availability_rule:
      'Forecast domain certified and a base-case run exists. Explains the CURRENTLY DISPLAYED forecast only — no assumption, rate, age or scenario input is accepted (spec sections 41, 47).',
    related_module: 'forecasting',
    action_route: '/forecast',
  }),
  delegated({
    target_code: 'FORECAST_RETIREMENT',
    module_code: 'forecast',
    display_label: 'Explain',
    display_question: 'What is affecting my retirement forecast?',
    intent_code: 'CTX_FORECAST_RETIREMENT_EXPLAIN',
    standard_question_code: 'SQ-AI-017',
    required_domains: ['forecasts', 'retirement'],
    target_entity_type: null,
    stored_pack_block_codes: ['forecast_summary', 'retirement_explanation'],
    availability_rule: 'Forecast AND retirement domains certified. Reads the stored grounded forecast commentary; never re-runs the projection.',
    related_module: 'forecasting',
    action_route: '/forecast/retirement',
  }),

  // =========================================================================
  // FINANCIAL TWIN (spec sections 42-43)
  // =========================================================================
  delegated({
    target_code: 'TWIN_COMPARISON',
    module_code: 'twin',
    display_label: 'Explain',
    display_question: 'How do I compare with my Financial Twin?',
    intent_code: 'CTX_TWIN_COMPARISON_EXPLAIN',
    standard_question_code: 'SQ-AI-023',
    required_domains: ['financial_twin'],
    target_entity_type: null,
    stored_pack_block_codes: ['twin_summary'],
    availability_rule:
      'Financial Twin domain certified. DOMAIN_UNAVAILABLE with no Twin comparison — generic benchmark education is never substituted for a personal comparison (spec section 43).',
    related_module: 'financial_twin',
    action_route: '/financial-twin',
  }),
  t({
    target_code: 'TWIN_CONFIDENCE',
    module_code: 'twin',
    display_label: 'What does this mean?',
    display_question: 'What does my Twin benchmark confidence mean?',
    intent_code: 'CTX_TWIN_CONFIDENCE_EXPLAIN',
    components: [
      { role: 'metric', intent_code: 'TWIN_CONFIDENCE', required: true },
      { role: 'definition', intent_code: 'BENCHMARK_DEFINITION', required: false },
    ],
    required_domains: ['financial_twin'],
    target_entity_type: null,
    stored_pack_block_codes: [],
    availability_rule: 'Only when a certified Twin run records a benchmark confidence. Never invents a confidence figure.',
    related_module: 'financial_twin',
    action_route: '/financial-twin',
  }),

  // =========================================================================
  // REPORTS (spec sections 44-48, 64)
  //
  // Every reports target REQUIRES a report_id and is resolved strictly within
  // that report's own certified context. The service additionally binds each
  // request to the report's `financial_snapshot_id` and compares it with the
  // household's CURRENT snapshot: an explanation opened from a historical
  // report never resolves against today's figures (spec sections 46-48).
  // =========================================================================
  t({
    target_code: 'REPORT_OVERVIEW',
    module_code: 'reports',
    display_label: 'Explain',
    display_question: 'What period and data does this report cover?',
    intent_code: 'CTX_REPORT_OVERVIEW_EXPLAIN',
    // No generic components, deliberately. This target has a DEDICATED
    // handler (AIContextualExplanationService.resolveReportOverview) because
    // the obvious candidates — REPORT_PERIOD / REPORT_VERSION — are hardwired
    // to `ctx.reports[0]`, the household's MOST RECENT report
    // (lib/ai/resolution/deterministicResolver.ts). Composing them for a
    // target that names a SPECIFIC report_id would answer about the wrong
    // report: open a March report, be told September's period. That is exactly
    // the cross-context substitution spec section 48 forbids, so the handler
    // reads the ownership-checked report row itself and adds the stored
    // household-level report-reading commentary ONLY when the report is the
    // current snapshot. Same "dedicated handler for a rule the generic engine
    // cannot express" precedent as Module 11.4's SQ-AI-013/SQ-AI-021.
    components: [],
    required_domains: ['reports'],
    target_entity_type: 'report',
    stored_pack_block_codes: ['report_reading_summary'],
    availability_rule:
      'Requires a report_id owned by the authenticated household. Resolved from that report’s own certified record, so it is equally valid for a current or a historical report.',
    related_module: 'reports',
    action_route: '/reports',
  }),
  t({
    target_code: 'REPORT_SCORE',
    module_code: 'reports',
    display_label: 'Explain',
    display_question: 'What does the Financial Health Score in this report mean?',
    intent_code: 'CTX_REPORT_SCORE_EXPLAIN',
    components: [
      { role: 'metric', intent_code: 'FINANCIAL_HEALTH_SCORE', required: true },
      { role: 'explanation', intent_code: 'SCORE_EXPLANATION', required: false },
    ],
    required_domains: ['score', 'reports'],
    target_entity_type: 'report',
    stored_pack_block_codes: ['score_explanation'],
    availability_rule:
      'Requires a report_id owned by the household AND bound to the household’s CURRENT financial snapshot. For a historical report this returns HISTORICAL_EXPLANATION_UNAVAILABLE rather than answering with today’s score (spec sections 46-48).',
    related_module: 'score',
    action_route: '/score',
  }),
  t({
    target_code: 'REPORT_CASH_FLOW',
    module_code: 'reports',
    display_label: 'Explain',
    display_question: 'What does the cash-flow section of this report mean?',
    intent_code: 'CTX_REPORT_CASH_FLOW_EXPLAIN',
    components: [
      { role: 'metric', intent_code: 'MONTHLY_SURPLUS', required: true },
      { role: 'explanation', intent_code: 'CASH_FLOW_EXPLANATION', required: false },
    ],
    required_domains: ['cash_flow', 'reports'],
    target_entity_type: 'report',
    stored_pack_block_codes: ['cash_flow_explanation'],
    availability_rule:
      'Requires a report_id owned by the household AND bound to the current financial snapshot; HISTORICAL_EXPLANATION_UNAVAILABLE for an older report.',
    related_module: 'dashboard',
    action_route: '/dashboard',
  }),
];

/**
 * Report targets whose answer would necessarily be composed from CURRENT
 * household figures. Explicitly listed rather than inferred, so that adding a
 * report target without deciding its snapshot semantics is impossible to do
 * silently (spec sections 46-48).
 */
export const CURRENT_SNAPSHOT_BOUND_REPORT_TARGETS: ReadonlySet<string> = new Set(['REPORT_SCORE', 'REPORT_CASH_FLOW']);

const BY_CODE = new Map(CONTEXTUAL_EXPLANATION_TARGETS.map((x) => [x.target_code, x]));

export function getContextualTarget(targetCode: string): ContextualExplanationTarget | null {
  return BY_CODE.get(targetCode) ?? null;
}

export function listContextualTargetsForModule(moduleCode: ContextualModule): ContextualExplanationTarget[] {
  return CONTEXTUAL_EXPLANATION_TARGETS.filter((x) => x.module_code === moduleCode && x.enabled);
}
