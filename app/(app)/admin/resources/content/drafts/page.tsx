import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canDeleteDraftResource } from '@/lib/resources/permissions';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

export default async function ResourcesDraftsPage() {
  const current = await requireResourceAdminAccess();
  return <ResourceContentListClient queue="drafts" title="Drafts" description="Content in Idea or Draft status, not yet submitted for review." canDeleteDrafts={canDeleteDraftResource(current)} />;
}
