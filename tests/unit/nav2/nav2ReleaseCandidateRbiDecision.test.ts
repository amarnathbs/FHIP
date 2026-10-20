// NAV2 release candidate, blocker B5: the Product Owner decision on RBI (restated 14-10-2026) is the only statement in the repository.
//
//   "Written RBI confirmation is not required by Product Owner decision. Historical manual loading and automated refresh are permitted subject to
//    technical validation, attribution, monitoring and the documented accepted reuse risk."
//
// No file may still say that the automated RBI refresh is blocked, forbidden or "pending" on a written confirmation from RBI. The weekly job stays OFF
// until its final-build dry run passes: that is a technical activation gate and must be worded as one.
//
// NAMED NEGATIVE CONTROLS
//   NC-B1  the scanner bites: each old sentence the Stage 3 pack carried is flagged;
//   NC-B2  no tracked source, document, SQL file or UI string in the NAV2 areas carries a "blocked on RBI's written confirmation" statement;
//   NC-B3  the decision wording is present in the production README, the release plan and the provenance note;
//   NC-B4  the operator attestation no longer promises that the app does not scrape;
//   NC-B5  the weekly switch file and the README keep the technical gate (dry run first).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RISK_FREE_ATTESTATION_TEXT } from '@/lib/services/investment-intelligence/nav2/riskFreeUploadService';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OLD_STATEMENTS: RegExp[] = [
  /(blocked|stays blocked|remains blocked)[^.\n]{0,60}(written|RBI confirm|RBI['’]s written|confirms? (reuse )?in writing)/i,
  /until RBI (has )?(confirm|gives|replies|answers)/i,
  /only after RBI (gives|confirms|replies)/i,
  /(do not|don't|must not) automate retrieval of rbi/i,
  /pending written (confirmation|permission)/i,
  /(app|fund analytics|fhip) (does|will) not scrape/i,
  /no scraping by the app/i,
  /written (RBI )?(confirmation|permission)[^.\n]{0,40}(pending|awaited|outstanding|not received)/i,
  /ask RBI in writing/i,
];
export function findOldStatements(text: string): string[] {
  return OLD_STATEMENTS.filter((r) => r.test(text)).map((r) => r.source);
}
const tracked = (): string[] => {
  const out = execFileSync('git', ['ls-files', 'lib/services/investment-intelligence/nav2', 'lib/config/nav2', 'lib/engines/nav2', 'app/api/admin/investment-intelligence/risk-free-data', 'app/api/admin/investment-intelligence/nav2-monitoring', 'app/api/investment-intelligence/cron/nav2-risk-free-refresh', 'components/admin', 'docs/nav2', 'supabase/migrations/0260_nav2_risk_free_governed_dataset.sql', 'supabase/migrations/0263_nav2_risk_free_refresh_attempts.sql', 'scripts/nav2_rc', 'scripts/nav2_stage3'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
  return out.split('\n').filter((f) => /\.(ts|tsx|md|sql|mjs)$/.test(f));
};
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');
/** The Stage 3 report is a dated historical record of what was true on 06-10-2026. This file defines the patterns, so it is excluded from its own scan. */
const EXEMPT = new Set(['docs/nav2/NAV2_STAGE3_CERTIFICATION_REPORT.md', 'tests/unit/nav2/nav2ReleaseCandidateRbiDecision.test.ts']);

describe('NC-B1: the scanner bites', () => {
  it('flags each old sentence', () => {
    for (const bad of [
      'Stage D, weekly RBI refresh: **blocked** until RBI confirms reuse in writing',
      'the weekly RBI refresh stays blocked on RBI written confirmation',
      '-- LATER STAGE (not at release, and only after RBI gives written permission).',
      'Do not automate retrieval of rbi.org.in from FHIP code',
      'Terms status: pending written confirmation from RBI',
      '(attribution kept, no scraping by the app)',
      'ask RBI in writing',
      'Status of that written confirmation: not received as of 03-10-2026.',
    ]) expect(findOldStatements(bad), bad).not.toEqual([]);
  });
  it('does not flag the new decision or ordinary technical blocking by the source', () => {
    for (const fine of [
      'Written RBI confirmation is not required by Product Owner decision. Historical manual loading and automated refresh are permitted subject to technical validation, attribution, monitoring and the documented accepted reuse risk.',
      'RBI is blocking the weekly read: the run stopped without trying to get round it.',
      'blocked_by_source: RBI refused a content page',
    ]) expect(findOldStatements(fine), fine).toEqual([]);
  });
});

describe('NC-B2: nothing in the repository says the automated refresh waits for RBI', () => {
  it('scans every tracked NAV2 file', () => {
    const hits: string[] = [];
    for (const f of tracked()) {
      if (EXEMPT.has(f)) continue;
      const found = findOldStatements(read(f));
      if (found.length) hits.push(`${f}: ${found.join(' | ')}`);
    }
    expect(hits).toEqual([]);
  }, 300_000);
});

describe('NC-B3 / NC-B4 / NC-B5: the decision is stated, and the gate is technical', () => {
  const DECISION = 'Written RBI confirmation is not required by Product Owner decision.';
  it('the production README, the provenance note and the dependency register carry the decision', () => {
    expect(read('docs/nav2/po_apply_production/README.md')).toContain(DECISION);
    expect(read('docs/nav2/risk_free_first_load/RISK_FREE_FIRST_LOAD_PROVENANCE.md')).toContain(DECISION);
    expect(read('docs/nav2/NAV2_BENCHMARK_AND_RISK_FREE_DEPENDENCY_REGISTER.md')).toMatch(/written RBI confirmation is not required/i);
    expect(read('docs/nav2/NAV2_PRODUCTION_RELEASE_PLAN.md')).toMatch(/written RBI confirmation is not required/i);
  });
  it('the series configuration records the accepted risk and that written confirmation is not required', () => {
    const cfg = read('lib/config/nav2/riskFreeSeriesConfig.ts');
    expect(cfg).toContain('written confirmation from RBI is NOT required');
    expect(cfg).toContain('po_accepted_2026-10-03');
  });
  it('the attestation the operator accepts names the accepted reuse risk and does not promise that the app never scrapes', () => {
    expect(RISK_FREE_ATTESTATION_TEXT).toContain('reuse risk accepted');
    expect(RISK_FREE_ATTESTATION_TEXT.toLowerCase()).not.toContain('scrap');
    expect(RISK_FREE_ATTESTATION_TEXT.length).toBeGreaterThanOrEqual(20); // the database requires at least 20 characters
  });
  it('the weekly switch file and the README keep the TECHNICAL gate: the final-build dry run, with the switch OFF until it passes', () => {
    const sw = read('docs/nav2/po_apply_production/sql/switches/switch_on_weekly_refresh.sql');
    expect(sw).toMatch(/final-build dry run/);
    expect(sw).toMatch(/not required by Product Owner decision/);
    const readme = read('docs/nav2/po_apply_production/README.md');
    expect(readme).toMatch(/technical activation gate, not a permission gate/);
    expect(readme).toMatch(/dry run first/);
  });
});
