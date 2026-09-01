import { describe, it, expect, afterEach } from 'vitest';
import { isG2LandingLocalisationEnabled } from '@/lib/services/landingLocalisationFlag';

describe('G2 feature flag — safe default and rollback (spec section 12)', () => {
  const original = process.env.G2_LANDING_LOCALISATION_ENABLED;
  afterEach(() => {
    process.env.G2_LANDING_LOCALISATION_ENABLED = original;
  });

  it('defaults to disabled when the env var is unset (matches production today)', () => {
    delete process.env.G2_LANDING_LOCALISATION_ENABLED;
    expect(isG2LandingLocalisationEnabled()).toBe(false);
  });

  it('stays disabled for any value other than the exact string "true"', () => {
    for (const value of ['false', '1', 'TRUE', 'yes', '']) {
      process.env.G2_LANDING_LOCALISATION_ENABLED = value;
      expect(isG2LandingLocalisationEnabled()).toBe(false);
    }
  });

  it('enables only when explicitly set to "true"', () => {
    process.env.G2_LANDING_LOCALISATION_ENABLED = 'true';
    expect(isG2LandingLocalisationEnabled()).toBe(true);
  });

  it('rollback (unsetting the flag again) returns to disabled with no other state involved', () => {
    process.env.G2_LANDING_LOCALISATION_ENABLED = 'true';
    expect(isG2LandingLocalisationEnabled()).toBe(true);
    delete process.env.G2_LANDING_LOCALISATION_ENABLED;
    expect(isG2LandingLocalisationEnabled()).toBe(false);
  });
});
