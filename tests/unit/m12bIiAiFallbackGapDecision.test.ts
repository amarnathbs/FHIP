/**
 * M12B section 7 — INVESTMENT INTELLIGENCE AI FALLBACK: the decision, pinned.
 *
 * THE DECISION IS TO DECLINE, and this file exists so that the decision is a
 * fact about the code rather than a paragraph in a report nobody re-reads.
 *
 * The M12 dispatch permits introducing an AI-eligible gap for Investment
 * Intelligence ONLY if a real field ambiguity exists that (a) AI can clarify
 * from source evidence, (b) cannot alter canonical identity by guess,
 * (c) cannot create tax-lot semantics, and (d) cannot override deterministic
 * reconciliation. It also names the one candidate worth taking seriously: the
 * M0-M11 mission's `M3-F1`, a real but explicitly unverified hypothesis that a
 * DISCARDED OPENING BALANCE on the CAS layout explains two of PC4's five
 * production reconciliation residuals.
 *
 * That candidate was investigated against the code rather than accepted or
 * dismissed on its description, and it FAILS three of the four conditions:
 *
 *  (a) FAILS — there is nothing for AI to clarify. The figure is printed
 *      unambiguously and `camsParser.ts`'s own `OPENING_BALANCE_RE` ALREADY
 *      CAPTURES IT in a group; the use site simply calls `.test(line)` and
 *      throws the capture away. The sibling certified parser
 *      (`camsFolioStatementParser.ts`) `.exec()`s the equivalent line and emits
 *      a real `adjustment` transaction from it. Two certified parsers in this
 *      repository disagree about the same concept, and one of them already
 *      demonstrates the concept is deterministically readable. This is a
 *      DISCARD DEFECT with a deterministic fix, not a field ambiguity.
 *  (c) FAILS — an opening unit balance is a POSITION figure. FS1 emits it as
 *      `adjustment` specifically so R6's `ACQUISITION_TYPE_MAP` excludes it
 *      from acquisitions; an AI-supplied units figure would feed the identical
 *      path and sit one mapping away from tax-lot semantics.
 *  (d) FAILS, and most decisively — `reconcilePosition` computes
 *      `opening + delta` and compares it to the statement's printed closing
 *      balance. An AI-supplied opening balance would not sit ALONGSIDE
 *      deterministic reconciliation; it would BE its input, and would directly
 *      determine the variance that PC4's residuals are measured in.
 *
 * So Investment Intelligence is certified in the state the dispatch itself
 * names as acceptable: deterministic-first path certified; AI fallback
 * structurally available but currently with no eligible extraction gap.
 *
 * WHAT THIS FILE GUARDS. Not that II must never have an AI gap — a future
 * document class with a genuine per-field gap may earn one. It guards against
 * the specific failure the dispatch warns about: fabricating a gap to turn AI
 * green. Each assertion below names the condition it protects, so a future
 * change that introduces a gap has to come back here and argue with it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { runExtractionPipeline, type AieOrchestratorDeps } from '@/lib/aie/orchestrator';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import { registerInvestmentIntelligenceAieParser, investmentIntelligenceRegisteredParser } from '@/lib/aie/adapters/investment-intelligence/parserAdapter';
import { buildInvestmentReconciliationRule, type InvestmentReconciliationContext } from '@/lib/aie/adapters/investment-intelligence/reconciliationRule';
import { ALLOWED_AI_COMPLETABLE_FIELDS as II_ALLOWED_AI_FIELDS } from '@/lib/aie/adapters/investment-intelligence/schema';
import { DEFAULT_RECONCILIATION_CONFIG } from '@/lib/services/investment-intelligence/reconciliationConfig';
import { parseExtractedDocument } from '@/lib/services/investment-intelligence/parsers/registry';
import { matchAccountsReadOnly } from '@/lib/aie/adapters/investment-intelligence/accountMatching';
import { buildAieIiCasFixtureText } from '../support/buildAieIiCasFixtureText';

function fakeDeps(): { deps: AieOrchestratorDeps; calls: { aiAttempts: number; maskingSummaries: number; transitions: string[] } } {
  const calls = { aiAttempts: 0, maskingSummaries: 0, transitions: [] as string[] };
  const deps: AieOrchestratorDeps = {
    recordTransition: async (p) => void calls.transitions.push(`${p.fromState}->${p.toState}`),
    recordParserAttempt: async () => {},
    recordMaskingSummary: async () => void (calls.maskingSummaries += 1),
    recordAiCompletionAttempt: async () => {
      calls.aiAttempts += 1;
      return { id: 'fake' };
    },
    recordSchemaValidationResult: async () => {},
    recordFieldCandidates: async () => {},
    recordReconciliationRuns: async () => {},
    createUnresolvedItems: async (p) => p.items.map((_, i) => `fake-item-${i}`),
    audit: async () => {},
    // The kill switch is forced ON, deliberately: if the AI fallback were
    // reachable at all for Investment Intelligence, this configuration would
    // reach it. Leaving the switch off would make every assertion below pass
    // for the wrong reason.
    gateway: new AieDocumentAiGateway(new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) }), { isKillSwitchEnabled: () => true }),
  };
  return { deps, calls };
}

/** A first-time import against an empty tenant — the same read-only context
 * `aieIiAdapterParser.test.ts` builds, so this decision test exercises the
 * reconciliation rule in a configuration the adapter's own suite already
 * treats as representative. */
