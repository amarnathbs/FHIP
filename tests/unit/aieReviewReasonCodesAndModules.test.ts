import { describe, it, expect } from 'vitest';
import { stripCoreReconciliationPrefix, GENERIC_FALLBACK_REASON_META, INSURANCE_REASON_CODES } from '@/lib/aie/review/reasonCodes';
import { resolveModuleDescriptorByAdapterId, resolveReasonCodeMeta, narrowInsuranceRequiredFieldsCorrection, listModuleDescriptors } from '@/lib/aie/review/moduleRegistry';

describe('AIE-1.5 reasonCodes.ts — prefix stripping', () => {
  it('strips the AIE-1.1 core "reconciliation_fail:" wrapper', () => {
    expect(stripCoreReconciliationPrefix('reconciliation_fail:insurance_document_class_supported')).toBe('insurance_document_class_supported');
  });
  it('strips the AIE-1.1 core "reconciliation_indeterminate:" wrapper', () => {
    expect(stripCoreReconciliationPrefix('reconciliation_indeterminate:insurance_multi_component_not_supported')).toBe('insurance_multi_component_not_supported');
  });
  it('passes through a reason code an adapter creates directly (no AIE-1.1 wrapper), e.g. AIE-1.2\'s own family', () => {
    expect(stripCoreReconciliationPrefix('ii_adapter:ambiguous_account')).toBe('ii_adapter:ambiguous_account');
  });
});

describe('AIE-1.5 moduleRegistry.ts — adapter resolution and reason-code lookup', () => {
  it('resolves the real, integration-tested Insurance descriptor by its actual adapter id', () => {
    const descriptor = resolveModuleDescriptorByAdapterId('insurance_generic_schedule_v1');
    expect(descriptor?.moduleKey).toBe('insurance');
    expect(descriptor?.integrationTested).toBe(true);
  });

  it('returns null for an unregistered/absent adapter id (AIE-1.1 core\'s own no-domain-adapter path)', () => {
    expect(resolveModuleDescriptorByAdapterId(null)).toBeNull();
    expect(resolveModuleDescriptorByAdapterId('something_unregistered')).toBeNull();
  });

  it('the Investment Intelligence and FDH descriptors are explicitly flagged design-only / not integration tested', () => {
    for (const descriptor of listModuleDescriptors()) {
      if (descriptor.moduleKey !== 'insurance') expect(descriptor.integrationTested).toBe(false);
    }
  });

  it('resolves an exact insurance reason code through the core reconciliation_fail: wrapper', () => {
    const descriptor = resolveModuleDescriptorByAdapterId('insurance_generic_schedule_v1');
    const meta = resolveReasonCodeMeta(descriptor, 'reconciliation_fail:insurance_currency_supported');
    expect(meta.humanQuestion).toBe(INSURANCE_REASON_CODES.insurance_currency_supported.humanQuestion);
    expect(meta.allowedActions).toContain('correct');
  });

  it('a genuinely unknown reason code for a known module falls back to the generic, correction-free, blocking meta (ITEM-01 / ACT-09 safe default)', () => {
    const descriptor = resolveModuleDescriptorByAdapterId('insurance_generic_schedule_v1');
    const meta = resolveReasonCodeMeta(descriptor, 'reconciliation_fail:some_future_rule_not_yet_catalogued');
    expect(meta).toEqual(GENERIC_FALLBACK_REASON_META);
    expect(meta.allowedActions).not.toContain('correct');
  });

  it('a null descriptor (no adapter at all) always falls back to the generic meta', () => {
    expect(resolveReasonCodeMeta(null, 'anything')).toEqual(GENERIC_FALLBACK_REASON_META);
  });

  it('a design-only module\'s prefix-matched (dynamic-id) reason code resolves correctly', () => {
    const descriptor = resolveModuleDescriptorByAdapterId('investment_intelligence_something');
    expect(descriptor).not.toBeNull();
    const meta = resolveReasonCodeMeta(descriptor, 'ii_adapter_roll_forward:acct-123:instr-456');
    expect(meta.humanQuestion).toMatch(/roll forward/);
  });
});

describe('AIE-1.5 moduleRegistry.ts — narrowInsuranceRequiredFieldsCorrection (ITEM-05/ACT-09)', () => {
  it('narrows the required-fields correction list to ONLY the fields actually missing on this document', () => {
    const meta = INSURANCE_REASON_CODES.insurance_required_fields_present;
    const present = new Set(['policyName', 'coverAmount']); // premium/premiumFrequency/currencyCode missing
    const narrowed = narrowInsuranceRequiredFieldsCorrection(meta, present);
    const fieldNames = narrowed.correctableFields?.map((f) => f.fieldName) ?? [];
    expect(fieldNames.sort()).toEqual(['currencyCode', 'premium', 'premiumFrequency']);
    expect(fieldNames).not.toContain('policyName');
    expect(fieldNames).not.toContain('coverAmount');
  });

  it('leaves an unrelated reason code\'s correctable fields untouched (e.g. currency_supported, where the field IS present but its VALUE is unsupported)', () => {
    const meta = INSURANCE_REASON_CODES.insurance_currency_supported;
    const present = new Set(['currencyCode']); // present, just an unsupported value
    const narrowed = narrowInsuranceRequiredFieldsCorrection(meta, present);
    expect(narrowed.correctableFields?.map((f) => f.fieldName)).toEqual(['currencyCode']);
  });

  it('is a no-op for a reason code with no correctable fields at all', () => {
    const meta = INSURANCE_REASON_CODES.insurance_document_class_supported;
    expect(narrowInsuranceRequiredFieldsCorrection(meta, new Set())).toBe(meta);
  });
});
