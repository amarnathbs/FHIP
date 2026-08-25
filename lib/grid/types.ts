import type { FinancialSection } from '@/lib/engines/financialSectionStatus';

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
  // retirement); see healthScore.ts's 'not_applicable' treatment.
  notApplicable?: {
    profileField: 'not_applicable_investments' | 'not_applicable_retirement' | 'not_applicable_insurance';
    label: string;
  };
  // Phase 0C: explicit Yes/No(/Not sure) confirmation, backed by the
  // canonical user_financial_section_status table rather than a
  // user_profiles boolean — used where an absence of rows is genuinely
  // ambiguous between "confirmed zero" and "not reviewed yet" (Liabilities,
  // Insurance). Distinct from notApplicable: a "No" answer here is a real,
  // scoreable fact (confirmed zero debt / confirmed no insurance), not an
  // exclusion from the score. Deliberately a radio question, not a
  // checkbox — Phase 0C §33 asks for the more explicit control on
  // questions this financially significant.
  zeroConfirmation?: {
    section: 'liabilities' | 'insurance';
    question: string;
    noLabel: string;
    // Insurance offers a third "Not sure" option (stays unreviewed rather
    // than forcing a Yes/No); Liabilities does not — see Phase 0C §12 vs §14.
    includeUnsure?: boolean;
  };
  // Phase 0C.1: which canonical FinancialSection this grid represents.
  // Set on every one of the 7 score-relevant grids. Drives the "I've added
  // everything relevant to me" completion control — one row existing is
  // 'in_progress', not 'reviewed_with_data', until the user explicitly
  // confirms the section is complete (see effectiveSectionStatus in
  // financialSectionStatus.ts). Liabilities/Insurance carry both this and
  // zeroConfirmation: zeroConfirmation answers "do you have any at all",
  // reviewSection's completion control answers "have you finished entering
  // what you do have" once the answer is Yes.
  reviewSection: FinancialSection;
  // App Review spec §9 (Assets — Field Reassessment): optional per-row field
  // visibility, driven by field metadata/configuration rather than a
  // scattered field-by-field conditional. Returning false hides that field
  // for that specific row (e.g. Purchase Date for a Savings Account) — the
  // field is still declared in `fields` above (so it renders normally for
  // rows where it applies), this only narrows it per row. Omitted entirely
  // = every field always shown (existing behaviour, unchanged) for every
  // grid that doesn't opt in.
  fieldVisibleForRow?: (fieldName: string, masterItemKey: string | null) => boolean;
}
