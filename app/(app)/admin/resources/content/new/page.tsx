import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateResource } from '@/lib/resources/permissions';
import { NewContentChooser } from '@/components/resources/editor/NewContentChooser';

// /admin/resources/content/new — spec §10. Server-resolves the create
// permission (never trusts a client-side role) and passes only the boolean
// down; the actual security boundary is still RLS ("authors insert own
// drafts") + the POST route's own re-check (spec §96).
export default async function NewResourceContentPage() {
  const current = await requireResourceAdminAccess();
  const canCreate = canCreateResource(current);
  return <NewContentChooser canCreate={canCreate} />;
}
