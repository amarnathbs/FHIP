import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canDeleteDraftResource } from '@/lib/resources/permissions';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

async function ResourcesDraftsPageContent() {
  const current = await requireResourceAdminAccess();
  return <ResourceContentListClient queue="drafts" title="Drafts" description="Content in Idea or Draft status, not yet submitted for review." canDeleteDrafts={canDeleteDraftResource(current)} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (All Content).
export default function ResourcesDraftsPage() {
  return (
    <>
      <PageBackLink href="/admin/resources/content" label="All Content" />
      <ResourcesDraftsPageContent />
    </>
  );
}
