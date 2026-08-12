import { describe, it, expect } from 'vitest';
import { findDuplicateCustomNames, type GridRow } from '@/lib/engines/data-quality';

function row(overrides: Partial<GridRow>): GridRow {
  return { is_custom: true, item_label: '', ...overrides };
}

describe('findDuplicateCustomNames', () => {
  it('flags two custom rows with the same name (case/whitespace-insensitive)', () => {
    const rows = [row({ item_label: 'Side hustle' }), row({ item_label: '  side HUSTLE  ' })];
    const duplicates = findDuplicateCustomNames(rows);
    expect(duplicates.has('side hustle')).toBe(true);
  });

  it('flags a custom row that collides with a master-catalog item label', () => {
    const rows = [
      row({ is_custom: false, item_label: 'Employment salary' }),
      row({ is_custom: true, item_label: 'employment salary' }),
    ];
    const duplicates = findDuplicateCustomNames(rows);
    expect(duplicates.has('employment salary')).toBe(true);
  });

  it('does not flag distinct custom names', () => {
    const rows = [row({ item_label: 'Side hustle' }), row({ item_label: 'Freelance design' })];
    expect(findDuplicateCustomNames(rows).size).toBe(0);
  });

  it('ignores empty custom names', () => {
    const rows = [row({ item_label: '' }), row({ item_label: '' })];
    expect(findDuplicateCustomNames(rows).size).toBe(0);
  });
});
