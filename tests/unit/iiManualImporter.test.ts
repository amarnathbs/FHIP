import { describe, it, expect } from 'vitest';
import { computeFixtureChecksum } from '@/lib/services/investment-intelligence/manualImporter';
import { iiManualFixtureSchema } from '@/lib/validation/investment-intelligence';
import singleFundFixture from '@/lib/fixtures/investment-intelligence/01-single-fund-cas.json';
import multiFundFixture from '@/lib/fixtures/investment-intelligence/02-multi-fund-cas-second-scheme.json';

// PROV-008 / ADR-003 testing implications: re-parsing an unchanged document
// must be idempotent (deterministic checksum), and two genuinely different
// documents must never collide.
describe('computeFixtureChecksum (manual test importer idempotency)', () => {
  it('is deterministic — the same fixture content always hashes the same', () => {
    const fixture = iiManualFixtureSchema.parse(singleFundFixture);
    expect(computeFixtureChecksum(fixture)).toBe(computeFixtureChecksum(fixture));
    expect(computeFixtureChecksum(JSON.parse(JSON.stringify(fixture)))).toBe(computeFixtureChecksum(fixture));
  });

  it('produces different checksums for two genuinely different fixtures', () => {
    const a = iiManualFixtureSchema.parse(singleFundFixture);
    const b = iiManualFixtureSchema.parse(multiFundFixture);
    expect(computeFixtureChecksum(a)).not.toBe(computeFixtureChecksum(b));
  });

  it('changes the checksum when any transaction data changes (not just the top-level fixtureKey)', () => {
    const fixture = iiManualFixtureSchema.parse(singleFundFixture);
    const mutated = { ...fixture, holdingSnapshot: { ...fixture.holdingSnapshot, value: fixture.holdingSnapshot.value + 1 } };
    expect(computeFixtureChecksum(mutated)).not.toBe(computeFixtureChecksum(fixture));
  });
});

describe('all six R1_IMPLEMENTATION_SPEC.md section 12 fixtures parse against the schema', () => {
  it('validates every required scenario fixture', async () => {
    const fixtureModules = await Promise.all([
      import('@/lib/fixtures/investment-intelligence/01-single-fund-cas.json'),
      import('@/lib/fixtures/investment-intelligence/02-multi-fund-cas-second-scheme.json'),
      import('@/lib/fixtures/investment-intelligence/03-refreshed-statement.json'),
      import('@/lib/fixtures/investment-intelligence/04-discrepant-reconciliation.json'),
      import('@/lib/fixtures/investment-intelligence/05-nps-account.json'),
      import('@/lib/fixtures/investment-intelligence/06-term-deposit.json'),
      import('@/lib/fixtures/investment-intelligence/07-household-b-independent.json'),
    ]);
    for (const mod of fixtureModules) {
      expect(() => iiManualFixtureSchema.parse(mod.default)).not.toThrow();
    }
  });

  it('the refreshed-statement fixture correctly declares which prior fixture it supersedes (scenario 11)', async () => {
    const refreshed = iiManualFixtureSchema.parse((await import('@/lib/fixtures/investment-intelligence/03-refreshed-statement.json')).default);
    expect(refreshed.supersedesFixtureKey).toBe('01-single-fund-cas');
  });

  it('the discrepant-reconciliation fixture carries a reconciliation block (scenario 12 / R0_SOURCE_PROVENANCE_CONTRACT.md section 2)', async () => {
    const discrepant = iiManualFixtureSchema.parse((await import('@/lib/fixtures/investment-intelligence/04-discrepant-reconciliation.json')).default);
    expect(discrepant.reconciliation).not.toBeNull();
    expect(discrepant.holdingSnapshot.qualityStatus).toBe('warning'); // never auto-certified while disputed
  });

  it('the NPS fixture routes to a retirement-type account, not investments (scenario 6)', async () => {
    const nps = iiManualFixtureSchema.parse((await import('@/lib/fixtures/investment-intelligence/05-nps-account.json')).default);
    expect(nps.account.accountType).toBe('retirement');
  });

  it('the term-deposit fixture uses the fixed_deposit instrument class (scenario 7)', async () => {
    const termDeposit = iiManualFixtureSchema.parse((await import('@/lib/fixtures/investment-intelligence/06-term-deposit.json')).default);
    expect(termDeposit.instrument.instrumentClass).toBe('fixed_deposit');
  });

  it('household A and household B fixtures use disjoint institutions/instruments (security-isolation test data, spec section 29)', async () => {
    const householdA = iiManualFixtureSchema.parse(singleFundFixture);
    const householdB = iiManualFixtureSchema.parse((await import('@/lib/fixtures/investment-intelligence/07-household-b-independent.json')).default);
    expect(householdA.account.institutionName).not.toBe(householdB.account.institutionName);
    expect(householdA.instrument.instrumentName).not.toBe(householdB.instrument.instrumentName);
  });
});
