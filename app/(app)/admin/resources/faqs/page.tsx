import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageFaqs } from '@/lib/resources/permissions';
import { FaqListClient } from '@/components/resources/faq/FaqListClient';

export default async function FaqsPage() {
  const current = await requireResourceAdminAccess();
  return <FaqListClient canCreate={canManageFaqs(current)} />;
}
