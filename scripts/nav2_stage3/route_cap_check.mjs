// The REAL generation route (own port, DEV, fixture users): the cap and the choice of funds, for a household that holds FEW funds.
// (A household with more than 10 funds cannot be made on DEV (cap 10 since 15-10-2026); the 11-fund refusal is proven at service level in nav2ReportFundCap.test.ts.)
//   * a choice naming a fund the caller does not hold, an empty choice and a repeated fund: 422 with the one plain message, nothing stored;
//   * a free user with any choice: 403 (the Premium message), nothing stored;
//   * a choice of two of the fund(s) held: 201, and the stored manifest carries the choice (sorted ids, funds held, cap);
//   * no choice at all: 201 as before (every fund held).
import crypto from 'node:crypto';
import { check, db, PORT, summary, USERS, userIdOf, logoutAll, login } from './_lib.mjs';
import { loadSession, cookieHeader } from '../canonical_cert/lib/session.mjs';

const holderId = await userIdOf(USERS.holder);
const latest = async () => (await db.from('nav2_fund_analytics_reports').select('id, version_number, manifest_json, report_json').eq('user_id', holderId).order('version_number', { ascending: false }).limit(1)).data?.[0];
const count = async () => (await db.from('nav2_fund_analytics_reports').select('id', { count: 'exact', head: true }).eq('user_id', holderId)).count ?? 0;
const base = await latest();
const heldIds = base.manifest_json.schemes.map((s) => s.instrumentId);
await login(USERS.holder);
const post = async (who, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/reports/fund-analytics`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookieHeader(loadSession(who)) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const before = await count();
const MSG = 'Choose between 1 and 10 of the funds you hold.';
const foreign = await post(USERS.holder, { period: 'since_first_held', funds: [heldIds[0], crypto.randomUUID()] });
check('a fund the caller does not hold: 422, one plain message', foreign.status === 422 && foreign.json?.error === MSG, `${foreign.status} ${foreign.json?.error}`);
const empty = await post(USERS.holder, { period: 'since_first_held', funds: [] });
check('an empty choice: 422, the same message', empty.status === 422 && empty.json?.error === MSG, `${empty.status}`);
const dup = await post(USERS.holder, { period: 'since_first_held', funds: [heldIds[0], heldIds[0]] });
check('a repeated fund: 422, the same message', dup.status === 422 && dup.json?.error === MSG, `${dup.status}`);
const notUuid = await post(USERS.holder, { period: 'since_first_held', funds: ['not-a-uuid'] });
check('a choice that is not a list of ids: refused by validation (422), nothing stored', notUuid.status === 422 || notUuid.status === 400, `${notUuid.status}`);
check('nothing was stored by any refusal', (await count()) === before, `${before} -> ${await count()}`);
await login(USERS.free);
const free = await post(USERS.free, { period: 'since_first_held', funds: heldIds.slice(0, 2) });
check('a free user with a choice: 403 and the Premium message', free.status === 403 && /Premium/.test(free.json?.error ?? ''), `${free.status} ${free.json?.error}`);
const chosen = heldIds.slice(0, 2);
const ok = await post(USERS.holder, { period: 'since_first_held', funds: chosen });
check('a choice of two held funds: 201', ok.status === 201, `${ok.status} ${JSON.stringify(ok.json).slice(0, 120)}`);
const row = await latest();
check('the stored manifest carries the choice (sorted ids, funds held, cap 10)', JSON.stringify(row.manifest_json.selection?.chosenInstrumentIds) === JSON.stringify([...chosen].sort()) && row.manifest_json.selection?.heldFundCount === heldIds.length && row.manifest_json.selection?.max === 10, JSON.stringify(row.manifest_json.selection));
check('the report covers exactly those funds', row.report_json.schemes.length === 2, `${row.report_json.schemes.length}`);
check('two of four held funds: the report says it covers 2 of the funds held only when the household holds more than the report covers', row.report_json.selection?.chosenCount === 2 || heldIds.length <= 2, JSON.stringify(row.report_json.selection));
const all = await post(USERS.holder, { period: 'since_first_held' });
check('no choice: 201 as before, every fund held', all.status === 201, `${all.status}`);
const last = await latest();
check('that manifest records "all_held"', last.manifest_json.selection?.basis === 'all_held' && last.report_json.schemes.length === heldIds.length, JSON.stringify(last.manifest_json.selection));
await logoutAll();
const s = summary();
console.log(`${s.pass} PASS, ${s.fail} FAIL`);
process.exitCode = s.fail ? 1 : 0;
