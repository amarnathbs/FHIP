// The ONE canonical e-mail address contract for promo codes (hardening 0264 item 5) — pure and dependency free.
//
// NORMALISATION (the same rule in SQL: public.promo_normalise_email()):
//   1. trim space, tab, CR and LF at both ends;
//   2. lower case the ASCII letters A to Z, and nothing else.
// Deliberately NOT done: Gmail dot removal, plus tag removal, googlemail rewriting, unicode folding, NBSP
// trimming. Two addresses are "the same" only when they are the same text after steps 1 and 2. The shared test
// vector file tests/fixtures/email-normalisation-vectors.json is asserted against BOTH implementations.
//
// VALIDATION is separate from normalisation and stricter: it exists so that an address typed by an admin can
// never carry a header injection (control characters, angle brackets, commas, quotes) and is a plausible
// public mailbox (a real domain with a real top level label). It checks shape only. It cannot know that a
// mailbox exists, and it does not try to.

export const EMAIL_MAX_LENGTH = 254;
const LOCAL_MAX = 64;
const DOMAIN_MAX = 253;
const LABEL_MAX = 63;

/** Top level labels that can never receive public mail. */
export const RESERVED_TLDS: ReadonlySet<string> = new Set(['invalid', 'localhost', 'local', 'example', 'test', 'internal']);

export function normaliseEmailAddress(input: string): string {
  return input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '').replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export type AddressRejection = 'empty' | 'too_long' | 'control_characters' | 'forbidden_characters' | 'malformed' | 'bad_local_part' | 'bad_domain';
export type AddressCheck = { ok: true; address: string } | { ok: false; reason: AddressRejection };

const CONTROL_RE = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}-${String.fromCharCode(159)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`);
const BACKSLASH = String.fromCharCode(92);
const FORBIDDEN_RE = new RegExp(`[\\s<>()\\[\\]${BACKSLASH}${BACKSLASH},;:"']`);
const LOCAL_OK_RE = /^[a-z0-9!#$&*+/=?^_`{|}~.-]+$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TLD_RE = /^([a-z]{2,24}|xn--[a-z0-9-]{2,59})$/;

/** Validates ONE address after normalising it. Returns the normalised address when acceptable. */
export function checkRecipientAddress(input: unknown): AddressCheck {
  if (typeof input !== 'string') return { ok: false, reason: 'malformed' };
  // Control characters are rejected BEFORE any trimming so an embedded CR/LF can never survive.
  const trimmedEnds = input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (CONTROL_RE.test(trimmedEnds)) return { ok: false, reason: 'control_characters' };
  const address = normaliseEmailAddress(input);
  if (address === '') return { ok: false, reason: 'empty' };
  if (address.length > EMAIL_MAX_LENGTH) return { ok: false, reason: 'too_long' };
  if (FORBIDDEN_RE.test(address)) return { ok: false, reason: 'forbidden_characters' };
  if (/[^\x00-\x7f]/.test(address)) return { ok: false, reason: 'forbidden_characters' }; // internationalised addresses are not accepted
  const at = address.indexOf('@');
  if (at < 1 || at !== address.lastIndexOf('@')) return { ok: false, reason: 'malformed' };
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > LOCAL_MAX || !LOCAL_OK_RE.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return { ok: false, reason: 'bad_local_part' };
  }
  if (domain.length === 0 || domain.length > DOMAIN_MAX || domain.startsWith('.') || domain.endsWith('.')) return { ok: false, reason: 'bad_domain' };
  const labels = domain.split('.');
  if (labels.length < 2) return { ok: false, reason: 'bad_domain' };
  for (const label of labels) {
    if (label.length === 0 || label.length > LABEL_MAX || !LABEL_RE.test(label)) return { ok: false, reason: 'bad_domain' };
  }
  const tld = labels[labels.length - 1];
  if (!TLD_RE.test(tld) || RESERVED_TLDS.has(tld)) return { ok: false, reason: 'bad_domain' };
  return { ok: true, address };
}
