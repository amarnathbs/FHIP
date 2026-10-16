import Link from 'next/link';
import { redirect } from 'next/navigation';
import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canBulkImportResources } from '@/lib/resources/permissions';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { listRuns } from '@/lib/resources/import/staging';
import { toHistoryRows } from '@/lib/resources/import/history';
import { BulkUploadChooser } from '@/components/resources/import/BulkUploadChooser';
import { ImportHistoryTable, type HistoryRow } from '@/components/resources/import/ImportHistoryTable';

export const dynamic = 'force-dynamic';

// /admin/resources/import -- capability resources.content.bulk_import (Super Admin, Resource Admin, Editor).
// A caller who holds a Resources role but not this capability is redirected, never shown an empty page
// (Admin Architecture Standard section 4). The API routes and the database enforce the same capability.
async function BulkUploadPageContent() {
  const current = await requireResourceAdminAccess();
  if (!canBulkImportResources(current)) redirect('/admin/resources');

  let history: HistoryRow[] = [];
  let historyError: string | null = null;
  try {
    const supabase = await createClient();
    const runs = await listRuns(supabase, 5);
    history = await toHistoryRows(createAdminClient(), runs, current.userId ?? '');
  } catch (err) {
    console.error('Bulk upload history load failed:', err);
    historyError = 'The import history could not be loaded.';
  }

  return (
    <div className="space-y-8">
      <BulkUploadChooser />
      <section aria-labelledby="recent-h" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="recent-h" className="text-lg font-semibold text-ink">
            Recent imports
          </h2>
          <Link href="/admin/resources/import/history" className="text-sm font-semibold text-trust hover:underline">
            View all
          </Link>
        </div>
        {historyError ? (
          <p role="alert" className="rounded-card border border-line bg-white px-4 py-3 text-sm text-ink">
            {historyError} You can still upload a file.
          </p>
        ) : (
          <ImportHistoryTable rows={history} />
        )}
      </section>
    </div>
  );
}

// PO review 06-10-2026 F6 (Admin Standard section 18): every page carries the shared back link to its parent (Resources).
export default function BulkUploadPage() {
  return (
    <>
      <PageBackLink href="/admin/resources" label="Resources" />
      <BulkUploadPageContent />
    </>
  );
}
