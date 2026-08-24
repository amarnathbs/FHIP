import { describe, expect, it } from 'vitest';
import { retirementMemberPatchSchema, RETIREMENT_AGE_MIN, RETIREMENT_AGE_MAX } from '@/lib/validation/retirementMember';

describe('retirementMemberPatchSchema', () => {
  it('accepts a valid self patch', () => {
    const result = retirementMemberPatchSchema.safeParse({ member_type: 'self', target_retirement_age: 65 });
    expect(result.success).toBe(true);
  });

  it('accepts a valid spouse patch', () => {
    const result = retirementMemberPatchSchema.safeParse({ member_type: 'spouse', target_retirement_age: 62 });
    expect(result.success).toBe(true);
  });

  it('accepts a null target_retirement_age (unconfirmed member, spec s.25-26)', () => {
    const result = retirementMemberPatchSchema.safeParse({ member_type: 'self', target_retirement_age: null });
    expect(result.success).toBe(true);
  });

  it('rejects a member_type other than self/spouse (spec s.5 stable codes)', () => {
    const result = retirementMemberPatchSchema.safeParse({ member_type: 'child', target_retirement_age: 65 });
    expect(result.success).toBe(false);
  });

  it(`rejects an age below the shared minimum (${RETIREMENT_AGE_MIN})`, () => {
    const result = retirementMemberPatchSchema.safeParse({ member_type: 'self', target_retirement_age: 0 });
    expect(result.success).toBe(false);
  });

  it(`rejects an age above the shared maximum (${RETIREMENT_AGE_MAX})`, () => {
    const result = retirementMemberPatchSchema.safeParse({ member_type: 'self', target_retirement_age: 120 });
    expect(result.success).toBe(false);
  });

  it('does NOT reject a retired user whose target age is below a plausible "current age" (spec s.13 — no >current-age rule)', () => {
    // A 70-year-old already-retired user recording their actual retirement
    // age of 60 must be representable — this schema has no such comparison
    // at all, by design.
    const result = retirementMemberPatchSchema.safeParse({ member_type: 'self', target_retirement_age: 60 });
    expect(result.success).toBe(true);
  });

  it('rejects a non-integer age', () => {
    const result = retirementMemberPatchSchema.safeParse({ member_type: 'self', target_retirement_age: 65.5 });
    expect(result.success).toBe(false);
  });

  it('rejects a request missing member_type', () => {
    const result = retirementMemberPatchSchema.safeParse({ target_retirement_age: 65 });
    expect(result.success).toBe(false);
  });

  it('accepts an optional country_code and rejects an unsupported one', () => {
    expect(retirementMemberPatchSchema.safeParse({ member_type: 'self', target_retirement_age: 65, country_code: 'AU' }).success).toBe(true);
    expect(retirementMemberPatchSchema.safeParse({ member_type: 'self', target_retirement_age: 65, country_code: 'US' }).success).toBe(false);
  });
});
