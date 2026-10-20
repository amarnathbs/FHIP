import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requireReferenceDataAdminPage } from '@/lib/services/investment-intelligence/pc6/referenceDataAdmin';
import Nav2MonitoringClient from '@/components/admin/Nav2MonitoringClient';

// Fund analytics health (NAV2 monitoring). The existing PC6 reference-data-quality capability: a read-only health view
// of the same surface. Admin Architecture Standard section 4 layer 3: the page guard runs BEFORE any render; a caller
// without the capability is redirected, never shown an empty screen.
async function Nav2MonitoringPageContent() {
  await requireReferenceDataAdminPage();
  return <Nav2MonitoringClient />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Dashboard: Admin tools have no Admin home).
export default function Nav2MonitoringPage() {
  return (
    <>
      <PageBackLink href="/dashboard" label="Dashboard" />
      <Nav2MonitoringPageContent />
    </>
  );
}
