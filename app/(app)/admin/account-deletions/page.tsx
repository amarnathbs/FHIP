import { requireAccountDeletionAdminPage } from '@/lib/services/accountDeletionAdmin';
import { AccountDeletionQueueClient } from '@/components/admin/AccountDeletionQueueClient';

export default async function AccountDeletionQueuePage() {
  await requireAccountDeletionAdminPage();
  return <AccountDeletionQueueClient />;
}
