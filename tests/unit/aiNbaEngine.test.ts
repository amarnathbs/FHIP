// Module 11.6 — Rules-First Next Best Action: the full test estate (brief
// section 49). Engine tests are pure (no mocks); service/route tests
// substitute only the database and session, never the engine.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeContext } from './support/financialContextFixture';
import { evaluateNextBestActions, applySuppression, rankCandidates, hashContextForNba } from '@/lib/ai/nba/engine';
import { evaluateRules, NBA_RULES } from '@/lib/ai/nba/rules';
import { NBA_ACTION_CODES, NBA_MAX_ACTIONS, NBA_RANKING_POLICY_VERSION, NBA_RULES_VERSION, type NbaCandidate } from '@/lib/ai/nba/types';
import { AINextBestActionService, type NbaServiceDeps } from '@/lib/ai/nba/service';
import type { FinancialContextObject } from '@/lib/ai/context/types';

const base = () => makeContext();
const codes = (ctx: FinancialContextObject) => evaluateNextBestActions(ctx).actions.map((a) => a.action_code);
const risk = (code: string, severity: string, category = 'x') => ({ code, category, severity });

/** A "quiet" household: no risks, on-track goals, good score, resilient — must yield 0 actions. */
function quiet(): FinancialContextObject {
  const c = base();
  return makeContext({
    resilience: { ...c.resilience!, resilience_status: 'resilient', active_risks: [] },
    goals: c.goals.map((g) => ({ ...g, track_status: 'on_track' })),
    health_score: { ...c.health_score!, score_band: 'good', score_movement: 2 },
  });
}

describe('11.6 — every rule: positive and negative (brief section 49, section 41 provenance)', () => {
  it('quiet household -> 0 candidates, 0 actions, never padded', () => {
    const e = evaluateNextBestActions(quiet());
    expect(e.candidates).toEqual([]);
    expect(e.actions).toEqual([]);
    expect(e.provider_calls).toBe(0);
    expect(e.custom_quota_consumed).toBe(0);
  });

  const cases: [string, (c: FinancialContextObject) => FinancialContextObject, string][] = [
    ['MISSING_CRITICAL_INFORMATION', (c) => ({ ...c, data_quality: { ...c.data_quality, unavailable_modules: ['cash_flow'] } }), 'data_quality.unavailable_modules:cash_flow'],
    ['STALE_INFORMATION', (c) => ({ ...c, domain_certification: { ...c.domain_certification, balance_sheet: { ...c.domain_certification.balance_sheet, status: 'STALE' } } }), 'domain_certification:STALE:balance_sheet'],
    ['MISSING_RETIREMENT_DATA', (c) => ({ ...c, domain_certification: { ...c.domain_certification, retirement: { ...c.domain_certification.retirement, status: 'UNAVAILABLE' } } }), 'domain_certification.retirement:UNAVAILABLE'],
    ['MISSING_INSURANCE_DATA', (c) => ({ ...c, insurance: { ...c.insurance!, data_status: 'missing' } }), 'insurance.data_status:missing'],
    ['NEGATIVE_CASH_FLOW', (c) => ({ ...c, cash_flow: { ...c.cash_flow!, monthly_surplus_or_deficit: -250 } }), 'cash_flow.monthly_surplus_or_deficit:<0'],
    ['LIQUIDITY_WEAKNESS', (c) => ({ ...c, resilience: { ...c.resilience!, active_risks: [risk('low_emergency_fund', 'high', 'liquidity')] } }), 'resilience.active_risks:low_emergency_fund'],
    ['DEBT_PRESSURE', (c) => ({ ...c, resilience: { ...c.resilience!, active_risks: [risk('high_credit_utilization', 'high', 'debt')] } }), 'resilience.active_risks:high_credit_utilization'],
    ['INSURANCE_PROTECTION_GAP', (c) => ({ ...c, resilience: { ...c.resilience!, active_risks: [risk('no_life_insurance', 'high', 'insurance')] } }), 'resilience.active_risks:no_life_insurance'],
    ['ASSET_CONCENTRATION', (c) => ({ ...c, resilience: { ...c.resilience!, active_risks: [risk('property_concentration', 'medium', 'concentration')] } }), 'resilience.active_risks:property_concentration'],
    ['INCOME_CONCENTRATION', (c) => ({ ...c, resilience: { ...c.resilience!, active_risks: [risk('income_concentration', 'medium', 'income')] } }), 'resilience.active_risks:income_concentration'],
    ['OFF_TRACK_GOALS', (c) => ({ ...c, goals: [{ ...c.goals[0], track_status: 'off_track' }] }), 'goals[].track_status:off_track'],
    ['SCORE_WEAKNESS', (c) => ({ ...c, health_score: { ...c.health_score!, score_band: 'needs_attention' } }), 'health_score.score_band:needs_attention'],
    ['SCORE_DETERIORATION', (c) => ({ ...c, health_score: { ...c.health_score!, score_movement: -4 } }), 'health_score.score_movement:<0'],
    ['CROSS_BORDER_EXPOSURE', (c) => ({ ...c, household: { ...c.household!, cross_border_indicator: true } }), 'household.cross_border_indicator:true'],
    ['RESILIENCE_WEAKNESS', (c) => ({ ...c, resilience: { ...c.resilience!, resilience_status: 'fragile', active_risks: [] } }), 'resilience.resilience_status:fragile'],
  ];

  it.each(cases)('%s fires ONLY from its certified source and is absent otherwise', (code, mutate, sourceRef) => {
    const fired = evaluateRules(mutate(quiet()));
    const hit = fired.find((c) => c.action_code === code);
    expect(hit).toBeDefined();
    expect(hit!.source_ref).toBe(sourceRef);
    expect(hit!.evidence.length).toBeGreaterThan(0);
    expect(hit!.evidence.every((e) => e.source_path.length > 0)).toBe(true);
    expect(evaluateRules(quiet()).find((c) => c.action_code === code)).toBeUndefined();
  });

  it('the rule table covers exactly the closed action-code set and no rule invents a numeric threshold (only certified codes/bands/signs)', () => {
    expect(NBA_RULES.map((r) => r.code).sort()).toEqual([...NBA_ACTION_CODES].sort());
    const src = readFileSync(join(__dirname, '..', '..', 'lib', 'ai', 'nba', 'rules.ts'), 'utf8');
    // The only numeric comparisons permitted are sign tests against 0.
    const comparisons = src.match(/[<>]=?\s*\d+(\.\d+)?/g) ?? [];
    expect(comparisons.every((c) => /^[<>]=?\s*0$/.test(c))).toBe(true);
  });

  it('an unrecognised resilience risk code (not in the certified register) fires nothing', () => {
    const c = quiet();
    expect(codes({ ...c, resilience: { ...c.resilience!, active_risks: [risk('low_liquidity', 'critical')] } })).toEqual([]);
  });
});

