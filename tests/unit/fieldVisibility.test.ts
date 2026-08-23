import { describe, it, expect } from 'vitest';
import { resolveFieldVisibility, isMetadataFieldMissing } from '@/lib/grid/fieldVisibility';
import type { GridFieldDef } from '@/lib/grid/types';

// Chunk 3a item 1 (Spec 1 §9): purchase_date/purchase_price shown/required/
// read-only per-row based on catalogue-item metadata, not uniformly for
// every asset type.

const purchaseDateField: GridFieldDef = { name: 'purchase_date', label: 'Purchase Date', type: 'date', metadataDriven: true };
const purchasePriceField: GridFieldDef = {
  name: 'purchase_price',
  label: 'Purchase Price',
  type: 'number',
  metadataDriven: true,
};
const nonMetadataField: GridFieldDef = { name: 'notes', label: 'Notes', type: 'text' };

describe('resolveFieldVisibility', () => {
  it('a non-metadataDriven field is always shown and never metadata-required, matching pre-existing behaviour', () => {
    const row = {};
    expect(resolveFieldVisibility(row, nonMetadataField)).toEqual({ show: true, required: false, readOnly: false });
  });

  it('a catalogue item that does not support purchase_date hides the field when no value is saved', () => {
    const row = { supports_purchase_date: false, requires_purchase_date: false };
    expect(resolveFieldVisibility(row, purchaseDateField)).toEqual({ show: false, required: false, readOnly: false });
  });

  it('a catalogue item that supports purchase_date shows it, editable, not required (the common case today)', () => {
    const row = { supports_purchase_date: true, requires_purchase_date: false };
    expect(resolveFieldVisibility(row, purchaseDateField)).toEqual({ show: true, required: false, readOnly: false });
  });

  it('a catalogue item that requires purchase_price shows it as required', () => {
    const row = { supports_purchase_price: true, requires_purchase_price: true };
    expect(resolveFieldVisibility(row, purchasePriceField)).toEqual({ show: true, required: true, readOnly: false });
  });

  it('backward compatibility: a field marked unsupported but already carrying a saved value stays visible, read-only', () => {
    const row = { supports_purchase_date: false, requires_purchase_date: false, purchase_date: '2019-03-01' };
    expect(resolveFieldVisibility(row, purchaseDateField)).toEqual({ show: true, required: false, readOnly: true });
  });

  it('a custom (user-defined) row always shows metadata-driven fields, matching pre-existing behaviour', () => {
    const row = { is_custom: true };
    expect(resolveFieldVisibility(row, purchaseDateField)).toEqual({ show: true, required: false, readOnly: false });
  });

  it('undefined metadata (e.g. before migrations 0068/0069 land) degrades safely to always-shown, never-required', () => {
    const row = {};
    expect(resolveFieldVisibility(row, purchaseDateField)).toEqual({ show: true, required: false, readOnly: false });
  });
});

describe('isMetadataFieldMissing', () => {
  it('is true when a required metadata field has no value', () => {
    const row = { supports_purchase_price: true, requires_purchase_price: true, purchase_price: '' };
    expect(isMetadataFieldMissing(row, purchasePriceField)).toBe(true);
  });

  it('is false once the required field has a value', () => {
    const row = { supports_purchase_price: true, requires_purchase_price: true, purchase_price: 5000 };
    expect(isMetadataFieldMissing(row, purchasePriceField)).toBe(false);
  });

  it('is false for every currently-populated catalogue item, since requires_* is false everywhere today', () => {
    const row = { supports_purchase_date: true, requires_purchase_date: false };
    expect(isMetadataFieldMissing(row, purchaseDateField)).toBe(false);
  });
});
