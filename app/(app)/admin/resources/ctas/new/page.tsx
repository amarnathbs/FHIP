import { redirect } from 'next/navigation';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageDiscovery } from '@/lib/resources/permissions';
import { CtaForm } from '@/components/resources/cta/CtaForm';

export default async function NewCtaPage() {
  const current = await requireResourceAdminAccess();
  if (!canManageDiscovery(current)) redirect('/admin/resources/ctas');
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-ink">New CTA</h1>
      <CtaForm />
    </div>
  );
}
