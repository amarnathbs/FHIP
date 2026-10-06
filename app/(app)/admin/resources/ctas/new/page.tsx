import { PageBackLink } from '@/components/navigation/PageBackLink';
import { redirect } from 'next/navigation';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageDiscovery } from '@/lib/resources/permissions';
import { CtaForm } from '@/components/resources/cta/CtaForm';

async function NewCtaPageContent() {
  const current = await requireResourceAdminAccess();
  if (!canManageDiscovery(current)) redirect('/admin/resources/ctas');
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-ink">New CTA</h1>
      <CtaForm />
    </div>
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (CTAs).
export default function NewCtaPage() {
  return (
    <>
      <PageBackLink href="/admin/resources/ctas" label="CTAs" />
      <NewCtaPageContent />
    </>
  );
}
