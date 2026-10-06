import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireAccountDeletionAdminPage } from '@/lib/services/accountDeletionAdmin';
import { AccountDeletionQueueClient } from '@/components/admin/AccountDeletionQueueClient';

async function AccountDeletionQueuePageContent() {
  await requireAccountDeletionAdminPage();
  return <AccountDeletionQueueClient />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Dashboard).
export default function AccountDeletionQueuePage() {
  return (
    <>
      <PageBackLink href="/dashboard" label="Dashboard" />
      <AccountDeletionQueuePageContent />
    </>
  );
}
