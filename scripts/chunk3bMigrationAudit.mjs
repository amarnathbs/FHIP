// Chunk 3b — read-only dry-run migration audit against real DEV data.
// NO WRITES. Uses the service-role key exactly like every prior phase's
// read-only PostgREST scripts (scripts/importRecommendationsData.mjs is the
// established precedent for loading .env.local; this script never calls
// .insert()/.update()/.delete() — select() only).
import fs from 'node:fs';

const envText = fs.readFileSync('D:\\FHIP\\.env.local', 'utf8');
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);

const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Paginated full-table read — DEV population here is a few hundred rows per
// table (per AR-0 §5: 838 assets / 717 investments / 357 retirement), well
// under any single-page default limit, but paginate defensively anyway
// (R6's independently-found lesson: never assume a single page is complete).
async function fetchAllRows(table, columns) {
  const pageSize = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

const ASSET_DEPRECATE = [
  'term_deposits', 'cryptocurrency', 'shares', 'etfs', 'managed_funds', 'bonds',
  'private_equity', 'commercial_property', // Class B, Assets<->Investments
  'industry_super', 'retail_super', 'defined_benefit', // Class B, Assets<->Retirement
  'smsf_balance', // 3-way SMSF
  'business_ownership', 'partnership_interest', 'trust_assets', 'investment_property', // Class C
];
const INVESTMENT_DEPRECATE = [
  'smsf_investments', // 3-way SMSF
  'education_fund', 'children_investment', // Class E
  'high_interest_savings', // Class C, reversed direction (Assets canonical)
];
const RETIREMENT_DEPRECATE = [
  'employer_contributions', 'salary_sacrifice', 'personal_concessional',
  'non_concessional', 'government_co_contribution', 'spouse_contribution', // Class F
  'allocated_pension', // item 7
  'retirement_savings', // item 8
];

// Canonical retirement account-style keys a contribution row could plausibly
// belong to (used as candidate "parent account" set for the evidence-based
// linking attempt).
const RETIREMENT_ACCOUNT_STYLE_KEYS = new Set([
  'industry_super', 'retail_super', 'smsf', 'defined_benefit',
  'transition_to_retirement', 'allocated_pension', 'account_based_pension',
  'annuity', 'overseas_pension', 'other_retirement_assets', 'retirement_savings',
  'epf', 'ppf', 'nps',
]);

const assetCols = 'id, user_id, asset_name, master_item_key, current_value, currency_code, country_code, owner, is_active, created_at, notes';
const invCols = 'id, user_id, investment_name, master_item_key, current_value, currency_code, country_code, owner, institution, is_active, created_at, notes';
const retCols = 'id, user_id, account_name, master_item_key, current_balance, currency_code, country_code, owner, is_active, created_at, notes';
const liabCols = 'id, user_id, liability_name, balance, currency_code, is_active';

console.log('Fetching assets / investments / retirement_accounts / liabilities (active only, is_active=true)...');
const [assets, investments, retirement, liabilities] = await Promise.all([
  fetchAllRows('assets', assetCols).then((r) => r.filter((x) => x.is_active)),
  fetchAllRows('investments', invCols).then((r) => r.filter((x) => x.is_active)),
  fetchAllRows('retirement_accounts', retCols).then((r) => r.filter((x) => x.is_active)),
  fetchAllRows('liabilities', liabCols).then((r) => r.filter((x) => x.is_active)),
]);

console.log(`Population: ${assets.length} assets, ${investments.length} investments, ${retirement.length} retirement, ${liabilities.length} liabilities.`);

// ---------------------------------------------------------------------------
// 1. Row counts per deprecated key
// ---------------------------------------------------------------------------
function countByKey(rows, keys) {
  const out = {};
  for (const k of keys) out[k] = rows.filter((r) => r.master_item_key === k);
  return out;
}
const assetDeprecatedRows = countByKey(assets, ASSET_DEPRECATE);
const invDeprecatedRows = countByKey(investments, INVESTMENT_DEPRECATE);
const retDeprecatedRows = countByKey(retirement, RETIREMENT_DEPRECATE);

console.log('\n=== Rows referencing a deprecated catalogue item (Assets) ===');
for (const [k, rows] of Object.entries(assetDeprecatedRows)) {
  if (rows.length) console.log(`  asset.${k}: ${rows.length} row(s) — users: ${[...new Set(rows.map((r) => r.user_id))].join(', ')}`);
}
console.log('\n=== Rows referencing a deprecated catalogue item (Investments) ===');
for (const [k, rows] of Object.entries(invDeprecatedRows)) {
  if (rows.length) console.log(`  investment.${k}: ${rows.length} row(s) — users: ${[...new Set(rows.map((r) => r.user_id))].join(', ')}`);
}
console.log('\n=== Rows referencing a deprecated catalogue item (Retirement) ===');
for (const [k, rows] of Object.entries(retDeprecatedRows)) {
  if (rows.length) console.log(`  retirement.${k}: ${rows.length} row(s) — users: ${[...new Set(rows.map((r) => r.user_id))].join(', ')}`);
}

// ---------------------------------------------------------------------------
// 2. Cross-module duplicate detection for the Class B (exact-key) pairs
//    Deterministic = same user + same mapped concept + institution/name
//    match + value match + created_at within 5 minutes of each other.
//    Otherwise: possible duplicate (flagged, both rows preserved).
// ---------------------------------------------------------------------------
const ASSET_TO_INVESTMENT_PAIR = {
  term_deposits: 'term_deposits', cryptocurrency: 'cryptocurrency', shares: 'shares',
  etfs: 'etfs', managed_funds: 'managed_funds', bonds: 'bonds',
  private_equity: 'private_equity', commercial_property: 'commercial_property',
  business_ownership: 'business_investment', partnership_interest: 'partnership_investment',
  trust_assets: 'trust_investment', investment_property: 'property',
};
const ASSET_TO_RETIREMENT_PAIR = { industry_super: 'industry_super', retail_super: 'retail_super', defined_benefit: 'defined_benefit' };

function closeInTime(a, b, minutes = 5) {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  return Math.abs(ta - tb) <= minutes * 60 * 1000;
}

const crossModuleFindings = [];
for (const [assetKey, invKey] of Object.entries(ASSET_TO_INVESTMENT_PAIR)) {
  const aRows = assets.filter((r) => r.master_item_key === assetKey);
  const iRows = investments.filter((r) => r.master_item_key === invKey);
  for (const a of aRows) {
    const candidates = iRows.filter((i) => i.user_id === a.user_id);
    for (const i of candidates) {
      const valueMatch = Math.abs(Number(a.current_value) - Number(i.current_value)) < 0.01;
      const currencyMatch = a.currency_code === i.currency_code;
      const timeClose = a.created_at && i.created_at ? closeInTime(a.created_at, i.created_at) : false;
      const deterministic = valueMatch && currencyMatch && timeClose;
      crossModuleFindings.push({
        pairType: 'asset<->investment', assetKey, invKey, userId: a.user_id,
        assetRow: { id: a.id, name: a.asset_name, value: a.current_value, currency: a.currency_code, created_at: a.created_at },
        investmentRow: { id: i.id, name: i.investment_name, value: i.current_value, currency: i.currency_code, institution: i.institution, created_at: i.created_at },
        valueMatch, currencyMatch, timeClose,
        classification: deterministic ? 'deterministic_duplicate' : 'possible_duplicate',
      });
    }
  }
}
for (const [assetKey, retKey] of Object.entries(ASSET_TO_RETIREMENT_PAIR)) {
  const aRows = assets.filter((r) => r.master_item_key === assetKey);
  const rRows = retirement.filter((r) => r.master_item_key === retKey);
  for (const a of aRows) {
    const candidates = rRows.filter((r) => r.user_id === a.user_id);
    for (const r of candidates) {
      const valueMatch = Math.abs(Number(a.current_value) - Number(r.current_balance)) < 0.01;
      const currencyMatch = a.currency_code === r.currency_code;
      const timeClose = a.created_at && r.created_at ? closeInTime(a.created_at, r.created_at) : false;
      const deterministic = valueMatch && currencyMatch && timeClose;
      crossModuleFindings.push({
        pairType: 'asset<->retirement', assetKey, retKey, userId: a.user_id,
        assetRow: { id: a.id, name: a.asset_name, value: a.current_value, currency: a.currency_code, created_at: a.created_at },
        retirementRow: { id: r.id, name: r.account_name, value: r.current_balance, currency: r.currency_code, created_at: r.created_at },
        valueMatch, currencyMatch, timeClose,
        classification: deterministic ? 'deterministic_duplicate' : 'possible_duplicate',
      });
    }
  }
}
// 3-way SMSF overlap
const smsfAsset = assets.filter((r) => r.master_item_key === 'smsf_balance');
const smsfInvestment = investments.filter((r) => r.master_item_key === 'smsf_investments');
const smsfRetirement = retirement.filter((r) => r.master_item_key === 'smsf');
console.log(`\n=== SMSF 3-way overlap ===\n  asset.smsf_balance: ${smsfAsset.length}, investment.smsf_investments: ${smsfInvestment.length}, retirement.smsf: ${smsfRetirement.length}`);

console.log(`\n=== Cross-module Class-B/C duplicate scan (${crossModuleFindings.length} candidate pairs found) ===`);
for (const f of crossModuleFindings) {
  console.log(`  [${f.classification}] user=${f.userId} ${f.pairType} ${f.assetKey}<->${f.invKey ?? f.retKey}`);
}

// ---------------------------------------------------------------------------
// 3. Class-E items (education_fund, children_investment) — evidence check
// ---------------------------------------------------------------------------
console.log('\n=== Class E rows (education_fund / children_investment) — evidence for reclassification ===');
for (const row of [...invDeprecatedRows.education_fund, ...invDeprecatedRows.children_investment]) {
  console.log(`  investment.${row.master_item_key} id=${row.id} user=${row.user_id} name="${row.investment_name}" institution="${row.institution ?? ''}" value=${row.current_value} notes="${row.notes ?? ''}"`);
}

// ---------------------------------------------------------------------------
// 4. Class-F contribution rows — candidate parent-account linking attempt
// ---------------------------------------------------------------------------
console.log('\n=== Class F contribution rows — candidate parent-account evidence ===');
const contributionRows = RETIREMENT_DEPRECATE.filter((k) => !['allocated_pension', 'retirement_savings'].includes(k))
  .flatMap((k) => retDeprecatedRows[k]);
for (const c of contributionRows) {
  const candidates = retirement.filter(
    (r) => r.user_id === c.user_id && RETIREMENT_ACCOUNT_STYLE_KEYS.has(r.master_item_key) && r.currency_code === c.currency_code
  );
  console.log(
    `  retirement.${c.master_item_key} id=${c.id} user=${c.user_id} balance_field=${c.current_balance} currency=${c.currency_code} -> ${candidates.length} candidate parent account(s): [${candidates.map((x) => `${x.master_item_key}:${x.id}`).join(', ')}]`
  );
}
if (contributionRows.length === 0) console.log('  (none found in current DEV population)');

// ---------------------------------------------------------------------------
// 5. allocated_pension / retirement_savings reclassification rows
// ---------------------------------------------------------------------------
console.log('\n=== allocated_pension rows (-> account_based_pension) ===');
for (const r of retDeprecatedRows.allocated_pension) console.log(`  id=${r.id} user=${r.user_id} balance=${r.current_balance}`);
console.log('\n=== retirement_savings rows (-> other_retirement_assets) ===');
for (const r of retDeprecatedRows.retirement_savings) console.log(`  id=${r.id} user=${r.user_id} balance=${r.current_balance}`);

// ---------------------------------------------------------------------------
// 6. Net Worth before/after simulation for the full user population.
//    Before = current (buggy) dashboard.ts logic: totalRetirement sums
//    EVERY active retirement_accounts row's current_balance regardless of
//    master_item_key (incl. Class-F contribution rows).
//    After = totalRetirement excludes rows whose master_item_key is one of
//    the 6 Class-F contribution keys (the disclosed, deliberate defect fix)
//    PLUS deterministic cross-module duplicates consolidated once.
//    Pure module/key reclassification (the overwhelming majority of the
//    work) never changes Net Worth by construction (moving a row's stored
//    classification between totalAssets/totalInvestments/totalRetirement
//    doesn't change which of the three buckets sums to the same
//    Assets+Investments+Retirement-Liabilities total).
// ---------------------------------------------------------------------------
function fx(currency, value, reportingCurrency, fxRateAudInr) {
  if (currency !== 'AUD' && currency !== 'INR') return value;
  if (currency === reportingCurrency) return value;
  if (currency === 'INR' && reportingCurrency === 'AUD') return value / fxRateAudInr;
  if (currency === 'AUD' && reportingCurrency === 'INR') return value * fxRateAudInr;
  return value;
}
const FX_RATE = 56;

const userIds = new Set([
  ...assets.map((r) => r.user_id), ...investments.map((r) => r.user_id),
  ...retirement.map((r) => r.user_id), ...liabilities.map((r) => r.user_id),
]);

const CONTRIBUTION_KEYS = new Set([
  'employer_contributions', 'salary_sacrifice', 'personal_concessional',
  'non_concessional', 'government_co_contribution', 'spouse_contribution',
]);

// Deterministic-duplicate row ids to exclude once (consolidate into the
// canonical side) in the "after" simulation — only pairs classified
// deterministic_duplicate above.
const deterministicAssetIdsToConsolidate = new Set(
  crossModuleFindings.filter((f) => f.classification === 'deterministic_duplicate').map((f) => f.assetRow.id)
);

let usersWithVariance = 0;
let usersReconciled = 0;
let usersWithExpectedRetirementCorrection = 0;
const varianceReport = [];

for (const uid of userIds) {
  const reportingCurrency = 'AUD'; // dashboard reporting currency is per-household; AUD used uniformly here since this is a structural (not currency) reconciliation — see doc for caveat.
  const uAssets = assets.filter((r) => r.user_id === uid);
  const uInvestments = investments.filter((r) => r.user_id === uid);
  const uRetirement = retirement.filter((r) => r.user_id === uid);
  const uLiabilities = liabilities.filter((r) => r.user_id === uid);

  const sumAssets = (rows) => rows.reduce((s, r) => s + fx(r.currency_code, Number(r.current_value), reportingCurrency, FX_RATE), 0);
  const sumInv = (rows) => rows.reduce((s, r) => s + fx(r.currency_code, Number(r.current_value), reportingCurrency, FX_RATE), 0);
  const sumRet = (rows) => rows.reduce((s, r) => s + fx(r.currency_code, Number(r.current_balance), reportingCurrency, FX_RATE), 0);
  const sumLiab = (rows) => rows.reduce((s, r) => s + fx(r.currency_code, Number(r.balance), reportingCurrency, FX_RATE), 0);

  const beforeAssetsTotal = sumAssets(uAssets);
  const beforeInvTotal = sumInv(uInvestments);
  const beforeRetTotal = sumRet(uRetirement); // BUG: includes Class-F phantom balances
  const beforeLiab = sumLiab(uLiabilities);
  const beforeNetWorth = beforeAssetsTotal + beforeInvTotal + beforeRetTotal - beforeLiab;

  // AFTER: same three module totals (pure reclassification never changes
  // which bucket a value's total lands in from a net-worth-sum point of
  // view), MINUS one deterministic-duplicate consolidation per matched
  // pair, MINUS the Class-F phantom-balance correction.
  const consolidationAdjustment = uAssets
    .filter((r) => deterministicAssetIdsToConsolidate.has(r.id))
    .reduce((s, r) => s + fx(r.currency_code, Number(r.current_value), reportingCurrency, FX_RATE), 0);
  const contributionAdjustment = uRetirement
    .filter((r) => CONTRIBUTION_KEYS.has(r.master_item_key))
    .reduce((s, r) => s + fx(r.currency_code, Number(r.current_balance), reportingCurrency, FX_RATE), 0);

  const afterNetWorth = beforeNetWorth - consolidationAdjustment - contributionAdjustment;
  const variance = afterNetWorth - beforeNetWorth;
  const explainedVariance = -(consolidationAdjustment + contributionAdjustment);

  if (Math.abs(variance - explainedVariance) > 0.01) {
    usersWithVariance += 1;
    varianceReport.push({ uid, beforeNetWorth, afterNetWorth, variance, consolidationAdjustment, contributionAdjustment, UNEXPLAINED: true });
  } else if (Math.abs(variance) < 0.01) {
    usersReconciled += 1;
  } else {
    usersWithExpectedRetirementCorrection += 1;
    varianceReport.push({ uid, beforeNetWorth, afterNetWorth, variance, consolidationAdjustment, contributionAdjustment, UNEXPLAINED: false });
  }
}

console.log(`\n=== Net Worth before/after reconciliation (${userIds.size} users) ===`);
console.log(`  Zero-variance (pure reclassification, no Class-F/duplicate row present): ${usersReconciled}`);
console.log(`  Explained variance (Class-F phantom-balance fix and/or deterministic-duplicate consolidation): ${usersWithExpectedRetirementCorrection}`);
console.log(`  UNEXPLAINED variance (hard stop candidates): ${usersWithVariance}`);
for (const v of varianceReport) {
  console.log(`    user=${v.uid} before=${v.beforeNetWorth.toFixed(2)} after=${v.afterNetWorth.toFixed(2)} variance=${v.variance.toFixed(2)} consolidation=${v.consolidationAdjustment.toFixed(2)} contribution=${v.contributionAdjustment.toFixed(2)} UNEXPLAINED=${v.UNEXPLAINED}`);
}

fs.writeFileSync(
  'C:\\Users\\user\\AppData\\Local\\Temp\\claude\\D--FHIP\\754236a6-648e-4039-9457-c73bef97d4a2\\scratchpad\\chunk3b_audit_output.json',
  JSON.stringify(
    {
      population: { assets: assets.length, investments: investments.length, retirement: retirement.length, liabilities: liabilities.length, users: userIds.size },
      assetDeprecatedCounts: Object.fromEntries(Object.entries(assetDeprecatedRows).map(([k, v]) => [k, v.length])),
      investmentDeprecatedCounts: Object.fromEntries(Object.entries(invDeprecatedRows).map(([k, v]) => [k, v.length])),
      retirementDeprecatedCounts: Object.fromEntries(Object.entries(retDeprecatedRows).map(([k, v]) => [k, v.length])),
      smsf3way: { asset: smsfAsset.length, investment: smsfInvestment.length, retirement: smsfRetirement.length },
      crossModuleFindings,
      classEEvidence: [...invDeprecatedRows.education_fund, ...invDeprecatedRows.children_investment],
      contributionEvidence: contributionRows.map((c) => ({
        id: c.id, user_id: c.user_id, master_item_key: c.master_item_key, current_balance: c.current_balance, currency_code: c.currency_code,
        candidates: retirement.filter((r) => r.user_id === c.user_id && RETIREMENT_ACCOUNT_STYLE_KEYS.has(r.master_item_key) && r.currency_code === c.currency_code).map((x) => ({ id: x.id, key: x.master_item_key })),
      })),
      allocatedPensionRows: retDeprecatedRows.allocated_pension,
      retirementSavingsRows: retDeprecatedRows.retirement_savings,
      netWorthReconciliation: {
        totalUsers: userIds.size,
        zeroVariance: usersReconciled,
        explainedVariance: usersWithExpectedRetirementCorrection,
        unexplainedVariance: usersWithVariance,
        detail: varianceReport,
      },
    },
    null,
    2
  )
);
console.log('\nFull JSON written to scratchpad/chunk3b_audit_output.json');
