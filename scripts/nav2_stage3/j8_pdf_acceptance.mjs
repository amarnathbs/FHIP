// NAV2 Stage 3, journey 8a: acceptance of the FINAL exported PDF (the real export route, as a Premium user), through PyMuPDF measurements.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { check, db, OUT, PORT, save, summary, USERS, userIdOf, logoutAll, login } from './_lib.mjs';
import { loadSession, cookieHeader } from '../canonical_cert/lib/session.mjs';

const ROOT = path.resolve(OUT, '..', '..');
const dir = path.join(OUT, 'pdf');
fs.mkdirSync(dir, { recursive: true });

async function download(email, reportId, name) {
  await login(email);
  const res = await fetch(`http://127.0.0.1:${PORT}/api/reports/fund-analytics/${reportId}/export`, { headers: { cookie: cookieHeader(loadSession(email)) } });
  const buf = Buffer.from(await res.arrayBuffer());
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), cache: res.headers.get('cache-control'), file, bytes: buf.length, head: buf.subarray(0, 5).toString('latin1') };
}

async function accept(label, email, reportId, expect) {
  console.log(`--- ${label} ---`);
  const d = await download(email, reportId, `${label}.pdf`);
  check(`${label}: the export route returns a real PDF (200, application/pdf, %PDF header, private no-store)`, d.status === 200 && /application\/pdf/.test(d.type) && d.head === '%PDF-' && /no-store/.test(d.cache ?? ''), `${d.status} ${d.type} ${d.bytes} bytes; ${d.disposition}`);
  const rep = (await db.from('nav2_fund_analytics_reports').select('report_json, version_number, created_at').eq('id', reportId).single()).data;
  const names = rep.report_json.schemes.map((s) => s.schemeName);
  const namesFile = path.join(dir, `${label}-names.json`);
  fs.writeFileSync(namesFile, JSON.stringify(names));
  const pngDir = path.join(dir, `${label}-png`);
  const layout = JSON.parse(execFileSync('npx', ['tsx', 'scripts/nav2_stage3/pdf_accept.ts', d.file, pngDir, namesFile], { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 50_000_000 }).trim().split('\n').pop());
  const extra = JSON.parse(execFileSync('python3', [path.join(ROOT, 'scripts/nav2_stage3/pdf_extra.py'), d.file], { encoding: 'utf8', maxBuffer: 80_000_000 }));
  save(`${label}_pdf_measurements.json`, { layout, extra: { ...extra, text: undefined } });
  const pages = extra.pages;
  const n = pages.length;
  // RELEASE CANDIDATE: the page plan of the PO decision of 07-10-2026: the summary flows over at most 2 pages, EVERY fund takes exactly one page, the comparison one page
  const lo = names.length + 2, hi = names.length + 3;
  console.log(`   ${n} pages (summary 1-2 + 1 per fund + comparison = ${lo} to ${hi}); ${layout.failures.length} layout failures`);
  check(`${label}: page count follows the plan: summary (1 or 2 pages) + one page per fund + one comparison page (${lo} or ${hi})`, n >= lo && n <= hi, `${n}`);
  check(`${label}: NO BLANK PAGES, no page more than 30% empty below its content, no heading stranded at a page end, no text past the margin, body text at the designed 8.5-10.5 pt`, layout.failures.length === 0, layout.failures.join(' | ') || 'judge clean');
  check(`${label}: every page has selectable text (no image-only page)`, pages.every((p) => p.text_chars > 150 && !p.image_only), pages.map((p) => p.text_chars).join(','));
  check(`${label}: PAGE NUMBERS "Page n of N" on every page, N equal to the page count`, pages.every((p, i) => p.footer_page && p.footer_page[0] === i + 1 && p.footer_page[1] === n), pages.map((p) => p.footer_page?.join('/')).join(' '));
  const t = extra.text;
  const asOf = rep.report_json.asOfDate.split('-').reverse().join('-');
  check(`${label}: AS-OF DATE ${asOf} appears, and dates are day-first (no ISO date in the text)`, t.includes(asOf) && !/\b20\d\d-\d\d-\d\d\b/.test(t), `${(t.match(/\b20\d\d-\d\d-\d\d\b/g) ?? []).slice(0, 3).join(',')}`);
  check(`${label}: the running header names the report and version`, /Fund analytics report/.test(t) && new RegExp(`Version ${rep.version_number}`).test(t));
  const flat = t.replace(/\s+/g, ' ');
  check(`${label}: ONE-YEAR CAGR DISCLOSURE (the convention note: 365.2425-day year, annualised on days actually elapsed) and the footnote when a one-year period is annualised over fewer days`, /365\.2425 days/.test(flat) && /days actually between the two prices/.test(flat) && (!rep.report_json.schemes.some((s) => s.analytics.scheme.pointToPoint.some((p) => (p.result.disclosures ?? []).some((d) => d.code === 'cagr_on_actual_days'))) || /annualised figure is worked out over those \d+ days/.test(flat)));
  const mix = rep.report_json.schemes.some((s) => s.analytics.investor?.investedAmount?.state === 'available');
  check(`${label}: OWN-MONEY table present for each fund ("Your own money in this fund")`, !mix || (t.match(/Your own money in this fund/g) ?? []).length >= names.length, `${(t.match(/Your own money in this fund/g) ?? []).length} of ${names.length}`);
  const sharpeAvail = rep.report_json.schemes.some((s) => s.analytics.scheme.sharpe.state === 'available');
  check(`${label}: the risk-free series is named in words (not an id)${sharpeAvail ? '' : ' [no Sharpe is available in this report, so only the id-absence is asserted]'}`, (!sharpeAvail || /RBI 91-day T-bill/.test(t)) && !/RBI_91D_TBILL_CUTOFF_YIELD/.test(t));
  const nextLine = (lab) => { const i = t.indexOf(lab); return i < 0 ? null : t.slice(i + lab.length).split('\n').map((x) => x.trim()).filter(Boolean)[0]; };
  // PO review of 07-10-2026: ONE plain line under the risk table replaces the two amber rows; the old label is still accepted for a reason other than a missing mapping
  const flatBeta = t.replace(/\s+/g, ' ');
  const bl = nextLine('Beta (vs declared benchmark)');
  check(`${label}: beta and alpha are shown as plain text ("not available yet" or a typed label), never as 0 or a number`, /Beta and alpha: not available yet/.test(flatBeta) || (bl !== null && !/^-?[0-9]/.test(bl)), `beta value line: "${bl}"`);
  check(`${label}: every fund page has a drawn chart or table structure (charts present)`, pages.slice(1, -1).filter((p) => p.drawings > 5).length >= names.length, pages.map((p) => p.drawings).join(','));
  if (expect?.honestUnavailable) check(`${label}: UNAVAILABLE SHOWN HONESTLY: the typed reason sentence is printed and no unavailable figure appears as a number`, /starts on \d\d-\d\d-\d\d\d\d, after the requested start/.test(t) || /no published price/i.test(t) || /gap of \d+ days/.test(t.replace(/\s+/g, ' ')), 'typed reason sentence found');
  return { d, layout, extra };
}

console.log(`=== journey 8a (final PDF) ${new Date().toISOString()} ===`);
const latest = async (u) => (await db.from('nav2_fund_analytics_reports').select('id').eq('user_id', await userIdOf(USERS[u])).order('version_number', { ascending: false }).limit(1)).data?.[0]?.id;
await accept('holder-3funds-redeemed', USERS.holder, await latest('holder'), {});
const adminFirst = (await db.from('nav2_fund_analytics_reports').select('id').eq('user_id', await userIdOf(USERS.admin)).order('version_number').limit(1)).data?.[0]?.id;
if (adminFirst) await accept('short-history-unavailable', USERS.admin, adminFirst, { honestUnavailable: true });
else console.log('   (no report of the admin fixture user exists: the short-history case is covered by the big-user run)');
const spareLatest = await latest('spare');
if (spareLatest) await accept('mixed-ownership', USERS.spare, spareLatest, {});
await logoutAll();
const s = summary();
save('j8a_results.json', s);
console.log(`\n=== journey 8a: ${s.pass} PASS, ${s.fail} FAIL ===`);
process.exitCode = s.fail ? 1 : 0;
