#!/usr/bin/env -S npx tsx --env-file=.env.local
// Module 11.4 — LIVE DEV verification of the REAL, imported
// lib/ai/standardQuestions/* code (not a shell-script reimplementation),
// against real hosted Supabase DEV (vqycarelcoijzwlpkpcz).
//
// scripts/module11_4_live_dev_standard_question_verification.mjs proves the
// underlying DATABASE-level invariants (entitlement RPC, quota ledger,
// ai_resolution_audit CHECK constraints, ai_insights RLS) the same way every
// other Module 11 *.mjs live-dev script does — it never imports application
// TypeScript. THIS script closes that gap for Module 11.4 specifically: it
// imports and calls the ACTUAL catalogueDb.ts / service.ts / audit.ts
// modules, so the exact fallback branch and status-mapping logic described
// in the completion report is proven to run, not merely asserted.
//
// buildFinancialContextObject() itself (and therefore
// AIStandardQuestionService.resolveQuestion()/listCatalogue()) requires a
// real Next.js request (cookies()-bound Supabase client) and cannot run
// standalone here — that end-to-end path is instead proven against a
// realistic in-memory FinancialContextObject fixture in
// tests/unit/aiStandardQuestionService.test.ts and
// tests/unit/aiStandardQuestionProviderProof.test.ts. What CAN run
// standalone (catalogueDb.ts and resolveDefinition()/resolveGoalRiskQuestion(),
// both of which take their dependencies as parameters rather than reading
// Next.js request state) is exercised here for real, against real DEV.
//
// Run: npx tsx --env-file=.env.local scripts/module11_4_live_dev_catalogue_fallback_verification.ts

process.on('uncaughtException', (e) => { console.error('UNCAUGHT: ' + (e instanceof Error ? e.stack : e)); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('REJECTED: ' + (e instanceof Error ? e.stack : e)); process.exit(9); });

const BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!BASE || !BASE.includes('vqycarelcoijzwlpkpcz')) {
  console.error(`FATAL: refusing to run — NEXT_PUBLIC_SUPABASE_URL (${BASE}) is not the known DEV project.`);
  process.exit(2);
}

