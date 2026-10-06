import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent, hasResourceRole, canManageResources, canPublishResource, canDeleteDraftResource } from '@/lib/resources/permissions';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { NewContentChooser } from '@/components/resources/editor/NewContentChooser';
import { ResourceEditor } from '@/components/resources/editor/ResourceEditor';
import { getEditorReferenceData } from '@/lib/resources/editor/queries';
import { blankEditorPost } from '@/lib/resources/editor/blankPost';
import { isEditableContentType } from '@/lib/resources/editor/types';
import type { WorkflowCapabilities } from '@/components/resources/editor/WorkflowPanel';

// /admin/resources/content/new — spec §10. Server-resolves the create
// permission (never trusts a client-side role) and passes only the boolean
// down; the actual security boundary is still RLS ("authors insert own
// drafts") + the POST route's own re-check (spec §96).
//
// PO review F3 (06/10/2026): choosing a content type (?type=article|guide|
// fhip_explainer) opens the editor on a BLANK, never-persisted post. No record
// is created by opening this page; the record is created only when the author
// presses Save (POST /api/admin/resources/content with the title, then the
// content is saved into it). The permission used here is the same stricter
// create rule the POST route enforces (Super Admin, Resource Administrator,
// Author, Editor), so the page never offers an editor whose Save is refused.
async function NewResourceContentPageContent({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const current = await requireResourceAdminAccess();
  const canCreate = canCreateSpecialistContent(current);
  const { type } = await searchParams;

  if (canCreate && type && isEditableContentType(type)) {
    const supabase = await createClient();
    const reference = await getEditorReferenceData(supabase, createAdminClient());
    const caps: WorkflowCapabilities = {
      isCreator: true,
      canEditorial: current.isSuperAdmin || hasResourceRole(current, 'editor') || canManageResources(current),
      canCompliance: current.isSuperAdmin || hasResourceRole(current, 'compliance_reviewer') || canManageResources(current),
      canPublish: canPublishResource(current),
      canManage: canManageResources(current),
    };
    return <ResourceEditor post={blankEditorPost(type, current.userId)} reference={reference} initialVersions={[]} initialWorkflowHistory={[]} currentUserId={current.userId ?? ''} caps={caps} canDelete={canDeleteDraftResource(current)} />;
  }

  return <NewContentChooser canCreate={canCreate} />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (All Content).
export default function NewResourceContentPage(props: Parameters<typeof NewResourceContentPageContent>[0]) {
  return (
    <>
      <PageBackLink href="/admin/resources/content" label="All Content" />
      <NewResourceContentPageContent {...props} />
    </>
  );
}
