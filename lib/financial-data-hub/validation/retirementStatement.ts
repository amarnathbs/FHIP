/**
 * FDH-12 — Retirement Statement Intelligence: validation for the
 * user-facing API surface (spec sections 91, 119). Follows the existing
 * `lib/financial-data-hub/validation/*` convention exactly — Zod, no
 * `user_id`/`owner_id`/`household_id` ever accepted from the client.
 *
 * Extracted 2026-09-21 (real-malware-gate async fix) from
 * `app/api/financial-data-hub/retirement-statement/upload/route.ts`, which
 * originally defined this schema inline — the new
 * `[documentId]/process/route.ts` resumption route needs to validate a
 * re-submitted metadata body identically, and importing a schema from a
 * sibling `route.ts` module (rather than a `lib/` validation file) would be
 * the odd one out against every other FDH-3-descended upload route.
 */

import { z } from 'zod';

export const retirementStatementUploadMetadataSchema = z.object({
  jurisdiction: z.enum(['AU', 'IN']),
  currency_code: z.enum(['AUD', 'INR']),
  fund_name: z.string().max(200).optional(),
  // MASKED ONLY (spec section 89). A value containing a run of 7+ digits is
  // rejected here rather than silently truncated, so a UI bug that sent a full
  // member number produces a visible error instead of quietly persisting it.
  // Migration 0112's CHECK constraint is the second, independent refusal.
  masked_account_identifier: z.string().max(64)
    .refine((v) => !/[0-9]{7,}/.test(v), {
      message: 'Enter only the last few digits of your member number, not the whole number.',
    })
    .optional(),
  statement_date: z.string().date().optional(),
  statement_period_start: z.string().date().optional(),
  statement_period_end: z.string().date().optional(),
});
export type RetirementStatementUploadMetadataInput = z.infer<typeof retirementStatementUploadMetadataSchema>;

/**
 * CURRENCY MUST MATCH JURISDICTION for a statement's own arithmetic to be
 * coherent (spec section 68: never sum AUD and INR without canonical FX
 * treatment).
 *
 * NOTE what this does NOT do (spec sections 69-70): it does not consult the
 * user's country of residence. An Australian resident may hold an Indian EPF
 * account, and an Indian resident may retain Australian super; blocking either
 * on residence would erase a legitimate foreign retirement holding.
 */
export function currencyMatchesJurisdiction(jurisdiction: 'AU' | 'IN', currency: string): boolean {
  return jurisdiction === 'AU' ? currency === 'AUD' : currency === 'INR';
}
