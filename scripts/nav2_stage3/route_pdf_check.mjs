// The REAL export route (signed-in Premium fixture user): download the PDF, run the layout judge (blank, stranded heading, margin, scale, collisions,
// smallest text) and check the correlation headers are separate, then rasterise every page to PNG for looking at.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, db, OUT, PORT, save, summary, USERS, userIdOf, logoutAll, login } from './_lib.mjs';
import { loadSession, cookieHeader } from '../canonical_cert/lib/session.mjs';
const ROOT = path.resolve(OUT, '..', '..');
const dir = path.join(OUT, 'pdf_route_check');
fs.mkdirSync(dir, { recursive: true });
const id = (await db.from('nav2_fund_analytics_reports').select('id, report_json').eq('user_id', await userIdOf(USERS.holder)).order('version_number', { ascending: false }).limit(1)).data[0];
await login(USERS.holder);
const res = await fetch(`http://127.0.0.1:${PORT}/api/reports/fund-analytics/${id.id}/export`, { headers: { cookie: cookieHeader(loadSession(USERS.holder)) } });
const file = path.join(dir, 'route.pdf');
fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
check('the export route returns a PDF', res.status === 200, `${res.status}`);
const names = id.report_json.schemes.map((s) => s.schemeName);
fs.writeFileSync(path.join(dir, 'names.json'), JSON.stringify(names));
const layout = JSON.parse(execFileSync('npx', ['tsx', 'scripts/nav2_stage3/pdf_accept.ts', file, path.join(dir, 'png'), path.join(dir, 'names.json')], { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 50_000_000 }).trim().split('\n').pop());
const extra = JSON.parse(execFileSync('python3', [path.join(ROOT, 'scripts/nav2_stage3/pdf_extra.py'), file], { encoding: 'utf8', maxBuffer: 80_000_000 }));
check(`layout judge clean on the real route PDF (${layout.analysis.page_count} pages)`, layout.failures.length === 0, layout.failures.join(' | ') || 'clean');
const t = extra.text;
check('correlation headers are separate words ("Common returns" and "Period"), never joined', !/returnsPeriod/.test(t) && /Common returns/.test(t) && /Period/.test(t));
// the judge above already fails any page whose smallest text (running header and footer excluded) is under 7.5 pt
const mins = extra.pages.map((p) => p.min_font_pt);
save('route_pdf_check.json', { pages: extra.pages.length, mins, failures: layout.failures });
await logoutAll();
const s = summary();
console.log(`${s.pass} PASS, ${s.fail} FAIL; PNGs in ${path.join(dir, 'png')}`);
process.exitCode = s.fail ? 1 : 0;
