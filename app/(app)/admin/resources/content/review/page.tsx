import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

export default async function ResourcesReviewQueuePage() {
  await requireResourceAdminAccess();
  return (
    <ResourceContentListClient
      queue="review"
      title="Review Queue"
      description="Content in Editorial Review, Compliance Review, or Approved and awaiting publication."
    />
  );
}
