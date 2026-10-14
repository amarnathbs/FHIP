import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

async function ResourcesReviewQueuePageContent() {
  await requireResourceAdminAccess();
  return (
    <ResourceContentListClient
      queue="review"
      title="Review Queue"
      description="Content in Editorial Review, Compliance Review, or Approved and awaiting publication."
    />
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (All Content).
export default function ResourcesReviewQueuePage() {
  return (
    <>
      <PageBackLink href="/admin/resources/content" label="All Content" />
      <ResourcesReviewQueuePageContent />
    </>
  );
}
