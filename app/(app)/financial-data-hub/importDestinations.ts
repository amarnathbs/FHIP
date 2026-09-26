/**
 * PO decision D-13 (WP-08, UPL-03 / GAP-11 hub part): the generic FDH upload
 * page is retired. Each document type is imported on the tab that has a real
 * process + review + Apply path for it; these are those tabs. Types with no
 * such path are listed as not supported (registry disposition E, visible).
 */
export const IMPORT_DESTINATIONS: ReadonlyArray<{ types: readonly string[]; href: string; label: string; what: string }> = [
  { types: ['bank_statement'], href: '/expenses', label: 'Expenses', what: 'Bank statements (PDF or CSV): Expenses, then "Import bank statement".' },
  { types: ['payslip'], href: '/income', label: 'Income', what: 'Payslips: Income, then "Import payslip".' },
  { types: ['credit_card_statement', 'loan_statement'], href: '/liabilities', label: 'Liabilities', what: 'Credit card and loan statements: Liabilities, then "Import statement".' },
  { types: ['investment_statement'], href: '/investments', label: 'Investments', what: 'Australian broker and investment statements: Investments, then "Import statement".' },
  { types: ['cas_statement'], href: '/investment-intelligence', label: 'Investment Intelligence', what: 'Indian mutual fund statements (CAS): Investment Intelligence.' },
  { types: ['super_statement'], href: '/retirement', label: 'Retirement', what: 'Superannuation statements: Retirement, then "Import statement".' },
];

export const NOT_SUPPORTED_FOR_IMPORT: ReadonlyArray<{ type: string; label: string }> = [
  { type: 'epf_statement', label: 'EPF statements' },
  { type: 'nps_statement', label: 'NPS statements' },
  { type: 'tax_document', label: 'Tax documents' },
  { type: 'other', label: 'Other financial documents' },
];

/** Where a document type is imported, or null when it cannot be yet. */
export function importDestinationFor(documentType: string | null | undefined): string | null {
  if (!documentType) return null;
  return IMPORT_DESTINATIONS.find((d) => d.types.includes(documentType))?.href ?? null;
}
