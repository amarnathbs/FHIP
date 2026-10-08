// Browser entry for scripts/a11y/dataTableCheck.mjs: the REAL components that render the tables named in the Product Owner's
// 08-10-2026 table complaint, inside the same width constraints as the Admin / user shell, with fetch answered from fixtures.
// No dev server, login or database: nothing here can touch DEV or production.
import React from 'react';
import { createRoot } from 'react-dom/client';
import JobsTab from '@/components/admin/benchmarkData/JobsTab';
import EntitlementsTab from '@/components/admin/benchmarkData/EntitlementsTab';
import MappingsTab from '@/components/admin/benchmarkData/MappingsTab';
import { PromoCodesClient } from '@/components/admin/PromoCodesClient';
import { ReportHistoryTable } from '@/components/reports/ReportHistoryTable';
import { HoldingsTable } from '@/components/investment-intelligence/HoldingsTable';
import { buildHeldSchemeRows } from '@/lib/services/investment-intelligence/benchmarkData/heldSchemes';

const fx = window.__FIXTURE__;
const caps = { view: true, upload: true, publish: true, correct: true, catalogue: true, entitlementApprove: true };

const jobs = [
  ['published', 'New history', 'NIFTY_50_TRI_2024_2026_full_history_export_final_v3.xlsx', ['NIFTY 50 TRI', 'S&P BSE SENSEX TRI'], 5230, 5230, 0, '2026-10-08T02:37:00.000Z', '2026-10-08T02:41:00.000Z', true, true],
  ['validated', 'New history', 'sensex_daily_levels.csv', ['S&P BSE SENSEX'], 120, 120, 0, '2026-10-07T09:10:00.000Z', null, true, false],
  ['published', 'Correction', 'nifty_midcap_150_corrections_2026-09.csv', ['NIFTY MIDCAP 150 TRI'], 14, 0, 14, '2026-10-06T04:00:00.000Z', '2026-10-06T04:30:00.000Z', false, false],
  ['failed', 'New history', 'a_really_long_file_name_without_any_spaces_that_would_never_break_nicely_20261001.xlsx', ['NIFTY 50', 'NIFTY NEXT 50', 'NIFTY 100', 'NIFTY 500'], 0, 0, 0, '2026-10-01T11:00:00.000Z', null, false, false],
  ['rolled_back', 'New history', 'bse500.csv', ['S&P BSE 500 TRI'], 4300, 4300, 0, '2026-09-30T01:00:00.000Z', '2026-09-30T01:05:00.000Z', false, false],
].map((r, i) => ({
  id: `0a1b2c3d-${i}000-4000-8000-000000000000`, status: r[0], mode: r[1] === 'Correction' ? 'correction' : 'new', shape: 'wide', fileName: r[2], fileFormat: 'xlsx', fileSha256: 'x', benchmarkKeys: r[3],
  returnVariant: 'total_return', currencyCode: 'INR', historyClass: 'live', rowsTotal: r[4], rowsNew: r[5], rowsIdentical: 0, rowsCorrection: r[6], rowsRevive: 0, hardErrorTotal: 0, warningCount: 0, requiredAcks: [], eligible: true,
  stagedAt: r[7], validatedAt: null, publishedAt: r[8], stagedByMe: r[9], publishedByMe: r[9] && !!r[8], selfPublished: r[10],
}));

