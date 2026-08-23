import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent } from '@/lib/resources/permissions';
import { GlossaryListClient } from '@/components/resources/glossary/GlossaryListClient';

export default async function GlossaryPage() {
  const current = await requireResourceAdminAccess();
  return <GlossaryListClient canCreate={canCreateSpecialistContent(current)} />;
}