describe('11.6 — suppression (section 45), ranking (section 43), maximum three (section 44)', () => {
  it('specific suppresses generic: a liquidity risk suppresses RESILIENCE_WEAKNESS; SCORE_WEAKNESS suppresses SCORE_DETERIORATION', () => {
    const c = quiet();
    const e = evaluateNextBestActions({ ...c, resilience: { ...c.resilience!, resilience_status: 'vulnerable', active_risks: [risk('low_emergency_fund', 'high')] }, health_score: { ...c.health_score!, score_band: 'critical', score_movement: -3 } });
    expect(e.candidates.map((x) => x.action_code).sort()).toEqual(['LIQUIDITY_WEAKNESS', 'RESILIENCE_WEAKNESS', 'SCORE_DETERIORATION', 'SCORE_WEAKNESS']);
    expect(e.suppressed.map((s) => `${s.action_code}<${s.suppressed_by}`).sort()).toEqual(['RESILIENCE_WEAKNESS<LIQUIDITY_WEAKNESS', 'SCORE_DETERIORATION<SCORE_WEAKNESS']);
    expect(e.actions.map((a) => a.action_code)).toEqual(['LIQUIDITY_WEAKNESS', 'SCORE_WEAKNESS']);
  });

  it('data-quality blocker suppresses unsupported financial conclusions: missing core data outranks and hides cash-flow/liquidity/debt/score conclusions', () => {
    const c = quiet();
    const e = evaluateNextBestActions({ ...c, data_quality: { ...c.data_quality, unavailable_modules: ['balance_sheet'] }, cash_flow: { ...c.cash_flow!, monthly_surplus_or_deficit: -1 }, resilience: { ...c.resilience!, active_risks: [risk('critical_liquidity', 'critical'), risk('high_credit_utilization', 'high')] }, health_score: { ...c.health_score!, score_band: 'critical' } });
    expect(e.actions.map((a) => a.action_code)).toEqual(['MISSING_CRITICAL_INFORMATION']);
    expect(e.suppressed.every((s) => s.suppressed_by === 'MISSING_CRITICAL_INFORMATION')).toBe(true);
    expect(e.suppressed.length).toBe(4);
  });

  it('missing insurance data suppresses a protection-gap conclusion (missing != none)', () => {
    const c = quiet();
    const e = evaluateNextBestActions({ ...c, insurance: { ...c.insurance!, data_status: 'missing' }, resilience: { ...c.resilience!, active_risks: [risk('no_life_insurance', 'high')] } });
    expect(e.actions.map((a) => a.action_code)).toEqual(['MISSING_INSURANCE_DATA']);
  });

  it('ranking: severity desc -> tier order -> alphabetical code; 1 and 2 actions come back as 1 and 2 (never padded)', () => {
    const c = quiet();
    const one = evaluateNextBestActions({ ...c, goals: [{ ...c.goals[0], track_status: 'at_risk' }] });
    expect(one.actions.map((a) => a.action_code)).toEqual(['OFF_TRACK_GOALS']);
    expect(one.actions[0].rank).toBe(1);
    const two = evaluateNextBestActions({ ...c, goals: [{ ...c.goals[0], track_status: 'at_risk' }], household: { ...c.household!, cross_border_indicator: true } });
    expect(two.actions.map((a) => [a.rank, a.action_code])).toEqual([[1, 'OFF_TRACK_GOALS'], [2, 'CROSS_BORDER_EXPOSURE']]); // medium beats low
    const tie: NbaCandidate[] = [
      { action_code: 'SCORE_WEAKNESS', tier: 'REVIEW', severity: 'medium', title: '', source_ref: '', evidence: [], related_module: '', action_route: '', suppresses: [] },
      { action_code: 'ASSET_CONCENTRATION', tier: 'CONCENTRATION', severity: 'medium', title: '', source_ref: '', evidence: [], related_module: '', action_route: '', suppresses: [] },
      { action_code: 'INCOME_CONCENTRATION', tier: 'CONCENTRATION', severity: 'medium', title: '', source_ref: '', evidence: [], related_module: '', action_route: '', suppresses: [] },
    ];
    expect(rankCandidates(tie).map((x) => x.action_code)).toEqual(['ASSET_CONCENTRATION', 'INCOME_CONCENTRATION', 'SCORE_WEAKNESS']); // tier, then alphabetical tie-break
  });

  it('>= 6 eligible candidates -> exactly 3 actions with ranks 1,2,3; candidates and suppression are still fully reported', () => {
    const c = quiet();
    const e = evaluateNextBestActions({
      ...c,
      cash_flow: { ...c.cash_flow!, monthly_surplus_or_deficit: -10 },
      resilience: { ...c.resilience!, active_risks: [risk('low_emergency_fund', 'high'), risk('high_credit_utilization', 'high'), risk('property_concentration', 'medium'), risk('income_concentration', 'medium')] },
      goals: [{ ...c.goals[0], track_status: 'off_track' }],
      household: { ...c.household!, cross_border_indicator: true },
      health_score: { ...c.health_score!, score_movement: -1 },
    });
    expect(e.candidates.length).toBeGreaterThanOrEqual(6);
    expect(e.actions.length).toBe(NBA_MAX_ACTIONS);
    expect(e.actions.map((a) => a.rank)).toEqual([1, 2, 3]);
    expect(e.actions.every((a) => a.severity === 'high')).toBe(true); // the three highs win; mediums/lows are candidates, not actions
  });
});

