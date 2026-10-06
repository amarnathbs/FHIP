import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { isResourceStaff, canManageResources, canPublishResource, hasResourceRole, canCreateSpecialistContent, canManageDiscovery } from '@/lib/resources/permissions';
import { getVideoEditorPost } from '@/lib/resources/video/queries';
import { getEditorReferenceData, getResourcePostVersions } from '@/lib/resources/editor/queries';
import { getResourceWorkflowHistory } from '@/lib/resources/admin/queries';
import { VideoEditor } from '@/components/resources/video/VideoEditor';
import { VideoRepairForm } from '@/components/resources/video/VideoRepairForm';
import { LinkedContentPanel } from '@/components/resources/video/LinkedVideosPanel';
import type { WorkflowCapabilities } from '@/components/resources/editor/WorkflowPanel';

// /admin/resources/videos/[id]/edit — spec §17-24, §68 (specialist edit
// routing: a video-typed post is never loaded through the R1.3 Article
// editor).
//
// PO review F12 (06/10/2026): a video-typed post with NO resource_videos row
// (the imported video scripts) used to reach a dead-end message. It now gets
// the repair form (add the real YouTube URL), and every video — healthy or
// not — shows the "Linked content" panel so it can be linked to content.
export default async function VideoEditPage({ params }: { params: Promise<{ id: string }> }) {
  const current = await requireResourceAdminAccess();
  const { id } = await params;
  const supabase = await createClient();

  const post = await getVideoEditorPost(supabase, id);
  if (!post) notFound();

  if (!isResourceStaff(current)) redirect(`/admin/resources/content/${id}`);

  const linksPanel = <LinkedContentPanel supabase={supabase} videoPostId={post.id} videoTitle={post.title} canManage={canManageDiscovery(current)} />;

  if (!post.video) {
    return (
      <div className="space-y-6">
        <nav aria-label="Breadcrumb" className="text-sm text-muted">
          <Link href="/admin/resources" className="hover:text-trust hover:underline">
            Resources
          </Link>{' '}
          &gt;{' '}
          <Link href="/admin/resources/videos" className="hover:text-trust hover:underline">
            Videos
          </Link>{' '}
          &gt; <span className="text-ink">{post.title}</span>
        </nav>
        <VideoRepairForm postId={post.id} title={post.title} contentId={post.content_id} canRepair={canCreateSpecialistContent(current)} />
        {linksPanel}
      </div>
    );
  }

  const [reference, versions, workflowHistory] = await Promise.all([getEditorReferenceData(supabase, createAdminClient()), getResourcePostVersions(supabase, id), getResourceWorkflowHistory(supabase, id)]);

  const caps: WorkflowCapabilities = {
    isCreator: post.created_by === current.userId,
    canEditorial: current.isSuperAdmin || hasResourceRole(current, 'editor') || canManageResources(current),
    canCompliance: current.isSuperAdmin || hasResourceRole(current, 'compliance_reviewer') || canManageResources(current),
    canPublish: canPublishResource(current),
    canManage: canManageResources(current),
  };

  return (
    <div className="space-y-6">
      <VideoEditor post={post} reference={reference} initialVersions={versions} initialWorkflowHistory={workflowHistory} currentUserId={current.userId ?? ''} caps={caps} />
      {linksPanel}
    </div>
  );
}
