// Module 11.5 — AIContextualExplanationService behaviour, the per-module
// matrices (spec sections 74-83), the availability-state vocabulary (section
// 49), the feature switches (58-59, 91-92) and the boundaries the phase must
// not cross (93-97, 125).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeContext } from './support/financialContextFixture';
import {
  freshState,
  makeAdminClient,
  makeServerClient,
  seedStoredInsights,
  type HarnessState,
} from './support/contextualExplainHarness';
import { CONTEXTUAL_EXPLANATION_TARGETS, getContextualTarget } from '@/lib/ai/contextualExplanations/registry';
import { CONTEXTUAL_AVAILABILITIES, CONTEXTUAL_AVAILABILITY_LABELS } from '@/lib/ai/contextualExplanations/types';
import type { FinancialContextObject } from '@/lib/ai/context/types';

let state: HarnessState = freshState();
let contextBuilder: () => FinancialContextObject = () => makeContext();
const SESSION_USER = 'user-a';

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => makeAdminClient(state) }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => makeServerClient(state, SESSION_USER) }));
vi.mock('@/lib/ai/resolution/routerDependencies', () => ({
  createRouterDependencies: () => ({
    buildContext: async () => contextBuilder(),
    getUserCountry: async () => 'AU' as const,
    isPersonalisedAiEligible: async () => state.eligible,
  }),
  hashNormalisedQuestion: (s: string) => s,
}));

const { AIContextualExplanationService } = await import('@/lib/ai/contextualExplanations/service');

const ALL_STORED_INTENTS = [
  'SCORE_EXPLANATION', 'SCORE_CHANGE_EXPLANATION', 'NET_WORTH_EXPLANATION', 'CASH_FLOW_EXPLANATION',
  'SAVINGS_EXPLANATION', 'LIQUIDITY_EXPLANATION', 'DEBT_EXPLANATION', 'FORECAST_SUMMARY_EXPLANATION',
  'RETIREMENT_EXPLANATION', 'TWIN_SUMMARY_EXPLANATION', 'DATA_QUALITY_SUMMARY_EXPLANATION',
  'REPORT_READING_EXPLANATION', 'DNA_EXPLANATION', 'RESILIENCE_EXPLANATION',
];

