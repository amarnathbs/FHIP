/**
 * AIE-1.5 — evidence reveal (section 10/11, EVID-04/06/10, MASK-01..12),
 * AS SUPERSEDED BY THE PRODUCT OWNER'S 2026-09-15 TOKENISATION DECISION.
 *
 * WHAT CHANGED, AND WHY THIS FILE STILL EXISTS.
 *
 * AIE-1.5 shipped an ownership-checked, audited, one-token-at-a-time reveal
 * that decrypted `aie_mask_token_map.ciphertext` and handed the reviewing
 * user back their own original value. That worked because masking used
 * opaque counter tokens plus a reversible AES-256-GCM escrow map.
 *
 * M2 recorded the conflict (`PO-BLOCKER-2`): global invariant D.6 requires
 * keyed ONE-WAY HMAC pseudonyms, "never reversible/dictionary-vulnerable",
 * and an escrow map is the opposite of that. The Product Owner resolved it
 * on 2026-09-15 in favour of D.6: **one-way HMAC, no reveal**, explicitly
 * understanding and accepting that a user will never see their own original
 * folio / account / PAN / holder-name / nominee value again once it has been
 * tokenised — including during their own document review.
 *
 * So this module no longer reveals anything. It is kept, rather than
 * deleted, for three reasons that are all about honesty rather than
 * convenience:
 *   1. `POST /api/aie/review/runs/{runId}/reveal` may already be called by a
 *      client. A typed, audited refusal is a better answer than a 404 from a
 *      route that vanished.
 *   2. The refusal is itself worth auditing — "a user asked to see an
 *      original value and the system structurally could not provide it" is a
 *      real privacy-posture fact, and `AUD-01` wants it recorded.
 *   3. Leaving a named, documented refusal in the place the capability used
 *      to live stops a future change from quietly reinstating a decrypt path
 *      as though the decision had never been made.
 *
 * THERE IS NO DECRYPT PATH LEFT TO GATE. This is not a feature flag turned
 * off. `lib/aie/masking/tokenMapCrypto.ts` is gone, `persistMaskTokenMap`
 * and `findMaskTokenCiphertext` are gone from the repository, and `maskText`
 * no longer retains original values past the callback that MACs them. Even
 * with every flag on and full database access, there is nothing to reverse:
 * recovering the original from a token would mean breaking HMAC-SHA256 or
 * obtaining the server-held key. Verified read-only on 2026-09-15:
 * `aie_mask_token_map` holds zero rows in DEV and zero in production, so no
 * historical escrow row exists either.
 */

import { getRunForUser } from '../db/repository';
import { isOneWayIdentifierToken } from '../masking/identifierToken';
import { recordAieAuditEvent } from '../audit';

export type RevealTokenOutcome =
  | { ok: false; reason: 'not_found' | 'forbidden' | 'not_revealable_one_way_masking' }
  | { ok: true; value: string };

const MASK_TOKEN_SHAPE = /^\[MASKED:[a-z_]+:[a-z]+:[0-9a-z]+\]$/i;

export interface RevealDeps {
  getRunForUser: typeof getRunForUser;
  audit: typeof recordAieAuditEvent;
}

export function createDefaultRevealDeps(): RevealDeps {
  return { getRunForUser, audit: recordAieAuditEvent };
}

/**
 * Always refuses a genuine masked token, with the typed reason
 * `not_revealable_one_way_masking`.
 *
 * ORDER OF CHECKS IS DELIBERATE. Token shape is validated first, so a
 * malformed or guessed token is still `not_found` and cannot be used to
 * probe which runs exist. Ownership is then checked BEFORE the refusal is
 * audited, so the audit trail attributes the attempt to a user who actually
 * owns the run rather than letting an unrelated caller write audit rows
 * against someone else's document (IDOR discipline, PRIV-06) — the refusal
 * itself would be identical either way, but the audit row would not be.
 */
export async function revealMaskedToken(
  params: { runId: string; userId: string; token: string; actorId: string },
  deps: RevealDeps = createDefaultRevealDeps(),
): Promise<RevealTokenOutcome> {
  if (!MASK_TOKEN_SHAPE.test(params.token)) return { ok: false, reason: 'not_found' };

  const run = await deps.getRunForUser(params.runId, params.userId);
  if (!run) return { ok: false, reason: 'forbidden' };

  // AUD-01/EVID-10: audit the ATTEMPT. Metadata carries the token (an opaque
  // pseudonym, never a plaintext) and the fact that the scheme made the
  // request unsatisfiable — never a value, because none exists to carry.
  await deps.audit({
    intakeId: run.intakeId,
    runId: run.id,
    userId: run.userId,
    eventType: 'evidence_reveal_refused_one_way_masking',
    actorType: 'user',
    actorId: params.actorId,
    metadata: { token: params.token, one_way_token: isOneWayIdentifierToken(params.token) },
  });

  return { ok: false, reason: 'not_revealable_one_way_masking' };
}
