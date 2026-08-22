import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageDiscovery } from '@/lib/resources/permissions';
import { ContextMappingManager } from '@/components/resources/context/ContextMappingManager';

export default async function ContextMappingPage() {
  const current = await requireResourceAdminAccess();
  return <ContextMappingManager canManage={canManageDiscovery(current)} />;
}
