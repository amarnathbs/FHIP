// Layout check of the Fund analytics PDF through the REAL path: the actual print route on a local app server and the actual export code
// (renderFundAnalyticsReportToPdf -> printPageToPdf), with a stored report from the DEV database. Development tool, not shipped.
//
//   1. start the app:        npx next dev -p 3981        (the worktree's .env.local holds ONLY the DEV variables and APP_BASE_URL=http://localhost:3981)
//   2. run this check:       npx tsx scripts/nav2_pdf_live_path_check.ts <report-id> [--out <dir>]
//
// SAFETY: refuses to run unless NEXT_PUBLIC_SUPABASE_URL names the DEV project; never prints a key; the only DEV write is the short-lived
// render token the export code itself creates (it expires in 5 minutes and is deleted when the render ends). Reads one report row.
import { createClient } from '@supabase/supabase-js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const DEV_REF = 'vqycarelcoijzwlpkpcz';

function loadEnv(): void {
  const file = path.join(ROOT, '.env.local');
  if (!existsSync(file)) throw new Error('no .env.local in this worktree');
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const reportId = args.find((a) => /^[0-9a-f-]{36}$/i.test(a));
  if (!reportId) throw new Error('usage: npx tsx scripts/nav2_pdf_live_path_check.ts <report-id> [--out <dir>]');
  const out = path.resolve(ROOT, args.includes('--out') ? args[args.indexOf('--out') + 1] : 'test-artifacts/nav2_pdf_live_path');
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  if (!url.includes(DEV_REF)) throw new Error('NEXT_PUBLIC_SUPABASE_URL is not the DEV project: aborting');
  if (Object.keys(process.env).some((k) => k.startsWith('PRODUCTION_'))) throw new Error('a PRODUCTION_ variable is set: aborting');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing');
  process.env.APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3981';
  mkdirSync(out, { recursive: true });

  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: row, error } = await admin.from('nav2_fund_analytics_reports').select('id, user_id, version_number, created_at, report_json').eq('id', reportId).maybeSingle();
  if (error || !row) throw new Error('the report was not found');
  const names = ((row.report_json as { schemes: Array<{ schemeName: string }> }).schemes ?? []).map((s) => s.schemeName);
  writeFileSync(path.join(out, 'fund-names.json'), JSON.stringify(names));

  // the module reads APP_BASE_URL when it loads, so it is imported only now
  const { renderFundAnalyticsReportToPdf } = await import('../lib/services/investment-intelligence/nav2/fundAnalyticsPdfRenderer');
  const { analysePdf, printAnalysis, judgeLayout } = await import('./nav2_pdf_layout_check');
  const pdf = await renderFundAnalyticsReportToPdf(admin as never, row.user_id as string, reportId, { versionNumber: row.version_number as number, createdAt: row.created_at as string });
  const pdfPath = path.join(out, 'live-path-export.pdf');
  writeFileSync(pdfPath, pdf);
  const analysis = analysePdf(pdfPath, path.join(out, 'png'), path.join(out, 'fund-names.json'));
  writeFileSync(path.join(out, 'analysis.json'), JSON.stringify(analysis, null, 1));
  printAnalysis(pdfPath, analysis);
  const expectedPages = names.length * 2 + 2;
  const failures = judgeLayout(analysis);
  if (analysis.page_count !== expectedPages) failures.push(`${analysis.page_count} pages, expected ${expectedPages} (cover 1 + 2 per fund + comparison 1)`);
  if (failures.length > 0) {
    console.log('\nLAYOUT FAILURES (live path):');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nLive-path layout check passed.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
});
