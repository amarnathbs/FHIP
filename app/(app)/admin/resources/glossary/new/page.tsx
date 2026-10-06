import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent, hasResourceRole, canManageResources, canPublishResource } from '@/lib/resources/permissions';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { GlossaryNewButton } from '@/components/resources/glossary/GlossaryNewButton';
import { GlossaryEditor } from '@/components/resources/glossary/GlossaryEditor';
import { getEditorReferenceData } from '@/lib/resources/editor/queries';
import { getGlossaryTermOptions } from '@/lib/resources/glossary/queries';
import { blankEditorPost } from '@/lib/resources/editor/blankPost';
import type { GlossaryEditorPost } from '@/lib/resources/glossary/types';
import type { WorkflowCapabilities } from '@/components/resources/editor/WorkflowPanel';

// PO review F3 (06/10/2026): this opens the editor on a BLANK, never
// persisted definition. The record is created only when the author presses
// Save. A caller without the create capability sees the permission notice.
export default async function NewGlossaryPage() {
  const current = await requireResourceAdminAccess();
  const canCreate = canCreateSpecialistContent(current);

  if (canCreate) {
    const supabase = await createClient();
    const [reference, termOptions] = await Promise.all([getEditorReferenceData(supabase, createAdminClient()), getGlossaryTermOptions(supabase)]);
    const base = blankEditorPost('article', current.userId);
    const post: GlossaryEditorPost = { ...base, content_type: 'glossary', content_blocks: [], aliases: [], relatedTerms: [] };
    const caps: WorkflowCapabilities = {
      isCreator: true,
      canEditorial: current.isSuperAdmin || hasResourceRole(current, 'editor') || canManageResources(current),
      canCompliance: current.isSuperAdmin || hasResourceRole(current, 'compliance_reviewer') || canManageResources(current),
      canPublish: canPublishResource(current),
      canManage: canManageResources(current),
    };
    return <GlossaryEditor post={post} reference={reference} termOptions={termOptions} initialVersions={[]} initialWorkflowHistory={[]} currentUserId={current.userId ?? ''} caps={caps} />;
  }

  return <GlossaryNewButton canCreate={canCreate} />;
}
