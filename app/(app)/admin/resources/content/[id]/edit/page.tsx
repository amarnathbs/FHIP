import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { isResourceStaff, canManageResources, canPublishResource, hasResourceRole } from '@/lib/resources/permissions';
import { getResourceEditorPost, getEditorReferenceData, getResourcePostVersions } from '@/lib/resources/editor/queries';
import { getResourceWorkflowHistory } from '@/lib/resources/admin/queries';
import { isEditableContentType } from '@/lib/resources/editor/types';
import { ResourceEditor } from '@/components/resources/editor/ResourceEditor';
import type { WorkflowCapabilities } from '@/components/resources/editor/WorkflowPanel';

// /admin/resources/content/[id]/edit — spec §9/§14.
export default async function ResourceEditPage({ params }: { params: Promise<{ id: string }> }) {
  const current = await requireResourceAdminAccess();
  const { id } = await params;
  const supabase = await createClient();

  const post = await getResourceEditorPost(supabase, id);
  // RLS-denied and genuinely-nonexistent resolve to the same 404 (spec §96).
  if (!post) notFound();

  // Read-only roles fall back to the existing R1.2 read-only detail view
  // rather than a duplicated read-only editor render (spec §108: "Read-only
  // mode for roles without edit capability" — RLS's "staff update posts"
  // policy is is_resource_staff()-gated, so a non-staff viewer who can still
  // *read* this post, e.g. an Analyst on a published item, gets the
  // established read-only page instead of a broken/half-disabled editor).
  if (!isResourceStaff(current)) redirect(`/admin/resources/content/${id}`);

  // R1.3 editors are scoped to exactly Article/Guide/FHIP Explainer (spec
  // §2/§76: content type is locked after creation and the other five
  // content types are explicitly out of scope, spec §4).
  if (!isEditableContentType(post.content_type)) redirect(`/admin/resources/content/${id}`);

  const [reference, versions, workflowHistory] = await Promise.all([getEditorReferenceData(supabase), getResourcePostVersions(supabase, id), getResourceWorkflowHistory(supabase, id)]);

  const caps: WorkflowCapabilities = {
    isCreator: post.created_by === current.userId,
    canEditorial: current.isSuperAdmin || hasResourceRole(current, 'editor') || canManageResources(current),
    canCompliance: current.isSuperAdmin || hasResourceRole(current, 'compliance_reviewer') || canManageResources(current),
    canPublish: canPublishResource(current),
    canManage: canManageResources(current),
  };

  return <ResourceEditor post={post} reference={reference} initialVersions={versions} initialWorkflowHistory={workflowHistory} currentUserId={current.userId ?? ''} caps={caps} />;
}
