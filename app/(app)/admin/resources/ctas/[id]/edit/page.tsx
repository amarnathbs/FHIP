import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageDiscovery } from '@/lib/resources/permissions';
import { getCtaById, countCtaUsage } from '@/lib/resources/cta/queries';
import { CtaForm } from '@/components/resources/cta/CtaForm';

export default async function EditCtaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const current = await requireResourceAdminAccess();
  if (!canManageDiscovery(current)) redirect('/admin/resources/ctas');

  const supabase = await createClient();
  const [cta, usageCount] = await Promise.all([getCtaById(supabase, id), countCtaUsage(supabase, id)]);
  if (!cta) notFound();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-ink">Edit CTA</h1>
      {usageCount > 0 && (
        <p className="text-sm text-muted">
          Currently used by {usageCount} {usageCount === 1 ? 'Resource' : 'Resources'} (as a primary or secondary CTA). Deactivating removes it from all of them immediately — no need to edit each Resource.
        </p>
      )}
      <CtaForm initial={cta} ctaId={cta.id} />
    </div>
  );
}
