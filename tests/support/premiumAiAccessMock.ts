// Shared test double for the Premium-entitlement guard
// (`lib/ai/access/premiumAiAccess.ts`).
//
// Why this exists: the guard reads `user_entitlements` through the service-role
// client, which a unit test has no database for. Tests that exercise the AI
// fallback / intake paths with fake providers use this to decide, per user, what
// the entitlement read would have said -- while the REAL deny/allow semantics,
// the REAL denial Response and the REAL call ordering stay in force (only the
// database read is replaced; the rest of the module is the actual one).
//
// Use from a test file:
//
//   vi.mock('@/lib/ai/access/premiumAiAccess', async (importOriginal) =>
//     (await import('../support/premiumAiAccessMock')).premiumAiAccessModule(await importOriginal()));
//   import { premiumAi } from '../support/premiumAiAccessMock';
//   beforeEach(() => premiumAi.reset());           // default: every user is active Premium
//   premiumAi.setTier('user-free', 'free');        // or 'expired', 'unavailable'
import type { EntitlementReadResult } from '@/lib/ai/access/premiumAiAccess';

type TestTier = 'premium' | 'free' | 'expired' | 'unavailable';

class PremiumAiTestState {
  private byUser = new Map<string, TestTier>();
  private fallback: TestTier = 'premium';
  /** Every user id the guard was asked about, in order (proves it ran, and for whom). */
  readonly asked: string[] = [];

  reset(): void {
    this.byUser.clear();
    this.fallback = 'premium';
    this.asked.length = 0;
  }
  /** The tier for users with no explicit entry. */
  setDefault(tier: TestTier): void {
    this.fallback = tier;
  }
  setTier(userId: string, tier: TestTier): void {
    this.byUser.set(userId, tier);
  }
  read(userId: string): EntitlementReadResult {
    this.asked.push(userId);
    const tier = this.byUser.get(userId) ?? this.fallback;
    switch (tier) {
      case 'premium':
        return { row: { plan_tier: 'premium', effective_from: null, effective_to: null }, error: null };
      case 'free':
        return { row: { plan_tier: 'free', effective_from: null, effective_to: null }, error: null };
      case 'expired':
        return { row: { plan_tier: 'premium', effective_from: '2020-01-01', effective_to: '2020-12-31' }, error: null };
      case 'unavailable':
        return { row: null, error: 'entitlement read failed (test)' };
    }
  }
}

export const premiumAi = new PremiumAiTestState();

type GuardModule = typeof import('@/lib/ai/access/premiumAiAccess');

/**
 * The actual guard module with ONLY its database read replaced by the test
 * state. `actual` is `await importOriginal()` from the vi.mock factory.
 */
export function premiumAiAccessModule(actual: GuardModule): GuardModule {
  const resolvePremiumAiAccess: GuardModule['resolvePremiumAiAccess'] = (userId, capability, deps = {}) =>
    actual.resolvePremiumAiAccess(userId, capability, { readEntitlement: async (id) => premiumAi.read(id), ...deps });
  const refuseUnlessPremiumAi: GuardModule['refuseUnlessPremiumAi'] = async (userId, capability, deps = {}) => {
    const decision = await resolvePremiumAiAccess(userId, capability, deps);
    return decision.allowed ? null : actual.premiumAiDeniedResponse(decision);
  };
  return { ...actual, resolvePremiumAiAccess, refuseUnlessPremiumAi };
}
