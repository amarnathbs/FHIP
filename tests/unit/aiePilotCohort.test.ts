/**
 * AIE-1 closure mission (section 13) — the allowlisted pilot cohort gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isAiePilotCohortEnforced, isUserInAiePilotCohort } from '@/lib/aie/featureFlags';

const ENV_KEYS = ['AIE_PILOT_COHORT_ENFORCED', 'AIE_PILOT_COHORT_USER_IDS', 'AIE_PILOT_COHORT_EMAILS'] as const;
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

describe('isAiePilotCohortEnforced', () => {
  it('defaults to false (production-safe: no restriction until explicitly enabled)', () => {
    expect(isAiePilotCohortEnforced()).toBe(false);
  });
  it('only the literal string "true" enables it', () => {
    process.env.AIE_PILOT_COHORT_ENFORCED = 'TRUE';
    expect(isAiePilotCohortEnforced()).toBe(false);
    process.env.AIE_PILOT_COHORT_ENFORCED = 'true';
    expect(isAiePilotCohortEnforced()).toBe(true);
  });
});

describe('isUserInAiePilotCohort', () => {
  it('when enforcement is OFF, every user is allowed regardless of allowlist content', () => {
    expect(isUserInAiePilotCohort({ userId: 'not-listed-anywhere' })).toBe(true);
  });

  it('when enforced, a listed user id is allowed', () => {
    process.env.AIE_PILOT_COHORT_ENFORCED = 'true';
    process.env.AIE_PILOT_COHORT_USER_IDS = 'user-a, user-b';
    expect(isUserInAiePilotCohort({ userId: 'user-b' })).toBe(true);
  });

  it('when enforced, an unlisted user id is denied', () => {
    process.env.AIE_PILOT_COHORT_ENFORCED = 'true';
    process.env.AIE_PILOT_COHORT_USER_IDS = 'user-a, user-b';
    expect(isUserInAiePilotCohort({ userId: 'user-c' })).toBe(false);
  });

  it('when enforced, a listed email is allowed (case-insensitive)', () => {
    process.env.AIE_PILOT_COHORT_ENFORCED = 'true';
    process.env.AIE_PILOT_COHORT_EMAILS = 'pilot@example.com';
    expect(isUserInAiePilotCohort({ userId: 'irrelevant', email: 'Pilot@Example.com' })).toBe(true);
  });

  it('FAILS CLOSED: enforced with a completely empty allowlist denies everyone, never silently allows all', () => {
    process.env.AIE_PILOT_COHORT_ENFORCED = 'true';
    expect(isUserInAiePilotCohort({ userId: 'anyone', email: 'anyone@example.com' })).toBe(false);
  });

  it('a user id match does not leak into email-only allowlist logic or vice versa incorrectly', () => {
    process.env.AIE_PILOT_COHORT_ENFORCED = 'true';
    process.env.AIE_PILOT_COHORT_USER_IDS = 'user-a';
    process.env.AIE_PILOT_COHORT_EMAILS = 'other@example.com';
    expect(isUserInAiePilotCohort({ userId: 'user-a', email: 'not-in-list@example.com' })).toBe(true);
    expect(isUserInAiePilotCohort({ userId: 'not-user-a', email: 'other@example.com' })).toBe(true);
    expect(isUserInAiePilotCohort({ userId: 'not-user-a', email: 'also-not-in-list@example.com' })).toBe(false);
  });
});