const catRow = (key, label) => ({
  catalogue: { id: key, benchmarkKey: key, label, officialName: label, ownerName: null, officialIdentifier: null, assetClass: 'equity', returnType: 'total_return', returnVariant: 'total_return', currencyCode: 'INR', countryCode: 'IN', baseDate: null, launchDate: null, historyStartDate: null, historyClass: 'live', backtestedThrough: null, methodologyUrl: null, sourceUrl: null, evidenceRef: null, evidenceRetrievedAt: null },
  coverage: {}, ingestion: null, demand: null, dataState: 'current', pending: null,
  entitlements: [
    { entitlementId: 'a1b2c3d4-aaaa', kind: 'public_use_permission', status: 'approved', rights: { ingestManual: true, automation: false, storage: true, calculation: true, customerDisplay: true, reportExport: false }, dataFrom: null, dataTo: null, validFrom: '2026-10-06', validTo: '2036-10-05', postExpiryStorage: 'retain', evidenceReference: 'NSE Indices written permission, reference NSE-IDX-2026-10-0042, signed by the Head of Index Licensing', evidenceUrl: 'https://www.example.test/permission.pdf', proposedByMe: false, approvedAt: '2026-10-06T00:00:00.000Z' },
    { entitlementId: 'b2c3d4e5-bbbb', kind: 'commercial_licence', status: 'draft', rights: { ingestManual: true, automation: true, storage: true, calculation: true, customerDisplay: true, reportExport: true }, dataFrom: '2010-04-01', dataTo: null, validFrom: '2026-10-08', validTo: null, postExpiryStorage: 'delete', evidenceReference: 'Draft licence', evidenceUrl: null, proposedByMe: true, approvedAt: null },
    { entitlementId: 'c3d4e5f6-cccc', kind: 'public_use_permission', status: 'revoked', rights: { ingestManual: false, automation: false, storage: false, calculation: false, customerDisplay: false, reportExport: false }, dataFrom: '2000-01-03', dataTo: '2025-12-31', validFrom: '2025-01-01', validTo: '2025-12-31', postExpiryStorage: 'unknown', evidenceReference: 'Old', evidenceUrl: null, proposedByMe: false, approvedAt: '2025-01-01T00:00:00.000Z' },
  ],
});
const ov = { state: 'ok', capabilities: caps, rows: [catRow('nifty_50_tri', 'NIFTY 50 TRI'), catRow('sensex_tri', 'S&P BSE SENSEX TRI')] };

const promoRows = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, code: `ABCDEFGH${i}JKLMNP`, code_hint: 'ABCD', duration_days: 30 + i, max_redemptions: i % 2 ? null : 10, redemption_count: i, expires_on: '2026-12-31', note: i % 2 ? 'Founding members cohort, October 2026 launch event, handed out by the partnerships team at the Sydney meetup' : null, status: 'active', state: i === 5 ? 'expired' : 'active', created_at: '2026-10-01T00:00:00.000Z', created_by_email: 'admin@example.test', bound: i % 3 === 0 }));
const promoEvents = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, created_at: '2026-10-0' + (i + 1) + 'T03:04:00.000Z', event_type: i % 2 ? 'redeem' : 'create', actor_email: 'someone.with.a.very.long.email.address@example.test', code_hint: 'ABCD', reason: i === 1 ? 'Disabled because the code was shared outside the intended cohort' : null }));

const reports = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, report_type_code: ['monthly_financial_health', 'net_worth', 'goal_progress'][i % 3], report_month: `2026-0${i + 4}-01`, generated_at: `2026-0${i + 4}-02T01:00:00.000Z`, status: ['ready', 'published', 'revised', 'failed', 'draft'][i], version_number: i + 1 }));

const holdings = Array.from({ length: 6 }, (_, i) => ({
  accountId: `a${i}`, instrumentId: `i${i}`, folioNumber: `1234567${i}/0${i}`, isin: `INF179K01${i}34`, schemeCode: `10317${i}`, schemeName: `H44-HDFC Large Cap Fund - Regular Plan - Growth (formerly HDFC Top 100 Fund) ${i}`, registrar: 'CAMS', costValue: 125000.5 * (i + 1), unitBalance: 812.345 * (i + 1), navDate: '2026-10-07', nav: 123.4567, marketValue: 160000.25 * (i + 1), gainLoss: 35000 * (i + 1), returnPct: 0.2812, xirr: { status: 'CALCULATED', value: { rate: 0.1534 } }, currencyCode: 'INR',
  valuationBasis: 'market_nav', dataQuality: { status: i === 2 ? 'unresolved' : 'ok', detail: null }, sourceDocumentId: i === 2 ? 'doc1' : null, benchmark: { status: 'CALCULATED' },
}));

