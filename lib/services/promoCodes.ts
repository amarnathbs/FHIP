// Promo codes — request validation, normalisation, error mapping and the
// user-facing redemption verdict mapping.
//
// WHERE THE RULES LIVE. The database is authoritative (the promo migration:
// create / disable / redeem functions, row locks, CHECK backstops). The
// validation here repeats the INPUT rules only so a bad request fails early with
// a precise message; it never approves anything the database would refuse.
//
// NO CODE VALUE IN LOGS OR AUDIT. Nothing in this module logs a code, and the
// admin/audit surfaces identify a code by its id and a masked hint.

import { addDaysIso, isValidIsoDate } from '@/lib/services/entitlementWindow';
import { FEATURE_UNAVAILABLE, isMissingDbObjectError, type RouteError } from '@/lib/services/premiumGrantAdmin';

/** Unambiguous alphabet: no 0/O, 1/I/L. 31 characters. */
export const PROMO_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PROMO_CODE_MIN_LENGTH = 6;
export const PROMO_CODE_MAX_LENGTH = 24;
export const PROMO_MAX_DURATION_DAYS = 365;
/** Access length a code grants when the admin does not choose one: one month (PO decision). The code's own REDEMPTION WINDOW is the separate expiry date. */
export const PROMO_DEFAULT_DURATION_DAYS = 30;
export const PROMO_DEFAULT_MAX_REDEMPTIONS = 100;
export const PROMO_MAX_REDEMPTIONS_CEILING = 1_000_000;
export const PROMO_NOTE_MAX_LENGTH = 500;
export const PROMO_DISABLE_REASON_MIN_LENGTH = 10;
/** Furthest-out code expiry an admin may set. */
export const PROMO_MAX_EXPIRY_DAYS = 3650;

/** Mirrors SQL promo_normalise_code(): upper-case, strip whitespace, hyphens and underscores. */
export function normalisePromoCode(input: unknown): string {
  return typeof input === 'string' ? input.replace(/[\s\-_]/g, '').toUpperCase() : '';
}

/** Display form: groups of 5 separated by hyphens (purely cosmetic). */
export function formatPromoCode(code: string): string {
  return code.replace(/(.{5})(?=.)/g, '$1-');
}

export function isValidPromoCodeShape(normalised: string): boolean {
  if (normalised.length < PROMO_CODE_MIN_LENGTH || normalised.length > PROMO_CODE_MAX_LENGTH) return false;
  for (const ch of normalised) if (!PROMO_ALPHABET.includes(ch)) return false;
  return true;
}

export interface CreatePromoRequest {
  /** Normalised; null = generate one server-side. */
  code: string | null;
  durationDays: number;
  /** null only when `unlimited` was chosen explicitly. */
  maxRedemptions: number | null;
  unlimited: boolean;
  /** null only when `noExpiry` was chosen explicitly. */
  expiresOn: string | null;
  noExpiry: boolean;
  note: string | null;
}

export type ParseCreateResult = { ok: true; value: CreatePromoRequest } | ({ ok: false } & RouteError);

const fail = (code: string, message: string): ParseCreateResult => ({ ok: false, status: 422, code, message });

/** `maxDurationDays` is a parameter ONLY so the test suite can run a deliberately weakened rule as a negative control. */
export function parseCreatePromoRequest(body: unknown, today: string, maxDurationDays: number = PROMO_MAX_DURATION_DAYS): ParseCreateResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('PROMO_REQUEST_INVALID', 'The request body must be a JSON object.');
  const b = body as Record<string, unknown>;

  let code: string | null = null;
  if (b.code !== undefined && b.code !== null && String(b.code).trim() !== '') {
    code = normalisePromoCode(b.code);
    if (!isValidPromoCodeShape(code)) {
      return fail(
        'PROMO_CODE_INVALID',
        `A code must be ${PROMO_CODE_MIN_LENGTH}-${PROMO_CODE_MAX_LENGTH} characters using only ${PROMO_ALPHABET} (no 0, O, 1, I or L). Leave it blank to generate one.`
      );
    }
  }

  const durationDays = b.durationDays === undefined ? PROMO_DEFAULT_DURATION_DAYS : b.durationDays;
  if (!Number.isInteger(durationDays) || (durationDays as number) < 1 || (durationDays as number) > maxDurationDays) {
    return fail('PROMO_DURATION_INVALID', `durationDays must be a whole number from 1 to ${maxDurationDays}.`);
  }

  const unlimited = b.unlimited === true;
  let maxRedemptions: number | null = null;
  if (unlimited) {
    if (b.maxRedemptions !== undefined && b.maxRedemptions !== null) return fail('PROMO_MAX_INVALID', 'Choose either a redemption limit or unlimited, not both.');
  } else {
    const m = b.maxRedemptions === undefined ? PROMO_DEFAULT_MAX_REDEMPTIONS : b.maxRedemptions;
    if (!Number.isInteger(m) || (m as number) < 1 || (m as number) > PROMO_MAX_REDEMPTIONS_CEILING) {
      return fail('PROMO_MAX_INVALID', `maxRedemptions must be a whole number from 1 to ${PROMO_MAX_REDEMPTIONS_CEILING}, or choose unlimited explicitly.`);
    }
    maxRedemptions = m as number;
  }

  const noExpiry = b.noExpiry === true;
  let expiresOn: string | null = null;
  if (noExpiry) {
    if (b.expiresOn !== undefined && b.expiresOn !== null) return fail('PROMO_EXPIRY_INVALID', 'Choose either an expiry date or no expiry, not both.');
  } else {
    if (!isValidIsoDate(b.expiresOn)) return fail('PROMO_EXPIRY_INVALID', 'expiresOn must be a valid date, or choose no expiry explicitly.');
    if (b.expiresOn < today) return fail('PROMO_EXPIRY_INVALID', 'The code expiry date cannot be in the past.');
    if (b.expiresOn > addDaysIso(today, PROMO_MAX_EXPIRY_DAYS)) return fail('PROMO_EXPIRY_INVALID', 'The code expiry date is too far in the future.');
    expiresOn = b.expiresOn;
  }

  let note: string | null = null;
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== 'string' || b.note.length > PROMO_NOTE_MAX_LENGTH) return fail('PROMO_NOTE_INVALID', `The note must be text of at most ${PROMO_NOTE_MAX_LENGTH} characters.`);
    note = b.note.trim() === '' ? null : b.note.trim();
  }

  return { ok: true, value: { code, durationDays: durationDays as number, maxRedemptions, unlimited, expiresOn, noExpiry, note } };
}

