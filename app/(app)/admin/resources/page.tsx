import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { ResourcesDashboardClient } from '@/components/resources/admin/ResourcesDashboardClient';

async function ResourcesAdminDashboardPageContent() {
  await requireResourceAdminAccess();
  return <ResourcesDashboardClient />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Dashboard).
export default function ResourcesAdminDashboardPage() {
  return (
    <>
      <PageBackLink href="/dashboard" label="Dashboard" />
      <ResourcesAdminDashboardPageContent />
    </>
  );
}
