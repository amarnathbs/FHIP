import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageDiscovery } from '@/lib/resources/permissions';
import { CtaListClient } from '@/components/resources/cta/CtaListClient';

export default async function CtasPage() {
  const current = await requireResourceAdminAccess();
  return <CtaListClient canManage={canManageDiscovery(current)} />;
}