describe('11.6 — determinism, snapshot A/B, country rules, FX integrity', () => {
  it('same input -> byte-identical evaluation across 25 runs', () => {
    const c = base();
    const first = JSON.stringify(evaluateNextBestActions(c));
    for (let i = 0; i < 25; i++) expect(JSON.stringify(evaluateNextBestActions(c))).toBe(first);
  });

  it('snapshot A/B: different certified states carry different context hashes and different actions', () => {
    const a = evaluateNextBestActions(makeContext({ meta: { ...base().meta, snapshot_id: 'A' } }));
    const c = quiet();
    const b = evaluateNextBestActions({ ...makeContext({ meta: { ...c.meta, snapshot_id: 'B' }, resilience: { ...c.resilience!, active_risks: [risk('critical_liquidity', 'critical')] } }), goals: c.goals });
    expect(a.snapshot_id).toBe('A'); expect(b.snapshot_id).toBe('B');
    expect(a.context_hash).not.toBe(b.context_hash);
    expect(a.context_hash).toBe(hashContextForNba(makeContext({ meta: { ...base().meta, snapshot_id: 'A' } })));
    expect(b.actions[0].action_code).toBe('LIQUIDITY_WEAKNESS');
  });

  it('country rules: the same certified state yields the same action codes in AU and IN; labels/currency follow the household', () => {
    const c = quiet();
    const au = evaluateNextBestActions({ ...c, cash_flow: { ...c.cash_flow!, monthly_surplus_or_deficit: -500 }, domain_certification: { ...c.domain_certification, retirement: { ...c.domain_certification.retirement, status: 'UNAVAILABLE' } } });
    const inr = evaluateNextBestActions({ ...c, meta: { ...c.meta, country_of_residence: 'IN', reporting_currency: 'INR' }, household: { ...c.household!, country_of_residence: 'IN', reporting_currency: 'INR' }, cash_flow: { ...c.cash_flow!, monthly_surplus_or_deficit: -500 }, domain_certification: { ...c.domain_certification, retirement: { ...c.domain_certification.retirement, status: 'UNAVAILABLE' } } });
    expect(au.actions.map((a) => a.action_code)).toEqual(inr.actions.map((a) => a.action_code));
    expect(au.actions.find((a) => a.action_code === 'MISSING_RETIREMENT_DATA')!.title).toContain('superannuation');
    expect(inr.actions.find((a) => a.action_code === 'MISSING_RETIREMENT_DATA')!.title).toContain('EPF');
    expect(au.actions.find((a) => a.action_code === 'NEGATIVE_CASH_FLOW')!.evidence[0].value).toContain('AUD');
    expect(inr.actions.find((a) => a.action_code === 'NEGATIVE_CASH_FLOW')!.evidence[0].value).toContain('₹');
    expect(inr.reporting_currency).toBe('INR');
  });

  it('FX integrity: evidence is only ever the certified reporting-currency figure — never a sum across currencies, never a conversion', () => {
    const c = quiet();
    const e = evaluateNextBestActions({ ...c, cash_flow: { ...c.cash_flow!, monthly_surplus_or_deficit: -1234 }, balance_sheet: { ...c.balance_sheet!, currency_breakdown: [{ currency_code: 'AUD', value: 400000 }, { currency_code: 'INR', value: 9000000 }] } });
    const text = JSON.stringify(e.actions);
    expect(text).toContain('-$1,234 AUD');
    expect(text).not.toMatch(/INR|₹|9,000,000/);
    expect(text).not.toMatch(/\+\s*(AUD|INR)/);
  });
});

