/**
 * Document2 closure mission, finding #9 (2026-09-30) — AMC/Fund House
 * exposure must reconcile against real data, not silently show "Unmapped"
 * for every real position.
 *
 * BACKGROUND (confirmed live against DEV, twwpnltizhtjxhamyoxt-adjacent
 * project vqycarelcoijzwlpkpcz, 2026-09-30): `loadXrayDataset()` in
 * lib/services/investment-intelligence/r5Repository.ts hardcoded every
 * position's `amcId`/`amcName` to `null`, so `calculateAmcConcentration()`
 * (lib/engines/investment-intelligence/xray/concentration.ts) always saw
 * zero attributed value and returned `status: 'unavailable'` — the AMC
 * table AND the 84debc5 pie chart both silently never rendered for any real
 * user, independent of that UI commit. `ii_instruments.amc_name` is itself
 * unreliable (confirmed empty/null for every real production mutual-fund
 * instrument), but `ii_scheme_master` — the scheme-resolution engine's own
 * output, one current row per instrument via `effective_to is null`
 * (migration 0041/0191) — already carries a real AMC name for every real
 * DEV holding checked (Mirae Asset Mutual Fund, HDFC Mutual Fund, SBI
 * Mutual Fund).
 *
 * THE FIX (this pass): r5Repository.ts now additionally queries
 * `ii_scheme_master` (instrument_id, amc_name; effective_to is null) and
 * uses the resolved name as both `amcId` and `amcName` (there is no
 * separate AMC-entity id space in this schema, so the name itself is the
 * bucket key `calculateAmcConcentration()` groups on).
 *
 * THIS TEST is a deliberately blunt source-text guard (see
 * tests/unit/pc5Prohibitions.test.ts for the established style in this
 * repo) rather than a full mocked-Supabase behavioural test — loadXrayDataset
 * has a wide, multi-table dependency surface (fund-holdings snapshots,
 * benchmark series, direct-security synthesis) that a hand-rolled mock
 * would either have to fully replicate or risk masking with over-broad
 * stubs. It prevents a future edit from silently reintroducing the
 * null-hardcoding regression, and the live-DEV data-layer proof above
 * (independently reproduced, not merely asserted) covers correctness.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const FILE = join(process.cwd(), 'lib', 'services', 'investment-intelligence', 'r5Repository.ts');

describe('r5Repository.loadXrayDataset wires a real AMC/fund-house name onto every fund position', () => {
  const source = readFileSync(FILE, 'utf8');

  it('does not hardcode amcId/amcName to null', () => {
    expect(source).not.toMatch(/amcId:\s*null,\s*\n\s*amcName:\s*null,/);
  });

  it('queries ii_scheme_master for the current (effective_to is null) amc_name per instrument', () => {
    expect(source).toMatch(/from\(\s*['"]ii_scheme_master['"]\s*\)/);
    expect(source).toMatch(/is\(\s*['"]effective_to['"]\s*,\s*null\s*\)/);
  });

  it('resolves amcId/amcName from the scheme-master lookup, not a fixed literal', () => {
    expect(source).toMatch(/amcId:\s*amcNameByInstrument\.get\(/);
    expect(source).toMatch(/amcName:\s*amcNameByInstrument\.get\(/);
  });
});
