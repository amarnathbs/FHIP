import { z } from 'zod';
import { CONTRIBUTION_FREQUENCIES, CONTRIBUTION_TYPES } from '@/lib/retirement-contributions/types';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date');

/**
 * A manual contribution (Document2 (4) F25b). It names the destination account, the type, the amount and WHEN: a regular
 * frequency, or a date for a one-off. It carries NO balance field, and the account route no longer accepts contribution fields,
 * so a balance and a contribution can never travel in the same request.
 */
export const manualContributionSchema = z
  .object({
    retirement_account_id: z.string().uuid(),
    contribution_type: z.enum(CONTRIBUTION_TYPES),
    amount: z.number().positive('Enter an amount greater than zero').max(10_000_000),
    frequency: z.enum(CONTRIBUTION_FREQUENCIES).nullable().optional(),
    contribution_date: isoDate.nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine((v) => (v.frequency ?? null) !== null || (v.contribution_date ?? null) !== null, {
    message: 'Choose how often it is paid, or enter the date it was paid',
    path: ['frequency'],
  })
  .refine((v) => v.frequency !== 'one_off' || (v.contribution_date ?? null) !== null, {
    message: 'A one-off contribution needs the date it was paid',
    path: ['contribution_date'],
  });

export const chooseDestinationSchema = z.object({ retirement_account_id: z.string().uuid() }).strict();

export type ManualContributionBody = z.infer<typeof manualContributionSchema>;
