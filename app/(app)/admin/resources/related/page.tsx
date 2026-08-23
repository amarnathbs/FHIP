import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageDiscovery } from '@/lib/resources/permissions';
import { RelatedContentManager } from '@/components/resources/related/RelatedContentManager';

export default async function RelatedContentPage() {
  const current = await requireResourceAdminAccess();
  return <RelatedContentManager canManage={canManageDiscovery(current)} />;
}
