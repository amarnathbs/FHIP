import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

async function ResourcesPublishedPageContent() {
  await requireResourceAdminAccess();
  return <ResourceContentListClient queue="published" title="Published" description="Content that is live and publicly visible." />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (All Content).
export default function ResourcesPublishedPage() {
  return (
    <>
      <PageBackLink href="/admin/resources/content" label="All Content" />
      <ResourcesPublishedPageContent />
    </>
  );
}
