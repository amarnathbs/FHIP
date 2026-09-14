/**
 * M3 (Phase 4) — KEYED ONE-WAY IDENTIFIER PSEUDONYMS.
 *
 * PRODUCT-OWNER DECISION, 2026-09-15. M2 recorded `PO-BLOCKER-2`: global
 * invariant D.6 requires "stable pseudonyms via keyed one-way HMAC, never
 * reversible/dictionary-vulnerable", while the implementation did the exact
 * opposite — opaque counter tokens (`[MASKED:<type>:<salt>:<counter>]`, with
 * no derivation from the value at all) plus an AES-256-GCM-encrypted
 * *escrow map* (`aie_mask_token_map`) that made the original value
 * recoverable through the evidence-reveal feature.
 *
 * The Product Owner chose **ONE-WAY HMAC, NO REVEAL**, explicitly accepting
 * the UX consequence: a user will never see their own original folio /
 * account / PAN / holder-name value again once it has been tokenised — not
 * even during their own document review. This module implements that
 * decision. `lib/aie/masking/tokenMapCrypto.ts` (the reversible AES path)
 * has been DELETED, along with the two repository functions that read and
 * wrote `aie_mask_token_map` — see `lib/aie/review/reveal.ts` for why the
 * reveal endpoint itself is kept as a typed, audited refusal rather than
 * removed.
 *
 * WHY THIS IS A GENUINE KEYED MAC AND NOT A HASH. A bare `sha256(folio)` is
 * trivially reversible for any low-entropy identifier — a mutual-fund folio
 * number, a 10-character PAN, an AU BSB+account are all small enough spaces
 * to enumerate exhaustively. The security property comes entirely from the
 * server-held key, which never leaves this process and is never sent to the
 * AI provider. HMAC-SHA256 is used rather than a bare keyed hash because it
 * is the standard construction and is available in `node:crypto` with no new
 * dependency (this codebase's established "no new npm package for something
 * node:crypto already does" convention).
 *
 * TENANT BINDING IS PART OF THE MAC INPUT, NOT AN AFTERTHOUGHT (PII-06:
 * "collision-resistant tokens, prevent cross-user correlation"). The MAC is
 * computed over `tenantKey || type || normalisedValue`, so:
 *   - the SAME folio in two documents belonging to the SAME user produces the
 *     SAME token — which is precisely the "account/folio stable token" the
 *     M3 AI investment JSON contract (I.4) requires, and which the previous
 *     per-call-counter scheme could never provide;
 *   - the SAME folio belonging to TWO DIFFERENT users produces DIFFERENT
 *     tokens, so an AI provider observing many documents cannot correlate
 *     users by identifier. The old scheme got this right only by accident
 *     (a fresh random salt per call) and at the cost of stability.
 *
 * TOKEN ALPHABET IS DELIBERATELY LETTERS-ONLY. The MAC is rendered as 24
 * characters drawn from `a`-`p` (one character per nibble) rather than hex,
 * for exactly the reason the previous salt generator documented for itself:
 * `maskText` applies its patterns in sequence over progressively-masked
 * text, so a placeholder containing a long digit run would be re-matched by
 * a LATER pattern (`long_digit_run` is `\d{11,}`; `card_number` is 13-19
 * digits) and double-tokenised. 24 nibbles is 96 bits of MAC — far beyond
 * collision risk for this use, and structurally immune to that re-match.
 * The resulting token also still satisfies the pre-existing
 * `/^\[MASKED:[a-z_]+:[a-z]+:[0-9a-z]+\]$/i` shape every existing consumer
 * (reveal route, `EvidenceValue`) already tests against, so no consumer had
 * to be loosened to accept it.
 *
 * KEY MANAGEMENT. Derives its MAC key from the SAME single server-held
 * secret the masking subsystem already requires, `AIE_MASK_TOKEN_ENCRYPTION_KEY`
 * (operator item OA-6), via one-step HKDF-style domain separation rather
 * than introducing a second secret an operator would have to provision
 * separately. The derived subkey is domain-separated by a fixed info string,
 * so the MAC key and the legacy AES key are cryptographically independent
 * even though they come from one master secret. Fails CLOSED and LOUDLY on a
 * missing/short key — this module throws rather than falling back to an
 * unkeyed hash. That is the intended behaviour: no key means no masking
 * means no AI egress.
 */

import { createHmac } from 'node:crypto';

/** Fixed domain-separation string. Changing it rotates every token; it is
 * versioned so a deliberate rotation is an explicit, reviewable edit. */
