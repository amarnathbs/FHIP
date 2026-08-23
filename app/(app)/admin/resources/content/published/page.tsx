import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

export default async function ResourcesPublishedPage() {
  await requireResourceAdminAccess();
  return <ResourceContentListClient queue="published" title="Published" description="Content that is live and publicly visible." />;
}