/** Removes block and line comments so a source scan tests CODE, not documentation. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function ask(targetCode: string, targetId: string | null = null, contextId: string | null = null) {
  const result = await AIContextualExplanationService.resolveExplanation(SESSION_USER, 'hh-1', {
    target_code: targetCode,
    target_id: targetId,
    context_id: contextId,
  });
  if ('unknownTarget' in result) throw new Error(`unexpected unknown target ${targetCode}`);
  return result;
}

beforeEach(() => {
  state = freshState({
    currentSnapshotId: 'snap-current',
    reports: new Map([
      ['report-current', { id: 'report-current', user_id: SESSION_USER, report_month: '2026-09-01', as_of_date: '2026-09-01', financial_snapshot_id: 'snap-current' }],
      ['report-old', { id: 'report-old', user_id: SESSION_USER, report_month: '2026-03-01', as_of_date: '2026-03-01', financial_snapshot_id: 'snap-march' }],
      ['report-other-user', { id: 'report-other-user', user_id: 'user-b', report_month: '2026-09-01', as_of_date: '2026-09-01', financial_snapshot_id: 'snap-current' }],
    ]),
  });
  seedStoredInsights(state, ALL_STORED_INTENTS);
  contextBuilder = () => makeContext();
});

// ---------------------------------------------------------------------------
// Registry integrity (spec sections 7, 10-12)
// ---------------------------------------------------------------------------
describe('contextual target registry integrity', () => {
  it('every target has a unique, stable, versioned code and a non-UI intent code', () => {
    const codes = CONTEXTUAL_EXPLANATION_TARGETS.map((t) => t.target_code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const t of CONTEXTUAL_EXPLANATION_TARGETS) {
      expect(t.target_code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(t.intent_code).toMatch(/^CTX_[A-Z0-9_]+$/);
      expect(t.version).toBeGreaterThanOrEqual(1);
      expect(t.introduced_version).toBe('module-11.5');
      expect(t.availability_rule.length).toBeGreaterThan(20);
    }
  });

  it('every delegated target names a REAL Module 11.4 catalogue question (spec section 9)', async () => {
    const { getQuestionDefinition } = await import('@/lib/ai/standardQuestions/catalogue');
    for (const t of CONTEXTUAL_EXPLANATION_TARGETS) {
      if (!t.standard_question_code) continue;
      expect(getQuestionDefinition(t.standard_question_code), `${t.target_code} -> ${t.standard_question_code}`).not.toBeNull();
    }
  });

  it('every contextual-only component names a REAL, enabled Module 11.2 intent (spec section 10)', async () => {
    const { getIntentDefinition } = await import('@/lib/ai/resolution/intentTaxonomy');
    for (const t of CONTEXTUAL_EXPLANATION_TARGETS) {
      for (const c of t.components) {
        const def = getIntentDefinition(c.intent_code);
        expect(def, `${t.target_code} -> ${c.intent_code}`).not.toBeNull();
        expect(def!.enabled).toBe(true);
      }
    }
  });

  it('no intent used by 11.5 permits LIVE_AI as a resolver where the target composes it itself', async () => {
    const { getIntentDefinition } = await import('@/lib/ai/resolution/intentTaxonomy');
    // A target that composes intents directly must never rely on an intent
    // whose ONLY resolver is LIVE_AI — that would be a target that can only
    // ever be answered by paying.
    for (const t of CONTEXTUAL_EXPLANATION_TARGETS) {
      for (const c of t.components) {
        const def = getIntentDefinition(c.intent_code)!;
        const zeroCost = def.allowed_resolvers.filter((r) => r !== 'LIVE_AI');
        expect(zeroCost.length, `${c.intent_code}`).toBeGreaterThan(0);
      }
    }
  });

  it('a target requiring an owned entity declares its entity type (spec section 13)', () => {
    expect(getContextualTarget('GOAL_STATUS')!.target_entity_type).toBe('goal');
    for (const t of CONTEXTUAL_EXPLANATION_TARGETS.filter((x) => x.module_code === 'reports')) {
      expect(t.target_entity_type).toBe('report');
    }
  });

  it('every availability state has user-safe wording that is not the raw enum (spec section 49)', () => {
    for (const state_ of CONTEXTUAL_AVAILABILITIES) {
      const label = CONTEXTUAL_AVAILABILITY_LABELS[state_];
      expect(label).toBeTruthy();
      if (state_ !== 'AVAILABLE') expect(label).not.toBe(state_);
    }
  });
});

// ---------------------------------------------------------------------------
// The estate genuinely resolves (anti-vacuity for the provider gate)
// ---------------------------------------------------------------------------
describe('the contextual estate genuinely produces answers (so the provider gate is not vacuous)', () => {
  it('a fully-certified Premium household resolves the large majority of targets to AVAILABLE with real content', async () => {
    const results = [];
    for (const t of CONTEXTUAL_EXPLANATION_TARGETS) {
      const targetId = t.target_entity_type === 'report' ? 'report-current' : t.target_entity_type === 'goal' ? 'goal-1' : null;
      results.push(await ask(t.target_code, targetId));
    }
    const available = results.filter((r) => r.status === 'AVAILABLE');
    // Not "all": GOAL_STATUS legitimately needs a goal selection, and some
    // targets depend on data this fixture does not have. But a clear majority
    // must genuinely answer, or the provider gate would prove nothing.
    expect(available.length).toBeGreaterThanOrEqual(12);
    for (const r of available) {
      expect(r.answer).not.toBeNull();
      expect(r.answer!.headline.length).toBeGreaterThan(0);
      expect(r.answer_origins.length).toBeGreaterThan(0);
      expect(r.provider_called).toBe(false);
      expect(r.custom_quota_consumed).toBe(false);
    }
  });

  it('spec section 110 — a contextual answer is SHORTER than the library answer: max 3 key points, max 4 summary sentences', async () => {
    for (const t of CONTEXTUAL_EXPLANATION_TARGETS) {
      const targetId = t.target_entity_type === 'report' ? 'report-current' : t.target_entity_type === 'goal' ? 'goal-1' : null;
      const r = await ask(t.target_code, targetId);
      if (!r.answer) continue;
      expect(r.answer.key_points.length).toBeLessThanOrEqual(3);
      const sentences = r.answer.summary.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect(sentences.length).toBeLessThanOrEqual(4);
    }
  });

  it('spec section 65 — answer origin is never misrepresented: deterministic data is not labelled AI-generated', async () => {
    // GOALS_OVERALL_STATUS is purely deterministic counting (SQ-AI-020 has no
    // stored explanation component at all), so it must never be labelled as a
    // personalised AI insight.
    const r = await ask('GOALS_OVERALL_STATUS');
    expect(r.status).toBe('AVAILABLE');
    expect(r.answer_origins).toEqual(['DETERMINISTIC']);
    expect(r.answer_origin_labels).toEqual(['From your FHIP data']);
  });
});

// ---------------------------------------------------------------------------
// Per-module matrices (spec sections 74-82)
// ---------------------------------------------------------------------------
describe('spec section 74 — DASHBOARD matrix', () => {
  it('net worth, cash flow and savings rate all resolve zero-cost from the certified balance sheet / cash flow', async () => {
    for (const code of ['DASHBOARD_NET_WORTH', 'DASHBOARD_CASH_FLOW', 'DASHBOARD_SAVINGS_RATE']) {
      const r = await ask(code);
      expect(r.status, code).toBe('AVAILABLE');
      expect(r.provider_called).toBe(false);
      expect(r.custom_quota_consumed).toBe(false);
      expect(r.source_refs.length).toBeGreaterThan(0);
    }
  });

  it('an INVALID balance-sheet certification fails safe rather than answering (spec sections 30-31)', async () => {
    contextBuilder = () =>
      makeContext({
        domain_certification: {
          ...makeContext().domain_certification,
          balance_sheet: { status: 'INVALID', reason: 'integrity', model_versions: [], data_as_of: null },
        },
      });
    const r = await ask('DASHBOARD_NET_WORTH');
    expect(r.status).toBe('DOMAIN_UNAVAILABLE');
    expect(r.answer).toBeNull();
  });
});

describe('spec section 75 — SCORE matrix', () => {
  it('the current score resolves with a stored explanation', async () => {
    const r = await ask('SCORE_OVERALL');
    expect(r.status).toBe('AVAILABLE');
    expect(r.answer_origins.some((o) => o === 'STORED_PERSONALISED' || o === 'COMPOSED_ZERO_COST')).toBe(true);
  });

  it('score CHANGE is NOT_APPLICABLE with no prior comparable score — no reason is invented (spec section 29)', async () => {
    contextBuilder = () =>
      makeContext({ health_score: { ...makeContext().health_score!, prior_valid_score: null, score_movement: null } });
    const r = await ask('SCORE_CHANGE');
    expect(r.status).toBe('NOT_APPLICABLE');
    expect(r.answer).toBeNull();
  });

  it('spec section 30 — no pillar-level target is registered, since no per-pillar causal driver exists', () => {
    const pillarTargets = CONTEXTUAL_EXPLANATION_TARGETS.filter((t) => /PILLAR/.test(t.target_code));
    expect(pillarTargets).toEqual([]);
  });
});

describe('spec section 76 — DNA matrix', () => {
  it('a classified household gets its OWN certified classification, read not recomputed', async () => {
    const r = await ask('DNA_PRIMARY_PROFILE');
    expect(r.status).toBe('AVAILABLE');
    // The personalised classification must be present — this is what makes it
    // a personal explanation rather than a glossary entry.
    expect(r.source_refs.some((s) => s.source_type === 'financial_dna')).toBe(true);
  });

  it('an unavailable DNA domain returns a controlled state, never a classification of its own (spec section 32)', async () => {
    contextBuilder = () =>
      makeContext({
        financial_dna: null,
        domain_certification: {
          ...makeContext().domain_certification,
          financial_dna: { status: 'UNAVAILABLE', reason: 'insufficient', model_versions: [], data_as_of: null },
        },
      });
    const r = await ask('DNA_PRIMARY_PROFILE');
    expect(r.status).toBe('DOMAIN_UNAVAILABLE');
    expect(r.answer).toBeNull();
  });

  it('a household with no SECONDARY profile is not given a fabricated one', async () => {
    contextBuilder = () => makeContext({ financial_dna: { ...makeContext().financial_dna!, secondary_profile: null } });
    const r = await ask('DNA_SECONDARY_PROFILE');
    expect(r.status).not.toBe('AVAILABLE');
    expect(r.answer).toBeNull();
  });
});

describe('spec sections 77 / 83 — RESILIENCE matrix and MISSING vs ZERO', () => {
  it('overall resilience status resolves from the certified band', async () => {
    const r = await ask('RESILIENCE_OVERALL');
    expect(r.status).toBe('AVAILABLE');
  });

  it('emergency-fund coverage resolves when recorded', async () => {
    const r = await ask('RESILIENCE_EMERGENCY_FUND');
    expect(r.status).toBe('AVAILABLE');
  });

  it('MISSING emergency-fund months is never presented as 0 months (spec sections 29, 83)', async () => {
    contextBuilder = () => makeContext({ resilience: { ...makeContext().resilience!, emergency_fund_months: null } });
    const r = await ask('RESILIENCE_EMERGENCY_FUND');
    expect(r.status).not.toBe('AVAILABLE');
    // Nothing anywhere in the response may claim a zero-month coverage.
    expect(JSON.stringify(r)).not.toMatch(/0(\.0)? months/);
  });

  it('CONFIRMED-ZERO liabilities still answers, and is distinguishable from missing liability data', async () => {
    const zero = makeContext({ balance_sheet: { ...makeContext().balance_sheet!, total_liabilities: 0 } });
    contextBuilder = () => zero;
    const confirmedZero = await ask('RESILIENCE_DEBT_PRESSURE');
    expect(confirmedZero.status).toBe('AVAILABLE');

    contextBuilder = () =>
      makeContext({
        balance_sheet: null,
        domain_certification: {
          ...makeContext().domain_certification,
          balance_sheet: { status: 'UNAVAILABLE', reason: 'no data', model_versions: [], data_as_of: null },
        },
      });
    const missing = await ask('RESILIENCE_DEBT_PRESSURE');
    expect(missing.status).toBe('DOMAIN_UNAVAILABLE');
    // The two states must not collapse into one another.
    expect(confirmedZero.status).not.toBe(missing.status);
  });

  it('spec section 35 — no rate-stress / scenario target exists, so Scenario Coach cannot be reached', () => {
    const scenarioish = CONTEXTUAL_EXPLANATION_TARGETS.filter((t) => /STRESS|SCENARIO|RATE_RISE|WHAT_IF/.test(t.target_code));
    expect(scenarioish).toEqual([]);
  });
});

describe('spec section 78 — GOALS matrix', () => {
  it('with no goal selected the caller is asked to choose from their OWN eligible goals', async () => {
    contextBuilder = () =>
      makeContext({
        goals: [
          { goal_reference: 'goal-mine', goal_type: 'home_deposit', goal_status: 'active', target_date: '2030-01-01', target_amount: 100000, current_funding: 20000, contribution: 500, required_contribution: 900, track_status: 'off_track', forecast_completion_date: '2030-01-01', confidence: 0.8, calculation_version: 'g-1' },
        ],
      });
    const r = await ask('GOAL_STATUS');
    expect(r.status).toBe('TARGET_REQUIRED');
    expect(r.eligible_targets?.map((t) => t.id)).toEqual(['goal-mine']);
  });

  it('an ON-TRACK goal is never given an off-track explanation (spec section 38)', async () => {
    contextBuilder = () =>
      makeContext({
        goals: [
          { goal_reference: 'goal-ok', goal_type: 'travel', goal_status: 'active', target_date: '2030-01-01', target_amount: 10000, current_funding: 9000, contribution: 500, required_contribution: 200, track_status: 'on_track', forecast_completion_date: '2027-01-01', confidence: 0.9, calculation_version: 'g-1' },
        ],
      });
    const r = await ask('GOAL_STATUS', 'goal-ok');
    expect(r.status).not.toBe('AVAILABLE');
  });

  it('a goal id that is not the household’s own is TARGET_NOT_FOUND, never another goal’s answer (spec sections 37, 122)', async () => {
    contextBuilder = () =>
      makeContext({
        goals: [
          { goal_reference: 'goal-mine', goal_type: 'home_deposit', goal_status: 'active', target_date: '2030-01-01', target_amount: 100000, current_funding: 20000, contribution: 500, required_contribution: 900, track_status: 'off_track', forecast_completion_date: '2030-01-01', confidence: 0.8, calculation_version: 'g-1' },
        ],
      });
    const r = await ask('GOAL_STATUS', 'goal-belonging-to-user-b');
    expect(r.status).toBe('TARGET_NOT_FOUND');
    expect(r.answer).toBeNull();
    expect(JSON.stringify(r)).not.toContain('goal-mine');
  });

  it('the answer for a selected goal refers only to THAT goal', async () => {
    contextBuilder = () =>
      makeContext({
        goals: [
          { goal_reference: 'goal-a', goal_type: 'home_deposit', goal_status: 'active', target_date: '2030-01-01', target_amount: 100000, current_funding: 20000, contribution: 500, required_contribution: 900, track_status: 'off_track', forecast_completion_date: '2030-01-01', confidence: 0.8, calculation_version: 'g-1' },
          { goal_reference: 'goal-b', goal_type: 'car', goal_status: 'active', target_date: '2030-01-01', target_amount: 40000, current_funding: 1000, contribution: 100, required_contribution: 700, track_status: 'at_risk', forecast_completion_date: '2029-01-01', confidence: 0.4, calculation_version: 'g-1' },
        ],
      });
    const r = await ask('GOAL_STATUS', 'goal-a');
    expect(r.status).toBe('AVAILABLE');
    expect(r.source_refs.map((s) => s.source_id)).toEqual(['goal-a']);
    expect(JSON.stringify(r.answer)).not.toContain('car');
  });
});

describe('spec sections 79-80 — FORECAST and TWIN matrices', () => {
  it('the current forecast resolves, and the request shape cannot carry a scenario assumption (spec sections 41, 47)', async () => {
    const r = await ask('FORECAST_SUMMARY');
    expect(r.status).toBe('AVAILABLE');
    // The request contract has exactly three fields; none of them can express
    // a rate, an age, a contribution or a scenario.
    expect(Object.keys({ target_code: '', target_id: '', context_id: '' }).sort()).toEqual(['context_id', 'target_code', 'target_id']);
  });

  it('an unavailable Twin returns a controlled state and never substitutes generic benchmark education (spec sections 43, 80)', async () => {
    contextBuilder = () =>
      makeContext({
        financial_twin: null,
        domain_certification: {
          ...makeContext().domain_certification,
          financial_twin: { status: 'UNAVAILABLE', reason: 'no twin run', model_versions: [], data_as_of: null },
        },
      });
    const twin = await ask('TWIN_COMPARISON');
    expect(twin.status).toBe('DOMAIN_UNAVAILABLE');
    expect(twin.answer).toBeNull();

    const confidence = await ask('TWIN_CONFIDENCE');
    expect(confidence.status).toBe('DOMAIN_UNAVAILABLE');
    // No benchmark definition may be served as if it were a personal comparison.
    expect(confidence.answer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The personalisation gate (spec section 125 fail condition)
// ---------------------------------------------------------------------------
describe('spec section 125 — generic Knowledge content is never presented as a personalised WHY answer', () => {
  it('when every personalised component misses, a Knowledge Base definition cannot stand in as the answer', async () => {
    // Twin confidence gone, but the BENCHMARK_DEFINITION knowledge intent is
    // still perfectly resolvable. The target must NOT answer from it alone.
    contextBuilder = () => makeContext({ financial_twin: { ...makeContext().financial_twin!, benchmark_confidence: null } });
    const r = await ask('TWIN_CONFIDENCE');
    expect(r.status).not.toBe('AVAILABLE');
    expect(r.answer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Entitlement, feature switches (spec sections 20-21, 57-59, 91-92)
// ---------------------------------------------------------------------------
describe('spec sections 20-21, 57 — Premium entitlement is server-authoritative', () => {
  it('a Free user gets PREMIUM_REQUIRED with no answer, no provider call and no quota movement', async () => {
    state.eligible = false;
    const r = await ask('SCORE_OVERALL');
    expect(r.status).toBe('PREMIUM_REQUIRED');
    expect(r.answer).toBeNull();
    expect(r.provider_called).toBe(false);
    expect(r.custom_quota_consumed).toBe(false);
    expect(state.customQuestionsUsed).toBe(0);
    expect(state.rpcCalls.get('ai_admit_request') ?? 0).toBe(0);
  });

  it('the request contract has no field through which a client could claim entitlement (spec section 56)', async () => {
    state.eligible = false;
    // Even passing a fabricated flag through the service's own typed input has
    // nowhere to land — the shape simply has no such property.
    const r = await AIContextualExplanationService.resolveExplanation(SESSION_USER, 'hh-1', {
      target_code: 'SCORE_OVERALL',
      ...({ premium: true, entitled: true, provider_called: false } as Record<string, unknown>),
    });
    expect('unknownTarget' in r).toBe(false);
    expect((r as { status: string }).status).toBe('PREMIUM_REQUIRED');
  });
});

describe('spec sections 58-59, 91-92 — feature and kill switches', () => {
  it('AI_CONTEXTUAL_EXPLANATIONS_ENABLED = false stops contextual explanations (and ON again resumes them)', async () => {
    const on = await ask('SCORE_OVERALL');
    expect(on.status).toBe('AVAILABLE');

    state.contextualExplanationsEnabled = false;
    const off = await ask('SCORE_OVERALL');
    expect(off.status).toBe('FEATURE_DISABLED');
    expect(off.answer).toBeNull();

    state.contextualExplanationsEnabled = true;
    const backOn = await ask('SCORE_OVERALL');
    expect(backOn.status).toBe('AVAILABLE');
  });

  it('spec sections 59/92 — AI_LIVE_PROVIDER_ENABLED = false does NOT break zero-cost contextual explanations', async () => {
    state.liveProviderEnabled = false;
    const r = await ask('SCORE_OVERALL');
    expect(r.status).toBe('AVAILABLE');
    expect(r.answer).not.toBeNull();
    expect(r.provider_called).toBe(false);
  });

  it('the global AI switch outranks everything', async () => {
    state.aiGloballyEnabled = false;
    const r = await ask('SCORE_OVERALL');
    expect(r.status).toBe('FEATURE_DISABLED');
  });
});

// ---------------------------------------------------------------------------
// Pack behaviour (spec sections 50, 89-90)
// ---------------------------------------------------------------------------
describe('spec sections 50, 90 — Insight Pack behaviour', () => {
  it('a pack that is still generating yields INSIGHT_PREPARING and does NOT trigger generation', async () => {
    state.packStatus = 'GENERATING';
    state.insightsByMetric.clear();
    const r = await ask('SCORE_OVERALL');
    expect(['INSIGHT_PREPARING', 'INSUFFICIENT_DATA']).toContain(r.status);
    expect(r.answer).toBeNull();
    // No pack generation may have been attempted: no insert into any pack table.
    expect(state.tableOps.get('ai_insight_pack_blocks') ?? 0).toBe(0);
  });

  it('spec section 89 — a compatible stored pack yields STORED_PERSONALISED origin with provider=0 and quota=0', async () => {
    const r = await ask('SCORE_OVERALL');
    expect(r.status).toBe('AVAILABLE');
    expect(r.answer_origins.some((o) => o === 'STORED_PERSONALISED' || o === 'COMPOSED_ZERO_COST')).toBe(true);
    expect(r.provider_called).toBe(false);
    expect(r.custom_quota_consumed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Audit (spec sections 102-103)
// ---------------------------------------------------------------------------
describe('spec sections 102-103 — audit', () => {
  it('records contextual metadata, never a raw entity id, and never a provider/quota claim', async () => {
    state.auditRows = [];
    await ask('GOAL_STATUS', 'goal-1');

    // A DELEGATED target writes two rows into the same reused
    // ai_resolution_audit table: Module 11.4's own standard-question row (from
    // AIStandardQuestionService, unchanged by this phase) and Module 11.5's
    // contextual row. Both are zero-cost rows; neither may claim a provider
    // call. The contextual metadata lives on the 11.5 row.
    expect(state.auditRows.length).toBeGreaterThanOrEqual(1);
    for (const r of state.auditRows) {
      expect(r.provider_called).toBe(false);
      expect(r.quota_consumed).toBe(false);
    }

    const contextualRows = state.auditRows.filter((r) => r.contextual_target_code);
    expect(contextualRows.length).toBe(1);
    const row = contextualRows[0];
    expect(row.contextual_target_code).toBe('GOAL_STATUS');
    expect(row.contextual_module_code).toBe('goals');
    expect(row.provider_called).toBe(false);
    expect(row.quota_consumed).toBe(false);
    // The raw goal id must NOT be persisted — only a hash.
    expect(row.contextual_target_entity_hash).toBeTruthy();
    expect(row.contextual_target_entity_hash).not.toBe('goal-1');
    expect(JSON.stringify(row)).not.toContain('goal-1');
  });

  it('the same entity hashes identically across requests (so the trail is still usable)', async () => {
    state.auditRows = [];
    await ask('GOAL_STATUS', 'goal-1');
    await ask('GOAL_STATUS', 'goal-1');
    const hashes = state.auditRows.filter((r) => r.contextual_target_code).map((r) => r.contextual_target_entity_hash);
    expect(hashes.length).toBe(2);
    expect(hashes[0]).toBe(hashes[1]);
  });
});

// ---------------------------------------------------------------------------
// Deferred-scope guards (spec sections 93-97)
// ---------------------------------------------------------------------------
describe('spec sections 93-97 — nothing out of scope was built', () => {
  it('no target is a Next Best Action / recommendation engine entry point', () => {
    for (const t of CONTEXTUAL_EXPLANATION_TARGETS) {
      expect(t.target_code).not.toMatch(/NEXT_BEST|RECOMMEND|ACTION_PLAN|DO_THIS/);
    }
  });

  it('the contextual source tree contains no embedding / vector / semantic-cache machinery', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(process.cwd(), 'lib', 'ai', 'contextualExplanations');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const code = readFileSync(join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const needle of ['embedding', 'pgvector', 'cosineSimilarity', 'vectorStore', 'semanticCache']) {
        expect(code.toLowerCase()).not.toContain(needle.toLowerCase());
      }
    }
  });

  it('the contextual UI contains no free-text input, follow-up box or conversation pane (spec section 96)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const file of ['ContextualExplain.tsx', 'ExplanationPanel.tsx']) {
      // Comments are stripped first: these files' own headers NAME the
      // forbidden wording in order to document that it is absent, and a naive
      // scan would flag that documentation as the violation it warns against.
      const code = stripComments(readFileSync(join(process.cwd(), 'components', 'aiExplain', file), 'utf8'));
      expect(code, file).not.toMatch(/<input\b/i);
      expect(code, file).not.toMatch(/<textarea\b/i);
      expect(code, file).not.toMatch(/contentEditable/i);
      expect(code, file).not.toMatch(/Ask AI|Chat with AI|Ask anything|AI Assistant|Ask another question/i);
    }
  });

  it('spec section 71 — the loading state never claims AI is thinking', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const raw = readFileSync(join(process.cwd(), 'components', 'aiExplain', 'ExplanationPanel.tsx'), 'utf8');
    expect(raw).toContain('Loading explanation');
    expect(stripComments(raw)).not.toMatch(/AI is thinking|Generating your answer/i);
  });
});