const MAC_KEY_INFO = 'aie/mask-token/one-way-hmac/v1';

/** The token's scheme segment. Letters-only so the token keeps matching the
 * pre-existing `[MASKED:<type>:<letters>:<alnum>]` shape, and self-describing
 * so a reader (and `reveal.ts`) can tell a one-way token from a legacy
 * reversible one by inspection alone. */
export const ONE_WAY_TOKEN_SCHEME = 'hmac';

/** 12 bytes => 24 nibble-characters => 96 bits. */
const MAC_BYTES = 12;

const NIBBLE_ALPHABET = 'abcdefghijklmnop';

function loadMasterKey(): Buffer {
  const hex = process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      'AIE_MASK_TOKEN_ENCRYPTION_KEY is not set or is not a 64-character hex string (32 bytes). ' +
        'It is required before any identifier can be tokenised — masking fails closed without it, ' +
        'which also means no AI fallback can run. See operator item OA-6.',
    );
  }
  return Buffer.from(hex, 'hex');
}

/** One-step HKDF-style expansion. Deliberately NOT cached across calls in a
 * module-level variable: `process.env` is mutated by tests (and by a
 * hot-reloading dev server), and a cached subkey derived from a stale master
 * would silently keep producing tokens under the old key. The cost is one
 * HMAC per call, which is negligible against the per-document work. */
function deriveMacKey(): Buffer {
  return createHmac('sha256', loadMasterKey()).update(MAC_KEY_INFO, 'utf8').digest();
}

/**
 * Value normalisation before the MAC. Stability is the whole point of a
 * keyed pseudonym, so two renderings of the same identifier must produce the
 * same token: `Folio No: 1234567 / 89` and `Folio No: 1234567/89` are the
 * same folio, and `RAJESH KUMAR SHARMA` and `Rajesh Kumar Sharma` are the
 * same holder.
 *
 * Deliberately conservative: it collapses whitespace, strips the separator
 * characters that genuinely vary between renderings of one identifier, and
 * upper-cases. It does NOT attempt any domain-specific canonicalisation
 * (e.g. stripping a folio's check-digit suffix) — over-normalising would
 * collapse two genuinely different identifiers into one token, which is a
 * correctness bug that would be invisible until it silently merged two
 * accounts.
 */
export function normaliseIdentifierForToken(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\s\-.]/g, '')
    .toUpperCase();
}

function renderMac(mac: Buffer): string {
  let out = '';
  for (const byte of mac.subarray(0, MAC_BYTES)) {
    out += NIBBLE_ALPHABET[(byte >> 4) & 0x0f];
    out += NIBBLE_ALPHABET[byte & 0x0f];
  }
  return out;
}

/**
 * The one-way pseudonym for one identifier value.
 *
 * `tenantKey` is REQUIRED and has no default — an omitted tenant would
 * silently produce globally-correlatable tokens, which is the exact failure
 * PII-06 exists to prevent, so it is a type error rather than a runtime
 * fallback. Callers pass the authenticated `user.id`.
 */
export function deriveIdentifierToken(params: { tenantKey: string; type: string; value: string }): string {
  if (!params.tenantKey) {
    throw new Error('deriveIdentifierToken: tenantKey is required — an untenanted token would be cross-user correlatable (PII-06).');
  }
  const normalised = normaliseIdentifierForToken(params.value);
  // LENGTH-PREFIXED, not separator-delimited. Without an injective encoding,
  // ('ab','c') and ('a','bc') would MAC identically, so two different
  // (tenant, type, value) triples could collide into one token. A separator
  // character would work only if it provably cannot occur in any of the three
  // inputs, which is not something a folio's charset guarantees; length
  // prefixes are injective unconditionally and need no such assumption.
  const macInput = `${params.tenantKey.length}:${params.tenantKey}${params.type.length}:${params.type}${normalised}`;
  const mac = createHmac('sha256', deriveMacKey()).update(macInput, 'utf8').digest();
  return `[MASKED:${params.type}:${ONE_WAY_TOKEN_SCHEME}:${renderMac(mac)}]`;
}

/** True for a token this module produced — i.e. one whose original value is
 * NOT recoverable by anybody, including the user who uploaded the document.
 * Used by `reveal.ts` to refuse structurally, before any database work. */
export function isOneWayIdentifierToken(token: string): boolean {
  return new RegExp(`^\\[MASKED:[a-z_]+:${ONE_WAY_TOKEN_SCHEME}:[a-p]+\\]$`).test(token);
}
