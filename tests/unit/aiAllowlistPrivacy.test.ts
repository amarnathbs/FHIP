import { describe, it, expect } from 'vitest';
import { scanForBannedFields, assertAllowlisted } from '@/lib/ai/context/allowlist';

// A realistic-shaped context fragment with only allowlisted fields — proves
// the scanner does NOT false-positive on a normal, compliant payload (spec
// section 58: "inspect the generated context and prove... unnecessary PII
// are absent" needs a passing case, not just a catching case).
const CLEAN_CONTEXT_FRAGMENT = {
  meta: {
    context_version: 'ai-context-1.0.0',
    reporting_currency: 'AUD',
    country_of_residence: 'AU',
    certification_status: 'CERTIFIED',
  },
  household: {
    household_type: 'family',
    number_of_adults: 2,
    number_of_dependants: 1,
    employment_status_summary: 'employed_full_time',
  },
  cash_flow: {
    monthly_gross_income: 12000,
    monthly_net_income: 9500,
    savings_rate: 0.22,
  },
  goals: [{ goal_reference: 'a1b2c3d4-0000-0000-0000-000000000000', goal_type: 'retirement', target_amount: 500000 }],
};

describe('Module 11.0 privacy allowlist (spec sections 4, 12, 35, 58)', () => {
  it('passes a clean, allowlisted-only context with zero violations', () => {
    expect(scanForBannedFields(CLEAN_CONTEXT_FRAGMENT)).toEqual([]);
    expect(() => assertAllowlisted(CLEAN_CONTEXT_FRAGMENT)).not.toThrow();
  });

  it.each([
    ['password', { user: { password: 'hunter2' } }],
    ['service-role key', { config: { service_role_key: 'sb-service-key' } }],
    ['auth token', { session: { auth_token: 'abc.def.ghi' } }],
    ['api key', { provider: { api_key: 'sk-abcdefghijklmnop' } }],
    ['SSN', { profile: { ssn: '123-45-6789' } }],
    ['passport number', { profile: { passport_number: 'X1234567' } }],
    ['card number', { payment: { card_number: '4111111111111111' } }],
    ['street address', { household: { street_address: '123 Main St' } }],
    ['unnecessary email', { profile: { email: 'user@example.com' } }],
    ['phone number', { profile: { phone_number: '+61400000000' } }],
  ])('rejects a context containing a %s field', (_label, poisoned) => {
    const violations = scanForBannedFields(poisoned);
    expect(violations.length).toBeGreaterThan(0);
    expect(() => assertAllowlisted(poisoned)).toThrow();
  });

  it('rejects a raw OpenAI-style secret key value even under an innocuous key name', () => {
    const poisoned = { note: 'sk-abcdefghijklmnopqrstuvwx' };
    expect(scanForBannedFields(poisoned).length).toBeGreaterThan(0);
  });

  it('rejects a JWT-shaped value even under an innocuous key name', () => {
    const poisoned = { note: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U' };
    expect(scanForBannedFields(poisoned).length).toBeGreaterThan(0);
  });

  it('catches a banned field nested arbitrarily deep inside arrays/objects', () => {
    const poisoned = { a: [{ b: { c: [{ d: { auth_token: 'leaked' } }] } }] };
    expect(scanForBannedFields(poisoned).length).toBeGreaterThan(0);
  });

  it('is case/format-insensitive on key names (camelCase, snake_case, etc.)', () => {
    expect(scanForBannedFields({ serviceRoleKey: 'x' }).length).toBeGreaterThan(0);
    expect(scanForBannedFields({ SERVICE_ROLE_KEY: 'x' }).length).toBeGreaterThan(0);
  });
});