describe('11.6 — 20-household matrix (section 49)', () => {
  it('every household: 0..3 actions, contiguous ranks, no duplicate codes, deterministic, provider/quota structurally zero', () => {
    const c = quiet();
    const households: FinancialContextObject[] = [
      quiet(),
      base(),
      { ...c, cash_flow: { ...c.cash_flow!, monthly_surplus_or_deficit: -1 } },
      { ...c, resilience: { ...c.resilience!, active_risks: [risk('critical_liquidity', 'critical')] } },
      { ...c, resilience: { ...c.resilience!, active_risks: [risk('low_emergency_fund', 'high')] } },
      { ...c, resilience: { ...c.resilience!, active_risks: [risk('no_income_protection', 'medium')] } },
      { ...c, resilience: { ...c.resilience!, active_risks: [risk('refinancing_exposure', 'high'), risk('variable_rate_exposure', 'medium')] } },
      { ...c, resilience: { ...c.resilience!, resilience_status: 'vulnerable' } },
      { ...c, resilience: { ...c.resilience!, resilience_status: 'fragile', active_risks: [risk('property_concentration', 'high')] } },
      { ...c, health_score: { ...c.health_score!, score_band: 'critical' } },
      { ...c, health_score: { ...c.health_score!, score_movement: -9 } },
      { ...c, health_score: null },
      { ...c, insurance: { ...c.insurance!, data_status: 'missing' } },
      { ...c, insurance: null },
      { ...c, goals: [] },
      { ...c, goals: c.goals.map((g) => ({ ...g, track_status: 'off_track' })) },
      { ...c, data_quality: { ...c.data_quality, unavailable_modules: ['cash_flow', 'balance_sheet'] }, cash_flow: null, balance_sheet: null },
      { ...c, data_quality: { ...c.data_quality, stale_fields: ['assets.valuation'] } },
      { ...c, household: { ...c.household!, cross_border_indicator: true }, meta: { ...c.meta, country_of_residence: 'IN', reporting_currency: 'INR' } },
      { ...c, resilience: null, cash_flow: { ...c.cash_flow!, monthly_surplus_or_deficit: -100 }, goals: [{ ...c.goals[0], track_status: 'at_risk' }], household: { ...c.household!, cross_border_indicator: true }, health_score: { ...c.health_score!, score_band: 'needs_attention', score_movement: -2 } },
    ];
    expect(households.length).toBe(20);
    let withActions = 0;
    for (const h of households) {
      const e = evaluateNextBestActions(h);
      expect(e.actions.length).toBeLessThanOrEqual(3);
      expect(e.actions.map((a) => a.rank)).toEqual(e.actions.map((_, i) => i + 1));
      expect(new Set(e.actions.map((a) => a.action_code)).size).toBe(e.actions.length);
      expect(e.provider_calls).toBe(0);
      expect(e.custom_quota_consumed).toBe(0);
      expect(JSON.stringify(evaluateNextBestActions(h))).toBe(JSON.stringify(e));
      if (e.actions.length > 0) withActions += 1;
      for (const a of e.actions) expect(a.explanation).toContain(a.source_ref);
    }
    expect(withActions).toBeGreaterThanOrEqual(15);
  });
});

