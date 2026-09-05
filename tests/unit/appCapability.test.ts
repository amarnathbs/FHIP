import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveModuleCapability,
  APP_CAPABILITY_MANIFEST,
  MODULE_KEYS,
  CAPABILITY_KEYS,
  type ModuleKey,
} from '@/lib/services/appCapability';
import type { ResolvedCountryContext } from '@/lib/services/jurisdiction';
import { __setG4CapabilityLayerFlagForTests, isG4CapabilityLayerEnabled } from '@/lib/services/appCapabilityFlag';
import { __setG5BGenericWriteFlagForTests } from '@/lib/services/g5bWriteFlag';

function emptyCapabilities(overrides: Record<string, boolean> = {}): Record<string, boolean> {
  const base = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, false]));
  return { ...base, ...overrides };
}

function context(overrides: Partial<ResolvedCountryContext> = {}): ResolvedCountryContext {
  return {
    residenceCountry: null,
    residenceConfirmed: false,
    primaryCountry: null,
    primaryCountryProvenance: 'UNRESOLVED',
    baseCurrency: null,
    locale: null,
    billingCountry: null,
    billingConfirmed: false,
    crossBorderCountries: [],
    experienceLevel: 'UNAVAILABLE',
    capabilities: emptyCapabilities(),
    ...overrides,
  };
}

describe('appCapabilityFlag', () => {
  afterEach(() => {
    __setG4CapabilityLayerFlagForTests(undefined);
  });

  it('defaults to off when the env var is unset', () => {
    delete process.env.G4_APP_CAPABILITY_LAYER_ENABLED;
    expect(isG4CapabilityLayerEnabled()).toBe(false);
  });

  it('is off for any value other than the exact string "true" (fail closed on misconfiguration)', () => {
    process.env.G4_APP_CAPABILITY_LAYER_ENABLED = 'TRUE';
    expect(isG4CapabilityLayerEnabled()).toBe(false);
    process.env.G4_APP_CAPABILITY_LAYER_ENABLED = '1';
    expect(isG4CapabilityLayerEnabled()).toBe(false);
    delete process.env.G4_APP_CAPABILITY_LAYER_ENABLED;
  });

  it('is on for the exact string "true"', () => {
    process.env.G4_APP_CAPABILITY_LAYER_ENABLED = 'true';
    expect(isG4CapabilityLayerEnabled()).toBe(true);
    delete process.env.G4_APP_CAPABILITY_LAYER_ENABLED;
  });

  it('the deterministic test override takes precedence over the env var', () => {
    process.env.G4_APP_CAPABILITY_LAYER_ENABLED = 'true';
    __setG4CapabilityLayerFlagForTests(false);
    expect(isG4CapabilityLayerEnabled()).toBe(false);
    delete process.env.G4_APP_CAPABILITY_LAYER_ENABLED;
  });
});

