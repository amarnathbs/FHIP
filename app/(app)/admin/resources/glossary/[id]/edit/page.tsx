import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { isResourceStaff, canManageResources, canPublishResource, hasResourceRole } from '@/lib/resources/permissions';
import { getGlossaryEditorPost, getGlossaryTermOptions } from '@/lib/resources/glossary/queries';
import { getEditorReferenceData, getResourcePostVersions } from '@/lib/resources/editor/queries';
import { getResourceWorkflowHistory } from '@/lib/resources/admin/queries';
import { GlossaryEditor } from '@/components/resources/glossary/GlossaryEditor';
import type { WorkflowCapabilities } from '@/components/resources/editor/WorkflowPanel';

export default async function GlossaryEditPage({ params }: { params: Promise<{ id: string }> }) {
  const current = await requireResourceAdminAccess();
  const { id } = await params;
  const supabase = await createClient();

  const post = await getGlossaryEditorPost(supabase, id);
  if (!post) notFound();

  if (!isResourceStaff(current)) redirect(`/admin/resources/content/${id}`);

  const [reference, versions, workflowHistory, termOptions] = await Promise.all([
    getEditorReferenceData(supabase),
    getResourcePostVersions(supabase, id),
    getResourceWorkflowHistory(supabase, id),
    getGlossaryTermOptions(supabase, id),
  ]);

  const caps: WorkflowCapabilities = {
    isCreator: post.created_by === current.userId,
    canEditorial: current.isSuperAdmin || hasResourceRole(current, 'editor') || canManageResources(current),
    canCompliance: current.isSuperAdmin || hasResourceRole(current, 'compliance_reviewer') || canManageResources(current),
    canPublish: canPublishResource(current),
    canManage: canManageResources(current),
  };

  return <GlossaryEditor post={post} reference={reference} termOptions={termOptions} initialVersions={versions} initialWorkflowHistory={workflowHistory} currentUserId={current.userId ?? ''} caps={caps} />;
}
