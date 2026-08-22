import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

export default async function ResourcesDraftsPage() {
  await requireResourceAdminAccess();
  return <ResourceContentListClient queue="drafts" title="Drafts" description="Content in Idea or Draft status, not yet submitted for review." />;
}
