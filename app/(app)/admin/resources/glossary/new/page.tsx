import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent } from '@/lib/resources/permissions';
import { GlossaryNewButton } from '@/components/resources/glossary/GlossaryNewButton';

async function NewGlossaryPageContent() {
  const current = await requireResourceAdminAccess();
  return <GlossaryNewButton canCreate={canCreateSpecialistContent(current)} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Glossary).
export default function NewGlossaryPage() {
  return (
    <>
      <PageBackLink href="/admin/resources/glossary" label="Glossary" />
      <NewGlossaryPageContent />
    </>
  );
}
