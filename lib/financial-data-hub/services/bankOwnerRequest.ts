/**
 * Owner-before-upload (Phase 1) -- the bank upload routes' shared owner
 * handling, so the CSV and PDF routes cannot drift apart.
 *
 * Reads the structured owner selection from the query string, validates it
 * server-side for the bank flow, and maps the two refusals the upload services
 * can raise (decisions 2 and 6) onto precise HTTP answers.
 */

import { bad } from '@/lib/api';
import { validateOwnerSelection, type OwnerValidationResult } from '@/lib/ownership/validateOwnerSelection';
import { CONFIRM_OWNER_CHANGE_QUERY_PARAM, OWNER_SELECTION_QUERY_PARAM, readOwnerSelectionParam } from '@/lib/ownership/ownerSelection';
import {
  BankIdenticalUploadOwnerConflictError,
  BankOwnerConflictError,
  toBankUploadOwner,
  type BankUploadOptions,
  type BankUploadOwner,
} from './bankOwnerAttribution';

export type BankOwnerRequest =
  | { ok: true; owner: BankUploadOwner; options: BankUploadOptions }
  | { ok: false; response: Response };

/** Parses + validates the owner for a bank upload. A missing owner is refused
 * here, before the body is read. `validate` is injectable for tests. */
export async function resolveBankOwnerFromRequest(
  userId: string,
  url: URL,
  validate: (userId: string, input: unknown) => Promise<OwnerValidationResult> = (u, i) => validateOwnerSelection(u, i, 'bank'),
): Promise<BankOwnerRequest> {
  const raw = readOwnerSelectionParam(url.searchParams.get(OWNER_SELECTION_QUERY_PARAM));
  const verdict = await validate(userId, raw);
  if (!verdict.ok) return { ok: false, response: bad(verdict.message, verdict.status, verdict.code) };
  return {
    ok: true,
    owner: toBankUploadOwner(verdict.owner),
    options: { confirmOwnerChange: url.searchParams.get(CONFIRM_OWNER_CHANGE_QUERY_PARAM) === '1' },
  };
}

/** Maps the two owner refusals to 409 answers; returns null for anything else. */
export function bankOwnerConflictResponse(e: unknown): Response | null {
  if (e instanceof BankOwnerConflictError) {
    return Response.json(
      {
        error: e.code,
        message: e.message,
        existing_owner_role: e.existingOwnerRole,
        selected_owner_role: e.selectedOwnerRole,
        financial_account_id: e.accountId,
      },
      { status: 409 },
    );
  }
  if (e instanceof BankIdenticalUploadOwnerConflictError) {
    return Response.json(
      {
        error: e.code,
        message: e.message,
        existing_document_id: e.existingDocumentId,
        existing_owner_role: e.existingOwnerRole,
        selected_owner_role: e.selectedOwnerRole,
      },
      { status: 409 },
    );
  }
  return null;
}
