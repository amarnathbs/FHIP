/**
 * AIE-1.5 — server-side correction validation (AIE15-VALID-01/05/06,
 * ACT-09). Every "enter correction" action is validated HERE, against the
 * specific `AieCorrectableFieldSpec` the reason-code registry declares for
 * that exact field — never a generic "accept any string" path. This is the
 * concrete mechanism behind "no arbitrary field/value mass assignment":
 * a fieldName not present in the item's own `correctableFields` list is
 * rejected before anything is normalised or persisted.
 */

import type { AieCorrectableFieldSpec } from './types';

export type CorrectionValidationResult =
  | { ok: true; normalized: string }
  | { ok: false; reason: 'field_not_correctable' | 'malformed_value' | 'out_of_range' | 'unsupported_enum_value' };

/** VALID-05: "reject NaN, scientific notation, overflow, unsupported
 * currency and malformed dates." Deliberately narrow numeric grammar
 * (plain decimal, optional leading '-', no exponent form) — scientific
 * notation is refused outright rather than silently parsed. */
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateCorrection(spec: AieCorrectableFieldSpec, rawValue: string): CorrectionValidationResult {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'malformed_value' };

  switch (spec.type) {
    case 'string': {
      // VALID-05 bound: cap length defensively — a correction is a short
      // field value, never a document-length paste (also keeps this value
      // safe to echo back in a UI without truncation surprises).
      if (trimmed.length > 200) return { ok: false, reason: 'out_of_range' };
      return { ok: true, normalized: trimmed };
    }
    case 'enum': {
      const upper = trimmed.toUpperCase();
      const match = (spec.enumValues ?? []).find((v) => v.toUpperCase() === upper);
      if (!match) return { ok: false, reason: 'unsupported_enum_value' };
      return { ok: true, normalized: match };
    }
    case 'number': {
      if (!PLAIN_DECIMAL.test(trimmed)) return { ok: false, reason: 'malformed_value' };
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { ok: false, reason: 'malformed_value' };
      if (spec.min !== undefined && n < spec.min) return { ok: false, reason: 'out_of_range' };
      if (spec.max !== undefined && n > spec.max) return { ok: false, reason: 'out_of_range' };
      // Canonical normalized form: no trailing zeros/plus signs beyond what
      // Number->String already gives, matching aie_field_candidate's own
      // "decimal values stored as text" convention (migration 0140).
      return { ok: true, normalized: String(n) };
    }
    case 'date': {
      if (!ISO_DATE.test(trimmed)) return { ok: false, reason: 'malformed_value' };
      const [y, m, d] = trimmed.split('-').map(Number);
      const asDate = new Date(Date.UTC(y, m - 1, d));
      const roundTrips = asDate.getUTCFullYear() === y && asDate.getUTCMonth() === m - 1 && asDate.getUTCDate() === d;
      if (!roundTrips) return { ok: false, reason: 'malformed_value' }; // e.g. 2026-02-30
      return { ok: true, normalized: trimmed };
    }
    default: {
      const _exhaustive: never = spec.type;
      throw new Error(`validateCorrection: unhandled field type ${String(_exhaustive)}`);
    }
  }
}

/** ACT-09: the field-name allowlist check itself, kept separate from value
 * validation so a caller can distinguish "you may not touch this field at
 * all for this reason code" from "the value you gave for a field you ARE
 * allowed to touch is invalid." */
export function findCorrectableFieldSpec(fields: readonly AieCorrectableFieldSpec[] | undefined, fieldName: string): AieCorrectableFieldSpec | null {
  return (fields ?? []).find((f) => f.fieldName === fieldName) ?? null;
}
