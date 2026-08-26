// Client grants (POST) or revokes (DELETE) exactly one permission scope on
// their own relationship. There is deliberately no PATCH/"set full scope
// list" verb — every change is a single, individually-audited grant/revoke
// (spec section 47's "auditable" + section 49's "scope reduction must
// immediately remove access").
import { requireUser, ok, bad } from '@/lib/api';
import { grantScope, revokeScope } from '@/lib/services/professional-access/access';
import { isProfessionalScope } from '@/lib/services/professional-access/permissions';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  let body: { scope?: string };
  try {
    body = await req.json();
  } catch {
    return bad('Invalid JSON body.');
  }
  if (!body.scope || !isProfessionalScope(body.scope)) return bad('A valid scope is required.');
  const result = await grantScope(id, user.id, body.scope);
  if (!result.ok) return bad(result.error ?? 'Failed to grant scope.');
  return ok({ granted: body.scope });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const url = new URL(req.url);
  const scope = url.searchParams.get('scope');
  if (!scope || !isProfessionalScope(scope)) return bad('A valid scope query parameter is required.');
  const result = await revokeScope(id, user.id, scope);
  if (!result.ok) return bad(result.error ?? 'Failed to revoke scope.');
  return ok({ revoked: scope });
}