describe('APP_CAPABILITY_MANIFEST completeness', () => {
  it('has exactly one entry per declared ModuleKey — no missing, no extra', () => {
    const manifestKeys = Object.keys(APP_CAPABILITY_MANIFEST).sort();
    expect(manifestKeys).toEqual([...MODULE_KEYS].sort());
  });

  it("every manifest entry's requiredCapability is one of the G1 registry's own capability keys", () => {
    for (const key of MODULE_KEYS) {
      const rule = APP_CAPABILITY_MANIFEST[key];
      expect(CAPABILITY_KEYS).toContain(rule.requiredCapability);
    }
  });

  it("every manifest entry's own key matches the record key it is stored under", () => {
    for (const key of MODULE_KEYS) {
      expect(APP_CAPABILITY_MANIFEST[key].key).toBe(key);
    }
  });

  // G4 closure item 2 (Product Owner, 2026-09-05): "require an explicit
  // capability-mapping entry for every opt-in" now extends to operations too
  // — every manifest entry must state a real policy for CREATE/UPDATE/DELETE,
  // not rely on an implicit default.
  it('every manifest entry declares an explicit, valid operationPolicy for CREATE, UPDATE and DELETE', () => {
    const VALID_POLICIES = new Set(['FOLLOWS_VIEW', 'UNAVAILABLE_FOR_GENERIC_WRITE', 'FOLLOWS_VIEW_WHEN_G5B_WRITE_ENABLED']);
    for (const key of MODULE_KEYS) {
      const policy = APP_CAPABILITY_MANIFEST[key].operationPolicy;
      expect(policy, key).toBeDefined();
      for (const op of ['CREATE', 'UPDATE', 'DELETE'] as const) {
        expect(VALID_POLICIES.has(policy[op]), `${key}.${op}`).toBe(true);
      }
    }
  });

  // G5B (Product Owner, 2026-09-05) split the original "six G4-universal
  // modules" group in two: three (Scores/DNA/Resilience) remain hard
  // UNAVAILABLE_FOR_GENERIC_WRITE (no write surface was ever certified for
  // them — they are derived/computed modules); three (Income/Expenses/
  // Insurance) were independently re-verified and now use
  // FOLLOWS_VIEW_WHEN_G5B_WRITE_ENABLED, which behaves identically to
  // UNAVAILABLE_FOR_GENERIC_WRITE while the G5B flag is off (see the
  // 'operation-aware decisions with the G5B flag' describe block below for
  // the flag-on behaviour).
  it('exactly three modules (Scores/DNA/Resilience) use UNAVAILABLE_FOR_GENERIC_WRITE, exactly three (Income/Expenses/Insurance) use FOLLOWS_VIEW_WHEN_G5B_WRITE_ENABLED, and every other module FOLLOWS_VIEW for every operation', () => {
    const HARD_UNAVAILABLE = new Set(['SCORES', 'DNA', 'RESILIENCE']);
    const G5B_GATED = new Set(['INCOME', 'EXPENSES', 'INSURANCE']);
    for (const key of MODULE_KEYS) {
      const policy = APP_CAPABILITY_MANIFEST[key].operationPolicy;
      if (HARD_UNAVAILABLE.has(key)) {
        expect(policy.CREATE, key).toBe('UNAVAILABLE_FOR_GENERIC_WRITE');
        expect(policy.UPDATE, key).toBe('UNAVAILABLE_FOR_GENERIC_WRITE');
        expect(policy.DELETE, key).toBe('FOLLOWS_VIEW');
      } else if (G5B_GATED.has(key)) {
        expect(policy.CREATE, key).toBe('FOLLOWS_VIEW_WHEN_G5B_WRITE_ENABLED');
        expect(policy.UPDATE, key).toBe('FOLLOWS_VIEW_WHEN_G5B_WRITE_ENABLED');
        expect(policy.DELETE, key).toBe('FOLLOWS_VIEW');
      } else {
        expect(policy.CREATE, key).toBe('FOLLOWS_VIEW');
        expect(policy.UPDATE, key).toBe('FOLLOWS_VIEW');
        expect(policy.DELETE, key).toBe('FOLLOWS_VIEW');
      }
    }
  });

  it('every manifest entry declares a writeTables entry (structured, not prose) for CREATE/UPDATE/DELETE', () => {
    for (const key of MODULE_KEYS) {
      const rule = APP_CAPABILITY_MANIFEST[key];
      expect(rule.writeTables, key).toBeDefined();
      for (const op of ['CREATE', 'UPDATE', 'DELETE'] as const) {
        expect(Array.isArray(rule.writeTables[op]), `${key}.${op}`).toBe(true);
      }
    }
  });

  it('only Income/Expenses/Insurance declare non-empty writeTables, and only for CREATE/UPDATE (never DELETE — "delete" is an UPDATE/archive)', () => {
    const G5B_GATED = new Set(['INCOME', 'EXPENSES', 'INSURANCE']);
    const expectedTable: Record<string, string> = {
      INCOME: 'income_sources',
      EXPENSES: 'expense_items',
      INSURANCE: 'insurance_policies',
    };
    for (const key of MODULE_KEYS) {
      const rule = APP_CAPABILITY_MANIFEST[key];
      if (G5B_GATED.has(key)) {
        expect(rule.writeTables.CREATE, key).toEqual([expectedTable[key]]);
        expect(rule.writeTables.UPDATE, key).toEqual([expectedTable[key]]);
        expect(rule.writeTables.DELETE, key).toEqual([]);
      } else {
        expect(rule.writeTables.CREATE, key).toEqual([]);
        expect(rule.writeTables.UPDATE, key).toEqual([]);
        expect(rule.writeTables.DELETE, key).toEqual([]);
      }
    }
  });
});

