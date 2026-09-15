// PC6 (M6) — run the real parsers over the REAL AMFI files and print what
// actually comes back. Not a test: a reality check, so the certification can
// cite counts that were observed rather than assumed.
//
// Usage: npx tsx scripts/pc6_parser_reality_probe.ts <dir-with-NAVAll.txt-and-NAVHist.txt>
import fs from 'node:fs';
import { parseNavAll, parseNavHistory } from '../lib/services/investment-intelligence/pc6/amfiParser';

const DIR = process.argv[2];
if (!DIR) throw new Error('Pass the directory holding NAVAll.txt and NAVHist.txt');
const AS_OF = process.argv[3] ?? '2026-09-15';

const cases = [
  { label: 'NAVAll', file: 'NAVAll.txt', fn: parseNavAll },
  { label: 'NAVHistory', file: 'NAVHist.txt', fn: parseNavHistory },
] as const;

for (const c of cases) {
  const bytes = fs.readFileSync(`${DIR}/${c.file}`);
  const r = c.fn(bytes, { asOfDate: AS_OF });
  console.log(`\n===== ${c.label} =====`);
  console.log('counts', r.counts);
  console.log('sha256', r.fingerprint.sha256, 'bytes', r.fingerprint.byteLength);
  console.log('distinct section headers', r.sectionHeaders.length, '| distinct AMCs', r.amcNames.length);
  console.log('navDate range', r.navDateMin, '->', r.navDateMax);

  const byReason: Record<string, number> = {};
  for (const j of r.rejections) byReason[j.reason] = (byReason[j.reason] ?? 0) + 1;
  console.log('rejections by reason', byReason);
  console.log('first 3 rejections', JSON.stringify(r.rejections.slice(0, 3), null, 1));

  const warn: Record<string, number> = {};
  for (const rec of r.records) for (const w of rec.fieldWarnings) warn[w.reason] = (warn[w.reason] ?? 0) + 1;
  console.log('field warnings', warn);

  const plans: Record<string, number> = {};
  const opts: Record<string, number> = {};
  for (const rec of r.records) {
    plans[String(rec.planType)] = (plans[String(rec.planType)] ?? 0) + 1;
    opts[String(rec.optionType)] = (opts[String(rec.optionType)] ?? 0) + 1;
  }
  console.log('planType distribution', plans);
  console.log('optionType distribution', opts);
  console.log('distinct raw option strings preserved:', new Set(r.records.map((x) => x.optionRaw)).size);
  console.log('records carrying a valid growth/payout ISIN:', r.records.filter((x) => x.isinGrowthOrPayout).length);
  console.log('records carrying a valid reinvestment ISIN:', r.records.filter((x) => x.isinReinvestment).length);
  console.log('sample record', JSON.stringify(r.records[0], null, 1));
}
