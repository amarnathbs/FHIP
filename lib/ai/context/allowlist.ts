// Module 11.0 — data-minimisation last line of defence (spec sections 4, 12,
// 35 privacy tests). The FinancialContextObject builder (financialContextObject.ts)
// is designed to never touch a banned field in the first place — this module
// is defence-in-depth: it structurally scans the FINAL object for any key
// name or value shape that must never reach a provider, and throws rather
// than silently continuing, so a future accidental field addition fails a
// build/test instead of leaking silently to production.

// Key names that must never appear anywhere in a context object, regardless
// of nesting depth. Deliberately broad (substring match on a normalised key)
// since a future field like `contactEmail` or `authToken` must be caught
// even if no one remembers to add the exact name here.
// Written with underscores for readability; normalised (underscores/case
// stripped, same as normalise() below) before every comparison, so
// 'service_role' and 'servicerole' are the same check — no need to
// hand-duplicate every entry in both forms.
const BANNED_KEY_SUBSTRINGS_RAW = [
  'password',
  'service_role',
  'auth_token',
  'access_token',
  'refresh_token',
  'api_key',
  'secret',
  'ssn',
  'social_security',
  'passport',
  'card_number',
  'cvv',
  'street_address',
  'phone_number',
  'email',
];

// Value shapes that must never appear even under an innocuous-looking key —
// e.g. a raw bank account number or a JWT accidentally passed through.
const BANNED_VALUE_PATTERNS: RegExp[] = [
  /^[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{10,}\.[A-Za-z0-9-_]{10,}$/, // JWT-shaped
  /\b\d{9,18}\b.*\b(account|acct)\b/i,
  /^sk-[A-Za-z0-9]{16,}$/, // OpenAI-style secret key
];

export interface AllowlistViolation {
  path: string;
  reason: string;
}

function normalise(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, '');
}

const BANNED_KEY_SUBSTRINGS = BANNED_KEY_SUBSTRINGS_RAW.map(normalise);

export function scanForBannedFields(value: unknown, path = '$'): AllowlistViolation[] {
  const violations: AllowlistViolation[] = [];

  if (value === null || value === undefined) return violations;

  if (typeof value === 'string') {
    for (const pattern of BANNED_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        violations.push({ path, reason: `Value at ${path} matches a banned value shape (${pattern.source}).` });
      }
    }
    return violations;
  }

  if (Array.isArray(value)) {
    value.forEach((item, i) => violations.push(...scanForBannedFields(item, `${path}[${i}]`)));
    return violations;
  }

  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const normalisedKey = normalise(key);
      if (BANNED_KEY_SUBSTRINGS.some((banned) => normalisedKey.includes(banned))) {
        violations.push({ path: `${path}.${key}`, reason: `Key "${key}" matches a banned field name.` });
        continue;
      }
      violations.push(...scanForBannedFields(val, `${path}.${key}`));
    }
  }

  return violations;
}

/**
 * Throws if the object about to be sent to a provider contains anything
 * banned. Called as the final step of FinancialContextObject construction,
 * and independently by tests that assert privacy guarantees directly.
 */
export function assertAllowlisted(value: unknown): void {
  const violations = scanForBannedFields(value);
  if (violations.length > 0) {
    throw new Error(
      `Financial Context Object failed the allowlist scan: ${violations.map((v) => `${v.path} (${v.reason})`).join('; ')}`
    );
  }
}
