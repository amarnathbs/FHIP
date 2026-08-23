// Chunk 3a item 1 (Spec 1 §9): resolves whether a metadata-driven grid field
// (currently purchase_date/purchase_price on the Assets grid) should be
// shown, hard-required, or shown-but-read-only for one row, based on the
// selected catalogue item's master_financial_items metadata
// (supports_<field>/requires_<field> — see migrations 0068/0069).
//
// Pure and framework-free so it is directly unit-testable without a DOM;
// components/grid/FinancialDataGrid.tsx calls this for every metadataDriven
// field on every row.
import type { GridFieldDef } from './types';

export interface FieldVisibilityRow {
  is_custom?: boolean;
  [key: string]: unknown;
}

export interface FieldVisibilityResult {
  show: boolean;
  required: boolean;
  readOnly: boolean;
}

function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

export function resolveFieldVisibility(row: FieldVisibilityRow, field: GridFieldDef): FieldVisibilityResult {
  if (!field.metadataDriven) {
    return { show: true, required: Boolean(field.required), readOnly: false };
  }

  // Custom (user-defined) rows have no catalogue item to carry metadata —
  // preserve today's behaviour exactly: always shown, never required.
  // Same fallback applies to any master-catalogue row whose metadata hasn't
  // been populated yet (supports_* undefined) so this never regresses
  // ahead of migrations 0068/0069 actually being applied.
  const supportsKey = `supports_${field.name}`;
  const requiresKey = `requires_${field.name}`;
  const supportsRaw = row[supportsKey];
  const requiresRaw = row[requiresKey];

  const supports = row.is_custom || supportsRaw === undefined ? true : Boolean(supportsRaw);
  const required = row.is_custom || requiresRaw === undefined ? false : Boolean(requiresRaw);
  const currentValueHasData = hasValue(row[field.name]);

  if (!supports) {
    // Field doesn't apply to this catalogue item — hide it entirely, UNLESS
    // a value was already saved (e.g. metadata changed after the fact, or a
    // legacy row from before this classification existed) — in that case
    // keep it visible but read-only so the saved value is never silently
    // dropped from view or from the next save's request body.
    return currentValueHasData ? { show: true, required: false, readOnly: true } : { show: false, required: false, readOnly: false };
  }

  return { show: true, required, readOnly: false };
}

/** True when a metadata-required field is genuinely missing on an included row — used for save-blocking and the "missing fields" count. */
export function isMetadataFieldMissing(row: FieldVisibilityRow, field: GridFieldDef): boolean {
  const vis = resolveFieldVisibility(row, field);
  return vis.required && !hasValue(row[field.name]);
}
