import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canBulkImportResources, canCreateSpecialistContent } from '@/lib/resources/permissions';
import { MoneyUpdateListClient } from '@/components/resources/money-update/MoneyUpdateListClient';

export default async function MoneyUpdatesPage() {
  const current = await requireResourceAdminAccess();
  return <MoneyUpdateListClient canCreate={canCreateSpecialistContent(current)} canBulkImport={canBulkImportResources(current)} />;
}
