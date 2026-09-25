/**
 * The payslip review screen's view of one proposal field.
 *
 * The proposal API returns the `fhip_import_proposal_fields` rows exactly as
 * `getIncomeProposalForReview` selects them -- snake_case column names
 * (field_name, proposed_value, ...). The Income-tab payslip panel read them
 * as camelCase (fieldName, proposedValue, ...), so every label and value was
 * undefined: the comparison table rendered blank rows, nothing was
 * pre-selected, and "Add as a new income source" sent an empty selection that
 * the apply RPC refuses (NO_FIELDS_SELECTED). No payslip could be applied
 * through the screen. Found in production on 2026-09-25 by the first real
 * AI-fallback payslip journey; every earlier check called the API directly.
 *
 * Accepts either casing so an API change in either direction can't blank the
 * screen again.
 */
export interface ProposedField {
  fieldName: string;
  valueKind: string;
  proposedValue: string | null;
  existingValue: string | null;
  isRecommended: boolean;
  requiresConfirmation: boolean;
  reasonCode: string;
}

type Row = Record<string, unknown>;

function pick(row: Row, camel: string, snake: string): unknown {
  return row[camel] !== undefined ? row[camel] : row[snake];
}

function asNullableString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

export function normaliseProposedField(row: Row): ProposedField {
  return {
    fieldName: String(pick(row, 'fieldName', 'field_name') ?? ''),
    valueKind: String(pick(row, 'valueKind', 'value_kind') ?? ''),
    proposedValue: asNullableString(pick(row, 'proposedValue', 'proposed_value')),
    existingValue: asNullableString(pick(row, 'existingValue', 'existing_value')),
    isRecommended: pick(row, 'isRecommended', 'is_recommended') === true,
    requiresConfirmation: pick(row, 'requiresConfirmation', 'requires_confirmation') === true,
    reasonCode: String(pick(row, 'reasonCode', 'reason_code') ?? ''),
  };
}

/** Drops rows with no field name rather than rendering an unlabelled, unselectable row. */
export function normaliseProposedFields(rows: unknown): ProposedField[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Row => typeof r === 'object' && r !== null)
    .map(normaliseProposedField)
    .filter((f) => f.fieldName !== '');
}
