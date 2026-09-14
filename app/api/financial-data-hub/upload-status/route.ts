import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';

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
export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  return ok({ enabled: isFdhDocumentUploadEnabled() });
}
