import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { iiManualDirectPositionSchema } from '@/lib/validation/investment-intelligence';
import { submitManualDirectPosition } from '@/lib/services/investment-intelligence/manualDirectPositionService';

// Investment Intelligence R12 — the first real, user-facing manual-entry
// route for Investment Intelligence (see
// R12_WIDER_INDIA_ASSETS_ARCHITECTURE_DISCOVERY.md section 2.6). Frozen to
// R12's scope: direct listed Indian equity + equity-oriented ETF only
// (enforced by iiManualDirectPositionSchema — instrumentClass is
// restricted to 'equity' | 'etf' at the Zod layer, not just documented).
//
// Every write happens through submitManualDirectPosition() ->
// importManualFixture(), both service-role-mediated — the authenticated
// caller never writes ii_instruments/ii_transactions/ii_holding_snapshots
// directly (matches the RLS posture ii_transactions/ii_holding_snapshots
// carry after migration 0092: SELECT-only for the authenticated role).
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = iiManualDirectPositionSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.message, 422);

  const result = await submitManualDirectPosition(user.id, parsed.data);
  if (result.validationError) return bad(result.validationError, 422);
  if (result.error) return bad(result.error, 400);

  return ok({
    sourceDocumentId: result.sourceDocumentId,
    accountId: result.accountId,
    instrumentId: result.instrumentId,
    transactionIds: result.transactionIds,
    holdingSnapshotId: result.holdingSnapshotId,
    taxClassificationSeeded: result.taxClassificationSeeded,
    unitsAfter: result.unitsAfter,
    valueAfter: result.valueAfter,
  });
}
