import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent } from '@/lib/resources/permissions';
import { MoneyUpdateListClient } from '@/components/resources/money-update/MoneyUpdateListClient';

async function MoneyUpdatesPageContent() {
  const current = await requireResourceAdminAccess();
  return <MoneyUpdateListClient canCreate={canCreateSpecialistContent(current)} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Resources).
export default function MoneyUpdatesPage() {
  return (
    <>
      <PageBackLink href="/admin/resources" label="Resources" />
      <MoneyUpdatesPageContent />
    </>
  );
}