// ---------------------------------------------------------------------------
// Service + isolation
// ---------------------------------------------------------------------------
function deps(over: Partial<NbaServiceDeps> = {}): NbaServiceDeps & { recorded: unknown[] } {
  const recorded: unknown[] = [];
  return {
    recorded,
    isPersonalisedAiEligible: async () => true,
    getControls: async () => ({ ai_globally_enabled: true, next_best_action_enabled: true, live_provider_enabled: false } as never),
    buildContext: async () => base(),
    recordEvaluation: async (_u, _h, e, t) => { recorded.push({ e, t }); },
    ...over,
  };
}

describe('11.6 — service: entitlement, kill switches, provider independence (section 47), quota independence (section 48)', () => {
  it('Premium required; feature disabled by ai_globally_enabled=false or next_best_action_enabled=false; live_provider_enabled=false has NO effect', async () => {
    expect((await new AINextBestActionService(deps({ isPersonalisedAiEligible: async () => false })).evaluate('u', null)).status).toBe('PREMIUM_REQUIRED');
    expect((await new AINextBestActionService(deps({ getControls: async () => ({ ai_globally_enabled: false }) })).evaluate('u', null)).status).toBe('FEATURE_DISABLED');
    expect((await new AINextBestActionService(deps({ getControls: async () => ({ ai_globally_enabled: true, next_best_action_enabled: false }) })).evaluate('u', null)).status).toBe('FEATURE_DISABLED');
    expect((await new AINextBestActionService(deps({ getControls: async () => null })).evaluate('u', null)).status).toBe('FEATURE_DISABLED');
    const d = deps(); // live_provider_enabled=false in this fixture
    const r = await new AINextBestActionService(d).evaluate('u', null);
    expect(r.status).toBe('AVAILABLE');
    expect(r.provider_called).toBe(false);
    expect(r.custom_quota_consumed).toBe(false);
    expect(d.recorded.length).toBe(1);
  });

  it('uncertified context -> INSUFFICIENT_DATA; a context builder failure -> INSUFFICIENT_DATA; never a fabricated action', async () => {
    const bad = { ...base(), meta: { ...base().meta, certification_status: 'INVALID' as const } };
    expect((await new AINextBestActionService(deps({ buildContext: async () => bad })).evaluate('u', null)).status).toBe('INSUFFICIENT_DATA');
    expect((await new AINextBestActionService(deps({ buildContext: async () => { throw new Error('db down'); } })).evaluate('u', null)).status).toBe('INSUFFICIENT_DATA');
  });

  it('static import boundary: lib/ai/nba/** never imports a provider, the gateway or the admission path', () => {
    const dir = join(__dirname, '..', '..', 'lib', 'ai', 'nba');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      // Import statements only (the header comments NAME the forbidden modules on purpose).
      expect(src, f).not.toMatch(/from '@\/lib\/ai\/(gateway|providers)|admitAiRequest\(|reserveCustomQuestion\(|consumeCustomQuestion\(|ai_admit_request|fetch\(/);
    }
  });

  it('provider negative control: with the real adapter spied, 50 evaluations produce 0 adapter calls and 0 network calls', async () => {
    const { OpenAIProviderAdapter } = await import('@/lib/ai/providers/openaiProvider');
    const spy = vi.spyOn(OpenAIProviderAdapter.prototype, 'generateStructured');
    const originalFetch = globalThis.fetch;
    let net = 0;
    globalThis.fetch = (async () => { net += 1; throw new Error('no network'); }) as typeof fetch;
    try {
      const svc = new AINextBestActionService(deps());
      for (let i = 0; i < 50; i++) await svc.evaluate('u', null);
      expect(spy).not.toHaveBeenCalled();
      expect(net).toBe(0);
    } finally {
      spy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });
});

describe('11.6 — API route: cross-tenant and client tampering', () => {
  it('scope comes only from the session; query params / bodies naming another user are ignored; unauthenticated -> denied', async () => {
    vi.resetModules();
    let session: { userId: string; householdId: string | null } | null = { userId: 'me', householdId: null };
    vi.doMock('@/lib/ai/household/resolveHouseholdContext', () => ({
      resolveHouseholdContext: async () => (session ? { scope: session, forbidden: null } : { scope: null, forbidden: new Response(JSON.stringify({ error: 'unauthenticated' }), { status: 401 }) }),
    }));
    const evaluated: string[] = [];
    vi.doMock('@/lib/ai/nba/service', () => ({
      AINextBestActionService: class { async evaluate(userId: string) { evaluated.push(userId); return { status: 'AVAILABLE', note: 'n', provider_called: false, custom_quota_consumed: false, evaluation: { rules_version: 'r', ranking_policy_version: 'p', snapshot_id: 's', actions: [], suppressed: [] } }; } },
    }));
    const { GET } = await import('@/app/api/ai/next-best-actions/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.provider_called).toBe(false);
    expect(json.data.custom_quota_consumed).toBe(false);
    expect(evaluated).toEqual(['me']); // the handler takes no request input at all
    session = null;
    expect((await GET()).status).toBe(401);
    vi.doUnmock('@/lib/ai/household/resolveHouseholdContext'); vi.doUnmock('@/lib/ai/nba/service');
  });
});

describe('11.6 — SQ-AI-003 / SQ-AI-025 now resolve from the deterministic engine (section 46)', () => {
  it('SQ-AI-003 = rank-1 action; SQ-AI-025 = top <=3 in engine order; 0 actions -> NOT_APPLICABLE; origins DETERMINISTIC; provider/quota false', async () => {
    vi.resetModules();
    vi.doMock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: () => ({ insert: async () => ({ error: null }), select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { ai_globally_enabled: true, next_best_action_enabled: true }, error: null }) }) }) }));
    const { AIStandardQuestionService } = await import('@/lib/ai/standardQuestions/service');
    const { getQuestionDefinition } = await import('@/lib/ai/standardQuestions/catalogue');
    const fakeDeps = { buildContext: async () => base(), getUserCountry: async () => 'AU' as const, isPersonalisedAiEligible: async () => true };
    const c = quiet();
    const busy = { ...c, cash_flow: { ...c.cash_flow!, monthly_surplus_or_deficit: -10 }, resilience: { ...c.resilience!, active_risks: [risk('low_emergency_fund', 'high'), risk('property_concentration', 'medium')] }, goals: [{ ...c.goals[0], track_status: 'off_track' }] };
    const expected = evaluateNextBestActions(busy).actions;

    const q3 = await AIStandardQuestionService.resolveDefinition(fakeDeps, 'u', null, getQuestionDefinition('SQ-AI-003')!, busy);
    expect(q3.status).toBe('AVAILABLE');
    expect(q3.answer?.headline).toBe(`Focus first on: ${expected[0].title}`);
    expect(q3.answer_origins).toEqual(['DETERMINISTIC']);
    expect(q3.provider_called).toBe(false);
    expect(q3.custom_quota_consumed).toBe(false);
    expect(q3.source_refs[0].source_id).toBe(expected[0].source_ref);

    const q25 = await AIStandardQuestionService.resolveDefinition(fakeDeps, 'u', null, getQuestionDefinition('SQ-AI-025')!, busy);
    expect(q25.status).toBe('AVAILABLE');
    expect(q25.answer?.key_points.length).toBe(Math.min(3, expected.length));
    expect(q25.answer?.key_points.map((k) => k.split(' — ')[0])).toEqual(expected.slice(0, 3).map((a) => `${a.rank}. ${a.title}`));

    const none = await AIStandardQuestionService.resolveDefinition(fakeDeps, 'u', null, getQuestionDefinition('SQ-AI-025')!, quiet());
    expect(none.status).toBe('NOT_APPLICABLE');
    expect(none.answer).toBeNull();

    // Catalogue metadata agrees: no pack block, no stored source, deterministic only.
    for (const code of ['SQ-AI-003', 'SQ-AI-025']) {
      const def = getQuestionDefinition(code)!;
      expect(def.preferred_resolution_sources).toEqual(['DETERMINISTIC']);
      expect(def.stored_pack_block_codes).toEqual([]);
      expect(def.components).toEqual([]);
    }
    vi.doUnmock('@/lib/supabase/admin');
  });
});

