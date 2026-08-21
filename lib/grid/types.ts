export type GridCategory = 'income' | 'expense' | 'asset' | 'liability' | 'investment' | 'retirement' | 'insurance';

export type GridFieldType = 'text' | 'number' | 'select' | 'date' | 'checkbox';

export interface GridFieldOption {
  value: string;
  label: string;
}

export interface GridFieldDef {
  name: string;
  label: string;
  type: GridFieldType;
  options?: GridFieldOption[];
  step?: string;
  required?: boolean;
  defaultValue?: string | number | boolean;
  // Chunk 3a item 1 (Spec 1 §9): when true, this field's visibility/
  // required-ness is driven per-row by the selected catalogue item's
  // master_financial_items metadata (supports_<name>/requires_<name>
  // columns — migrations 0033/0034) rather than being uniformly shown for
  // every row in this category. See lib/grid/fieldVisibility.ts. Only
  // meaningful for field names with a matching supports_*/requires_*
  // column pair (currently purchase_date, purchase_price).
  metadataDriven?: boolean;
}

export interface GridConfig {
  category: GridCategory;
  resource: string; // API path segment, e.g. 'income'
  title: string;
  description: string;
  nameField: string; // e.g. 'source_name'
  valueField: string; // primary amount/value field for totals + validation
  isFlow?: boolean; // true = recurring amount that needs a frequency to annualise
  frequencyField?: string;
  fields: GridFieldDef[]; // extra editable columns beyond item name/owner/currency
  // When set, shows a "this doesn't apply to me" toggle backed by this
  // user_profiles boolean column (migration 0029) — only offered for the
  // categories where genuine inapplicability is plausible (investments,
  // retirement, insurance); see healthScore.ts's 'not_applicable' treatment.
  notApplicable?: {
    profileField: 'not_applicable_investments' | 'not_applicable_retirement' | 'not_applicable_insurance';
    label: string;
  };
}
