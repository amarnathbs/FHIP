import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canCreateSpecialistContent, hasResourceRole, canManageResources, canPublishResource, canDeleteDraftResource } from '@/lib/resources/permissions';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { MoneyUpdateNewChooser } from '@/components/resources/money-update/MoneyUpdateNewChooser';
import { MoneyUpdateEditor } from '@/components/resources/money-update/MoneyUpdateEditor';
import { getEditorReferenceData } from '@/lib/resources/editor/queries';
import { searchSources } from '@/lib/resources/sources/queries';
import { blankMoneyUpdatePost } from '@/lib/resources/money-update/blankPost';
import type { MoneyUpdateContentType } from '@/lib/resources/money-update/types';
import type { WorkflowCapabilities } from '@/components/resources/editor/WorkflowPanel';

const TYPES: MoneyUpdateContentType[] = ['money_update', 'money_update_template'];

// PO review F3 (06/10/2026): choosing Money Update / Template (?type=...) opens
// the editor on a BLANK, never-persisted post. The record is created only when
// the author presses Save. "Create from an existing template" remains an
// explicit action that creates a copy immediately (the author asked for a copy).
export default async function NewMoneyUpdatePage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const current = await requireResourceAdminAccess();
  const canCreate = canCreateSpecialistContent(current);
  const { type } = await searchParams;

  if (canCreate && type && (TYPES as string[]).includes(type)) {
    const supabase = await createClient();
    const [reference, sourceOptions] = await Promise.all([getEditorReferenceData(supabase, createAdminClient()), searchSources(supabase, '')]);
    const caps: WorkflowCapabilities = {
      isCreator: true,
      canEditorial: current.isSuperAdmin || hasResourceRole(current, 'editor') || canManageResources(current),
      canCompliance: current.isSuperAdmin || hasResourceRole(current, 'compliance_reviewer') || canManageResources(current),
      canPublish: canPublishResource(current),
      canManage: canManageResources(current),
    };
    return (
      <MoneyUpdateEditor
        post={blankMoneyUpdatePost(type as MoneyUpdateContentType, current.userId)}
        reference={reference}
        sourceOptions={sourceOptions}
        initialVersions={[]}
        initialWorkflowHistory={[]}
        currentUserId={current.userId ?? ''}
        caps={caps}
        canDelete={canDeleteDraftResource(current)}
      />
    );
  }

  return <MoneyUpdateNewChooser canCreate={canCreate} />;
}
