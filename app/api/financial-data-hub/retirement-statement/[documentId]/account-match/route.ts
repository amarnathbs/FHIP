import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { getRetirementStatementIdForDocument } from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
// Canonical Retirement is read by the BRIDGE, never by the Hub — see that
// module's header and `tests/unit/fdh1Isolation.test.ts`.
import { resolveRetirementStatementAccount } from '@/lib/retirement-import-bridge/retirementAccountResolution';

// POST /api/financial-data-hub/retirement-statement/{documentId}/account-match
//
// Resolve which canonical retirement account and household member this
// statement belongs to (spec sections 14-19, 112, 132).
//
// MATCHING IS NOT APPLYING (spec section 56). This route reads canonical
// Retirement and writes only the FDH-12 statement row's match state. The
// canonical account itself is untouched.

const bodySchema = z.union([
  // Run the automatic matcher.
  z.object({ action: z.literal('auto') }),
  // The user picked an existing account from the candidate list.
  z.object({
    action: z.literal('resolve'),
    account_id: z.string().uuid(),
    member_id: z.string().uuid().optional(),
  }),
  // The user chose ADD NEW RETIREMENT ACCOUNT (spec section 19). No canonical
  // row is created here — that happens only at Apply, through the canonical
  // service, never by direct client insert (spec section 103).
  z.object({
    action: z.literal('confirm_new'),
    member_id: z.string().uuid().optional(),
  }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getRetirementStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return bad('Unrecognised request.', 400);
  const body = parsed.data;

  const result = await resolveRetirementStatementAccount(user.id, statementId, {
    userConfirmedAccountId: body.action === 'resolve' ? body.account_id : null,
    userConfirmedMemberId: 'member_id' in body ? (body.member_id ?? null) : null,
    confirmNewAccount: body.action === 'confirm_new',
  });

  if (result.error === 'routed_to_smsf') {
    return bad(
      'This looks like a self-managed super fund statement. SMSFs are managed in the SMSF section of the Retirement page.',
      409,
    );
  }
  if (result.error === 'smsf_account_not_importable') {
    return bad(
      'That is a self-managed super fund account. Its balance is managed in the SMSF section, so a statement import cannot change it.',
      409,
    );
  }
  if (result.error) return bad(result.error, 400);

  return ok({
    statement_id: statementId,
    account_match_status: result.status,
    canonical_account_id: result.accountId,
    retirement_member_id: result.memberId,
  });
}
