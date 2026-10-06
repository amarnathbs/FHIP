// NAV2 Stage 3, journey 6: ownership and valuation cases through the real upload route and the real report:
// personal (self), spouse (personal), joint 50/50, Family Trust, HUF, Company, a MANUAL register entry, and a fully REDEEMED fund (journey 1).
// Fixture user: spare (starts empty). Owners are chosen BEFORE upload, as the product requires.
import { api, check, db, OUT, save, summary, USERS, userIdOf, logoutAll } from './_lib.mjs';
import { FUND, generate, readReport, uploadAndAccept } from './_flow.mjs';
import { close, loadNav, navOnOrBefore } from './oracle.mjs';

const email = USERS.spare;
const uid = await userIdOf(email);
console.log(`=== journey 6 ${new Date().toISOString()} ===`);

const selfRes = await api(email, 'POST', '/api/ownership/self');
const selfId = selfRes.json?.data?.memberId;
const opts = await api(email, 'GET', '/api/ownership/options?flow=ii_cas');
let spouseId = (opts.json?.data?.members ?? []).find((m) => m.ownerRole === 'spouse')?.id;
if (!spouseId) spouseId = (await api(email, 'POST', '/api/household-members', { json: { full_name: 'FHIP Synthetic Spouse', relationship: 'spouse' } })).json?.data?.id;
check('self and spouse members exist for the fixture user', !!selfId && !!spouseId);

const entity = async (name, type) => {
  const list = (await api(email, 'GET', '/api/business-entities')).json?.data ?? [];
  const hit = list.find((e) => e.name === name);
  if (hit) return hit.id;
  const r = await api(email, 'POST', '/api/business-entities', { json: { name, entity_type: type, country_code: 'IN', currency_code: 'INR', ownership_percentage: 100, valuation_mode: 'summary', summary_net_asset_value: 1 } });
  return r.json?.data?.id;
};
const trustId = await entity('NAV2 Stage3 Family Trust', 'family_trust');
const hufId = await entity('NAV2 Stage3 HUF', 'huf');
const companyId = await entity('NAV2 Stage3 Company', 'company');
check('a Family Trust, an HUF and a Company exist for the fixture user', !!trustId && !!hufId && !!companyId, `${String(trustId).slice(0, 8)} ${String(hufId).slice(0, 8)} ${String(companyId).slice(0, 8)}`);

const cases = [
  ['own-self', 'nav2s3-own-self', { kind: 'member', memberId: selfId }, 'A', 'personal (Self)'],
  ['own-spouse', 'nav2s3-own-spouse', { kind: 'member', memberId: spouseId }, 'A', 'personal (Spouse), the same fund A in another folio'],
  ['own-joint', 'nav2s3-own-joint', { kind: 'joint', allocations: [{ memberId: selfId, basisPoints: 5000 }, { memberId: spouseId, basisPoints: 5000 }] }, 'D', 'joint 50/50 Self and Spouse'],
  ['own-trust', 'nav2s3-own-trust', { kind: 'entity', entityId: trustId }, 'B', 'Family Trust'],
  ['own-huf', 'nav2s3-own-huf', { kind: 'entity', entityId: hufId }, 'C', 'HUF'],
  ['own-company', 'nav2s3-own-company', { kind: 'entity', entityId: companyId }, 'D', 'Company'],
];
const accepted = {};
for (const [key, stmt, owner, fund, label] of cases) {
  const r = await uploadAndAccept(email, stmt, { owner });
  accepted[key] = r;
  check(`uploaded under the chosen owner and accepted: ${label}`, r.ok, `status ${r.status} ${r.body ?? ''}`);
}
// a manual register entry that looks like one of the funds: it is not an Investment Intelligence instrument and must never be in the report
const manual = await api(email, 'POST', '/api/investments', { json: { investment_name: 'HDFC Large Cap Fund (manual entry)', investment_type: 'managed_fund', current_value: 99999, currency_code: 'INR', country_code: 'IN', owner: 'self' } });
check('a MANUAL register investment was added (outside Investment Intelligence)', manual.status < 300, `status ${manual.status}`);

const accounts = (await db.from('ii_accounts').select('*').eq('user_id', uid)).data ?? [];
const allocs = (await db.from('ii_ownership_allocation').select('ii_account_id, owner_member_id, owner_business_entity_id, owner_role, allocation_basis_points').eq('user_id', uid)).data ?? [];
const entityAccountIds = new Set(allocs.filter((x) => x.owner_business_entity_id).map((x) => x.ii_account_id));
const accOwner = Object.fromEntries(accounts.map((a) => [a.folio_number, allocs.filter((x) => x.ii_account_id === a.id).map((x) => `${x.owner_role}${x.owner_business_entity_id ? '(entity)' : '(member)'}`)]));
save('j6_account_owners.json', accOwner);
console.log('   account owners:', JSON.stringify(accOwner));
const entityFolios = accounts.filter((a) => entityAccountIds.has(a.id)).map((a) => a.folio_number);
check('the three entity-owned folios (Trust, HUF, Company) are recorded against their entity, and the Self, Spouse and Joint folios against members', entityFolios.length === 3 && accounts.length === 6, entityFolios.join(','));

