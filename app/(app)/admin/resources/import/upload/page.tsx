import { redirect } from 'next/navigation';
import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canBulkImportResources } from '@/lib/resources/permissions';
import { isImportContentType } from '@/lib/resources/import/types';
import { ImportUploader } from '@/components/resources/import/ImportUploader';

export const dynamic = 'force-dynamic';

// /admin/resources/import/upload?type=article|money_update -- the type is chosen on the previous screen and
// can never be changed by the file. An unknown type returns the person to the chooser.
async function BulkUploadTypePageContent({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const current = await requireResourceAdminAccess();
  if (!canBulkImportResources(current)) redirect('/admin/resources');
  const { type } = await searchParams;
  if (!isImportContentType(type)) redirect('/admin/resources/import');
  return <ImportUploader type={type} />;
}

// PO review 06-10-2026 F6 (Admin Standard section 18): every page carries the shared back link to its parent (Bulk Upload).
export default function BulkUploadTypePage(props: Parameters<typeof BulkUploadTypePageContent>[0]) {
  return (
    <>
      <PageBackLink href="/admin/resources/import" label="Bulk Upload" />
      <BulkUploadTypePageContent {...props} />
    </>
  );
}
