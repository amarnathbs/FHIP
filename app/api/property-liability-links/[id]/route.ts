import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { propertyLiabilityLinkSchema } from '@/lib/validation/propertyLiabilityLink';
import { unlinkPropertyLiabilityLink, updatePropertyLiabilityLink } from '@/lib/services/propertyLiabilityLinksData';

// PATCH allows editing allocation/link_type/notes on an existing link
// without unlinking and relinking (spec s.56: "Change Link" / allocation
// adjustment for cross-collateralised facilities).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = propertyLiabilityLinkSchema
    .innerType()
    .pick({ link_type: true, allocation_percent: true, allocation_amount: true, is_primary: true, notes: true })
    .partial()
    .safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);
  const { data, error } = await updatePropertyLiabilityLink(user.id, id, parsed.data);
  return error ? bad(error.message, 422) : ok(data);
}

// DELETE = unlink (spec s.19-24): removes only the relationship record
// (soft-deactivates it), never the property or the liability, and never
// changes either record's stored value/balance.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { data, error } = await unlinkPropertyLiabilityLink(user.id, id);
  return error ? bad(error.message) : ok({ unlinked: true, link: data });
}
