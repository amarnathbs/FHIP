/**
 * AIE-1 closure mission — the ONE place that decides mock vs. real AI
 * provider. Closes a real, disclosed gap: `app/api/aie/intake/route.ts`,
 * `app/api/aie/fdh-bank/intake/route.ts` and
 * `app/api/aie/insurance/intake/route.ts` each independently hardcoded
 * `new MockAieProvider(...)` as a module-level singleton — there was no
 * env-driven switch anywhere, so wiring a real provider meant editing three
 * unrelated route files by hand with no single source of truth. All three
 * routes now call `createAieAiProvider()` instead.
 *
 * FAIL LOUD, NEVER SILENT SUBSTITUTION (mission section 2.3: "do not
 * silently substitute another model if unavailable. Report the specific
 * blocker while continuing other work."). If `AIE_AI_PROVIDER=openai` is
 * explicitly configured but `AIE_OPENAI_API_KEY` is missing, this throws
 * immediately at construction time with a message naming the exact missing
 * variable — it does NOT quietly fall back to the mock provider, which
 * would make a real production misconfiguration invisible. The
 * default (unset `AIE_AI_PROVIDER`) IS the mock provider — a
 * production-safe default, not a fallback-after-failure.
 */

// M12C §13 (`M2-OPEN-4`): this module reads a server-side SECRET from
// `process.env`. The marker makes that explicit and enforceable — see
// `lib/serverOnly.ts` for what it does, what it deliberately does not do, and
// why the canonical `server-only` package is a named follow-up rather than a
// silent omission.
import '@/lib/serverOnly';
import type { AieAiProvider } from './types';
import { MockAieProvider, type MockAieProviderScript } from './mockAieProvider';
import { OpenAiAieProvider } from './openaiAieProvider';
import { ProviderError } from '@/lib/ai/providers/types';
import { getAieAiProviderKind } from '../config';

/** The mock provider's default DEV/test script — deterministic, no
 * network, mirrors the shape every registered schema expects (an empty
 * `fields` array is always schema-valid for every currently-registered
 * schema, since `fields` has no `minItems`). Routes that want a specific
 * scripted mock behaviour (e.g. for a targeted test) can still construct
 * their own `MockAieProvider` directly — this default is only for the
 * "mock selected, no special script needed" path `createAieAiProvider()`
 * covers. */
const DEFAULT_MOCK_SCRIPT: MockAieProviderScript = {
  respond: () => JSON.stringify({ fields: [] }),
};

/**
 * AIE-1 final production completion (2026-09-25): the provider used when
 * `AIE_AI_PROVIDER` is not set outside the test runner. It never calls
 * anything and never fabricates output: every call fails as
 * PROVIDER_UNAVAILABLE, which the gateway maps to a typed provider_error
 * outcome (the reservation is settled at zero, nothing was sent). This
 * replaces the old silent mock default that production was running on.
 * Constructed lazily-failing rather than throwing at module load, so a route
 * module that imports a gateway still loads and its deterministic
 * (non-AI) path keeps working.
 */
class UnconfiguredAieProvider implements AieAiProvider {
  readonly providerName = 'unconfigured';
  async generateStructured(): Promise<never> {
    throw new ProviderError(
      'PROVIDER_UNAVAILABLE',
      'AIE_AI_PROVIDER is not configured in this environment; no AI provider call was made.',
    );
  }
  async validateProviderHealth() {
    return { healthy: false, checkedAt: new Date().toISOString(), detail: 'AIE_AI_PROVIDER not configured' };
  }
  estimateCost(inputTokens: number, outputTokens: number) {
    return { inputTokens, outputTokens, estimatedCostUsd: 0 };
  }
}

export function createAieAiProvider(mockScript: MockAieProviderScript = DEFAULT_MOCK_SCRIPT): AieAiProvider {
  const kind = getAieAiProviderKind();
  if (kind === 'mock') {
    return new MockAieProvider(mockScript);
  }
  if (kind === 'unconfigured') {
    return new UnconfiguredAieProvider();
  }
  // kind === 'openai' — checked HERE, synchronously, at construction time
  // (route module load), not deferred to the first real user upload. This
  // is a plain env-var presence check (no network call spent) so it is
  // safe to run unconditionally every time a route module loads.
  if (!process.env.AIE_OPENAI_API_KEY) {
    throw new Error(
      'AIE_AI_PROVIDER=openai is configured but AIE_OPENAI_API_KEY is not set in this environment. ' +
        'Refusing to silently fall back to the mock provider (mission requirement: never substitute a ' +
        'provider silently) — set AIE_OPENAI_API_KEY or unset AIE_AI_PROVIDER to use the mock provider.',
    );
  }
  return new OpenAiAieProvider();
}
