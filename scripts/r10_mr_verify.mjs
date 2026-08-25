// II-R10 terminal closure — final MR01-MR12 verdict table, computed
// against the already-generated report snapshot at
// pdf_pages/MR_report.json (see r10_manual_reconciliation.mjs for how it
// was seeded/generated). Expected values are independently derived from
// the known seed inputs baked into that script (arithmetic ground truth,
// not a re-read of the report's own numbers).
import fs from 'fs';
const j = JSON.parse(fs.readFileSync('C:/Users/user/AppData/Local/Temp/claude/D--FHIP/754236a6-648e-4039-9457-c73bef97d4a2/scratchpad/pdf_pages/MR_report.json', 'utf8'));
const byCode = Object.fromEntries(j.sections.map((s) => [s.sectionCode, s]));
const results = [];
function check(id, label, expected, actual, tol, note) {
  const ok = typeof expected === 'number' && typeof actual === 'number' ? Math.abs(expected - actual) <= tol : expected === actual;
  results.push({ id, label, expected, actual, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${label}: expected=${expected} actual=${actual}${note ? ' -- ' + note : ''}`);
}

const cf = byCode.cash_flow.sectionData;
check('MR01', 'Gross monthly income (2 income sources: 120000+30000)', 150000, cf.grossMonthlyIncome, 0.01);
check('MR02', 'Essential expenses (Housing)', 45000, cf.essentialMonthlyExpenses, 0.01);
check('MR03', 'Monthly surplus (150000 - 53000)', 97000, cf.monthlySurplus, 0.01);

const nw = byCode.net_worth.sectionData;
check('MR04', 'Net worth (assets incl. retirement 7,800,000 - liabilities 1,200,000)', 6600000, nw.netWorth, 0.01);
check('MR05', 'Total assets (cash 300,000 + property 5,000,000 + retirement 2,500,000)', 7800000, nw.totalAssets, 0.01);

const goals = byCode.goals.sectionData;
const g = goals.goals[0];
const expectedGoalPct = (375000 / goals.summary.totalTargetAmount) * 100;
check('MR06', 'Goal progress % (current 375,000 / app-adjusted target, self-consistency)', Number(expectedGoalPct.toFixed(6)), g.progressPct, 0.01, `adjustedTarget=${goals.summary.totalTargetAmount}`);

const rr = byCode.retirement_readiness.sectionData;
check('MR07', 'Retirement opening balance (seeded NPS balance)', 2500000, rr.results[0].opening_value, 1);

const perf = byCode.investment_performance.sectionData.results;
const expectedPerfFundValue = (() => { let nav = 100, v; for (let i = 0; i < 12; i++) { v = nav * 2000; nav *= 1.01; } return v; })();
const expectedSipFundValue = (() => { let nav = 50, cum = 0, v; for (let i = 0; i < 6; i++) { cum += 5000 / nav; v = cum * nav; nav *= 1.01; } return v; })();
const expectedTotalPortfolioValue = expectedPerfFundValue + expectedSipFundValue + 800000 + 0;
check('MR08', 'Total portfolio value (hand-computed from raw NAV/units across all 4 funds: perf+SIP+X-Ray+Tax)', Number(expectedTotalPortfolioValue.toFixed(2)), perf.portfolios[0].totalValue, 0.5);

const sip = byCode.sip_contribution.sectionData.results;
const presentable = sip.analytics.filter((a) => a.series.contributions.length >= 2)[0];
const sipSum = presentable.series.contributions.reduce((s, c) => s + c.grossAmount, 0);
check('MR09', 'SIP total invested (6 contributions x 5,000)', 30000, sipSum, 0.01, `contributionCount=${presentable.series.contributions.length}`);

const xray = byCode.portfolio_xray.sectionData.results;
const expectedTop1 = 800000 / expectedTotalPortfolioValue;
check('MR10', 'X-Ray top-scheme concentration (X-Ray fund value 800,000 / total portfolio value)', Number(expectedTop1.toFixed(10)), xray.schemeConcentration.top1, 0.0001, `securityCount=${xray.schemeConcentration.securityCount}`);

const tax = byCode.tax_and_cost.sectionData.results;
const disposal = tax.disposalResults.find((d) => d.acquisitionDate === '2024-03-01');
check('MR11', 'Realized capital gain (sale 150,000 - cost basis 100,000)', 50000, disposal.saleValue - disposal.costBasisUsed, 0.01);

const review = byCode.priority_review_items.sectionData;
const items = review.items ?? review.openItems ?? [];
check('MR12', 'Priority review items: high-severity item ranked first among 3 seeded (high/medium/low)', 'high', items[0]?.severity, 0, `order=${items.map((i) => i.severity).join(',')}`);

console.log('\n=== SUMMARY ===');
console.log(`${results.filter((r) => r.ok).length}/${results.length} PASS`);
fs.writeFileSync('C:/Users/user/AppData/Local/Temp/claude/D--FHIP/754236a6-648e-4039-9457-c73bef97d4a2/scratchpad/pdf_pages/MR_final_results.json', JSON.stringify(results, null, 2));
