import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageDiscovery } from '@/lib/resources/permissions';
import { CtaListClient } from '@/components/resources/cta/CtaListClient';

async function CtasPageContent() {
  const current = await requireResourceAdminAccess();
  return <CtaListClient canManage={canManageDiscovery(current)} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Resources).
export default function CtasPage() {
  return (
    <>
      <PageBackLink href="/admin/resources" label="Resources" />
      <CtasPageContent />
    </>
  );
}
