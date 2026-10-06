// Layout verdict for an exported Fund analytics PDF (the same judge the live-path check uses). Prints JSON.
//   npx tsx scripts/nav2_stage3/pdf_accept.ts <pdf> <out-dir> <fund-names-json>
import { writeFileSync } from 'node:fs';
import path from 'node:path';

async function main() {
  const [pdf, out, names] = process.argv.slice(2);
  const { analysePdf, judgeLayout } = await import('../nav2_pdf_layout_check');
  const analysis = analysePdf(pdf, out, names);
  const failures = judgeLayout(analysis);
  writeFileSync(path.join(out, 'analysis.json'), JSON.stringify(analysis, null, 1));
  console.log(JSON.stringify({ analysis: { page_count: analysis.page_count, pages: analysis.pages.map((p) => ({ page: p.page, blank_ratio: p.blank_ratio, body_size: p.body_size, funds_named: p.funds_named.length, first: p.first_line?.text, last: p.last_line?.text, overflow: p.overflow_right.length })) }, failures }));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
