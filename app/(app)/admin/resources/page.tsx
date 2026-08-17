import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { ResourcesDashboardClient } from '@/components/resources/admin/ResourcesDashboardClient';

export default async function ResourcesAdminDashboardPage() {
  await requireResourceAdminAccess();
  return <ResourcesDashboardClient />;
}
