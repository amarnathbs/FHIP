import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageDiscovery } from '@/lib/resources/permissions';
import { RelatedContentManager } from '@/components/resources/related/RelatedContentManager';

async function RelatedContentPageContent() {
  const current = await requireResourceAdminAccess();
  return <RelatedContentManager canManage={canManageDiscovery(current)} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Resources).
export default function RelatedContentPage() {
  return (
    <>
      <PageBackLink href="/admin/resources" label="Resources" />
      <RelatedContentPageContent />
    </>
  );
}
