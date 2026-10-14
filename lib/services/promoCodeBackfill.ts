// Server-only. The digest backfill for codes created BEFORE hash only storage (hardening 0264/0265, deploy safety).
//
// WHY THIS IS A SERVER FUNCTION. The keyed digest needs PROMO_CODE_DIGEST_SECRET, which must never reach the database or the
// operator's browser. The PO applies migrations by hand in the SQL editor and has no Node toolchain at hand, so the backfill
// runs here, inside the deployed application, behind the promo capability, from one button on the Promo Codes page. The
// operator script scripts/promo_code_digest_backfill.mjs does the same job from a workstation; both call the same database
// functions and a test asserts they compute the same digest.
//
// WHAT IT DOES, for every row that still has a plain value and no verified digest: computes the keyed digest of the plain value,
// stores it (promo_codes_digest_apply), then recomputes it independently from the value read back and asks the database to mark
// the row verified ONLY if the stored digest equals that recomputation (promo_codes_digest_mark_verified). It NEVER blanks a
// plain value (that is the separate, deliberate finalise step), never returns or logs a code or a digest, and is safe to repeat:
// a row that is already verified is not touched. Until a row is verified, redemption still finds it through the legacy plain lookup,
// so every existing code keeps working at every step.

import { computePromoDigest } from '@/lib/services/promoCodeDigest';
import type { DigestKeys } from '@/lib/services/promoSecrets';

interface RpcResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}
export interface BackfillClient {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
}

export interface BackfillSummary {
  rowsSeen: number;
  digestsStored: number;
  rowsVerified: number;
  rowsNotVerified: number;
  /** True when the loop stopped because a page made no progress (a row could not be verified). */
  stalled: boolean;
  /** Set when a database call failed; the counts above are what was done before it. */
  failure: string | null;
  /** The database error code behind `failure`, if any (to tell a missing function from a fault). */
  failureCode: string | null;
}

/** A page is at most this many rows (the database function caps it at 1000). */
export const BACKFILL_PAGE = 200;
/** Hard ceiling per run so a button click can never run unbounded. A second click continues. */
export const BACKFILL_MAX_ROWS_PER_RUN = 2000;

interface PendingRow {
  id: string;
  code: string | null;
}

export async function runDigestBackfill(opts: { db: BackfillClient; keys: DigestKeys; actorId?: string | null }): Promise<BackfillSummary> {
  const { db, keys } = opts;
  const out: BackfillSummary = { rowsSeen: 0, digestsStored: 0, rowsVerified: 0, rowsNotVerified: 0, stalled: false, failure: null, failureCode: null };
  const fail = (what: string, e: { code?: string } | null) => {
    out.failure = `${what} failed${e?.code ? ` (${e.code})` : ''}`;
    out.failureCode = e?.code ?? null;
    return out;
  };

  while (out.rowsSeen < BACKFILL_MAX_ROWS_PER_RUN) {
    const page = await db.rpc('promo_codes_digest_pending', { p_limit: BACKFILL_PAGE });
    if (page.error) return fail('reading the pending codes', page.error);
    const rows = (page.data ?? []) as PendingRow[];
    if (rows.length === 0) break;
    out.rowsSeen += rows.length;
    let progressed = 0;
    for (const row of rows) {
      if (typeof row.code !== 'string' || row.code === '') {
        out.rowsNotVerified += 1;
        continue;
      }
      const stored = await db.rpc('promo_codes_digest_apply', { p_id: row.id, p_digest: computePromoDigest(row.code, keys.current), p_version: keys.current.version });
      if (stored.error) {
        out.rowsNotVerified += 1;
        continue;
      }
      out.digestsStored += 1;
      // The independent recomputation: the database marks the row verified only when it equals what it stored.
      const verified = await db.rpc('promo_codes_digest_mark_verified', { p_id: row.id, p_recomputed_digest: computePromoDigest(row.code, keys.current) });
      if (verified.data === true) {
        out.rowsVerified += 1;
        progressed += 1;
      } else out.rowsNotVerified += 1;
    }
    if (progressed === 0) {
      out.stalled = true;
      break;
    }
  }

  // Evidence row, counts only. A failure to write it never hides the result.
  try {
    await db.rpc('promo_codes_backfill_record', { p_actor: opts.actorId ?? null, p_rows_seen: out.rowsSeen, p_rows_verified: out.rowsVerified });
  } catch {
    /* evidence is best effort */
  }
  return out;
}
