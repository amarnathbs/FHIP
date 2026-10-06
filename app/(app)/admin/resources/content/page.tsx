import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canDeleteDraftResource } from '@/lib/resources/permissions';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

export default async function ResourcesAllContentPage() {
  const current = await requireResourceAdminAccess();
  return <ResourceContentListClient title="All Content" description="Browse, filter and manage Resources content across the publishing workflow." canDeleteDrafts={canDeleteDraftResource(current)} />;
}
