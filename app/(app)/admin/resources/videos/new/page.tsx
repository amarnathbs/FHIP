import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent, canManageDiscovery } from '@/lib/resources/permissions';
import { VideoNewForm } from '@/components/resources/video/VideoNewForm';

export default async function NewVideoPage() {
  const current = await requireResourceAdminAccess();
  return <VideoNewForm canCreate={canCreateSpecialistContent(current)} canLink={canManageDiscovery(current)} />;
}