let pass = 0, fail = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label} ${detail}`); }
  else { fail++; failures.push(label); console.log(`  FAIL  ${label} ${detail}`); }
}

async function main() {
  console.log(`Target: ${BASE}`);

  const { loadStandardQuestionCatalogue } = await import('../lib/ai/standardQuestions/catalogueDb');
  const { STANDARD_QUESTIONS } = await import('../lib/ai/standardQuestions/catalogue');
  const { AIStandardQuestionService } = await import('../lib/ai/standardQuestions/service');
  const { recordStandardQuestionAudit } = await import('../lib/ai/standardQuestions/audit');

  console.log('\n=== 1. Real catalogueDb.ts fallback against real (pre-migration) DEV ===');
  const result = await loadStandardQuestionCatalogue();
  check('loadStandardQuestionCatalogue() reports ok=true (schema-optional fallback engaged, not a fail-closed outage)', result.ok === true);
  check('all 25 approved codes are present via the code-catalogue fallback', result.questions.length === 25, `(count=${result.questions.length})`);
  check('every returned question is enabled by default (no admin override row exists yet)', result.questions.every((q) => q.enabled === true));
  check('the fallback result is reference-identical to the code catalogue (no silent mutation)', result.questions === STANDARD_QUESTIONS);

  console.log('\n=== 2. Real resolveDefinition()/resolveGoalRiskQuestion() against a realistic context (no DB needed for these two entry points) ===');
  const { makeContext } = await loadFixture();

  const def013 = STANDARD_QUESTIONS.find((q) => q.standard_question_code === 'SQ-AI-013')!;
  const r013 = await AIStandardQuestionService.resolveDefinition(fakeDeps(), 'live-dev-check', null, def013, makeContext());
  check('SQ-AI-013 is DEFERRED_CAPABILITY via the REAL imported service code', r013.status === 'DEFERRED_CAPABILITY', `(status=${r013.status})`);
  check('SQ-AI-013 reports provider_called=false / custom_quota_consumed=false', r013.provider_called === false && r013.custom_quota_consumed === false);

  const def021 = STANDARD_QUESTIONS.find((q) => q.standard_question_code === 'SQ-AI-021')!;
  const ctxNoOffTrack = makeContext({ goals: makeContext().goals.map((g) => ({ ...g, track_status: 'on_track' })) });
  const r021 = AIStandardQuestionService.resolveGoalRiskQuestion('live-dev-check', null, def021, ctxNoOffTrack, undefined);
  check('SQ-AI-021 with no off-track goals is NOT_APPLICABLE via the REAL imported service code', r021.status === 'NOT_APPLICABLE', `(status=${r021.status})`);

  console.log('\n=== 3. Real recordStandardQuestionAudit() against real (pre-migration) DEV — must never throw ===');
  let threw = false;
  try {
    await recordStandardQuestionAudit({ userId: '00000000-0000-0000-0000-000000000000', householdId: null, questionCode: 'SQ-AI-013', questionVersion: 1, status: 'DEFERRED_CAPABILITY', answerOrigins: [] });
  } catch {
    threw = true;
  }
  check('recordStandardQuestionAudit() is best-effort and never throws, even though standard_question_code/version/answer_origins columns do not exist in DEV yet', !threw);

  console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
  if (fail > 0) { console.log('FAILED CHECKS:', failures.join(' | ')); process.exit(1); }
}

function fakeDeps() {
  return {
    async buildContext() { throw new Error('buildContext should not be called by resolveDefinition() when ctx is supplied directly'); },
    async getUserCountry() { return 'AU' as const; },
    async isPersonalisedAiEligible() { return true; },
  };
}

// Inline minimal fixture (deliberately NOT importing tests/unit/support/* —
// this script has no dependency on the test tree) mirroring
// lib/ai/context/types.ts closely enough for the two entry points above,
// which only read `goals`/`domain_certification`.
async function loadFixture() {
  type FCO = import('../lib/ai/context/types').FinancialContextObject;

  function makeContext(overrides: Record<string, unknown> = {}): FCO {
    const domains = ['cash_flow', 'balance_sheet', 'score', 'financial_dna', 'resilience', 'investments', 'retirement', 'insurance', 'goals', 'forecasts', 'financial_twin', 'reports', 'cross_border'] as const;
    const domain_certification = Object.fromEntries(domains.map((d) => [d, { status: 'CERTIFIED' as const, reason: null, model_versions: [] as string[], data_as_of: null }]));
    const base = {
      meta: { context_version: 'test', generated_at: '2026-08-01', user_scope_identifier: 'u', household_scope_identifier: 'u', reporting_currency: 'AUD' as const, country_of_residence: 'AU', data_as_of: '2026-08-01', snapshot_id: null, source_snapshot_version: null, calculation_status: 'complete' as const, integrity_status: 'CERTIFIED' as const, currency_integrity_status: 'CERTIFIED' as const, data_completeness: null, certification_status: 'CERTIFIED' as const, request_scope: 'FULL' as const },
      household: null, cash_flow: null, balance_sheet: null, health_score: { overall_score: 70, score_band: 'good', pillar_scores: [] as { code: string; score: number | null; weight: number }[], principal_drivers: [] as string[], prior_valid_score: 68, score_movement: 2, confidence: 0.8, calculation_date: '2026-08-01', model_version: 'v1' },
      financial_dna: null, resilience: null, investments: null, retirement: null, insurance: null,
      goals: [{ goal_reference: 'g1', goal_type: 'holiday', goal_status: 'active', target_amount: 10000, current_funding: 1000, contribution: 100, target_date: null, track_status: 'at_risk', required_contribution: 400, forecast_completion_date: null, confidence: null, calculation_version: null }],
      forecasts: [] as FCO['forecasts'], financial_twin: null, risks: [] as FCO['risks'], recommendations: [] as FCO['recommendations'], reports: [] as FCO['reports'], cross_border: null,
      data_quality: { complete_domains: [] as FCO['data_quality']['complete_domains'], incomplete_domains: [] as FCO['data_quality']['incomplete_domains'], missing_fields: [] as string[], confirmed_zero_fields: [] as string[], stale_fields: [] as string[], rejected_records: [] as string[], excluded_duplicates: [] as string[], valuation_date_issues: [] as string[], unsupported_calculations: [] as string[], unavailable_modules: [] as FCO['data_quality']['unavailable_modules'], confidence_limitations: [] as string[] },
      domain_certification, source_references: [] as FCO['source_references'],
    };
    return { ...base, ...overrides } as FCO;
  }
  return { makeContext };
}

main().catch((e) => { console.error('FATAL: ' + (e instanceof Error ? e.stack : e)); process.exit(9); });
