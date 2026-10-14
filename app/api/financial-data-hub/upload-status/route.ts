import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { financialImportAccessView } from '@/lib/entitlements/financialDataImport';

// GET /api/financial-data-hub/upload-status — App Review 2026-09-14, item 2.
//
// `isFdhDocumentUploadEnabled()` (the hard, code-level production gate —
// see featureFlags.ts) is a server-only function, but the document-upload
// entry points that live inside client components on ordinary app pages
// (BankStatementImportPanel.tsx on Expenses, and its PayslipImportPanel/
// LiabilityImportPanel/AuInvestmentStatementImportPanel/
// RetirementStatementImportPanel siblings) had no way to know the upload
// pipeline is disabled until a user actually attempted an upload and hit
// the resulting 403 — unlike the dedicated /financial-data-hub page, which
// reads this server-side and disables its own form up front. This tiny
// read-only endpoint (no PII, gated only by ordinary auth) lets any client
// component check the same flag before rendering an upload form as if it
// were fully functional.
//
// Premium Upload Entitlement (14-10-2026): also returns `import_access`
// ('allowed' | 'premium_required' | 'unavailable') -- the server's own reading of
// the caller's entitlement, so the Import UI can show the Premium lock BEFORE any
// file is chosen. It is for presentation only; every upload / process route
// re-checks the entitlement itself and refuses a Free caller regardless of what
// this said. A pure read: no document, storage or provider is touched.
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const importAccess = await financialImportAccessView(user.id, 'fdh.upload_status');
  return ok({ enabled: isFdhDocumentUploadEnabled(), import_access: importAccess.state });
}