describe('11.6 — migration 0178 (PGlite): audit row shape, max-3 CHECK, RLS select-own', () => {
  it('inserts a 3-action row, rejects a 4-action row, and a user session sees only its own rows', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '..', '..');
    const db = await PGlite.create();
    await db.exec(fs.readFileSync(path.join(root, 'scripts/db-rebuild-check/shim.sql'), 'utf8'));
    const migDir = path.join(root, 'supabase/migrations');
    for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
      await db.exec(fs.readFileSync(path.join(migDir, f), 'utf8').replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, ''));
      if (f.startsWith('0001')) await db.exec(fs.readFileSync(path.join(root, 'supabase/seed.sql'), 'utf8'));
    }
    const A = '44444444-4444-4444-4444-000000000001', B = '44444444-4444-4444-4444-000000000002';
    await db.exec(`insert into auth.users(id,email) values ('${A}','nba-a@example.test'),('${B}','nba-b@example.test');`);
    const { rows: ctl } = await db.query(`select next_best_action_enabled from ai_platform_controls where id='global'`);
    expect((ctl[0] as { next_best_action_enabled: boolean }).next_best_action_enabled).toBe(true);
    await db.query(`insert into ai_next_best_action_evaluations (user_id, context_hash, rules_version, ranking_policy_version, candidate_count, suppressed_count, action_count, action_codes, trigger) values ($1,'h',$2,$3,5,1,3,array['A','B','C'],'api')`, [A, NBA_RULES_VERSION, NBA_RANKING_POLICY_VERSION]);
    await expect(db.query(`insert into ai_next_best_action_evaluations (user_id, context_hash, rules_version, ranking_policy_version, candidate_count, suppressed_count, action_count, action_codes, trigger) values ($1,'h','r','p',6,0,4,array['A','B','C','D'],'api')`, [A])).rejects.toThrow();
    await expect(db.query(`insert into ai_next_best_action_evaluations (user_id, context_hash, rules_version, ranking_policy_version, candidate_count, suppressed_count, action_count, action_codes, trigger) values ($1,'h','r','p',6,0,2,array['A','B','C'],'api')`, [A])).rejects.toThrow(); // count must match codes
    await db.exec(`grant usage on schema public to authenticated; grant select on all tables in schema public to authenticated;`);
    await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub','${B}',false);`);
    const { rows: seenByB } = await db.query(`select count(*)::int n from ai_next_best_action_evaluations`);
    expect((seenByB[0] as { n: number }).n).toBe(0);
    await db.exec(`select set_config('request.jwt.claim.sub','${A}',false);`);
    const { rows: seenByA } = await db.query(`select count(*)::int n from ai_next_best_action_evaluations`);
    expect((seenByA[0] as { n: number }).n).toBe(1);
    await db.exec(`reset role;`);
    await db.close();
  }, 180_000);
});
