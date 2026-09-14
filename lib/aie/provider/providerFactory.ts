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

import type { AieAiProvider } from './types';
import { MockAieProvider, type MockAieProviderScript } from './mockAieProvider';
import { OpenAiAieProvider } from './openaiAieProvider';
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

export function createAieAiProvider(mockScript: MockAieProviderScript = DEFAULT_MOCK_SCRIPT): AieAiProvider {
  const kind = getAieAiProviderKind();
  if (kind === 'mock') {
    return new MockAieProvider(mockScript);
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
