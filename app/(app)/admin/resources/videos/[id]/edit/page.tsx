import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { isResourceStaff, canManageResources, canPublishResource, hasResourceRole } from '@/lib/resources/permissions';
import { getVideoEditorPost } from '@/lib/resources/video/queries';
import { getEditorReferenceData, getResourcePostVersions } from '@/lib/resources/editor/queries';
import { getResourceWorkflowHistory } from '@/lib/resources/admin/queries';
import { VideoEditor } from '@/components/resources/video/VideoEditor';
import type { WorkflowCapabilities } from '@/components/resources/editor/WorkflowPanel';

// /admin/resources/videos/[id]/edit — spec §17-24, §68 (specialist edit
// routing: a video-typed post is never loaded through the R1.3 Article
// editor).
export default async function VideoEditPage({ params }: { params: Promise<{ id: string }> }) {
  const current = await requireResourceAdminAccess();
  const { id } = await params;
  const supabase = await createClient();

  const post = await getVideoEditorPost(supabase, id);
  if (!post) notFound();

  if (!isResourceStaff(current)) redirect(`/admin/resources/content/${id}`);

  const [reference, versions, workflowHistory] = await Promise.all([getEditorReferenceData(supabase, createAdminClient()), getResourcePostVersions(supabase, id), getResourceWorkflowHistory(supabase, id)]);

  const caps: WorkflowCapabilities = {
    isCreator: post.created_by === current.userId,
    canEditorial: current.isSuperAdmin || hasResourceRole(current, 'editor') || canManageResources(current),
    canCompliance: current.isSuperAdmin || hasResourceRole(current, 'compliance_reviewer') || canManageResources(current),
    canPublish: canPublishResource(current),
    canManage: canManageResources(current),
  };

  return <VideoEditor post={post} reference={reference} initialVersions={versions} initialWorkflowHistory={workflowHistory} currentUserId={current.userId ?? ''} caps={caps} />;
}
