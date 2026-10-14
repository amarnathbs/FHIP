/**
 * Financial data import -- the CLIENT-SAFE half of the Premium upload entitlement.
 *
 * Premium Upload Entitlement programme (Product Owner decision, 14-10-2026):
 * every customer-facing financial file upload / statement import / automated
 * extraction / reprocessing / future data connector is a PREMIUM capability.
 * Manual Add / Edit / Delete of the user's own financial records is NOT -- it
 * stays available on Free and never touches this capability.
 *
 * This file is pure constants and types (no server imports), so a client
 * component can use the wording, the codes and the upgrade path without
 * pulling the server entitlement reader into the browser bundle. The server
 * half -- the only place the entitlement is actually decided -- is
 * `financialDataImport.ts`. NOTHING in this file authorises anything: a client
 * may use `FinancialImportAccessView` to decide what to DRAW; every API route,
 * every service and every admission point re-evaluates the entitlement itself.
 */

/** Stable capability name, by product behaviour rather than by file type, so every current and future import reuses it. */
export const FINANCIAL_DATA_IMPORT_CAPABILITY = 'financial_data_import' as const;

/**
 * The existing upgrade experience. The codebase has no separate /upgrade/pricing page: plans, the billing country,
 * promo codes and checkout live in the Billing section of the profile page, so the lock sends people there
 * (the PO rule is to reuse the existing flow, not to build a second checkout for uploads).
 */
export const FINANCIAL_IMPORT_UPGRADE_PATH = '/profile';

/** Stable machine-readable codes. Never a provider-specific billing status. */
export const FINANCIAL_IMPORT_PREMIUM_REQUIRED = 'PREMIUM_REQUIRED' as const;
export const FINANCIAL_IMPORT_ENTITLEMENT_UNAVAILABLE = 'ENTITLEMENT_UNAVAILABLE' as const;
export type FinancialImportDenyCode = typeof FINANCIAL_IMPORT_PREMIUM_REQUIRED | typeof FINANCIAL_IMPORT_ENTITLEMENT_UNAVAILABLE;

/** High-level product domains (for lock copy / conversion attribution only; never a document type or a filename). */
export type FinancialImportDomain = 'income' | 'expenses' | 'liabilities' | 'investments' | 'retirement' | 'insurance' | 'fdh';

/** Free-plan wording, as set by the Product Owner. No advice or compliance language is changed by it. */
export const FINANCIAL_IMPORT_LOCK_COPY =
  'Statement and document import is available on Premium. You can continue to add and edit your financial information manually on the Free plan.';

/** Shown when the plan could not be determined: an outage, not a payment problem. */
export const FINANCIAL_IMPORT_UNAVAILABLE_COPY =
  'We could not confirm your plan just now, so importing is unavailable. Please try again in a moment. You can still add and edit your information manually.';

/** What the lock sits next to. */
export const FINANCIAL_IMPORT_MANUAL_ENTRY_NOTE = 'Manual entry stays available on every plan.';

/** The body every refused API call carries (HTTP 403 for PREMIUM_REQUIRED, HTTP 503 for ENTITLEMENT_UNAVAILABLE). */
export interface FinancialImportDeniedBody {
  error: string;
  code: FinancialImportDenyCode;
  data: {
    allowed: false;
    reason: FinancialImportDenyCode;
    upgrade_available: boolean;
    upgrade_path: string | null;
  };
}

/** What the browser is told for presentation only (never used to authorise). */
export type FinancialImportAccessView =
  | { state: 'allowed' }
  | { state: 'premium_required' }
  | { state: 'unavailable' };

export function financialImportDeniedMessage(code: FinancialImportDenyCode): string {
  return code === FINANCIAL_IMPORT_PREMIUM_REQUIRED ? FINANCIAL_IMPORT_LOCK_COPY : FINANCIAL_IMPORT_UNAVAILABLE_COPY;
}

/** True when a parsed JSON body is the unified Premium/entitlement refusal (lets every domain panel show one experience). */
export function isFinancialImportDeniedBody(json: unknown): json is FinancialImportDeniedBody {
  if (!json || typeof json !== 'object') return false;
  const code = (json as { code?: unknown }).code;
  return code === FINANCIAL_IMPORT_PREMIUM_REQUIRED || code === FINANCIAL_IMPORT_ENTITLEMENT_UNAVAILABLE;
}

/** The access view implied by a refusal body, for a panel that learns of the lock only from a response. */
export function accessViewFromDeniedBody(body: FinancialImportDeniedBody): FinancialImportAccessView {
  return body.code === FINANCIAL_IMPORT_PREMIUM_REQUIRED ? { state: 'premium_required' } : { state: 'unavailable' };
}

/** Upgrade link with non-sensitive context (domain only) so the plan page can explain why the user arrived. */
export function financialImportUpgradeHref(domain: FinancialImportDomain): string {
  return `${FINANCIAL_IMPORT_UPGRADE_PATH}?from=import-${domain}`;
}
