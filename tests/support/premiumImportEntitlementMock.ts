/**
 * For LEGACY tests that exercise an upload / processing route or service for reasons that have nothing to do with the
 * Premium upload entitlement (parsers, owner-before-upload, malware gates...). They run as an ENTITLED customer, which
 * is the state those tests were written for; the entitlement itself is proved, with the real capability, in
 * tests/unit/premiumUpload*.test.ts.
 *
 * Usage, at the top of the legacy test file:
 *
 *   vi.mock('@/lib/entitlements/financialDataImport', async (importOriginal) =>
 *     (await import('../support/premiumImportEntitlementMock')).withPremiumImportEntitlement(await importOriginal()));
 */
export function withPremiumImportEntitlement<T extends Record<string, unknown>>(actual: T): T {
  return {
    ...actual,
    resolveFinancialImportAccess: async () => ({ allowed: true, planTier: 'premium' }),
    refuseUnlessFinancialImportAllowed: async () => null,
    refuseUnlessImportRunMayStart: async () => null,
    assertFinancialImportAllowed: async () => undefined,
    financialImportAccessView: async () => ({ state: 'allowed' }),
  };
}
