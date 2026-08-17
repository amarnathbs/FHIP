import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent } from '@/lib/resources/permissions';
import { MoneyUpdateNewChooser } from '@/components/resources/money-update/MoneyUpdateNewChooser';

export default async function NewMoneyUpdatePage() {
  const current = await requireResourceAdminAccess();
  return <MoneyUpdateNewChooser canCreate={canCreateSpecialistContent(current)} />;
}
