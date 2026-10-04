// The AI adapter backed by the repository's AIE provider layer (lib/aie/provider). Server-side only.
//
// Reuses: the provider selection (createLazyAieAiProvider: mock under the test runner, real OpenAI only when
// AIE_AI_PROVIDER=openai and AIE_OPENAI_API_KEY are set, otherwise 'unconfigured', which fails every call closed),
// the strict json_schema Structured Outputs call, the bounded timeout / transient-retry policy and the
// GPT-4o-mini-only model rule (isPermittedAieModel).
//
// Not reused, on purpose: the AIE document gateway (lib/aie/provider/gateway.ts). That gateway is built around a
// user's uploaded document: PII masking, a per-user cost reservation in the database and the intake kill switch.
// None of that applies to a PUBLIC fund document with no user data, and using it would tie this reader to a
// user-upload path. The reader instead carries its own bounds: the AI pass is off unless
// FACTSHEET_READER_AI_ENABLED=true, it runs only when the pattern pass failed, at most maxAiCallsPerRun times per
// run, on a bounded excerpt, and the answer is validated before any use (aiExtractor.ts).

import '@/lib/serverOnly';
import { getAieAiModel, getAieAiTimeoutMs, isPermittedAieModel } from '@/lib/aie/config';
import { createLazyAieAiProvider } from '@/lib/aie/provider/providerFactory';
import type { AieAiProvider } from '@/lib/aie/provider/types';
import { FACTSHEET_AI_SCHEMA_NAME, FACTSHEET_AI_SCHEMA_VERSION, FACTSHEET_AI_SYSTEM_PROMPT, buildAiUserPrompt, type FactsheetAiExtractor, type FactsheetAiRawResult, type FactsheetAiRequest } from './aiExtractor';

const MAX_OUTPUT_TOKENS = 500;

export function createAieFactsheetAiExtractor(provider: AieAiProvider = createLazyAieAiProvider()): FactsheetAiExtractor {
  return {
    id: 'aie-openai-structured',
    async extract(req: FactsheetAiRequest): Promise<FactsheetAiRawResult> {
      const model = getAieAiModel();
      if (!isPermittedAieModel(model)) return { ok: false, reason: 'The configured AI model is not permitted for this product.' };
      try {
        const result = await provider.generateStructured({
          systemPrompt: FACTSHEET_AI_SYSTEM_PROMPT,
          // The ONLY content sent: the scheme name and a bounded excerpt of the public document.
          userPrompt: buildAiUserPrompt(req),
          schemaName: FACTSHEET_AI_SCHEMA_NAME,
          schemaVersion: FACTSHEET_AI_SCHEMA_VERSION,
          model,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          temperature: 0,
          timeoutMs: getAieAiTimeoutMs(),
        });
        if (result.finishReason !== 'stop') return { ok: false, reason: `The AI call did not finish normally (${result.finishReason}).` };
        return { ok: true, rawText: result.rawText, model: result.modelVersion || model };
      } catch (e) {
        // Category only: never the prompt, the excerpt or a provider message.
        const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code).slice(0, 40) : 'ERROR';
        return { ok: false, reason: `provider error (${code})` };
      }
    },
  };
}
