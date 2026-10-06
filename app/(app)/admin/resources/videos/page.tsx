import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent } from '@/lib/resources/permissions';
import { VideoListClient } from '@/components/resources/video/VideoListClient';

async function VideosPageContent() {
  const current = await requireResourceAdminAccess();
  return <VideoListClient canCreate={canCreateSpecialistContent(current)} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Resources).
export default function VideosPage() {
  return (
    <>
      <PageBackLink href="/admin/resources" label="Resources" />
      <VideosPageContent />
    </>
  );
}
