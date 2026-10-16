import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canBulkImportResources } from '@/lib/resources/permissions';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { listRuns } from '@/lib/resources/import/staging';
import { toHistoryRows } from '@/lib/resources/import/history';
import { ImportHistoryTable, type HistoryRow } from '@/components/resources/import/ImportHistoryTable';

export const dynamic = 'force-dynamic';

// /admin/resources/import/history -- the shared import history for both types.
async function BulkUploadHistoryPageContent() {
  const current = await requireResourceAdminAccess();
  if (!canBulkImportResources(current)) redirect('/admin/resources');

  let rows: HistoryRow[] = [];
  let error: string | null = null;
  try {
    const supabase = await createClient();
    rows = await toHistoryRows(createAdminClient(), await listRuns(supabase, 100), current.userId ?? '');
  } catch (err) {
    console.error('Bulk upload history load failed:', err);
    error = 'The import history could not be loaded.';
  }

  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/admin/resources" className="hover:text-trust hover:underline">Resources</Link> &gt;{' '}
        <Link href="/admin/resources/content/new" className="hover:text-trust hover:underline">Create Resource</Link> &gt;{' '}
        <Link href="/admin/resources/import" className="hover:text-trust hover:underline">Bulk Upload</Link> &gt; <span className="text-ink">Import history</span>
      </nav>
      <h1 className="text-2xl font-semibold text-ink">Import history</h1>
      <p className="max-w-3xl text-sm text-muted">
        Each upload is listed once. Uploaded files are not kept: only a fingerprint of the file and the checked rows are stored, and unapplied rows are removed after 7 days.
      </p>
      {error ? <p role="alert" className="rounded-card border border-line bg-white px-4 py-3 text-sm text-ink">{error}</p> : <ImportHistoryTable rows={rows} />}
    </div>
  );
}

// PO review 06-10-2026 F6 (Admin Standard section 18): every page carries the shared back link to its parent (Bulk Upload).
export default function BulkUploadHistoryPage() {
  return (
    <>
      <PageBackLink href="/admin/resources/import" label="Bulk Upload" />
      <BulkUploadHistoryPageContent />
    </>
  );
}
