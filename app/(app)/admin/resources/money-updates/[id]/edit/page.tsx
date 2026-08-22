import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { isResourceStaff, canManageResources, canPublishResource, hasResourceRole } from '@/lib/resources/permissions';
import { getMoneyUpdateEditorPost } from '@/lib/resources/money-update/queries';
import { getEditorReferenceData, getResourcePostVersions } from '@/lib/resources/editor/queries';
import { getResourceWorkflowHistory } from '@/lib/resources/admin/queries';
import { searchSources } from '@/lib/resources/sources/queries';
import { MoneyUpdateEditor } from '@/components/resources/money-update/MoneyUpdateEditor';
import type { WorkflowCapabilities } from '@/components/resources/editor/WorkflowPanel';

export default async function MoneyUpdateEditPage({ params }: { params: Promise<{ id: string }> }) {
  const current = await requireResourceAdminAccess();
  const { id } = await params;
  const supabase = await createClient();

  const post = await getMoneyUpdateEditorPost(supabase, id);
  if (!post) notFound();

  if (!isResourceStaff(current)) redirect(`/admin/resources/content/${id}`);

  const [reference, versions, workflowHistory, sourceOptions] = await Promise.all([
    getEditorReferenceData(supabase),
    getResourcePostVersions(supabase, id),
    getResourceWorkflowHistory(supabase, id),
    searchSources(supabase, ''),
  ]);

  const caps: WorkflowCapabilities = {
    isCreator: post.created_by === current.userId,
    canEditorial: current.isSuperAdmin || hasResourceRole(current, 'editor') || canManageResources(current),
    canCompliance: current.isSuperAdmin || hasResourceRole(current, 'compliance_reviewer') || canManageResources(current),
    canPublish: canPublishResource(current),
    canManage: canManageResources(current),
  };

  return <MoneyUpdateEditor post={post} reference={reference} sourceOptions={sourceOptions} initialVersions={versions} initialWorkflowHistory={workflowHistory} currentUserId={current.userId ?? ''} caps={caps} />;
}
