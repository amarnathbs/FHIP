import { z } from 'zod';

// Shared, central bounds for retirement age (spec s.12: "do not invent
// arbitrary limits if the existing FHIP retirement engine already defines
// them" -- these match the existing retirement_members check constraint
// (migration 0072: > 0 and < 120) and the existing per-account
// retirementSchema bound (lib/validation/retirement.ts), so every layer
// that validates a retirement age agrees on the same range.
export const RETIREMENT_AGE_MIN = 1;
export const RETIREMENT_AGE_MAX = 119;

export const MEMBER_TYPE_VALUES = ['self', 'spouse'] as const;
export type MemberType = (typeof MEMBER_TYPE_VALUES)[number];

// Patch payload for PATCH /api/retirement/members -- one member (self or
// spouse) per request. target_retirement_age may be null to explicitly
// clear/unconfirm a value (spec s.25/39), otherwise must be a plausible
// integer age. country_code is optional -- when omitted the server keeps
// whatever is already on the row (or leaves it null for a first-time save).
export const retirementMemberPatchSchema = z.object({
  member_type: z.enum(MEMBER_TYPE_VALUES),
  target_retirement_age: z.number().int().min(RETIREMENT_AGE_MIN).max(RETIREMENT_AGE_MAX).nullable(),
  country_code: z.enum(['AU', 'IN']).optional(),
});

export type RetirementMemberPatchInput = z.infer<typeof retirementMemberPatchSchema>;
