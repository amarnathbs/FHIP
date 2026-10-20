/**
 * PDF statement routes (liability, retirement, Australian investment): the three kill switches.
 *
 * ONE switch per class, each default OFF in every environment: only the literal string `'true'` turns it on. Unset, empty,
 * `'1'`, `'TRUE'` and `'yes'` all leave it OFF, so a mistyped value gives the safe behaviour. The `AIE_` prefix is forwarded to the
 * server by `amplify.yml` wholesale, so no deployment-file change is needed (and a switch cannot be silently dropped).
 *
 * A switch that is OFF refuses a PDF at the upload route, BEFORE the document row, the storage object, the scan or any reader or
 * provider is touched. CSV keeps working. The AI fallback has its OWN switch per class (the existing
 * `AIE_*_AI_FALLBACK_ENABLED` variables) and is NOT turned on by these: a PDF route that is ON with the AI switch OFF reads only
 * statements the certified layouts cover and refuses the rest with the ordinary "could not read" words.
 *
 * Turning a switch off never touches the per-user cap, the global cost ledger, a saved statement or a pending draft.
 */

export type PdfStatementClass = 'liability' | 'retirement' | 'au_investment';

export function isLiabilityPdfRouteEnabled(): boolean {
  return process.env.AIE_LIABILITY_PDF_ROUTE_ENABLED === 'true';
}
export function isRetirementPdfRouteEnabled(): boolean {
  return process.env.AIE_RETIREMENT_PDF_ROUTE_ENABLED === 'true';
}
export function isAuInvestmentPdfRouteEnabled(): boolean {
  return process.env.AIE_AU_INVESTMENT_PDF_ROUTE_ENABLED === 'true';
}

export function isPdfRouteEnabled(cls: PdfStatementClass): boolean {
  switch (cls) {
    case 'liability': return isLiabilityPdfRouteEnabled();
    case 'retirement': return isRetirementPdfRouteEnabled();
    case 'au_investment': return isAuInvestmentPdfRouteEnabled();
  }
}

/** The environment variable name per class (for the documentation tests and the operator pack). */
export const PDF_ROUTE_FLAG_NAMES: Record<PdfStatementClass, string> = {
  liability: 'AIE_LIABILITY_PDF_ROUTE_ENABLED',
  retirement: 'AIE_RETIREMENT_PDF_ROUTE_ENABLED',
  au_investment: 'AIE_AU_INVESTMENT_PDF_ROUTE_ENABLED',
};

/** What the person sees when a PDF is sent while that class's switch is off. Plain words, no internal names. */
export const PDF_ROUTE_DISABLED_MESSAGE =
  'Reading PDF statements of this type is not switched on yet. You can upload a CSV export of the statement, or add this manually.';
