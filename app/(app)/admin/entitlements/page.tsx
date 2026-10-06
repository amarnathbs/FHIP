import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requirePremiumEntitlementAdminPage } from '@/lib/services/premiumEntitlementAdmin';
import { PremiumEntitlementsClient } from '@/components/admin/PremiumEntitlementsClient';

// Admin Premium grant (migration 0231) — allocate / extend / revoke Premium for a
// user who has not paid.
//
// Admin Architecture Standard §4 layer 3: the page-layer guard runs BEFORE any
// render, and a caller without can_manage_premium_entitlements is redirected,
// never shown an empty console. Layers 1, 2 and 4 are the RPCs' own capability
// check, the /api/admin/entitlements/** routes, and lib/admin/adminNav.ts.
async function AdminEntitlementsPageContent() {
  await requirePremiumEntitlementAdminPage();
  return <PremiumEntitlementsClient />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Dashboard).
export default function AdminEntitlementsPage() {
  return (
    <>
      <PageBackLink href="/dashboard" label="Dashboard" />
      <AdminEntitlementsPageContent />
    </>
  );
}
