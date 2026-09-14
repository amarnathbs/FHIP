/**
 * AIE-1.5 — evidence reveal (section 10/11, EVID-04/06/10, MASK-01..12).
 *
 * Operates on AIE-1.1 core's own reversible mask-token-map mechanism
 * (`aie_mask_token_map` + `lib/aie/masking/tokenMapCrypto.ts`, migration
 * 0140) — the generic PII-masking step every run goes through before any
 * masked text reaches the AI fallback (`maskText`,
 * `lib/aie/masking/piiMasking.ts`). This is genuinely adapter-agnostic:
 * whatever adapter produced the run, a `[MASKED:<type>:<salt>:<n>]` token
 * appearing in its evidence can be revealed through this SAME path.
 *
 * NOT EVERY MASKED-LOOKING VALUE IS REVEALABLE THIS WAY — disclosed
 * limitation. Some adapters mask a field irreversibly at parse time (e.g.
 * Insurance's `maskPolicyNumber` in `lib/aie/adapters/insurance/parser.ts`
 * keeps only the last 4 digits and discards the rest before the value ever
 * becomes a field candidate — there is nothing left to reverse, by design,
 * since that field has no canonical column and exists for display/audit
 * only). `revealMaskedToken` below only ever succeeds for a token that
 * actually exists in `aie_mask_token_map` for THIS run; anything else
 * returns `not_found` — never a fabricated or partially-reconstructed
 * value.
 */

import { findMaskTokenCiphertext, getRunForUser } from '../db/repository';
import { decryptTokenValue } from '../masking/tokenMapCrypto';
import { recordAieAuditEvent } from '../audit';

export type RevealTokenOutcome = { ok: false; reason: 'not_found' | 'forbidden' } | { ok: true; value: string };

const MASK_TOKEN_SHAPE = /^\[MASKED:[a-z_]+:[a-z]+:[0-9a-z]+\]$/i;

export interface RevealDeps {
  getRunForUser: typeof getRunForUser;
  findMaskTokenCiphertext: typeof findMaskTokenCiphertext;
  decrypt: typeof decryptTokenValue;
  audit: typeof recordAieAuditEvent;
}

export function createDefaultRevealDeps(): RevealDeps {
  return { getRunForUser, findMaskTokenCiphertext, decrypt: decryptTokenValue, audit: recordAieAuditEvent };
}

/**
 * EVID-04/06/10: ownership-checked, minimum-necessary (one token per call,
 * never the whole mask map), audited reveal. MASK-03/PRIV-02: the caller
 * (API route) is responsible for never echoing `params.token` or the
 * returned value into a URL, log line or analytics event — this function
 * itself never logs either.
 */
export async function revealMaskedToken(params: { runId: string; userId: string; token: string; actorId: string }, deps: RevealDeps = createDefaultRevealDeps()): Promise<RevealTokenOutcome> {
  if (!MASK_TOKEN_SHAPE.test(params.token)) return { ok: false, reason: 'not_found' };

  const run = await deps.getRunForUser(params.runId, params.userId);
  if (!run) return { ok: false, reason: 'forbidden' };

  const ciphertext = await deps.findMaskTokenCiphertext(run.id, params.token);
  if (!ciphertext) return { ok: false, reason: 'not_found' };

  const value = deps.decrypt(ciphertext);

  // AUD-01/EVID-10: audit the reveal itself — metadata carries the TOKEN
  // (an opaque placeholder, never the plaintext) and never the revealed
  // value (P10/OBS-02: no raw PII in audit metadata).
  await deps.audit({ intakeId: run.intakeId, runId: run.id, userId: run.userId, eventType: 'evidence_revealed', actorType: 'user', actorId: params.actorId, metadata: { token: params.token } });

  return { ok: true, value };
}
