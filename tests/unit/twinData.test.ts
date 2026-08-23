import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Financial Twin phantom-balance regression guard.
//
// lib/engines/dashboard.ts's computeDashboard already excludes Class-F
// contribution-type retirement_accounts rows from totalRetirement
// (isRetirementContributionRow — tests/unit/dashboard.test.ts), but ONLY
// when each row carries master_item_key. twinData.ts's loadDashboardForTwin
// builds its own copy of the dashboard summary by calling computeDashboard
// directly (reusing the same engine, per this file's own top-of-function
// comment) — but its retirement_accounts query never selected
// master_item_key, so every row silently looked like a real balance to
// computeDashboard regardless of type. The exact same query in
// dashboardData.ts's loadDashboard (the canonical Dashboard page) already
// selected it correctly — the Financial Twin's copy had fallen out of sync
// and was double-counting contribution rows dashboard.ts had already fixed
// for the main Dashboard.
//
// This sandbox has no live Supabase/DB access (same disclosed limitation as
// tests/unit/chunk3aSchemaRls.test.ts), so the fix can't be exercised via a
// real loadTwinSourceData() call against seeded data. What CAN be verified
// directly against the source text is the actual root cause and its fix:
// the retirement_accounts select string that feeds computeDashboard must
// include master_item_key, and must stay in sync with dashboardData.ts's
// own select for the same table/columns so the two can never drift apart
// again the way they did here.

const SERVICES_DIR = join(__dirname, '..', '..', 'lib', 'services');
const twinDataSource = readFileSync(join(SERVICES_DIR, 'twinData.ts'), 'utf8');
const dashboardDataSource = readFileSync(join(SERVICES_DIR, 'dashboardData.ts'), 'utf8');

// Isolates the loadDashboardForTwin function body so a master_item_key
// present only in the OTHER retirement_accounts query in this file (the
// rawRetirement one used for target_retirement_age) can't accidentally
// satisfy this assertion.
function extractFunctionBody(source: string, functionName: string): string {
  const startMatch = source.match(new RegExp(`function ${functionName}\\b[^{]*{`));
  expect(startMatch, `expected to find "function ${functionName}" in the source`).not.toBeNull();
  const start = startMatch!.index! + startMatch![0].length;
  let depth = 1;
  let i = start;
  while (depth > 0 && i < source.length) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    i++;
  }
  return source.slice(start, i);
}

describe('twinData.ts loadDashboardForTwin retirement_accounts select (Financial Twin phantom-balance fix)', () => {
  it('selects master_item_key on the retirement_accounts query that feeds computeDashboard', () => {
    const body = extractFunctionBody(twinDataSource, 'loadDashboardForTwin');
    const selectMatch = body.match(/from\('retirement_accounts'\)\.select\('([^']+)'\)/);
    expect(selectMatch, 'expected a retirement_accounts select in loadDashboardForTwin').not.toBeNull();
    const columns = selectMatch![1].split(',').map((c) => c.trim());
    expect(columns).toContain('master_item_key');
  });

  it('selects the same retirement_accounts column set as dashboardData.ts\'s loadDashboard, so the Twin\'s copy can never silently drift from the canonical Dashboard again', () => {
    const twinBody = extractFunctionBody(twinDataSource, 'loadDashboardForTwin');
    const twinSelect = twinBody.match(/from\('retirement_accounts'\)\.select\('([^']+)'\)/);
    const dashboardSelect = dashboardDataSource.match(/\.from\('retirement_accounts'\)\s*\.select\('([^']+)'\)/);
    expect(twinSelect, 'expected a retirement_accounts select in twinData.ts loadDashboardForTwin').not.toBeNull();
    expect(dashboardSelect, 'expected a retirement_accounts select in dashboardData.ts').not.toBeNull();

    const twinColumns = new Set(twinSelect![1].split(',').map((c) => c.trim()));
    const dashboardColumns = new Set(dashboardSelect![1].split(',').map((c) => c.trim()));
    expect(twinColumns).toEqual(dashboardColumns);
  });
});