const inventory = fx.inventory ?? [];
const held = buildHeldSchemeRows(inventory.map((r, i) => ({ instrumentId: r.instrument_id, instrumentName: r.instrument_name, amcName: r.amc_name, amfiSchemeCode: r.amfi_scheme_code, subCategory: r.sub_category, categoryHeaderRaw: r.category_header_raw, holderCount: i % 3 === 0 ? null : 12 + i, firstHeldDate: i % 3 === 0 ? null : r.first_transaction_date, schemeMasterName: r.scheme_name, mapped: false, proposalWaiting: false })));
const sources = ['approved', 'approved', 'not_reviewed', 'not_reviewed', 'declined', 'not_reviewed'].map((st, i) => ({ id: `src-${i}`, sourceKey: `hdfc_mutual_fund_factsheet_monthly_${i}`, amcName: ['HDFC Mutual Fund', 'SBI Mutual Fund', 'Axis Mutual Fund', 'ICICI Prudential Mutual Fund', 'Nippon India Mutual Fund'][i % 5], documentType: 'amc_factsheet', url: 'https://www.example.test/factsheets/monthly.pdf', host: 'www.example.test', amfiSchemeCodes: i % 2 ? ['103174', '118989'] : [], termsReviewStatus: st, termsReviewedAt: st === 'approved' ? '2026-10-05T09:00:00.000Z' : null, termsReviewNote: st === 'approved' ? 'Terms reviewed by the Product Owner.' : null, enabled: true, lastResult: null }));

const routes = [
  [/\/jobs/, jobs],
  [/\/mappings\/held/, held],
  [/\/mappings\/unmapped/, { totalSchemeRows: 0, mappedRows: 0, unmappedRows: 0, byCategory: [] }],
  [/\/factsheet\/changes/, { state: 'ok', items: [], readerSwitchedOn: false }],
  [/\/factsheet\/sources/, { state: 'ok', sources }],
  [/\/mappings(\?|$)/, []],
  [/\/promo-codes\/events/, promoEvents],
  [/\/promo-codes/, promoRows],
  [/\/investment-intelligence\/holdings/, { holdings, warnings: [], empty: false }],
];
window.fetch = async (url) => {
  const hit = routes.find(([re]) => re.test(String(url)));
  return new Response(JSON.stringify(hit ? { data: hit[1] } : { error: 'no fixture' }), { status: hit ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
};

function Page() {
  switch (fx.page) {
    case 'jobs': return <JobsTab caps={caps} refreshKey={0} onChanged={() => {}} say={() => {}} />;
    case 'entitlements': return <EntitlementsTab ov={ov} onChanged={() => {}} say={() => {}} />;
    case 'mappings': return <MappingsTab ov={ov} refreshKey={0} onChanged={() => {}} say={() => {}} />;
    case 'promo': return <PromoCodesClient />;
    case 'reports': return <ReportHistoryTable reports={reports} currency="INR" />;
    case 'holdings': return <HoldingsTable />;
    default: return null;
  }
}

// Same width constraints as the real shells: components/ui/AppShell.tsx (sidebar 248px from lg, main px-4 lg:px-8, content max 1480px)
// and the Admin client wrapper (max-w-6xl px-4).
function Shell() {
  return (
    <div style={{ background: '#F5F7FA', minHeight: '100vh' }}>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col bg-nav lg:flex" aria-label="Sidebar stand-in" />
      <main className="px-4 py-8 lg:ml-[248px] lg:px-8">
        <div className="mx-auto max-w-[1480px]">
          <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
            <h1 className="text-2xl font-semibold text-ink">{fx.title}</h1>
            <Page />
          </div>
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')).render(<Shell />);
