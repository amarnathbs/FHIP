import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent, canManageDiscovery } from '@/lib/resources/permissions';
import { VideoNewForm } from '@/components/resources/video/VideoNewForm';

async function NewVideoPageContent() {
  const current = await requireResourceAdminAccess();
  return <VideoNewForm canCreate={canCreateSpecialistContent(current)} canLink={canManageDiscovery(current)} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Videos).
export default function NewVideoPage() {
  return (
    <>
      <PageBackLink href="/admin/resources/videos" label="Videos" />
      <NewVideoPageContent />
    </>
  );
}
