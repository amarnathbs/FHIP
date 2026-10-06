import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent } from '@/lib/resources/permissions';
import { MoneyUpdateNewChooser } from '@/components/resources/money-update/MoneyUpdateNewChooser';

async function NewMoneyUpdatePageContent() {
  const current = await requireResourceAdminAccess();
  return <MoneyUpdateNewChooser canCreate={canCreateSpecialistContent(current)} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Money Updates).
export default function NewMoneyUpdatePage() {
  return (
    <>
      <PageBackLink href="/admin/resources/money-updates" label="Money Updates" />
      <NewMoneyUpdatePageContent />
    </>
  );
}
