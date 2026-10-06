// DEV proof of the joint SHARE rule (PO decision 06-10-2026): fixture user 'spare' with a joint 60/40 holding, a joint 50/50 holding and a sole holding,
// through the real upload routes, the real report and the real PDF export. Independent oracle: the raw DEV rows, scaled by hand.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, db, OUT, PORT, save, summary, USERS, userIdOf, logoutAll, api, login } from './_lib.mjs';
import { FUND, generate, readReport, uploadAndAccept, storedRow } from './_flow.mjs';
import { oracleFor, close, loadNav, navOnOrBefore } from './oracle.mjs';
import { loadSession, cookieHeader } from '../canonical_cert/lib/session.mjs';

const email = USERS.spare;
const uid = await userIdOf(email);
const ROOT = path.resolve(OUT, '..', '..');
console.log(`=== journey 6b (joint SHARE) ${new Date().toISOString()} ===`);
const selfId = (await api(email, 'POST', '/api/ownership/self')).json?.data?.memberId;
let spouseId = ((await api(email, 'GET', '/api/ownership/options?flow=ii_cas')).json?.data?.members ?? []).find((m) => m.ownerRole === 'spouse')?.id;
if (!spouseId) spouseId = (await api(email, 'POST', '/api/household-members', { json: { full_name: 'FHIP Synthetic Spouse', relationship: 'spouse' } })).json?.data?.id;
const joint = (a, b) => ({ kind: 'joint', allocations: [{ memberId: selfId, basisPoints: a }, { memberId: spouseId, basisPoints: b }] });
const r1 = await uploadAndAccept(email, 'nav2s3-own-joint', { owner: joint(6000, 4000) });   // fund D, joint 60/40
const r2 = await uploadAndAccept(email, 'nav2s3-own-trust', { owner: joint(5000, 5000) });   // fund B, joint 50/50
const r3 = await uploadAndAccept(email, 'nav2s3-own-self', { owner: { kind: 'member', memberId: selfId } }); // fund A, sole
check('three statements accepted: D joint 60/40, B joint 50/50, A sole', r1.ok && r2.ok && r3.ok, JSON.stringify([r1.status, r2.status, r3.status]));

const g = await generate(email);
check('the report is generated', g.status === 201, `${g.status} ${g.body}`);
const rep = (await readReport(email, g.id)).report;
const row = await storedRow(g.id);
const asOf = rep.asOfDate;
const navCache = {};
const blockOf = (id) => rep.schemes.find((s) => s.instrumentId === id);
const alloc = (await db.from('ii_ownership_allocation').select('ii_account_id, owner_member_id, allocation_basis_points, allocation_group_id, status').eq('user_id', uid).eq('status', 'active')).data ?? [];
save('j6b_allocations.json', alloc);

for (const [name, id, bp] of [['D (joint 60/40)', FUND.D, 6000], ['B (joint 50/50)', FUND.B, 5000]]) {
  const o = await oracleFor(uid, id, asOf, navCache); // WHOLE folio from the raw rows
  const f = bp / 10000;
  const b = blockOf(id);
  const inv = b.analytics.investor;
  const expectValue = Math.round(o.currentValue * f * 100) / 100;
  check(`${name}: current value is the user's ${bp / 100}% = ${expectValue} (whole holding ${o.currentValue}, never the whole)`, close(inv.currentValue.value.value, expectValue, 0.02) && !close(inv.currentValue.value.value, o.currentValue, 1), `report ${inv.currentValue.value.value}`);
  check(`${name}: amount put in, gain or loss are the user's share`, close(inv.investedAmount.value.invested, Math.round(o.invested * f * 100) / 100, 0.02) && close(inv.gainLoss.value.gainLoss, Math.round(o.gainLoss * f * 100) / 100, 0.03), `put in ${inv.investedAmount.value.invested} vs ${o.invested * f}; gain ${inv.gainLoss.value.gainLoss} vs ${o.gainLoss * f}`);
  check(`${name}: XIRR equals the whole-holding XIRR (flows strictly proportional) ${(o.xirr * 100).toFixed(4)}%`, close(inv.xirr.value.rate, o.xirr, 1e-6), `report ${(inv.xirr.value.rate * 100).toFixed(4)}%`);
  check(`${name}: the report says "Your share: ${bp / 100}% of a joint holding."`, b.ownership?.mode === 'share' && b.ownership.jointBasisPoints === bp, JSON.stringify(b.ownership));
  const m = row.manifest_json.schemes.find((s) => s.instrumentId === id);
  const dbGroup = alloc.find((a) => a.owner_member_id === selfId && a.allocation_basis_points === bp)?.allocation_group_id;
  check(`${name}: the manifest pins the allocation (member, basis points, allocation group ${String(dbGroup).slice(0, 8)})`, m.ownership?.jointBasisPoints === bp && m.ownership.selfMemberId === selfId && m.ownership.jointFolios[0]?.allocationGroup === dbGroup, JSON.stringify(m.ownership).slice(0, 200));
  // fund performance is the fund's, not scaled
  const cagr3 = b.analytics.scheme.pointToPoint.find((p) => p.id === '3Y')?.cagr?.value?.cagr;
  check(`${name}: the fund's own 3-year CAGR is unchanged (oracle ${o.p2p['3Y']?.cagr?.toFixed(6)})`, close(cagr3, o.p2p['3Y']?.cagr, 1e-9));
}
const a = await oracleFor(uid, FUND.A, asOf, navCache);
// the sole fund: only the household member folios (Self sole); the Spouse folio of fund A is not part of this journey
check('A (sole, Self): counted in full and carries no ownership note', close(blockOf(FUND.A).analytics.investor.currentValue.value.value, a.currentValue, 0.02) && blockOf(FUND.A).ownership === undefined, `${blockOf(FUND.A).analytics.investor.currentValue.value.value} vs ${a.currentValue}`);
check('NEGATIVE CONTROL: had the report shown the whole joint holding it would not equal the share (the two differ by more than 1 rupee)', Math.abs((await oracleFor(uid, FUND.D, asOf, navCache)).currentValue * 0.4) > 1);

// the PDF through the real export route
await login(email);
const res = await fetch(`http://127.0.0.1:${PORT}/api/reports/fund-analytics/${g.id}/export`, { headers: { cookie: cookieHeader(loadSession(email)) } });
const file = path.join(OUT, 'pdf', 'joint-share.pdf');
fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
const text = JSON.parse(execFileSync('python3', [path.join(ROOT, 'scripts/nav2_stage3/pdf_extra.py'), file], { encoding: 'utf8', maxBuffer: 80_000_000 })).text.replace(/\s+/g, ' ');
check('the PDF says "Your share: 60% of a joint holding." and "Your share: 50% of a joint holding."', res.status === 200 && text.includes('Your share: 60% of a joint holding.') && text.includes('Your share: 50% of a joint holding.'), `${res.status}`);
check('the PDF cover names the share beside the fund and explains it', /\(your share 60%\)/.test(text) && /\(your share 50%\)/.test(text) && /your share of it/.test(text));
await logoutAll();
const s = summary();
save('j6b_results.json', s);
console.log(`\n=== journey 6b: ${s.pass} PASS, ${s.fail} FAIL ===`);
process.exitCode = s.fail ? 1 : 0;
