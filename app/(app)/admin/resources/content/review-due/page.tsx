import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

async function ResourcesReviewDuePageContent() {
  await requireResourceAdminAccess();
  return <ResourceContentListClient queue="review-due" title="Review Due" description="Published content that is due for a periodic content review." />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (All Content).
export default function ResourcesReviewDuePage() {
  return (
    <>
      <PageBackLink href="/admin/resources/content" label="All Content" />
      <ResourcesReviewDuePageContent />
    </>
  );
}
