import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageDiscovery } from '@/lib/resources/permissions';
import { ContextMappingManager } from '@/components/resources/context/ContextMappingManager';

async function ContextMappingPageContent() {
  const current = await requireResourceAdminAccess();
  return <ContextMappingManager canManage={canManageDiscovery(current)} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Resources).
export default function ContextMappingPage() {
  return (
    <>
      <PageBackLink href="/admin/resources" label="Resources" />
      <ContextMappingPageContent />
    </>
  );
}
