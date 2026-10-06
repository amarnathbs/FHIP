import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent } from '@/lib/resources/permissions';
import { GlossaryListClient } from '@/components/resources/glossary/GlossaryListClient';

async function GlossaryPageContent() {
  const current = await requireResourceAdminAccess();
  return <GlossaryListClient canCreate={canCreateSpecialistContent(current)} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Resources).
export default function GlossaryPage() {
  return (
    <>
      <PageBackLink href="/admin/resources" label="Resources" />
      <GlossaryPageContent />
    </>
  );
}
