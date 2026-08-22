import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

export default async function ResourcesReviewDuePage() {
  await requireResourceAdminAccess();
  return <ResourceContentListClient queue="review-due" title="Review Due" description="Published content that is due for a periodic content review." />;
}
