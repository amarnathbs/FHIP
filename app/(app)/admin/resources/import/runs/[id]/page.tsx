import { notFound, redirect } from 'next/navigation';
import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canBulkImportResources } from '@/lib/resources/permissions';
import { createClient } from '@/lib/supabase/server';
import { getRun, getRunRows } from '@/lib/resources/import/staging';
import { getImportAdapter } from '@/lib/resources/import/adapters';
import { ImportPreview, type PreviewRow, type PreviewRun } from '@/components/resources/import/ImportPreview';

export const dynamic = 'force-dynamic';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// /admin/resources/import/runs/[id] -- preview (before apply) and result (after). RLS decides visibility: another
// person's run is a 404 for an Editor, never a page that exists-but-is-empty.
async function ImportRunPageContent({ params }: { params: Promise<{ id: string }> }) {
  const current = await requireResourceAdminAccess();
  if (!canBulkImportResources(current)) redirect('/admin/resources');
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const supabase = await createClient();
  const run = await getRun(supabase, id);
  if (!run) notFound();
  const rows = await getRunRows(supabase, id);
  const adapter = getImportAdapter(run.content_type);

  return (
    <ImportPreview
      run={run as unknown as PreviewRun}
      rows={rows as unknown as PreviewRow[]}
      editBase={run.content_type === 'article' ? 'content' : 'money-updates'}
      listHref={adapter.listRoute}
    />
  );
}

// PO review 06-10-2026 F6 (Admin Standard section 18): every page carries the shared back link to its parent (Bulk Upload).
export default function ImportRunPage(props: Parameters<typeof ImportRunPageContent>[0]) {
  return (
    <>
      <PageBackLink href="/admin/resources/import" label="Bulk Upload" />
      <ImportRunPageContent {...props} />
    </>
  );
}
