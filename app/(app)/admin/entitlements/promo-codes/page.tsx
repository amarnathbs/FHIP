import { PageBackLink } from '@/components/navigation/PageBackLink';
import { requirePromoCodeAdminPage } from '@/lib/services/promoCodeAdmin';
import { PromoCodesClient } from '@/components/admin/PromoCodesClient';

// Promo codes — create / list / disable.
//
// Admin Architecture Standard §4 layer 3: the page-layer guard runs BEFORE any
// render, and a caller without can_manage_promo_codes is redirected, never shown
// an empty console. (Holding can_manage_premium_entitlements does NOT admit a
// caller here: the two are separate capabilities, Standard §3.)
async function AdminPromoCodesPageContent() {
  await requirePromoCodeAdminPage();
  return <PromoCodesClient />;
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Premium Access).
export default function AdminPromoCodesPage() {
  return (
    <>
      <PageBackLink href="/admin/entitlements" label="Premium Access" />
      <AdminPromoCodesPageContent />
    </>
  );
}
