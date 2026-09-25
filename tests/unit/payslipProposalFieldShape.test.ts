/**
 * The payslip review screen must understand the proposal rows the API sends.
 *
 * Production 2026-09-25: the proposal API returns snake_case rows
 * (field_name, proposed_value, ...) and the Income-tab payslip panel read
 * camelCase -- a blank comparison table, nothing pre-selected, and "Add as a
 * new income source" refused as NO_FIELDS_SELECTED. No payslip could be
 * applied through the screen.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normaliseProposedFields } from '@/lib/import-bridge/proposedFieldShape';

const root = path.resolve(__dirname, '..', '..');

/** Rows exactly as getIncomeProposalForReview selects them from fhip_import_proposal_fields. */
const apiRows = [
  { field_name: 'source_name', value_kind: 'text', proposed_value: 'Quillfeather Studio Pty Ltd', existing_value: null, is_recommended: true, requires_confirmation: false, confidence: 'high', reason_code: 'new_source' },
  { field_name: 'amount', value_kind: 'money', proposed_value: '3200.0000', existing_value: null, is_recommended: true, requires_confirmation: false, confidence: 'high', reason_code: 'new_source' },
  { field_name: 'frequency', value_kind: 'enum', proposed_value: 'fortnightly', existing_value: null, is_recommended: true, requires_confirmation: false, confidence: 'high', reason_code: 'new_source' },
  { field_name: 'tax_withheld', value_kind: 'money', proposed_value: '512.0000', existing_value: null, is_recommended: false, requires_confirmation: true, confidence: 'medium', reason_code: 'confirm' },
];

describe('proposal rows from the API reach the review screen intact', () => {
  it('maps every snake_case column to the field the screen renders', () => {
    const fields = normaliseProposedFields(apiRows);
    expect(fields).toHaveLength(4);
    expect(fields[1]).toEqual({
      fieldName: 'amount', valueKind: 'money', proposedValue: '3200.0000', existingValue: null,
      isRecommended: true, requiresConfirmation: false, reasonCode: 'new_source',
    });
    expect(fields.every((f) => f.fieldName !== '')).toBe(true);
  });

  it("the screen's default selection is non-empty, so 'Add as a new income source' has fields to apply", () => {
    const fields = normaliseProposedFields(apiRows);
    // The panel's own default-selection rule (PayslipImportPanel.loadProposal).
    const selected = fields.filter((f) => f.isRecommended && !f.requiresConfirmation && f.proposedValue !== f.existingValue).map((f) => f.fieldName);
    expect(selected).toEqual(['source_name', 'amount', 'frequency']);
  });

  it('still accepts camelCase rows, and drops rows with no field name instead of rendering them blank', () => {
    const fields = normaliseProposedFields([{ fieldName: 'amount', proposedValue: '1', isRecommended: true }, { nonsense: 1 }, null]);
    expect(fields.map((f) => f.fieldName)).toEqual(['amount']);
    expect(normaliseProposedFields(undefined)).toEqual([]);
  });
});

describe('the API and the screen agree on the row shape', () => {
  it("the review query selects every column the screen's mapping reads", () => {
    const src = fs.readFileSync(path.join(root, 'lib/import-bridge/incomeProposalService.ts'), 'utf8');
    const fn = src.slice(src.indexOf('export async function getIncomeProposalForReview'));
    const select = fn.slice(fn.indexOf("from('fhip_import_proposal_fields')"), fn.indexOf('.eq(', fn.indexOf("from('fhip_import_proposal_fields')")));
    for (const col of ['field_name', 'value_kind', 'proposed_value', 'existing_value', 'is_recommended', 'requires_confirmation', 'reason_code']) {
      expect(select, `review query no longer selects ${col}`).toContain(col);
    }
  });

  it('the payslip panel maps the rows instead of casting them', () => {
    const panel = fs.readFileSync(path.join(root, 'components/income/PayslipImportPanel.tsx'), 'utf8');
    expect(panel).toContain('normaliseProposedFields(json.data.fields)');
    expect(panel).not.toMatch(/json\.data\.fields as ProposedField\[\]/);
  });
});
