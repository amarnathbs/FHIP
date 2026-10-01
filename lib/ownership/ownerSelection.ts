/**
 * Owner-before-upload (Phase 1) -- the shared, CLIENT-SAFE owner-selection
 * contract.
 *
 * The user says WHO a document belongs to before the file is sent, so there is
 * no after-upload ownership review. This module is the one wire format both
 * the browser (OwnerSelector) and the server (validateOwnerSelection) speak.
 * It is pure: no database, no React, no environment, so it can be imported by
 * either side and unit-tested directly.
 *
 * WHAT THE SELECTION CAN SAY
 *   - member  : one household member (Self, Spouse/Partner, any other member)
 *   - entity  : one registered business entity (Family Trust, HUF, Company)
 *   - joint   : two or more owners with a share each (basis points out of
 *               10000). Percentages are REQUIRED for investment documents and
 *               not used for bank statements (a bank joint account still
 *               counts 100% to the household today); the per-flow rule lives
 *               in validateOwnerSelection, not here.
 *   - smsf    : the user's SMSF (AU only; the SMSF is not a business entity,
 *               it lives in smsf_funds, so it has no id here)
 *
 * WHAT IT DELIBERATELY DOES NOT CARRY: a country. Whether HUF or SMSF is
 * permitted is decided from the user's AUTHORITATIVE home country on the
 * server (lib/services/jurisdiction.ts), never from anything in this payload.
 *
 * SHARES ARE BASIS POINTS ON THE WIRE. The UI shows and edits percent; it
 * converts with `percentToBasisPoints`. Integers out of 10000 are what
 * lib/pc5/jointAllocation.ts `validateAllocation` checks, so a three-way split
 * (3333 + 3333 + 3334) is exact.
 */

import { z } from 'zod';

export const OWNER_SELECTION_KINDS = ['member', 'entity', 'joint', 'smsf'] as const;
export type OwnerSelectionKind = (typeof OWNER_SELECTION_KINDS)[number];

/** The upload flows that take an owner. Phase 1 ships the first two only. */
export const OWNER_FLOWS = ['bank', 'ii_cas'] as const;
export type OwnerFlow = (typeof OWNER_FLOWS)[number];

export function isOwnerFlow(value: unknown): value is OwnerFlow {
  return typeof value === 'string' && (OWNER_FLOWS as readonly string[]).includes(value);
}

/** Total basis points a joint allocation must sum to. Mirrors
 * PC5_TOTAL_BASIS_POINTS without importing server-only code into the client. */
export const OWNER_TOTAL_BASIS_POINTS = 10000;

const uuid = z.string().uuid();

/** One owner's share of a joint document. Exactly one of memberId / entityId. */
export const ownerAllocationEntrySchema = z
  .object({
    memberId: uuid.optional(),
    entityId: uuid.optional(),
    // Integer-ness is checked by validateAllocation so a fractional share gets its own,
    // specific refusal (joint_share_invalid) rather than a generic schema error.
    basisPoints: z.number().finite(),
  })
  .strict();
export type OwnerAllocationEntry = z.infer<typeof ownerAllocationEntrySchema>;

export const ownerSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), memberId: uuid }).strict(),
  z.object({ kind: z.literal('entity'), entityId: uuid }).strict(),
  z.object({ kind: z.literal('joint'), allocations: z.array(ownerAllocationEntrySchema).max(10).optional() }).strict(),
  z.object({ kind: z.literal('smsf') }).strict(),
]);
export type OwnerSelection = z.infer<typeof ownerSelectionSchema>;

// ---------------------------------------------------------------------------
// Wire helpers (query string for the bank routes, JSON meta for II).
// ---------------------------------------------------------------------------

/** The single query-string parameter the bank routes read the selection from. */
export const OWNER_SELECTION_QUERY_PARAM = 'owner';
/** Bank: the user has explicitly confirmed changing an existing account's owner. */
export const CONFIRM_OWNER_CHANGE_QUERY_PARAM = 'confirm_owner_change';

/** Sets the owner selection on a URLSearchParams. The value is the JSON of the
 * selection (ids and basis points only -- no names, no country). */
export function ownerSelectionToQuery(params: URLSearchParams, selection: OwnerSelection): URLSearchParams {
  params.set(OWNER_SELECTION_QUERY_PARAM, JSON.stringify(selection));
  return params;
}

/** The JSON-meta shape for multipart uploads (Investment Intelligence). */
export function ownerSelectionToMeta(selection: OwnerSelection): { owner: OwnerSelection } {
  return { owner: selection };
}

/** Reads the raw `owner` query value back into an unvalidated unknown. Returns
 * undefined when absent and the string `'__invalid_json__'` marker object when
 * the value is not JSON, so the validator reports `owner_invalid` rather than
 * `owner_required` for a garbled value. */
export function readOwnerSelectionParam(raw: string | null | undefined): unknown {
  if (raw === null || raw === undefined || raw.trim() === '') return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return { kind: '__invalid_json__' };
  }
}

// ---------------------------------------------------------------------------
// Percent <-> basis points (presentation only).
// ---------------------------------------------------------------------------

/** "33.34" -> 3334. Returns null for anything that is not a plain non-negative
 * number with at most two decimals (so "33.345" is refused rather than silently
 * rounded into a different share than the one the user typed). */
export function percentToBasisPoints(input: string | number): number | null {
  const text = typeof input === 'number' ? String(input) : input.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return null;
  const bp = Math.round(Number(text) * 100);
  return Number.isFinite(bp) ? bp : null;
}

/** 3334 -> "33.34". Presentation only; never used for arithmetic. */
export function basisPointsToPercentText(basisPoints: number): string {
  return (basisPoints / 100).toFixed(2).replace(/\.?0+$/, '');
}

/** An equal split for `count` owners; the remainder goes to the LAST owner, the
 * same rule lib/pc5/jointAllocation.ts `defaultEqualAllocation` applies. */
export function equalShares(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(OWNER_TOTAL_BASIS_POINTS / count);
  const remainder = OWNER_TOTAL_BASIS_POINTS - base * count;
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? base + remainder : base));
}
