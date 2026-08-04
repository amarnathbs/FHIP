export const COUNTRY_OPTIONS: { value: 'AU' | 'IN'; label: string }[] = [
  { value: 'AU', label: 'Australia' },
  { value: 'IN', label: 'India' },
];

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