describe('resolveModuleCapability', () => {
  it('UNAVAILABLE, reason MANIFEST_ENTRY_MISSING for a module key absent from the manifest', () => {
    const result = resolveModuleCapability('NOT_A_REAL_MODULE' as ModuleKey, context({ primaryCountry: 'AU', experienceLevel: 'FULL', capabilities: emptyCapabilities({ UNIVERSAL_MODULES: true }) }));
    expect(result).toEqual({ decision: 'UNAVAILABLE', reason: 'MANIFEST_ENTRY_MISSING' });
  });

  it('UNAVAILABLE, reason NO_PRIMARY_COUNTRY when the context has no resolvable primary country and no existing records', () => {
    const result = resolveModuleCapability('INCOME', context({ primaryCountry: null }));
    expect(result).toEqual({ decision: 'UNAVAILABLE', reason: 'NO_PRIMARY_COUNTRY' });
  });

  it('EXISTING_RECORD_ONLY when no primary country is resolvable but the caller has existing rows and the module supports preservation', () => {
    const result = resolveModuleCapability('INCOME', context({ primaryCountry: null }), { hasExistingRecords: true });
    expect(result).toEqual({ decision: 'EXISTING_RECORD_ONLY', reason: 'NO_PRIMARY_COUNTRY' });
  });

  it('UNAVAILABLE, reason EXPERIENCE_UNAVAILABLE when the primary country registry entry is UNAVAILABLE', () => {
    const result = resolveModuleCapability(
      'INCOME',
      context({ primaryCountry: 'FR', experienceLevel: 'UNAVAILABLE', capabilities: emptyCapabilities() })
    );
    expect(result).toEqual({ decision: 'UNAVAILABLE', reason: 'EXPERIENCE_UNAVAILABLE' });
  });

  it('ENABLED for a UNIVERSAL_MODULES-gated module when the resolved country has that capability true (GENERIC country, e.g. GB)', () => {
    const result = resolveModuleCapability(
      'INCOME',
      context({ primaryCountry: 'GB', experienceLevel: 'GENERIC', capabilities: emptyCapabilities({ UNIVERSAL_MODULES: true }) })
    );
    expect(result).toEqual({ decision: 'ENABLED', reason: 'NONE' });
  });

  it('ENABLED for the same UNIVERSAL_MODULES module for a FULL country (AU)', () => {
    const result = resolveModuleCapability(
      'INCOME',
      context({ primaryCountry: 'AU', experienceLevel: 'FULL', capabilities: emptyCapabilities({ UNIVERSAL_MODULES: true }) })
    );
    expect(result).toEqual({ decision: 'ENABLED', reason: 'NONE' });
  });

  it('UNAVAILABLE for a DOMESTIC_RETIREMENT-gated module (Retirement) for a GENERIC country whose capability is false', () => {
    const result = resolveModuleCapability(
      'RETIREMENT',
      context({ primaryCountry: 'GB', experienceLevel: 'GENERIC', capabilities: emptyCapabilities({ UNIVERSAL_MODULES: true, CROSS_BORDER_RELATIONSHIPS: true }) })
    );
    expect(result).toEqual({ decision: 'UNAVAILABLE', reason: 'CAPABILITY_NOT_ENABLED' });
  });

  it('EXISTING_RECORD_ONLY (not UNAVAILABLE) for a capability-off module when the caller has existing rows and the module supports preservation — e.g. a user whose primary country changed away from AU', () => {
    const result = resolveModuleCapability(
      'RETIREMENT',
      context({ primaryCountry: 'GB', experienceLevel: 'GENERIC', capabilities: emptyCapabilities({ UNIVERSAL_MODULES: true }) }),
      { hasExistingRecords: true }
    );
    expect(result).toEqual({ decision: 'EXISTING_RECORD_ONLY', reason: 'CAPABILITY_NOT_ENABLED' });
  });

  it('never returns EXISTING_RECORD_ONLY for a module whose manifest entry has supportsExistingRecordPreservation=false, even with hasExistingRecords=true', () => {
    // PROFILE is UNIVERSAL_MODULES-gated with supportsExistingRecordPreservation=false and
    // would resolve ENABLED anyway once a country is set — use ADMIN instead, which has
    // no meaningful "existing record" concept and also carries the flag false, to isolate
    // the branch: force a capability-off scenario so the two branches would visibly differ
    // if the false flag were not honoured.
    const rule = APP_CAPABILITY_MANIFEST.ADMIN;
    expect(rule.supportsExistingRecordPreservation).toBe(false);
    const result = resolveModuleCapability(
      'ADMIN',
      context({ primaryCountry: 'GB', experienceLevel: 'GENERIC', capabilities: emptyCapabilities({ UNIVERSAL_MODULES: true }) }),
      { hasExistingRecords: true }
    );
    expect(result).toEqual({ decision: 'UNAVAILABLE', reason: 'CAPABILITY_NOT_ENABLED' });
  });

  it('AU stays ENABLED for every module the current registry actually enables for AU (no regression check)', () => {
    const auCapabilities = emptyCapabilities({
      REGISTRATION: true,
      UNIVERSAL_MODULES: true,
      DOMESTIC_CALCULATIONS: true,
      DOMESTIC_RETIREMENT: true,
      DOMESTIC_TAX_OUTPUTS: false,
      CROSS_BORDER_RELATIONSHIPS: true,
      LOCALISED_RESOURCES: true,
      LOCALISED_REPORTS: true,
      APPROVED_BILLING: false,
      APPROVED_PRICING: false,
      FX_CONVERSION: true,
      REGULATORY_GUIDANCE: true,
      COUNTRY_SPECIFIC_CATALOGUE_ITEMS: true,
    });
    const auContext = context({ primaryCountry: 'AU', experienceLevel: 'FULL', capabilities: auCapabilities });
    for (const key of MODULE_KEYS) {
      const rule = APP_CAPABILITY_MANIFEST[key];
      const result = resolveModuleCapability(key, auContext);
      if (auCapabilities[rule.requiredCapability]) {
        expect(result.decision, `${key} should be ENABLED for AU`).toBe('ENABLED');
      }
    }
  });

  it('IN stays ENABLED for every module the current registry actually enables for IN (no regression check)', () => {
    const inCapabilities = emptyCapabilities({
      REGISTRATION: true,
      UNIVERSAL_MODULES: true,
      DOMESTIC_CALCULATIONS: true,
      DOMESTIC_RETIREMENT: false,
      DOMESTIC_TAX_OUTPUTS: true,
      CROSS_BORDER_RELATIONSHIPS: true,
      LOCALISED_RESOURCES: true,
      LOCALISED_REPORTS: true,
      APPROVED_BILLING: false,
      APPROVED_PRICING: false,
      FX_CONVERSION: true,
      REGULATORY_GUIDANCE: true,
      COUNTRY_SPECIFIC_CATALOGUE_ITEMS: true,
    });
    const inContext = context({ primaryCountry: 'IN', experienceLevel: 'FULL', capabilities: inCapabilities });
    for (const key of MODULE_KEYS) {
      const rule = APP_CAPABILITY_MANIFEST[key];
      const result = resolveModuleCapability(key, inContext);
      if (inCapabilities[rule.requiredCapability]) {
        expect(result.decision, `${key} should be ENABLED for IN`).toBe('ENABLED');
      }
    }
  });

  it('every GENERIC country (GB/US/SG/AE) resolves to exactly the same decision set as every other GENERIC country for every module (no per-generic-country drift)', () => {
    const genericCapabilities = emptyCapabilities({ UNIVERSAL_MODULES: true, CROSS_BORDER_RELATIONSHIPS: true });
    const decisionsByCountry = ['GB', 'US', 'SG', 'AE'].map((code) => {
      const ctx = context({ primaryCountry: code, experienceLevel: 'GENERIC', capabilities: genericCapabilities });
      return MODULE_KEYS.map((key) => resolveModuleCapability(key, ctx).decision);
    });
    for (let i = 1; i < decisionsByCountry.length; i++) {
      expect(decisionsByCountry[i]).toEqual(decisionsByCountry[0]);
    }
  });

  it('the six modules G4/G5B certify universal-to-VIEW are ENABLED for a GENERIC country', () => {
    const genericContext = context({ primaryCountry: 'GB', experienceLevel: 'GENERIC', capabilities: emptyCapabilities({ UNIVERSAL_MODULES: true, CROSS_BORDER_RELATIONSHIPS: true }) });
    for (const key of ['INCOME', 'EXPENSES', 'INSURANCE', 'SCORES', 'DNA', 'RESILIENCE'] as ModuleKey[]) {
      expect(resolveModuleCapability(key, genericContext).decision, key).toBe('ENABLED');
    }
  });

  // G4 closure item 2 (Product Owner, 2026-09-05): operation-aware decisions.
  describe('operation-aware decisions', () => {
    const genericSix = context({ primaryCountry: 'GB', experienceLevel: 'GENERIC', capabilities: emptyCapabilities({ UNIVERSAL_MODULES: true }) });
    const fullSix = context({ primaryCountry: 'AU', experienceLevel: 'FULL', capabilities: emptyCapabilities({ UNIVERSAL_MODULES: true }) });
    const SIX: ModuleKey[] = ['INCOME', 'EXPENSES', 'INSURANCE', 'SCORES', 'DNA', 'RESILIENCE'];
    // G5B (Product Owner, 2026-09-05) split this group: these three now
    // depend on the G5B feature flag for CREATE/UPDATE (see the dedicated
    // 'with the G5B flag' describe block below); the other three
    // (Scores/DNA/Resilience) never do — see HARD_UNAVAILABLE below.
    const G5B_GATED: ModuleKey[] = ['INCOME', 'EXPENSES', 'INSURANCE'];
    const HARD_UNAVAILABLE: ModuleKey[] = ['SCORES', 'DNA', 'RESILIENCE'];

    afterEach(() => {
      __setG5BGenericWriteFlagForTests(undefined);
    });

    it('defaults to the VIEW decision when no operation is passed (backward compatible)', () => {
      for (const key of SIX) {
        expect(resolveModuleCapability(key, genericSix).decision, key).toBe('ENABLED');
      }
    });

    it('CREATE and UPDATE are UNAVAILABLE for GENERIC on Scores/DNA/Resilience regardless of the G5B flag, with the dedicated reason', () => {
      for (const flagState of [false, true]) {
        __setG5BGenericWriteFlagForTests(flagState);
        for (const key of HARD_UNAVAILABLE) {
          for (const operation of ['CREATE', 'UPDATE'] as const) {
            const result = resolveModuleCapability(key, genericSix, { operation });
            expect(result, `${key}.${operation} (flag=${flagState})`).toEqual({ decision: 'UNAVAILABLE', reason: 'WRITE_NOT_CERTIFIED_FOR_GENERIC' });
          }
        }
      }
    });

    it('CREATE and UPDATE are UNAVAILABLE for GENERIC on Income/Expenses/Insurance while the G5B flag is OFF — byte-identical to pre-G5B behaviour', () => {
      __setG5BGenericWriteFlagForTests(false);
      for (const key of G5B_GATED) {
        for (const operation of ['CREATE', 'UPDATE'] as const) {
          const result = resolveModuleCapability(key, genericSix, { operation });
          expect(result, `${key}.${operation}`).toEqual({ decision: 'UNAVAILABLE', reason: 'WRITE_NOT_CERTIFIED_FOR_GENERIC' });
        }
      }
    });

    it('CREATE and UPDATE become ENABLED for GENERIC on Income/Expenses/Insurance once the G5B flag is ON', () => {
      __setG5BGenericWriteFlagForTests(true);
      for (const key of G5B_GATED) {
        for (const operation of ['CREATE', 'UPDATE'] as const) {
          const result = resolveModuleCapability(key, genericSix, { operation });
          expect(result, `${key}.${operation}`).toEqual({ decision: 'ENABLED', reason: 'NONE' });
        }
      }
    });

    it('DELETE follows VIEW (still ENABLED) for GENERIC on all six modules, regardless of the G5B flag', () => {
      for (const flagState of [false, true]) {
        __setG5BGenericWriteFlagForTests(flagState);
        for (const key of SIX) {
          expect(resolveModuleCapability(key, genericSix, { operation: 'DELETE' }).decision, `${key} (flag=${flagState})`).toBe('ENABLED');
        }
      }
    });

    it('CREATE/UPDATE/DELETE are all still ENABLED for a FULL (AU/IN) user on all six modules — no regression, regardless of the G5B flag', () => {
      for (const flagState of [false, true]) {
        __setG5BGenericWriteFlagForTests(flagState);
        for (const key of SIX) {
          for (const operation of ['VIEW', 'CREATE', 'UPDATE', 'DELETE'] as const) {
            expect(resolveModuleCapability(key, fullSix, { operation }).decision, `${key}.${operation} (flag=${flagState})`).toBe('ENABLED');
          }
        }
      }
    });

    it('a module already UNAVAILABLE at VIEW for GENERIC keeps its original reason for CREATE — never overwritten', () => {
      const result = resolveModuleCapability(
        'RETIREMENT',
        context({ primaryCountry: 'GB', experienceLevel: 'GENERIC', capabilities: emptyCapabilities({ UNIVERSAL_MODULES: true }) }),
        { operation: 'CREATE' }
      );
      expect(result).toEqual({ decision: 'UNAVAILABLE', reason: 'CAPABILITY_NOT_ENABLED' });
    });

    it('EXISTING_RECORD_ONLY at VIEW for GENERIC (existing rows, capability off) is forced UNAVAILABLE for CREATE/UPDATE on a six-module entry', () => {
      const ctx = context({ primaryCountry: 'GB', experienceLevel: 'GENERIC', capabilities: emptyCapabilities() });
      const viewResult = resolveModuleCapability('INCOME', ctx, { hasExistingRecords: true });
      expect(viewResult.decision).toBe('EXISTING_RECORD_ONLY');
      const createResult = resolveModuleCapability('INCOME', ctx, { hasExistingRecords: true, operation: 'CREATE' });
      expect(createResult).toEqual({ decision: 'UNAVAILABLE', reason: 'WRITE_NOT_CERTIFIED_FOR_GENERIC' });
    });
  });

  it('the modules with a confirmed real domestic assumption stay UNAVAILABLE for a GENERIC country', () => {
    const genericContext = context({ primaryCountry: 'GB', experienceLevel: 'GENERIC', capabilities: emptyCapabilities({ UNIVERSAL_MODULES: true, CROSS_BORDER_RELATIONSHIPS: true }) });
    for (const key of [
      'DASHBOARD',
      'ASSETS',
      'LIABILITIES',
      'GOALS',
      'INVESTMENTS',
      'RETIREMENT',
      'SMSF',
      'FORECASTING',
      'FINANCIAL_TWIN',
      'RECOMMENDATIONS',
      'REPORTS',
      'RESOURCES',
      'FINANCIAL_DATA_HUB',
      'INVESTMENT_INTELLIGENCE',
      'SUBSCRIPTION_PRICING',
      'AI_INSIGHTS',
      'ADMIN',
    ] as ModuleKey[]) {
      expect(resolveModuleCapability(key, genericContext).decision, key).toBe('UNAVAILABLE');
    }
  });
});
