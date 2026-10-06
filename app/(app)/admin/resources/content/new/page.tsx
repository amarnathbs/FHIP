import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateResource } from '@/lib/resources/permissions';
import { NewContentChooser } from '@/components/resources/editor/NewContentChooser';

// /admin/resources/content/new — spec §10. Server-resolves the create
// permission (never trusts a client-side role) and passes only the boolean
// down; the actual security boundary is still RLS ("authors insert own
// drafts") + the POST route's own re-check (spec §96).
async function NewResourceContentPageContent() {
  const current = await requireResourceAdminAccess();
  const canCreate = canCreateResource(current);
  return <NewContentChooser canCreate={canCreate} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (All Content).
export default function NewResourceContentPage() {
  return (
    <>
      <PageBackLink href="/admin/resources/content" label="All Content" />
      <NewResourceContentPageContent />
    </>
  );
}
