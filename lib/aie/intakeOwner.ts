/**
 * Owner-before-upload -- AIE-fronted intakes.
 *
 * An AIE intake that can end in a canonical bank statement (fdh_bank adapter) or a canonical
 * Investment Intelligence source document must know WHO THE DOCUMENT BELONGS TO before a byte is
 * accepted. "AI is involved" is not a way around that: the owner the user chose is validated at
 * intake (same canonical validator as the interactive upload routes), stored on the intake row as
 * `aie_document_intake.owner_selection` (migration 0236), RE-VALIDATED against the user's CURRENT
 * household / entities at accept time, and only then handed to the canonical write.
 *
 * The owner is NEVER inferred from document text and never defaulted: a missing owner is refused
 * at intake (422 owner_required), and an intake that carries none (created before this change) is
 * refused at accept (it must be re-uploaded with an owner). Insurance has its own
 * ownerHouseholdRole gate and is unaffected.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { OWNER_SELECTION_QUERY_PARAM, readOwnerSelectionParam, type OwnerFlow } from '@/lib/ownership/ownerSelection';
import { validateOwnerSelection, type OwnerValidationResult, type ResolvedOwner } from '@/lib/ownership/validateOwnerSelection';

export type AieIntakeOwnerFlow = Extract<OwnerFlow, 'bank' | 'ii_cas'>;

export type AieIntakeOwnerRequest =
  | { ok: true; owner: ResolvedOwner; selection: Record<string, unknown> }
  | { ok: false; status: 403 | 422; code: string; message: string };

type Validate = (userId: string, input: unknown, flow: OwnerFlow) => Promise<OwnerValidationResult>;

/** Reads + validates the owner from the intake request. Refuses a missing owner BEFORE the body is read. */
export async function resolveAieIntakeOwner(userId: string, url: URL, flow: AieIntakeOwnerFlow, validate: Validate = validateOwnerSelection): Promise<AieIntakeOwnerRequest> {
  const raw = readOwnerSelectionParam(url.searchParams.get(OWNER_SELECTION_QUERY_PARAM));
  const verdict = await validate(userId, raw, flow);
  if (!verdict.ok) return { ok: false, status: verdict.status, code: verdict.code, message: verdict.message };
  // `raw` is a plain object here (the validator refused anything else); it is stored verbatim as the wire selection.
  return { ok: true, owner: verdict.owner, selection: raw as Record<string, unknown> };
}

export async function recordIntakeOwnerSelection(intakeId: string, userId: string, selection: Record<string, unknown>): Promise<boolean> {
  const admin = createAdminClient();
  const { error } = await admin
    .from('aie_document_intake')
    .update({ owner_selection: selection, updated_at: new Date().toISOString() })
    .eq('id', intakeId)
    .eq('user_id', userId);
  return !error;
}

export async function getIntakeOwnerSelection(intakeId: string, userId: string): Promise<unknown> {
  const admin = createAdminClient();
  const { data } = await admin.from('aie_document_intake').select('owner_selection').eq('id', intakeId).eq('user_id', userId).maybeSingle();
  return (data as { owner_selection?: unknown } | null)?.owner_selection ?? null;
}

export type IntakeOwnerOutcome = { ok: true; owner: ResolvedOwner } | { ok: false; message: string };

/**
 * ACCEPT-TIME gate: loads the owner stored at intake and validates it again against the user's
 * CURRENT household / entities / country (a member removed, an entity deactivated or a changed
 * country between upload and accept must not slip through).
 */
export async function resolveIntakeOwnerForAccept(
  userId: string,
  intakeId: string,
  flow: AieIntakeOwnerFlow,
  deps: { load?: (intakeId: string, userId: string) => Promise<unknown>; validate?: Validate } = {},
): Promise<IntakeOwnerOutcome> {
  const stored = await (deps.load ?? getIntakeOwnerSelection)(intakeId, userId);
  if (stored === null || stored === undefined) {
    return {
      ok: false,
      message: 'No document owner was recorded when this file was uploaded. Upload it again and choose who it belongs to before sending it.',
    };
  }
  const verdict = await (deps.validate ?? validateOwnerSelection)(userId, stored, flow);
  if (!verdict.ok) return { ok: false, message: `The owner chosen when this file was uploaded is no longer valid: ${verdict.message}` };
  return { ok: true, owner: verdict.owner };
}
