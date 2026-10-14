import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

async function ResourcesScheduledPageContent() {
  await requireResourceAdminAccess();
  return <ResourceContentListClient queue="scheduled" title="Scheduled" description="Content approved and scheduled for future publication." />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (All Content).
export default function ResourcesScheduledPage() {
  return (
    <>
      <PageBackLink href="/admin/resources/content" label="All Content" />
      <ResourcesScheduledPageContent />
    </>
  );
}
