// Investment Intelligence AI-fallback pilot-cohort gate (2026-09-21 fix,
// M13A finding). Mirrors tests/unit/aiePilotCohort.test.ts exactly (same
// fail-closed contract), for this path's own, separately-named env vars —
// see aiFallbackFeatureFlag.ts's header for why this is NOT the
// AIE_PILOT_COHORT_* mechanism reused verbatim.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isIiAiFallbackPilotCohortEnforced, isUserInIiAiFallbackPilotCohort } from '@/lib/services/investment-intelligence/aiFallbackFeatureFlag';

const ENV_KEYS = ['II_AI_FALLBACK_PILOT_COHORT_ENFORCED', 'II_AI_FALLBACK_PILOT_COHORT_USER_IDS', 'II_AI_FALLBACK_PILOT_COHORT_EMAILS'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('isIiAiFallbackPilotCohortEnforced', () => {
  it('defaults to false (production-safe: no restriction until explicitly enabled)', () => {
    expect(isIiAiFallbackPilotCohortEnforced()).toBe(false);
  });
  it('only the literal string "true" enables it', () => {
    process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED = 'TRUE';
    expect(isIiAiFallbackPilotCohortEnforced()).toBe(false);
    process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED = 'true';
    expect(isIiAiFallbackPilotCohortEnforced()).toBe(true);
  });
});

describe('isUserInIiAiFallbackPilotCohort', () => {
  it('when enforcement is OFF, every user is allowed regardless of allowlist content', () => {
    expect(isUserInIiAiFallbackPilotCohort({ userId: 'not-listed-anywhere' })).toBe(true);
  });

  it('when enforced, a listed user id is allowed', () => {
    process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED = 'true';
    process.env.II_AI_FALLBACK_PILOT_COHORT_USER_IDS = 'user-a, user-b';
    expect(isUserInIiAiFallbackPilotCohort({ userId: 'user-b' })).toBe(true);
  });

  it('when enforced, an unlisted user id is denied', () => {
    process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED = 'true';
    process.env.II_AI_FALLBACK_PILOT_COHORT_USER_IDS = 'user-a, user-b';
    expect(isUserInIiAiFallbackPilotCohort({ userId: 'user-c' })).toBe(false);
  });

  it('when enforced, a listed email is allowed (case-insensitive)', () => {
    process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED = 'true';
    process.env.II_AI_FALLBACK_PILOT_COHORT_EMAILS = 'pilot@example.com';
    expect(isUserInIiAiFallbackPilotCohort({ userId: 'irrelevant', email: 'Pilot@Example.com' })).toBe(true);
  });

  it('FAILS CLOSED: enforced with a completely empty allowlist denies everyone, never silently allows all', () => {
    process.env.II_AI_FALLBACK_PILOT_COHORT_ENFORCED = 'true';
    expect(isUserInIiAiFallbackPilotCohort({ userId: 'anyone', email: 'anyone@example.com' })).toBe(false);
  });

  it('this cohort is independent of the AIE pilot cohort — setting only the AIE_ variables does not enforce this one', () => {
    process.env.AIE_PILOT_COHORT_ENFORCED = 'true';
    process.env.AIE_PILOT_COHORT_USER_IDS = 'user-a';
    try {
      expect(isIiAiFallbackPilotCohortEnforced()).toBe(false);
      expect(isUserInIiAiFallbackPilotCohort({ userId: 'not-user-a' })).toBe(true);
    } finally {
      delete process.env.AIE_PILOT_COHORT_ENFORCED;
      delete process.env.AIE_PILOT_COHORT_USER_IDS;
    }
  });
});
