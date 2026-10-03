// Building a safe `From` header for the Premium e-mails (promo codes and expiry reminders).
//
// The SENDING ADDRESS is exactly what is configured today (the address part of PREMIUM_REMINDER_FROM_EMAIL,
// else CONTACT_FROM_EMAIL, else the default no-reply address on the verified domain). Only the DISPLAY NAME is
// replaced: the configured value is parsed for its address and any display name it carries (for example the
// Contact form's "FHIP Contact Form") is discarded, and the name comes from PREMIUM_PROMO_EMAIL_FROM_NAME
// (default "FHIP"). The Contact form's own route builds its own From and does not use this module.
//
// HEADER-INJECTION SAFETY: the name is reduced to letters, digits, spaces and a few harmless punctuation marks
// (no angle brackets, quotes, backslashes, commas, colons, semicolons, "@", parentheses, CR, LF or any other
// control character), whitespace is collapsed, the length is capped, and an empty or invalid result falls back to
// "FHIP". The address is accepted only if it is a single plain address (no whitespace, no angle brackets, no
// control characters); otherwise the default address is used, never an invented one.

export const DEFAULT_FROM_NAME = 'FHIP';
export const DEFAULT_FROM_ADDRESS = 'no-reply@auth.financialhealthplatform.com';
export const MAX_FROM_NAME_LENGTH = 60;

const PLAIN_ADDRESS_RE = /^[^\s<>"',;:()\\@]+@[^\s<>"',;:()\\@]+\.[^\s<>"',;:()\\@]+$/;

/** Letters, digits, spaces and . & ' _ - only; collapsed and capped. Empty/invalid input yields the default. */
export function sanitiseFromName(input: string | null | undefined): string {
  if (typeof input !== 'string') return DEFAULT_FROM_NAME;
  const cleaned = input
    .replace(/[^\p{L}\p{N} .&_-]/gu, ' ') // everything else (incl. quotes, <>, CR/LF, control chars) becomes a space
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FROM_NAME_LENGTH)
    .trim();
  return cleaned === '' ? DEFAULT_FROM_NAME : cleaned;
}

/** The address part of a configured sender such as `Name <a@b.test>` or a bare `a@b.test`; null when it is not a single plain address. */
export function extractFromAddress(configured: string | null | undefined): string | null {
  if (typeof configured !== 'string') return null;
  const value = configured.trim();
  if (/[\r\n\u0000-\u001f\u007f]/.test(value)) return null; // never touch a value carrying control characters
  if ((value.match(/</g)?.length ?? 0) > 1 || (value.match(/>/g)?.length ?? 0) > 1) return null; // ambiguous: two bracketed parts
  const angle = value.match(/<([^<>]*)>\s*$/);
  const candidate = (angle ? angle[1] : value).trim();
  return PLAIN_ADDRESS_RE.test(candidate) ? candidate : null;
}

/** `Name <address>`: the configured address, the sanitised name. */
export function buildFromHeader(configuredFrom: string | null | undefined, rawName: string | null | undefined): string {
  const address = extractFromAddress(configuredFrom) ?? DEFAULT_FROM_ADDRESS;
  return `${sanitiseFromName(rawName)} <${address}>`;
}
