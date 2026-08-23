import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

export default async function ResourcesArchivedPage() {
  await requireResourceAdminAccess();
  return <ResourceContentListClient queue="archived" title="Archived" description="Retired content, no longer active in the publishing workflow." />;
}
