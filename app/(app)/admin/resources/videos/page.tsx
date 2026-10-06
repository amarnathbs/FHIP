import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent, canManageDiscovery } from '@/lib/resources/permissions';
import { VideoListClient } from '@/components/resources/video/VideoListClient';

export default async function VideosPage() {
  const current = await requireResourceAdminAccess();
  return <VideoListClient canCreate={canCreateSpecialistContent(current)} canLink={canManageDiscovery(current)} />;
}