// -- database message codes -> HTTP ------------------------------------------

const ADMIN_RPC_ERRORS: Record<string, { status: number; message: string }> = {
  PROMO_UNAUTHENTICATED: { status: 401, message: 'unauthenticated' },
  PROMO_ADMIN_REQUIRED: { status: 403, message: 'Promo code admin access required' },
  PROMO_CODE_INVALID: { status: 422, message: `A code must be ${PROMO_CODE_MIN_LENGTH}-${PROMO_CODE_MAX_LENGTH} characters using only the unambiguous alphabet.` },
  PROMO_CODE_EXISTS: { status: 409, message: 'That code already exists. Choose another or leave it blank to generate one.' },
  PROMO_DURATION_INVALID: { status: 422, message: `durationDays must be a whole number from 1 to ${PROMO_MAX_DURATION_DAYS}.` },
  PROMO_MAX_INVALID: { status: 422, message: 'Set a redemption limit, or choose unlimited explicitly.' },
  PROMO_EXPIRY_INVALID: { status: 422, message: 'Set a valid future expiry date, or choose no expiry explicitly.' },
  PROMO_NOTE_INVALID: { status: 422, message: `The note must be at most ${PROMO_NOTE_MAX_LENGTH} characters.` },
  PROMO_REASON_REQUIRED: { status: 422, message: `A reason of at least ${PROMO_DISABLE_REASON_MIN_LENGTH} characters is required.` },
  PROMO_NOT_FOUND: { status: 404, message: 'No such promo code.' },
  PROMO_BINDING_INVALID: { status: 422, message: 'The address binding is not valid.' },
  PROMO_RECIPIENTS_INVALID: { status: 422, message: 'You can e-mail between 1 and 20 valid addresses at a time.' },
  PROMO_EMAIL_KEY_INVALID: { status: 422, message: 'A request key of 8 to 100 letters, digits, "-" or "_" is required when e-mailing a code.' },
  PROMO_EMAIL_RATE_LIMITED: { status: 429, message: 'You have sent too many promo e-mails in the last hour. Please wait and try again, or copy the code and send it yourself.' },
  PROMO_CODE_ALREADY_DISABLED: { status: 409, message: 'This promo code is already disabled.' },
};

export function mapPromoRpcError(error: { message?: string; code?: string } | null | undefined): RouteError | null {
  if (!error?.message) return null;
  if (isMissingDbObjectError(error)) return FEATURE_UNAVAILABLE; // promo migration not applied here: explicit 503, never an internals leak
  const code = Object.keys(ADMIN_RPC_ERRORS).find((c) => error.message === c || error.message!.includes(c));
  return code ? { code, ...ADMIN_RPC_ERRORS[code] } : null;
}

// -- user redemption ---------------------------------------------------------

/**
 * Messages a USER may see. Deliberately few, and the "unusable" message is the
 * SAME for a code that does not exist, is disabled, is expired, is exhausted,
 * or would add nothing to an entitlement the user already has — so the endpoint
 * cannot be used to learn which codes exist.
 */
export const REDEEM_MESSAGES = {
  PROMO_CODE_UNUSABLE: { status: 422, message: 'This code cannot be used.' },
  PROMO_PAID_ACTIVE: {
    status: 409,
    message: 'You already have an active paid Premium subscription, so a promo code cannot be applied to your account.',
  },
  PROMO_ALREADY_REDEEMED: { status: 409, message: 'You have already used this code.' },
  PROMO_RATE_LIMITED: { status: 429, message: 'Too many attempts. Please wait a few minutes and try again.' },
} as const;

export type RedeemFailureCode = keyof typeof REDEEM_MESSAGES;

export interface RedeemVerdict {
  ok: boolean;
  code?: string;
  ends_on?: string;
  started_on?: string;
}

/** Maps the redeem function's verdict to an HTTP response shape. An unknown or malformed verdict is treated as the generic failure. */
export function interpretRedeemVerdict(verdict: unknown): { status: number; body: { data?: { endsOn: string }; error?: string; message?: string } } {
  const v = (verdict ?? null) as RedeemVerdict | null;
  if (v && v.ok === true && typeof v.ends_on === 'string') return { status: 200, body: { data: { endsOn: v.ends_on } } };
  const code = (v && typeof v.code === 'string' && v.code in REDEEM_MESSAGES ? v.code : 'PROMO_CODE_UNUSABLE') as RedeemFailureCode;
  const m = REDEEM_MESSAGES[code];
  return { status: m.status, body: { error: code, message: m.message } };
}
