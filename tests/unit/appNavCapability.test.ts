import { describe, it, expect } from 'vitest';
import {
  NAV_HREF_MODULE_MAP,
  isNavHrefVisible,
  parseNavDecisions,
  EMPTY_NAV_DECISIONS,
  parseWriteDecisions,
  isModuleWriteAvailable,
  parseDeleteDecisions,
  isModuleDeleteAvailable,
} from '@/lib/nav/appNavCapability';
import { APP_CAPABILITY_MANIFEST, MODULE_KEYS } from '@/lib/services/appCapability';

describe('NAV_HREF_MODULE_MAP', () => {
  it('every mapped module key has a real manifest entry', () => {
    for (const moduleKey of Object.values(NAV_HREF_MODULE_MAP)) {
      expect(MODULE_KEYS).toContain(moduleKey);
      expect(APP_CAPABILITY_MANIFEST[moduleKey]).toBeDefined();
    }
  });

  it('covers every href components/ui/AppShell.tsx actually renders', () => {
    // Mirrors AppShell.tsx's NAV_GROUPS + FORECASTING_ITEMS hrefs verbatim —
    // if a future edit to that file adds/renames an href without updating
    // this map, this assertion is what catches it (nav-config completeness,
    // not itself a security control — see appNavCapability.ts's header).
    const expectedHrefs = [
      '/dashboard',
      '/income',
      '/expenses',
      '/financial-data-hub/activity',
      '/assets',
      '/liabilities',
      '/investments',
      '/insurance',
      '/goals',
      '/score',
      '/dna',
      '/resilience',
      '/financial-twin',
      '/investment-intelligence',
      '/forecast',
      '/forecast/net-worth',
      '/forecast/retirement',
      '/forecast/goals',
      '/forecast/debt',
      '/forecast/investments',
      '/forecast/cross-border',
      '/forecast/resilience',
      '/forecast/variance',
      '/forecast/report',
      '/forecast/scenarios',
      '/forecast/assumptions',
      '/forecast/history',
      '/recommendations',
      '/reports',
      '/ai-insights',
      '/profile',
    ];
    expect(Object.keys(NAV_HREF_MODULE_MAP).sort()).toEqual(expectedHrefs.sort());
  });
});

describe('isNavHrefVisible', () => {
  it('shows an unmapped href regardless of decisions (nav visibility is UX, not authorisation)', () => {
    expect(isNavHrefVisible('/some-future-page', {})).toBe(true);
  });

  it('hides a mapped href with no decision at all (fail closed before /api/capabilities/nav resolves)', () => {
    expect(isNavHrefVisible('/income', EMPTY_NAV_DECISIONS)).toBe(false);
  });

  it('shows a mapped href decided ENABLED', () => {
    expect(isNavHrefVisible('/income', { INCOME: 'ENABLED' })).toBe(true);
  });

  it('shows a mapped href decided EXISTING_RECORD_ONLY (user should still reach their preserved history)', () => {
    expect(isNavHrefVisible('/investments', { INVESTMENTS: 'EXISTING_RECORD_ONLY' })).toBe(true);
  });

  it('hides a mapped href decided UNAVAILABLE — never a clickable item that would only 403', () => {
    expect(isNavHrefVisible('/dashboard', { DASHBOARD: 'UNAVAILABLE' })).toBe(false);
  });
});

describe('parseNavDecisions', () => {
  it('returns empty for a null/non-object/malformed body', () => {
    expect(parseNavDecisions(null)).toEqual({});
    expect(parseNavDecisions(undefined)).toEqual({});
    expect(parseNavDecisions({})).toEqual({});
    expect(parseNavDecisions({ data: null })).toEqual({});
    expect(parseNavDecisions({ data: { decisions: 'not-an-object' } })).toEqual({});
    expect(parseNavDecisions({ data: { decisions: ['array', 'not', 'object'] } })).toEqual({});
  });

  it('drops any entry whose value is not a valid CapabilityDecision string', () => {
    const parsed = parseNavDecisions({
      data: { decisions: { INCOME: 'ENABLED', DASHBOARD: 'YES', GOALS: 123, ASSETS: null } },
    });
    expect(parsed).toEqual({ INCOME: 'ENABLED' });
  });

  it('parses a well-formed decisions body in full', () => {
    const parsed = parseNavDecisions({
      data: { decisions: { INCOME: 'ENABLED', RETIREMENT: 'UNAVAILABLE', INVESTMENTS: 'EXISTING_RECORD_ONLY' } },
    });
    expect(parsed).toEqual({ INCOME: 'ENABLED', RETIREMENT: 'UNAVAILABLE', INVESTMENTS: 'EXISTING_RECORD_ONLY' });
  });
});

