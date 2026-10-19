// The REAL print route with the two-page plan (?plan=2): the page the export falls back to when a one-page fund sheet does not fit.
// Makes a short-lived render token for the holder fixture user's latest report (the token is deleted at the end), opens the print route once
// with the default plan and once with plan=2, and checks which plan each page says it is and how many fund sections it holds.
import crypto from 'node:crypto';
import { check, db, PORT, summary, USERS, userIdOf } from './_lib.mjs';

const userId = await userIdOf(USERS.holder);
const report = (await db.from('nav2_fund_analytics_reports').select('id, report_json').eq('user_id', userId).order('version_number', { ascending: false }).limit(1)).data[0];
const funds = report.report_json.schemes.length;
const token = crypto.randomBytes(32).toString('hex');
const ins = await db.from('nav2_report_render_tokens').insert({ token, user_id: userId, report_id: report.id, expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() });
check('a render token was made', !ins.error, ins.error?.message ?? 'ok');
try {
  const one = await (await fetch(`http://127.0.0.1:${PORT}/reports/fund-analytics/print?token=${token}`)).text();
  const two = await (await fetch(`http://127.0.0.1:${PORT}/reports/fund-analytics/print?token=${token}&plan=2`)).text();
  const n = (hay, s) => hay.split(s).length - 1;
  check('default: one page per fund', one.includes('data-fa-pages-per-fund="1"') && n(one, '<section class="fa-fund fa-one"') === funds, `${n(one, '<section class="fa-fund fa-one"')} one-page sheets for ${funds} funds`);
  check('plan=2: two pages per fund (a sheet A and a sheet B for each fund)', two.includes('data-fa-pages-per-fund="2"') && n(two, '<section class="fa-fund fa-sheet-a"') === funds && n(two, '<section class="fa-fund fa-sheet-b"') === funds, `${n(two, '<section class="fa-fund fa-sheet-a"')} A and ${n(two, '<section class="fa-fund fa-sheet-b"')} B sheets`);
  check('an unknown plan value falls back to one page', (await (await fetch(`http://127.0.0.1:${PORT}/reports/fund-analytics/print?token=${token}&plan=9`)).text()).includes('data-fa-pages-per-fund="1"'));
} finally {
  await db.from('nav2_report_render_tokens').delete().eq('token', token);
}
const s = summary();
console.log(`${s.pass} PASS, ${s.fail} FAIL`);
process.exitCode = s.fail ? 1 : 0;
