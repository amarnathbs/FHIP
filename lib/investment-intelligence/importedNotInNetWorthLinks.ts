// Document2 (4) WP-B (F13): every actionable warning needs a tested call to action. The "Imported, not yet in Net Worth" note on the
// Dashboard and on the Investments tab used to be plain text: the person was left to hunt for where to resolve it.
//
// PURE. Where to send the person for a bucket of imported-but-not-counted holdings:
//   * India mutual-fund holdings (INR) are published from Investment Intelligence -> Statements & data. With exactly one source
//     statement the link opens THAT statement's resolution panel (`?documentId=`), otherwise the Statements & data list.
//   * Everything else (Australian broker imports) is added to Net Worth from the Investments page.
// Presentation only: never part of a figure.

export interface ImportedNotInNetWorthAction {
  href: string;
  label: string;
}

export const IMPORTED_DATA_PATH = '/investment-intelligence/data';
export const IMPORTED_INVESTMENTS_PATH = '/investments';

export function importedNotInNetWorthActions(where: { documentIds: readonly string[]; currencies: readonly string[] } | null | undefined): ImportedNotInNetWorthAction[] {
  const currencies = where?.currencies ?? [];
  const documentIds = where?.documentIds ?? [];
  const hasIndia = currencies.includes('INR');
  const hasOther = currencies.some((c) => c !== 'INR') || currencies.length === 0;
  const actions: ImportedNotInNetWorthAction[] = [];
  if (hasIndia) {
    actions.push(
      documentIds.length === 1
        ? { href: `${IMPORTED_DATA_PATH}?documentId=${encodeURIComponent(documentIds[0])}`, label: 'Resolve and publish this statement' }
        : { href: IMPORTED_DATA_PATH, label: 'Review and publish your statements' },
    );
  }
  if (hasOther) actions.push({ href: IMPORTED_INVESTMENTS_PATH, label: 'Add to Net Worth on the Investments page' });
  return actions;
}
