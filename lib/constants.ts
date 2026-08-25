export const COUNTRY_OPTIONS: { value: 'AU' | 'IN'; label: string }[] = [
  { value: 'AU', label: 'Australia' },
  { value: 'IN', label: 'India' },
];

// App Review spec §11 (Currency and Country — Critical Financial Defect):
// country selection sets an *intelligent default* currency, never a
// permanent lock — the user can always override it afterwards, and an
// override survives further edits. See COUNTRY_CURRENCY_DEFAULT's usage in
// components/grid/FinancialDataGrid.tsx's handleFieldChange for the "only
// auto-fill while the user hasn't manually touched currency" rule.
export const COUNTRY_CURRENCY_DEFAULT: Record<'AU' | 'IN', 'AUD' | 'INR'> = {
  AU: 'AUD',
  IN: 'INR',
};

export const OWNER_VALUES = [
  'self',
  'spouse',
  'joint',
  'child',
  'family_trust',
  'company',
  'smsf',
  'other',
] as const;

export type Owner = (typeof OWNER_VALUES)[number];

export const OWNER_OPTIONS: { value: Owner; label: string }[] = [
  { value: 'self', label: 'Self' },
  { value: 'spouse', label: 'Spouse/Partner' },
  { value: 'joint', label: 'Joint' },
  { value: 'child', label: 'Child' },
  { value: 'family_trust', label: 'Family Trust' },
  { value: 'company', label: 'Company' },
  { value: 'smsf', label: 'SMSF' },
  { value: 'other', label: 'Other' },
];
