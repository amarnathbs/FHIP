import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

async function ResourcesArchivedPageContent() {
  await requireResourceAdminAccess();
  return <ResourceContentListClient queue="archived" title="Archived" description="Retired content, no longer active in the publishing workflow." />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (All Content).
export default function ResourcesArchivedPage() {
  return (
    <>
      <PageBackLink href="/admin/resources/content" label="All Content" />
      <ResourcesArchivedPageContent />
    </>
  );
}
