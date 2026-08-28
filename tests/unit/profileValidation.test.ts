import { describe, expect, it } from 'vitest';
import { profileSchema } from '@/lib/validation/profile';

// App Review tier-2 fix pass, Fix 1 (Profile Page) — migration 0099 adds
// user_profiles.phone; profileSchema must accept it (previously it was
// silently stripped by zod's default "strip unknown keys" behaviour on
// PUT /api/user/profile, since profileSchema.partial().safeParse() would
// never have had a `phone` key to begin with).
describe('profileSchema — phone field (App Review tier-2 Fix 1)', () => {
  const base = {
    full_name: 'Test User',
    country_of_residence: 'AU' as const,
    preferred_currency: 'AUD' as const,
  };

  it('accepts a profile update that includes a phone number', () => {
    const result = profileSchema.safeParse({ ...base, phone: '+61 400 000 000' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phone).toBe('+61 400 000 000');
  });

  it('accepts an omitted phone (optional field)', () => {
    const result = profileSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('accepts a null phone (clearing a previously-set number)', () => {
    const result = profileSchema.safeParse({ ...base, phone: null });
    expect(result.success).toBe(true);
  });

  it('a partial PUT body containing only phone parses and round-trips it (matches the actual PUT /api/user/profile call shape)', () => {
    const result = profileSchema.partial().safeParse({ phone: '0400 000 000' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phone).toBe('0400 000 000');
  });

  it('email is never a field on this schema — it must never be settable through the profile PUT route (Auth-only, spec §16.1)', () => {
    expect('email' in profileSchema.shape).toBe(false);
  });
});
