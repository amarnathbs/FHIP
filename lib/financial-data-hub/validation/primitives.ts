/**
 * Financial Data Hub — shared runtime-validation primitives.
 *
 * Uses Zod, the validation library already established across
 * `lib/validation/**` (17 schema files). No second validation framework is
 * introduced.
 */

import { z } from 'zod';
import { FDH_COUNTRY_CODES } from '../constants/enums';
import { FDH_MAX_MONEY, FDH_MONEY_SCALE } from '../domain/money';

/** ISO-3166-1 alpha-2, matching `countries.country_code` and lib/constants.ts. */
export const fdhCountryCode = z.enum(FDH_COUNTRY_CODES);

/**
 * ISO-4217. Restricted to the currencies the `currencies` table actually holds
 * (0021_currencies_add_usd.sql added USD to the original AUD/INR), so an
 * unsupported code fails validation rather than a foreign-key error at write
 * time.
 */
export const FDH_SUPPORTED_CURRENCIES = ['AUD', 'INR', 'USD'] as const;
export const fdhCurrencyCode = z.enum(FDH_SUPPORTED_CURRENCIES);

/** `YYYY-MM-DD`. Same convention as every existing register schema. */
export const fdhDate = z.string().date();

export const fdhTimestamp = z.string().datetime({ offset: true });

export const fdhUuid = z.string().uuid();

/** Confidence / completeness: the closed range [0, 1], stored as numeric(5,4). */
export const fdhUnitInterval = z.number().min(0).max(1);

/**
 * A persisted money magnitude.
 *
 * Strictly positive, because FDH stores magnitudes and keeps direction in a
 * separate `credit_debit` column. Bounded by what `numeric(20,4)` can hold, and
 * rejected outright if it carries more than four decimal places — silently
 * truncating a user's amount is worse than refusing it.
 */
export const fdhMoneyMagnitude = z
  .number()
  .finite()
  .positive()
  .max(FDH_MAX_MONEY)
  .refine(
    (n) => Number.isInteger(Number((n * 10 ** FDH_MONEY_SCALE).toFixed(0)))
      && Math.abs(n * 10 ** FDH_MONEY_SCALE - Math.round(n * 10 ** FDH_MONEY_SCALE)) < 1e-6,
    { message: `amount may carry at most ${FDH_MONEY_SCALE} decimal places` },
  );

/** A non-negative money total (e.g. extracted credits on a reconciliation). */
export const fdhMoneyNonNegative = z.number().finite().min(0).max(FDH_MAX_MONEY);

/** A signed balance. Opening/closing balances and variances may be negative. */
export const fdhMoneySigned = z.number().finite().min(-FDH_MAX_MONEY).max(FDH_MAX_MONEY);

/** An FX rate. Always positive; `numeric(20,10)` in the schema. */
export const fdhFxRate = z.number().finite().positive();

/**
 * Ownership fields present on every user-owned FDH input.
 *
 * `user_id` is NOT accepted from a client. Repositories inject it from the
 * authenticated session, exactly as `makeRegistry` does
 * (lib/services/registry.ts:18). Accepting it here would create precisely the
 * tenant-spoofing hole that RLS `with check` exists to close, and would invite
 * a caller to trust it.
 */
export const fdhOwnershipInput = z.object({
  household_id: fdhUuid.nullish(),
});

/**
 * A masked account identifier. Rejects any run of 7 or more consecutive
 * digits, mirroring the `chk_fdh_accounts_masked_identifier` database check —
 * an AU BSB+account or an Indian account number cannot pass, `****1234` can.
 */
export const fdhMaskedIdentifier = z
  .string()
  .max(64)
  .refine((s) => !/[0-9]{7,}/.test(s), {
    message: 'masked_identifier must not contain a full account number',
  });

/** A stable machine key: lowercase, digits and underscores. Never a label. */
export const fdhMachineKey = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, 'must be a stable lowercase machine key');

/** A 4-digit ISO-18245 merchant category code. */
export const fdhMcc = z.string().regex(/^[0-9]{4}$/);

/** At least one supported country, no duplicates. */
export const fdhCountryApplicability = z
  .array(fdhCountryCode)
  .min(1)
  .refine((v) => new Set(v).size === v.length, { message: 'duplicate country code' });

/**
 * Assert that a date range is ordered. Used by several schemas via
 * `.superRefine`, so the message and the semantics stay identical everywhere.
 */
export function refineDateOrder<T extends Record<string, unknown>>(
  startKey: keyof T & string,
  endKey: keyof T & string,
) {
  return (value: T, ctx: z.RefinementCtx) => {
    const start = value[startKey];
    const end = value[endKey];
    if (typeof start === 'string' && typeof end === 'string' && end < start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [endKey],
        message: `${endKey} must not be earlier than ${startKey}`,
      });
    }
  };
}
