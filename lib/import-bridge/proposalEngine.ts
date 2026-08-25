/**
 * FHIP Input Data Import Bridge — the domain-agnostic engine.
 *
 * Everything here works for Income, Expenses, Investments, Liabilities and
 * Retirement without modification. Nothing in this file knows what a payslip
 * is, and nothing in it names a canonical register.
 *
 * The three things it owns:
 *   1. VALUE SERIALISATION — one canonical text form per value kind, so a
 *      comparison is exact and reproducible across domains.
 *   2. STALENESS — the value-comparison gate that stops a proposal
 *      overwriting an edit the user made after it was generated.
 *   3. FIELD SELECTION — resolving which fields a user actually approved,
 *      intersected with what the adapter is permitted to write.
 */

import type { ImportValueKind, ProposedField } from './types';

/**
 * Canonical text form of a value.
 *
 * MONEY is the case that matters. `4250`, `4250.0` and `4250.00` are the same
 * amount but three different strings, and a naive string comparison would
 * report a spurious staleness every time. Money is therefore normalised to a
 * fixed 2-decimal representation before it is ever compared or stored.
 * `null`/`undefined` serialise to `null` — "not set" is distinct from "0".
 */
export function serialiseValue(value: unknown, kind: ImportValueKind): string | null {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case 'money': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return null;
      return n.toFixed(2);
    }
    case 'int': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return null;
      return String(Math.trunc(n));
    }
    case 'bool':
      return value === true || value === 'true' ? 'true' : 'false';
    case 'text':
    case 'enum':
    default: {
      const s = String(value).trim();
      return s === '' ? null : s;
    }
  }
}

/** Inverse of `serialiseValue`, for writing back to a column. */
export function deserialiseValue(value: string | null, kind: ImportValueKind): unknown {
  if (value === null) return null;
  switch (kind) {
    case 'money': {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'int': {
      const n = Number(value);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case 'bool':
      return value === 'true';
    case 'text':
    case 'enum':
    default:
      return value;
  }
}

/** True when a proposed field would actually change the target. */
export function isRealChange(field: ProposedField): boolean {
  return field.proposedValue !== field.existingValue;
}

/**
 * Resolve which fields a user's selection actually authorises.
 *
 * Three independent filters, all of which must pass. Each exists to stop a
 * different attack or mistake:
 *
 *   1. The field must be one the PROPOSAL contains — a request cannot invent
 *      a field the engine never proposed.
 *   2. The field must be in the ADAPTER'S ALLOW-LIST — so even a forged
 *      proposal row in the database cannot cause a write to a column the
 *      domain never permits (spec section 47: "selected fields valid, no
 *      forbidden mutation").
 *   3. `requiresConfirmation` fields must be EXPLICITLY selected — they are
 *      never swept in by an "apply everything" default (spec sections 26-27).
 */
export function resolveSelectedFields(
  proposalFields: readonly ProposedField[],
  requestedFieldNames: readonly string[],
  adapterAllowList: readonly string[],
): { selected: ProposedField[]; forbidden: string[]; unknown: string[] } {
  const byName = new Map(proposalFields.map((f) => [f.fieldName, f]));
  const allowed = new Set(adapterAllowList);

  const selected: ProposedField[] = [];
  const forbidden: string[] = [];
  const unknownFields: string[] = [];

  for (const name of requestedFieldNames) {
    const field = byName.get(name);
    if (!field) { unknownFields.push(name); continue; }
    if (!allowed.has(name)) { forbidden.push(name); continue; }
    selected.push(field);
  }

  return { selected, forbidden, unknown: unknownFields };
}

/** The fields ticked by default in the compare view. */
export function defaultSelection(proposalFields: readonly ProposedField[]): string[] {
  return proposalFields
    .filter((f) => f.isRecommended && !f.requiresConfirmation && isRealChange(f))
    .map((f) => f.fieldName);
}

export interface StalenessReport {
  stale: boolean;
  /** Fields whose live value no longer matches the snapshot taken at
   * generation time, with both values, so the UI can show a refreshed
   * comparison rather than a bare refusal. */
  changed: {
    fieldName: string;
    snapshotValue: string | null;
    currentValue: string | null;
    proposedValue: string | null;
  }[];
}

/**
 * THE STALE-PROPOSAL GATE (spec section 48).
 *
 * "If Income was edited after proposal generation, do not silently overwrite
 * newer values — detect STALE_PROPOSAL or use version comparison, show
 * refreshed comparison."
 *
 * WHY VALUE COMPARISON RATHER THAN A TIMESTAMP. The canonical registers carry
 * no version column, and `updated_at` is set by the application layer on some
 * write paths and not others (`registry.update()` sets it; `registry.save()`'s
 * upsert does not — see FDH9_REUSE_AND_GAP_AUDIT.md §1.2). A timestamp gate
 * would therefore have a hole in it. Comparing the actual current value of
 * each field against the snapshot taken at generation time is sound no matter
 * which code path performed the edit, and no matter whether it bumped a
 * timestamp.
 *
 * SCOPED TO THE SELECTED FIELDS ON PURPOSE. If the user edited their Notes
 * and is now applying an Amount, nothing is being overwritten and the apply
 * should proceed. Only a change to a field this apply would WRITE constitutes
 * a conflict.
 */
export function detectStaleness(
  selected: readonly ProposedField[],
  liveValues: Readonly<Record<string, unknown>>,
  serialise: (fieldName: string, value: unknown, kind: ImportValueKind) => string | null,
): StalenessReport {
  const changed: StalenessReport['changed'] = [];
  for (const field of selected) {
    const currentValue = serialise(field.fieldName, liveValues[field.fieldName], field.valueKind);
    if (currentValue !== field.existingValue) {
      changed.push({
        fieldName: field.fieldName,
        snapshotValue: field.existingValue,
        currentValue,
        proposedValue: field.proposedValue,
      });
    }
  }
  return { stale: changed.length > 0, changed };
}

/**
 * Build the patch to write, from the approved fields only.
 *
 * Note what this does NOT do: it never includes a field the user did not
 * select, and it never carries a value from anywhere except the proposal. This
 * is what makes "approve the amount only, leave the frequency alone" real
 * (spec section 61).
 */
export function buildPatch(
  selected: readonly ProposedField[],
  coerce: (fieldName: string, value: string | null, kind: ImportValueKind) => unknown,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of selected) {
    patch[field.fieldName] = coerce(field.fieldName, field.proposedValue, field.valueKind);
  }
  return patch;
}

/** The before/after audit snapshot recorded on apply (spec section 32). */
export function buildAuditSnapshot(
  selected: readonly ProposedField[],
): { appliedFields: string[]; previousValues: Record<string, string | null>; newValues: Record<string, string | null> } {
  const appliedFields: string[] = [];
  const previousValues: Record<string, string | null> = {};
  const newValues: Record<string, string | null> = {};
  for (const field of selected) {
    appliedFields.push(field.fieldName);
    previousValues[field.fieldName] = field.existingValue;
    newValues[field.fieldName] = field.proposedValue;
  }
  return { appliedFields, previousValues, newValues };
}
