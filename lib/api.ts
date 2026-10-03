import type { ZodError, ZodIssue } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

export const ok = (data: unknown) => Response.json({ data });
// `errorCode` is optional and additive (PC1-D2/D4): when omitted, behaviour
// is byte-identical to before (`{ error: msg }`) for every one of this
// helper's existing call sites. When a stable machine-readable code is
// supplied, the body becomes `{ error: CODE, message: msg }` — the
// contract PC1's ISIN/date validation error responses use so a client can
// branch on `error` without parsing prose.
export const bad = (msg: string, code = 400, errorCode?: string) =>
  Response.json(errorCode ? { error: errorCode, message: msg } : { error: msg }, { status: code });

// App Review 2026-09-14, item 1 (leaked validation error): `parsed.error.message`
// is ZodError's own stringified issue dump — e.g. `[{"expected":"'AU' | 'IN'",
// "received":"null","code":"invalid_type","path":["country_code"], ...}]` —
// and several route handlers were returning that verbatim as the client-facing
// error body, so a validation failure surfaced raw internal type/enum plumbing
// to the end user. This turns the same ZodError into a short, actionable,
// field-named message with no technical jargon (still 422 by default, still
// takes an optional `errorCode` for callers that branch on it). Applied so far
// only to the routes the app-review report actually reproduced against
// (Retirement); the same `bad(parsed.error.message, ...)` pattern exists on
// other registers' routes too and is a good candidate for the same treatment,
// but that is a separate, broader cleanup from this bug-fix pass.
function humanizeFieldName(name: string): string {
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Plain-language message for ONE validation issue (never zod's own text, never a type name, an enum
// list or a regex). Used for the per-field `fields` map below. Dates are described without a format
// because this layer does not know which country's screen it feeds: the client names the format
// (day-first) next to its own date fields.
export function humanizeIssue(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      if (issue.received === 'undefined' || issue.received === 'null') return 'This is required.';
      if (issue.expected === 'number' || issue.expected === 'integer') return 'Enter a number.';
      if (issue.expected === 'boolean') return 'Choose yes or no.';
      return 'This is not in the expected form.';
    case 'too_small':
      if (issue.type === 'string') return Number(issue.minimum) <= 1 ? 'This is required.' : `Enter at least ${issue.minimum} characters.`;
      if (issue.type === 'array') return 'Choose at least one option.';
      return `Enter a number of at least ${issue.minimum}.`;
    case 'too_big':
      if (issue.type === 'string') return `Use at most ${issue.maximum} characters.`;
      if (issue.type === 'array') return 'Too many options were chosen.';
      return `Enter a number no larger than ${issue.maximum}.`;
    case 'invalid_string':
      if (issue.validation === 'date') return 'Enter a valid date.';
      if (issue.validation === 'url') return 'Enter a full web address starting with https://';
      if (issue.validation === 'uuid') return 'This identifier is not valid.';
      return 'This is not in the expected form.';
    case 'invalid_enum_value':
    case 'invalid_literal':
      return 'Choose one of the listed options.';
    case 'custom':
      return typeof issue.message === 'string' && issue.message.length > 0 && issue.message.length <= 200 ? issue.message : 'This value is not allowed.';
    default:
      return 'This is not in the expected form.';
  }
}

/**
 * Field-level validation messages for a 422: `{ "valid_from": "Enter a valid date." }`, keyed by the
 * dotted API field path, first message per field. Safe to return to a client: plain sentences only,
 * no schema internals. Issues with no path (a whole-object rule) are not in the map; they appear only
 * in the summary sentence.
 */
export function validationFields(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    if (issue.path.length === 0) continue;
    const key = issue.path.map(String).join('.');
    if (!(key in out)) out[key] = humanizeIssue(issue);
  }
  return out;
}

export const badValidation = (error: ZodError, code = 422, errorCode?: string) => {
  const fields = Array.from(
    new Set(
      error.issues
        .map((issue) => issue.path.filter((seg): seg is string => typeof seg === 'string'))
        .filter((path) => path.length > 0)
        .map((path) => humanizeFieldName(path.join(' ')))
    )
  );
  const msg = fields.length
    ? `Please check: ${fields.join(', ')}. ${fields.length === 1 ? 'This field could not be saved — correct it' : 'These fields could not be saved — correct them'} and try again.`
    : 'Some of the details for this item could not be saved. Please check your entries and try again.';
  const body = errorCode ? { error: errorCode, message: msg } : { error: msg };
  const fieldMap = validationFields(error);
  return Response.json(Object.keys(fieldMap).length > 0 ? { ...body, fields: fieldMap } : body, { status: code });
};