const g = await generate(email);
check('the report is generated for the mixed-ownership household', g.status === 201, `${g.status} ${g.body}`);
const { report } = await readReport(email, g.id);
save('j6_report.json', report);
const names = report.schemes.map((s) => s.instrumentId);
console.log('   report schemes:', report.schemes.map((s) => `${s.schemeName} (${s.instrumentId.slice(0, 8)})`).join(' | '), '| scope', JSON.stringify(report.scope));
check('PERSONAL: fund A (Self + Spouse folios) is in the report ONCE', names.filter((i) => i === FUND.A).length === 1);
check('JOINT: fund D held jointly 50/50 by two household members is in the personal report (a joint holding is not entity-held)', names.includes(FUND.D));
check('ENTITY: the Family Trust fund B and the HUF fund C are NOT in the personal report', !names.includes(FUND.B) && !names.includes(FUND.C), `schemes in report: ${names.map((i) => i.slice(0, 8)).join(',')}`);
check('ENTITY: the report says plainly that entity-held schemes were left out (scope.entityHeldSchemesExcluded counts them)', report.scope.entityHeldSchemesExcluded >= 2, `entityHeldSchemesExcluded ${report.scope.entityHeldSchemesExcluded}`);
check('MANUAL: the manual register entry never appears as a scheme', !report.schemes.some((s) => /manual/i.test(s.schemeName)));

// valuation: compare the personal totals with an independent sum over the personal accounts only
const navA = await loadNav(FUND.A); const navD = await loadNav(FUND.D);
const lastA = navOnOrBefore(navA, report.asOfDate, 3650).nav; const lastD = navOnOrBefore(navD, report.asOfDate, 3650).nav;
const txns = (await db.from('ii_transactions').select('account_id, instrument_id, units, transaction_type').eq('user_id', uid)).data ?? [];
const unitsFor = (instr, accIds) => txns.filter((t) => t.instrument_id === instr && accIds.includes(t.account_id)).reduce((s, t) => s + (t.transaction_type === 'redemption' ? -1 : 1) * Number(t.units), 0);
const personalIds = accounts.filter((a) => !entityAccountIds.has(a.id)).map((a) => a.id);
const uA = unitsFor(FUND.A, personalIds); const uD = unitsFor(FUND.D, personalIds);
const repA = report.schemes.find((s) => s.instrumentId === FUND.A)?.analytics.investor.currentValue.value;
const repD = report.schemes.find((s) => s.instrumentId === FUND.D)?.analytics.investor.currentValue.value;
check('PERSONAL VALUATION: fund A current value = (Self units + Spouse units) x latest NAV, from the independent sum', close(repA?.value, Math.round(uA * lastA * 100) / 100, 0.02), `report ${repA?.value} vs ${(uA * lastA).toFixed(2)} (${uA.toFixed(3)} units)`);
const dFull = Math.round(uD * lastD * 100) / 100;
const dHalf = Math.round(uD * lastD * 50) / 100;
const dMode = close(repD?.value, dFull, 0.02) ? 'FULL account value (the report does not apply the 50/50 split)' : close(repD?.value, dHalf, 0.02) ? 'the 50% share' : 'neither';
console.log(`   JOINT valuation observed: report ${repD?.value}; independent full ${dFull}, 50% share ${dHalf} -> ${dMode}`);
save('j6_joint_observation.json', { reportValue: repD?.value, full: dFull, half: dHalf, mode: dMode });
check('JOINT VALUATION is one of the two defined bases (full account value or the owner share), not a third number', dMode !== 'neither', dMode);
check('NEGATIVE CONTROL: counting the Company folio of fund D into the personal total would have given a different (wrong) figure', Math.abs(unitsFor(FUND.D, accounts.map((a) => a.id)) - uD) > 1, `D units with all folios ${unitsFor(FUND.D, accounts.map((a) => a.id)).toFixed(3)} vs personal-only ${uD.toFixed(3)}`);

await logoutAll();
const s = summary();
save('j6_results.json', s);
console.log(`\n=== journey 6: ${s.pass} PASS, ${s.fail} FAIL ===`);
process.exitCode = s.fail ? 1 : 0;
