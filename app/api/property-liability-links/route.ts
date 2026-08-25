import { requireUser, ok, bad } from '@/lib/api';
import { propertyLiabilityLinkSchema } from '@/lib/validation/propertyLiabilityLink';
import {
  listPropertyLiabilityLinks,
  listLinksForLiability,
  listLinksForProperty,
  listEligibleLiabilities,
  createPropertyLiabilityLink,
} from '@/lib/services/propertyLiabilityLinksData';

// GET supports optional filters so both the Property side ("what finances
// this property?") and the Liability side ("what does this loan finance?")
// can query the same canonical relationship (spec s.14-18: bidirectional --
// one relationship record, visible correctly from both pages).
//   ?liability_id=<id>                        -> active links for one liability
//   ?asset_id=<id> | ?investment_id=<id>       -> active links for one property
//   ?eligible_liabilities=1                    -> this user's linkable liabilities
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const url = new URL(req.url);

  if (url.searchParams.get('eligible_liabilities')) {
    const { data, error } = await listEligibleLiabilities(user.id);
    return error ? bad(error.message) : ok(data);
  }

  const liabilityId = url.searchParams.get('liability_id');
  if (liabilityId) {
    const { data, error } = await listLinksForLiability(user.id, liabilityId);
    return error ? bad(error.message) : ok(data);
  }

  const assetId = url.searchParams.get('asset_id');
  if (assetId) {
    const { data, error } = await listLinksForProperty(user.id, 'asset', assetId);
    return error ? bad(error.message) : ok(data);
  }

  const investmentId = url.searchParams.get('investment_id');
  if (investmentId) {
    const { data, error } = await listLinksForProperty(user.id, 'investment', investmentId);
    return error ? bad(error.message) : ok(data);
  }

  const { data, error } = await listPropertyLiabilityLinks(user.id);
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = propertyLiabilityLinkSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);
  const { data, error } = await createPropertyLiabilityLink(user.id, parsed.data);
  return error ? bad(error.message, 422) : ok(data);
}