function reconciliationContext(text: string): InvestmentReconciliationContext {
  const parsed = parseExtractedDocument(text).parsed!;
  return {
    sourceKey: 'cams',
    countryCode: 'IN',
    accountMatches: matchAccountsReadOnly(parsed, []),
    instrumentMatches: new Map(),
    existingFingerprints: new Set(),
    existingSnapshots: new Map(),
    existingTransactionsForPosition: new Map(),
    existingAccountCurrency: new Map(),
    config: DEFAULT_RECONCILIATION_CONFIG,
  };
}

describe('M12B.7 — Investment Intelligence AI fallback: no eligible extraction gap (decision pinned)', () => {
  let savedKey: string | undefined;

  beforeAll(() => {
    registerInvestmentIntelligenceAieParser();
    savedKey = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
    // Deliberately UNSET, to prove the finding is structural rather than
    // key-blocked: II does not reach masking at all, so the masking key's
    // absence is not what is being observed here.
    delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
  });

  afterAll(() => {
    if (savedKey === undefined) delete process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
    else process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = savedKey;
  });

  it('DECISION: the II parser declares no AI-eligible gap on a real, fully-parsing CAS document', () => {
    const result = investmentIntelligenceRegisteredParser.parse(buildAieIiCasFixtureText());
    expect(result.outcome).toBe('complete');
    expect(result.aiEligibleGaps).toEqual([]);
  });

  it('DECISION: the AI fallback is STRUCTURALLY unreachable for II — not merely disabled, and not merely key-blocked', async () => {
    // The orchestrator gates masking on
    // `deterministic_partial && aiEligibleGaps.length > 0`. With no gap
    // declared, the masking stage is never entered, so there is no payload to
    // build and nothing for the masking key to block.
    expect(process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY).toBeUndefined();

    const { deps, calls } = fakeDeps();
    const outcome = await runExtractionPipeline({
      runId: 'm12b-ii-1',
      intakeId: 'm12b-ii-intake-1',
      userId: 'user-m12b-ii',
      extractedText: buildAieIiCasFixtureText(),
      reconcile: buildInvestmentReconciliationRule(reconciliationContext(buildAieIiCasFixtureText())),
      deps,
    });

    expect(outcome.aiWasUsed).toBe(false);
    expect(calls.aiAttempts).toBe(0);
    expect(calls.maskingSummaries).toBe(0);
    // The run never visits `masking`, `ai_pending`, `ai_running` or
    // `privacy_blocked` — asserted on the real transitions the pipeline
    // recorded, not inferred from the absence of an AI call.
    for (const forbidden of ['masking', 'ai_pending', 'ai_running', 'privacy_blocked']) {
      expect(calls.transitions.some((t) => t.includes(forbidden)), `run must never enter ${forbidden}`).toBe(false);
    }
    // And it did NOT crash on the unset key — M12A-F2's fix, observed from a
    // third adapter.
    expect(outcome.finalStatus).not.toBe('threw');
  });

  it('CONDITION (c)/(d): II\'s registered AI schema cannot express an opening balance, a unit count or any cost-base field', () => {
    // Even if a gap were introduced tomorrow, the closed enum is what would
    // have to be widened first — which is the prohibition, made structural.
    expect(II_ALLOWED_AI_FIELDS).toEqual(['sourceDescriptionClarification']);
    const forbiddenSubstrings = ['opening', 'balance', 'unit', 'nav', 'amount', 'cost', 'currency', 'fx', 'folio', 'owner', 'instrument', 'isin', 'date'];
    for (const field of II_ALLOWED_AI_FIELDS) {
      for (const forbidden of forbiddenSubstrings) {
        expect(field.toLowerCase(), `II AI-completable field "${field}" must not name a ${forbidden} concept`).not.toContain(forbidden);
      }
    }
  });

  it('CONDITION (a): the CAS opening-balance figure is deterministically READABLE — and as of M12C §8.3 it is deterministically READ', async () => {
    // The claim under test is narrow and is the one that decides section 7:
    // this repository ALREADY contains a certified parser that reads the same
    // concept correctly. A fact one deterministic parser reads exactly is not
    // a fact the other one needs an AI to guess.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../lib/services/investment-intelligence/parsers/camsFolioStatementParser.ts', import.meta.url), 'utf8'),
    );
    // FS1 EXECs the pattern and uses the captured units.
    expect(source).toContain('OPENING_BALANCE_ROW_RE.exec(line)');
    expect(source).toContain('OPENING_BALANCE_SOURCE_REFERENCE');

    const casSource = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../lib/services/investment-intelligence/parsers/camsParser.ts', import.meta.url), 'utf8'),
    );
    // The CAS pattern CAPTURES the figure in a group...
    expect(casSource).toMatch(/const OPENING_BALANCE_RE = .*\(.*\)/);

    // ...and, until M12C, the use site discarded that capture with `.test()`.
    //
    // M12B wrote this assertion as `expect(casSource).toContain(
    // 'OPENING_BALANCE_RE.test(line)')` and said, in place, that it was
    // "expected to FAIL the day someone fixes M3-F1 deterministically, which is
    // the correct outcome: at that point this test should be updated to record
    // that the defect is closed, and section 7's conclusion — that no AI gap
    // was warranted — is only reinforced."
    //
    // THAT DAY IS M12C. §8.3 confirmed M3-F1 against production and fixed it in
    // `camsParser.ts`: the use site now `.exec()`s the pattern and preserves
    // the captured figure as an `adjustment` carrying
    // `OPENING_BALANCE_SOURCE_REFERENCE` — the identical shape FS1 already
    // used, which is what made the "deterministically readable" claim provable
    // in the first place.
    //
    // The assertion is therefore INVERTED rather than deleted. Section 7's
    // conclusion is not weakened by the fix; it is settled by it. A future
    // change that reverted to `.test()` would re-open a discard defect, and
    // this test would catch it.
    expect(casSource, 'M3-F1 has regressed: the CAS opening balance is being discarded again').not.toContain('OPENING_BALANCE_RE.test(line)');
    expect(casSource, 'the CAS parser must EXEC the opening-balance pattern and keep the capture').toContain('OPENING_BALANCE_RE.exec(line)');
    // And it must preserve the value through the same certified sentinel FS1
    // uses, never as a purchase, an amount or a tax lot.
    expect(casSource).toContain('OPENING_BALANCE_SOURCE_REFERENCE');
    expect(casSource).toMatch(/canonicalType: 'adjustment'/);
  });
});
