import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageFaqs } from '@/lib/resources/permissions';
import { FaqListClient } from '@/components/resources/faq/FaqListClient';

async function FaqsPageContent() {
  const current = await requireResourceAdminAccess();
  return <FaqListClient canCreate={canManageFaqs(current)} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Resources).
export default function FaqsPage() {
  return (
    <>
      <PageBackLink href="/admin/resources" label="Resources" />
      <FaqsPageContent />
    </>
  );
}
