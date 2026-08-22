import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent } from '@/lib/resources/permissions';
import { GlossaryNewButton } from '@/components/resources/glossary/GlossaryNewButton';

export default async function NewGlossaryPage() {
  const current = await requireResourceAdminAccess();
  return <GlossaryNewButton canCreate={canCreateSpecialistContent(current)} />;
}
