import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canDeleteDraftResource } from '@/lib/resources/permissions';
import { ResourceContentListClient } from '@/components/resources/admin/ResourceContentListClient';

async function ResourcesAllContentPageContent() {
  const current = await requireResourceAdminAccess();
  return <ResourceContentListClient title="All Content" description="Browse, filter and manage Resources content across the publishing workflow." canDeleteDrafts={canDeleteDraftResource(current)} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Resources).
export default function ResourcesAllContentPage() {
  return (
    <>
      <PageBackLink href="/admin/resources" label="Resources" />
      <ResourcesAllContentPageContent />
    </>
  );
}