export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, unauthenticated: bad('unauthenticated', 401) };
  return { user, unauthenticated: null };
}

// Mandatory Country Confirmation (Product Owner decision, 2026-08-29) — the
// canonical API-layer guard for every authenticated financial endpoint.
//
// Kept as a SEPARATE export from requireUser() (rather than changing
// requireUser() itself) so the two responsibilities stay distinguishable in
// code, but every one of the ~188 route handlers that previously imported
// `requireUser` from this module has been switched onto this function via a
// single-line import alias (`import { requireCountryConfirmedUser as
// requireUser, ... } from '@/lib/api'`) — see the closure report's Scope and
// Security Audit section for the exact file list. That preserves the
// existing `const { user, unauthenticated } = await requireUser(); if
// (!user) return unauthenticated!;` idiom verbatim at every call site (this
// function returns the identical `{ user, unauthenticated }` shape), so no
// route handler body had to change to gain country enforcement.
//
// Round-3 closure (Gap 1): NO onboarding exemption is applied here at all —
// deliberately. Round 2 gave every one of the ~241 routes using this
// function the same blanket "skip the check while onboarding_completed is
// false" exemption the database trigger had, which was the identical class
// of bypass the Product Owner flagged: a defective or malicious client
// could call ANY of those routes directly while onboarding_completed
// stayed false. The onboarding wizard no longer calls any of these routes
// during onboarding at all — its optional first-goal write (the one thing
// that used to need this) now happens strictly AFTER country confirmation
// (see app/(onboarding)/confirm-country/ConfirmCountryForm.tsx), and its
// household write goes through app/api/household/route.ts, which is the
// ONLY caller of countryConfirmationBlockResponse() that opts into the
// (now off-by-default) onboarding exemption via
// `{ allowDuringOnboarding: true }`. Every other route gated by this
// function requires a genuinely confirmed country, full stop.
export async function requireCountryConfirmedUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, unauthenticated: bad('unauthenticated', 401) };

  // Delegates to the ONE shared classify-and-respond helper
  // (lib/services/countryGate.ts's countryConfirmationBlockResponse) also
  // used by requireAdmin(), the 39 Resources admin routes (MCC-2) and
  // app/api/household/route.ts (MCC-7), so every call site shares
  // identical state-to-response logic instead of near-duplicates.
  const block = await countryConfirmationBlockResponse(supabase, user.id);
  if (block) return { user: null, unauthenticated: block };
  return { user, unauthenticated: null };
}

// G3 — Registration and Existing-User Alignment, spec section 10.
//
// Identical to requireCountryConfirmedUser() except that it also admits
// GENERIC-experience (GB/US/SG/AE) users. It exists because G3 opens
// registration to four generic countries while G4's application-wide
// capability layer — the thing that will decide, per module, what a generic
// user may do — has not been built. In that gap, the safe default had to be
// "generic users are refused", and the safe default had to apply to all ~241
// existing gated routes WITHOUT touching 241 files (where one missed file is
// a real hole). So the default lives in the shared guard above, and this
// function is the explicit, greppable opt-out.
//
// USE THIS ONLY for a surface that is genuinely jurisdiction-neutral and has
// been reasoned about individually. As of G3 that is exactly:
//   - the user's own cross-border relationship declarations (spec section 9 —
//     a declaration, never a calculation)
//   - the primary-country preview/confirm workflow (G1's own controlled
//     country-change path, which a generic user must be able to run in order
//     to correct a wrong country)
// Everything else — every financial module, every domestic calculation,
// SMSF, catalogue creation, reports, billing confirmation — deliberately
// keeps requireCountryConfirmedUser() and therefore refuses generic users
// with a truthful GENERIC_EXPERIENCE_RESTRICTED (403) until G4.
export async function requireCountryConfirmedUserAllowingGeneric() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { user: null, unauthenticated: bad('unauthenticated', 401) };

  const block = await countryConfirmationBlockResponse(supabase, user.id, { allowGenericExperience: true });
  if (block) return { user: null, unauthenticated: block };
  return { user, unauthenticated: null };
}
