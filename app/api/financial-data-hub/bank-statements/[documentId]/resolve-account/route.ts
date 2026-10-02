import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { BankAccountAssignmentError, resolveStatementAccount } from '@/lib/financial-data-hub/services/bankAccountAssignment';
import { bankOwnerConflictResponse } from '@/lib/financial-data-hub/services/bankOwnerRequest';

// POST /api/financial-data-hub/bank-statements/{documentId}/resolve-account
//
// Settles WHICH ACCOUNT an already-uploaded bank statement belongs to when the
// upload could not tell (account_resolution = 'ambiguous'), without re-uploading
// the file. See lib/financial-data-hub/services/bankAccountAssignment.ts for the
// full rules.
//
//   {}                              -> try to resolve automatically (only where
//                                      deterministic); otherwise answer
//                                      { status: 'needs_choice', candidates }
//   { account_id }                  -> the user picked one of their accounts
//   { new_account_digits, new_account_name? }
//                                   -> "a different / new account" (also how a
//                                      prefilled suggestion is accepted), last 4-6 digits
//   + { confirm_owner_change: true }-> the user confirmed changing the owner an
//                                      existing account is recorded under
//
// Tenant-scoped: the statement and any chosen account must be the caller's own.
const bodySchema = z
  .object({
    account_id: z.string().uuid().optional(),
    new_account_digits: z.string().max(12).optional(),
    new_account_name: z.string().max(80).optional(),
    confirm_owner_change: z.boolean().optional(),
  })
  .strict();

export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isFdhDocumentUploadEnabled()) return bad('Bank statement uploads are not currently enabled in this environment.', 403);

  const raw = await req.json().catch(() => ({}));
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) return bad('Invalid request.', 422);

  try {
    const result = await resolveStatementAccount(user.id, documentId, {
      accountId: parsed.data.account_id,
      newAccountDigits: parsed.data.new_account_digits,
      newAccountName: parsed.data.new_account_name,
      confirmOwnerChange: parsed.data.confirm_owner_change,
    });
    if (result.status === 'assigned') {
      return ok({
        status: 'assigned',
        financial_account_id: result.financialAccountId,
        how: result.how,
        account: { display_name: result.account.displayName, last_digits: result.account.lastDigits },
      });
    }
    return ok({
      status: 'needs_choice',
      reason: result.reason,
      candidates: result.candidates.map((c) => ({ id: c.id, display_name: c.displayName, last_digits: c.lastDigits })),
      // What was read off the statement, for a prefilled "add it as a new account" (last digits only).
      suggestion: result.suggestion ? { institution_name: result.suggestion.institutionName, last_digits: result.suggestion.lastDigits } : null,
    });
  } catch (e) {
    const ownerConflict = bankOwnerConflictResponse(e);
    if (ownerConflict) return ownerConflict;
    if (e instanceof BankAccountAssignmentError) {
      const status = e.code === 'not_found' || e.code === 'account_not_found' ? 404 : e.code === 'already_assigned_to_other' || e.code === 'invalid_state' ? 409 : 422;
      return bad(e.message, status, e.code);
    }
    return bad('We could not assign this statement to an account. Please try again.', 500);
  }
}
