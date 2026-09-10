// LR-11B — legacy 'company'/'family_trust' owner-tag resolution. These two
// OWNER_VALUES entries pre-date the real Company/Family Trust entity
// workspace (LR-11/LR-11B) and are cosmetic-only free-text tags with no
// valuation/consolidation logic of their own — see LR11_PHASE_REPORT.md §3's
// disclosed double-entry risk. This phase's resolution (PO decision,
// 2026-09-10): preserve existing rows exactly as they are (no migration, no
// reclassification), mark them clearly as legacy in the UI, and stop
// offering them as a choice for a brand-new row on any of the 7
// financial-data-grid registers. See
// docs/live-recovery/LR11B_LEGACY_OWNER_TAG_RESOLUTION.md for the full
// record.
import { describe, it, expect } from 'vitest';
import { OWNER_VALUES, LEGACY_ENTITY_OWNER_RESTRICTIONS, ownerDisplayLabel } from '@/lib/constants';
import {
  incomeGridConfig,
  expenseGridConfig,
  assetGridConfig,
  liabilityGridConfig,
  investmentGridConfig,
  retirementGridConfig,
  insuranceGridConfig,
} from '@/lib/grid/configs';
import type { GridConfig } from '@/lib/grid/types';

const ALL_SEVEN_CONFIGS: GridConfig[] = [
  incomeGridConfig,
  expenseGridConfig,
  assetGridConfig,
  liabilityGridConfig,
  investmentGridConfig,
  retirementGridConfig,
  insuranceGridConfig,
];

describe('LR-11B — LEGACY_ENTITY_OWNER_RESTRICTIONS', () => {
  it('restricts exactly company and family_trust, unconditionally (no requiredCountry)', () => {
    expect(LEGACY_ENTITY_OWNER_RESTRICTIONS).toEqual(
      expect.arrayContaining([{ value: 'company' }, { value: 'family_trust' }])
    );
    expect(LEGACY_ENTITY_OWNER_RESTRICTIONS).toHaveLength(2);
    for (const r of LEGACY_ENTITY_OWNER_RESTRICTIONS) {
      expect((r as { requiredCountry?: string }).requiredCountry).toBeUndefined();
    }
  });

  it('both restricted values are still valid OWNER_VALUES (existing rows remain valid, never removed from the type)', () => {
    for (const r of LEGACY_ENTITY_OWNER_RESTRICTIONS) {
      expect(OWNER_VALUES).toContain(r.value);
    }
  });
});

describe('LR-11B — every one of the 7 financial-data-grid registers restricts the legacy tags for NEW selection', () => {
  it.each(ALL_SEVEN_CONFIGS.map((c) => [c.title, c] as const))('%s config includes both legacy restrictions', (_title, config) => {
    const values = (config.restrictedOwnerValues ?? []).map((r) => r.value);
    expect(values).toEqual(expect.arrayContaining(['company', 'family_trust']));
  });

  it("insurance's pre-existing AU-only SMSF restriction (LR-7 WP-03) survives the merge unchanged", () => {
    const smsfRestriction = insuranceGridConfig.restrictedOwnerValues?.find((r) => r.value === 'smsf');
    expect(smsfRestriction).toEqual({ value: 'smsf', requiredCountry: 'AU' });
  });

  it('no config accidentally restricts anything other than company/family_trust (+ insurance\'s own pre-existing smsf entry)', () => {
    for (const config of ALL_SEVEN_CONFIGS) {
      const values = (config.restrictedOwnerValues ?? []).map((r) => r.value);
      const unexpected = values.filter((v) => v !== 'company' && v !== 'family_trust' && v !== 'smsf');
      expect(unexpected).toEqual([]);
    }
  });
});

describe('LR-11B — ownerDisplayLabel()', () => {
  it('marks company and family_trust as (Legacy)', () => {
    expect(ownerDisplayLabel('company')).toBe('Company (Legacy)');
    expect(ownerDisplayLabel('family_trust')).toBe('Family Trust (Legacy)');
  });

  it('leaves every other owner value unmarked', () => {
    expect(ownerDisplayLabel('self')).toBe('Self');
    expect(ownerDisplayLabel('spouse')).toBe('Spouse/Partner');
    expect(ownerDisplayLabel('joint')).toBe('Joint');
    expect(ownerDisplayLabel('child')).toBe('Child');
    expect(ownerDisplayLabel('smsf')).toBe('SMSF');
    expect(ownerDisplayLabel('other')).toBe('Other');
  });

  it('falls back gracefully for null/undefined/unknown values without throwing', () => {
    expect(ownerDisplayLabel(null)).toBe('');
    expect(ownerDisplayLabel(undefined)).toBe('');
    expect(ownerDisplayLabel('some_future_value_zzz')).toBe('some_future_value_zzz');
  });
});
