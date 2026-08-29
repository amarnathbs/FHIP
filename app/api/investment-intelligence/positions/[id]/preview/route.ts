import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { buildPreview } from '@/lib/services/investment-intelligence/investmentPublicationService';

// R3 spec section 12/61 — publication preview. Read-only: computes
// eligibility, owner/mapping preview, duplicate candidates, financial
// impact and cross-border preview, but writes nothing to any FHIP register
// (only an audit 'publication_previewed' event is recorded).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { preview, error } = await buildPreview(user.id, id);
  if (error) return bad(error, 404);
  return ok(preview);
}
