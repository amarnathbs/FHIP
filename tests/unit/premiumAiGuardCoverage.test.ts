// Coverage guard: every place in the product that can START a chargeable AI
// document reading must go through the shared Premium-entitlement check, and
// the retired pilot allowlists must not creep back (14-10-2026).
//
// This is the test that makes "a new route / service reaches the provider
// without checking the plan" a FAILURE rather than a silent gap. It walks the
// source tree for the call shapes that reach an AI provider and requires each
// file to either (a) contain the shared guard, or (b) be listed below as a
// building block that has no request entry point of its own, with the reason.
//
// A NEGATIVE CONTROL at the bottom proves the scanner is not vacuous: the same
// scan over a synthetic file that reaches a provider with no guard reports it.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.setConfig({ testTimeout: 120000 });

const ROOT = path.resolve(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Call shapes that reach (or construct the path to) an AI provider. */
const PROVIDER_REACHING =
  /new AieDocumentAiGateway\(|resolveAieDocumentProvider\(|new AIModelGateway\(|requestAdapterDocumentFacts\(|request(Payslip|BankStatement|AuInvestment|Liability|Retirement|Insurance)[A-Za-z]*AiExtraction\(|\.requestFieldCompletion\(/;

const GUARD = /resolvePremiumAiAccess\(|refuseUnlessPremiumAi\(|evaluateAiFallbackGate\(|requireAIEntitlement\(|isPersonalisedAIEligible\(|isPersonalisedAiEligible\(/;

/** Files that reach a provider AND must show the guard themselves. */
const MUST_GUARD: Record<string, RegExp> = {
  'lib/financial-data-hub/services/payslipProcessingService.ts': /resolvePremiumAiAccess\(/,
  'lib/financial-data-hub/services/bankPdfProcessingService.ts': /await evaluateAiFallbackGate\(/,
  'lib/financial-data-hub/services/investmentStatementProcessingService.ts': /await evaluateAiFallbackGate\(/,
  'lib/financial-data-hub/services/liabilityStatementProcessingService.ts': /await evaluateAiFallbackGate\(/,
  'lib/financial-data-hub/services/retirementStatementProcessingService.ts': /await evaluateAiFallbackGate\(/,
  'lib/services/investment-intelligence/aiFallbackDocumentExtraction.ts': /resolvePremiumAiAccess\(/,
  // Module 11.3 Insight Pack: Premium gate is step 1 of generateOrGetPack (admin-only trigger on main; no user surface).
  'lib/ai/insightPack/insightPackService.ts': /isPersonalisedAiEligible\(/,
  'app/api/aie/intake/route.ts': /refuseUnlessPremiumAi\(/,
  'app/api/aie/insurance/intake/route.ts': /refuseUnlessPremiumAi\(/,
  'app/api/aie/fdh-bank/intake/route.ts': /refuseUnlessPremiumAi\(/,
  'app/api/aie/investment-intelligence/intake/route.ts': /refuseUnlessPremiumAi\(/,
  'app/api/aie/investment-intelligence/intake/[intakeId]/process/route.ts': /refuseUnlessPremiumAi\(/,
};

/**
 * Provider-reaching files that are NOT request entry points. Each is reachable
 * only through a MUST_GUARD file above (or has no real provider behind it).
 */
const BUILDING_BLOCKS: Record<string, string> = {
  'lib/aie/orchestrator.ts': 'pipeline engine; only invoked by the five guarded /api/aie routes',
  'lib/aie/adapters/shared/gateway.ts': 'shared adapter gateway factory; called after evaluateAiFallbackGate in each service',
  'lib/aie/adapters/retirement/gateway.ts': 'retirement adapter gateway; called after evaluateAiFallbackGate in the retirement service',
  'lib/aie/adapters/payslip/gateway.ts': 'payslip adapter gateway; called after the inline Premium check in the payslip service',
  'lib/aie/adapters/bankStatement/gateway.ts': 'bank adapter gateway; called after evaluateAiFallbackGate',
  'lib/aie/adapters/liability/gateway.ts': 'liability adapter gateway; called after evaluateAiFallbackGate',
  'lib/aie/adapters/auInvestment/gateway.ts': 'AU investment adapter gateway; called after evaluateAiFallbackGate',
  'lib/aie/adapters/insurance/gateway.ts': 'insurance adapter gateway; used only by the guarded insurance route',
  'lib/aie/provider/gateway.ts': 'the gateway class itself (kill switch + cost admission live here)',
  'lib/aie/provider/providerFactory.ts': 'provider selection',
  'lib/ai/gateway/aiModelGateway.ts': 'Module 11 gateway; every call is admitted by ai_admit_request (Premium + quota + budget) inside the gateway',
  'app/api/internal/ai/provider/health/route.ts': 'constructs the gateway with the MOCK provider only; no provider spend',
  'lib/services/investment-intelligence/factsheetReader/aieAdapter.ts': 'ADMIN / cron factsheet ingestion, not a user-facing path; stays OFF (not activated by this change)',
};

function scan(files: Array<{ rel: string; text: string }>) {
  const problems: string[] = [];
  for (const { rel, text } of files) {
    if (!PROVIDER_REACHING.test(text)) continue;
    if (rel in BUILDING_BLOCKS) continue;
    const need = MUST_GUARD[rel];
    if (!need) {
      problems.push(`${rel}: reaches an AI provider but is neither guarded nor a listed building block`);
      continue;
    }
    if (!need.test(text) || !GUARD.test(text)) problems.push(`${rel}: expected the shared Premium guard (${need}) but it is missing`);
  }
  return problems;
}

function load(): Array<{ rel: string; text: string }> {
  return [...walk(path.join(ROOT, 'lib')), ...walk(path.join(ROOT, 'app'))].map((f) => ({
    rel: path.relative(ROOT, f).split(path.sep).join('/'),
    text: fs.readFileSync(f, 'utf8'),
  }));
}

describe('Premium guard coverage', () => {
  const files = load();

  it('every provider-reaching file is guarded or is a listed building block', () => {
    expect(scan(files)).toEqual([]);
  });

  it('every MUST_GUARD file still exists and still reaches a provider (the list cannot rot)', () => {
    for (const rel of Object.keys(MUST_GUARD)) {
      const f = files.find((x) => x.rel === rel);
      expect(f, `${rel} must exist`).toBeDefined();
      expect(PROVIDER_REACHING.test(f!.text) || /evaluateAiFallbackGate\(|resolvePremiumAiAccess\(/.test(f!.text), `${rel} should still reach a provider path`).toBe(true);
    }
  });

  it('NEGATIVE CONTROL: the scanner reports an unguarded provider-reaching file', () => {
    const synthetic = [{ rel: 'app/api/new-feature/route.ts', text: 'const g = new AieDocumentAiGateway(provider);\nawait g.requestFieldCompletion(req);' }];
    expect(scan(synthetic)).toEqual(['app/api/new-feature/route.ts: reaches an AI provider but is neither guarded nor a listed building block']);
  });

  it('NEGATIVE CONTROL: a listed file whose guard was deleted is reported', () => {
    const broken = [{ rel: 'app/api/aie/intake/route.ts', text: 'const g = new AieDocumentAiGateway(provider); // no guard here' }];
    expect(scan(broken)).toHaveLength(1);
  });

  it('the retired pilot variables are read by NO code (comments excluded)', () => {
    const offenders: string[] = [];
    for (const { rel, text } of files) {
      const code = text
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      if (/process\.env\.(AIE_PILOT_COHORT_[A-Z_]+|II_AI_FALLBACK_PILOT_COHORT_[A-Z_]+)/.test(code)) offenders.push(rel);
      if (/isUserInAiePilotCohort|isAiePilotCohortEnforced|isUserIdInAiePilotCohort|resolveEmailForAiePilotCohort|isUserInIiAiFallbackPilotCohort|isIiAiFallbackPilotCohortEnforced/.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    expect(fs.existsSync(path.join(ROOT, 'lib/aie/pilotCohortEmail.ts'))).toBe(false);
  });

  it('no source compares a user e-mail to a literal address to decide AI access', () => {
    const offenders: string[] = [];
    const rx = /(email|user\.email)\s*(===|==|!==)\s*['"`][^'"`]+@[^'"`]+['"`]/i;
    for (const { rel, text } of files) {
      if (!/\bai\b|aie|premium|entitle/i.test(rel)) continue;
      if (rx.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
