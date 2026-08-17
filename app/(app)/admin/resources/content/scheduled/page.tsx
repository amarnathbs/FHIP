import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

export default async function ResourcesScheduledPage() {
  await requireResourceAdminAccess();
  return <ResourceContentListClient queue="scheduled" title="Scheduled" description="Content approved and scheduled for future publication." />;
}
