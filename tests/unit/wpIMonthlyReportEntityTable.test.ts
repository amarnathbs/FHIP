/**
 * Document2 (4) WP-I: the Monthly Report (and its PDF) entity table shows EXACTLY the numbers the Dashboard entity section shows, for all four entity kinds.
 *
 * AUDIT RESULT (recorded here): the Monthly Report, its print page (the PDF is that page printed by the headless renderer, app/(print)/reports/[id]/print)
 * and the Net Worth Statement do not compute entity figures. The report builder copies the Dashboard model (summary.netWorthLevels) into the Net Worth section
 * (sectionData.levels, stored as JSON) and ReportPreview renders it with the SAME component as the Dashboard (NetWorthLevelsPanel). This test drives the
 * REAL loaders (loadDashboard, the report source resolver, buildReportSections) and renders BOTH surfaces, the report from a JSON round trip of the stored
 * section, then compares the entity table cell for cell.
 *
 * HAND ORACLE (AUD), personal Savings 100,000:
 *   SMSF (itemised)    assets 503,000  liabilities 370,000  net 133,000  counted 133,000 (in full, the derived Detailed value, never the fund account row on top)
 *   Family Trust       assets 1,000,000 liabilities 400,000 net 600,000  counted 600,000 (in full)
 *   India HUF          assets 1,000,000 liabilities 400,000 net 600,000  counted 600,000 (in full)
 *   Company 40 percent assets 1,000,000 liabilities 750,000 net 250,000  counted 100,000 (ownership share)
 *   Family = 100,000 + 133,000 + 600,000 + 600,000 + 100,000 = 1,533,000.
 * EVIDENCE LABEL: UNIT-TESTED. Not DEV-verified. A PDF was not rendered by a browser here (NOT PERFORMED): the PDF is the same React tree, proven below.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('createClient() must not be called -- every test passes an explicit client.');
  },
}));
vi.mock('@/lib/services/healthScoreData', () => ({ loadHealthScore: vi.fn().mockRejectedValue(new Error('not under test')) }));
vi.mock('@/lib/services/resilienceData', () => ({ loadResilience: vi.fn().mockRejectedValue(new Error('not under test')) }));
vi.mock('@/lib/services/financialDnaData', () => ({ loadFinancialDna: vi.fn().mockRejectedValue(new Error('not under test')) }));
vi.mock('@/lib/services/goalsData', () => ({
  computeGoalsPagePayload: vi.fn().mockResolvedValue({
    payload: {
      goals: [],
      summary: { activeGoalsCount: 0, totalTargetAmount: 0, totalCurrentAmount: 0, overallProgressPct: 0, totalMonthlyContribution: 0, onTrackCount: 0, atRiskCount: 0, offTrackCount: 0, achievedCount: 0, nextGoalDue: null },
      affordability: { status: 'insufficient_data', monthlySurplus: null, totalPlannedGoalContributions: 0, unallocatedAmount: null, overallocatedAmount: null, usageRatio: null, warning: null },
      modelVersion: 'test',
      goalTypes: [],
    },
  }),
}));
vi.mock('@/lib/services/financialTwinService', () => ({ listTwinRuns: vi.fn().mockResolvedValue([]), getTwinRunDetail: vi.fn() }));
vi.mock('@/lib/services/recommendationsData', () => ({ buildReportActionMatches: vi.fn().mockResolvedValue([]) }));
vi.mock('@/lib/services/forecastReportData', () => ({ buildForecastReportData: vi.fn().mockRejectedValue(new Error('not under test')) }));
vi.mock('@/lib/services/investmentIntelligenceReportData', () => ({
  loadInvestmentPerformanceForReport: vi.fn().mockResolvedValue(null),
  loadSipForReport: vi.fn().mockResolvedValue(null),
  loadXrayForReport: vi.fn().mockResolvedValue(null),
  loadTaxForReport: vi.fn().mockResolvedValue(null),
  loadReviewItemsForReport: vi.fn().mockResolvedValue(null),
}));

import { loadDashboard } from '@/lib/services/dashboardData';
import { resolveReportSourceData, buildEligibilityInput } from '@/lib/services/reportSnapshotResolver';
import { buildReportSections } from '@/lib/engines/reportSections';
import { loadReportContent } from '@/lib/services/reportContentData';
import { NetWorthLevelsPanel } from '@/components/dashboard/NetWorthLevelsPanel';
import { ReportPreview } from '@/components/reports/ReportPreview';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { profile, tables, USER } from './readModels/helpers/fixtures';

const ROOT = path.resolve(__dirname, '..', '..');

function household(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  const entity = (id: string, type: string, name: string, pct: number): Row => ({
    id, user_id: USER, entity_type: type, name, country_code: 'AU', currency_code: 'AUD', ownership_percentage: pct,
    valuation_mode: 'detailed', summary_net_asset_value: null, is_active: true, created_at: '2026-01-01T00:00:00Z',
  });
  const asset = (id: string, eid: string, value: number): Row => ({ id, user_id: USER, business_entity_id: eid, label: 'Assets', value, currency_code: 'AUD', is_active: true });
  const liab = (id: string, eid: string, value: number): Row => ({ id, user_id: USER, business_entity_id: eid, label: 'Debts', value, currency_code: 'AUD', is_active: true });
  return tables(profile('AUD', 'AU', 56), {
    assets: [{ id: 'a1', user_id: USER, asset_name: 'Savings', asset_class: 'cash', current_value: 100_000, currency_code: 'AUD', owner: 'self', master_item_key: 'savings_account', source_type: 'manual', linked_liability_id: null, country_code: 'AU', is_active: true }],
    retirement_accounts: [{ id: 'r-fund', user_id: USER, account_name: 'PO SMSF', account_type: 'super', current_balance: 133_000, currency_code: 'AUD', owner: 'self', employer_contribution: 0, personal_contribution: 0, contribution_frequency: 'monthly', source_type: 'manual', retirement_member_id: null, country_code: 'AU', target_retirement_age: null, master_item_key: 'smsf', is_active: true }],
    smsf_funds: [{ id: 'f', user_id: USER, fund_name: 'PO SMSF', retirement_account_id: 'r-fund', mode: 'detailed', summary_balance: null, currency_code: 'AUD', is_active: true }],
    smsf_holdings: [{ id: 'h1', user_id: USER, smsf_fund_id: 'f', holding_name: 'Property and cash', holding_type: 'residential_property', value: 503_000, currency_code: 'AUD', is_active: true }],
    smsf_liabilities: [{ id: 'sl1', user_id: USER, smsf_fund_id: 'f', liability_name: 'LRBA', liability_type: 'property_loan', lender: 'Bank', balance: 370_000, currency_code: 'AUD', is_active: true }],
    business_entities: [
      entity('tr', 'family_trust', 'Smith Family Trust', 100),
      entity('hu', 'huf', 'Smith HUF', 100),
      entity('co', 'company', 'Smith Pty Ltd', 40),
    ],
    business_entity_assets: [asset('ta', 'tr', 1_000_000), asset('ha', 'hu', 1_000_000), asset('ca', 'co', 1_000_000)],
    business_entity_liabilities: [liab('tl', 'tr', 400_000), liab('hl', 'hu', 400_000), liab('cl', 'co', 750_000)],
  }, extra);
}

const rowsOf = (html: string): string[] =>
  [...html.matchAll(/<tr[^>]*data-testid="net-worth-entity-row"[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
const familyLines = (html: string): string[] => {
  const section = html.slice(html.indexOf('Family net worth (consolidated)'));
  return [...section.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].slice(0, 8).map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
};

async function surfaces(t: Record<string, Row[]>) {
  const { client } = makeFakeSupabase(tables(t, { user_entitlements: [{ user_id: USER, plan_tier: 'premium' }] }));
  const dashboard = await loadDashboard(USER, client as never);
  const source = await resolveReportSourceData(USER, undefined, client as never);
  const built = buildReportSections(source, buildEligibilityInput(source), false);
  // The report is STORED as JSON and read back before it is shown or printed.
  const stored = JSON.parse(JSON.stringify(built)) as typeof built;
  const content = await loadReportContent('en', client as never);
  const report = { id: 'r1', user_id: USER, report_type_code: 'monthly', report_month: '2026-09-01', as_of_date: '2026-09-30', title: 'Report', status: 'generated', version_number: 1, revises_report_id: null, reporting_currency: 'AUD', country_scope: 'household' };
  const reportHtml = renderToStaticMarkup(h(ReportPreview, { report: report as never, sections: stored as never, currency: 'AUD', content }));
  const dashboardHtml = renderToStaticMarkup(h(NetWorthLevelsPanel, { levels: dashboard.netWorthLevels! }));
  return { dashboard, reportHtml, dashboardHtml, stored };
}

describe('Monthly Report entity table = Dashboard entity section (SMSF, Company, Trust, HUF)', () => {
  it('the Dashboard model has the hand-computed figures for all four kinds', async () => {
    const { dashboard } = await surfaces(household());
    const l = dashboard.netWorthLevels!;
    const block = (kind: string) => l.entities.blocks.find((b) => b.kind === kind)!;
    expect(block('smsf').entityTotals).toMatchObject({ totalAssets: 503_000, liabilities: 370_000, net: 133_000 });
    expect(block('smsf').included.net).toBe(133_000);
    expect(block('family_trust').entityTotals).toMatchObject({ totalAssets: 1_000_000, liabilities: 400_000, net: 600_000 });
    expect(block('family_trust').included.net).toBe(600_000);
    expect(block('huf').included.net).toBe(600_000);
    expect(block('company').entityTotals.net).toBe(250_000);
    expect(block('company').included.net).toBe(100_000);
    expect(l.personal.total.net).toBe(100_000);
    expect(l.family.net).toBe(1_533_000);
  });

  it('the report entity table is identical to the Dashboard entity table, row for row and cell for cell', async () => {
    const { reportHtml, dashboardHtml } = await surfaces(household());
    const onDashboard = rowsOf(dashboardHtml);
    const inReport = rowsOf(reportHtml);
    expect(onDashboard).toHaveLength(4);
    expect(inReport).toEqual(onDashboard);
    const joined = inReport.join(' | ');
    expect(joined).toContain('$503,000');
    expect(joined).toContain('$370,000');
    expect(joined).toContain('$133,000');
    expect(joined).toContain('$1,000,000');
    expect(joined).toContain('$400,000');
    expect(joined).toContain('$600,000');
    expect(joined).toContain('$750,000');
    expect(joined).toContain('$250,000');
    expect(joined).toContain('$100,000'); // the company's 40 percent share
  });

  it('the family reconciliation lines agree exactly (individual first, then each entity kind, then family 1,533,000)', async () => {
    const { reportHtml, dashboardHtml } = await surfaces(household());
    const d = familyLines(dashboardHtml);
    expect(familyLines(reportHtml)).toEqual(d);
    expect(d.join(' ')).toContain('$1,533,000');
  });

  it('the stored section carries the Dashboard model unchanged, and a JSON round trip loses nothing the table needs', async () => {
    const { dashboard, stored } = await surfaces(household());
    const nw = stored.find((s) => s.sectionCode === 'net_worth')!;
    const data = nw.sectionData as { levels: unknown; familyNetWorth: number };
    expect(data.levels).toEqual(JSON.parse(JSON.stringify(dashboard.netWorthLevels)));
    expect(data.familyNetWorth).toBe(1_533_000);
  });

  it('a net value only entity reads the same on both surfaces ("Recorded as a net value only", never invented assets)', async () => {
    const t = household();
    t.business_entities = t.business_entities.map((e) => (e.id === 'co' ? { ...e, valuation_mode: 'summary', summary_net_asset_value: 250_000 } : e));
    t.business_entity_assets = t.business_entity_assets.filter((a) => a.business_entity_id !== 'co');
    t.business_entity_liabilities = t.business_entity_liabilities.filter((a) => a.business_entity_id !== 'co');
    const { reportHtml, dashboardHtml } = await surfaces(t);
    const dashRows = rowsOf(dashboardHtml);
    expect(rowsOf(reportHtml)).toEqual(dashRows);
    const company = dashRows.find((r) => r.includes('Smith Pty Ltd'))!;
    expect(company).toContain('Recorded as a net value only');
    expect(company).toContain('$250,000');
    expect(company).toContain('$100,000');
  });

  it('NEGATIVE CONTROL: a report that disagrees with the Dashboard (a stale stored section) is detected by the same comparison', async () => {
    const { reportHtml, dashboardHtml, stored } = await surfaces(household());
    const stale = JSON.parse(JSON.stringify(stored)) as typeof stored;
    const levels = (stale.find((s) => s.sectionCode === 'net_worth')!.sectionData as { levels: { entities: { blocks: { kind: string; included: { net: number } }[] } } }).levels;
    levels.entities.blocks.find((b) => b.kind === 'company')!.included.net = 250_000; // the company wrongly counted in full
    const { client } = makeFakeSupabase(tables(household(), { user_entitlements: [{ user_id: USER, plan_tier: 'premium' }] }));
    const content = await loadReportContent('en', client as never);
    const staleHtml = renderToStaticMarkup(h(ReportPreview, { report: { id: 'r1', report_month: '2026-09-01', as_of_date: '2026-09-30' } as never, sections: stale as never, currency: 'AUD', content }));
    expect(rowsOf(staleHtml)).not.toEqual(rowsOf(dashboardHtml));
    expect(rowsOf(reportHtml)).toEqual(rowsOf(dashboardHtml));
  });

  it('the PDF is the same tree: the print page renders ReportPreview, and the report preview renders the shared Dashboard panel with the stored levels', () => {
    const print = fs.readFileSync(path.join(ROOT, 'app/(print)/reports/[id]/print/page.tsx'), 'utf8');
    expect(print).toContain('<ReportPreview');
    expect(print).toContain('sections={result.sections}');
    const preview = fs.readFileSync(path.join(ROOT, 'components/reports/ReportPreview.tsx'), 'utf8');
    expect(preview).toContain("import { NetWorthLevelsPanel }");
    expect(preview).toContain('<NetWorthLevelsPanel levels={nwLevels} />');
    expect(preview).toContain("netWorth?.sectionData?.levels");
    const builder = fs.readFileSync(path.join(ROOT, 'lib/engines/reportSections.ts'), 'utf8');
    expect(builder).toContain('levels: d.netWorthLevels ?? null');
  });
});