// G4 closure item 2 / G5B Phase 2 (2026-09-06): parseWriteDecisions and
// parseDeleteDecisions share parseNavDecisions' exact parsing behaviour
// (same fail-closed rules against a different response field) but had no
// direct unit coverage of their own before this pass — only exercised
// indirectly through useModuleWriteAvailability. Covered directly here so a
// future change to either field name or parse rule fails a focused test
// rather than only a live component behaviour.
describe('parseWriteDecisions', () => {
  it('returns empty for a null/non-object/malformed body', () => {
    expect(parseWriteDecisions(null)).toEqual({});
    expect(parseWriteDecisions({ data: { writeDecisions: 'not-an-object' } })).toEqual({});
  });

  it('parses a well-formed writeDecisions body, dropping invalid entries', () => {
    const parsed = parseWriteDecisions({
      data: { writeDecisions: { INCOME: 'ENABLED', EXPENSES: 'UNAVAILABLE', GOALS: 'bogus' } },
    });
    expect(parsed).toEqual({ INCOME: 'ENABLED', EXPENSES: 'UNAVAILABLE' });
  });
});

describe('isModuleWriteAvailable', () => {
  it('true only for ENABLED, false for any other value or an absent entry', () => {
    expect(isModuleWriteAvailable('INCOME', { INCOME: 'ENABLED' })).toBe(true);
    expect(isModuleWriteAvailable('INCOME', { INCOME: 'EXISTING_RECORD_ONLY' })).toBe(false);
    expect(isModuleWriteAvailable('INCOME', { INCOME: 'UNAVAILABLE' })).toBe(false);
    expect(isModuleWriteAvailable('INCOME', {})).toBe(false);
  });
});

// G5B Phase 2 (2026-09-06): the DELETE-operation counterparts, new this
// phase — Income/Expenses/Insurance are the first modules whose write and
// delete decisions can genuinely diverge for a GENERIC caller (see
// appCapability.ts's OPERATIONS_G5B_WRITE_CERTIFIED comment), so this is
// deliberately tested as its own function, not assumed identical to
// parseWriteDecisions/isModuleWriteAvailable just because every OTHER module
// happens to agree on the two today.
describe('parseDeleteDecisions', () => {
  it('returns empty for a null/non-object/malformed body', () => {
    expect(parseDeleteDecisions(null)).toEqual({});
    expect(parseDeleteDecisions({ data: { deleteDecisions: 'not-an-object' } })).toEqual({});
    expect(parseDeleteDecisions({ data: { writeDecisions: { INCOME: 'ENABLED' } } })).toEqual({}); // reads its own field, not writeDecisions'
  });

  it('parses a well-formed deleteDecisions body, dropping invalid entries', () => {
    const parsed = parseDeleteDecisions({
      data: { deleteDecisions: { INCOME: 'UNAVAILABLE', SCORES: 'ENABLED', GOALS: 'bogus' } },
    });
    expect(parsed).toEqual({ INCOME: 'UNAVAILABLE', SCORES: 'ENABLED' });
  });

  it('a writeDecisions=ENABLED, deleteDecisions=UNAVAILABLE body for the same module is parsed as two independent, disagreeing decisions — the exact G5B Income/Expenses/Insurance shape', () => {
    const body = {
      data: {
        writeDecisions: { INCOME: 'ENABLED' },
        deleteDecisions: { INCOME: 'UNAVAILABLE' },
      },
    };
    expect(isModuleWriteAvailable('INCOME', parseWriteDecisions(body))).toBe(true);
    expect(isModuleDeleteAvailable('INCOME', parseDeleteDecisions(body))).toBe(false);
  });
});

describe('isModuleDeleteAvailable', () => {
  it('true only for ENABLED, false for any other value or an absent entry', () => {
    expect(isModuleDeleteAvailable('SCORES', { SCORES: 'ENABLED' })).toBe(true);
    expect(isModuleDeleteAvailable('INCOME', { INCOME: 'EXISTING_RECORD_ONLY' })).toBe(false);
    expect(isModuleDeleteAvailable('INCOME', { INCOME: 'UNAVAILABLE' })).toBe(false);
    expect(isModuleDeleteAvailable('INCOME', {})).toBe(false);
  });
});
